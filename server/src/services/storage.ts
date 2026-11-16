import fs from "node:fs";
import path from "node:path";
import type { JobDto, StorageReport, Tier, VariantDto } from "@chill/shared";
import { putioFolder, type Ctx } from "../context.js";
import { admit, DEFAULT_EVICTION, planEviction, type Admission, type Budget, type VariantFacts } from "../domain/storage.js";
import { getSetting } from "../db.js";
import { log } from "../log.js";

const PLAYING_WINDOW_MS = 2 * 60_000;

export interface VariantRow {
  id: string;
  tmdb_id: number;
  location: Tier;
  quality: "instant" | "target";
  release_id: string | null;
  acquisition_id: number | null;
  putio_file_id: number | null;
  local_path: string | null;
  size_bytes: number;
  resolution: number | null;
  dynamic_range: "SDR" | "HDR10" | "DV";
  video_codec: string | null;
  audio_codec: string | null;
  container: string | null;
  duration_s: number | null;
  label: string;
  edition: string | null;
  probe_json: string | null;
  superseded_by: string | null;
  pinned: number;
  ready: number;
  last_played_at: number | null;
  last_heartbeat_at: number | null;
  created_at: number;
}

export function variant(ctx: Ctx, id: string): VariantRow | undefined {
  return ctx.db.prepare("SELECT * FROM variants WHERE id = ?").get(id) as VariantRow | undefined;
}

export function variantsFor(ctx: Ctx, tmdbId: number): VariantRow[] {
  return ctx.db.prepare("SELECT * FROM variants WHERE tmdb_id = ? ORDER BY created_at").all(tmdbId) as VariantRow[];
}

export function budget(ctx: Ctx, tier: Tier): Budget {
  const override = getSetting<Partial<Record<Tier, Partial<Budget>>>>(ctx.db, "budgets", {});
  return { ...ctx.cfg.budgets[tier], ...override[tier] };
}

export function isPlaying(ctx: Ctx, v: Pick<VariantRow, "last_heartbeat_at">): boolean {
  return !!v.last_heartbeat_at && ctx.clock.now() - v.last_heartbeat_at < PLAYING_WINDOW_MS;
}

/** Bytes on a tier: stored variants plus what in-flight work has reserved. */
export function usedBytes(ctx: Ctx, tier: Tier): number {
  const stored = ctx.db.prepare("SELECT COALESCE(SUM(size_bytes), 0) FROM variants WHERE location = ?").pluck().get(tier) as number;
  if (tier === "putio") {
    // Transfers in progress will land on put.io; count them now.
    const inflight = ctx.db
      .prepare(
        `SELECT COALESCE(SUM(r.size_bytes), 0) FROM acquisitions a JOIN releases r ON r.tmdb_id = a.tmdb_id AND r.id = a.release_id
         WHERE a.state = 'transferring'`,
      )
      .pluck()
      .get() as number;
    return stored + inflight;
  }
  const mirroring = ctx.db
    .prepare(
      `SELECT COALESCE(SUM(v.size_bytes), 0) FROM jobs j JOIN variants v ON v.id = json_extract(j.payload_json, '$.variantId')
       WHERE j.type = 'mirror.download' AND j.state = 'running'`,
    )
    .pluck()
    .get() as number;
  return stored + mirroring;
}

function facts(ctx: Ctx, tier: Tier): VariantFacts[] {
  const rows = ctx.db.prepare("SELECT * FROM variants WHERE location = ?").all(tier) as VariantRow[];
  const mirrorSources = new Set(
    ctx.db.prepare("SELECT json_extract(payload_json, '$.variantId') FROM jobs WHERE type IN ('mirror.download', 'upgrade.prepare') AND state IN ('queued','running')").pluck().all() as string[],
  );
  const upgradeSources = new Set(
    ctx.db.prepare("SELECT json_extract(payload_json, '$.fromVariantId') FROM jobs WHERE type = 'upgrade.prepare' AND state IN ('queued','running')").pluck().all() as string[],
  );
  const localTitles = new Set(ctx.db.prepare("SELECT DISTINCT tmdb_id FROM variants WHERE location = 'local' AND ready = 1").pluck().all() as number[]);
  return rows.map((v) => {
    const w = ctx.db
      .prepare("SELECT MAX(watched) AS watched, MAX(updated_at) AS updated_at FROM watch_state WHERE tmdb_id = ?")
      .get(v.tmdb_id) as { watched: number | null; updated_at: number | null };
    return {
      id: v.id,
      tmdbId: v.tmdb_id,
      tier: v.location,
      sizeBytes: v.size_bytes,
      createdAt: new Date(v.created_at),
      lastPlayedAt: v.last_played_at ? new Date(v.last_played_at) : null,
      pinned: !!v.pinned,
      playing: isPlaying(ctx, v),
      protected: mirrorSources.has(v.id) || upgradeSources.has(v.id),
      superseded: !!v.superseded_by,
      mirroredLocally: v.location === "putio" && localTitles.has(v.tmdb_id),
      watch: w.updated_at ? { watched: !!w.watched, updatedAt: new Date(w.updated_at) } : null,
    };
  });
}

