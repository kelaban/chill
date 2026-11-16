import type { HomeResponse, ResumeHero, Row, TitleDetail, TitleSummary, WatchOn } from "@chill/shared";
import type { DiscoverParams, TmdbDetail, TmdbList, TmdbMovie } from "../adapters/types.js";
import { normalizeTitle } from "../domain/release.js";
import type { Ctx } from "../context.js";
import { cached } from "../db.js";
import type { TitleFacts } from "../domain/ranker.js";
import { availability } from "./releases.js";
import { providerServices } from "../domain/services.js";
import { episodeRow, isEpisode, showRow } from "./shows.js";
import { becauseRows, becauseSeeds, genreAffinity, pickGenreRows, type Watched } from "../domain/taste.js";

const H = 3_600_000;

/** Cache keys carry the answering catalog, so a switch to (or away from) TMDB never serves the other's answers. */
const src = (ctx: Ctx) => ctx.catalog.source();

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
  const xs = await cached(ctx.db, `${src(ctx)}:list:${kind}:${page}`, 6 * H, ctx.clock.now(), () => ctx.svc.tmdb.list(kind, page));
  return xs.map(toSummary);
}

export async function discover(ctx: Ctx, p: DiscoverParams): Promise<{ results: TitleSummary[]; totalPages: number }> {
  const r = await cached(ctx.db, `${src(ctx)}:discover:${JSON.stringify(p)}`, 6 * H, ctx.clock.now(), () => ctx.svc.tmdb.discover(p));
  return { results: withReady(r.results.map(toSummary), readySet(ctx)), totalPages: r.totalPages };
}

export async function genres(ctx: Ctx) {
  return cached(ctx.db, `${src(ctx)}:genres`, 7 * 24 * H, ctx.clock.now(), () => ctx.svc.tmdb.genres());
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
  const found = await Promise.all(imdbIds.map((id) => cached(ctx.db, `${src(ctx)}:imdb:${id}`, 7 * 24 * H, ctx.clock.now(), () => ctx.svc.tmdb.byImdb(id)).catch(() => null)));
  return found.filter((m): m is TmdbMovie => !!m);
}

