// Where a film streams, from chill.institute's parsed release facts. A web
// release's `source` tag names the service it was captured from (NF = Netflix,
// HMAX/MAX = Max, …), so a title's tags say where it is (or was) streaming.
// No API key needed; when TMDB is configured its watch providers could replace
// this (DECISIONS D41). With TMDB on, `providerServices` reads TMDB's watch
// providers (JustWatch data) instead, and the tags are the fallback. Pure.

import type { Release } from "./release.js";
import type { TmdbProvider, TmdbWatchProviders } from "../adapters/types.js";

export interface Service {
  code: string;
  name: string;
  /** Storefronts sell or rent nearly everything, so they say little about origin. */
  store?: boolean;
}

const SERVICES: [string[], Service][] = [
  [["NF", "NFLX", "NETFLIX"], { code: "netflix", name: "Netflix" }],
  [["HMAX", "MAX", "HBO", "HBOM", "HBOMAX"], { code: "max", name: "HBO Max" }],
  [["DSNP", "DSNY", "DISNEY", "DISNEYPLUS"], { code: "disney", name: "Disney+" }],
  [["HULU"], { code: "hulu", name: "Hulu" }],
  [["ATVP", "APTV", "APPLETV"], { code: "appletv", name: "Apple TV" }],
  [["PCOK", "PEACOCK"], { code: "peacock", name: "Peacock" }],
  [["PMTP", "PARAMOUNT", "PARAMOUNTPLUS", "CBSAA"], { code: "paramount", name: "Paramount+" }],
  [["AMC", "AMCPLUS"], { code: "amc", name: "AMC+" }],
  [["SHO", "SHOWTIME"], { code: "showtime", name: "Showtime" }],
  [["STARZ", "STZ"], { code: "starz", name: "Starz" }],
  [["MUBI"], { code: "mubi", name: "MUBI" }],
  [["CRITERION", "CRIT"], { code: "criterion", name: "Criterion Channel" }],
  [["ROKU"], { code: "roku", name: "The Roku Channel" }],
  [["TUBI"], { code: "tubi", name: "Tubi" }],
  [["STAN"], { code: "stan", name: "Stan" }],
  [["CRAV", "CRAVE"], { code: "crave", name: "Crave" }],
  [["AMZN", "AMZ", "PRIME"], { code: "prime", name: "Prime Video", store: true }],
  [["IT", "ITUNES"], { code: "itunes", name: "Apple TV Store", store: true }],
  [["VUDU", "FANDANGO"], { code: "vudu", name: "Vudu", store: true }],
  [["MA", "MOVIESANYWHERE"], { code: "moviesanywhere", name: "Movies Anywhere", store: true }],
  [["GPLAY", "PLAY"], { code: "googleplay", name: "Google Play", store: true }],
];

/** The service a release tag names, or null ("WEB-DL" from nowhere in particular, BluRay, …). */
export function serviceOf(tag: string | null | undefined): Service | null {
  if (!tag) return null;
  const t = tag.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!t) return null;
  for (const [codes, svc] of SERVICES) if (codes.includes(t)) return svc;
  return null;
}

export const releaseService = (r: Release): Service | null => serviceOf(r.info?.source);

/**
 * The services a title streams on, most likely origin first. Each tag counts
 * by its releases' seeders (popular captures are the meaningful ones).
 * Subscription services come before storefronts; a storefront appears only
 * when nothing else does, or when it clearly dominates (Prime Video originals).
 */
export function titleServices(releases: Release[], max = 3): Service[] {
  const weight = new Map<string, { svc: Service; w: number }>();
  for (const r of releases) {
    const svc = releaseService(r);
    if (!svc) continue;
    const cur = weight.get(svc.code) ?? { svc, w: 0 };
    cur.w += 1 + Math.max(0, r.seeders);
    weight.set(svc.code, cur);
  }
  const all = [...weight.values()].sort((a, b) => b.w - a.w);
  const subs = all.filter((x) => !x.svc.store);
  const stores = all.filter((x) => x.svc.store);
  // A storefront that outweighs every subscription service 3:1 is likely the real home (e.g. a Prime Video original).
  const dominantStore = stores.filter((x) => x.w >= 3 * (subs[0]?.w ?? 0) && x.svc.code === "prime");
  // Keep subscription services that aren't noise next to the leading subscription service.
  const kept = subs.filter((x) => x.w >= 0.05 * (subs[0]?.w ?? 0));
  const ordered = [...dominantStore, ...kept];
  return (ordered.length ? ordered : stores.slice(0, 1)).slice(0, max).map((x) => x.svc);
}

// ---- TMDB watch providers