/** Delete one stored copy everywhere it lives, and forget it. */
export async function evictVariant(ctx: Ctx, id: string, reason: string): Promise<void> {
  const v = variant(ctx, id);
  if (!v) return;
  if (v.location === "putio" && v.putio_file_id) {
    // Delete the transfer's whole folder when the video sits in one.
    const f = await ctx.svc.putio.getFile(v.putio_file_id).catch(() => null);
    const parent = f?.parentId;
    const root = await putioFolder(ctx).catch(() => null);
    const target = parent && parent !== root && parent !== 0 ? parent : v.putio_file_id;
    await ctx.svc.putio.deleteFiles([target]);
  } else if (v.location === "local" && v.local_path) {
    const abs = path.join(ctx.cfg.libraryDir, v.local_path);
    await fs.promises.rm(abs, { force: true });
    const dir = path.dirname(abs);
    if (dir.startsWith(ctx.cfg.libraryDir) && dir !== ctx.cfg.libraryDir) {
      const left = await fs.promises.readdir(dir).catch(() => ["?"]);
      if (left.length === 0) await fs.promises.rmdir(dir).catch(() => {});
    }
  }
  ctx.db.transaction(() => {
    // Whatever this copy superseded is now superseded by what superseded it.
    ctx.db.prepare("UPDATE variants SET superseded_by = ? WHERE superseded_by = ?").run(v.superseded_by, id);
    // Resume positions saved against this copy move to an aligned survivor's timeline.
    const al = ctx.db
      .prepare("SELECT to_id, a, b FROM variant_alignments WHERE from_id = ? AND aligned = 1 AND to_id IN (SELECT id FROM variants WHERE id != ?) ORDER BY (to_id = ?) DESC LIMIT 1")
      .get(id, id, v.superseded_by ?? "") as { to_id: string; a: number; b: number } | undefined;
    if (al) ctx.db.prepare("UPDATE watch_state SET position_s = MAX(0, ? * position_s + ?), last_variant_id = ? WHERE last_variant_id = ?").run(al.a, al.b, al.to_id, id);
    ctx.db.prepare("UPDATE watch_state SET last_variant_id = NULL WHERE last_variant_id = ?").run(id);
    ctx.db.prepare("DELETE FROM variant_alignments WHERE from_id = ? OR to_id = ?").run(id, id);
    ctx.db.prepare("DELETE FROM variants WHERE id = ?").run(id);
    ctx.db.prepare("INSERT INTO storage_events (variant_id, tier, action, bytes, reason, at) VALUES (?,?,?,?,?,?)").run(id, v.location, "evict", v.size_bytes, reason, ctx.clock.now());
  })();
  log.info("evicted", { variant: id, tier: v.location, bytes: v.size_bytes, reason });
}

/** Admission control: may `sizeBytes` land on `tier`? Applies the evictions it needs. */
export async function admitAndMakeRoom(ctx: Ctx, tier: Tier, sizeBytes: number): Promise<Admission> {
  const b = budget(ctx, tier);
  const a = admit(sizeBytes, facts(ctx, tier), usedBytes(ctx, tier), b, new Date(ctx.clock.now()), DEFAULT_EVICTION);
  if (!a.ok) return a;
  if (tier === "putio") {
    // The account itself must also have room (it may hold things chill doesn't own).
    const disk = await ctx.svc.putio.accountDisk().catch(() => null);
    const freed = a.evict.reduce((s, id) => s + (variant(ctx, id)?.size_bytes ?? 0), 0);
    if (disk && disk.avail + freed < sizeBytes * 1.05)
      return { ok: false, reason: `put.io account is nearly full (${(disk.avail / 1e9).toFixed(1)} GB free)`, shortBytes: sizeBytes - disk.avail };
  }
  for (const id of a.evict) await evictVariant(ctx, id, `room for ${(sizeBytes / 1e9).toFixed(1)} GB on ${tier}`);
  if (a.evict.length) publishStorage(ctx);
  return a;
}

