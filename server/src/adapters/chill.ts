import type { Release, ReleaseInfo } from "../domain/release.js";
import { http, HttpError, limiter } from "../http.js";
import type { ChillApi, ResolvedPlayback } from "./types.js";

// chill.institute v4 API (Connect-style JSON over HTTP). Schema:
// chill-institute/chill-contracts proto/chill/v4/api.proto. Same host failover
// as their CLI: api.chill.institute, then api.binge.institute, only when a host
// is unreachable or answers 502/503/504.
const HOSTS = ["https://api.chill.institute", "https://api.binge.institute"];
const RETRYABLE = new Set([502, 503, 504]);

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Number(v) : 0) || 0;
const pick = (o: any, camel: string, snake: string) => o?.[camel] ?? o?.[snake];

/** Map one SearchResult (proto JSON; int64 may arrive as strings) to our Release. */
export function mapSearchResult(r: any): Release | null {
  if (!r?.id || !r.link) return null;
  const ri = pick(r, "releaseInfo", "release_info");
  const info: ReleaseInfo | undefined = ri
    ? {
        title: ri.title ?? "",
        year: ri.year != null ? num(ri.year) : undefined,
        resolution: ri.resolution || undefined,
        quality: ri.quality || undefined,
        source: ri.source || undefined,
        codec: ri.codec || undefined,
        hdr: ri.hdr || undefined,
        audio: ri.audio || undefined,
        group: ri.group || undefined,
        container: ri.container || undefined,
        language: ri.language || undefined,
        edition: ri.edition || undefined,
        bitDepth: pick(ri, "bitDepth", "bit_depth") || undefined,
        extended: !!ri.extended,
        hardcoded: !!ri.hardcoded,
        threeD: !!pick(ri, "threeD", "three_d"),
        proper: !!ri.proper,
        repack: !!ri.repack,
        remastered: !!ri.remastered,
        imax: !!ri.imax,
      }
    : undefined;
  return {
    id: String(r.id),
    rawTitle: String(r.title ?? ""),
    indexer: String(r.indexer ?? ""),
    link: String(r.link),
    imdbId: pick(r, "imdbId", "imdb_id") || undefined,
    seeders: num(r.seeders),
    peers: num(r.peers),
    sizeBytes: num(r.size),
    info,
  };
}

export function chillClient(token: string, hosts = HOSTS): ChillApi {
  const run = limiter(2);
  let preferred = 0;

  async function call<T>(method: string, body: unknown): Promise<T> {
    return run(async () => {
      let lastErr: unknown;
      for (let i = 0; i < hosts.length; i++) {
        const idx = (preferred + i) % hosts.length;
        const url = `${hosts[idx]}/v4/chill.v4.UserService/${method}`;
        try {
          const res = await http(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(body),
            timeoutMs: 30_000,
          });
          if (RETRYABLE.has(res.status)) {
            lastErr = new HttpError(res.status, "", `chill ${method}`);
            continue;
          }
          if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ""), `chill ${method}`);
          preferred = idx;
          return (await res.json()) as T;
        } catch (e) {
          if (e instanceof HttpError && !RETRYABLE.has(e.status)) throw e;
          lastErr = e;
        }
      }
      throw lastErr;
    });
  }

  return {
    async search(query) {
      const r = await call<{ results?: unknown[] }>("Search", { query });
      return (r.results ?? []).map(mapSearchResult).filter((x): x is Release => x !== null);
    },
    async resolvePlayback(fileId, delivery): Promise<ResolvedPlayback> {
      const r = await call<any>("ResolvePlayback", { fileId: String(fileId), delivery: `PLAYBACK_DELIVERY_${delivery}` });
      if (r.ready?.media?.url)
        return {
          kind: "ready",
          url: r.ready.media.url,
          subtitles: (r.ready.subtitles ?? []).map((s: any) => ({ id: s.id, language: s.language, url: s.source?.url })).filter((s: any) => s.url),
        };
      if (r.pending) return { kind: "pending" };
      return { kind: "unavailable", reason: String(r.unavailable?.reason ?? "UNAVAILABLE_REASON_UNSPECIFIED") };
    },
    async startConversion(fileId) {
      const r = await call<any>("StartPlaybackConversion", { fileId: String(fileId) });
      return r.pending ? "pending" : "unavailable";
    },
  };
}
