// API contract shared by the server and the SPA. Types only — nothing here may
// carry runtime code, so the SPA bundle never pulls in server modules.

export type TmdbId = number;

export interface TitleSummary {
  tmdbId: TmdbId;
  title: string;
  year: number | null;
  posterPath: string | null;
  backdropPath: string | null;
  /** TMDB vote average, 0–10. */
  rating: number | null;
  overview?: string;
  /** Set when the household has a playable copy right now. */
  ready?: boolean;
  /** 0–1 progress for Continue Watching. */
  progress?: number;
  /** Absent = movie. A show opens its page; an episode plays. */
  kind?: "movie" | "show" | "episode";
  /** The show's IMDb id, for shows and episodes. */
  showId?: string;
  /** Second line for episodes: "S1 E2 · Chapter 12". */
  subtitle?: string;
}

export interface ShowSeason {
  number: number;
  name: string;
  episodeCount: number;
}

export interface ShowDetail {
  imdbId: string;
  title: string;
  year: number | null;
  posterPath: string | null;
  backdropPath: string | null;
  overview: string;
  rating: number | null;
  networks: string[];
  genres: string[];
  status: string | null;
  seasons: ShowSeason[];
  /** What "Play" means for this profile: the episode to resume, or the next unwatched one. */
  next: { tmdbId: number; season: number; episode: number; name: string; resume: boolean; positionS: number } | null;
}

export interface EpisodeItem {
  /** The episode's title id (negative): play it with /watch/:id. */
  tmdbId: number;
  season: number;
  episode: number;
  name: string;
  overview: string;
  airDate: string | null;
  runtimeMin: number | null;
  stillPath: string | null;
  /** 0–1 when partly watched. */
  progress: number | null;
  watched: boolean;
  ready: boolean;
}

export interface Row {
  id: string;
  title: string;
  items: TitleSummary[];
}

export interface HomeResponse {
  /** The profile's latest unfinished title, to pick up where it left off; null when there's none. */
  hero: ResumeHero | null;
  rows: Row[];
}

export interface ResumeHero extends TitleSummary {
  positionS: number;
  durationS: number;
}

export interface Person {
  name: string;
  character?: string;
}

export interface WatchStateDto {
  positionS: number;
  durationS: number;
  watched: boolean;
  updatedAt: string;
}

export type Availability =
  | { state: "unknown" }
  | { state: "searching" }
  | { state: "none" }
  | { state: "available"; instantLabel: string; targetLabel: string | null; releases: number; services: Service[] }
  | { state: "ready"; label: string; services: Service[] };

/** A streaming service a title is on, from its web releases' source tags (Netflix, Max, …). */
export interface Service {
  code: string;
  name: string;
}

export interface TitleDetail extends TitleSummary {
  imdbId: string | null;
  runtimeMin: number | null;
  genres: string[];
  tagline: string | null;
  cast: Person[];
  director: string | null;
  certification: string | null;
  watch: WatchStateDto | null;
  availability: Availability;
  recommendations: TitleSummary[];
  inMyList: boolean;
  /**
   * Where it streams right now, from TMDB's watch providers (data by JustWatch).
   * Only when TMDB is on (key configured and working); otherwise null and the UI
   * uses `availability.services` (from release source tags).
   */
  watchOn: WatchOn | null;
}

export interface WatchOn {
  source: "tmdb";
  region: string;
  /** Subscription, free and ad-supported services, likeliest first. */
  services: Service[];
  /** Rent / buy storefronts, when nothing streams it. */
  stores: Service[];
}

export type AcquisitionPhase =
  | "searching"
  | "queued"
  | "transferring"
  | "ready"
  | "failed"
  | "cancelled";

export interface PlayStatus {
  tmdbId: TmdbId;
  phase: AcquisitionPhase | "idle";
  /** 0–100 while transferring. */
  percent?: number;
  etaSeconds?: number | null;
  releaseLabel?: string;
  message?: string;
  /** Present when phase === "ready". */
  stream?: StreamInfo;
}

export interface StreamInfo {
  variantId: string;
  url: string;
  /** "hls" when the URL is an HLS playlist. */
  kind: "file" | "hls";
  label: string;
  dynamicRange: DynamicRange;
  startAtS: number;
  durationS: number | null;
  /** Normalized audio codec (aac, ac3, eac3, dts, truehd, opus, …) or null if unknown. */
  audioCodec: string | null;
  /** Normalized video codec (h264, hevc, av1, …) or null if unknown. */
  videoCodec: string | null;
  /** Container family (mp4, mkv, …) or null if unknown. */
  container: string | null;
  audioChannels: number | null;
  subtitles: SubtitleTrack[];
  /** The track to start with for this profile, or null for none. */
  subtitleId: string | null;
}

export interface SubtitleTrack {
  id: string;
  /** ISO 639-1, or null if unknown. */
  language: string | null;
  label: string;
  forced: boolean;
  sdh: boolean;
  /** WebVTT in the copy's own timeline; add ?shift=&scale= to map it. */
  url: string;
}

export type DynamicRange = "SDR" | "HDR10" | "DV";

export interface UpgradeReady {
  tmdbId: TmdbId;
  fromVariantId: string;
  to: StreamInfo;
  /** t_to = a * t_from + b (seconds). */
  a: number;
  b: number;
  /** Cut points in the *from* timeline (seconds), ascending. */
  cutsFrom: number[];
  mode: HandoffMode;
}

export type HandoffMode = "seamless" | "black-segment" | "natural-break";

export type ServerEvent =
  | { type: "play"; status: PlayStatus }
  | { type: "upgrade"; upgrade: UpgradeReady }
  | { type: "storage"; report: StorageReport }
  /** Scrub previews just became available for a title's copies. */
  | { type: "trickplay"; tmdbId: TmdbId }
  | { type: "hello" };

export type Tier = "putio" | "local";

export interface VariantDto {
  id: string;
  tmdbId: TmdbId;
  title: string;
  location: Tier;
  quality: "instant" | "target";
  label: string;
  sizeBytes: number;
  status: "playing" | "pinned" | "in-progress" | "watched" | "unwatched" | "superseded";
  pinned: boolean;
  lastPlayedAt: string | null;
}

export interface TierReport {
  tier: Tier;
  usedBytes: number;
  budgetBytes: number;
  highWatermark: number;
  lowWatermark: number;
  variants: VariantDto[];
}

export interface JobDto {
  id: number;
  type: string;
  state: string;
  title: string | null;
  detail: string | null;
  percent: number | null;
}

export interface StorageReport {
  tiers: TierReport[];
  jobs: JobDto[];
  waiting: string[];
}

export interface Profile {
  id: number;
  name: string;
  color: string;
}

export interface HandoffTelemetry {
  tmdbId: TmdbId;
  mode: HandoffMode;
  gapMs: number;
  droppedFrames: number;
  fromVariantId: string;
  toVariantId: string;
}

/**
 * Scrub previews for the copy being played. Frame i of the sheets shows time
 * i·intervalS of the file they came from; for player time t, that file's time
 * is a·t + b (identity when the player is on that file).
 */
export interface TrickplayManifest {
  intervalS: number;
  width: number;
  height: number;
  cols: number;
  rows: number;
  count: number;
  sheets: string[];
  a: number;
  b: number;
}