export async function search(ctx: Ctx, q: string): Promise<TitleSummary[]> {
  const query = q.trim();
  if (!query) return [];
  const [fromCatalog, fromReleases] = await Promise.all([
    cached(ctx.db, `${src(ctx)}:search:${query.toLowerCase()}`, H, ctx.clock.now(), () => ctx.svc.tmdb.search(query)).catch(() => [] as TmdbMovie[]),
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
  if (isEpisode(tmdbId)) return episodeTitle(ctx, tmdbId);
  const detail = await cached(ctx.db, `${src(ctx)}:movie:${tmdbId}`, 7 * 24 * H, ctx.clock.now(), () => ctx.svc.tmdb.movie(tmdbId));
  const year = yearOf(detail.release_date);
  ctx.db
    .prepare(
      `INSERT INTO titles (tmdb_id, imdb_id, title, original_title, year, runtime_min, poster_path, backdrop_path, json, fetched_at, original_language)
       VALUES (@id, @imdb, @title, @orig, @year, @runtime, @poster, @backdrop, @json, @now, @lang)
       ON CONFLICT(tmdb_id) DO UPDATE SET imdb_id=@imdb, title=@title, original_title=@orig, year=@year, runtime_min=@runtime,
         poster_path=@poster, backdrop_path=@backdrop, json=@json, fetched_at=@now, original_language=@lang`,
    )
    .run({
      id: tmdbId, imdb: detail.imdb_id, title: detail.title, orig: detail.original_title ?? null, year, runtime: detail.runtime,
      poster: detail.poster_path, backdrop: detail.backdrop_path, json: JSON.stringify(toSummary(detail)), now: ctx.clock.now(),
      lang: detail.original_language ?? null,
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

/** Genres that can have a row (TMDB ids; Cinemeta maps the same ids). */
const GENRE_POOL: { id: number; name: string }[] = [
  { id: 28, name: "Action" }, { id: 878, name: "Sci-Fi" }, { id: 35, name: "Comedy" }, { id: 53, name: "Thrillers" }, { id: 18, name: "Drama" },
  { id: 16, name: "Animation" }, { id: 27, name: "Horror" }, { id: 80, name: "Crime" }, { id: 10749, name: "Romance" }, { id: 12, name: "Adventure" },
  { id: 14, name: "Fantasy" }, { id: 9648, name: "Mystery" }, { id: 99, name: "Documentary" }, { id: 10751, name: "Family" },
  { id: 10752, name: "War" }, { id: 37, name: "Western" }, { id: 36, name: "History" },
];
/** The household default, used until a profile's history says otherwise. */
const DEFAULT_GENRES = [28, 878, 35, 53, 18, 16];

/** The profile's recent films (episodes aside), with genres from the cached catalog detail. */
async function history(ctx: Ctx, profileId: number): Promise<Watched[]> {
  const rows = ctx.db
    .prepare("SELECT tmdb_id, position_s, duration_s, watched, updated_at FROM watch_state WHERE profile_id = ? AND tmdb_id > 0 ORDER BY updated_at DESC LIMIT 20")
    .all(profileId) as { tmdb_id: number; position_s: number; duration_s: number; watched: number; updated_at: number }[];
  const out = await Promise.all(
    rows.map(async (r) => {
      const t = await ensureTitle(ctx, r.tmdb_id).catch(() => null);
      if (!t) return null;
      const fraction = r.watched ? 1 : r.duration_s ? r.position_s / r.duration_s : 0;
      return { tmdbId: r.tmdb_id, title: t.detail.title, genreIds: t.detail.genres.map((g) => g.id), fraction, at: r.updated_at };
    }),
  );
  return out.filter((w): w is Watched => w !== null);
}

export async function home(ctx: Ctx, profileId: number): Promise<HomeResponse> {
  const ready = readySet(ctx);
  const rows: Row[] = [];
  const push = (id: string, title: string, items: TitleSummary[]) => {
    if (items.length) rows.push({ id, title, items: withReady(items, ready) });
  };

  // Films and episodes in progress; a show appears once (its latest episode).
  const cont = (
    ctx.db
      .prepare(
        `SELECT w.tmdb_id, w.position_s, w.duration_s, e.show_imdb FROM watch_state w LEFT JOIN episodes e ON w.tmdb_id < 0 AND e.id = -w.tmdb_id
         WHERE w.profile_id = ? AND w.watched = 0 AND w.position_s > 30 ORDER BY w.updated_at DESC LIMIT 40`,
      )
      .all(profileId) as { tmdb_id: number; position_s: number; duration_s: number; show_imdb: string | null }[]
  ).filter((c, i, all) => !c.show_imdb || all.findIndex((x) => x.show_imdb === c.show_imdb) === i).slice(0, 20);
  const continuing = summariesFromTitles(ctx, cont.map((c) => ({ tmdb_id: c.tmdb_id, progress: c.duration_s ? c.position_s / c.duration_s : 0 })));
  // The hero is "pick up where you left off": the latest unfinished title, or nothing.
  // The Continue Watching row lists the rest (the hero already says it).
  const latest = continuing[0] ? cont.find((c) => c.tmdb_id === continuing[0]!.tmdbId) : undefined;
  const hero: ResumeHero | null = latest ? { ...continuing[0]!, ready: ready.has(latest.tmdb_id), positionS: latest.position_s, durationS: latest.duration_s } : null;
  push("continue", "Continue Watching", continuing.slice(1));

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
  const watched = await history(ctx, profileId);
  const genreRows = pickGenreRows(GENRE_POOL, DEFAULT_GENRES, genreAffinity(watched, ctx.clock.now()));
  const [trending, popular, topRated, nowPlaying, ...genreLists] = await Promise.all([
    settle(list(ctx, "trending"), []),
    settle(list(ctx, "popular"), []),
    settle(list(ctx, "top_rated"), []),
    settle(list(ctx, "now_playing"), []),
    ...genreRows.map((g) => settle(discover(ctx, { genre: g.id }).then((r) => r.results), [] as TitleSummary[])),
  ]);

  // "Because you watched": TMDB's real recommendations for the two latest films
  // watched, minus anything already seen and anything the other row shows. With
  // Cinemeta (no recommendations, only same-genre popular titles) one row at most.
  const seeds = becauseSeeds(watched, ctx.catalog.tmdb ? 2 : 1);
  const seen = new Set(ctx.db.prepare("SELECT tmdb_id FROM watch_state WHERE profile_id = ?").pluck().all(profileId) as number[]);
  const because = becauseRows(
    await Promise.all(
      seeds.map(async (seed) => ({
        seed,
        recs: ((await ensureTitle(ctx, seed.tmdbId).catch(() => null))?.detail.recommendations?.results ?? []).filter((m) => m.poster_path).map(toSummary),
      })),
    ),
    seen,
  );

  push("trending", "Trending Now", trending);
  if (because[0]) push("because", `Because you watched ${because[0].seed.title}`, because[0].items);
  push("popular", "Popular on chill", popular);
  if (because[1]) push("because-2", `Because you watched ${because[1].seed.title}`, because[1].items);
  push("top-rated", "Top Rated", topRated);
  push("now-playing", "New Releases", nowPlaying);
  genreRows.forEach((g, i) => push(`genre-${g.name.toLowerCase()}`, g.name, genreLists[i] ?? []));

  return { hero, rows };
}

/** An episode as a title: facts from the episode and its show (no catalog call). */
function episodeTitle(ctx: Ctx, tmdbId: number): { facts: TitleFacts; detail: TmdbDetail } {
  const e = episodeRow(ctx, tmdbId);
  const show = e ? showRow(ctx, e.show_imdb) : undefined;
  if (!e || !show) throw Object.assign(new Error(`unknown episode ${tmdbId}`), { status: 404 });
  const detail: TmdbDetail = {
    id: tmdbId, title: `${show.title} · S${e.season} E${e.episode}`, original_title: show.title, release_date: e.air_date ?? undefined,
    overview: e.overview ?? show.overview ?? "", poster_path: show.poster_url, backdrop_path: e.still_url ?? show.backdrop_url,
    vote_average: undefined, runtime: e.runtime_min, genres: (JSON.parse(show.genres_json) as string[]).map((name, i) => ({ id: i, name })),
    tagline: e.name, imdb_id: null, original_language: null,
  };
  // Release names carry the show's title, not the episode's; no year (shows span many).
  return { facts: { title: show.title, originalTitle: null, year: null, imdbId: null, runtimeMin: e.runtime_min, originalLanguage: null }, detail };
}

/**
 * Where a film streams now, from TMDB's watch providers (JustWatch data), cached
 * 24 h. Only while TMDB is on; null otherwise, for episodes, on any error, or
 * when TMDB has nothing for the region — the UI then falls back to the
 * release-tag guess (where web copies came from: the film's origin).
 */
export async function watchOn(ctx: Ctx, tmdbId: number): Promise<WatchOn | null> {
  const providers = ctx.svc.tmdb.watchProviders;
  if (!ctx.catalog.tmdb || !providers || isEpisode(tmdbId)) return null;
  const region = ctx.cfg.watchRegion;
  const p = await cached(ctx.db, `${src(ctx)}:providers:${region}:${tmdbId}`, 24 * H, ctx.clock.now(), () => providers(tmdbId, region)).catch(() => null);
  const on = providerServices(p);
  return on.services.length || on.stores.length ? { source: "tmdb", region, ...on } : null;
}

export async function detail(ctx: Ctx, tmdbId: number, profileId: number): Promise<TitleDetail> {
  const [{ detail: d }, on] = await Promise.all([ensureTitle(ctx, tmdbId), watchOn(ctx, tmdbId)]);
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
    watchOn: on,
  };
}
