import { describe, expect, it } from "vitest";
import { becauseRows, becauseSeeds, genreAffinity, pickGenreRows, watchWeight, type Watched } from "../src/domain/taste.js";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const w = (tmdbId: number, genreIds: number[], fraction = 1, daysAgo = 0, title = `#${tmdbId}`): Watched => ({ tmdbId, title, genreIds, fraction, at: NOW - daysAgo * DAY });
const POOL = [28, 878, 35, 53, 18, 16, 27, 80].map((id) => ({ id }));
const DEFAULTS = [28, 878, 35, 53, 18, 16];

describe("taste: what a profile watched → what it sees first", () => {
  it("weighs a watch by how much was seen and how long ago", () => {
    expect(watchWeight(w(1, [27], 1, 0), NOW)).toBe(1);
    expect(watchWeight(w(1, [27], 0.6, 0), NOW)).toBe(1);
    expect(watchWeight(w(1, [27], 0.06, 0), NOW)).toBeCloseTo(0.1);
    expect(watchWeight(w(1, [27], 1, 30), NOW)).toBeCloseTo(0.5);
  });

  it("no history: the household default rows, in order", () => {
    expect(pickGenreRows(POOL, DEFAULTS, genreAffinity([], NOW)).map((g) => g.id)).toEqual(DEFAULTS);
  });

  it("a horror streak puts Horror first; the defaults fill the rest", () => {
    const aff = genreAffinity([w(348, [27, 878]), w(578, [27, 53, 12]), w(419430, [9648, 53, 27])], NOW);
    const rows = pickGenreRows(POOL, DEFAULTS, aff).map((g) => g.id);
    expect(rows[0]).toBe(27);
    expect(rows).toHaveLength(6);
    expect(new Set(rows).size).toBe(6);
  });

  it("a film abandoned after five minutes, or watched a year ago, barely moves anything", () => {
    const aff = genreAffinity([w(1, [27], 0.04), w(2, [80], 1, 365)], NOW);
    expect(pickGenreRows(POOL, DEFAULTS, aff).map((g) => g.id)).toEqual(DEFAULTS);
  });

  it("seeds 'Because you watched' from the latest films watched at least a quarter through, never episodes", () => {
    const seeds = becauseSeeds([w(1, [], 0.9, 3), w(-5, [], 1, 0), w(2, [], 0.1, 1), w(3, [], 1, 2), w(4, [], 1, 9)]);
    expect(seeds.map((s) => s.tmdbId)).toEqual([3, 1]);
  });

  it("rows skip what was seen, the seeds, and each other; thin rows are dropped", () => {
    const r = (...ids: number[]) => ids.map((tmdbId) => ({ tmdbId }));
    const rows = becauseRows(
      [
        { seed: w(1, []), recs: r(2, 10, 11, 12, 13, 14) },
        { seed: w(2, []), recs: r(1, 10, 11, 12, 20, 21, 22, 23) },
        { seed: w(3, []), recs: r(10, 11, 30) },
      ],
      new Set([14]),
    );
    expect(rows.map((x) => x.items.map((i) => i.tmdbId))).toEqual([[10, 11, 12, 13], [20, 21, 22, 23]]);
  });
});
