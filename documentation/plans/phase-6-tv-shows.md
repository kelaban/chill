# Phase 6 — TV shows

> **Status 2026-11-16:** built; tests and e2e pass in demo mode. Not archived until
> checked against the real chill.institute TV endpoints (DECISIONS D44) and on the
> TV. Decisions on the way: one copy per episode (D42), no season packs (D43),
> episodes as negative title ids (D45).

**Goal:** browse shows by service, open a show, pick a season and episode (or
just "Play next"), watch it with everything films already get (fast start,
resume, subtitles, home cache), and roll into the next episode.

**No new key.** chill.institute's v4 API (the token we have) serves it all:

| Need | chill.institute `UserService` |
|---|---|
| Rows by service | `GetTVShows { source }` — Netflix, HBO Max, Apple TV+, Prime Video, Disney+, Hulu, Paramount+, AMC+, Peacock |
| Show page | `GetTVShowDetail { imdb_id }` → show + seasons |
| Episodes | `GetTVShowSeason { imdb_id, season_number }` → names, overviews, stills, runtimes |
| What to download | `GetTVShowEpisodeDownload { imdb_id, season, episode }` → chill's pick (stable release `id`, `link`, size, seeders) |

Search adds Cinemeta's keyless series search. Everything is cached (lists 6 h,
show/season 24 h), so a visit costs at most a couple of chill.institute calls.

## Model: an episode is a "title"

The whole pipeline (acquire → put.io → play → resume → subtitles → home cache →
eviction) is keyed by a numeric title id. Each episode gets a row in
`episodes` and acts as a title with a **negative id** (`-episodes.id`), so it
never collides with TMDB ids and every existing table works unchanged — watch
state stays keyed by title, never by file.

- Migration `0004_tv.sql`: `shows` (by IMDb id), `episodes` (show, season,
  episode, name, overview, air date, runtime, still).
- `ensureTitle(-id)` builds title facts from the episode and show (no catalog
  call). The library path is Plex's TV layout:
  `TV Shows/Show (Year)/Season 01/Show (Year) - S01E02 - Name.mkv`.
- Release search for an episode: chill's own pick plus the general search for
  `Show S01E02`, filtered by `release_info` season/episode (never parsing names),
  ranked by the usual ranker (chill's pick gets a bonus).
- **No 4K upgrade for episodes** (one copy per episode; DECISIONS D42). Season
  packs are out of scope for now (BACKLOG).

## Server

- `adapters/chill.ts`: `tvShows(source)`, `tvShowDetail(imdb)`, `tvSeason(imdb, n)`,
  `tvEpisodeDownload(imdb, s, e)`. Fakes for demo mode.
- `services/shows.ts`: rows by service, show detail with seasons and the
  profile's next episode, season episodes with watch state, episode ids.
- API: `GET /api/shows`, `GET /api/shows/:imdb`, `GET /api/shows/:imdb/seasons/:n`,
  `GET /api/shows/search?q=`. Episodes play through the existing
  `/api/titles/:id/play` with their negative id.
- **Next episode:** `GET /api/titles/:id/next`; the player prefetches the next
  episode once you're halfway through the current one.

## UI

- Nav: **TV Shows** (`/shows`): rows by service; search finds shows too.
- Show page (`/show/:imdb`): backdrop, networks, **Play S1 E1 / Resume S2 E3**,
  season tabs, episode list with stills and progress.
- Player: when an episode ends, the next one starts (a 5 s "Next episode" card
  with Cancel). Continue Watching on Home includes episodes.

## Tests (fakes only)

- Unit: episode release filtering, library path, next-episode logic.
- Integration: show rows, show detail, season episodes, play an episode end to
  end (put.io → home under `TV Shows/…`), resume, next episode + prefetch.
- e2e: open TV Shows with the remote, open a show, play an episode, it rolls
  into the next.

## Acceptance

- [ ] TV Shows rows by service; a show opens with seasons and episodes.
- [ ] Play an episode; stop; Continue Watching resumes it.
- [ ] At the end, the next episode starts by itself (and was prefetched).
- [ ] Subtitles and the audio line work for episodes.
