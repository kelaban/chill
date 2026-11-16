// Every tunable number in the ranker, so tuning is one reviewable diff.
// Snapshot tests in test/ranker.test.ts lock the resulting picks.

export const W = {
  minBytes: 300e6,
  /** A 2160p upgrade needs at least this many bytes per minute of film (~6.7 Mbps). */
  uhdMinBytesPerMinute: 50e6,
  /** …or, when the runtime is unknown, at least this many bytes. */
  uhdMinBytes: 8e9,
  minSeeders: 2,
  riskyAudioPenalty: 4,
  preferSameRelease: 50,
  preferSameEdition: 3,
  /** Original-language-only release (e.g. Korean audio for a Korean film): fine, subtitles needed. */
  originalLanguageOnly: 2,
  instant: {
    /** Per doubling of seeders: speed of finishing on put.io dominates. */
    seeders: 3,
    /** Past this, more seeders don't make put.io faster (popular releases are cached). DECISIONS D26. */
    seedersCap: 200,
    sizeOutsidePenalty: 2,
    res2160: 1,
    res1080: 3,
    res720: 1.5,
    resUnknown: 0.5,
    /**
     * Same picture type (SDR/HDR10/DV) as the expected upgrade, so the later
     * switch needs no TV picture-mode change and can happen mid-movie. Worth
     * ~3 doublings of seeders, but only for releases with `matchMinSeeders`.
     * Measured on 20 real searches (DECISIONS D12).
     */
    matchesTargetRange: 10,
    matchMinSeeders: 25,
    oddCodecPenalty: 2,
  },
  target: {
    resMatch: 10,
    resFallback: 5,
    drFirst: 4,
    drOther: 3,
    sdrAtTargetPenalty: 2,
    seeders: 1,
  },
} as const;
