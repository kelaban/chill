import type { DynamicRange, HandoffMode, Tier } from "@chill/shared";

export interface PlayableVariant {
  id: string;
  tier: Tier;
  quality: "instant" | "target";
  resolution: number | null;
  dynamicRange: DynamicRange;
  durationS: number | null;
  ready: boolean;
  superseded: boolean;
}

/** The copy to play: ready, not superseded; local > put.io, target > instant, then resolution. */
export function selectVariant(variants: PlayableVariant[]): PlayableVariant | null {
  const ready = variants.filter((v) => v.ready);
  if (ready.length === 0) return null;
  const rank = (v: PlayableVariant) =>
    (v.superseded ? 0 : 1000) + (v.tier === "local" ? 100 : 0) + (v.quality === "target" ? 10 : 0) + (v.resolution ?? 0) / 1000;
  return [...ready].sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id))[0] ?? null;
}

export interface Alignment {
  a: number;
  b: number;
}

export interface AlignmentEdge extends Alignment {
  from: string;
  to: string;
}

/** `t ↦ a·t + b` applied after `first`. */
export const composeAlignment = (first: Alignment, then: Alignment): Alignment => ({ a: then.a * first.a, b: then.a * first.b + then.b });
export const invertAlignment = (x: Alignment): Alignment => ({ a: 1 / x.a, b: -x.b / x.a });

/**
 * The mapping from copy `from`'s timeline to copy `to`'s, through measured
 * alignments in either direction (fast copy → 4K on put.io → same 4K at home),
 * or null when they aren't connected within `maxHops`.
 */
export function alignmentBetween(edges: AlignmentEdge[], from: string, to: string, maxHops = 3): Alignment | null {
  if (from === to) return { a: 1, b: 0 };
  const next = new Map<string, { id: string; m: Alignment }[]>();
  const add = (x: string, y: string, m: Alignment) => next.set(x, [...(next.get(x) ?? []), { id: y, m }]);
  for (const e of edges) {
    if (!(e.a > 0)) continue;
    add(e.from, e.to, e);
    add(e.to, e.from, invertAlignment(e));
  }
  let frontier: { id: string; m: Alignment }[] = [{ id: from, m: { a: 1, b: 0 } }];
  const seen = new Set([from]);
  for (let hop = 0; hop < maxHops && frontier.length; hop++) {
    const nextFrontier: { id: string; m: Alignment }[] = [];
    for (const f of frontier)
      for (const n of next.get(f.id) ?? []) {
        if (seen.has(n.id)) continue;
        const m = composeAlignment(f.m, n.m);
        if (n.id === to) return m;
        seen.add(n.id);
        nextFrontier.push({ id: n.id, m });
      }
    frontier = nextFrontier;
  }
  return null;
}

/**
 * Where to start the `to` copy, given a position saved against the `from` copy.
 * Aligned pairs map exactly (5 s rewind); unaligned pairs whose durations differ
 * by > 2% map proportionally (15 s rewind); otherwise same seconds (5 s rewind).
 */
export function mapPosition(
  positionS: number,
  from: { durationS: number | null } | null,
  to: { durationS: number | null },
  alignment?: Alignment | null,
): number {
  let t: number;
  if (alignment) t = alignment.a * positionS + alignment.b - 5;
  else if (from?.durationS && to.durationS && Math.abs(from.durationS - to.durationS) / from.durationS > 0.02)
    t = (positionS * to.durationS) / from.durationS - 15;
  else t = positionS - 5;
  const max = to.durationS ? Math.max(0, to.durationS - 10) : Infinity;
  return Math.round(Math.min(Math.max(0, t), max) * 1000) / 1000;
}

/** Watched once ≥ 92% through (credits). */
export const isWatched = (positionS: number, durationS: number) => durationS > 0 && positionS / durationS >= 0.92;

export interface HandoffInputs {
  aligned: boolean;
  sameDynamicRange: boolean;
  twoDecoders: boolean;
  hasUsableBlackSegment: boolean;
}

/** See ARCHITECTURE.md → Seamless upgrade. */
export function decideHandoffMode(i: HandoffInputs): HandoffMode {
  if (!i.aligned || !i.sameDynamicRange) return "natural-break";
  if (i.twoDecoders) return "seamless";
  return i.hasUsableBlackSegment ? "black-segment" : "natural-break";
}

/** Next cut at least `minLeadS` ahead of `nowS` (both in the same timeline). */
export function nextCut(cuts: number[], nowS: number, minLeadS = 15): number | null {
  for (const c of cuts) if (c >= nowS + minLeadS) return c;
  return null;
}
