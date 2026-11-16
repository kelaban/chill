# chill — Product Requirements

> Living document. Update it as scope changes; never archive it.

## The problem

Today, watching a movie takes five tools and a lot of waiting:

1. Find the movie somewhere (IMDb, Letterboxd, a friend).
2. Search for it on **chill.institute** and pick a release by squinting at release names.
3. Send it to **put.io** and wait for the transfer.
4. Get the file onto the **home server** so **Plex** can see it.
5. Open Plex on the **LG webOS TV** and play.

Nothing in that chain knows about the others. There is no "just play this."

## The product

**chill** is a personal, Netflix-style streaming app for one household. You browse
or search the *entire* movie universe — not just what you already own — and press
**Play**. chill finds a release in the background, sends it to put.io, and starts
playing it on the TV as soon as *any* watchable version exists. A better version
is fetched behind the scenes and swapped in later. Storage on both put.io and the
home server is managed automatically; your place in every movie is not.

## Goals (acceptance criteria for the whole project)

| # | Goal | How we know it's met |
|---|------|----------------------|
| G1 | **Works on the LG webOS TV**, natively or via phone/Chromecast | A chill app tile on the TV home screen launches the full UI, navigable with the Magic Remote (pointer *and* D-pad). Fallback: cast from a phone to a Chromecast. |
| G2 | **Uses chill.institute** (or a similar aggregator) for releases | Release search goes through the chill.institute v4 API behind an `Indexer` interface; a Torznab/Prowlarr adapter can be added without touching callers. |
| G3 | **Downloads via put.io** | Every acquisition is a put.io transfer into a dedicated `chill/` folder. |
| G4 | **Beautiful Netflix-like UI over the full universe** | Home rows, hero, genre browse, filters, ratings, and a search box that queries all of TMDB — owned or not. Selecting a result kicks off release search in the background. |
| G5 | **Quick and storage-efficient** | Popular titles go from Play to first frame in **≤ 60 s (p50)**. A higher-quality copy upgrades in the background and swaps in seamlessly mid-playback. Total usage never exceeds **100 GB on put.io** or **100 GB local**. Resume position survives eviction. |

## Users

One household (~2–4 people). Netflix-style profiles (no passwords) so each person
has their own Continue Watching and My List. No public sign-up, ever.

## Core user stories

1. **Browse.** I open chill on the TV and see Continue Watching, My List, Trending,
   Top Rated, genre rows, and "Because you watched…". Every poster shows ratings on
   focus; a badge says when it's already downloaded.
2. **Search.** I type "heat" with the remote and get instant TMDB results. When I
   open one, chill has already looked for releases and shows "Ready in ~30 s" or
   "No releases found."
3. **Play now.** I press Play on something I've never downloaded. A preparing
   screen shows *Finding releases → Sending to put.io → Downloading 64% → Starting*.
   It plays from put.io the moment a watchable file exists.
4. **Quietly better.** Partway through the movie, the 4K HDR copy finishes and is
   copied home. Playback switches over to it **seamlessly** — no prompt, no jump,
   no rebuffer. I just notice it looks better.
5. **Resume anything.** I stopped a movie three weeks ago and its files have since
   been evicted. I press Resume; chill re-acquires it and seeks to where I left off.
6. **My List = pre-fetched.** Adding a movie to My List downloads it in the
   background when there is room, so it starts instantly on movie night.
7. **See what's using space.** A Downloads/Storage screen shows both tiers as bars,
   what's in flight, and lets me pin or delete things.

## Quality & storage policy (the heart of G5)

- **Two quality tiers per title:**
  - **Instant** — the release most likely to finish on put.io fastest
    (high seeders, ~2–8 GB, codecs the TV plays — never DTS — and, where a healthy
    one exists, the same dynamic range as the target so the later switch is invisible). Streamed straight from
    put.io; never needs local disk.
  - **Target** — the household's preferred quality (default: 2160p HDR WEB-DL
    ≤ 25 GB, else 1080p x265 BluRay ≤ 12 GB). Downloaded to put.io, mirrored to the
    home server, played locally.
  - If the instant pick already meets Target, there is only one acquisition.
