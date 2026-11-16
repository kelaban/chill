# Phase 2 — Quality ladder, local tier & storage manager

> **Status 2026-11-16:** built and passing in demo mode (unit, integration, e2e). Not archived yet: the
> acceptance items that need the TV, the home server or real API keys are still open — see
> `documentation/DECISIONS.md`. Deviations: aria2c replaced by a built-in resumable downloader (D18);
> put.io streams use put.io's own URL and fall back to HLS via chill.institute (D7, D8).

**Goal:** every title starts fast and ends up as a good local copy, without anyone
thinking about disk space. Neither tier ever exceeds its 100 GB budget, and
resume survives eviction.

**Depends on:** Phase 1 (acquirer, variants, jobs, SSE, player).

## 1. Settings & profiles

`settings` rows (editable on a Settings screen):

```jsonc
{
  "budgets": { "putioBytes": 100e9, "localBytes": 100e9,
               "highWatermark": 0.90, "lowWatermark": 0.75 },
  "quality": {
    "target": { "resolution": "2160p", "hdr": ["HDR10", "DV8"], "maxBytes": 25e9,
                "fallback": { "resolution": "1080p", "codec": "x265", "maxBytes": 12e9 } },
    "instant": { "sweetSpotBytes": [2e9, 8e9] }
  },
  "eviction": { "watchedGraceDays": 3, "prefetchStaleDays": 14,
                "inProgressStaleDays": 30 },
  "mirror": { "enabled": true, "connections": 8 }
}
```

The put.io budget is `min(settings, account quota from /account/info)`. Local
usage is our own byte accounting of `/data/library`, cross-checked against
`statfs` (if the volume itself is nearly full, the tighter limit wins).

## 2. Target acquisition

- On Play (and on My List add, Phase 3), after the instant acquisition is created,
  also create `acquisition(tier=target)` **unless** the instant pick already
  satisfies the target profile.
- Target transfers run through **admission control** (§5): a `queued` target
  waits until put.io has `size × 1.1` free after planned evictions.
- Targets never race; they're not urgent. Retry next candidate on failure.

## 3. Mirror put.io → local

Job `mirror.download(variantId)`:

1. Admission control on the local tier.
2. Get a download URL from put.io; hand it to **aria2c** (JSON-RPC, running as a
   child process the server supervises) with `--continue`, `-x <connections>`,
   destination `library/.partial/<variantId>.<ext>`.
3. Poll progress → SSE (Downloads screen).
4. Verify: size equals put.io's size; `ffprobe` succeeds and reports a duration
   within 2% of the put.io variant's. Store `probe_json`, codecs, HDR, duration.
5. Atomic rename to `library/Movies/<Title> (<Year>)/<Title> (<Year>) {tmdb-<id>}
   - <resolution>.<ext>` (Plex and Jellyfin both parse this).
6. Create `variant(location=local)`, mark the put.io variant `superseded_by` it.
   If Plex/Jellyfin are configured, ping their library-refresh endpoint.

Mirror policy: mirror **target** variants always; mirror **instant** variants only
if no target is expected (e.g. instant already meets target) or the title is in
progress and the target failed.

## 4. Choosing what to play

Pure fn `selectVariant(variants, device, context)`:

1. Prefer local over put.io, higher tier over lower, among variants the device can
   direct-play (Phase 4 widens this with remux).
2. When the selected variant differs from `watch_state.last_variant_id` and the
   durations differ by > 2%, map the position proportionally and rewind 15 s;
   otherwise rewind 5 s.
