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
  `documentation/BACKLOG.md`, `documentation/TESTING.md`. `ISSUES.md` is a lightweight bug tracker, one `##`
  heading per bug.
- Before starting work, pick the relevant plan. If none exists, write one first.
- Phases are in `ROADMAP.md`. Start with `plans/phase-0-spikes.md`.

## Where things live (once scaffolded in Phase 1)

| Path | Contents |
|---|---|
| `server/src/adapters/` | `tmdb`, `omdb`, `chill`, `putio` — thin typed clients, nothing else |
| `server/src/domain/` | Pure logic: `ranker`, `storage`, `selectVariant`, position mapping |
| `server/src/jobs.ts` | Durable SQLite job queue + worker |
| `server/migrations/` | SQLite migrations (`0001_init.sql`, …) |
| `web/` | React SPA (TV 10-foot UI + phone layout) |
| `webos/` | Hosted-app shell for the TV |
| `shared/` | API DTOs shared by server and web |
| `docker/` | Dockerfile, compose, `.env.example` |

## Conventions

- TypeScript `strict`. One repo, one Docker image.
- **Never parse release names ourselves.** chill.institute returns a parsed
  `release_info` for every result; use it. (Same spirit as COOK's "prefer
  structured data over scraping.")
- **Domain logic is pure.** `ranker`, `storage`, and `selectVariant` take facts and
  return decisions — no I/O, no clock reads (pass `now`). They carry the tests.
- **Watch state is keyed by TMDB id, never by file.** Files come and go; progress
  doesn't.
- **Every byte goes through admission control.** No transfer or mirror starts
  without `storage.admit()` saying yes.
- **Secrets stay on the server.** Tokens never reach the SPA bundle; signed put.io
  URLs are fetched per request and never logged or stored.
- **Be a good API citizen.** chill.institute: cache searches 12 h, concurrency ≤ 2,
  no bulk availability scans. TMDB: cache, and show attribution.
- **Target the TV, not your laptop.** LG OLED G3 (2023). It shipped with webOS 23
  (Chromium 94) and may since have been upgraded; until Phase 0 reads its real user
  agent, build for the floor: Vite `build.target: "chrome94"`, Tailwind v3 (v4
  needs Chromium 111). Keep animations to transforms/opacity (TV CPUs are weak);
  test focus with D-pad *and* pointer.
- **Upgrades never ask.** A better copy swaps in seamlessly (aligned, on a scene
  cut). Don't add prompts or toasts for it; see `ARCHITECTURE.md` → *Seamless upgrade*.
- **LAN-only.** Nothing is exposed to the internet; there is no remote access.
- Fail gracefully: no releases → say so on the detail page; playback fails → fall
  back to put.io HLS before showing an error.
