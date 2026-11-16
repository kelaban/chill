import type { EpisodeItem, Row, ShowDetail, TitleSummary } from "@chill/shared";
import type { TvEpisodeInfo, TvShowInfo, TvSource } from "../adapters/types.js";
import type { Ctx } from "../context.js";
import { cached } from "../db.js";
import { normalizeTitle } from "../domain/release.js";

// TV shows (documentation/plans/phase-6-tv-shows.md). chill.institute serves
// the catalog; each episode becomes a title with id = -episodes.id so the
// movie pipeline (acquire, play, resume, subtitles, cache) works unchanged.

const H = 3_600_000;

export const TV_ROWS: [TvSource, string][] = [
  ["NETFLIX", "Netflix"], ["HBO_MAX", "HBO Max"], ["APPLE_TV_PLUS", "Apple TV+"], ["PRIME_VIDEO", "Prime Video"], ["DISNEY_PLUS", "Disney+"],
  ["HULU", "Hulu"], ["PARAMOUNT_PLUS", "Paramount+"], ["PEACOCK", "Peacock"], ["AMC_PLUS", "AMC+"],
];

export const isEpisode = (tmdbId: number) => tmdbId < 0;

const pad = (n: number) => String(n).padStart(2, "0");
export const episodeCode = (s: number, e: number) => `S${pad(s)}E${pad(e)}`;

export function upsertShow(ctx: Ctx, s: TvShowInfo) {
  ctx.db
    .prepare(
      `INSERT INTO shows (imdb_id, title, year, poster_url, backdrop_url, overview, rating, networks_json, genres_json, status, season_count, fetched_at)
       VALUES (@id, @title, @year, @poster, @backdrop, @overview, @rating, @networks, @genres, @status, @seasons, @now)
       ON CONFLICT(imdb_id) DO UPDATE SET title=@title, year=@year, poster_url=COALESCE(@poster, poster_url), backdrop_url=COALESCE(@backdrop, backdrop_url),
         overview=@overview, rating=@rating, networks_json=@networks, genres_json=CASE WHEN @genres = '[]' THEN genres_json ELSE @genres END,
         status=@status, season_count=@seasons, fetched_at=@now`,
    )
    .run({
      id: s.imdbId, title: s.title, year: s.year, poster: s.posterUrl, backdrop: s.backdropUrl, overview: s.overview, rating: s.rating,
      networks: JSON.stringify(s.networks), genres: JSON.stringify(s.genres), status: s.status, seasons: s.seasonCount, now: ctx.clock.now(),
    });
}

interface ShowRow {
  imdb_id: string;
  title: string;
  year: number | null;
  poster_url: string | null;
  backdrop_url: string | null;
  overview: string | null;
  rating: number | null;
  networks_json: string;
  genres_json: string;
  status: string | null;
}

export interface EpisodeRow {
  id: number;
  show_imdb: string;
  season: number;
  episode: number;
  name: string | null;
  overview: string | null;
  air_date: string | null;
  runtime_min: number | null;
  still_url: string | null;
  pick_release_id: string | null;
}

export const showRow = (ctx: Ctx, imdb: string) => ctx.db.prepare("SELECT * FROM shows WHERE imdb_id = ?").get(imdb) as ShowRow | undefined;
export const episodeRow = (ctx: Ctx, tmdbId: number) => ctx.db.prepare("SELECT * FROM episodes WHERE id = ?").get(-tmdbId) as EpisodeRow | undefined;

export function showSummary(s: TvShowInfo | ShowRow): TitleSummary {
  const r = "imdbId" in s
    ? { imdb: s.imdbId, title: s.title, year: s.year, poster: s.posterUrl, backdrop: s.backdropUrl, rating: s.rating, overview: s.overview }
    : { imdb: s.imdb_id, title: s.title, year: s.year, poster: s.poster_url, backdrop: s.backdrop_url, rating: s.rating, overview: s.overview ?? "" };
  return { tmdbId: 0, kind: "show", showId: r.imdb, title: r.title, year: r.year, posterPath: r.poster, backdropPath: r.backdrop, rating: r.rating ? Math.round(r.rating * 10) / 10 : null, overview: r.overview };
}

/**
 * An episode's title id, creating its rows on first sight. Also writes the
 * `titles` row the rest of chill reads (summaries, naming, Continue Watching).
 */
