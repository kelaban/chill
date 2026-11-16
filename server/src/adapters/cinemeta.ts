import { httpJson, limiter } from "../http.js";
import type { DiscoverParams, TmdbApi, TmdbDetail, TmdbList, TmdbMovie } from "./types.js";
import { http } from "../http.js";

// Cinemeta: Stremio's public movie catalog (IMDb-based, no API key). Used when
// no TMDB token is configured. Titles keep their TMDB ids (Cinemeta reports
// `moviedb_id`), so switching to TMDB later needs no migration.
//
// Shapes verified live 2026-11-16: catalogs `top` (genre, search, skip),
// `imdbRating` (genre, skip), `year` (genre=YYYY, skip); 50 items a page.

const BASE = "https://v3-cinemeta.strem.io";
const IMG = "https://images.metahub.space";

/** Cinemeta genre names ↔ TMDB genre ids (so the rest of chill stays TMDB-shaped). */
export const CINEMETA_GENRES: { id: number; name: string }[] = [
  { id: 28, name: "Action" }, { id: 12, name: "Adventure" }, { id: 16, name: "Animation" }, { id: 1001, name: "Biography" },
  { id: 35, name: "Comedy" }, { id: 80, name: "Crime" }, { id: 99, name: "Documentary" }, { id: 18, name: "Drama" },
  { id: 10751, name: "Family" }, { id: 14, name: "Fantasy" }, { id: 36, name: "History" }, { id: 27, name: "Horror" },
  { id: 9648, name: "Mystery" }, { id: 10749, name: "Romance" }, { id: 878, name: "Sci-Fi" }, { id: 1002, name: "Sport" },
  { id: 53, name: "Thriller" }, { id: 10752, name: "War" }, { id: 37, name: "Western" },
];
const genreId = (name: string) => CINEMETA_GENRES.find((g) => g.name === name)?.id;
const genreName = (id: number) => CINEMETA_GENRES.find((g) => g.id === id)?.name;

/** First production country → original language (the ranker accepts original-language releases). */
const COUNTRY_LANG: [RegExp, string][] = [
  [/^(United States|USA|United Kingdom|UK|Canada|Australia|New Zealand|Ireland)/i, "en"], [/^South Korea|^Korea/i, "ko"],
  [/^Japan/i, "ja"], [/^France|^Belgium/i, "fr"], [/^(West )?Germany|^Austria/i, "de"], [/^Italy/i, "it"], [/^(Spain|Mexico|Argentina|Chile|Colombia)/i, "es"],
  [/^India/i, "hi"], [/^(China|Hong Kong|Taiwan)/i, "zh"], [/^(Russia|Soviet Union|USSR)/i, "ru"], [/^(Brazil|Portugal)/i, "pt"],
  [/^Denmark/i, "da"], [/^Sweden/i, "sv"], [/^Norway/i, "no"],
];
export function languageFromCountry(country?: string | null): string | null {
  if (!country) return null;
  for (const [re, lang] of COUNTRY_LANG) if (re.test(country.trim())) return lang;
  return null;
}

interface Meta {
  id?: string;
  imdb_id?: string;
  moviedb_id?: number;
  name: string;
  year?: string;
  releaseInfo?: string;
  released?: string;
  description?: string;
  imdbRating?: string;
  genre?: string[];
  genres?: string[];
  runtime?: string;
  cast?: string[];
  director?: string[];
  country?: string;
  popularity?: number;
  popularities?: { moviedb?: number };
}

/** Persistent tmdb ↔ imdb mapping (a SQLite table in production). */
export interface IdStore {
  imdbFor(tmdbId: number): string | null;
  remember(tmdbId: number, imdbId: string): void;
}

const year = (m: Meta) => m.released?.slice(0, 10) ?? (m.year || m.releaseInfo ? `${(m.year || m.releaseInfo)!.slice(0, 4)}-01-01` : undefined);

