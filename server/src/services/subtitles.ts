import fs from "node:fs";
import path from "node:path";
import type { SubtitleTrack } from "@chill/shared";
import { newId, type Ctx } from "../context.js";
import { factsFromName, langName, normalizeLang, parseCues, pickSubtitle, toVtt, type Remembered } from "../domain/subtitles.js";
import { extractSubtitle, runProcess, type Probe } from "../media/ffmpeg.js";
import { log } from "../log.js";
import type { VariantRow } from "./storage.js";

// Subtitles per stored copy (see documentation/plans/phase-4-subtitles.md).
//  put.io copy → put.io's subtitle list for the file (one call), text on demand.
//  home copy   → sidecars next to the video + text tracks inside it.
// Raw WebVTT is cached on disk per track; each request applies its own time
// transform (compat offset, alignment to another copy).

interface Row {
  id: string;
  variant_id: string;
  source: "putio" | "sidecar" | "embedded";
  ref: string;
  language: string | null;
  label: string;
  forced: number;
  sdh: number;
  codec: string | null;
  rank: number;
}

const SIDE_EXT = /\.(srt|vtt|ass|ssa)$/i;
const SOURCE_RANK: Record<string, number> = { folder: 0, mkv: 1, opensubtitles: 2 };

function label(language: string | null, forced: boolean, sdh: boolean, hint?: string | null): string {
  const base = language ? langName(language) : hint?.trim() || "Unknown";
  return `${base}${forced ? " (forced)" : ""}${sdh ? " SDH" : ""}`;
}

function rowsFor(ctx: Ctx, variantId: string): Row[] {
  return ctx.db.prepare("SELECT * FROM subtitles WHERE variant_id = ? ORDER BY rank, language, forced, sdh, id").all(variantId) as Row[];
}

const toDto = (r: Row): SubtitleTrack => ({ id: r.id, language: r.language, label: r.label, forced: !!r.forced, sdh: !!r.sdh, url: `/api/subtitles/${r.id}.vtt` });

export function tracksFor(ctx: Ctx, variantId: string): SubtitleTrack[] {
  return rowsFor(ctx, variantId).map(toDto);
}

