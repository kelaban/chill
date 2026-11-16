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
│  optional: Plex/Jellyfin reading /data/library;  Tailscale sidecar      │
└────────────────────────────▲────────────────────────────────────────────┘
                             │ LAN (HTTP)
        ┌────────────────────┼──────────────────────┐
        │                    │                      │
  LG webOS TV          Phone / laptop           Chromecast
  hosted-app shell →   same SPA as a PWA;       Default Media Receiver
  loads SPA from       browse + cast sender     (custom receiver later)
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
| Live status | Server-Sent Events | Works on old Chromium, simpler than WebSockets. |
| Downloads | `aria2c` (multi-connection, resumable) via JSON-RPC | Saturates the home link; restarts cleanly. |
| Media tools | `ffprobe` always; `ffmpeg` for remux/audio only | Know exactly what each file is; never video-transcode. |
| Client | React 18 + Vite + TanStack Query + React Router | |
| Styling | **Tailwind v3** (not v4) | v4 needs Chromium ≥ 111; webOS ships 79–108. |
| TV focus | `@noriginmedia/norigin-spatial-navigation` | D-pad focus management; Magic Remote pointer works natively. |
| Video | `<video>` + native HLS on webOS; `hls.js` elsewhere | webOS's media pipeline handles HLS and HEVC in hardware. |
| Build target | `@vitejs/plugin-legacy`, target set from Phase 0's webOS version | |
| Tests | Vitest; MSW fixtures for TMDB/chill/put.io | |
| Deploy | GitHub Actions → GHCR image → `docker compose pull && up -d` on the server | |

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
   eviction candidates (first in line).
3. If the title is playing, SSE tells the client; it offers "4K is ready — switch?"
   and on accept swaps `src` and seeks to the same position.

### Resume after eviction

Same as cold Play, but the ranker prefers the release (or edition) recorded in
`last_variant_id` so timelines match. When durations differ by > 2%, the position
maps proportionally and rewinds 15 s.

### Eviction (runs after every acquisition and hourly)

Pure function `planEviction(variants, budgets, now) → variantIds`, applied per tier.
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
- **TMDB v3**: `/trending`, `/movie/popular|top_rated|now_playing|upcoming`,
  `/discover/movie`, `/search/movie`, `/movie/:id?append_to_response=credits,videos,images,release_dates,recommendations,external_ids`, `/genre/movie/list`.

## TV delivery

The webOS app is a **hosted-app shell**: a tiny IPK whose `index.html` redirects to
`http://<server>/tv`. The real UI ships with every server deploy; the IPK almost
never changes. It's sideloaded with Developer Mode (`ares-cli` or webOS Dev
Manager). Developer Mode sessions expire (community reports ~1000 h) and remove
sideloaded apps, so we automate renewal (Phase 1) and consider Homebrew Channel
if the firmware allows. Fallbacks if sideloading fails: the TV's browser, casting
from a phone, or Plex/Jellyfin on the same library.

### Decision gate (end of Phase 0)

If the webOS `<video>` element can't direct-play HEVC 10-bit + E-AC3 even after an
ffmpeg remux to fragmented MP4/HLS, switch the local tier's playback engine to **Jellyfin** (its webOS-aware transcoder
behind our UI) instead of building more of our own. The rest of the design is
unchanged.
