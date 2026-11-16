import type { DynamicRange } from "@chill/shared";

/**
 * Release facts as chill.institute's `release_info` reports them. We never parse
 * release names ourselves; this module only *normalizes* the already-parsed
 * fields into small enums the ranker can compare.
 */
export interface ReleaseInfo {
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  resolution?: string;
  quality?: string;
  source?: string;
  codec?: string;
  hdr?: string;
  audio?: string;
  group?: string;
  container?: string;
  language?: string;
  edition?: string;
  bitDepth?: string;
  extended?: boolean;
  hardcoded?: boolean;
  threeD?: boolean;
  proper?: boolean;
  repack?: boolean;
  remastered?: boolean;
  imax?: boolean;
}

export interface Release {
  /** chill.institute's opaque, stable release id. */
  id: string;
  rawTitle: string;
  indexer: string;
  /** Magnet or torrent URL. Never shown to clients. */
  link: string;
  imdbId?: string;
  seeders: number;
  peers: number;
  sizeBytes: number;
  info?: ReleaseInfo;
}

export type Source = "remux" | "bluray" | "webdl" | "webrip" | "hdtv" | "dvd" | "cam" | "unknown";
export type VideoCodec = "h264" | "hevc" | "av1" | "other" | "unknown";
export type AudioCodec = "dts" | "truehd" | "eac3" | "ac3" | "aac" | "other" | "unknown";

export interface ReleaseFacts {
  resolution: number | null; // vertical lines: 2160, 1080, 720, 480
  source: Source;
  video: VideoCodec;
  audio: AudioCodec;
  dynamicRange: DynamicRange;
  threeD: boolean;
  hardcoded: boolean;
  language: string | null;
  edition: string | null;
}

const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/[\s._-]+/g, "");

export function resolutionOf(info?: ReleaseInfo): number | null {
  const r = norm(info?.resolution);
  if (!r) return null;
  if (r.includes("2160") || r === "4k" || r === "uhd") return 2160;
  if (r.includes("1080")) return 1080;
  if (r.includes("720")) return 720;
  if (r.includes("576") || r.includes("480") || r === "sd") return 480;
  return null;
}

const CAM = ["cam", "hdcam", "camrip", "ts", "hdts", "telesync", "tc", "telecine", "scr", "screener", "dvdscr", "workprint", "r5"];

export function sourceOf(info?: ReleaseInfo): Source {
  const q = norm(info?.quality);
  if (!q) return "unknown";
  if (CAM.includes(q)) return "cam";
  if (q.includes("remux")) return "remux";
  if (q.includes("bluray") || q.includes("bdrip") || q.includes("brrip") || q === "bd") return "bluray";
  if (q.includes("webdl") || q === "web") return "webdl";
  if (q.includes("webrip")) return "webrip";
  if (q.includes("hdtv") || q.includes("pdtv")) return "hdtv";
  if (q.includes("dvd")) return "dvd";
  return "unknown";
}

export function videoOf(info?: ReleaseInfo): VideoCodec {
  const c = norm(info?.codec);
  if (!c) return "unknown";
  if (c.includes("265") || c.includes("hevc")) return "hevc";
  if (c.includes("264") || c.includes("avc")) return "h264";
  if (c.includes("av1")) return "av1";
  return "other";
}

export function audioOf(info?: ReleaseInfo): AudioCodec {
  const a = norm(info?.audio);
  if (!a) return "unknown";
  if (a.includes("dts")) return "dts";
  if (a.includes("truehd")) return "truehd";
  if (a.includes("ddp") || a.includes("eac3") || a.includes("dd+") || a.includes("atmos")) return "eac3";
  if (a.includes("ac3") || a.startsWith("dd")) return "ac3";
  if (a.includes("aac")) return "aac";
  return "other";
}

export function dynamicRangeOf(info?: ReleaseInfo): DynamicRange {
  const h = norm(info?.hdr);
  if (!h) return "SDR";
  if (h.includes("dv") || h.includes("dovi") || h.includes("dolbyvision")) return "DV";
  if (h.includes("hdr")) return "HDR10";
  return "SDR";
}

export function factsOf(r: Release): ReleaseFacts {
  const i = r.info;
  return {
    resolution: resolutionOf(i),
    source: sourceOf(i),
    video: videoOf(i),
    audio: audioOf(i),
    dynamicRange: dynamicRangeOf(i),
    threeD: i?.threeD === true,
    hardcoded: i?.hardcoded === true,
    language: i?.language ? i.language.toLowerCase() : null,
    edition: i?.edition ? i.edition.toLowerCase() : i?.extended ? "extended" : null,
  };
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} kB`;
}

const SOURCE_LABEL: Record<Source, string> = {
  remux: "Remux", bluray: "BluRay", webdl: "WEB-DL", webrip: "WEBRip", hdtv: "HDTV", dvd: "DVD", cam: "CAM", unknown: "",
};

export function releaseLabel(r: Release): string {
  const f = factsOf(r);
  const parts = [
    f.resolution ? `${f.resolution}p` : null,
    f.dynamicRange === "SDR" ? null : f.dynamicRange === "DV" ? "Dolby Vision" : "HDR10",
    SOURCE_LABEL[f.source] || null,
  ].filter(Boolean);
  return `${parts.join(" ") || "Unknown quality"} · ${formatBytes(r.sizeBytes)}`;
}

/** Lowercase, strip accents and punctuation; "&" reads as "and". */
export function normalizeTitle(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[^a-z0-9]+/g, "");
}
