# Phase 1 — Walking skeleton

**Goal:** on the TV, browse the whole movie universe, press Play on something never
downloaded, and be watching from put.io in ≤ 60 s. Stop; relaunch; resume.

**Depends on:** Phase 0 decisions (stream delivery, race timeout, build target —
Chromium 94 floor for the LG G3 unless Phase 0 finds a newer engine).

**Out of scope here:** local tier, target quality, eviction (Phase 2); OMDb,
Browse filters, prefetch (Phase 3); remux/subtitles (Phase 4).

## 1. Scaffold

- npm workspaces: `server/`, `web/`, `shared/`, `webos/`. TypeScript `strict`,
  ESLint + Prettier, Vitest at the root.
- Root scripts:

  | Script | Does |
  |---|---|
  | `npm run dev` | server on `:7878` (tsx watch) + Vite on `:5173` proxying `/api`, `/img` |
  | `npm run typecheck` | `tsc -b` across workspaces |
  | `npm test` | Vitest |
  | `npm run build` | web → `server/public/`, server → `server/dist/` |
  | `npm run db:migrate` | applies `server/migrations/*.sql` |
  | `npm run webos:package` | builds the IPK into `dist/` |

- `docker/Dockerfile`: multi-stage; runtime `node:22-slim` + `ffmpeg` +
  `aria2` (unused until Phase 2, installed now so the image is stable).
- `docker/compose.yml`: service `chill`, port `7878`, volumes `/data/db`,
  `/data/library`, `/data/cache`, `env_file: .env`.
- `docker/.env.example`: `TMDB_API_KEY`, `CHILL_TOKEN`, `PUTIO_TOKEN`,
  `PUTIO_FOLDER=chill`, `PUBLIC_URL=http://<lan-ip>:7878`.
- `.github/workflows/ci.yml`: install → typecheck → test → build → docker build;
  on `main`, push `ghcr.io/kelaban/chill:latest`.

## 2. Server foundation

- `server/src/config.ts`: zod-validated env; fail fast with a readable message.
- `server/src/db.ts`: `better-sqlite3`, WAL mode, migration runner.
- `migrations/0001_init.sql`: `profiles`, `titles`, `watch_state`, `releases`,
  `acquisitions`, `variants`, `jobs`, `settings` (columns per `ARCHITECTURE.md`;
  Phase 2 adds what it needs). Seed one profile.
- `server/src/jobs.ts`: `enqueue(type, payload, runAfter?)`, a worker loop that
  claims one job at a time, retries with backoff (max 5), marks `failed` with
  `last_error`. Job handlers register by type.
- `server/src/events.ts`: in-process pub/sub → `GET /api/events` (SSE, 15 s
  heartbeats, `?profile=` filter).
- Logging: pino; a redactor strips `Authorization` headers and any put.io URL
  query string.

## 3. Adapters (each a thin, typed client + MSW fixtures)

- `adapters/tmdb.ts`: trending, popular, top_rated, now_playing, discover (by
  genre), search, movie detail with `append_to_response=credits,videos,
  release_dates,recommendations,external_ids`, genre list. Response cache in
  SQLite (`titles` + a generic `http_cache` table): lists 6 h, details 7 d.
- `adapters/chill.ts`: `search(query)`, `getIndexers()` over
  `POST https://api.chill.institute/v4/chill.v4.UserService/<Method>`,
  `Authorization: Bearer ${CHILL_TOKEN}`. Concurrency limit 2; cache searches 12 h
  keyed by normalized query. Types generated from (or copied from)
  `@chill-institute/contracts`; pin a release, not `main`.
- `adapters/putio.ts`: `ensureFolder(name)`, `addTransfer(magnet, parentId)`,
  `getTransfer(id)`, `cancelTransfer(id)`, `listFiles(parentId)`,
  `getFile(id)`, `streamUrl(fileId, mode)`, `deleteFiles(ids)`, `accountInfo()`.
  Exact endpoints as verified in Phase 0.
