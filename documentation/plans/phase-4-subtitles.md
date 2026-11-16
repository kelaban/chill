# Phase 4a — Subtitles (and an audio-format line)

> **Status 2026-11-16:** built; all tests and e2e pass in demo mode. Not archived
> until checked on the TV (acceptance below) and against real put.io subtitles
> (DECISIONS D37). Deviation: captions are drawn by the player, not the browser's
> native renderer (D40). Found and fixed on the way: replays no longer get stuck
> on the 1080p copy (S18).

**Goal:** every copy chill plays offers its subtitles in the player, picks the
right one automatically (English for foreign-language films, off otherwise),
remembers your choice, and stays in sync through the seamless upgrade and the
laptop's compat stream. The player also says what audio you're getting.

**Out of scope:** image subtitles (PGS/VobSub: need OCR or burn-in),
OpenSubtitles search, preferring releases that carry English subtitles
(chill.institute's `release_info` rarely says), audio-track picker.

## Where subtitles come from

| Copy | Source | How |
|---|---|---|
| put.io | put.io's subtitle list for the file (`GET /v2/files/{id}/subtitles`: sidecar `.srt`s in the transfer folder and tracks inside the MKV, possibly OpenSubtitles) | One call when the copy becomes ready; text fetched server-side on first use as WebVTT (`/files/{id}/subtitles/{key}?format=webvtt`), cached on disk. The put.io token never reaches the player |
| home | sidecars next to the video (`Title (Year) {tmdb-…} - 2160p.en.srt`, Plex naming) + text tracks inside the file (SRT/ASS/mov_text) | Mirror saves put.io's subtitles as sidecars before the put.io copy is cleaned up. Embedded tracks are listed from ffprobe and extracted with ffmpeg on first use, cached |

No new downloads and no extra put.io traffic beyond one list call per copy and
one fetch per subtitle actually shown (or saved home).

## Server

- `domain/subtitles.ts` (pure): language normalization (`English`/`eng`/`en-US` → `en`),
  language + forced/SDH flags from filenames, SRT/VTT cue parsing, VTT output with a
  time transform (`t' = scale·t + shift`), and `pickSubtitle(tracks, pref, film)`.
- Migration `0003_subtitles.sql`: `subtitles` (per variant: id, source, ref,
  language, label, forced, sdh, codec) and `subtitle_choice` (per profile per
  title; NULL language = off). `variants.subs_checked_at`.
- `probe()` also returns subtitle streams and audio channels/layout.
- `services/subtitles.ts`: discover (put.io list or local sidecars + embedded),
  VTT text (cached raw, transformed per request), default pick, save choice.
- API: `StreamInfo` gains `subtitles[]`, `subtitleId` (the pick), `audioChannels`.
  `GET /api/subtitles/:id.vtt?scale=&shift=`, `POST /api/titles/:id/subtitle`.

**Default pick:** a remembered choice for this title wins (including "off").
Otherwise, if the film's original language isn't English → English (full, not
forced; non-SDH preferred). Otherwise → an English *forced* track if there is
one (foreign-dialogue lines), else off.

## Player

- `HandoffEngine.setSubtitle(track | null)`: one `<track>` on the active element.
  Cue times are film time; the engine requests the VTT shifted by its compat
  offset, and after a switch to another copy uses that copy's matching track
  (same language and flags) or, if it has none, the old track transformed by the
  alignment (`scale = a`, `shift = b`).
- OSD: a **Subtitles** chip and an audio line ("Dolby Digital Plus 5.1", or
  "Stereo (converted for this device)" on compat). **Down** opens a menu: Off +
  tracks; Up/Down, OK to choose, Back to close. The choice is saved per profile
  per title.
- `::cue` styled for the TV: large, white, translucent black box.
- Telemetry: one `playback` event per start with the path (direct/compat/HLS),
  audio codec and channels.

## Tests (fakes + generated media only — no live put.io)

- Unit: language/filename parsing, SRT/VTT parse + transform, `pickSubtitle` table.
- Integration: Parasite (Korean) starts with English on; Heat starts with none;
  VTT endpoint shifts cues; mirror writes sidecars; home copy lists embedded +
  sidecar tracks; a saved "off" sticks.
- e2e: Parasite shows cues on the compat stream; the menu turns them off with keys.

## Acceptance

- [ ] Foreign-language film: English subtitles on by default, readable on the TV.
- [ ] English film: off by default; Down → pick English → on; next Play remembers.
- [ ] Subtitles stay in sync across the seamless upgrade and after seeking.
- [ ] Laptop (compat stream): subtitles in sync.
- [ ] Player shows the audio format; telemetry records the playback path.