export function episodeTitleId(ctx: Ctx, show: ShowRow, e: TvEpisodeInfo): number {
  ctx.db
    .prepare(
      `INSERT INTO episodes (show_imdb, season, episode, name, overview, air_date, runtime_min, still_url) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(show_imdb, season, episode) DO UPDATE SET name = excluded.name, overview = excluded.overview, air_date = excluded.air_date,
         runtime_min = COALESCE(excluded.runtime_min, runtime_min), still_url = COALESCE(excluded.still_url, still_url)`,
    )
    .run(show.imdb_id, e.seasonNumber, e.episodeNumber, e.name || null, e.overview || null, e.airDate, e.runtime, e.stillUrl);
  const id = ctx.db.prepare("SELECT id FROM episodes WHERE show_imdb = ? AND season = ? AND episode = ?").pluck().get(show.imdb_id, e.seasonNumber, e.episodeNumber) as number;
  const tmdbId = -id;
  const summary: TitleSummary = {
    tmdbId, kind: "episode", showId: show.imdb_id, title: show.title, year: show.year,
    subtitle: `S${e.seasonNumber} E${e.episodeNumber}${e.name ? ` · ${e.name}` : ""}`,
    posterPath: show.poster_url, backdropPath: e.stillUrl ?? show.backdrop_url, rating: null, overview: e.overview,
  };
  ctx.db
    .prepare(
      `INSERT INTO titles (tmdb_id, imdb_id, title, original_title, year, runtime_min, poster_path, backdrop_path, json, fetched_at)
       VALUES (?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tmdb_id) DO UPDATE SET title = excluded.title, year = excluded.year, runtime_min = excluded.runtime_min,
         poster_path = excluded.poster_path, backdrop_path = excluded.backdrop_path, json = excluded.json, fetched_at = excluded.fetched_at`,
    )
    .run(tmdbId, show.title, show.year, e.runtime, show.poster_url, summary.backdropPath, JSON.stringify(summary), ctx.clock.now());
  return tmdbId;
}

async function detailCached(ctx: Ctx, imdb: string) {
  const d = await cached(ctx.db, `chill:tv:${imdb}`, 24 * H, ctx.clock.now(), () => ctx.svc.chill.tvShowDetail(imdb));
  upsertShow(ctx, d.show);
  return d;
}

async function seasonCached(ctx: Ctx, imdb: string, season: number) {
  return cached(ctx.db, `chill:tv:${imdb}:s${season}`, 24 * H, ctx.clock.now(), () => ctx.svc.chill.tvSeason(imdb, season));
}

/** Rows of shows by service (one chill.institute call per service, cached 6 h) plus Continue Watching. */
export async function showsHome(ctx: Ctx, profileId: number): Promise<{ rows: Row[] }> {
  const rows: Row[] = [];
  const cont = continueWatching(ctx, profileId);
  if (cont.length) rows.push({ id: "continue-tv", title: "Continue Watching", items: cont });
  const lists = await Promise.all(
    TV_ROWS.map(([src]) => cached(ctx.db, `chill:tv:list:${src}`, 6 * H, ctx.clock.now(), () => ctx.svc.chill.tvShows(src)).catch(() => [] as TvShowInfo[])),
  );
  TV_ROWS.forEach(([src, label], i) => {
    const shows = lists[i] ?? [];
    for (const s of shows) upsertShow(ctx, s);
    if (shows.length) rows.push({ id: `tv-${src.toLowerCase()}`, title: `Popular on ${label}`, items: shows.map(showSummary) });
  });
  return { rows };
}

/** The latest in-progress (or just-finished) episode per show, as playable items. */
export function continueWatching(ctx: Ctx, profileId: number): TitleSummary[] {
  const rows = ctx.db
    .prepare(
      `SELECT w.tmdb_id, w.position_s, w.duration_s, e.show_imdb FROM watch_state w JOIN episodes e ON e.id = -w.tmdb_id
       WHERE w.profile_id = ? AND w.tmdb_id < 0 AND w.watched = 0 AND w.position_s > 30 ORDER BY w.updated_at DESC`,
    )
    .all(profileId) as { tmdb_id: number; position_s: number; duration_s: number; show_imdb: string }[];
  const seen = new Set<string>();
  const out: TitleSummary[] = [];
  for (const r of rows) {
    if (seen.has(r.show_imdb)) continue;
    seen.add(r.show_imdb);
    const json = ctx.db.prepare("SELECT json FROM titles WHERE tmdb_id = ?").pluck().get(r.tmdb_id) as string | undefined;
    if (json) out.push({ ...(JSON.parse(json) as TitleSummary), progress: r.duration_s ? r.position_s / r.duration_s : 0 });
  }
  return out;
}

export async function seasonEpisodes(ctx: Ctx, profileId: number, imdb: string, season: number): Promise<EpisodeItem[]> {
  await detailCached(ctx, imdb);
  const show = showRow(ctx, imdb)!;
  const eps = await seasonCached(ctx, imdb, season);
  const ready = new Set(ctx.db.prepare("SELECT DISTINCT tmdb_id FROM variants WHERE ready = 1 AND tmdb_id < 0").pluck().all() as number[]);
  return eps.map((e) => {
    const tmdbId = episodeTitleId(ctx, show, e);
    const w = ctx.db.prepare("SELECT position_s, duration_s, watched FROM watch_state WHERE profile_id = ? AND tmdb_id = ?").get(profileId, tmdbId) as
      | { position_s: number; duration_s: number; watched: number }
      | undefined;
    return {
      tmdbId, season: e.seasonNumber, episode: e.episodeNumber, name: e.name || `Episode ${e.episodeNumber}`, overview: e.overview, airDate: e.airDate,
      runtimeMin: e.runtime, stillPath: e.stillUrl, watched: !!w?.watched,
      progress: w && !w.watched && w.duration_s ? w.position_s / w.duration_s : null, ready: ready.has(tmdbId),
    };
  });
}