/** TMDB provider names (lower-case, tiers and channels stripped) → our services. */
const PROVIDER_ALIASES: Record<string, string> = {
  netflix: "netflix", "hbo max": "max", max: "max", hbo: "max", "disney plus": "disney", "disney+": "disney", hulu: "hulu",
  "apple tv plus": "appletv", "apple tv+": "appletv", "apple tv": "appletv", peacock: "peacock", "paramount plus": "paramount", "paramount+": "paramount",
  "paramount+ with showtime": "paramount", "amc+": "amc", "amc plus": "amc", showtime: "showtime", starz: "starz", mubi: "mubi",
  "criterion channel": "criterion", "the roku channel": "roku", "tubi tv": "tubi", tubi: "tubi", "amazon prime video": "prime",
  "prime video": "prime", "amazon video": "prime", "apple tv store": "itunes", itunes: "itunes",
  "fandango at home": "vudu", vudu: "vudu", "google play movies": "googleplay", "movies anywhere": "moviesanywhere",
};

/** TMDB provider ids (US list, checked live 2026-11-16) — sturdier than names: Apple TV+ is now just "Apple TV", the store "Apple TV Store". */
const PROVIDER_IDS: Record<number, string> = {
  8: "netflix", 1899: "max", 1825: "max", 384: "max", 9: "prime", 119: "prime", 10: "prime", 350: "appletv", 2: "itunes",
  337: "disney", 15: "hulu", 386: "peacock", 387: "peacock", 2303: "paramount", 2616: "paramount", 531: "paramount", 582: "paramount",
  633: "paramount", 526: "amc", 528: "amc", 635: "amc", 1854: "amc", 207: "roku", 258: "criterion", 11: "mubi", 73: "tubi",
  7: "vudu", 332: "vudu", 3: "googleplay",
};

/**
 * Not somewhere to watch for a cord-cutting household (DECISIONS D47): JustWatch's
 * own channels, live-TV bundles, and cable networks' apps that need a TV login.
 */
const IGNORED_PROVIDERS = new Set([2285, 2784, 2785, 257, 2528, 2383]);
const squash = (n: string) => n.toLowerCase().replace(/[^a-z0-9&+]/g, "");
const IGNORED_NAMES = new Set(
  [
    "fuboTV", "YouTube TV", "Philo", "Sling TV", "DIRECTV", "DIRECTV STREAM", "Spectrum On Demand", "Xfinity Stream", "Hulu Live TV",
    "TNT", "TBS", "truTV", "FXNow", "Freeform", "A&E", "Lifetime", "History", "AMC", "NBC", "ABC", "CBS", "USA Network",
    "Bravo", "Syfy", "TCM", "Watch TCM", "IFC", "SundanceTV", "E! Online", "Discovery GO",
  ].map(squash),
);
export const ignoredProvider = (p: TmdbProvider) => IGNORED_PROVIDERS.has(p.provider_id) || IGNORED_NAMES.has(squash(p.provider_name));

/** Strip tiers and resellers: "Netflix Standard with Ads", "Max Amazon Channel", "Peacock Premium Plus" → the service. */
export function providerKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+(amazon|apple tv|roku premium|roku) channel$/, "")
    .replace(/\s+(standard|basic)?\s*with ads$/, "")
    .replace(/\s+(premium plus|premium|essential|ad-free|basic)$/, "")
    .trim();
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function providerService(p: TmdbProvider): Service {
  const key = providerKey(p.provider_name);
  const code = PROVIDER_IDS[p.provider_id] ?? PROVIDER_ALIASES[key];
  const known = code ? SERVICES.find(([, s]) => s.code === code)?.[1] : undefined;
  if (known) return known;
  // Unknown to us (Kanopy, Shudder, …): keep TMDB's name, minus the tier.
  const name = p.provider_name.replace(/\s+(Amazon|Apple TV|Roku Premium) Channel$/, "").replace(/\s+(Standard |Basic )?with Ads$/, "");
  return { code: slug(key) || `tmdb-${p.provider_id}`, name };
}

/**
 * One country's TMDB watch providers → what to show. Subscription first, then
 * free / ad-supported, each in TMDB's display order, de-duplicated by service
 * (a film on "Max" and "Max Amazon Channel" is on Max once). Storefronts are
 * listed separately — they rent nearly everything.
 */
export function providerServices(p: TmdbWatchProviders | null | undefined, max = 3): { services: Service[]; stores: Service[] } {
  if (!p) return { services: [], stores: [] };
  const byPriority = (xs: TmdbProvider[] = []) => [...xs].sort((a, b) => (a.display_priority ?? 999) - (b.display_priority ?? 999));
  // Every name in a group counts: "Amazon Prime Video" under flatrate means it's included with Prime.
  const pick = (groups: (TmdbProvider[] | undefined)[], n: number) => {
    const out: Service[] = [];
    for (const g of groups)
      for (const x of byPriority(g)) {
        if (ignoredProvider(x)) continue;
        const { code, name } = providerService(x);
        if (!out.some((o) => o.code === code)) out.push({ code, name });
      }
    return out.slice(0, n);
  };
  const services = pick([p.flatrate, p.free, p.ads], max);
  const stores = services.length ? [] : pick([p.rent, p.buy], 2);
  return { services, stores };
}
