# chill — Roadmap

> Living document. Each phase gets a self-contained plan in `documentation/plans/`
> before work starts; finished plans move to `documentation/archive/`.

Phases are thin vertical slices: after each one the household can use something
real on the TV.

| Phase | Theme | Plan | Status |
|---|---|---|---|
| 0 | Spikes & decisions | `plans/phase-0-spikes.md` | Ready |
| 1 | Walking skeleton: browse → Play from put.io on the TV | `plans/phase-1-walking-skeleton.md` | Ready |
| 2 | Quality ladder, local tier & storage manager | `plans/phase-2-quality-ladder-and-storage.md` | Ready |
| 3 | Netflix polish & personalization | to write | — |
| 4 | Playback robustness (remux, audio, subtitles) | to write | — |
| 5 | Phone & Google Cast | to write | — |
| 6 | TV shows | to write | — |

---

## Phase 0 — Spikes & decisions (1–2 days)

Answer the PRD's open questions with experiments, not guesses: the G3's codec
matrix and seamless-switch limits (two decoders? picture-mode blanking?), put.io
time-to-ready, chill.institute ranking quality, home server specs.
**Exit:** a decision record in the Phase 0 plan, including the Jellyfin decision
gate and the seamless handoff mode.

## Phase 1 — Walking skeleton (MVP; replaces the current workflow)

Monorepo, Docker image, SQLite. TMDB-backed home rows, detail page, search.
Play → chill.institute search → ranker (instant tier only) → put.io transfer →
stream from put.io on the TV, with resume. webOS hosted-app shell installed, with
Developer Mode renewal automated. Simple profiles.
**Exit:** pick an un-downloaded popular movie on the TV and be watching in ≤ 60 s;
stop, relaunch the app, resume at the same spot.

## Phase 2 — Quality ladder, local tier & storage

Target tier, parallel acquisition, race-the-runner-up, put.io → local mirror
(aria2c), local range serving, Plex-compatible naming, **seamless** mid-playback
upgrade (audio-aligned, switched on a scene cut, no prompt), both storage budgets
with eviction + admission control, resume after eviction, Storage screen.
**Exit:** a movie starts in 1080p from put.io, upgrades to 4K local without user
action, put.io usage stays < 100 GB and local < 100 GB through a 20-movie soak test.

## Phase 3 — Netflix polish & personalization

Hero banner with backdrop motion, OMDb ratings (IMDb / RT / Metacritic), full
Browse page (genre, year, rating, runtime, language filters, infinite grid),
"Because you watched…", "New on digital", My List with background prefetch,
availability badges, trailers on detail, profile avatars, TMDB attribution,
performance pass on the TV (virtualized rows, image sizes, 60 fps focus).
**Exit:** the household stops opening chill.institute and Plex directly.

## Phase 4 — Playback robustness

Device capability profile (probe on first launch), playback decision per variant:
direct → remux (ffmpeg `-c copy` to fMP4/HLS) → audio re-encode (DTS/TrueHD →
E-AC3) → put.io HLS. Subtitles from put.io + OpenSubtitles, audio/subtitle
track pickers, language preferences fed into the ranker.
**Exit:** ≥ 90% direct play; every remaining failure has a working fallback.

## Phase 5 — Phone & Google Cast

Phone layout as a PWA; Cast sender to the G3's built-in Google Cast (Default
Media Receiver first, custom receiver if progress reporting needs it); "play on
TV" handoff. LAN-only — if Phase 0 shows the Cast sender needs a secure context,
serve chill over HTTPS on the LAN (Caddy with a DNS-01 certificate for a private
hostname pointing at the server's LAN IP; nothing exposed to the internet).
**Exit:** browse on the phone, cast to the TV, progress syncs to the TV app.

## Phase 6 — TV shows

chill.institute's TV endpoints (show detail, season, episode/season downloads),
episode-level watch state, Next Episode autoplay, season-aware storage rules.
