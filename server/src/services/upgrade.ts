import type { UpgradeReady } from "@chill/shared";
import type { Ctx } from "../context.js";
import { alignFromWindows, type AlignmentResult } from "../domain/align.js";
import { decideHandoffMode } from "../domain/playback.js";
import { detectCuts, extractPcm } from "../media/ffmpeg.js";
import { log } from "../log.js";
import { streamInfo } from "./acquirer.js";
import { mediaInput } from "./media.js";
import { variant, type VariantRow } from "./storage.js";

// Seamless upgrade preparation (ARCHITECTURE.md → Seamless upgrade):
// 1. align the two copies by audio, 2. find cut points ahead of the playhead in
// the new copy, 3. decide the handoff mode, 4. tell the player.

const RATE = 8000;

async function align(ctx: Ctx, from: VariantRow, to: VariantRow): Promise<AlignmentResult> {
  const cachedRow = ctx.db.prepare("SELECT a, b, residual_ms, aligned, reason FROM variant_alignments WHERE from_id = ? AND to_id = ?").get(from.id, to.id) as
    | { a: number; b: number; residual_ms: number; aligned: number; reason: string | null }
    | undefined;
  if (cachedRow) return { a: cachedRow.a, b: cachedRow.b, residualMs: cachedRow.residual_ms, aligned: !!cachedRow.aligned, reason: cachedRow.reason ?? undefined };

  let result: AlignmentResult;
  if (from.release_id && from.release_id === to.release_id) {
    result = { a: 1, b: 0, residualMs: 0, aligned: true };
  } else {
    const [inFrom, inTo] = await Promise.all([mediaInput(ctx, from), mediaInput(ctx, to)]);
    const dur = from.duration_s ?? 0;
    // Short films (demo samples) get short windows; features get 20 s windows ±30 s.
    const win = Math.min(20, Math.max(3, dur * 0.05));
    const margin = Math.min(30, Math.max(4, dur * 0.04));
    const anchors = [0.1, 0.5, 0.9].map((f) => Math.max(margin, dur * f));
    const windows = [];
    for (const t of anchors) {
      const [a, b] = await Promise.all([extractPcm(inFrom, t, win, RATE), extractPcm(inTo, t - margin, win + 2 * margin, RATE)]);
      windows.push({ fromStartS: t, toStartS: t - margin, from: a, to: b });
    }
    result = alignFromWindows(windows, RATE);
  }
  ctx.db
    .prepare("INSERT OR REPLACE INTO variant_alignments (from_id, to_id, a, b, residual_ms, aligned, reason, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(from.id, to.id, result.a, result.b, Number.isFinite(result.residualMs) ? result.residualMs : null, result.aligned ? 1 : 0, result.reason ?? null, ctx.clock.now());
  log.info("aligned", { from: from.id, to: to.id, aligned: result.aligned, b: result.b, a: result.a, residualMs: result.residualMs, reason: result.reason });
  return result;
}

export function playhead(ctx: Ctx, fromVariantId: string): number {
  const p = ctx.db.prepare("SELECT position_s FROM watch_state WHERE last_variant_id = ? ORDER BY updated_at DESC LIMIT 1").pluck().get(fromVariantId) as number | undefined;
  return p ?? 0;
}

export async function prepareUpgrade(ctx: Ctx, fromId: string, toId: string, atS?: number): Promise<UpgradeReady | null> {
  const from = variant(ctx, fromId);
  const to = variant(ctx, toId);
  if (!from || !to) return null;
  const al = await align(ctx, from, to);
  const now = atS ?? playhead(ctx, fromId);
  const sameDynamicRange = from.dynamic_range === to.dynamic_range;

  let cutsFrom: number[] = [];
  let hasUsableBlackSegment = false;
  if (al.aligned && sameDynamicRange) {
    const toIn = await mediaInput(ctx, to);
    const startTo = Math.max(0, al.a * now + al.b);
    const cuts = await detectCuts(toIn, startTo, 300);
    const toFrom = (t: number) => (t - al.b) / al.a;
    if (ctx.cfg.tv.twoDecoders) {
      cutsFrom = cuts.scenes.map(toFrom);
    } else {
      const minLen = ctx.cfg.tv.swapLatencyMs / 1000;
      const usable = cuts.black.filter((s) => s.end - s.start >= minLen);
      hasUsableBlackSegment = usable.length > 0;
      cutsFrom = usable.map((s) => toFrom(s.start));
    }
    cutsFrom = cutsFrom.filter((c) => c > now).map((c) => Math.round(c * 1000) / 1000);
  }
  const mode = decideHandoffMode({ aligned: al.aligned, sameDynamicRange, twoDecoders: ctx.cfg.tv.twoDecoders, hasUsableBlackSegment });
  const finalMode = mode !== "natural-break" && cutsFrom.length === 0 ? "natural-break" : mode;
  const up: UpgradeReady = {
    tmdbId: from.tmdb_id,
    fromVariantId: from.id,
    to: streamInfo(ctx, to, 1),
    a: al.a,
    b: al.b,
    cutsFrom,
    mode: finalMode,
  };
  ctx.db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(`upgrade:${from.tmdb_id}`, JSON.stringify({ ...up, at: ctx.clock.now() }));
  return up;
}

export function pendingUpgrade(ctx: Ctx, tmdbId: number, playingVariantId: string): UpgradeReady | null {
  const raw = ctx.db.prepare("SELECT value_json FROM settings WHERE key = ?").pluck().get(`upgrade:${tmdbId}`) as string | undefined;
  if (!raw) return null;
  const up = JSON.parse(raw) as UpgradeReady;
  if (up.fromVariantId !== playingVariantId || !variant(ctx, up.to.variantId)) return null;
  return up;
}

export function registerUpgradeJobs(ctx: Ctx) {
  ctx.jobs.register("upgrade.prepare", async ({ fromVariantId, toVariantId, atS }: { fromVariantId: string; toVariantId: string; atS?: number }) => {
    const up = await prepareUpgrade(ctx, fromVariantId, toVariantId, atS);
    if (up) ctx.bus.publish({ type: "upgrade", upgrade: up });
  });
}
