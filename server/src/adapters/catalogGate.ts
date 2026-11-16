import { HttpError } from "../http.js";
import { log } from "../log.js";
import type { IdStore } from "./cinemeta.js";
import type { TmdbApi } from "./types.js";

// TMDB is used only when it is configured (TMDB_TOKEN) AND the key works.
// Until then — no token, a rejected key, TMDB unreachable — every call goes to
// the keyless Cinemeta catalog and the TMDB-only features stay off. Both speak
// TMDB ids, so switching either way loses no watch state.
//
// The key is checked at boot, re-checked every 15 minutes while it isn't
// working, and a 401/403 mid-flight turns TMDB off on the spot (that call is
// answered by Cinemeta instead).

export type TmdbState = "off" | "checking" | "ok" | "rejected" | "unreachable";

export interface CatalogGate {
  /** Which catalog answers right now. "fake" is demo mode and the tests. */
  source(): "tmdb" | "cinemeta" | "fake";
  /** TMDB-only features (watch providers, real recommendations) may run. */
  readonly tmdb: boolean;
  status(): { state: TmdbState; checkedAt: number | null; reason: string | null };
  /** Check the key now. Resolves once known (or after `timeoutMs`). */
  verify(timeoutMs?: number): Promise<TmdbState>;
}

const RECHECK_MS = 15 * 60_000;
const rejected = (e: unknown) => e instanceof HttpError && (e.status === 401 || e.status === 403);

/** A gate that never changes: demo mode / tests ("fake" counts as TMDB), or no token at all. */
export function fixedGate(source: "fake" | "cinemeta"): CatalogGate {
  const state: TmdbState = source === "fake" ? "ok" : "off";
  return {
    source: () => source,
    tmdb: source === "fake",
    status: () => ({ state, checkedAt: null, reason: source === "cinemeta" ? "TMDB_TOKEN not set" : null }),
    verify: async () => state,
  };
}

export function gatedCatalog(
  tmdb: TmdbApi & { verify(): Promise<void> },
  fallback: TmdbApi,
  ids: IdStore,
  now: () => number = Date.now,
): { api: TmdbApi; gate: CatalogGate } {
  let state: TmdbState = "checking";
  let checkedAt: number | null = null;
  let reason: string | null = null;
  let inflight: Promise<TmdbState> | null = null;

  const check = (): Promise<TmdbState> =>
    (inflight ??= tmdb
      .verify()
      .then(() => {
        if (state !== "ok") log.info("TMDB key works; using the TMDB catalog");
        state = "ok";
        reason = null;
      })
      .catch((e: unknown) => {
        const was = state;
        state = rejected(e) ? "rejected" : "unreachable";
        reason = e instanceof Error ? e.message : String(e);
        if (was !== state) log.warn(`TMDB ${state}; using Cinemeta until it works`, { reason });
      })
      .then(() => {
        checkedAt = now();
        inflight = null;
        return state;
      }));

  const maybeRecheck = () => {
    if (state !== "ok" && !inflight && (checkedAt === null || now() - checkedAt >= RECHECK_MS)) void check();
  };

  /** TMDB when it works, otherwise (or on a 401/403) the fallback. */
  function route<K extends keyof TmdbApi>(k: K) {
    return (async (...args: unknown[]) => {
      maybeRecheck();
      const viaFallback = () => (fallback[k] as (...a: unknown[]) => unknown)(...args);
      if (state !== "ok") return viaFallback();
      try {
        return await (tmdb[k] as (...a: unknown[]) => Promise<unknown>)(...args);
      } catch (e) {
        if (!rejected(e)) throw e;
        state = "rejected";
        reason = (e as Error).message;
        checkedAt = now();
        log.warn("TMDB rejected the key; using Cinemeta until it works", { reason });
        return viaFallback();
      }
    }) as NonNullable<TmdbApi[K]>;
  }

  const api: TmdbApi = {
    list: route("list"),
    discover: route("discover"),
    search: route("search"),
    async movie(id) {
      const d = await route("movie")(id);
      // Remember the IMDb id, so Cinemeta can still answer for this title if TMDB goes away.
      if (d.imdb_id) ids.remember(id, d.imdb_id);
      return d;
    },
    byImdb: route("byImdb"),
    genres: route("genres"),
    // TMDB has no series search here; Cinemeta's is keyless.
    ...(fallback.searchShows ? { searchShows: (q: string) => fallback.searchShows!(q) } : {}),
    // TMDB-only: when TMDB is off (or refuses mid-flight) the answer is "no data", never an error.
    async watchProviders(id, region) {
      if (state !== "ok" || !tmdb.watchProviders) return null;
      try {
        return await tmdb.watchProviders(id, region);
      } catch (e) {
        if (rejected(e)) {
          state = "rejected";
          checkedAt = now();
        }
        return null;
      }
    },
    // Images go wherever their path came from: Cinemeta's are "/mh/…", the rest
    // are TMDB's (image.tmdb.org needs no key, so they load even with a bad one).
    image(size, path) {
      return /^\/?mh\//.test(path) ? fallback.image(size, path) : tmdb.image(size, path);
    },
  };

  const gate: CatalogGate = {
    source: () => (state === "ok" ? "tmdb" : "cinemeta"),
    get tmdb() {
      return state === "ok";
    },
    status: () => ({ state, checkedAt, reason }),
    async verify(timeoutMs = 5000) {
      const timeout = new Promise<TmdbState>((r) => setTimeout(() => r(state), timeoutMs).unref?.());
      return Promise.race([check(), timeout]);
    },
  };
  return { api, gate };
}
