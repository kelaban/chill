# chill — Architecture

> Living document. It describes the system as designed (and, once built, as it
> is). Update it when a decision changes; never archive it.

## Build vs. compose: the decision

| Option | Verdict |
|---|---|
| **Plex** as the app | Rejected as the front end. Its UI only shows what you already own, it can't trigger chill.institute/put.io, and it can't swap a quality mid-life. **Kept** as an optional consumer of the same library folder. |
| **Jellyfin** as the app | Same UI limits as Plex. Open source and has a good webOS client and transcoder. **Kept in reserve** as a playback engine if Phase 0 shows the TV can't direct-play enough (see *Decision gate* below). |
| **Radarr + Prowlarr + Overseerr + putioarr** | Mature, but built for "eventually have the file," not "play in 60 s, upgrade later." Five services to run and glue for one household. Rejected; we borrow their ideas (quality profiles, naming). |
| **Stremio + chill-stremio add-on** | Closest in spirit (browse → put.io playback), but Stremio's webOS story is weak, there's no local tier or storage management, and the UI isn't ours. Good reference implementation for put.io playback. |
| **New app: chill** | **Chosen.** One server, one client. The browse UI and the acquisition/upgrade/eviction logic are the product — they're worth owning. |

## System diagram

```
                    ┌────────────── Internet ──────────────┐
                    │  TMDB   OMDb   chill.institute  put.io│
                    └───▲──────▲──────────▲───────────▲─────┘
                        │      │          │           │ transfers, files,
                        │      │ search   │           │ HLS/original streams
┌───────────────────────┴──────┴──────────┴───────────┴───────────────────┐
│  Home server (Docker)                                                   │
│  ┌──────────────── chill-server (Node 22 + Hono) ─────────────────────┐ │
│  │ catalog      → TMDB/OMDb proxy + SQLite cache + image cache         │ │
│  │ indexer      → chill.institute adapter (Indexer interface)          │ │
│  │ ranker       → pure fn: releases × profile × device → scored picks  │ │
│  │ acquirer     → put.io transfers, instant/target tiers, races        │ │
│  │ mirror       → put.io → local (aria2c, resumable, verified)         │ │
│  │ storage      → budgets, watermarks, eviction, admission control     │ │
│  │ playback     → pick best variant for a device; range-serve / remux  │ │
│  │ progress     → watch state per profile per TMDB id                  │ │
│  │ jobs         → durable SQLite job queue + single worker loop        │ │
│  │ api + SSE    → /api/*, /api/events; serves the built SPA            │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│  volumes: /data/db (SQLite)  /data/library (≤100 GB)  /data/cache         │
│  optional: Plex/Jellyfin reading /data/library        (LAN-only)        │
└────────────────────────────▲────────────────────────────────────────────┘
                             │ LAN (HTTP)
        ┌────────────────────┼──────────────────────┐
        │                    │                      │
  LG OLED G3 (webOS 23+)   Phone / laptop        Google Cast (built
  hosted-app shell →       same SPA as a PWA;    into the same TV)
  loads SPA from           browse + cast sender  Default Media Receiver
  server (/tv)
```

## Repo layout (npm workspaces)

| Path | Contents |
|---|---|
| `server/` | Hono API, job worker, adapters (`tmdb`, `omdb`, `chill`, `putio`), domain (`ranker`, `storage`, `acquirer`, `playback`) |
| `server/src/domain/` | Pure, I/O-free logic with exhaustive unit tests (ranker, eviction policy, variant selection, position mapping) |
| `server/migrations/` | SQLite migrations (`0001_init.sql`, …) |
| `web/` | React SPA: 10-foot TV UI + phone layout from one codebase |
| `webos/` | Hosted-app shell (`appinfo.json`, icons, `index.html`), packaging script |
| `shared/` | Types shared by server and web (API DTOs, enums) |
| `docker/` | `Dockerfile`, `compose.yml`, `.env.example` |
| `documentation/` | PRD, architecture, roadmap, backlog, issues, plans, archive |

