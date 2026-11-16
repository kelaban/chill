# Phase 0 — Spikes & decisions

**Goal:** replace every guess in the PRD with a measurement before writing product
code. Throwaway code lives in `spikes/` and is deleted at the end of the phase;
only the decision record below survives.

**Time box:** 1–2 days.

## S1. The TV: what can it actually play?

1. Record the TV's model, year, webOS version (Settings → General → About), and
   from that the Chromium version of its web engine.
2. Enable **Developer Mode** (LG Developer Mode app; needs an LG developer
   account). Install `@webos-tools/cli` (`ares-*`) or webOS Dev Manager on a laptop.
3. Build a hello-world **hosted app** IPK (`webos/` layout from the Phase 1 plan)
   whose page is a codec test harness served from a laptop on the LAN:
   - Report `navigator.userAgent`, `MediaSource.isTypeSupported` and
     `video.canPlayType` for each codec string below.
   - Actually play a 30 s sample of each and record pass/fail (picture, sound, seek,
     audio-track switch):

   | # | Container | Video | Audio | Notes |
   |---|---|---|---|---|
   | 1 | MP4 | H.264 1080p | AAC | baseline |
   | 2 | MKV | H.264 1080p | AC3 | |
   | 3 | MKV | HEVC 10-bit 2160p HDR10 | E-AC3 | typical 4K WEB-DL |
   | 4 | MP4 (fMP4) | HEVC 10-bit HDR10 | E-AC3 | what a remux would produce |
   | 5 | MKV | HEVC DV profile 8 | E-AC3 Atmos | |
   | 6 | MKV | HEVC DV profile 5 | E-AC3 | some WEB-DLs |
   | 7 | MKV | HEVC | DTS / DTS-HD MA | often unsupported on newer LGs |
   | 8 | MKV | HEVC | TrueHD | |
   | 9 | HLS (fMP4 segments) | HEVC | E-AC3 | our remux path |
   | 10 | put.io HLS of a real file | (put.io's transcode) | | universal fallback |
   | 11 | MKV with PGS / SRT subs | | | subtitle handling |

4. Check remote key codes in the harness: Back (461), Play/Pause (415/19), FF/RW
   (417/412), color keys, and that the Magic Remote pointer focuses elements.
5. Note how long Developer Mode says the session lasts and whether the renewal can
   be scripted (`ares-*` / the dev-mode session-token endpoint). Check if the
   firmware allows Homebrew Channel.

**Output:** the table filled in; Chromium version; renewal approach.

## S2. chill.institute: is ranking good enough?

1. Get a token via `chilly auth login` (it prints the token page).
2. Script: for 20 movies (mix of new blockbusters, older classics, obscure
   foreign), `POST https://api.chill.institute/v4/chill.v4.UserService/Search`
   with `{ "query": "<title> <year>" }`.
3. Dump results as JSON fixtures into `server/test/fixtures/chill/` (keep these —
   they become the ranker's tests in Phase 1).
4. Record: results per title, % with `release_info`, % with `imdb_id`, latency,
   how often a title has a clearly-good 1080p and a clearly-good 2160p option.
5. Also call `GetIndexers` and `GetMovies` to see what the catalog endpoints offer.

## S3. put.io: how fast is "instant"?

1. Create a put.io OAuth app (or personal token); confirm each endpoint listed in
   `ARCHITECTURE.md` against the live docs and fix the doc if any differ.
2. For 10 of S2's titles, add the hand-picked "instant" candidate as a transfer
   into a `chill-spike/` folder and log: time to `COMPLETED`, whether it finished
   immediately (cached), size.
3. For 3 files: time from request to first frame via (a) `/files/:id/url`
   original, (b) `/hls/media.m3u8`, (c) MP4 conversion — on the TV harness.
4. Read `/account/info` and confirm how quota is reported. Delete everything.

## S4. Home server

Record OS, CPU (and iGPU / QuickSync), RAM, free disk for `/data/library`,
Docker + Compose versions, whether it's always on, LAN IP / hostname, and the home
internet downlink (speed test). Check that the TV can reach the server by IP (and
whether it resolves `.local` names — usually not).

## S5. Chromecast (if one exists)

Model, and whether the Default Media Receiver plays sample #1 and #3 from a LAN
URL with CORS headers.

## Decision record (fill in, then archive this plan)

| Decision | Options | Chosen | Evidence |
|---|---|---|---|
| Chromium build target | per S1 | | |
| Local playback engine | own (direct + remux) / Jellyfin | | S1 rows 3, 4, 9 |
| Default target profile | 2160p HDR WEB-DL ≤ 25 GB / 1080p x265 ≤ 12 GB | | S1, S4 disk |
| DV allowed? which profiles | | | S1 rows 5, 6 |
| Audio codecs to penalize | DTS / TrueHD / … | | S1 rows 7, 8 |
| Instant stream delivery | original URL / HLS / MP4 conversion | | S3 |
| Race timeout | default 90 s | | S3 |
| Dev Mode renewal | script / Homebrew / manual | | S1 |
| Cast in scope for Phase 5? | | | S5 |

## Done when

Every PRD open question has an answer in the table, the fixtures from S2 are
committed, and `ARCHITECTURE.md` reflects any changed decisions.