- **Upgrades are seamless and automatic.** When a better copy is ready, the
  player switches to it in place, with no prompt: aligned to the same frame,
  on a scene cut, with no visible gap. The one thing software can't hide is the
  TV changing picture mode (SDR → HDR) — the panel itself blanks for a moment.
  So the instant pick prefers the same dynamic range as the target. If they still
  differ, the switch waits for the next natural break (pause, seek, or resume).
  See `ARCHITECTURE.md` → *Seamless upgrade*.
- **put.io is a staging tier, local is the library tier.** Once a file is safely
  mirrored home, its put.io copy is deleted to keep put.io free for new transfers.
- **Budgets with watermarks.** Each tier has a 100 GB budget; eviction starts at
  90% and stops at 75%. Order: superseded copies → put.io copies already mirrored →
  watched titles (after 3 days) → stale prefetches → stale in-progress → LRU.
  Never evicted: what's playing, pinned items, in-flight dependencies.
- **Progress is keyed to the movie, not the file.** Watch state lives in the DB
  by TMDB id, so any copy (or a future re-download) resumes at the right place.

Rough capacity: 100 GB local ≈ 4 × 4K movies (~20 GB) + 5 × 1080p (~4 GB). Mirroring
a 20 GB file takes ~5 min at 500 Mbps, ~27 min at 100 Mbps.

## Non-goals (v1)

- TV shows (chill.institute supports them; planned for a later phase).
- Live TV, music, photos.
- Offline downloads to phones; watching outside the home.
- Public hosting, sharing outside the household, multi-household.
- Video transcoding on the home server (we remux/re-encode audio at most; put.io's
  HLS is the universal fallback).
- Replacing Plex outright: chill writes Plex/Jellyfin-compatible folder names so the
  existing Plex setup keeps working on the same files.

## External services

| Service | Used for | Notes |
|---|---|---|
| **TMDB** API | The movie universe: discover, search, details, images, genres, recommendations, trailers | Free personal key. Attribution required in the UI. |
| **OMDb** API | IMDb / Rotten Tomatoes / Metacritic ratings | Optional; cached aggressively. |
| **chill.institute** v4 API | Release search with parsed `release_info`, indexer health, curated movie lists | Bearer token from `chilly auth login`'s token page. Be a good citizen: cache, low concurrency. |
| **put.io** v2 API | Transfers, files, HLS/MP4 streaming, subtitles, quota, deletes | Our own put.io OAuth app/token. |

## Constraints

- One Docker container (plus optional sidecars) on the home server; no cloud
  backend required.
- **LAN-only.** No watching outside the home; nothing is exposed to the internet.
- Secrets (TMDB, OMDb, chill, put.io tokens) live only on the server. Signed
  put.io URLs are never logged.
- **The TV is an LG OLED G5 (2025)**: webOS 25, Chromium 120 web engine (webOS 26,
  Chromium 132, is rolling out to it). HEVC, AV1, Dolby Vision, HDR10, Dolby Atmos;
  **Google Cast built in**; **no DTS** — LG dropped DTS from the whole 2025 line-up.

## Success metrics

- p50 Play→first-frame for a never-downloaded popular title ≤ 60 s; p90 ≤ 3 min.
- ≥ 90% of plays direct-play (no server-side processing).
- Zero manual storage cleanups needed in a typical month.
- Household stops opening chill.institute / Plex directly.

## Decisions so far

| Question | Answer (2026-11-16) | Consequence |
|---|---|---|
| TV | LG OLED G5 (2025), webOS 25 | Build for Chromium 120; Tailwind v4 is fine; no legacy polyfills. |
| Chromecast? | Built into the TV | Phone → TV casting needs no extra device; it's also the fallback if Developer Mode sideloading breaks. |
| Home downlink | "Good enough" | Mirroring speed isn't a design constraint. |
| Watch outside the home? | No | LAN-only; no Tailscale, no remote access phase. |
| Upgrade UX | Seamless, no prompt | Phase 2 builds a frame-aligned in-place handoff. |

## Open questions (answer in Phase 0)

1. Home server: OS, CPU (Intel QuickSync?), always on, Docker available?
2. Keep Plex running alongside on the same library? (Default: yes.)
3. Audio/subtitle language preferences? (Default: English audio, no subtitles.)
