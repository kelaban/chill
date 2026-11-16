# chill — Decisions to revisit

> Living document. Every call made on an assumption instead of a measurement,
> with what would change it. When one is settled, move it to the **Settled**
> table with the evidence. Newest first within each section.

Built 2026-11-16 without the TV, the home server, or API credentials (home
testing was tabled; the credential forms were declined). So most of these wait on
one of three things:

- **🔑 keys**: TMDB, chill.institute and put.io tokens (`npm run test:live`).
- **📺 TV**: Phase 0's codec / handoff harness on the G3.
- **🏠 home**: the server running for real for a few weeks.

## Open

| # | Decision (as built) | Assumption behind it | Revisit when / how | Waits on |
|---|---|---|---|---|
| D1 | Build target **Chromium 94**, Tailwind **v3** | G3 shipped webOS 23; may have been upgraded to 24/25 | Read `navigator.userAgent` on the TV (About page shows it). If ≥ 111, Tailwind v4 is possible; ≥ 108 raises `TV_TARGET` in `web/vite.config.ts` | 📺 |
| D2 | `TV_TWO_DECODERS=1`: seamless handoff runs two `<video>` decoders for ~1.2 s | The G3 can decode the playing copy and pre-roll the 4K copy at once | Phase 0 S1 step 4. If not, set `TV_TWO_DECODERS=0` → black-segment / natural-break modes (already built) | 📺 |
| D3 | `TV_SWAP_LATENCY_MS=800` for black-segment switches | Typical single-element source swap on a TV | Measure in Phase 0; it sets which black segments are long enough to hide a swap | 📺 |
| D4 | Ranker soft-penalizes **TrueHD and DTS** (4 points), drops nothing for audio | G3 decodes DTS (LG only dropped it in 2025); TrueHD in a web app is unverified | Fill the Phase 0 codec matrix; move confirmed-bad codecs to `unsupportedAudio`, confirmed-good out of `riskyAudio` (`settings.device`) | 📺 |
| D5 | **Dolby Vision allowed** and preferred over HDR10 for the target tier | The G3 plays DV in the web engine's `<video>`, profiles 5 and 8 | Phase 0 rows 5–6. If DV fails in the web app, set `dolbyVision: false` | 📺 |
| D6 | Seamless measured at **28–32 ms timeline error, 1 dropped frame** | Headless Chromium (software decode) is representative | Repeat the e2e handoff on the TV; target ≤ 1 frame (42 ms at 24 fps) | 📺 |
| D7 | Playing a put.io copy streams the URL from put.io's `/files/:id/url` straight to the TV | put.io's link is bound to the requesting IP; the server and TV share one public IP behind the home router | First real play. If it 403s, proxy through the server or use chill.institute's `ResolvePlayback` (ORIGINAL) | 🔑 |
| D8 | HLS fallback via chill.institute `ResolvePlayback` / `StartPlaybackConversion` (no put.io token on the client) | Learned from chill-stremio's design docs | First file the TV can't decode (`npm run test:live` doesn't cover it yet) | 🔑📺 |
| D9 | put.io auth sent as `Authorization: Bearer <token>`; endpoint shapes from memory of the v2 API | put.io accepts Bearer OAuth tokens | `npm run test:live` (Sintel transfer) — fix `adapters/putio.ts` if any field differs | 🔑 |
| D10 | chill.institute fixtures in tests are **synthetic** (built from the published proto) | Real responses match `chill-contracts` v4 | `npm run test:live`, then record real fixtures for 20 titles and lock ranker snapshots (Phase 0 S2) | 🔑 |
| D11 | **Ranker weights are untuned** (`server/src/domain/rankerWeights.ts`) | Seeders dominate time-to-ready on put.io | After ~20 real plays: compare picked vs. fastest release; adjust weights in one diff | 🔑🏠 |
| D12 | Instant pick prefers the **dynamic range of the top target pick** (+1.5, below one doubling of seeders) | A matching instant copy makes the later switch invisible; speed still wins | If many upgrades fall to natural-break because of HDR mismatch, raise the weight | 🏠 |
| D13 | Alignment: 3 anchors (10/50/90%), 20 s windows, ±30 s search, accept if residual ≤ 40 ms | Releases of the same cut differ by < 30 s of lead-in | Real pairs with longer intros fall back to natural-break; widen the margin if that happens often | 🔑🏠 |
| D14 | Upgrades can switch **twice**: fast copy → 4K on put.io → same 4K at home (second is identity-aligned) | Each switch is invisible, so getting 4K sooner is worth it | If the TV shows any artifact on switches, skip the put.io-4K step and only switch to the home copy | 📺 |
| D15 | Race: start the runner-up if the fast copy is < 50% after **90 s** | put.io usually finishes popular releases in seconds or not at all | Phase 0 S3 timings; `RACE_AFTER_S` | 🔑 |
| D16 | Budgets **100 GB / 100 GB**, watermarks **90% / 75%**, target **2160p HDR ≤ 25 GB** (1080p x265 ≤ 12 GB fallback) | From the brief; ~4 × 4K movies fit at home | After a month of use: does eviction ever bite something you wanted? (`settings.budgets`, `settings.quality`) | 🏠 |
| D17 | Eviction grace: watched **3 d**, stale prefetch **14 d**, stale in-progress **30 d** | Reasonable household habits | Same as D16 | 🏠 |
| D18 | **Own segmented downloader** instead of aria2c for put.io → home | Fewer moving parts; resume + retry tested | If home mirroring is slower than the link, add aria2c back behind the same interface | 🏠 |
| D19 | **No auth on the LAN API**; profiles have no PINs | LAN-only household; nothing exposed to the internet | If guests on the Wi-Fi matter, add a pairing code for devices | 🏠 |
| D20 | Docker image is **1.08 GB** (Debian ffmpeg) | Size doesn't matter on a home server | Switch to a static ffmpeg build if pulls are slow | 🏠 |
| D21 | Developer Mode renewal via `webos/renew-devmode.sh` (community-documented session-token endpoint) | Works on webOS 23–25 | Phase 0 S1 step 6. If it doesn't, use Homebrew Channel or the Stremio/Cast fallbacks (BACKLOG) | 📺 |
| D22 | Movies only; TV shows are Phase 6 | From the brief | When you want series | — |
| D23 | Home-screen rows: Continue, My List, Ready, Trending, Because-you-watched, Popular, Top Rated, New, 6 genres | A Netflix-like default | After real use; reorder in `server/src/services/catalog.ts` | 🏠 |
| D24 | No OMDb (IMDb/RT ratings) yet — TMDB rating only | Phase 3 | Needs an OMDb key | 🔑 |

## Settled

| # | Decision | Evidence | Date |
|---|---|---|---|
| S1 | The TV is an **LG OLED G3** | You confirmed | 2026-11-16 |
| S2 | **LAN-only**, no remote access | You decided | 2026-11-16 |
| S3 | Upgrades are **seamless, no prompt** | You decided | 2026-11-16 |
| S4 | Google Cast is available on the TV (firmware ≥ 23.20.50) | You confirmed; LG/9to5Google | 2026-11-16 |
| S5 | chill.institute is used through its **public v4 API** (`/v4/chill.v4.UserService/*`, bearer token, `api.binge.institute` failover) | `chill-contracts` proto + `chill-cli` docs | 2026-11-16 |
| S6 | Seamless handoff works in principle: audio alignment recovers a 2.5 s offset, switch lands on the cut with < 1 frame error | Integration test + e2e in headless Chromium | 2026-11-16 |
