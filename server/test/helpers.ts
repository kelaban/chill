import type { Release, ReleaseInfo } from "../src/domain/release.js";

let n = 0;

/** A release with sensible defaults; override what the test is about. */
export function rel(info: Partial<ReleaseInfo> & { seeders?: number; size?: number; imdbId?: string; id?: string }): Release {
  const { seeders = 100, size = 4e9, imdbId, id, ...ri } = info;
  n++;
  return {
    id: id ?? `r${n}`,
    rawTitle: `${ri.title ?? "Heat"} ${ri.year ?? 1995} ${ri.resolution ?? ""} ${ri.quality ?? ""}`.trim(),
    indexer: "test",
    link: `magnet:?xt=urn:btih:${String(n).padStart(40, "0")}`,
    imdbId,
    seeders,
    peers: seeders * 2,
    sizeBytes: size,
    info: { title: "Heat", year: 1995, resolution: "1080p", quality: "WEB-DL", codec: "x264", audio: "DDP5.1", ...ri },
  };
}

export const HEAT = { title: "Heat", originalTitle: "Heat", year: 1995, imdbId: "tt0113277" };

export const days = (d: number) => d * 86_400_000;
