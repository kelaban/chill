import type {
  Availability, EpisodeItem, HomeResponse, PlayStatus, Profile, Row, ShowDetail, StorageReport, TitleDetail, TitleSummary, UpgradeReady,
} from "@chill/shared";

export function profileId(): number {
  try {
    return Number(localStorage.getItem("chill.profile")) || 0;
  } catch {
    return 0;
  }
}
export function setProfileId(id: number) {
  try {
    localStorage.setItem("chill.profile", String(id));
  } catch {
    /* private mode */
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${path}${sep}profile=${profileId() || 1}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** Which catalog answers: TMDB only when its key is configured and works; Cinemeta otherwise. */
export interface Health {
  ok: boolean;
  fake: boolean;
  catalog: "tmdb" | "cinemeta" | "fake";
  tmdb: { state: "off" | "checking" | "ok" | "rejected" | "unreachable"; checkedAt: string | null };
}

export const api = {
  profiles: () => req<Profile[]>("GET", "/api/profiles"),
  addProfile: (name: string, color: string) => req<Profile>("POST", "/api/profiles", { name, color }),
  home: () => req<HomeResponse>("GET", "/api/home"),
  genres: () => req<{ id: number; name: string }[]>("GET", "/api/genres"),
  discover: (genre: number | null, page: number, sort?: string) =>
    req<{ results: TitleSummary[]; totalPages: number }>("GET", `/api/discover?page=${page}${genre ? `&genre=${genre}` : ""}${sort ? `&sort=${sort}` : ""}`),
  search: (q: string) => req<TitleSummary[]>("GET", `/api/search?q=${encodeURIComponent(q)}`),
  title: (id: number) => req<TitleDetail>("GET", `/api/titles/${id}`),
  availability: (id: number) => req<Availability>("GET", `/api/titles/${id}/availability`),
  play: (id: number) => req<PlayStatus>("POST", `/api/titles/${id}/play`),
  playStatus: (id: number) => req<PlayStatus>("GET", `/api/titles/${id}/play`),
  cancelPlay: (id: number) => req<{ ok: true }>("DELETE", `/api/titles/${id}/play`),
  upgrade: (id: number, fromVariantId: string) => req<UpgradeReady | null>("GET", `/api/titles/${id}/upgrade?from=${encodeURIComponent(fromVariantId)}`),
  refreshUpgrade: (id: number, body: { fromVariantId: string; toVariantId: string; positionS: number }) => req("POST", `/api/titles/${id}/upgrade/refresh`, body),
  fallback: (variantId: string) => req<{ state: string; url?: string; kind?: "hls" }>("POST", `/api/variants/${variantId}/fallback`),
  addToList: (id: number) => req("POST", `/api/my-list/${id}`),
  setSubtitle: (id: number, choice: { language: string | null; forced?: boolean; sdh?: boolean }) => req("POST", `/api/titles/${id}/subtitle`, choice),
  removeFromList: (id: number) => req("DELETE", `/api/my-list/${id}`),
  storage: () => req<StorageReport>("GET", "/api/storage"),
  shows: () => req<{ rows: Row[] }>("GET", "/api/shows"),
  show: (imdb: string) => req<ShowDetail>("GET", `/api/shows/${imdb}`),
  season: (imdb: string, n: number) => req<EpisodeItem[]>("GET", `/api/shows/${imdb}/seasons/${n}`),
  searchShows: (q: string) => req<TitleSummary[]>("GET", `/api/shows/search?q=${encodeURIComponent(q)}`),
  next: (id: number) => req<{ tmdbId: number; season: number; episode: number; name: string } | null>("GET", `/api/titles/${id}/next`),
  prefetch: (id: number) => req<PlayStatus>("POST", `/api/titles/${id}/prefetch`),
  pin: (variantId: string, pinned: boolean) => req("POST", `/api/variants/${variantId}/pin`, { pinned }),
  evict: (variantId: string) => req("POST", `/api/variants/${variantId}/evict`),
  health: () => req<Health>("GET", "/api/health"),
};

export function progress(body: { tmdbId: number; variantId: string; positionS: number; durationS: number; event: "heartbeat" | "pause" | "seek" | "stop" | "end" }) {
  // keepalive so the final "stop" survives leaving the page.
  return fetch("/api/progress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, profileId: profileId() || 1 }),
    keepalive: true,
  }).catch(() => {});
}

export function telemetry(body: Record<string, unknown>) {
  return fetch("/api/telemetry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true }).catch(() => {});
}

// Absolute URLs (chill.institute's show art) load directly; paths go through the /img proxy.
export const img = (size: "w185" | "w342" | "w500" | "w780" | "w1280" | "original", path: string | null | undefined) =>
  path ? (/^https?:\/\//.test(path) ? path : `/img/${size}${path}`) : "";

/** Where a card goes: a show opens its page, an episode plays, a film opens its detail. */
export function titleHref(t: { tmdbId: number; kind?: string; showId?: string }): string {
  if (t.kind === "show" && t.showId) return `/show/${t.showId}`;
  if (t.kind === "episode") return `/watch/${t.tmdbId}`;
  return `/title/${t.tmdbId}`;
}

export function fmtBytes(n: number) {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

export function fmtTime(s: number) {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}
