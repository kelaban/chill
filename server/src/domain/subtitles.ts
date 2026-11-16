// Subtitles, pure: language normalization, filename facts, SRT/VTT cues with a
// time transform, and the default pick. No I/O.

// ---------------------------------------------------------------- languages

const LANGS: [string, string, string[]][] = [
  // [iso639-1, English name, aliases (639-2/B, 639-2/T, native, common)]
  ["en", "English", ["eng", "english"]],
  ["es", "Spanish", ["spa", "spanish", "español", "espanol", "castellano", "latino", "lat"]],
  ["fr", "French", ["fre", "fra", "french", "français", "francais", "vf", "vff", "vfq"]],
  ["de", "German", ["ger", "deu", "german", "deutsch"]],
  ["it", "Italian", ["ita", "italian", "italiano"]],
  ["pt", "Portuguese", ["por", "portuguese", "português", "portugues", "brazilian", "pob"]],
  ["nl", "Dutch", ["dut", "nld", "dutch", "nederlands"]],
  ["sv", "Swedish", ["swe", "swedish", "svenska"]],
  ["da", "Danish", ["dan", "danish", "dansk"]],
  ["no", "Norwegian", ["nor", "nob", "nno", "norwegian", "norsk"]],
  ["fi", "Finnish", ["fin", "finnish", "suomi"]],
  ["pl", "Polish", ["pol", "polish", "polski"]],
  ["ru", "Russian", ["rus", "russian"]],
  ["uk", "Ukrainian", ["ukr", "ukrainian"]],
  ["cs", "Czech", ["cze", "ces", "czech"]],
  ["hu", "Hungarian", ["hun", "hungarian", "magyar"]],
  ["ro", "Romanian", ["rum", "ron", "romanian"]],
  ["el", "Greek", ["gre", "ell", "greek"]],
  ["tr", "Turkish", ["tur", "turkish"]],
  ["he", "Hebrew", ["heb", "hebrew"]],
  ["ar", "Arabic", ["ara", "arabic"]],
  ["hi", "Hindi", ["hin", "hindi"]],
  ["ja", "Japanese", ["jpn", "japanese"]],
  ["ko", "Korean", ["kor", "korean"]],
  ["zh", "Chinese", ["chi", "zho", "chinese", "chs", "cht", "mandarin", "cantonese"]],
  ["th", "Thai", ["tha", "thai"]],
  ["vi", "Vietnamese", ["vie", "vietnamese"]],
  ["id", "Indonesian", ["ind", "indonesian"]],
];

/** "English" / "eng" / "en-US" / "pt-BR" → "en" / "pt". Unknown or "und" → null. */
export function normalizeLang(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  if (!t || t === "und" || t === "unknown" || t === "zxx" || t === "mul") return null;
  const base = t.split(/[-_]/)[0]!;
  for (const [code, name, aliases] of LANGS) if (base === code || t === name.toLowerCase() || aliases.includes(t) || aliases.includes(base)) return code;
  return /^[a-z]{2}$/.test(base) ? base : null;
}

export function langName(code: string | null): string {
  if (!code) return "Unknown";
  return LANGS.find(([c]) => c === code)?.[1] ?? code.toUpperCase();
}

export interface NameFacts {
  language: string | null;
  forced: boolean;
  sdh: boolean;
}

/**
 * Facts from a subtitle file name: "Movie.en.srt", "Movie.eng.forced.srt",
 * "2_English.srt", "Movie.English.SDH.srt", "Subs/Spanish (Latin).srt".
 */
export function factsFromName(name: string): NameFacts {
  const base = name.split("/").pop()!.replace(/\.(srt|vtt|ass|ssa|sub)$/i, "");
  const tokens = base.split(/[\s._()[\]-]+/).filter(Boolean);
  const lower = tokens.map((t) => t.toLowerCase());
  const forced = lower.includes("forced") || lower.includes("foreign");
  const sdh = lower.includes("sdh") || lower.includes("hi") || lower.includes("cc");
  let language: string | null = null;
  // Prefer the last token that is a language (Movie.2023.en.srt), skipping "hi" (SDH flag).
  for (let i = lower.length - 1; i >= 0 && !language; i--) {
    const t = lower[i]!;
    if (t === "hi" || t === "sdh" || t === "forced" || t === "cc" || /^\d+$/.test(t)) continue;
    if (t.length < 2) continue;
    const n = normalizeLang(t);
    // Only accept 2-letter tokens as languages when they're at the end (avoid "it" in titles).
    if (n && (t.length > 2 || i >= lower.length - 3)) language = n;
  }
  return { language, forced, sdh };
}

