import type { DynamicRange } from "@chill/shared";
import { type AudioCodec, factsOf, normalizeTitle, type Release, type ReleaseFacts, type Source } from "./release.js";
import { W } from "./rankerWeights.js";

export interface TitleFacts {
  title: string;
  originalTitle?: string | null;
  year: number | null;
  imdbId?: string | null;
}

export interface QualityProfile {
  target: {
    resolution: 2160 | 1080;
    /** Allowed dynamic ranges, most preferred first. */
    dynamicRanges: DynamicRange[];
    maxBytes: number;
    minSeeders: number;
    fallback: { resolution: 2160 | 1080 | 720; maxBytes: number };
  };
  instant: { sweetSpotBytes: [number, number]; maxBytes: number };
  /** ISO 639-1 codes; untagged and "multi" always pass. */
  languages: string[];
}

export interface DeviceCaps {
  /** Audio the TV cannot decode at all — releases with it are dropped. */
  unsupportedAudio: AudioCodec[];
  /** Audio that is unverified on the TV — penalized, not dropped. */
  riskyAudio: AudioCodec[];
  dolbyVision: boolean;
}

export const DEFAULT_PROFILE: QualityProfile = {
  target: {
    resolution: 2160,
    dynamicRanges: ["DV", "HDR10"],
    maxBytes: 25e9,
    minSeeders: 5,
    fallback: { resolution: 1080, maxBytes: 12e9 },
  },
  instant: { sweetSpotBytes: [2e9, 8e9], maxBytes: 15e9 },
  languages: ["en"],
};

/** LG OLED G3 until Phase 0 measures it: DTS expected fine, TrueHD unverified. */
export const DEFAULT_DEVICE: DeviceCaps = {
  unsupportedAudio: [],
  riskyAudio: ["truehd", "dts"],
  dolbyVision: true,
};

export interface Scored {
  release: Release;
  facts: ReleaseFacts;
  score: number;
}

export interface Ranking {
  instant: Scored[];
  target: Scored[];
  /** Why each dropped release was dropped (for the debug endpoint and tests). */
  dropped: { id: string; reason: string }[];
}

export function matchesTitle(t: TitleFacts, r: Release): boolean {
  if (t.imdbId && r.imdbId) return t.imdbId.toLowerCase() === r.imdbId.toLowerCase();
  const name = r.info?.title;
  if (!name) return false;
  const n = normalizeTitle(name);
  const ok = [t.title, t.originalTitle].some((x) => x && normalizeTitle(x) === n);
  if (!ok) return false;
  const y = r.info?.year;
  if (t.year && y && Math.abs(t.year - y) > 1) return false;
  return true;
}

function dropReason(t: TitleFacts, r: Release, f: ReleaseFacts, p: QualityProfile, d: DeviceCaps): string | null {
  if (!matchesTitle(t, r)) return "title/year/imdb mismatch";
  if (f.source === "cam") return "cam/telesync";
  if (f.threeD) return "3D";
  if (f.hardcoded) return "hardcoded subtitles";
  if (r.sizeBytes < W.minBytes) return "too small (sample?)";
  if (r.seeders < W.minSeeders) return "too few seeders";
  if (r.sizeBytes > Math.max(p.target.maxBytes, p.instant.maxBytes)) return "too large";
  if (f.language && !["multi", "und", ...p.languages].some((l) => f.language!.startsWith(l))) return `language ${f.language}`;
  if (d.unsupportedAudio.includes(f.audio)) return `unsupported audio ${f.audio}`;
  if (f.dynamicRange === "DV" && !d.dolbyVision) return "Dolby Vision unsupported";
  return null;
}

const log2p = (n: number) => Math.log2(1 + Math.max(0, n));

function sizeFit(bytes: number, [lo, hi]: [number, number]): number {
  if (bytes >= lo && bytes <= hi) return 0;
  const edge = bytes < lo ? lo : hi;
  return -W.instant.sizeOutsidePenalty * Math.abs(Math.log2(bytes / edge));
}

const INSTANT_RES: Record<number, number> = { 2160: W.instant.res2160, 1080: W.instant.res1080, 720: W.instant.res720, 480: 0 };
const INSTANT_SRC: Record<Source, number> = { webdl: 2, bluray: 1.5, webrip: 1, hdtv: 0, dvd: -1, remux: -3, cam: -99, unknown: 0.5 };
const TARGET_SRC: Record<Source, number> = { webdl: 3, bluray: 3, webrip: 1.5, hdtv: 0, dvd: -2, remux: 0, cam: -99, unknown: 0 };

/**
 * `preferredRanges`: the dynamic range of the expected upgrade (the top target
 * pick), so the later switch needs no picture-mode change.
 */