## Tech choices

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript `strict`, end to end | Same as COOK; one toolchain. |
| Server | Node 22 LTS + Hono (`@hono/node-server`) | Long-running process with disk I/O, child processes (aria2c, ffmpeg), and a worker loop — not a fit for Workers. Hono keeps the COOK muscle memory. |
| DB | SQLite (`better-sqlite3`) + plain SQL migrations | One file, backs up with `cp`, enough for a household. |
| Jobs | SQLite `jobs` table + one in-process worker | Durable across restarts, no Redis. |
| Live status | Server-Sent Events | Simpler than WebSockets; one-way is all we need. |
| Downloads | `aria2c` (multi-connection, resumable) via JSON-RPC | Saturates the home link; restarts cleanly. |
| Media tools | `ffprobe` always; `ffmpeg` for remux/audio only | Know exactly what each file is; never video-transcode. |
| Client | React 18 + Vite + TanStack Query + React Router | |
| Styling | Tailwind v3.4 | Chosen when the floor was Chromium 94. The TV now runs Chromium 132, so v4 (≥ 111) is possible; migration not done. |
| TV focus | `@noriginmedia/norigin-spatial-navigation` | D-pad focus management; Magic Remote pointer works natively. |
| Video | `<video>` + native HLS on webOS; `hls.js` elsewhere | webOS's media pipeline handles HLS and HEVC in hardware. |
| Build target | Vite `build.target: "chrome132"` | The G3's measured engine (webOS 11.2, Chromium 132; Phase 0). CI fails if the output needs anything newer. |
| Seamless switch | Two `<video>` elements + `requestVideoFrameCallback`; ffmpeg audio cross-correlation + `scdet` on the server | See *Seamless upgrade*. |
| Tests | Vitest; MSW fixtures for TMDB/chill/put.io | |
| Deploy | Self-updating container on the home server (farnsworth): `docker/supervise.sh` builds each new `main` commit beside the running one; the server exits 75 when idle to swap | No registry, no Docker socket. See [`DEPLOY.md`](DEPLOY.md). |

## Domain model (SQLite)

```
profiles      (id, name, avatar, created_at)
titles        (tmdb_id PK, imdb_id, title, original_title, year, runtime_min,
               poster_path, backdrop_path, genres_json, ratings_json, tmdb_json, fetched_at)
watch_state   (profile_id, tmdb_id, position_s, duration_s, watched, last_variant_id, updated_at)
my_list       (profile_id, tmdb_id, added_at)
releases      (id, tmdb_id, source, chill_release_id, raw_title, link, size_bytes, seeders,
               release_info_json, score_instant, score_target, fetched_at)
acquisitions  (id, tmdb_id, tier [instant|target], release_id, state, putio_transfer_id,
               putio_file_id, error, created_at, ready_at)
variants      (id, tmdb_id, location [putio|local], putio_file_id, local_path, size_bytes,
               resolution, hdr, video_codec, audio_codec, container, duration_s,
               probe_json, tier, superseded_by, pinned, last_played_at, created_at)
variant_alignments (from_id, to_id, a, b, residual_ms, created_at)   -- t_to = a·t_from + b
jobs          (id, type, payload_json, state, attempts, run_after, last_error, created_at)
settings      (key PK, value_json)
```

`acquisitions.state`: `searching → queued → transferring → ready | failed | cancelled`.
A **variant** is one playable copy in one place; a title can have several
(put.io instant, put.io target, local target). Watch state never references a
file path — only `last_variant_id` as a hint.

## Key flows

### Play (cold — nothing downloaded)

1. `POST /api/titles/:tmdbId/play` → server looks for a usable variant. None.
2. `indexer.search("<title> <year>")` (cached 12 h) → `releases`.
3. `ranker` filters (title/year/IMDb match; no CAM/TS/3D/hardsub; size caps) and
   scores for both tiers.
4. `acquirer` starts the **instant** transfer on put.io (and the **target**
   transfer too if put.io has room; else queues it).
5. Client shows the preparing screen fed by `GET /api/events` (SSE).
6. **Race:** if the instant transfer is < 50% after 90 s, start the runner-up;
   first to finish wins, the loser is cancelled and deleted.
