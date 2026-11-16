import type { Release, ReleaseInfo } from "../domain/release.js";
import { http, HttpError, limiter } from "../http.js";
import type { ChillApi, ResolvedPlayback, TvEpisodeInfo, TvSeasonInfo, TvShowInfo } from "./types.js";

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
        season: ri.season != null ? num(ri.season) : undefined,
        episode: ri.episode != null ? num(ri.episode) : undefined,
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

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

export function mapShow(s: any): TvShowInfo | null {
  const imdbId = str(pick(s, "imdbId", "imdb_id"));
  if (!imdbId) return null;
  const status = str(s.status);
  return {
    imdbId,
    title: String(s.title ?? ""),
    year: s.year ? num(s.year) : null,
    posterUrl: str(pick(s, "posterUrl", "poster_url")),
    backdropUrl: str(pick(s, "backdropUrl", "backdrop_url")),
    rating: s.rating != null ? num(s.rating) : null,
    overview: String(s.overview ?? ""),
    seasonCount: pick(s, "seasonCount", "season_count") != null ? num(pick(s, "seasonCount", "season_count")) : null,
    status: status ? status.replace(/^TV_SHOW_STATUS_/, "").toLowerCase() : null,
    networks: Array.isArray(s.networks) ? s.networks.map(String) : [],
    genres: Array.isArray(s.genres) ? s.genres.map(String) : [],
    firstAirDate: str(pick(s, "firstAirDate", "first_air_date")),
  };
}

const mapSeason = (s: any): TvSeasonInfo => ({
  seasonNumber: num(pick(s, "seasonNumber", "season_number")),
  name: String(s.name ?? ""),
  episodeCount: num(pick(s, "episodeCount", "episode_count")),
  airDate: str(pick(s, "airDate", "air_date")),
  posterUrl: str(pick(s, "posterUrl", "poster_url")),
});

const mapEpisode = (e: any): TvEpisodeInfo => ({
  seasonNumber: num(pick(e, "seasonNumber", "season_number")),
  episodeNumber: num(pick(e, "episodeNumber", "episode_number")),
  name: String(e.name ?? ""),
  overview: String(e.overview ?? ""),
  airDate: str(pick(e, "airDate", "air_date")),
  runtime: e.runtime ? num(e.runtime) : null,
  stillUrl: str(pick(e, "stillUrl", "still_url")),
  rating: e.rating != null ? num(e.rating) : null,
});

/** A TVShowDownload (chill.institute's pick for an episode) as our Release. */
export function mapTvDownload(d: any, showTitle = ""): Release | null {
  if (!d?.id || !d.link) return null;
  const episode = pick(d, "episodeNumber", "episode_number");
  return {
    id: String(d.id),
    rawTitle: String(d.title ?? ""),
    indexer: String(d.indexer ?? ""),
    link: String(d.link),
    seeders: num(d.seeders),
    peers: 0,
    sizeBytes: num(d.size),
    info: {
      title: showTitle,
      season: num(pick(d, "seasonNumber", "season_number")) || undefined,
      episode: episode != null ? num(episode) : undefined,
      resolution: str(d.resolution) ?? undefined,
      codec: str(d.codec) ?? undefined,
      quality: str(d.quality) ?? undefined,
    },
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
    async tvShows(source) {
      const r = await call<{ shows?: unknown[] }>("GetTVShows", { source: `TV_SHOWS_SOURCE_${source}` });
      return (r.shows ?? []).map(mapShow).filter((x): x is TvShowInfo => x !== null);
    },
    async tvShowDetail(imdbId) {
      const r = await call<{ show?: unknown; seasons?: unknown[] }>("GetTVShowDetail", { imdbId });
      const show = mapShow(r.show);
      if (!show) throw Object.assign(new Error(`chill: no show ${imdbId}`), { status: 404 });
      return { show, seasons: (r.seasons ?? []).map(mapSeason) };
    },
    async tvSeason(imdbId, season) {
      const r = await call<{ episodes?: unknown[] }>("GetTVShowSeason", { imdbId, seasonNumber: season });
      return (r.episodes ?? []).map(mapEpisode);
    },
    async tvEpisodeDownload(imdbId, season, episode) {
      const r = await call<{ download?: unknown }>("GetTVShowEpisodeDownload", { imdbId, seasonNumber: season, episodeNumber: episode });
      return mapTvDownload(r.download);
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
