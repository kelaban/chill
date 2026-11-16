import type { PlayStatus, StreamInfo } from "@chill/shared";
import type { PutioFile } from "../adapters/types.js";
import { newId, putioFolder, type Ctx } from "../context.js";
import { mapPosition, selectVariant, type PlayableVariant } from "../domain/playback.js";
import { needsUpgrade, type Scored } from "../domain/ranker.js";
import { factsOf, releaseLabel } from "../domain/release.js";
import { PermanentError } from "../jobs.js";
import { log } from "../log.js";
import { ensureTitle, watchState } from "./catalog.js";
import { deviceCaps, qualityProfile, ranking, releaseById } from "./releases.js";
import { admitAndMakeRoom, isPlaying, publishStorage, variant, variantsFor, type VariantRow } from "./storage.js";

export interface AcqRow {
  id: number;
  tmdb_id: number;
  tier: "instant" | "target";
  release_id: string | null;
  state: "searching" | "queued" | "transferring" | "ready" | "failed" | "cancelled";
  putio_transfer_id: number | null;
  putio_file_id: number | null;
  percent: number | null;
  eta_s: number | null;
  message: string | null;
  races: number | null;
  attempts: number;
  created_at: number;
  updated_at: number;
}

const ACTIVE = "('searching','queued','transferring')";
const MAX_CANDIDATES = 3;

const acq = (ctx: Ctx, id: number) => ctx.db.prepare("SELECT * FROM acquisitions WHERE id = ?").get(id) as AcqRow | undefined;

function update(ctx: Ctx, id: number, f: Partial<Omit<AcqRow, "id">>) {
  const keys = Object.keys(f);
  if (!keys.length) return;
  ctx.db.prepare(`UPDATE acquisitions SET ${keys.map((k) => `${k} = @${k}`).join(", ")}, updated_at = @__now WHERE id = @__id`).run({ ...f, __now: ctx.clock.now(), __id: id });
}

