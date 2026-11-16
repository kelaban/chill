> Completed 2026-11-16 — scrub previews (sheets from the home copy, mapped onto any aligned copy, pointer hover/drag and remote scrubbing with one deferred seek) and the Resume hero shipped. Deviations: ffmpeg's `fps` filter needed `round=up` (the default shows each window's *last* keyframe, up to 10 s late; a real-ffmpeg test now guards it); previews announce themselves over SSE instead of waiting for the 1-minute retry; Continue Watching leaves out the hero's title; evicting a copy now keeps its neighbours aligned. TV checks are in DECISIONS D49.

# Phase 3a — Scrub previews and a Resume hero

## 1. Preview thumbnails when scrubbing

**Goal:** while seeking — dragging or hovering the progress bar with the
pointer, or pressing Left/Right on the remote — a picture of that moment shows
above the bar, Netflix-style.

### Where the pictures come from

- Generated on the server with ffmpeg from the **home copy** (the local file):
  keyframes only (`-skip_frame nokey`), one frame every 10 s, 320 px wide,
  tiled 10×10 into JPEG sheets (100 frames ≈ 16 min per sheet; a 2 h film is
  8 sheets, a few MB). HDR sources are tone-mapped so they don't look washed
  out (falls back to plain scaling if the filter chain fails).
- **Not from put.io:** reading a put.io copy for thumbnails would mean
  downloading it a second time (every seek fetches a whole GOP). The home copy
  arrives during the first watch (the instant copy, or the 4K one), so previews
  show up partway through a first watch and always on a resume. DECISIONS D49.
- A low-priority job (`trickplay.generate`, its own single lane, `nice`d,
  2 threads) runs after a copy lands home; existing home copies are backfilled
  at startup. Sheets live in `cacheDir/trickplay/<variant>/` and are deleted
  with the copy.

### Any copy can use them

Thumbnails belong to one file, but the player may be on another copy of the
same film (the put.io fast copy, before the switch). The alignment the seamless
upgrade already measures (`variant_alignments`, `t_to = a·t + b`) maps the
player's time onto the thumbnails' file, through up to two hops (fast copy →
4K on put.io → same 4K at home). Copies that aren't aligned get no previews
rather than wrong ones. Pure: `domain/playback.ts` → `alignmentBetween`.

### API

- `GET /api/stream/:variantId/trickplay` → `{ intervalS, width, height, cols,
  rows, count, sheets: [url], a, b }` (thumbnail time = `a·t + b` for player
  time `t`), or 404 while none exists.
- `GET /api/trickplay/:variantId/:n.jpg` → a sheet (immutable cache).

### Player

- The manifest is fetched for the copy that's playing, again after a seamless
  switch, and re-tried every minute until it exists.
- **Pointer:** the thumbnail sits above the time tip while hovering or dragging.
- **Remote:** Left/Right (and ⏩/⏪) no longer seek on every press: presses add
  up to a target (±10 s each; holding speeds up to 30 s, then 60 s steps) shown
  with its thumbnail and time; the seek happens 0.7 s after the last press, or
  at once on OK. Back cancels. One seek instead of many also spares put.io.

### Tests

- Unit: `alignmentBetween` (identity, direct, inverse, two hops, unaligned).
- Integration: a home copy gets sheets; the manifest for the put.io fast copy
  maps through the alignment; eviction deletes the sheets.
- e2e: drag shows a thumbnail; Right ×3 shows the target and seeks once.

## 2. Replace the hero with a Resume hero

**Goal:** the big trending banner at the top of Home goes. In its place, only
when there is one: the profile's most recent unfinished title — backdrop,
title, "S2 E3 · name" for episodes, how far in, **Resume** (and Start over).
Nothing at all otherwise; the rows move up.

- Server: `HomeResponse.hero` becomes the latest Continue Watching entry
  (`{ ...summary, progress, positionS, durationS }`) or null; the Continue
  Watching row then lists the others.
- Web: Home renders the Resume hero when present; focus starts on Resume;
  otherwise on the first row.
- e2e/integration: a fresh profile has no hero; after watching part of a film,
  Home leads with it and Resume continues from the saved point.

## Acceptance

- [x] Dragging the bar, and pressing Left/Right, shows the right picture for
      the target time, on the fast copy and after the switch (e2e, demo mode; TV check: D49).
- [x] A fresh profile's Home has no hero; an unfinished film gets a Resume hero (e2e + integration).
