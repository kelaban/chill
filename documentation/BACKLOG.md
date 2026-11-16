# chill — Backlog

> Living document. Deferred and someday-maybe items, not committed to a phase.
> Promote one into `ROADMAP.md` (and write a plan) when it's picked up.

- **Claude integration (MCP).** "Pick something for movie night like *Heat* but
  funnier" → search, explain, add to My List. Same pattern as COOK's `/mcp`.
  chill.institute also publishes its own MCP server for reference.
- **Natural-language search** in the search box, backed by the same model.
- **Learned "instant" priors.** Record time-to-ready per indexer / size / age and
  feed it back into the ranker's instant score.
- **Ratings sync** with Trakt / Letterboxd; import watch history.
- **Lists from chill.institute "binges"** and IMDb/Letterboxd lists as home rows.
- **Collections** (TMDB collections: "The Godfather Collection") as rows.
- **Notifications** ("Your 4K copy of Dune is ready") via webOS toast / phone push.
- **Kids profile** with certification filter.
- **Torznab/Prowlarr indexer adapter** as a fallback when chill.institute is down.
- **Remux tier.** Opt-in per title for lossless copies when local space allows.
- **Server hardware transcode** (QuickSync/VAAPI) if Phase 4 shows it's needed.
- **Watch parties / sharing** — probably never.
- **chill as a Stremio add-on.** Expose the server through Stremio's add-on
  protocol so Stremio's LG-store app is a second way onto the TV (no Developer
  Mode). Loses the seamless upgrade; keeps browse, Play and resume. Reference:
  chill-institute/chill-stremio (MIT).
- **Audio track picker** (Phase 4). (Scrub previews and the subtitles picker are built.)
- **Subtitles, round two:** OpenSubtitles lookup when a copy has no English track;
  burn-in or OCR for image-only (PGS) subtitles; prefer releases that carry
  English subtitles for foreign films; a per-profile subtitle language.
- **TV, round two:** season packs (one transfer for a season, files matched to
  episodes); "skip intro"; a 4K tier for episodes; My List for shows; shows in
  "Because you watched".
