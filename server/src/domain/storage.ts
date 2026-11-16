import type { Tier } from "@chill/shared";

/** Everything the eviction policy needs to know about one stored copy. */
export interface VariantFacts {
  id: string;
  tmdbId: number;
  tier: Tier;
  sizeBytes: number;
  createdAt: Date;
  lastPlayedAt: Date | null;
  pinned: boolean;
  /** A playback heartbeat arrived recently. */
  playing: boolean;
  /** Source of an in-flight mirror, or the only copy of a title queued to play. */
  protected: boolean;
  /** A better, verified copy of the same title exists (anywhere). */
  superseded: boolean;
  /** put.io variants only: the title has a verified local copy. */
  mirroredLocally: boolean;
  /** Watch state for the title (any profile), or null if never started. */
  watch: { watched: boolean; updatedAt: Date } | null;
}

export interface Budget {
  budgetBytes: number;
  highWatermark: number; // 0–1
  lowWatermark: number; // 0–1
}

export interface EvictionConfig {
  watchedGraceDays: number;
  prefetchStaleDays: number;
  inProgressStaleDays: number;
}

export const DEFAULT_EVICTION: EvictionConfig = { watchedGraceDays: 3, prefetchStaleDays: 14, inProgressStaleDays: 30 };

export interface EvictionPlan {
  evict: string[];
  freedBytes: number;
  /** Usage after the plan is applied. */
  usedAfter: number;
  /** Usage the plan was aiming for. */
  goalBytes: number;
  satisfied: boolean;
}

const DAY = 86_400_000;

/**
 * Eviction class, lower goes first. null = never evict.
 *  1 superseded · 2 put.io copy already mirrored home · 3 watched past grace ·
 *  4 stale never-started prefetch · 5 stale in-progress · 6 everything else (LRU)
 */
export function evictionClass(v: VariantFacts, now: Date, cfg: EvictionConfig = DEFAULT_EVICTION): number | null {
  if (v.playing || v.pinned || v.protected) return null;
  if (v.superseded) return 1;
  if (v.tier === "putio" && v.mirroredLocally) return 2;
  const last = lastActivity(v).getTime();
  const age = now.getTime() - last;
  if (v.watch?.watched && age > cfg.watchedGraceDays * DAY) return 3;
  if (!v.watch && now.getTime() - v.createdAt.getTime() > cfg.prefetchStaleDays * DAY) return 4;
  if (v.watch && !v.watch.watched && age > cfg.inProgressStaleDays * DAY) return 5;
  return 6;
}

function lastActivity(v: VariantFacts): Date {
  // Last time anyone engaged with it; a copy nobody touched dates from its arrival.
  const times = [v.lastPlayedAt, v.watch?.updatedAt].filter((d): d is Date => !!d);
  return times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : v.createdAt;
}

/**
 * Which variants (all on one tier) to delete. Triggers when usage is above the
 * high watermark (then aims for the low watermark) or when `needBytes` must be
 * freed for an incoming file (then aims for budget − needBytes); the stricter
 * goal wins when both apply.
 */
export function planEviction(
  variants: VariantFacts[],
  usedBytes: number,
  budget: Budget,
  now: Date,
  needBytes = 0,
  cfg: EvictionConfig = DEFAULT_EVICTION,
): EvictionPlan {
  const goals: number[] = [];
  if (usedBytes > budget.highWatermark * budget.budgetBytes) goals.push(budget.lowWatermark * budget.budgetBytes);
  if (needBytes > 0 && usedBytes + needBytes > budget.budgetBytes) goals.push(budget.budgetBytes - needBytes);
  if (goals.length === 0) return { evict: [], freedBytes: 0, usedAfter: usedBytes, goalBytes: usedBytes, satisfied: true };
  const goal = Math.min(...goals);

  const candidates = variants
    .map((v) => ({ v, cls: evictionClass(v, now, cfg) }))
    .filter((x): x is { v: VariantFacts; cls: number } => x.cls !== null)
    .sort((a, b) => a.cls - b.cls || lastActivity(a.v).getTime() - lastActivity(b.v).getTime() || a.v.id.localeCompare(b.v.id));

  const evict: string[] = [];
  let used = usedBytes;
  for (const { v } of candidates) {
    if (used <= goal) break;
    evict.push(v.id);
    used -= v.sizeBytes;
  }
  return { evict, freedBytes: usedBytes - used, usedAfter: used, goalBytes: goal, satisfied: used <= goal };
}

export type Admission =
  | { ok: true; evict: string[] }
  | { ok: false; reason: string; shortBytes: number };

/** Admission control: may a file of `sizeBytes` land on this tier, and what must go first? */
export function admit(
  sizeBytes: number,
  variants: VariantFacts[],
  usedBytes: number,
  budget: Budget,
  now: Date,
  cfg: EvictionConfig = DEFAULT_EVICTION,
): Admission {
  const need = Math.ceil(sizeBytes * 1.1);
  if (need > budget.budgetBytes) return { ok: false, reason: `File is larger than the whole ${fmt(budget.budgetBytes)} budget`, shortBytes: need - budget.budgetBytes };
  if (usedBytes + need <= budget.budgetBytes) return { ok: true, evict: [] };
  const plan = planEviction(variants, usedBytes, budget, now, need, cfg);
  if (plan.usedAfter + need <= budget.budgetBytes) return { ok: true, evict: plan.evict };
  const short = plan.usedAfter + need - budget.budgetBytes;
  return { ok: false, reason: `Waiting for space: ${fmt(short)} more needed`, shortBytes: short };
}

const fmt = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