export function cinemetaClient(ids: IdStore, base = BASE): TmdbApi {
  const run = limiter(4);
  const get = <T>(path: string) => run(() => httpJson<T>(`${base}${path}`, { what: `Cinemeta ${path.split("/").slice(0, 4).join("/")}` }));

  function toMovie(m: Meta): TmdbMovie | null {
    const imdb = m.imdb_id ?? m.id;
    if (!m.moviedb_id || !imdb?.startsWith("tt")) return null;
    ids.remember(m.moviedb_id, imdb);
    const rating = m.imdbRating ? Number(m.imdbRating) : undefined;
    return {
      id: m.moviedb_id,
      title: m.name,
      original_title: m.name,
      release_date: year(m),
      overview: m.description,
      poster_path: `/mh/poster/${imdb}`,
      backdrop_path: `/mh/background/${imdb}`,
      vote_average: Number.isFinite(rating) ? rating : undefined,
      genre_ids: (m.genre ?? m.genres ?? []).map(genreId).filter((x): x is number => x !== undefined),
      popularity: m.popularities?.moviedb ?? m.popularity,
    };
  }

  async function catalog(id: "top" | "imdbRating" | "year", extra: Record<string, string | number | undefined>): Promise<TmdbMovie[]> {
    const parts = Object.entries(extra)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
    const r = await get<{ metas: Meta[] }>(`/catalog/movie/${id}${parts.length ? `/${parts.join("&")}` : ""}.json`);
    return r.metas.map(toMovie).filter((x): x is TmdbMovie => x !== null);
  }

  async function meta(imdb: string): Promise<Meta> {
    return (await get<{ meta: Meta }>(`/meta/movie/${imdb}.json`)).meta;
  }

  const api: TmdbApi = {
    async list(kind: TmdbList, page = 1) {
      const skip = (page - 1) * 50;
      if (kind === "trending") return catalog("top", { skip: skip || undefined });
      if (kind === "popular") return catalog("top", { skip: skip + 50 });
      if (kind === "top_rated") return catalog("imdbRating", { skip: skip || undefined });
      if (kind === "now_playing") return catalog("year", { genre: new Date().getFullYear(), skip: skip || undefined });
      return [];
    },
    async discover(p: DiscoverParams) {
      const g = p.genre ? genreName(p.genre) : undefined;
      const skip = ((p.page ?? 1) - 1) * 50 || undefined;
      let results: TmdbMovie[];
      if (p.sort === "vote_average.desc") results = await catalog("imdbRating", { genre: g, skip });
      else if (p.sort === "primary_release_date.desc" && !g) results = await catalog("year", { genre: new Date().getFullYear(), skip });
      else results = await catalog("top", { genre: g, skip });
      if (p.minRating) results = results.filter((m) => (m.vote_average ?? 0) >= p.minRating!);
      if (p.sort === "primary_release_date.desc") results.sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? ""));
      return { results, totalPages: results.length === 50 ? 20 : p.page ?? 1 };
    },
    async search(query) {
      // Search results carry no TMDB id: resolve the top hits' metadata (cached by the caller).
      const r = await get<{ metas: Meta[] }>(`/catalog/movie/top/search=${encodeURIComponent(query)}.json`);
      const hits = r.metas.filter((m) => (m.imdb_id ?? m.id)?.startsWith("tt")).slice(0, 16);
      const full = await Promise.all(hits.map((h) => meta((h.imdb_id ?? h.id)!).catch(() => null)));
      return full.map((m) => (m ? toMovie(m) : null)).filter((x): x is TmdbMovie => x !== null);
    },
    async movie(tmdbId) {
      const imdb = ids.imdbFor(tmdbId);
      if (!imdb) throw Object.assign(new Error(`Cinemeta: no IMDb id known for title ${tmdbId}`), { status: 404 });
      const m = await meta(imdb);
      const base = toMovie({ ...m, moviedb_id: m.moviedb_id ?? tmdbId, imdb_id: imdb });
      if (!base) throw Object.assign(new Error(`Cinemeta: incomplete metadata for ${imdb}`), { status: 404 });
      const genres = (m.genre ?? m.genres ?? []).map((name) => ({ id: genreId(name) ?? 0, name }));
      // No recommendations endpoint: popular titles in the same first genre.
      const recs = genres[0] ? (await catalog("top", { genre: genres[0].name }).catch(() => [])).filter((x) => x.id !== tmdbId).slice(0, 16) : [];
      const detail: TmdbDetail = {
        ...base,
        runtime: m.runtime ? parseInt(m.runtime, 10) || null : null,
        genres,
        tagline: null,
        imdb_id: imdb,
        original_language: languageFromCountry(m.country),
        credits: { cast: (m.cast ?? []).map((name) => ({ name })), crew: (m.director ?? []).map((name) => ({ name, job: "Director" })) },
        recommendations: { results: recs },
      };
      return detail;
    },
    async byImdb(imdbId) {
      const m = await meta(imdbId).catch(() => null);
      return m ? toMovie({ ...m, imdb_id: imdbId }) : null;
    },
    async searchShows(query) {
      const r = await get<{ metas: Meta[] }>(`/catalog/series/top/search=${encodeURIComponent(query)}.json`);
      return r.metas
        .filter((m) => (m.imdb_id ?? m.id)?.startsWith("tt"))
        .slice(0, 12)
        .map((m) => {
          const imdb = (m.imdb_id ?? m.id)!;
          const y = (m.releaseInfo ?? m.year ?? "").slice(0, 4);
          return {
            imdbId: imdb, title: m.name, year: /^\d{4}$/.test(y) ? Number(y) : null,
            posterUrl: `/mh/poster/${imdb}`, backdropUrl: `/mh/background/${imdb}`, rating: m.imdbRating ? Number(m.imdbRating) : null,
            overview: m.description ?? "", seasonCount: null, status: null, networks: [], genres: m.genre ?? m.genres ?? [], firstAirDate: null,
          };
        });
    },
    async genres() {
      return CINEMETA_GENRES;
    },
    async image(size, path) {
      const m = /^\/?mh\/(poster|background)\/(tt\d+)$/.exec(path);
      if (!m) throw Object.assign(new Error("unknown image"), { status: 404 });
      const kind = m[1]!;
      const variant = kind === "poster" ? (size === "w185" ? "small" : "medium") : size === "w780" ? "medium" : "large";
      const res = await http(`${IMG}/${kind}/${variant}/${m[2]}/img`);
      if (!res.ok) throw Object.assign(new Error(`image ${res.status}`), { status: 404 });
      return { body: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "image/jpeg" };
    },
  };
  return api;
}
