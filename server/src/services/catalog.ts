import type { HomeResponse, Row, TitleDetail, TitleSummary } from "@chill/shared";
import type { DiscoverParams, TmdbDetail, TmdbList, TmdbMovie } from "../adapters/types.js";
import { normalizeTitle } from "../domain/release.js";
import type { Ctx } from "../context.js";
import { cached } from "../db.js";
import type { TitleFacts } from "../domain/ranker.js";
import { availability } from "./releases.js";

const H = 3_600_000;

const yearOf = (d?: string) => (d && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : null);

export function toSummary(m: TmdbMovie): TitleSummary {
  return {
    tmdbId: m.id,
    title: m.title,
    year: yearOf(m.release_date),
    posterPath: m.poster_path,
    backdropPath: m.backdrop_path,
    rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
    overview: m.overview,
  };
}

function readySet(ctx: Ctx): Set<number> {
  return new Set(ctx.db.prepare("SELECT DISTINCT tmdb_id FROM variants WHERE ready = 1").pluck().all() as number[]);
}

const withReady = (xs: TitleSummary[], ready: Set<number>) => xs.map((x) => (ready.has(x.tmdbId) ? { ...x, ready: true } : x));

export async function list(ctx: Ctx, kind: TmdbList, page = 1): Promise<TitleSummary[]> {
  const xs = await cached(ctx.db, `tmdb:list:${kind}:${page}`, 6 * H, ctx.clock.now(), () => ctx.svc.tmdb.list(kind, page));
  return xs.map(toSummary);
}

export async function discover(ctx: Ctx, p: DiscoverParams): Promise<{ results: TitleSummary[]; totalPages: number }> {
  const r = await cached(ctx.db, `tmdb:discover:${JSON.stringify(p)}`, 6 * H, ctx.clock.now(), () => ctx.svc.tmdb.discover(p));
  return { results: withReady(r.results.map(toSummary), readySet(ctx)), totalPages: r.totalPages };
}

export async function genres(ctx: Ctx) {
  return cached(ctx.db, "tmdb:genres", 7 * 24 * H, ctx.clock.now(), () => ctx.svc.tmdb.genres());
}

/**
 * Films that chill.institute has releases for, matching the query: its search
 * returns IMDb ids, which the catalog resolves. Finds what catalog search
 * misses (Cinemeta's fuzzy search can't find "Sintel") and guarantees there is
 * something to play. Cached 12 h per query, like every chill.institute search.
 */
async function titlesWithReleases(ctx: Ctx, query: string): Promise<TmdbMovie[]> {
  if (query.length < 3) return [];
  const imdbIds = await cached(ctx.db, `chill:titles:${query.toLowerCase()}`, 12 * H, ctx.clock.now(), async () => {
    const rs = await ctx.svc.chill.search(query);
    const seen = new Map<string, number>();
    for (const r of rs) if (r.imdbId) seen.set(r.imdbId, (seen.get(r.imdbId) ?? 0) + r.seeders);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id]) => id);
  }).catch(() => [] as string[]);
  const found = await Promise.all(imdbIds.map((id) => cached(ctx.db, `catalog:imdb:${id}`, 7 * 24 * H, ctx.clock.now(), () => ctx.svc.tmdb.byImdb(id)).catch(() => null)));
  return found.filter((m): m is TmdbMovie => !!m);
}

export async function search(ctx: Ctx, q: string): Promise<TitleSummary[]> {
  const query = q.trim();
  if (!query) return [];
  const [fromCatalog, fromReleases] = await Promise.all([
    cached(ctx.db, `tmdb:search:${query.toLowerCase()}`, H, ctx.clock.now(), () => ctx.svc.tmdb.search(query)).catch(() => [] as TmdbMovie[]),
    titlesWithReleases(ctx, query),
  ]);
  // Keep the providers' relevance order; exact title matches first, then films
  // with releases, then the rest. De-duplicated by id.
  const nq = normalizeTitle(query);
  const exact = (m: TmdbMovie) => normalizeTitle(m.title) === nq;
  const merged = new Map<number, TmdbMovie>();
  for (const m of [...fromReleases.filter(exact), ...fromCatalog.filter(exact), ...fromReleases, ...fromCatalog]) if (!merged.has(m.id)) merged.set(m.id, m);
  const results = [...merged.values()].filter((m) => m.poster_path).map(toSummary);
  // Pre-warm release search for the likeliest picks, so their detail pages
  // already know whether something is playable. Cached 12 h; low priority.
  for (const r of results.slice(0, 3)) ctx.jobs.enqueue("releases.search", { tmdbId: r.tmdbId }, { dedupeKey: `releases.search:${r.tmdbId}`, delayMs: 500 });
  return withReady(results, readySet(ctx));
}