7. Transfer done → `putio.files` → create `variant(location=putio)` → resolve a
   stream URL (HLS if the original won't direct-play) → client plays and seeks to
   `watch_state.position_s`.

### Upgrade

1. Target transfer finishes → `mirror` job copies it home via aria2c to
   `library/.partial/`, verifies size + `ffprobe`, atomically renames to
   `library/Movies/<Title> (<Year>)/<Title> (<Year>) - <res>.<ext>`.
2. New local variant; older variants get `superseded_by`. Both put.io copies become
   eviction candidates (first in line) — but never while still playing.
3. If the title is playing, the server prepares a **seamless upgrade** (below) and
   pushes it to the player over SSE. No prompt; the player switches on its own.

### Seamless upgrade

The goal: the viewer can't tell the moment it happened, other than the picture
getting better. Three problems, three mechanisms.

**1. The two files don't share a timeline.** Different releases of the same cut
can be offset by seconds (logos, intros) and drift (23.976 vs 24 fps). Job
`align(from, to)` extracts ~60 s of mono 8 kHz audio at three anchors (10%, 50%,
90%) from both files with ffmpeg — the put.io copy over HTTP range requests — and
cross-correlates them (pure function `crossCorrelate(pcmA, pcmB) → offsetMs`).
It fits `t_to = a·t_from + b`. If the anchors disagree or the residual is
> 40 ms, they're different cuts: no seamless switch for this pair (fall back to
the next natural break with proportional mapping). Result is stored in
`variant_alignments(from_id, to_id, a, b, residual_ms)`.

**2. Any switch must happen somewhere it can't be seen.** The server runs ffmpeg
`scdet` (scene-change) and `blackdetect` on the *target* file over the next ~5 min
past the playhead and sends cut points, refreshed as playback moves. The switch
always lands exactly on a cut.

**3. The new file must be ready before the old one lets go.** On the client:

1. Pick the next cut `c` ≥ 15 s ahead (in the playing file's timeline).
2. Load the new source into a second, hidden, muted `<video>`; seek it to
   `map(c)`; wait until it has buffered ≥ 10 s and is paused on that frame.
3. Watch the playing element with `requestVideoFrameCallback`. On the frame where
   `mediaTime` reaches `c`: `play()` the new element, show it, ramp audio across
   over ~120 ms, then stop and release the old element.
4. Log the measured gap (last old frame → first new frame) for the success metric.

**Fallbacks**, chosen from Phase 0's measurements:

- If the TV can't run two decoders at once (one being 4K HEVC): single-element
  swap at a **black segment** at least as long as the measured swap latency;
  if none appears in the next 10 min, at the next natural break.
- If the dynamic range differs (SDR ↔ HDR10 ↔ Dolby Vision): the TV panel
  changes picture mode and blanks for a moment, which no software hides. Switch
  only at the next natural break (pause, seek, resume). The ranker prefers an
  instant pick with the target's dynamic range to make this case rare.
- If alignment failed: next natural break, proportional position mapping.

### Subtitles

Each stored copy's tracks are recorded once (`subtitles` table): a put.io copy
lists put.io's subtitles for the file (sidecars in the transfer, tracks in the
MKV); a home copy lists its Plex-style sidecars plus text tracks inside the file
(ffprobe). Copying home saves put.io's English and original-language subtitles
as sidecars first. Text is served as WebVTT from `/api/subtitles/:id.vtt`,
cached raw on disk, with `?scale=&shift=` mapping it onto another timeline. The
player keeps the viewer's *choice* (language + forced/SDH), not a track: after a
switch it uses the new copy's matching track, or maps the old one through the
alignment (`scale = a`, `shift = b`); on the compat stream it shifts by the
offset. It draws the cues itself, above the controls. Defaults and memory per
profile per title: `domain/subtitles.ts` → `pickSubtitle`.

### TV shows

chill.institute serves the TV catalog (rows by service, show detail with
seasons, season episodes, and its own pick of release per episode); Cinemeta's
keyless series catalog adds search. Each episode is a row in `episodes` and
acts as a **title with a negative id**, so the movie pipeline runs unchanged.
Release search for an episode = chill's pick (ranked first) + the general
search for `Show S01E02` filtered by parsed season/episode. One copy per
episode (no 4K upgrade); the next episode is prefetched at 50% and starts after
a 5 s "Up next" card. Copies home use Plex's TV layout
(`TV Shows/Show (Year)/Season 01/Show (Year) - S01E02 - Name.mkv`).

### Resume after eviction

Same as cold Play, but the ranker prefers the release (or edition) recorded in
`last_variant_id` so timelines match. When durations differ by > 2%, the position
maps proportionally and rewinds 15 s.

### Eviction (runs on every Play, after every acquisition, and hourly)

- **On Play** (not a My List prefetch): `cacheEvictions(localVariants, tmdbId, now)`
  clears every other title's home copy that `evictionClass` lets go (not playing, pinned
  or protected). The home library is a cache of what's on now, not a collection.
- **Budgets:** pure function `planEviction(variants, budgets, now) → variantIds`, applied per tier.
  See PRD for the order. Admission control: a transfer or mirror only starts when its
  tier has `size × 1.1` free after planned evictions; otherwise its job waits.

