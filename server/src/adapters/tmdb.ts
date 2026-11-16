import { http, httpJson } from "../http.js";
import type { DiscoverParams, TmdbApi, TmdbDetail, TmdbList, TmdbMovie, TmdbWatchProviders } from "./types.js";

const API = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";

/** TMDB v3 with a v4 Read Access Token (Bearer). Caching is the caller's job. */
export function tmdbClient(token: string): TmdbApi & { verify(): Promise<void> } {
  const get = <T>(path: string, q: Record<string, string | number | undefined> = {}) => {
    const u = new URL(API + path);
    u.searchParams.set("language", "en-US");
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
    return httpJson<T>(u.toString(), { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, what: `TMDB ${path}` });
  };
  const LIST_PATH: Record<TmdbList, string> = {
    trending: "/trending/movie/week",
    popular: "/movie/popular",
    top_rated: "/movie/top_rated",
    now_playing: "/movie/now_playing",
    upcoming: "/movie/upcoming",
  };
  return {
    /** Throws HttpError 401 when the key is wrong (TMDB's own key check). */
    async verify() {
      const r = await httpJson<{ success?: boolean }>(`${API}/authentication`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, what: "TMDB /authentication", timeoutMs: 8000,
      });
      if (!r.success) throw new Error("TMDB /authentication did not succeed");
    },
    async list(kind, page = 1) {
      return (await get<{ results: TmdbMovie[] }>(LIST_PATH[kind], { page })).results;
    },
    async discover(p: DiscoverParams) {
      const r = await get<{ results: TmdbMovie[]; total_pages: number }>("/discover/movie", {
        with_genres: p.genre,
        sort_by: p.sort ?? "popularity.desc",
        "primary_release_date.gte": p.yearFrom ? `${p.yearFrom}-01-01` : undefined,
        "primary_release_date.lte": p.yearTo ? `${p.yearTo}-12-31` : undefined,
        "vote_average.gte": p.minRating,
        "vote_count.gte": p.sort === "vote_average.desc" ? 500 : 50,
        include_adult: "false",
        page: p.page ?? 1,
      });
      return { results: r.results, totalPages: r.total_pages };
    },
    async search(query, page = 1) {
      return (await get<{ results: TmdbMovie[] }>("/search/movie", { query, page, include_adult: "false" })).results;
    },
    movie(id) {
      return get<TmdbDetail>(`/movie/${id}`, { append_to_response: "credits,recommendations,release_dates" });
    },
    async watchProviders(id, region) {
      const r = await get<{ results: Record<string, TmdbWatchProviders> }>(`/movie/${id}/watch/providers`);
      return r.results[region] ?? null;
    },
    async byImdb(imdbId) {
      const r = await get<{ movie_results: TmdbMovie[] }>(`/find/${imdbId}`, { external_source: "imdb_id" });
      return r.movie_results[0] ?? null;
    },
    async genres() {
      return (await get<{ genres: { id: number; name: string }[] }>("/genre/movie/list")).genres;
    },
    async image(size, path) {
      const res = await http(`${IMG}/${size}/${path.replace(/^\//, "")}`);
      if (!res.ok) throw new Error(`TMDB image ${res.status}`);
      return { body: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "image/jpeg" };
    },
  };
}
