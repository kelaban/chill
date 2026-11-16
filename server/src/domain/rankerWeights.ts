// Every tunable number in the ranker, so tuning is one reviewable diff.
// Snapshot tests in test/ranker.test.ts lock the resulting picks.

export const W = {
  minBytes: 300e6,
  minSeeders: 2,
  riskyAudioPenalty: 4,
  preferSameRelease: 50,
  preferSameEdition: 3,
  instant: {
    /** Per doubling of seeders: speed of finishing on put.io dominates. */
    seeders: 3,
    sizeOutsidePenalty: 2,
    res2160: 1,
    res1080: 3,
    res720: 1.5,
    resUnknown: 0.5,
    /** Below one doubling of seeders, so it never makes Play slower. */
    matchesTargetRange: 1.5,
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
