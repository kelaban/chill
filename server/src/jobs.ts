import type { DB } from "./db.js";
import { log } from "./log.js";

export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

/** What a handler returns: nothing (done), or "run me again in N ms" (polling). */
export type JobOutcome = void | { againInMs: number };

export interface JobContext {
  id: number;
  attempts: number;
  progress(p: Record<string, unknown>): void;
}

export type Handler = (payload: any, ctx: JobContext) => Promise<JobOutcome>;

interface JobRow {
  id: number;
  type: string;
  payload_json: string;
  attempts: number;
}

const MAX_ATTEMPTS = 5;

/**
 * Durable job queue in SQLite with an in-process worker. Up to `concurrency`
 * jobs run at once, but at most one per lane (a lane is the part of the type
 * before the dot, e.g. all `mirror.*` jobs share one lane), so a long download
 * never blocks Play.
 */
export class Jobs {
  private handlers = new Map<string, Handler>();
  private running = new Map<number, string>(); // job id → lane
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private wake: (() => void) | null = null;
  readonly singleLanes = new Set(["mirror", "upgrade", "trickplay"]);

  constructor(
    private db: DB,
    private clock: Clock = systemClock,
    private concurrency = 4,
  ) {
    // Crash recovery: anything that was running when we died runs again.
    db.prepare("UPDATE jobs SET state = 'queued' WHERE state = 'running'").run();
  }

  register(type: string, handler: Handler): void {
    this.handlers.set(type, handler);
  }

  enqueue(type: string, payload: unknown, opts: { delayMs?: number; dedupeKey?: string } = {}): number | null {
    const now = this.clock.now();
    try {
      const r = this.db
        .prepare("INSERT INTO jobs (type, payload_json, dedupe_key, state, run_after, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)")
        .run(type, JSON.stringify(payload), opts.dedupeKey ?? null, now + (opts.delayMs ?? 0), now, now);
      this.wake?.();
      return Number(r.lastInsertRowid);
    } catch (e) {
      if (String(e).includes("UNIQUE")) {
        // Already queued: run it no later than this request asked for.
        this.db.prepare("UPDATE jobs SET run_after = MIN(run_after, ?) WHERE dedupe_key = ? AND state = 'queued'").run(now + (opts.delayMs ?? 0), opts.dedupeKey ?? null);
        this.wake?.();
        return null;
      }
      throw e;
    }
  }

  cancelWhere(type: string, match: (payload: any) => boolean): number {
    const rows = this.db.prepare("SELECT id, payload_json FROM jobs WHERE type = ? AND state = 'queued'").all(type) as { id: number; payload_json: string }[];
    let n = 0;
    for (const r of rows)
      if (match(JSON.parse(r.payload_json))) {
        this.db.prepare("UPDATE jobs SET state = 'cancelled', updated_at = ? WHERE id = ?").run(this.clock.now(), r.id);
        n++;
      }
    return n;
  }

  private lane(type: string) {
    const l = type.split(".")[0]!;
    return this.singleLanes.has(l) ? l : `job:${type}`;
  }

  /** Claim and start every due job the limits allow. Returns the started promises. */
  private claim(): Promise<void>[] {
    const started: Promise<void>[] = [];
    if (this.running.size >= this.concurrency) return started;
    const due = this.db
      .prepare("SELECT id, type, payload_json, attempts FROM jobs WHERE state = 'queued' AND run_after <= ? ORDER BY run_after, id LIMIT 50")
      .all(this.clock.now()) as JobRow[];
    const busyLanes = new Set(this.running.values());
    for (const job of due) {
      if (this.running.size >= this.concurrency) break;
      const lane = this.lane(job.type);
      if (this.singleLanes.has(lane) && busyLanes.has(lane)) continue;
      busyLanes.add(lane);
      this.db.prepare("UPDATE jobs SET state = 'running', updated_at = ? WHERE id = ?").run(this.clock.now(), job.id);
      this.running.set(job.id, lane);
      started.push(this.run(job).finally(() => this.running.delete(job.id)));
    }
    return started;
  }

  private async run(job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.type);
    const now = () => this.clock.now();
    if (!handler) {
      this.db.prepare("UPDATE jobs SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?").run(`no handler for ${job.type}`, now(), job.id);
      return;
    }
    const ctx: JobContext = {
      id: job.id,
      attempts: job.attempts,
      progress: (p) => this.db.prepare("UPDATE jobs SET progress_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(p), now(), job.id),
    };
    try {
      const out = await handler(JSON.parse(job.payload_json), ctx);
      if (out && "againInMs" in out) {
        this.db.prepare("UPDATE jobs SET state = 'queued', run_after = ?, updated_at = ? WHERE id = ?").run(now() + out.againInMs, now(), job.id);
      } else {
        this.db.prepare("UPDATE jobs SET state = 'done', updated_at = ? WHERE id = ?").run(now(), job.id);
      }
    } catch (err) {
      const attempts = job.attempts + 1;
      const final = attempts >= MAX_ATTEMPTS || (err as { permanent?: boolean }).permanent === true;
      log.warn("job failed", { job: job.type, id: job.id, attempts, final, err });
      this.db
        .prepare("UPDATE jobs SET state = ?, attempts = ?, last_error = ?, run_after = ?, updated_at = ? WHERE id = ?")
        .run(final ? "failed" : "queued", attempts, String((err as Error).message ?? err), now() + 1000 * 2 ** attempts, now(), job.id);
    }
  }

  /** Run everything that's due, repeatedly, until nothing is due (tests and boot). */
  async tick(maxRounds = 100): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      const started = this.claim();
      if (started.length === 0 && this.running.size === 0) return;
      await Promise.race([Promise.all(started), new Promise((r) => setTimeout(r, 5))]);
      if (started.length === 0) await new Promise((r) => setTimeout(r, 5));
    }
  }

  start(pollMs = 250): void {
    this.stopped = false;
    const loop = () => {
      if (this.stopped) return;
      this.claim();
      this.timer = setTimeout(loop, pollMs);
      this.wake = () => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(loop, 0);
      };
    };
    loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Await all currently running jobs (graceful shutdown, tests). */
  async idle(): Promise<void> {
    while (this.running.size) await new Promise((r) => setTimeout(r, 10));
  }
}

export class PermanentError extends Error {
  readonly permanent = true;
}
