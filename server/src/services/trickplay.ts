import fs from "node:fs";
import path from "node:path";
import type { TrickplayManifest } from "@chill/shared";
import type { Ctx } from "../context.js";
import { alignmentBetween, type AlignmentEdge } from "../domain/playback.js";
import { trickplaySheets, type SheetLayout } from "../media/ffmpeg.js";
import { log } from "../log.js";
import { variant, type VariantRow } from "./storage.js";

// Scrub-preview thumbnails ("trickplay"), made from home copies only: reading a
// put.io copy for them would download it a second time (DECISIONS D49). Sheets
// live in cacheDir/trickplay/<variant>/ and go when the copy goes.

const INTERVAL_S = 10;
const WIDTH = 320;
const COLS = 10;
const ROWS = 10;

interface Stored extends SheetLayout {
  count: number;
  sheets: number;
}

export const trickplayDir = (ctx: Ctx, variantId: string) => path.join(ctx.cfg.cacheDir, "trickplay", variantId.replace(/[^\w-]/g, ""));

/** Thumbnail size for a picture of `w`×`h`: WIDTH wide, even height, the film's shape. */
export function thumbSize(w: number | null, h: number | null): { width: number; height: number } {
  const ratio = w && h ? h / w : 9 / 16;
  return { width: WIDTH, height: Math.max(2, Math.round((WIDTH * ratio) / 2) * 2) };
}

export function registerTrickplayJobs(ctx: Ctx) {
  ctx.jobs.register("trickplay.generate", async ({ variantId }: { variantId: string }) => {
    const v = variant(ctx, variantId);
    if (!v || v.location !== "local" || !v.local_path || v.trickplay_json) return;
    const probe = v.probe_json ? (JSON.parse(v.probe_json) as { width?: number | null; height?: number | null; dynamicRange?: string; durationS?: number | null }) : {};
    const layout: SheetLayout = { intervalS: INTERVAL_S, ...thumbSize(probe.width ?? null, probe.height ?? null), cols: COLS, rows: ROWS };
    const dir = trickplayDir(ctx, v.id);
    const tmp = `${dir}.partial`;
    await fs.promises.rm(tmp, { recursive: true, force: true });
    await fs.promises.mkdir(tmp, { recursive: true });
    const started = Date.now();
    try {
      const hdr = (probe.dynamicRange ?? "SDR") !== "SDR";
      const sheets = await trickplaySheets(path.join(ctx.cfg.libraryDir, v.local_path), tmp, layout, hdr);
      if (!sheets) throw new Error("ffmpeg wrote no sheets");
      const duration = probe.durationS ?? v.duration_s ?? sheets * COLS * ROWS * INTERVAL_S;
      const count = Math.min(sheets * COLS * ROWS, Math.floor(duration / INTERVAL_S) + 1);
      await fs.promises.rm(dir, { recursive: true, force: true });
      await fs.promises.rename(tmp, dir);
      // The copy may have been evicted meanwhile; then there is nothing to keep.
      const r = ctx.db.prepare("UPDATE variants SET trickplay_json = ? WHERE id = ?").run(JSON.stringify({ ...layout, count, sheets } satisfies Stored), v.id);
      if (!r.changes) await fs.promises.rm(dir, { recursive: true, force: true });
      else ctx.bus.publish({ type: "trickplay", tmdbId: v.tmdb_id });
      log.info("scrub previews ready", { variant: v.id, sheets, frames: count, seconds: Math.round((Date.now() - started) / 1000) });
    } catch (err) {
      await fs.promises.rm(tmp, { recursive: true, force: true });
      throw err;
    }
  });
}

export function queueTrickplay(ctx: Ctx, variantId: string) {
  ctx.jobs.enqueue("trickplay.generate", { variantId }, { dedupeKey: `trickplay:${variantId}`, delayMs: 5000 });
}

/** Home copies that predate scrub previews get them too (run once at startup). */
export function backfillTrickplay(ctx: Ctx) {
  const ids = ctx.db.prepare("SELECT id FROM variants WHERE location = 'local' AND ready = 1 AND trickplay_json IS NULL").pluck().all() as string[];
  for (const id of ids) queueTrickplay(ctx, id);
  return ids.length;
}

export async function forgetTrickplay(ctx: Ctx, variantId: string) {
  await fs.promises.rm(trickplayDir(ctx, variantId), { recursive: true, force: true });
}

/**
 * Previews for whatever copy `variantId` is: its own sheets, or another copy of
 * the same title's, mapped through the measured alignment. Null when no copy
 * has sheets yet, or none of them is aligned with this one.
 */
export function manifestFor(ctx: Ctx, variantId: string): TrickplayManifest | null {
  const v = variant(ctx, variantId);
  if (!v) return null;
  const withSheets = ctx.db.prepare("SELECT * FROM variants WHERE tmdb_id = ? AND trickplay_json IS NOT NULL ORDER BY (id = ?) DESC, created_at DESC").all(v.tmdb_id, v.id) as VariantRow[];
  if (!withSheets.length) return null;
  const ids = ctx.db.prepare("SELECT id FROM variants WHERE tmdb_id = ?").pluck().all(v.tmdb_id) as string[];
  const marks = ids.map(() => "?").join(",");
  const edges = (
    ctx.db.prepare(`SELECT from_id, to_id, a, b FROM variant_alignments WHERE aligned = 1 AND from_id IN (${marks}) AND to_id IN (${marks})`).all(...ids, ...ids) as {
      from_id: string; to_id: string; a: number; b: number;
    }[]
  ).map((e): AlignmentEdge => ({ from: e.from_id, to: e.to_id, a: e.a, b: e.b }));
  for (const src of withSheets) {
    const m = alignmentBetween(edges, v.id, src.id);
    if (!m) continue;
    const s = JSON.parse(src.trickplay_json!) as Stored;
    return {
      intervalS: s.intervalS, width: s.width, height: s.height, cols: s.cols, rows: s.rows, count: s.count,
      sheets: Array.from({ length: s.sheets }, (_, i) => `/api/trickplay/${src.id}/${String(i + 1).padStart(3, "0")}.jpg`),
      a: m.a, b: m.b,
    };
  }
  return null;
}
