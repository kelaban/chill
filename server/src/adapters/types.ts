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
  genres(): Promise<{ id: number; name: string }[]>;
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
  accountDisk(): Promise<{ size: number; used: number; avail: number }>;
}

export type ResolvedPlayback =
  | { kind: "ready"; url: string; subtitles: { id: string; language: string; url: string }[] }
  | { kind: "pending" }
  | { kind: "unavailable"; reason: string };

export interface ChillApi {
  search(query: string): Promise<Release[]>;
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