/** TMDB detail, cached 7 d, and mirrored into `titles` for the ranker and naming. */
export async function ensureTitle(ctx: Ctx, tmdbId: number): Promise<{ facts: TitleFacts; detail: TmdbDetail }> {
  const detail = await cached(ctx.db, `tmdb:movie:${tmdbId}`, 7 * 24 * H, ctx.clock.now(), () => ctx.svc.tmdb.movie(tmdbId));
  const year = yearOf(detail.release_date);
  ctx.db
    .prepare(
      `INSERT INTO titles (tmdb_id, imdb_id, title, original_title, year, runtime_min, poster_path, backdrop_path, json, fetched_at)
       VALUES (@id, @imdb, @title, @orig, @year, @runtime, @poster, @backdrop, @json, @now)
       ON CONFLICT(tmdb_id) DO UPDATE SET imdb_id=@imdb, title=@title, original_title=@orig, year=@year, runtime_min=@runtime,
         poster_path=@poster, backdrop_path=@backdrop, json=@json, fetched_at=@now`,
    )
    .run({
      id: tmdbId, imdb: detail.imdb_id, title: detail.title, orig: detail.original_title ?? null, year, runtime: detail.runtime,
      poster: detail.poster_path, backdrop: detail.backdrop_path, json: JSON.stringify(toSummary(detail)), now: ctx.clock.now(),
    });
  return { facts: { title: detail.title, originalTitle: detail.original_title, year, imdbId: detail.imdb_id, runtimeMin: detail.runtime, originalLanguage: detail.original_language ?? null }, detail };
}

export function titleRow(ctx: Ctx, tmdbId: number) {
  return ctx.db.prepare("SELECT tmdb_id, imdb_id, title, original_title, year, runtime_min, poster_path, backdrop_path FROM titles WHERE tmdb_id = ?").get(tmdbId) as
    | { tmdb_id: number; imdb_id: string | null; title: string; original_title: string | null; year: number | null; runtime_min: number | null; poster_path: string | null; backdrop_path: string | null }
    | undefined;
}

function summariesFromTitles(ctx: Ctx, rows: { tmdb_id: number; progress?: number }[]): TitleSummary[] {
  const out: TitleSummary[] = [];
  for (const r of rows) {
    const t = ctx.db.prepare("SELECT json FROM titles WHERE tmdb_id = ?").pluck().get(r.tmdb_id) as string | undefined;
    if (!t) continue;
    out.push({ ...(JSON.parse(t) as TitleSummary), ...(r.progress !== undefined ? { progress: r.progress } : {}) });
  }
  return out;
}

export function watchState(ctx: Ctx, profileId: number, tmdbId: number) {
  return ctx.db.prepare("SELECT position_s, duration_s, watched, updated_at, last_variant_id, last_release_id, last_edition FROM watch_state WHERE profile_id = ? AND tmdb_id = ?").get(profileId, tmdbId) as
    | { position_s: number; duration_s: number; watched: number; updated_at: number; last_variant_id: string | null; last_release_id: string | null; last_edition: string | null }
    | undefined;
}

const GENRE_ROWS: [number, string][] = [
  [28, "Action"], [878, "Sci-Fi"], [35, "Comedy"], [53, "Thrillers"], [18, "Drama"], [16, "Animation"],
];