function create(ctx: Ctx, tmdbId: number, tier: "instant" | "target", state: AcqRow["state"], extra: Partial<AcqRow> = {}): number {
  const now = ctx.clock.now();
  const r = ctx.db
    .prepare("INSERT INTO acquisitions (tmdb_id, tier, state, release_id, races, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(tmdbId, tier, state, extra.release_id ?? null, extra.races ?? null, now, now);
  return Number(r.lastInsertRowid);
}

const toPlayable = (v: VariantRow): PlayableVariant => ({
  id: v.id, tier: v.location, quality: v.quality, resolution: v.resolution, dynamicRange: v.dynamic_range,
  durationS: v.duration_s, ready: !!v.ready, superseded: !!v.superseded_by,
});

export function streamInfo(ctx: Ctx, v: VariantRow, profileId: number): StreamInfo {
  const ws = watchState(ctx, profileId, v.tmdb_id);
  let startAtS = 0;
  if (ws && !ws.watched && ws.position_s > 30) {
    const from = ws.last_variant_id ? variant(ctx, ws.last_variant_id) : undefined;
    const al = from && from.id !== v.id
      ? (ctx.db.prepare("SELECT a, b FROM variant_alignments WHERE from_id = ? AND to_id = ? AND aligned = 1").get(from.id, v.id) as { a: number; b: number } | undefined)
      : from?.id === v.id ? { a: 1, b: 0 } : undefined;
    startAtS = mapPosition(ws.position_s, from ? { durationS: from.duration_s } : { durationS: ws.duration_s }, { durationS: v.duration_s }, al ?? null);
  }
  return {
    variantId: v.id,
    url: `/api/stream/${v.id}`,
    kind: "file",
    label: `${v.label}${v.location === "local" ? " · Home" : " · put.io"}`,
    dynamicRange: v.dynamic_range,
    startAtS,
    durationS: v.duration_s,
  };
}

function bestVariant(ctx: Ctx, tmdbId: number): VariantRow | null {
  const vs = variantsFor(ctx, tmdbId);
  const pick = selectVariant(vs.map(toPlayable));
  return pick ? (vs.find((v) => v.id === pick.id) ?? null) : null;
}

export function playStatus(ctx: Ctx, tmdbId: number, profileId: number): PlayStatus {
  const best = bestVariant(ctx, tmdbId);
  if (best) return { tmdbId, phase: "ready", stream: streamInfo(ctx, best, profileId), releaseLabel: best.label };
  const a = ctx.db
    .prepare(`SELECT * FROM acquisitions WHERE tmdb_id = ? AND tier = 'instant' ORDER BY (state IN ${ACTIVE}) DESC, (races IS NULL) DESC, id DESC LIMIT 1`)
    .get(tmdbId) as AcqRow | undefined;
  if (!a || a.state === "cancelled" || (a.state === "failed" && ctx.clock.now() - a.updated_at > 10 * 60_000)) return { tmdbId, phase: "idle" };
  // When a race is on, report whichever transfer is ahead.
  const racers = ctx.db.prepare(`SELECT * FROM acquisitions WHERE (id = ? OR races = ?) AND state IN ${ACTIVE}`).all(a.id, a.id) as AcqRow[];
  const lead = racers.sort((x, y) => (y.percent ?? 0) - (x.percent ?? 0))[0] ?? a;
  const rel = lead.release_id ? releaseById(ctx, tmdbId, lead.release_id) : null;
  return {
    tmdbId,
    phase: a.state === "ready" ? "transferring" : a.state,
    percent: lead.percent ?? undefined,
    etaSeconds: lead.eta_s,
    releaseLabel: rel ? releaseLabel(rel) : undefined,
    message: a.message ?? undefined,
  };
}

function publish(ctx: Ctx, tmdbId: number) {
  // Watch state is per profile; the event carries the status for the default
  // profile and clients re-fetch with their own profile when it's "ready".
  ctx.bus.publish({ type: "play", status: playStatus(ctx, tmdbId, 1) });
}

/** Press Play (or prefetch for My List). Idempotent. */
export async function play(ctx: Ctx, tmdbId: number, profileId: number, opts: { prefetch?: boolean } = {}): Promise<PlayStatus> {
  if (bestVariant(ctx, tmdbId)) {
    if (!opts.prefetch) ensureUpgradeQueued(ctx, tmdbId);
    return playStatus(ctx, tmdbId, profileId);
  }
  const active = ctx.db.prepare(`SELECT id FROM acquisitions WHERE tmdb_id = ? AND tier = 'instant' AND state IN ${ACTIVE}`).get(tmdbId);
  if (!active) {
    await ensureTitle(ctx, tmdbId);
    const id = create(ctx, tmdbId, "instant", "searching");
    ctx.jobs.enqueue("acquire.search", { acqId: id, prefetch: !!opts.prefetch });
  }
  return playStatus(ctx, tmdbId, profileId);
}

/** A title that's already playable may still deserve its target copy. */
function ensureUpgradeQueued(ctx: Ctx, tmdbId: number) {
  const hasTarget = ctx.db.prepare(`SELECT 1 FROM acquisitions WHERE tmdb_id = ? AND tier = 'target' AND state IN ${ACTIVE} UNION SELECT 1 FROM variants WHERE tmdb_id = ? AND quality = 'target'`).get(tmdbId, tmdbId);
  if (!hasTarget) ctx.jobs.enqueue("acquire.plan-target", { tmdbId }, { dedupeKey: `plan-target:${tmdbId}` });
}

export async function cancel(ctx: Ctx, tmdbId: number): Promise<void> {
  const rows = ctx.db.prepare(`SELECT * FROM acquisitions WHERE tmdb_id = ? AND state IN ${ACTIVE}`).all(tmdbId) as AcqRow[];
  for (const a of rows) await abandon(ctx, a, "cancelled");
  publish(ctx, tmdbId);
  publishStorage(ctx);
}

/** Stop an acquisition and clean up whatever it put on put.io. */
async function abandon(ctx: Ctx, a: AcqRow, state: "cancelled" | "failed", message?: string) {
  if (a.putio_transfer_id) await ctx.svc.putio.cancelTransfers([a.putio_transfer_id]).catch(() => {});
  const t = a.putio_transfer_id ? await ctx.svc.putio.getTransfer(a.putio_transfer_id).catch(() => null) : null;
  if (t?.fileId) await ctx.svc.putio.deleteFiles([t.fileId]).catch(() => {});
  update(ctx, a.id, { state, message: message ?? null });
}

function excludedReleases(ctx: Ctx, tmdbId: number): Set<string> {
  return new Set(
    ctx.db.prepare("SELECT release_id FROM acquisitions WHERE tmdb_id = ? AND state IN ('failed') AND release_id IS NOT NULL").pluck().all(tmdbId) as string[],
  );
}

async function preferredFor(ctx: Ctx, tmdbId: number) {
  const ws = ctx.db.prepare("SELECT last_release_id, last_edition FROM watch_state WHERE tmdb_id = ? ORDER BY updated_at DESC LIMIT 1").get(tmdbId) as
    | { last_release_id: string | null; last_edition: string | null }
    | undefined;
  return ws ? { releaseId: ws.last_release_id, edition: ws.last_edition } : undefined;
}

/** Plan the target acquisition for a title given the copy we have/will have. */
async function planTarget(ctx: Ctx, tmdbId: number, instantPick: Scored | null) {
  const exists = ctx.db.prepare(`SELECT 1 FROM acquisitions WHERE tmdb_id = ? AND tier = 'target' AND state IN ${ACTIVE}`).get(tmdbId);
  if (exists) return;
  const r = await ranking(ctx, tmdbId, await preferredFor(ctx, tmdbId));
  const excluded = excludedReleases(ctx, tmdbId);
  const target = r.target.find((s) => !excluded.has(s.release.id));
  if (!target) return;
  const runtime = ctx.db.prepare("SELECT runtime_min FROM titles WHERE tmdb_id = ?").pluck().get(tmdbId) as number | null;
  if (instantPick && !needsUpgrade(instantPick, target, qualityProfile(ctx), deviceCaps(ctx), runtime)) return;
  const have = variantsFor(ctx, tmdbId).find((v) => v.release_id === target.release.id);
  if (have) return;
  const id = create(ctx, tmdbId, "target", "queued", { release_id: target.release.id });
  ctx.jobs.enqueue("acquire.start", { acqId: id });
}

async function pickVideo(ctx: Ctx, fileId: number): Promise<PutioFile | null> {
  const f = await ctx.svc.putio.getFile(fileId);
  if (f.fileType === "VIDEO") return f;
  if (f.fileType !== "FOLDER") return null;
  // Bounded walk: two levels, largest video wins (samples are tiny).
  const level1 = await ctx.svc.putio.listFiles(f.id);
  const vids = level1.filter((x) => x.fileType === "VIDEO");
  for (const sub of level1.filter((x) => x.fileType === "FOLDER").slice(0, 5)) vids.push(...(await ctx.svc.putio.listFiles(sub.id)).filter((x) => x.fileType === "VIDEO"));
  return vids.sort((a, b) => b.size - a.size)[0] ?? null;
}

export function registerAcquireJobs(ctx: Ctx) {
  const pollMs = ctx.cfg.fake ? 1000 : 3000;

  ctx.jobs.register("acquire.search", async ({ acqId, prefetch }: { acqId: number; prefetch?: boolean }) => {
    const a = acq(ctx, acqId);
    if (!a || a.state !== "searching") return;
    const r = await ranking(ctx, a.tmdb_id, await preferredFor(ctx, a.tmdb_id));
    const excluded = excludedReleases(ctx, a.tmdb_id);
    const pick = r.instant.find((s) => !excluded.has(s.release.id));
    if (!pick) {
      update(ctx, acqId, { state: "failed", message: r.instant.length ? "Every release failed to download" : "No releases found" });
      publish(ctx, a.tmdb_id);
      return;
    }
    update(ctx, acqId, { state: "queued", release_id: pick.release.id, message: null });
    publish(ctx, a.tmdb_id);
    ctx.jobs.enqueue("acquire.start", { acqId });
    await planTarget(ctx, a.tmdb_id, pick);
    void prefetch;
  });

  ctx.jobs.register("acquire.plan-target", async ({ tmdbId }: { tmdbId: number }) => {
    const best = bestVariant(ctx, tmdbId);
    const rel = best?.release_id ? releaseById(ctx, tmdbId, best.release_id) : null;
    await planTarget(ctx, tmdbId, rel ? { release: rel, facts: factsOf(rel), score: 0 } : null);
  });

  ctx.jobs.register("acquire.start", async ({ acqId }: { acqId: number }) => {
    const a = acq(ctx, acqId);
    if (!a || a.state !== "queued" || !a.release_id) return;
    const rel = releaseById(ctx, a.tmdb_id, a.release_id);
    if (!rel) throw new PermanentError(`release ${a.release_id} vanished`);
    const room = await admitAndMakeRoom(ctx, "putio", rel.sizeBytes);
    if (!room.ok) {
      update(ctx, acqId, { message: room.reason });
      publish(ctx, a.tmdb_id);
      publishStorage(ctx);
      return { againInMs: 30_000 };
    }
    const folder = await putioFolder(ctx);
    const t = await ctx.svc.putio.addTransfer(rel.link, folder);
    update(ctx, acqId, { state: "transferring", putio_transfer_id: t.id, percent: t.percentDone, eta_s: t.etaS, message: null });
    publish(ctx, a.tmdb_id);
    publishStorage(ctx);
    ctx.jobs.enqueue("acquire.poll", { acqId }, { delayMs: 500 });
  });

  ctx.jobs.register("acquire.poll", async ({ acqId }: { acqId: number }, job) => {
    const a = acq(ctx, acqId);
    if (!a || a.state !== "transferring" || !a.putio_transfer_id) return;
    const t = await ctx.svc.putio.getTransfer(a.putio_transfer_id);
    const title = ctx.db.prepare("SELECT title FROM titles WHERE tmdb_id = ?").pluck().get(a.tmdb_id) as string | undefined;
    job.progress({ title: title ?? null, detail: `${a.tier === "instant" ? "Fast copy" : "Upgrade"} on put.io`, percent: t.percentDone });

    if (t.status === "ERROR") {
      log.warn("transfer failed", { acqId, error: t.error });
      await abandon(ctx, a, "failed", t.error ?? "Transfer failed");
      await retryOrFail(ctx, a);
      return;
    }
    const done = t.status === "COMPLETED" || t.status === "SEEDING" || (t.percentDone >= 100 && t.fileId);
    if (!done) {
      update(ctx, acqId, { percent: t.percentDone, eta_s: t.etaS });
      if (a.tier === "instant") {
        publish(ctx, a.tmdb_id);
        maybeRace(ctx, a, t.percentDone);
      }
      const age = ctx.clock.now() - a.created_at;
      return { againInMs: age < 60_000 ? pollMs : pollMs * 3 };
    }
    if (!t.fileId) return { againInMs: pollMs };
    const file = await pickVideo(ctx, t.fileId);
    if (!file) {
      await abandon(ctx, a, "failed", "Transfer contained no video");
      await retryOrFail(ctx, a);
      return;
    }
    const rel = releaseById(ctx, a.tmdb_id, a.release_id!);
    const f = rel ? factsOf(rel) : null;
    const runtime = ctx.db.prepare("SELECT runtime_min FROM titles WHERE tmdb_id = ?").pluck().get(a.tmdb_id) as number | null;
    const vid = newId("v");
    ctx.db
      .prepare(
        `INSERT INTO variants (id, tmdb_id, location, quality, release_id, acquisition_id, putio_file_id, size_bytes, resolution, dynamic_range,
           video_codec, audio_codec, duration_s, label, edition, ready, created_at)
         VALUES (?, ?, 'putio', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(vid, a.tmdb_id, a.tier, a.release_id, a.id, file.id, file.size, f?.resolution ?? null, f?.dynamicRange ?? "SDR", f?.video ?? null, f?.audio ?? null,
        runtime ? runtime * 60 : null, rel ? releaseLabel(rel) : file.name, f?.edition ?? null, ctx.clock.now());
    update(ctx, acqId, { state: "ready", putio_file_id: file.id, percent: 100, eta_s: 0 });
    ctx.db.prepare("UPDATE acquisitions SET ready_at = ? WHERE id = ?").run(ctx.clock.now(), acqId);
    log.info("ready on put.io", { tmdbId: a.tmdb_id, tier: a.tier, variant: vid });

    // Won the race? Cancel the other runner(s) and delete what they downloaded.
    if (a.tier === "instant") {
      const root = a.races ?? a.id;
      const rivals = ctx.db.prepare(`SELECT * FROM acquisitions WHERE state IN ${ACTIVE} AND id != ? AND (id = ? OR races = ?)`).all(a.id, root, root) as AcqRow[];
      for (const r of rivals) await abandon(ctx, r, "cancelled", "Lost the race");
    }

    ctx.jobs.enqueue("variant.probe", { variantId: vid });
    if (a.tier === "target") {
      // An upgrade arrived: supersede lower copies, prepare a live switch, mirror home.
      supersedeLower(ctx, a.tmdb_id, vid);
      queueUpgradeIfPlaying(ctx, a.tmdb_id, vid);
      ctx.jobs.enqueue("mirror.download", { variantId: vid }, { dedupeKey: `mirror:${vid}` });
    } else {
      const target = ctx.db.prepare(`SELECT 1 FROM acquisitions WHERE tmdb_id = ? AND tier = 'target' AND state IN ${ACTIVE}`).get(a.tmdb_id);
      // No upgrade coming? Then this copy is the keeper: mirror it home.
      if (!target) ctx.jobs.enqueue("mirror.download", { variantId: vid }, { dedupeKey: `mirror:${vid}` });
    }
    publish(ctx, a.tmdb_id);
    publishStorage(ctx);
  });

  ctx.jobs.register("variant.probe", async ({ variantId }: { variantId: string }) => {
    const v = variant(ctx, variantId);
    if (!v) return;
    const { mediaInput } = await import("./media.js");
    const input = await mediaInput(ctx, v);
    const { probe } = await import("../media/ffmpeg.js");
    const p = await probe(input);
    ctx.db
      .prepare("UPDATE variants SET duration_s = COALESCE(?, duration_s), video_codec = COALESCE(?, video_codec), audio_codec = COALESCE(?, audio_codec), container = ?, probe_json = ? WHERE id = ?")
      .run(p.durationS, p.videoCodec, p.audioCodec, p.container, JSON.stringify(p), variantId);
  });
}

async function retryOrFail(ctx: Ctx, a: AcqRow) {
  if (a.races) return; // a failed runner-up just drops out
  if (a.attempts + 1 >= MAX_CANDIDATES) {
    update(ctx, a.id, { state: "failed", message: "Couldn't download any release" });
    publish(ctx, a.tmdb_id);
    return;
  }
  // Try the next candidate under the same acquisition so the client keeps watching one id.
  update(ctx, a.id, { state: "searching", attempts: a.attempts + 1, putio_transfer_id: null, percent: null, eta_s: null });
  ctx.db.prepare("INSERT INTO acquisitions (tmdb_id, tier, state, release_id, created_at, updated_at) VALUES (?, ?, 'failed', ?, ?, ?)").run(a.tmdb_id, a.tier, a.release_id, ctx.clock.now(), ctx.clock.now());
  if (a.tier === "instant") ctx.jobs.enqueue("acquire.search", { acqId: a.id });
  else update(ctx, a.id, { state: "failed", message: "Upgrade failed" });
  publish(ctx, a.tmdb_id);
}

function maybeRace(ctx: Ctx, a: AcqRow, percent: number) {
  if (a.races || percent >= 50 || ctx.clock.now() - a.created_at < ctx.cfg.raceAfterMs) return;
  const already = ctx.db.prepare("SELECT 1 FROM acquisitions WHERE races = ?").get(a.id);
  if (already) return;
  void (async () => {
    const r = await ranking(ctx, a.tmdb_id);
    const excluded = excludedReleases(ctx, a.tmdb_id);
    const runnerUp = r.instant.find((s) => s.release.id !== a.release_id && !excluded.has(s.release.id));
    if (!runnerUp) return;
    const id = create(ctx, a.tmdb_id, "instant", "queued", { release_id: runnerUp.release.id, races: a.id });
    log.info("racing runner-up", { acqId: a.id, runnerUp: runnerUp.release.id });
    ctx.jobs.enqueue("acquire.start", { acqId: id });
  })().catch((err) => log.warn("race setup failed", { err }));
}

/** Mark every lower-quality copy of the title as superseded by `vid`. */
export function supersedeLower(ctx: Ctx, tmdbId: number, vid: string) {
  const nv = variant(ctx, vid);
  if (!nv) return;
  const rank = (v: VariantRow) => (v.resolution ?? 0) * 10 + ({ SDR: 0, HDR10: 1, DV: 2 } as const)[v.dynamic_range];
  for (const v of variantsFor(ctx, tmdbId)) {
    if (v.id === vid || v.superseded_by) continue;
    const lower = rank(v) < rank(nv) || (rank(v) === rank(nv) && v.release_id === nv.release_id && v.location === "putio" && nv.location === "local");
    if (lower) ctx.db.prepare("UPDATE variants SET superseded_by = ? WHERE id = ?").run(vid, v.id);
  }
}

/** If someone is watching this title right now, prepare a seamless switch to `toVariantId`. */
export function queueUpgradeIfPlaying(ctx: Ctx, tmdbId: number, toVariantId: string) {
  const playing = variantsFor(ctx, tmdbId).find((v) => v.id !== toVariantId && isPlaying(ctx, v));
  if (playing) ctx.jobs.enqueue("upgrade.prepare", { fromVariantId: playing.id, toVariantId }, { dedupeKey: `upgrade:${playing.id}:${toVariantId}` });
}
