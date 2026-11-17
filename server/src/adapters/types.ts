import type { Release } from "../domain/release.js";

// The three outside services, as interfaces. Real clients and the fakes used by
// demo mode and the integration tests both implement these.

export interface TmdbMovie {
  id: number;
  title: string;
  original_title?: string;
  release_date?: string;
  overview?: string;
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average?: number;
  vote_count?: number;
  genre_ids?: number[];
  popularity?: number;
}

export interface TmdbDetail extends TmdbMovie {
  runtime: number | null;
  genres: { id: number; name: string }[];
  tagline?: string | null;
  imdb_id: string | null;
  original_language?: string | null;
  credits?: { cast: { name: string; character?: string }[]; crew: { name: string; job: string }[] };
  recommendations?: { results: TmdbMovie[] };
  release_dates?: { results: { iso_3166_1: string; release_dates: { certification: string; type: number }[] }[] };
}

export interface TmdbProvider {
  provider_id: number;
  provider_name: string;
  display_priority?: number;
}

/** One country's entry of `/movie/:id/watch/providers` (data by JustWatch). */
export interface TmdbWatchProviders {
  link?: string;
  flatrate?: TmdbProvider[];
  free?: TmdbProvider[];
  ads?: TmdbProvider[];
  rent?: TmdbProvider[];
  buy?: TmdbProvider[];
}

export interface TmdbPerson {
  id: number;
  name: string;
  profile_path: string | null;
  known_for_department?: string | null;
  popularity?: number;
  known_for?: { media_type?: string; title?: string; name?: string }[];
}

/** A film in someone's credits: the movie plus their part in it. */
export interface TmdbCredit extends TmdbMovie {
  job?: string;
  character?: string;
}

export interface TmdbPersonDetail extends TmdbPerson {
  movie_credits: { cast: TmdbCredit[]; crew: TmdbCredit[] };
}

export type TmdbList = "trending" | "popular" | "top_rated" | "now_playing" | "upcoming";

export interface DiscoverParams {
  genre?: number;
  sort?: "popularity.desc" | "vote_average.desc" | "primary_release_date.desc" | "revenue.desc";
  yearFrom?: number;
  yearTo?: number;
  minRating?: number;
  page?: number;
}

export interface TmdbApi {
  list(kind: TmdbList, page?: number): Promise<TmdbMovie[]>;
  discover(p: DiscoverParams): Promise<{ results: TmdbMovie[]; totalPages: number }>;
  search(query: string, page?: number): Promise<TmdbMovie[]>;
  movie(id: number): Promise<TmdbDetail>;
  /** Look a film up by IMDb id (e.g. from a chill.institute release). */
  byImdb(imdbId: string): Promise<TmdbMovie | null>;
  /** Series search, when the catalog has one (Cinemeta does; TMDB would need its own call). */
  searchShows?(query: string): Promise<TvShowInfo[]>;
  genres(): Promise<{ id: number; name: string }[]>;
  /** TMDB only: people search (empty when TMDB is off). */
  searchPeople?(query: string): Promise<TmdbPerson[]>;
  /** TMDB only: a person and their film credits (null when TMDB is off). */
  person?(id: number): Promise<TmdbPersonDetail | null>;
  /** TMDB only: where a film streams in a country (null when TMDB has no entry, or is off). */
  watchProviders?(tmdbId: number, region: string): Promise<TmdbWatchProviders | null>;
  /** Image bytes for the /img proxy. */
  image(size: string, path: string): Promise<{ body: Uint8Array; contentType: string }>;
}

export interface PutioTransfer {
  id: number;
  name: string;
  status: "IN_QUEUE" | "WAITING" | "DOWNLOADING" | "COMPLETING" | "SEEDING" | "COMPLETED" | "ERROR" | string;
  percentDone: number;
  etaS: number | null;
  /** The file or folder the transfer produced, once complete. */
  fileId: number | null;
  error: string | null;
  size: number;
}

export interface PutioFile {
  id: number;
  name: string;
  size: number;
  fileType: string; // FOLDER, VIDEO, ...
  parentId: number;
  contentType?: string;
}

export interface PutioSubtitle {
  key: string;
  /** Language name or code as put.io reports it (e.g. "English", "eng"). */
  language: string | null;
  name: string;
  source: string; // folder, mkv, opensubtitles
}

export interface PutioApi {
  ensureFolder(name: string): Promise<number>;
  addTransfer(url: string, parentId: number): Promise<PutioTransfer>;
  getTransfer(id: number): Promise<PutioTransfer>;
  cancelTransfers(ids: number[]): Promise<void>;
  listFiles(parentId: number): Promise<PutioFile[]>;
  getFile(id: number): Promise<PutioFile>;
  /** A short-lived URL for the original file (bound to the requesting IP). */
  downloadUrl(fileId: number): Promise<string>;
  deleteFiles(ids: number[]): Promise<void>;
  /** put.io's subtitles for a video: sidecars in its folder, tracks in the MKV, OpenSubtitles. */
  subtitles(fileId: number): Promise<PutioSubtitle[]>;
  /** One subtitle's text (server-side; the token never reaches the player). */
  subtitleText(fileId: number, key: string, format: "webvtt" | "srt"): Promise<string>;
  accountDisk(): Promise<{ size: number; used: number; avail: number }>;
}

export type ResolvedPlayback =
  | { kind: "ready"; url: string; subtitles: { id: string; language: string; url: string }[] }
  | { kind: "pending" }
  | { kind: "unavailable"; reason: string };

export type TvSource = "NETFLIX" | "HBO_MAX" | "APPLE_TV_PLUS" | "PRIME_VIDEO" | "DISNEY_PLUS" | "HULU" | "PARAMOUNT_PLUS" | "AMC_PLUS" | "PEACOCK" | "ALL_PROVIDERS";

export interface TvShowInfo {
  imdbId: string;
  title: string;
  year: number | null;
  /** Absolute image URL, or a path for the /img proxy (demo mode). */
  posterUrl: string | null;
  backdropUrl: string | null;
  rating: number | null;
  overview: string;
  seasonCount: number | null;
  status: string | null;
  networks: string[];
  genres: string[];
  firstAirDate: string | null;
}

export interface TvSeasonInfo {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  airDate: string | null;
  posterUrl: string | null;
}

export interface TvEpisodeInfo {
  seasonNumber: number;
  episodeNumber: number;
  name: string;
  overview: string;
  airDate: string | null;
  runtime: number | null;
  stillUrl: string | null;
  rating: number | null;
}

export interface ChillApi {
  search(query: string): Promise<Release[]>;
  tvShows(source: TvSource): Promise<TvShowInfo[]>;
  tvShowDetail(imdbId: string): Promise<{ show: TvShowInfo; seasons: TvSeasonInfo[] }>;
  tvSeason(imdbId: string, season: number): Promise<TvEpisodeInfo[]>;
  /** chill.institute's pick for an episode, or null when it has none. */
  tvEpisodeDownload(imdbId: string, season: number, episode: number): Promise<Release | null>;
  /** Read-only: never starts a transfer or conversion. */
  resolvePlayback(fileId: number, delivery: "ORIGINAL" | "HLS"): Promise<ResolvedPlayback>;
  /** Only when the user chose to play (chill's API rule). Idempotent. */
  startConversion(fileId: number): Promise<"pending" | "unavailable">;
}

export interface Services {
  tmdb: TmdbApi;
  chill: ChillApi;
  putio: PutioApi;
}