3. `GET /api/stream/:variantId` for local variants range-serves the file (`206`,
   `Accept-Ranges`, correct `Content-Type`; tested with the TV's `<video>`).

## 4a. Seamless mid-playback upgrade (no prompt)

Design is in `ARCHITECTURE.md` → *Seamless upgrade*; the handoff mode
(two-element / black-segment / natural-break-only) comes from Phase 0 S1 step 4.

Server:

1. On a better variant becoming ready for a title with a playback heartbeat in
   the last 2 min, enqueue `upgrade.align(from=playing, to=new)`.
2. `upgrade.align`: ffmpeg extracts 60 s mono 8 kHz PCM at 10/50/90% from both
   (put.io copy via a fresh URL and range reads) → `domain/align.ts`
   `crossCorrelate` (FFT) per anchor → `fitLinear` → store `variant_alignments`.
   Residual > 40 ms or anchors disagreeing → mark `aligned = false`.
3. `upgrade.cuts`: ffmpeg `scdet` + `blackdetect` over
   `[map(playhead), map(playhead) + 5 min]` on the new file → cut list in the new
   file's timeline. Re-run when the playhead passes 3 min into the window.
4. Emit `upgrade.ready { fromVariantId, toVariantId, a, b, cuts[], mode }` on SSE,
   where `mode` is `seamless`, `black-segment`, or `natural-break` (no alignment,
   dynamic range differs, or the TV can't do two decoders and no black segment).

Client (`web/src/player/handoff.ts`):

- `seamless`: next cut ≥ 15 s ahead → hidden muted second `<video>` → seek to
  `map(c)` → wait for ≥ 10 s buffered → on the playing element's
  `requestVideoFrameCallback` frame where `mediaTime ≥ c`, play + show the new
  element, 120 ms audio ramp, release the old one. Abort quietly (and retry at the
  next cut) if the viewer seeks or pauses during the setup.
- `black-segment`: same idea with one element, swapping `src` inside a black
  segment longer than the measured swap latency.
- `natural-break`: swap on the next pause, seek, or resume.
- Report `{ mode, gapMs, droppedFrames }` to `/api/telemetry`; the Storage screen
  shows the last handoff for debugging.
- From then on, progress reports reference the new variant, and the old variant's
  "currently playing" protection lifts so eviction can take it.

## 5. Storage manager

`server/src/domain/storage.ts` — pure, exhaustively tested:

```ts
planEviction(tier: "putio" | "local", variants: VariantFacts[], usedBytes: number,
             budgets: Budgets, now: Date, needBytes = 0): string[] /* variantIds */
admit(tier, sizeBytes, ...) : { ok: true, evict: string[] } | { ok: false, reason }
```

- Runs when used > high watermark, or when `admit` needs room; evicts down to the
  low watermark (or to `needBytes` free, whichever frees more).
- **Never evict:** a variant being played (heartbeat in the last 2 min), pinned
  variants, the source of an in-flight mirror, the only copy of a title that's
  queued to play.
- **Eviction order** (each class in LRU order of `last_played_at ?? created_at`):
  1. Superseded variants (a better verified copy exists anywhere).
  2. put.io variants whose title has a verified local copy.
  3. Watched titles older than `watchedGraceDays`.
  4. Never-started prefetches older than `prefetchStaleDays`.
  5. In-progress titles untouched for `inProgressStaleDays` (watch state kept).
  6. Everything else, LRU.
- Evicting = delete from put.io (`/files/delete`) or unlink locally, then delete
  the `variants` row and log a `storage_event`. Empty title folders are removed.
- If nothing evictable frees enough, `admit` returns `{ ok: false }` and the job
  stays queued; the Downloads screen says why ("Waiting for space: 18 GB needed").
- A reconciler job (hourly + on boot) diffs DB ↔ put.io folder ↔ local disk:
  adopt unknown files that match a title, drop rows whose files vanished, delete
  `.partial` leftovers older than 24 h.

## 6. Resume after eviction

Play on a title with `watch_state` but no variants = cold Play, except the ranker
gets `preferRelease = last release` and `preferEdition = last edition` so the
timeline matches. Continue Watching rows show a small cloud icon for titles that
will need re-acquisition.

## 7. Storage screen

Two bars (put.io / local) with used, budget, and watermarks; a list per tier:
title, tier, size, status (playing / pinned / in progress / watched / prefetched),
last played, and actions **Pin**, **Delete now**. In-flight transfers and mirrors
with speed and ETA. A line explaining any job waiting for space.

## Tests

- `storage.test.ts`: table-driven — every class in order, every never-evict rule,
  watermark math, `needBytes`, ties.
- `selectVariant.test.ts`: local vs put.io, tier order, position mapping.
- `align.test.ts`: synthetic signals with known offset and drift (recover offset
  ± 5 ms, slope ± 0.0005); a different-cut pair is rejected.
- **Handoff e2e (Playwright, headless Chromium):** two ffmpeg-generated clips of
  the same `testsrc2` source with a burned-in frame counter and a chirp track —
  B at a different resolution with 2.5 s of extra lead-in and a cut every 20 s.
  Assert alignment finds 2.5 s, the switch lands on a cut, and the frame counter
  read via `requestVideoFrameCallback` never skips or repeats more than one frame.
- **Real-film alignment:** *Tears of Steel* (open movie, CC-BY) 1080p vs 4K
  masters, fetched in CI and cached.
- Mirror job with a fake aria2 RPC and a fixture file: verify fail → retry, verify
  pass → rename + supersede.
- **Soak test** (`npm run soak`, not in CI): simulate 20 titles of realistic sizes
  through play → upgrade → watch → idle over a simulated month against mocked
  put.io and a temp dir; assert budgets are never exceeded and no watch state is
  lost.

## Acceptance

- [ ] Cold Play starts from put.io (instant), and within the expected download time
      a local 4K copy appears with correct naming; Plex sees it if it's running.
- [ ] Mid-movie, with no prompt, playback switches to the 4K copy on a scene cut;
      on the TV, a viewer who wasn't told can't point to the moment (same dynamic
      range), and telemetry reports a gap of ≤ 1 frame.
- [ ] When dynamic range differs, the switch waits for the next pause/seek and
      resumes at the same frame.
- [ ] After the local copy verifies, both put.io copies are gone.
- [ ] Soak test passes; manual 20-movie week stays within both budgets.
- [ ] Deleting a watched, evicted title's files and pressing Resume re-acquires and
      seeks correctly.
- [ ] Killing the container mid-mirror and restarting resumes the download.