/** The episode after `tmdbId` (next in its season, else the first of the next season), or null. */
export async function nextEpisode(ctx: Ctx, tmdbId: number): Promise<{ tmdbId: number; season: number; episode: number; name: string } | null> {
  const ep = episodeRow(ctx, tmdbId);
  if (!ep) return null;
  const show = showRow(ctx, ep.show_imdb);
  if (!show) return null;
  const { seasons } = await detailCached(ctx, ep.show_imdb);
  const candidates = [ep.season, ...seasons.map((s) => s.seasonNumber).filter((n) => n > ep.season && n > 0).sort((a, b) => a - b)];
  for (const s of candidates) {
    const eps = (await seasonCached(ctx, ep.show_imdb, s)).filter((e) => (s === ep.season ? e.episodeNumber > ep.episode : true)).sort((a, b) => a.episodeNumber - b.episodeNumber);
    const n = eps[0];
    if (n) return { tmdbId: episodeTitleId(ctx, show, n), season: n.seasonNumber, episode: n.episodeNumber, name: n.name };
  }
  return null;
}

export async function showDetail(ctx: Ctx, profileId: number, imdb: string): Promise<ShowDetail> {
  const { show, seasons } = await detailCached(ctx, imdb);
  const row = showRow(ctx, imdb)!;
  const real = seasons.filter((s) => s.seasonNumber > 0).sort((a, b) => a.seasonNumber - b.seasonNumber);

  // "Play": resume the episode in progress; else the one after the last finished; else the first.
  let next: ShowDetail["next"] = null;
  const last = ctx.db
    .prepare(
      `SELECT w.tmdb_id, w.position_s, w.watched FROM watch_state w JOIN episodes e ON e.id = -w.tmdb_id
       WHERE w.profile_id = ? AND e.show_imdb = ? ORDER BY w.updated_at DESC LIMIT 1`,
    )
    .get(profileId, imdb) as { tmdb_id: number; position_s: number; watched: number } | undefined;
  if (last && !last.watched) {
    const e = episodeRow(ctx, last.tmdb_id)!;
    next = { tmdbId: last.tmdb_id, season: e.season, episode: e.episode, name: e.name ?? "", resume: last.position_s > 30, positionS: last.position_s };
  } else if (last) {
    const n = await nextEpisode(ctx, last.tmdb_id);
    if (n) next = { ...n, resume: false, positionS: 0 };
  }
  if (!next && real[0]) {
    const first = (await seasonCached(ctx, imdb, real[0].seasonNumber)).sort((a, b) => a.episodeNumber - b.episodeNumber)[0];
    if (first) next = { tmdbId: episodeTitleId(ctx, row, first), season: first.seasonNumber, episode: first.episodeNumber, name: first.name, resume: false, positionS: 0 };
  }
  return {
    imdbId: imdb, title: show.title, year: show.year, posterPath: show.posterUrl, backdropPath: show.backdropUrl, overview: show.overview,
    rating: show.rating ? Math.round(show.rating * 10) / 10 : null, networks: show.networks, genres: show.genres.length ? show.genres : (JSON.parse(row.genres_json) as string[]),
    status: show.status, seasons: real.map((s) => ({ number: s.seasonNumber, name: s.name || `Season ${s.seasonNumber}`, episodeCount: s.episodeCount })), next,
  };
}

/** Shows matching a search: the catalog's series search when it has one, else the shows chill.institute has listed. */
export async function searchShows(ctx: Ctx, q: string): Promise<TitleSummary[]> {
  const query = q.trim();
  if (query.length < 2) return [];
  const viaCatalog = ctx.svc.tmdb.searchShows
    ? await cached(ctx.db, `catalog:shows:${query.toLowerCase()}`, H, ctx.clock.now(), () => ctx.svc.tmdb.searchShows!(query)).catch(() => [] as TvShowInfo[])
    : [];
  for (const s of viaCatalog) upsertShow(ctx, s);
  const n = normalizeTitle(query);
  const known = (ctx.db.prepare("SELECT * FROM shows").all() as ShowRow[]).filter((s) => normalizeTitle(s.title).includes(n));
  const out = new Map<string, TitleSummary>();
  for (const s of [...viaCatalog.map(showSummary), ...known.map(showSummary)]) if (s.showId && !out.has(s.showId)) out.set(s.showId, s);
  return [...out.values()].slice(0, 12);
}
