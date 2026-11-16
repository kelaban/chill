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
}

export interface Row {
  id: string;
  title: string;
  items: TitleSummary[];
}

export interface HomeResponse {
  hero: TitleSummary | null;
  rows: Row[];
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
  | { state: "available"; instantLabel: string; targetLabel: string | null; releases: number }
  | { state: "ready"; label: string };

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
