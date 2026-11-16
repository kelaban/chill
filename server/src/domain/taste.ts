// What a profile likes, from what it watched: which genre rows come first, and
// which films seed "Because you watched". Pure: facts in, decisions out (pass
// `now`), no I/O.

export interface Watched {
  tmdbId: number;
  title: string;
  genreIds: number[];
  /** 0–1 of the film seen (1 when marked watched). */
  fraction: number;
  /** ms since epoch of the last watch. */
  at: number;
}

const DAY = 86_400_000;
/** A month-old watch counts half as much as today's. */
const HALF_LIFE_DAYS = 30;

/** How much one watch says about taste: barely-started films say little, old ones fade. */
export function watchWeight(w: Watched, now: number): number {
  const engaged = Math.min(1, Math.max(0, w.fraction) / 0.6); // 60% through counts fully
  const age = Math.max(0, now - w.at) / DAY;
  return engaged * 0.5 ** (age / HALF_LIFE_DAYS);
}

/** Genre id → affinity, summed over watches. A film's weight is split across its genres. */
export function genreAffinity(history: Watched[], now: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const w of history) {
    if (!w.genreIds.length) continue;
    const share = watchWeight(w, now) / Math.sqrt(w.genreIds.length);
    for (const g of w.genreIds) out.set(g, (out.get(g) ?? 0) + share);
  }
  return out;
}

/**
 * Which genre rows to show, in order: the profile's genres first (strongest
 * first, if they clear `minAffinity`), then the household defaults, `n` in all.
 */
export function pickGenreRows<G extends { id: number }>(pool: G[], defaults: number[], affinity: Map<number, number>, n = 6, minAffinity = 0.15): G[] {
  const byId = new Map(pool.map((g) => [g.id, g]));
  const liked = [...affinity.entries()].filter(([id, a]) => a >= minAffinity && byId.has(id)).sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const order = [...new Set([...liked, ...defaults.filter((id) => byId.has(id))])];
  return order.slice(0, n).map((id) => byId.get(id)!);
}

/** Films worth a "Because you watched" row: recent, actually watched (≥ 25%), newest first, one row each. */
export function becauseSeeds(history: Watched[], max = 2): Watched[] {
  return [...history]
    .filter((w) => w.tmdbId > 0 && w.fraction >= 0.25)
    .sort((a, b) => b.at - a.at)
    .slice(0, max);
}

/**
 * Turn each seed's recommendations into a row: drop what the profile already
 * watched, the seeds themselves, and anything an earlier row shows; a row with
 * fewer than `minItems` left is dropped.
 */
export function becauseRows<T extends { tmdbId: number }>(
  seeds: { seed: Watched; recs: T[] }[],
  seen: Set<number>,
  minItems = 4,
  perRow = 20,
): { seed: Watched; items: T[] }[] {
  const shown = new Set<number>([...seen, ...seeds.map((s) => s.seed.tmdbId)]);
  const rows: { seed: Watched; items: T[] }[] = [];
  for (const { seed, recs } of seeds) {
    const items = recs.filter((r) => !shown.has(r.tmdbId)).slice(0, perRow);
    if (items.length < minItems) continue;
    for (const r of items) shown.add(r.tmdbId);
    rows.push({ seed, items });
  }
  return rows;
}