## HTTP API (sketch)

```
GET    /api/home?profile=            rows for the home screen
GET    /api/discover?genre&sort&year&minRating&page
GET    /api/search?q=                TMDB typeahead; pre-warms release search for top hits
GET    /api/titles/:tmdbId           detail + ratings + availability + watch state
GET    /api/titles/:tmdbId/releases  ranked releases (debug / manual pick)
POST   /api/titles/:tmdbId/play      → { state, eta?, stream? }  (starts acquisition)
DELETE /api/titles/:tmdbId/play      cancel an in-flight acquisition
GET    /api/events                   SSE: acquisition progress, upgrades, storage
GET    /api/stream/:variantId        Range-served local file, or 302 to a put.io URL
POST   /api/progress                 { profileId, tmdbId, variantId, position, duration }
GET|POST|DELETE /api/my-list
GET    /api/storage                  usage per tier + items
POST   /api/variants/:id/pin | /evict
GET    /api/profiles
GET    /img/:size/:path              TMDB image proxy with a disk cache
```

## External API notes

- **chill.institute v4**: Connect-style JSON over HTTP —
  `POST https://api.chill.institute/v4/chill.v4.UserService/Search` with
  `Authorization: Bearer <token>`; body `{ "query": "…" }`. Results carry
  `seeders`, `size`, `link` (magnet), `imdb_id`, and a parsed `release_info`
  (resolution, codec, hdr, audio, source, edition…). Schema:
  `chill-institute/chill-contracts/proto/chill/v4/api.proto`. **We never parse
  release names ourselves** — that's what `release_info` is for.
- **put.io v2** (verify each in Phase 0): `POST /v2/transfers/add` (`url`,
  `save_parent_id`), `GET /v2/transfers/:id`, `POST /v2/transfers/cancel`,
  `GET /v2/files/list`, `GET /v2/files/:id/url`, `GET /v2/files/:id/hls/media.m3u8`,
  `POST|GET /v2/files/:id/mp4`, `GET /v2/files/:id/subtitles`,
  `POST /v2/files/delete`, `GET /v2/account/info` (disk quota).
- **Catalog gate** (`adapters/catalogGate.ts`): TMDB answers only while
  `TMDB_TOKEN` is set *and* the key works (checked at boot, re-checked every
  15 min while it doesn't, dropped on any 401/403); otherwise Cinemeta does, and
  the TMDB-only features (`ctx.catalog.tmdb`) stay off. Catalog caches are keyed
  by the answering catalog. DECISIONS D46.
- **TMDB v3**: `/authentication` (key check), `/movie/:id/watch/providers`
  ("where it streams", `WATCH_REGION`, 24 h cache, D41/D47), `/trending`, `/movie/popular|top_rated|now_playing|upcoming`,
  `/discover/movie`, `/search/movie`, `/movie/:id?append_to_response=credits,videos,images,release_dates,recommendations,external_ids`, `/genre/movie/list`.

## TV delivery

The webOS app is a **hosted-app shell**: a tiny IPK whose `index.html` redirects to
`http://<server>/tv`. The real UI ships with every server deploy; the IPK almost
never changes. It's sideloaded with Developer Mode (`ares-cli` or webOS Dev
Manager). Developer Mode sessions expire (community reports ~1000 h) and remove
sideloaded apps, so we automate renewal (Phase 1) and consider Homebrew Channel
if the firmware allows. Fallbacks if sideloading fails: **Google Cast**, built into
the G3 via firmware 23.20.50 (phone browses, TV plays), the TV's browser, or Plex/Jellyfin on the same
library.

The TV is an LG OLED G3 (2023), model OLED65G3PUA: it shipped with webOS 23 /
Chromium 94 and has since been upgraded through webOS Re:New to webOS 11.2
(firmware 43.21.96), whose user agent reports Chromium 132. It decodes HEVC, AV1, Dolby Vision and HDR10 in hardware, and
DTS is expected to work (LG only dropped it in 2025). Whatever audio Phase 0
finds unplayable (TrueHD is the likely one) the ranker filters until Phase 4 can
re-encode it.

### Decision gate (end of Phase 0)

If the webOS `<video>` element can't direct-play HEVC 10-bit + E-AC3 even after an
ffmpeg remux to fragmented MP4/HLS, switch the local tier's playback engine to **Jellyfin** (its webOS-aware transcoder
behind our UI) instead of building more of our own. The rest of the design is
unchanged.
