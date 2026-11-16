# chill — Decisions to revisit

> Living document. Every call made on an assumption instead of a measurement,
> with what would change it. When one is settled, move it to the **Settled**
> table with the evidence. Newest first within each section.

Built 2026-11-16 without the TV or the home server (home testing is tabled).
chill.institute and put.io tokens are configured and tested live; TMDB is
skipped for now (Cinemeta stands in). Open items wait on:

- **🔑 keys**: a TMDB token (optional) or an OMDb key.
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
| D11 | Ranker weights tuned on **20 real searches** (snapshot in `server/test/__snapshots__/`) but not on real put.io timings | Seeders predict time-to-ready on put.io | Log time-to-ready per release for ~20 real plays; adjust weights in one diff and review the snapshot | 🏠 |
| D12 | Fast copy prefers the **upgrade's picture type** (+10 ≈ 3 doublings of seeders, only with ≥ 25 seeders) | Real data: with +1.5, 0/20 upgrades could switch mid-movie; with +10 (and D26, D27) 14/20 never show a seam (7 seamless, 7 need no switch) | If starts get noticeably slower, lower it; if more upgrades wait for a pause, raise it | 🏠 |
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
| D24 | No OMDb; ratings are IMDb's (via Cinemeta) or TMDB's | Phase 3 | Needs an OMDb key for Rotten Tomatoes / Metacritic | 🔑 |
| D25 | **Catalog = Cinemeta** (keyless) until a TMDB token is set; ids stay TMDB ids via Cinemeta's `moviedb_id` | You skipped TMDB for now. Cinemeta's search is weak (can't find "Sintel"), it has no recommendations or certifications, and "Top Rated" is really "Featured" | Add `TMDB_TOKEN` and the catalog switches automatically; no migration | 🔑 |
| D26 | Seeder benefit **capped at 200** for the fast copy | Past ~200 seeders put.io has the release cached (Sintel: ready in 3–5 s) | Real time-to-ready logs (D11) | 🏠 |
| D27 | A 4K upgrade must be **≥ 50 MB per minute** of film (~6.7 Mbps), else it's a starved encode and not an upgrade | Real data had a 5.5 GB 4K DV of a 139-min film | If good 4K encodes get excluded, lower it | 🏠 |
| D28 | Original language from Cinemeta's **first production country** (TMDB gives it directly) | Lets "Parasite" pick Korean-audio releases | Wrong for co-productions; fixed by TMDB | 🔑 |
| D29 | Search **merges chill.institute results**: its releases' IMDb ids become titles, exact matches first | Finds what the catalog misses and guarantees something playable; one cached chill.institute search per query | If chill.institute rate-limits, search only on Enter | 🏠 |

## Settled

| # | Decision | Evidence | Date |
|---|---|---|---|
| S1 | The TV is an **LG OLED G3** | You confirmed | 2026-11-16 |
| S2 | **LAN-only**, no remote access | You decided | 2026-11-16 |
| S3 | Upgrades are **seamless, no prompt** | You decided | 2026-11-16 |
| S4 | Google Cast is available on the TV (firmware ≥ 23.20.50) | You confirmed; LG/9to5Google | 2026-11-16 |
| S5 | chill.institute is used through its **public v4 API** (`/v4/chill.v4.UserService/*`, bearer token, `api.binge.institute` failover) | `chill-contracts` proto + `chill-cli` docs | 2026-11-16 |
| S7 | put.io: Bearer token, endpoints, signed CDN download URLs with range requests, quota via `/account/info` (was D9) | Live test + probe; Sintel ready in 3–5 s | 2026-11-16 |
| S8 | Playing put.io copies: chill's `/api/stream` → put.io's signed URL works end to end (was D7) | Real Sintel play in Chromium: first frame 10.7 s after Play, 1920×1080 | 2026-11-16 |
| S9 | HLS fallback via chill.institute `ResolvePlayback` works without exposing the put.io token, and returns subtitles (was D8) | Live probe on a real put.io file: ORIGINAL and HLS both `ready` | 2026-11-16 |
| S10 | chill.institute response shape: camelCase, int64 as strings, `releaseInfo` (was D10) | 20 real searches recorded in `server/test/fixtures/chill/` (links stripped) | 2026-11-16 |
| S11 | Multi-language tags ("ita eng") include English; original-language releases allowed | Real data dropped many good releases before the fix | 2026-11-16 |
| S6 | Seamless handoff works in principle: audio alignment recovers a 2.5 s offset, switch lands on the cut with < 1 frame error | Integration test + e2e in headless Chromium | 2026-11-16 |
