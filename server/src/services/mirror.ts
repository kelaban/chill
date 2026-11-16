import fs from "node:fs";
import path from "node:path";
import { newId, type Ctx } from "../context.js";
import { libraryPath } from "../domain/naming.js";
import { probe } from "../media/ffmpeg.js";
import { log } from "../log.js";
import { queueUpgradeIfPlaying, supersedeLower } from "./acquirer.js";
import { download } from "./downloader.js";
import { admitAndMakeRoom, publishStorage, variant } from "./storage.js";

/** Copy a put.io variant to the home library, verified, Plex-named. */
export function registerMirrorJobs(ctx: Ctx) {
  ctx.jobs.register("mirror.download", async ({ variantId }: { variantId: string }, job) => {
    const v = variant(ctx, variantId);
    if (!v || v.location !== "putio" || !v.putio_file_id) return;
    const t = ctx.db.prepare("SELECT title, year FROM titles WHERE tmdb_id = ?").get(v.tmdb_id) as { title: string; year: number | null } | undefined;
    const already = ctx.db.prepare("SELECT 1 FROM variants WHERE location = 'local' AND tmdb_id = ? AND release_id IS ?").get(v.tmdb_id, v.release_id);
    if (already) return;

    const room = await admitAndMakeRoom(ctx, "local", v.size_bytes);
    if (!room.ok) {
      job.progress({ title: t?.title ?? null, detail: room.reason, percent: 0 });
      publishStorage(ctx);
      return { againInMs: 60_000 };
    }

    const file = await ctx.svc.putio.getFile(v.putio_file_id);
    const ext = path.extname(file.name) || ".mkv";
    const partialDir = path.join(ctx.cfg.libraryDir, ".partial");
    await fs.promises.mkdir(partialDir, { recursive: true });
    const partial = path.join(partialDir, `${v.id}${ext}`);
    const rawUrl = await ctx.svc.putio.downloadUrl(v.putio_file_id);
    const url = rawUrl.startsWith("/") ? ctx.selfBase + rawUrl : rawUrl;

    let lastPct = -1;
    await download(url, partial, {
      connections: ctx.cfg.mirrorConnections,
      maxBytesPerSec: ctx.fake && ctx.cfg.fakeTimings.mirrorKbps ? ctx.cfg.fakeTimings.mirrorKbps * 1000 : undefined,
      onProgress: (done, total) => {
        const pct = Math.floor((done / Math.max(1, total)) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          job.progress({ title: t?.title ?? null, detail: "Copying home", percent: pct });
          publishStorage(ctx);
        }
      },
    });

    // Verify: it must probe, and match the put.io copy's *measured* duration
    // within 2% (the catalog runtime is only an estimate, so never compare to it).
    const p = await probe(partial);
    const ref = v.probe_json ? ((JSON.parse(v.probe_json) as { durationS?: number }).durationS ?? null) : null;
    if (!p.durationS || (ref && Math.abs(p.durationS - ref) / ref > 0.02 && !ctx.fake)) {
      await fs.promises.rm(partial, { force: true });
      throw new Error(`mirror verify failed: duration ${p.durationS} vs ${ref}`);
    }

    const rel = libraryPath(t?.title ?? `Title ${v.tmdb_id}`, t?.year ?? null, v.tmdb_id, v.resolution, ext);
    const abs = path.join(ctx.cfg.libraryDir, rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.rename(partial, abs);
    const size = (await fs.promises.stat(abs)).size;

    const lid = newId("v");
    ctx.db
      .prepare(
        `INSERT INTO variants (id, tmdb_id, location, quality, release_id, acquisition_id, local_path, size_bytes, resolution, dynamic_range,
           video_codec, audio_codec, container, duration_s, label, edition, probe_json, ready, created_at)
         VALUES (?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(lid, v.tmdb_id, v.quality, v.release_id, v.acquisition_id, rel,
        // Demo mode serves tiny sample files; keep the release's nominal size for realistic accounting.
        ctx.fake ? v.size_bytes : size,
        v.resolution, v.dynamic_range, p.videoCodec, p.audioCodec, p.container, p.durationS, v.label, v.edition, JSON.stringify(p), ctx.clock.now());
    // The local copy is the same release: identity alignment.
    ctx.db.prepare("INSERT OR REPLACE INTO variant_alignments (from_id, to_id, a, b, residual_ms, aligned, created_at) VALUES (?, ?, 1, 0, 0, 1, ?)").run(v.id, lid, ctx.clock.now());
    supersedeLower(ctx, v.tmdb_id, lid);
    log.info("mirrored home", { tmdbId: v.tmdb_id, variant: lid, path: rel });

    queueUpgradeIfPlaying(ctx, v.tmdb_id, lid);
    ctx.jobs.enqueue("storage.cleanup", {}, { dedupeKey: "storage.cleanup", delayMs: 1000 });
    publishStorage(ctx);
  });
}