/** Bring a tier back under its high watermark. */
export async function enforce(ctx: Ctx, tier: Tier): Promise<string[]> {
  const plan = planEviction(facts(ctx, tier), usedBytes(ctx, tier), budget(ctx, tier), new Date(ctx.clock.now()));
  for (const id of plan.evict) await evictVariant(ctx, id, "over high watermark");
  if (plan.evict.length) publishStorage(ctx);
  return plan.evict;
}

/**
 * put.io is staging: once a copy is safely home (or replaced by a better one),
 * delete it — unless it's being played or used as an upgrade source right now.
 * Returns how many are still waiting on playback.
 */
export async function cleanupStaging(ctx: Ctx): Promise<number> {
  let waiting = 0;
  for (const f of facts(ctx, "putio")) {
    if (!(f.superseded || f.mirroredLocally) || f.pinned) continue;
    if (f.playing || f.protected) {
      waiting++;
      continue;
    }
    await evictVariant(ctx, f.id, f.superseded ? "superseded" : "mirrored home");
  }
  publishStorage(ctx);
  return waiting;
}

function status(ctx: Ctx, v: VariantRow): VariantDto["status"] {
  if (isPlaying(ctx, v)) return "playing";
  if (v.superseded_by) return "superseded";
  if (v.pinned) return "pinned";
  const w = ctx.db.prepare("SELECT MAX(watched) AS w, MAX(position_s) AS p FROM watch_state WHERE tmdb_id = ?").get(v.tmdb_id) as { w: number | null; p: number | null };
  if (w.w) return "watched";
  if (w.p && w.p > 30) return "in-progress";
  return "unwatched";
}

export function report(ctx: Ctx): StorageReport {
  const tiers = (["putio", "local"] as const).map((tier) => {
    const b = budget(ctx, tier);
    const rows = ctx.db
      .prepare("SELECT v.*, t.title AS title FROM variants v LEFT JOIN titles t ON t.tmdb_id = v.tmdb_id WHERE v.location = ? ORDER BY v.created_at DESC")
      .all(tier) as (VariantRow & { title: string | null })[];
    return {
      tier,
      usedBytes: usedBytes(ctx, tier),
      budgetBytes: b.budgetBytes,
      highWatermark: b.highWatermark,
      lowWatermark: b.lowWatermark,
      variants: rows.map((v) => ({
        id: v.id, tmdbId: v.tmdb_id, title: v.title ?? `#${v.tmdb_id}`, location: v.location, quality: v.quality, label: v.label,
        sizeBytes: v.size_bytes, status: status(ctx, v), pinned: !!v.pinned, lastPlayedAt: v.last_played_at ? new Date(v.last_played_at).toISOString() : null,
      })),
    };
  });
  const jobs = ctx.db
    .prepare("SELECT id, type, state, payload_json, progress_json, last_error FROM jobs WHERE state IN ('queued','running') AND type IN ('acquire.poll','acquire.start','mirror.download','upgrade.prepare') ORDER BY id")
    .all() as { id: number; type: string; state: string; payload_json: string; progress_json: string | null; last_error: string | null }[];
  const jobDtos: JobDto[] = jobs.map((j) => {
    const p = j.progress_json ? (JSON.parse(j.progress_json) as { title?: string; detail?: string; percent?: number }) : {};
    return { id: j.id, type: j.type, state: j.state, title: p.title ?? null, detail: p.detail ?? j.last_error, percent: p.percent ?? null };
  });
  const waiting = ctx.db.prepare("SELECT message FROM acquisitions WHERE state = 'queued' AND message IS NOT NULL").pluck().all() as string[];
  return { tiers, jobs: jobDtos, waiting };
}

let pending: NodeJS.Timeout | null = null;
/** Throttled: storage reports are cheap but not free. */
export function publishStorage(ctx: Ctx) {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    if (ctx.bus.size) ctx.bus.publish({ type: "storage", report: report(ctx) });
  }, 250);
}

export function registerStorageJobs(ctx: Ctx) {
  ctx.jobs.register("storage.cleanup", async () => {
    const waiting = await cleanupStaging(ctx);
    await enforce(ctx, "putio");
    await enforce(ctx, "local");
    if (waiting) return { againInMs: 60_000 };
  });
}