- `indexer.ts`: `interface Indexer { search(q): Promise<Release[]> }` with the
  chill adapter as the only implementation. `Release` is our type, mapped from
  `SearchResult` + `release_info`.

## 4. Ranker (pure, the most-tested file in the repo)

`server/src/domain/ranker.ts`:

```ts
rank(title: TitleFacts, releases: Release[], profile: QualityProfile,
     device: DeviceCaps): { instant: Scored[]; target: Scored[] }
```

**Hard filters** (a release that fails any is dropped):

- Identity: `imdb_id` equals the TMDB `imdb_id` when both present; otherwise
  normalized `release_info.title` matches `title` or `original_title` and
  `|year − release_year| ≤ 1`.
- Not CAM/TS/TC/SCR/HDCAM/TELESYNC; not 3D; not hardcoded subs; not a sample.
- `seeders ≥ 2`; `size` within `[300 MB, profile.maxSizeTarget]`.
- Language: English or untagged/multi, unless the profile says otherwise.
- Audio the TV can't decode, per Phase 0's codec matrix (TrueHD is the likely
  one; the G3 is expected to handle DTS). Lifted for the target tier once Phase 4
  can re-encode audio.

**Soft preference, both tiers:** the target profile's dynamic range (SDR / HDR10 /
DV). An instant pick that matches it makes the Phase 2 upgrade invisible; it's
weighted below seeders so it never makes Play slower.

**Instant score** — prefers what will *finish fast* and *play anywhere*:
`w1·log2(1+seeders) + w2·sizeFit(size, 2–8 GB) + w3·resolution(1080p>720p>2160p)
+ w4·source(WEB-DL ≥ BluRay ≥ WEBRip > HDTV) − w5·audioPenalty(device)
− w6·codecPenalty(device)`.

**Target score** — prefers *quality within budget*: resolution & HDR matching the
profile, DV only in profiles allowed by Phase 0, size ≤ cap, `seeders ≥ 5`,
source preference, then seeders as tiebreaker.

Weights live in `domain/rankerWeights.ts` so tuning is one diff. Tests:
- One snapshot test per Phase 0 fixture title asserting the top instant and target
  pick by `chill_release_id` (reviewed by a human once, then locked).
- Unit tests for every filter, including "CAM with 5,000 seeders never wins" and
  "wrong-year remake never matches."

Phase 1 uses only `instant`; `target` is computed and stored for Phase 2.

## 5. Acquisition (instant tier)

`server/src/domain/acquirer.ts` + job handlers:

1. `POST /api/titles/:tmdbId/play`:
   - usable `variant` exists → return `{ state: "ready", stream }`.
   - acquisition in flight → return its state.
   - else create `acquisition(tier=instant, state=searching)`, enqueue
     `acquire.search`, return `{ state: "searching" }`.
2. `acquire.search`: indexer search → upsert `releases` → rank → no candidates?
   `failed` with reason `no_releases` → else `acquire.transfer` with the top pick.
3. `acquire.transfer`: `putio.addTransfer(link, folderId)`, store
   `putio_transfer_id`, enqueue `acquire.poll`.
4. `acquire.poll` (every 3 s for the first minute, then 10 s): publish progress
   (`percent`, `eta`, `peers`) on SSE. On completion, find the largest video file
   in the transfer's folder → create `variant(location=putio, tier=instant)` →
   `ready`. Error → try the next candidate (max 3) before `failed`.
5. **Race:** if `percent < 50` at `RACE_AFTER_S` (Phase 0, default 90), add the
   runner-up as a second transfer; whichever completes first wins; cancel and
   delete the other.
6. `DELETE /api/titles/:tmdbId/play` cancels and cleans up put.io.

## 6. Playback & progress

- `GET /api/stream/:variantId` for a put.io variant → 302 to a fresh stream URL
  (original if the device profile direct-plays its codecs, else put.io HLS).
  URLs are fetched per request, never stored or logged.