/** Find (and record) a copy's subtitle tracks. Runs once per copy. */
export async function discover(ctx: Ctx, v: VariantRow): Promise<void> {
  const fresh = ctx.db.prepare("SELECT subs_checked_at FROM variants WHERE id = ?").pluck().get(v.id) as number | null | undefined;
  if (fresh) return;
  const found: Omit<Row, "id" | "variant_id">[] = [];

  if (v.location === "putio" && v.putio_file_id) {
    const list = await ctx.svc.putio.subtitles(v.putio_file_id).catch((err) => {
      log.warn("put.io subtitles unavailable", { variant: v.id, err });
      return [];
    });
    for (const s of list) {
      const named = factsFromName(s.name);
      const language = normalizeLang(s.language) ?? named.language;
      found.push({ source: "putio", ref: s.key, language, label: label(language, named.forced, named.sdh, s.language), forced: named.forced ? 1 : 0, sdh: named.sdh ? 1 : 0, codec: null, rank: SOURCE_RANK[s.source] ?? 3 });
    }
  } else if (v.location === "local" && v.local_path) {
    const abs = path.join(ctx.cfg.libraryDir, v.local_path);
    const dir = path.dirname(abs);
    const stem = path.basename(abs).replace(/\.[^.]+$/, "");
    for (const f of await fs.promises.readdir(dir).catch(() => [] as string[])) {
      if (!SIDE_EXT.test(f) || !f.startsWith(stem)) continue;
      const facts = factsFromName(f.slice(stem.length));
      found.push({ source: "sidecar", ref: path.relative(ctx.cfg.libraryDir, path.join(dir, f)), language: facts.language, label: label(facts.language, facts.forced, facts.sdh), forced: facts.forced ? 1 : 0, sdh: facts.sdh ? 1 : 0, codec: path.extname(f).slice(1).toLowerCase(), rank: 0 });
    }
    const probe = v.probe_json ? (JSON.parse(v.probe_json) as Partial<Probe>) : null;
    for (const s of probe?.subtitles ?? []) {
      if (!s.text) continue; // image subtitles (PGS/VobSub) can't become WebVTT
      const language = normalizeLang(s.language);
      // Skip an embedded track that duplicates a sidecar we already have.
      if (found.some((x) => x.source === "sidecar" && x.language === language && !!x.forced === s.forced && !!x.sdh === s.sdh)) continue;
      found.push({ source: "embedded", ref: String(s.index), language, label: label(language, s.forced, s.sdh, s.title), forced: s.forced ? 1 : 0, sdh: s.sdh ? 1 : 0, codec: s.codec, rank: 1 });
    }
  }

  ctx.db.transaction(() => {
    ctx.db.prepare("DELETE FROM subtitles WHERE variant_id = ?").run(v.id);
    const ins = ctx.db.prepare("INSERT INTO subtitles (id, variant_id, source, ref, language, label, forced, sdh, codec, rank, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    for (const f of found) ins.run(newId("s"), v.id, f.source, f.ref, f.language, f.label, f.forced, f.sdh, f.codec, f.rank, ctx.clock.now());
    ctx.db.prepare("UPDATE variants SET subs_checked_at = ? WHERE id = ?").run(ctx.clock.now(), v.id);
  })();
  if (found.length) log.info("subtitles found", { variant: v.id, tracks: found.length });
}

const cacheFile = (ctx: Ctx, id: string) => path.join(ctx.cfg.cacheDir, "subs", `${id}.vtt`);

/** A track's WebVTT in its copy's own timeline, cached on disk. */
async function rawVtt(ctx: Ctx, r: Row): Promise<string> {
  const file = cacheFile(ctx, r.id);
  if (fs.existsSync(file)) return fs.promises.readFile(file, "utf8");
  const v = ctx.db.prepare("SELECT * FROM variants WHERE id = ?").get(r.variant_id) as VariantRow | undefined;
  if (!v) throw Object.assign(new Error("copy is gone"), { status: 404 });
  let text: string;
  if (r.source === "putio") {
    text = await ctx.svc.putio.subtitleText(v.putio_file_id!, r.ref, "webvtt");
  } else if (r.source === "sidecar") {
    const abs = path.join(ctx.cfg.libraryDir, r.ref);
    if (/\.(ass|ssa)$/i.test(abs)) text = (await runProcess("ffmpeg", ["-v", "error", "-nostdin", "-i", abs, "-f", "webvtt", "pipe:1"], { timeoutMs: 60_000 })).stdout.toString("utf8");
    else text = await fs.promises.readFile(abs, "utf8");
  } else {
    text = await extractSubtitle(path.join(ctx.cfg.libraryDir, v.local_path!), Number(r.ref));
  }
  const vtt = toVtt(parseCues(text));
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, vtt);
  return vtt;
}