// ---------------------------------------------------------------- cues

export interface Cue {
  start: number; // seconds
  end: number;
  text: string;
}

const TS = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function parseTs(s: string): number | null {
  const m = TS.exec(s.trim());
  if (!m) return null;
  const ms = Number(m[4]!.padEnd(3, "0"));
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000;
}

/** Parse SRT or WebVTT text into cues (tolerant: BOMs, CRLF, missing indexes, cue settings). */
export function parseCues(text: string): Cue[] {
  const body = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const cues: Cue[] = [];
  for (const block of body.split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const [a, rest] = lines[i]!.split("-->");
    const start = parseTs(a ?? "");
    const end = parseTs((rest ?? "").trim().split(/\s+/)[0] ?? "");
    if (start === null || end === null || end <= start) continue;
    const textLines = lines.slice(i + 1).join("\n").trim();
    if (textLines) cues.push({ start, end, text: textLines });
  }
  return cues.sort((x, y) => x.start - y.start);
}

function fmt(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

/** Strip ASS override tags ({\an8}, {\i1}) and keep simple <i>/<b>/<u> markup. */
function cleanText(t: string): string {
  return t.replace(/\{\\[^}]*\}/g, "").replace(/<(?!\/?(i|b|u)>)[^>]*>/gi, "").trim();
}

/** WebVTT for `cues` with times mapped t' = scale·t + shift; cues ending before 0 are dropped. */
export function toVtt(cues: Cue[], transform: { scale?: number; shift?: number } = {}): string {
  const scale = transform.scale ?? 1;
  const shift = transform.shift ?? 0;
  const out = ["WEBVTT", ""];
  for (const c of cues) {
    const s = scale * c.start + shift;
    const e = scale * c.end + shift;
    if (e <= 0) continue;
    const text = cleanText(c.text);
    if (!text) continue;
    out.push(`${fmt(Math.max(0, s))} --> ${fmt(e)}`, text, "");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- default pick

export interface TrackFacts {
  id: string;
  language: string | null;
  forced: boolean;
  sdh: boolean;
  /** Lower is better when otherwise equal (e.g. sidecar before embedded). */
  rank?: number;
}

/** A remembered choice for this title: a language (with flags) or explicitly off. */
export type Remembered = { language: string | null; forced: boolean; sdh: boolean } | null;

export interface PickContext {
  /** The film's original language (ISO 639-1), when known. */
  originalLanguage: string | null;
  /** The household's subtitle language (ISO 639-1). */
  preferred: string;
  /** undefined = nothing remembered for this title. */
  remembered?: Remembered;
}

function best(tracks: TrackFacts[], language: string, forced: boolean, sdh?: boolean): TrackFacts | null {
  const xs = tracks
    .filter((t) => t.language === language && t.forced === forced)
    .sort((a, b) => (sdh === undefined ? Number(a.sdh) - Number(b.sdh) : Number(a.sdh !== sdh) - Number(b.sdh !== sdh)) || (a.rank ?? 0) - (b.rank ?? 0) || a.id.localeCompare(b.id));
  return xs[0] ?? null;
}

/**
 * The subtitle to show when playback starts, or null for none.
 *  1. A remembered choice for this title wins (null language = off).
 *  2. Film not in the preferred language → full (non-forced) preferred-language track, non-SDH first.
 *  3. Otherwise → a forced preferred-language track (foreign-dialogue lines), else none.
 */
export function pickSubtitle(tracks: TrackFacts[], ctx: PickContext): TrackFacts | null {
  if (ctx.remembered !== undefined) {
    const r = ctx.remembered;
    if (!r || !r.language) return null;
    return best(tracks, r.language, r.forced, r.sdh) ?? best(tracks, r.language, false, r.sdh) ?? null;
  }
  const foreign = !!ctx.originalLanguage && ctx.originalLanguage !== ctx.preferred;
  if (foreign) return best(tracks, ctx.preferred, false) ?? best(tracks, ctx.preferred, true);
  return best(tracks, ctx.preferred, true);
}

/** The track in `candidates` that best matches `current` (after switching copies), or null. */
export function matchTrack<T extends TrackFacts>(current: Pick<TrackFacts, "language" | "forced" | "sdh">, candidates: T[]): T | null {
  return (
    candidates.find((t) => t.language === current.language && t.forced === current.forced && t.sdh === current.sdh) ??
    candidates.find((t) => t.language === current.language && t.forced === current.forced) ??
    null
  );
}