export function instantScore(r: Release, f: ReleaseFacts, p: QualityProfile, d: DeviceCaps, preferredRanges: DynamicRange[] = p.target.dynamicRanges): number {
  return (
    W.instant.seeders * log2p(r.seeders) +
    sizeFit(r.sizeBytes, p.instant.sweetSpotBytes) +
    (f.resolution ? INSTANT_RES[f.resolution] ?? 0 : W.instant.resUnknown) +
    INSTANT_SRC[f.source] +
    (preferredRanges.includes(f.dynamicRange) ? W.instant.matchesTargetRange : 0) -
    (d.riskyAudio.includes(f.audio) ? W.riskyAudioPenalty : 0) -
    (f.video === "other" ? W.instant.oddCodecPenalty : 0)
  );
}

/** null when the release isn't a target candidate at all. */
export function targetScore(r: Release, f: ReleaseFacts, p: QualityProfile, d: DeviceCaps): number | null {
  const t = p.target;
  if (r.seeders < t.minSeeders) return null;
  let res: number;
  if (f.resolution === t.resolution && r.sizeBytes <= t.maxBytes) res = W.target.resMatch;
  else if (f.resolution === t.fallback.resolution && r.sizeBytes <= t.fallback.maxBytes) res = W.target.resFallback;
  else return null;
  const drIndex = t.dynamicRanges.indexOf(f.dynamicRange);
  const dr = drIndex === 0 ? W.target.drFirst : drIndex > 0 ? W.target.drOther : f.resolution === t.resolution ? -W.target.sdrAtTargetPenalty : 0;
  const codec = f.resolution && f.resolution >= 2160 && (f.video === "hevc" || f.video === "av1") ? 1 : 0;
  return res + dr + TARGET_SRC[f.source] + codec + W.target.seeders * log2p(r.seeders) - (d.riskyAudio.includes(f.audio) ? W.riskyAudioPenalty : 0);
}

const bySCore = (a: Scored, b: Scored) => b.score - a.score || b.release.seeders - a.release.seeders || a.release.id.localeCompare(b.release.id);

export function rank(
  title: TitleFacts,
  releases: Release[],
  profile: QualityProfile = DEFAULT_PROFILE,
  device: DeviceCaps = DEFAULT_DEVICE,
  prefer?: { releaseId?: string | null; edition?: string | null },
): Ranking {
  const kept: { r: Release; f: ReleaseFacts; bonus: number }[] = [];
  const dropped: Ranking["dropped"] = [];
  const seen = new Set<string>();
  for (const r of releases) {
    if (seen.has(r.id)) continue; // same release from several indexers
    seen.add(r.id);
    const f = factsOf(r);
    const why = dropReason(title, r, f, profile, device);
    if (why) {
      dropped.push({ id: r.id, reason: why });
      continue;
    }
    const bonus =
      (prefer?.releaseId === r.id ? W.preferSameRelease : 0) +
      (prefer?.edition !== undefined && (prefer.edition ?? null) === f.edition ? W.preferSameEdition : 0);
    kept.push({ r, f, bonus });
  }
  // Target first: the instant pick prefers the dynamic range it will upgrade to.
  const target: Scored[] = [];
  for (const { r, f, bonus } of kept) {
    const ts = targetScore(r, f, profile, device);
    if (ts !== null) target.push({ release: r, facts: f, score: ts + bonus });
  }
  target.sort(bySCore);
  const ranges = target[0] ? [target[0].facts.dynamicRange] : profile.target.dynamicRanges;
  const instant: Scored[] = kept
    .filter(({ r }) => r.sizeBytes <= profile.instant.maxBytes)
    .map(({ r, f, bonus }) => ({ release: r, facts: f, score: instantScore(r, f, profile, device, ranges) + bonus }));
  instant.sort(bySCore);
  return { instant, target, dropped };
}

/** Does this pick already satisfy the target profile (so no upgrade is needed)? */
export function meetsTarget(s: Scored, p: QualityProfile = DEFAULT_PROFILE): boolean {
  return s.facts.resolution === p.target.resolution && p.target.dynamicRanges.includes(s.facts.dynamicRange) && s.release.sizeBytes <= p.target.maxBytes;
}

/** Is `b` a real upgrade over `a`? */
export function isBetter(a: ReleaseFacts, b: ReleaseFacts): boolean {
  const ra = a.resolution ?? 0;
  const rb = b.resolution ?? 0;
  if (rb !== ra) return rb > ra;
  const dr = { SDR: 0, HDR10: 1, DV: 2 } as const;
  return dr[b.dynamicRange] > dr[a.dynamicRange];
}
