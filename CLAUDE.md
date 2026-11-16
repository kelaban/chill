# CLAUDE.md

Routing and conventions for agents working in this repo. Read this first.

## What this is

**chill** — a personal, Netflix-style streaming app for one household. Browse or
search the whole movie universe (TMDB), press Play, and chill finds a release on
**chill.institute**, downloads it via **put.io**, and plays it on the **LG webOS TV**
— fast copy first, better copy later — while keeping put.io and the home server
each under a 100 GB budget.

Not affiliated with chill.institute; it's an API we call.

## Planning workflow (important)

- **Active plans** live in `documentation/plans/`. Each is a self-contained,
  executable spec for one chunk of work.
- **When a plan is fully implemented**, move it to `documentation/archive/` and
  prepend: `> Completed YYYY-MM-DD — what shipped; any deviations from the plan.`
- **Living documents** — update in place, never archive: `documentation/PRD.md`,
  `documentation/ARCHITECTURE.md`, `documentation/ROADMAP.md`,
  `documentation/BACKLOG.md`, `documentation/TESTING.md`, `documentation/DEPLOY.md` (how it runs on
  the home server), `documentation/DECISIONS.md` (calls made on
  assumptions — add one whenever you guess instead of measure). `ISSUES.md` is a lightweight bug tracker, one `##`
  heading per bug.
- Before starting work, pick the relevant plan. If none exists, write one first.
- Phases are in `ROADMAP.md`. Start with `plans/phase-0-spikes.md`.

## Where things live

| Path | Contents |
|---|---|
| `server/src/adapters/` | `tmdb` or `cinemeta` (keyless, default without a TMDB token), `chill`, `putio` — thin typed clients |
| `server/src/domain/` | Pure logic: `ranker`, `storage`, `selectVariant`, position mapping |
| `server/src/services/` | Catalog, releases, acquirer (Play + race), mirror, upgrade (seamless prep), storage, subtitles, shows (TV) |
| `server/src/fakes/` | Fake TMDB / chill.institute / put.io + generated sample films (demo mode, tests) |
| `server/src/jobs.ts` | Durable SQLite job queue + worker |
| `server/migrations/` | SQLite migrations (`0001_init.sql`, …) |
| `web/` | React SPA (TV 10-foot UI + phone layout) |
| `web/src/player/handoff.ts` | Two-`<video>` engine that performs the seamless switch |
| `webos/` | Hosted-app shell for the TV |
| `shared/` | API DTOs shared by server and web |
| `docker/` | Dockerfile, compose, `.env.example` |

## Commands

| Task | Command |
|---|---|
| Dev (demo mode without tokens) | `npm run dev` |
| Typecheck / tests / e2e | `npm run typecheck` · `npm test` · `npm run test:e2e` |
| Live API smoke tests | `npm run test:live` runs only the keyless catalog. put.io / chill.institute suites are **opt-in** (`LIVE_PUTIO=1`, `LIVE_CHILL=1`) — put.io flagged the dev IP once; use fakes and recorded fixtures instead |
| Build + bundle check | `npm run build && npm run check:bundle` |
| TV package | `CHILL_URL=http://192.168.1.21:7878 npm run webos:package` |
| Deploy to farnsworth | Push to `main`: the server builds and switches itself within ~10 min, never mid-movie. Changes under `docker/` need `ssh keith@farnsworth 'cd ~/apps/chill && git -C src pull && docker compose up -d --build'`. See `documentation/DEPLOY.md` |

Demo mode (`CHILL_FAKE=1`) runs everything against fakes, including real ffmpeg
alignment and the seamless switch, so most work never needs real credentials.

## Conventions

- TypeScript `strict`. One repo, one Docker image.
- **Never parse release names ourselves.** chill.institute returns a parsed
  `release_info` for every result; use it. (Same spirit as COOK's "prefer
  structured data over scraping.")
- **Domain logic is pure.** `ranker`, `storage`, and `selectVariant` take facts and
  return decisions — no I/O, no clock reads (pass `now`). They carry the tests.
- **Watch state is keyed by TMDB id, never by file.** Files come and go; progress
  doesn't. TV episodes are titles with **negative** ids (`-episodes.id`), so the
  same pipeline serves them; `isEpisode(id)` is `id < 0`.
- **Every byte goes through admission control.** No transfer or mirror starts
  without `storage.admit()` saying yes.
- **Secrets stay on the server.** Tokens never reach the SPA bundle; signed put.io
  URLs are fetched per request and never logged or stored.
- **Be a good API citizen.** chill.institute: cache searches 12 h, concurrency ≤ 2,
  no bulk availability scans. TMDB: cache, and show attribution.
- **Target the TV, not your laptop.** LG OLED G3 (2023), upgraded to webOS 11.2 —
  its user agent reports **Chromium 132** (measured 2026-11-15). Vite
  `build.target: "chrome132"`. Still on Tailwind v3; v4 (needs 111) is now
  possible but not migrated. Keep animations to transforms/opacity (TV CPUs are weak);
  test focus with D-pad *and* pointer.
- **Upgrades never ask.** A better copy swaps in seamlessly (aligned, on a scene
  cut). Don't add prompts or toasts for it; see `ARCHITECTURE.md` → *Seamless upgrade*.
- **LAN-only.** Nothing is exposed to the internet; there is no remote access.
- Fail gracefully: no releases → say so on the detail page; playback fails → fall
  back to put.io HLS before showing an error.