export async function home(ctx: Ctx, profileId: number): Promise<HomeResponse> {
  const ready = readySet(ctx);
  const rows: Row[] = [];
  const push = (id: string, title: string, items: TitleSummary[]) => {
    if (items.length) rows.push({ id, title, items: withReady(items, ready) });
  };

  const cont = ctx.db
    .prepare("SELECT tmdb_id, position_s, duration_s FROM watch_state WHERE profile_id = ? AND watched = 0 AND position_s > 30 ORDER BY updated_at DESC LIMIT 20")
    .all(profileId) as { tmdb_id: number; position_s: number; duration_s: number }[];
  push("continue", "Continue Watching", summariesFromTitles(ctx, cont.map((c) => ({ tmdb_id: c.tmdb_id, progress: c.duration_s ? c.position_s / c.duration_s : 0 }))));

  const mine = ctx.db.prepare("SELECT tmdb_id FROM my_list WHERE profile_id = ? ORDER BY added_at DESC").all(profileId) as { tmdb_id: number }[];
  push("my-list", "My List", summariesFromTitles(ctx, mine));

  // What this profile played and what the household fetched, newest first. Independent of
  // whether a copy is still on hand: the home library is a cache that empties on every Play.
  const recent = ctx.db
    .prepare(
      `SELECT tmdb_id, MAX(at) AS at FROM (
         SELECT tmdb_id, created_at AS at FROM acquisitions WHERE state NOT IN ('failed', 'cancelled')
         UNION ALL
         SELECT tmdb_id, updated_at AS at FROM watch_state WHERE profile_id = ?
       ) GROUP BY tmdb_id ORDER BY at DESC LIMIT 20`,
    )
    .all(profileId) as { tmdb_id: number }[];
  push("recent", "Recent", summariesFromTitles(ctx, recent));

  const settle = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
  const [trending, popular, topRated, nowPlaying, ...genreLists] = await Promise.all([
    settle(list(ctx, "trending"), []),
    settle(list(ctx, "popular"), []),
    settle(list(ctx, "top_rated"), []),
    settle(list(ctx, "now_playing"), []),
    ...GENRE_ROWS.map(([g]) => settle(discover(ctx, { genre: g }).then((r) => r.results), [] as TitleSummary[])),
  ]);

  const last = ctx.db
    .prepare("SELECT tmdb_id FROM watch_state WHERE profile_id = ? ORDER BY updated_at DESC LIMIT 1")
    .pluck()
    .get(profileId) as number | undefined;
  let because: { title: string; items: TitleSummary[] } | null = null;
  if (last) {
    const d = await ensureTitle(ctx, last).catch(() => null);
    if (d?.detail.recommendations?.results.length) because = { title: `Because you watched ${d.detail.title}`, items: d.detail.recommendations.results.map(toSummary) };
  }

  push("trending", "Trending Now", trending);
  if (because) push("because", because.title, because.items);
  push("popular", "Popular on chill", popular);
  push("top-rated", "Top Rated", topRated);
  push("now-playing", "New Releases", nowPlaying);
  GENRE_ROWS.forEach(([, name], i) => push(`genre-${name.toLowerCase()}`, name, genreLists[i] ?? []));

  const hero = trending.find((t) => t.backdropPath) ?? popular[0] ?? null;
  return { hero: hero ? { ...hero, ready: ready.has(hero.tmdbId) } : null, rows };
}

export async function detail(ctx: Ctx, tmdbId: number, profileId: number): Promise<TitleDetail> {
  const { detail: d } = await ensureTitle(ctx, tmdbId);
  const ws = watchState(ctx, profileId, tmdbId);
  const cert = d.release_dates?.results.find((r) => r.iso_3166_1 === "US")?.release_dates.find((x) => x.certification)?.certification ?? null;
  if (availability(ctx, tmdbId).state === "unknown") ctx.jobs.enqueue("releases.search", { tmdbId }, { dedupeKey: `releases.search:${tmdbId}` });
  const inList = !!ctx.db.prepare("SELECT 1 FROM my_list WHERE profile_id = ? AND tmdb_id = ?").get(profileId, tmdbId);
  return {
    ...toSummary(d),
    ready: readySet(ctx).has(tmdbId),
    imdbId: d.imdb_id,
    runtimeMin: d.runtime,
    genres: d.genres.map((g) => g.name),
    tagline: d.tagline || null,
    cast: (d.credits?.cast ?? []).slice(0, 8).map((c) => ({ name: c.name, character: c.character })),
    director: d.credits?.crew.find((c) => c.job === "Director")?.name ?? null,
    certification: cert,
    watch: ws ? { positionS: ws.position_s, durationS: ws.duration_s, watched: !!ws.watched, updatedAt: new Date(ws.updated_at).toISOString() } : null,
    availability: availability(ctx, tmdbId),
    recommendations: withReady((d.recommendations?.results ?? []).slice(0, 16).map(toSummary), readySet(ctx)),
    inMyList: inList,
  };
}