- `POST /api/progress` every 10 s while playing, plus on pause, seek, stop, and
  `visibilitychange`. Watched when position ≥ 92% of duration or the credits start
  (TMDB runtime fallback).
- Resume: `GET /api/titles/:tmdbId` returns `watch_state`; the player seeks to
  `position − 5 s`.

## 7. Web client (10-foot first)

- Vite (`build.target` from Phase 0; `chrome94` floor) + React 18 + React Router +
  TanStack Query + Tailwind v3.4.
- 1920×1080 design canvas scaled to the viewport; safe-area padding 5%.
- `@noriginmedia/norigin-spatial-navigation` for D-pad focus; focused card scales
  to 1.08 with a CSS transform (no layout shift, no `backdrop-filter`).
- Keys: Back (461 / Escape / Backspace) navigates back and closes overlays;
  media keys control the player.
- Screens:
  - **Profile picker** (remembered in `localStorage`, with try/catch).
  - **Home:** rows — Continue Watching, Trending, Popular, Top Rated, Now Playing,
    and three genre rows. Horizontally virtualized; posters at TMDB `w342`
    through `/img`.
  - **Search:** on-screen keyboard grid + typed input; 250 ms debounce; results
    grid. The server pre-warms chill search for the top 3 results.
  - **Detail:** backdrop, title, year, runtime, genres, TMDB rating, overview, cast;
    buttons **Play / Resume**, **Start over**; release availability line ("Ready in
    ~30 s", "Searching…", "No releases found").
  - **Preparing:** backdrop + stepper (*Finding → Sending to put.io → Downloading
    n% · ETA → Starting*), Cancel. Driven by SSE.
  - **Player:** full-screen `<video>`; OSD with title, scrub bar, elapsed/remaining;
    auto-hide after 4 s; ±10 s on Left/Right, ±60 s on FF/RW.
  - **Downloads:** in-flight acquisitions with progress (storage bars come in
    Phase 2).
- TMDB attribution in a Settings/About screen.

## 8. webOS shell

`webos/`:
- `appinfo.json`: `id: "com.kelaban.chill"`, `type: "web"`, `main: "index.html"`,
  `title: "chill"`, icons (80×80, 130×130, splash 1920×1080),
  `resolution: "1920x1080"`, `disableBackHistoryAPI: true`.
- `index.html`: reads the server URL baked in at package time
  (`CHILL_URL=http://<lan-ip>:7878`), shows a spinner, `location.replace(url +
  "/tv")`; if unreachable after 5 s, shows the URL and a Retry button.
- `scripts/package-webos.mjs` → `ares-package` → `dist/com.kelaban.chill_*.ipk`.
- `documentation/webos.md`: install (`ares-setup-device`, `ares-install`), and
  the Developer Mode renewal job decided in Phase 0 (a scheduled job on the home
  server that renews the session before it expires; alert in the UI when the
  session has < 72 h left if that's readable).

## 9. Deploy

- On the server: `docker compose pull && docker compose up -d`. Document it in
  `README.md`, including first-run steps (create `.env`, put.io folder created on
  boot, health check at `/api/health`).

## Acceptance

- [ ] CI green: typecheck, tests (ranker fixtures, acquirer state machine with MSW,
      progress endpoint), build, Docker image.
- [ ] chill tile on the TV home screen opens the Home screen in < 4 s.
- [ ] Every screen is fully usable with D-pad only and with the pointer only.
- [ ] Cold Play on 5 popular titles: median first frame ≤ 60 s (log the numbers in
      the archive note).
- [ ] Cold Play on an obscure title with no releases shows "No releases found"
      within 10 s, without an error screen.
- [ ] Stop mid-movie, quit the app, relaunch: Continue Watching shows it; Resume
      starts within 5 s of the saved position.
- [ ] No token or signed URL appears in logs (`grep` test in CI over a captured
      log of the e2e run).
