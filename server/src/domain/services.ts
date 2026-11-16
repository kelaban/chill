// Where a film streams, from chill.institute's parsed release facts. A web
// release's `source` tag names the service it was captured from (NF = Netflix,
// HMAX/MAX = Max, …), so a title's tags say where it is (or was) streaming.
// No API key needed; when TMDB is configured its watch providers could replace
// this (DECISIONS D41). Pure.

import type { Release } from "./release.js";

export interface Service {
  code: string;
  name: string;
  /** Storefronts sell or rent nearly everything, so they say little about origin. */
  store?: boolean;
}

const SERVICES: [string[], Service][] = [
  [["NF", "NFLX", "NETFLIX"], { code: "netflix", name: "Netflix" }],
  [["HMAX", "MAX", "HBO", "HBOM", "HBOMAX"], { code: "max", name: "Max" }],
  [["DSNP", "DSNY", "DISNEY", "DISNEYPLUS"], { code: "disney", name: "Disney+" }],
  [["HULU"], { code: "hulu", name: "Hulu" }],
  [["ATVP", "APTV", "APPLETV"], { code: "appletv", name: "Apple TV+" }],
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
  [["IT", "ITUNES"], { code: "itunes", name: "iTunes", store: true }],
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
