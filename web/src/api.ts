import type {
  Availability, HomeResponse, PlayStatus, Profile, StorageReport, TitleDetail, TitleSummary, UpgradeReady,
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
  pin: (variantId: string, pinned: boolean) => req("POST", `/api/variants/${variantId}/pin`, { pinned }),
  evict: (variantId: string) => req("POST", `/api/variants/${variantId}/evict`),
  health: () => req<{ ok: boolean; fake: boolean }>("GET", "/api/health"),
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

export const img = (size: "w185" | "w342" | "w500" | "w780" | "w1280" | "original", path: string | null | undefined) => (path ? `/img/${size}${path}` : "");

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
