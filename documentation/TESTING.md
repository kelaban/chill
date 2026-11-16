# chill — Testing

> Living document. How chill is tested, what runs where, and what needs a human.

Two places tests can run:

- **Cloud** (this dev container and CI). Has the internet and the TMDB /
  chill.institute / put.io APIs. Has no TV and no home server.
- **Home** (the LAN). Has the LG G3 and the server. This is the only place real
  playback, the remote, HDR, and the seamless switch can be judged.

Everything that *can* be pushed to the cloud is, so the home loop is short and rare.

## Status (2026-11-16)

| Layer | Where | State |
|---|---|---|
| 1–3 | `server/test/*.test.ts` | ✅ 175 tests, incl. the ranker on 20 **real** chill.institute searches (invariants + locked snapshot) |
| 4 Soak | — | ⏳ not written yet |
| 5–6 UI + playback e2e | `scripts/e2e.mjs` | ✅ remote-only navigation, first frame, seamless switch on a cut (≤ 1 frame), resume |
| 7 Build guards | `npm run typecheck`, `npm run check:bundle`, CI | ✅ |
| 8 Live API | `server/test/services.live.test.ts` | ✅ chill.institute search, put.io Sintel transfer + URL + cleanup, Cinemeta; TMDB skipped (no token). Plus a manual real-mode run: Sintel searched → transferred → played (first frame 10.7 s) → copied home → put.io cleaned |
| 9 On the TV | — | ⏸ tabled until home testing |

## Layers

| # | Layer | Runs | When | What it covers |
|---|---|---|---|---|
| 1 | **Domain unit tests** | cloud / CI | every commit | `ranker` against recorded chill.institute fixtures, `storage` eviction/admission (table-driven), `selectVariant`, position mapping, `align.crossCorrelate` on synthetic signals |
| 2 | **Adapter contract tests** | cloud / CI | every commit | TMDB, chill, put.io clients against recorded responses (MSW). A recorded fixture is the contract; re-record when an API changes |
| 3 | **Server integration** | cloud / CI | every commit | Hono app + temp SQLite + a **stateful fake put.io** (transfers progress on a fake clock, quota enforced, files appear) + fake aria2. Covers Play → ready, race, cancel, mirror, eviction, resume after eviction, restart mid-job |
| 4 | **Soak simulation** | cloud | before each phase ships | 20 titles through play → upgrade → watch → idle over a simulated month; asserts neither 100 GB budget is ever exceeded and no watch state is lost |
| 5 | **UI e2e** | cloud / CI | every commit | Playwright, Chromium, 1920×1080, against the fake backend. One pass **keyboard-only** (arrows, Enter, Back = keyCode 461, media keys) and one **pointer-only**. Screenshots of each screen saved as CI artifacts |
| 6 | **Playback e2e** | cloud / CI | every commit | ffmpeg-generated H.264/AAC clips (headless Chromium has no HEVC) with a burned-in frame counter: resume position, OSD, and the **seamless handoff** — the frame counter read via `requestVideoFrameCallback` must not skip or repeat more than one frame |
| 7 | **Build guards** | cloud / CI | every commit | output must parse as the TV's target (`chrome132`); bundle size budget; no API token or put.io URL in the client bundle; log-redaction test over a captured e2e log |
| 8 | **Live API smoke** | cloud | on demand / nightly | Real TMDB search, real chill.institute search, real put.io transfer of an **open-licensed film** (Big Buck Bunny, Sintel, Tears of Steel) into `chill-test/`, stream URL resolves, then delete everything. Never more than 10 GB on put.io at once |
| 9 | **On the TV** | home | phase milestones | Codec matrix and switch measurements (Phase 0); real cold-Play timing; HDR/DV look; whether a viewer can spot the seamless switch; remote ergonomics |

Layers 1–7 run on every push. Layer 8 runs whenever adapters change (and
recording new fixtures comes from it). Layer 9 is the only one that needs someone
at home.

## Real test media

Torrent tests use only Blender Foundation open movies (CC-BY): legal, stable,
well-seeded, and *Tears of Steel* has both 1080p and 4K masters — a real pair for
testing alignment and the upgrade switch.

## Getting results off the TV

The TV harness (Phase 0) and the TV app post results and errors to
`POST /api/telemetry` on the home server, which writes them to
`/data/db/telemetry.ndjson`. Two ways they reach development:

1. **Preferred — Remote Control on a home machine.** If the Claude desktop app
   on a computer on the home LAN (ideally the server) shares a folder through
   Remote Control, a dev session can run `docker compose` there, install and launch
   the TV app with `ares-install` / `ares-launch`, read the TV app's console with
   `ares-inspect`, and read telemetry directly. The home loop becomes "turn the
   TV on and look at it."
2. **Fallback — manual.** Run `npm run tv:install` and `docker compose up -d` on
   the server; the harness shows a summary on screen and the server writes
   `telemetry.ndjson`; paste it into an issue in `ISSUES.md` or the chat.

## What a human has to judge (layer 9 checklists)

- **Phase 0:** run the harness, confirm the samples look right (HDR/DV engaged,
  sound present).
- **Phase 1:** five cold Plays timed; Resume after relaunch; D-pad and pointer feel.
- **Phase 2:** watch 10 minutes across an upgrade without being told when — can
  you name the moment?
- **Phase 3:** does the home screen feel fast (focus moves at 60 fps, no blank
  posters)?