/** WebVTT for a track with times mapped t' = scale·t + shift (compat offset, alignment). */
export async function vttFor(ctx: Ctx, id: string, transform: { scale?: number; shift?: number }): Promise<string> {
  const r = ctx.db.prepare("SELECT * FROM subtitles WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw Object.assign(new Error("no such subtitle"), { status: 404 });
  const raw = await rawVtt(ctx, r);
  if ((transform.scale ?? 1) === 1 && (transform.shift ?? 0) === 0) return raw;
  return toVtt(parseCues(raw), transform);
}

/** The household's subtitle language: English for now (DECISIONS D38). */
export const PREFERRED_LANGUAGE = "en";

export function rememberedChoice(ctx: Ctx, profileId: number, tmdbId: number): Remembered | undefined {
  const r = ctx.db.prepare("SELECT language, forced, sdh FROM subtitle_choice WHERE profile_id = ? AND tmdb_id = ?").get(profileId, tmdbId) as
    | { language: string | null; forced: number; sdh: number }
    | undefined;
  if (!r) return undefined;
  return r.language ? { language: r.language, forced: !!r.forced, sdh: !!r.sdh } : null;
}

export function saveChoice(ctx: Ctx, profileId: number, tmdbId: number, choice: { language: string | null; forced?: boolean; sdh?: boolean }) {
  ctx.db
    .prepare(
      `INSERT INTO subtitle_choice (profile_id, tmdb_id, language, forced, sdh, updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(profile_id, tmdb_id) DO UPDATE SET language = excluded.language, forced = excluded.forced, sdh = excluded.sdh, updated_at = excluded.updated_at`,
    )
    .run(profileId, tmdbId, normalizeLang(choice.language) ?? null, choice.forced ? 1 : 0, choice.sdh ? 1 : 0, ctx.clock.now());
}

/** Which track starts on for this profile and copy (null = off). */
export function defaultSubtitle(ctx: Ctx, profileId: number, v: Pick<VariantRow, "id" | "tmdb_id">): string | null {
  const rows = rowsFor(ctx, v.id);
  if (!rows.length) return null;
  const original = ctx.db.prepare("SELECT original_language FROM titles WHERE tmdb_id = ?").pluck().get(v.tmdb_id) as string | null | undefined;
  const pick = pickSubtitle(
    rows.map((r) => ({ id: r.id, language: r.language, forced: !!r.forced, sdh: !!r.sdh, rank: r.rank })),
    { originalLanguage: normalizeLang(original ?? null), preferred: PREFERRED_LANGUAGE, remembered: rememberedChoice(ctx, profileId, v.tmdb_id) },
  );
  return pick?.id ?? null;
}

/**
 * Before a put.io copy is cleaned up, save its useful subtitles next to the
 * home copy as Plex-style sidecars (`<video stem>.<lang>[.forced][.sdh].srt`).
 * Only the household's language and the film's original language — a handful
 * of small requests, not the whole list.
 */
export async function saveSidecars(ctx: Ctx, putioVariant: VariantRow, localRelPath: string): Promise<number> {
  await discover(ctx, putioVariant).catch(() => {});
  const original = normalizeLang((ctx.db.prepare("SELECT original_language FROM titles WHERE tmdb_id = ?").pluck().get(putioVariant.tmdb_id) as string | null) ?? null);
  const wanted = new Set([PREFERRED_LANGUAGE, original].filter(Boolean));
  const rows = rowsFor(ctx, putioVariant.id).filter((r) => r.source === "putio" && r.language && wanted.has(r.language)).slice(0, 6);
  const abs = path.join(ctx.cfg.libraryDir, localRelPath);
  const stem = abs.replace(/\.[^.]+$/, "");
  const used = new Set<string>();
  let saved = 0;
  for (const r of rows) {
    let name = `${stem}.${r.language}${r.forced ? ".forced" : ""}${r.sdh ? ".sdh" : ""}`;
    for (let i = 2; used.has(name); i++) name = `${stem}.${r.language}${r.forced ? ".forced" : ""}${r.sdh ? ".sdh" : ""}.${i}`;
    used.add(name);
    try {
      const srt = await ctx.svc.putio.subtitleText(putioVariant.putio_file_id!, r.ref, "srt");
      await fs.promises.writeFile(`${name}.srt`, srt);
      saved++;
    } catch (err) {
      log.warn("could not save subtitle home", { variant: putioVariant.id, err });
    }
  }
  return saved;
}

/** Forget a copy's tracks (on eviction). */
export async function forgetSubtitles(ctx: Ctx, variantId: string): Promise<void> {
  for (const r of rowsFor(ctx, variantId)) await fs.promises.rm(cacheFile(ctx, r.id), { force: true });
  ctx.db.prepare("DELETE FROM subtitles WHERE variant_id = ?").run(variantId);
}

export function registerSubtitleJobs(ctx: Ctx) {
  ctx.jobs.register("subtitles.discover", async ({ variantId }: { variantId: string }) => {
    const v = ctx.db.prepare("SELECT * FROM variants WHERE id = ?").get(variantId) as VariantRow | undefined;
    if (v) await discover(ctx, v);
  });
}
