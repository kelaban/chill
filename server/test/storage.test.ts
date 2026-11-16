import { describe, expect, it } from "vitest";
import { admit, evictionClass, planEviction, type VariantFacts } from "../src/domain/storage.js";
import { days } from "./helpers.js";

const NOW = new Date("2026-11-16T12:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - days(d));
const GB = 1e9;
const BUDGET = { budgetBytes: 100 * GB, highWatermark: 0.9, lowWatermark: 0.75 };

function v(id: string, o: Partial<VariantFacts> = {}): VariantFacts {
  return {
    id, tmdbId: 1, tier: "local", sizeBytes: 10 * GB, createdAt: ago(1), lastPlayedAt: null,
    pinned: false, playing: false, protected: false, superseded: false, mirroredLocally: false,
    watch: { watched: false, updatedAt: ago(1) }, ...o,
  };
}

describe("evictionClass", () => {
  it.each([
    ["superseded", { superseded: true }, 1],
    ["put.io copy already home", { tier: "putio" as const, mirroredLocally: true }, 2],
    ["watched past grace", { watch: { watched: true, updatedAt: ago(4) } }, 3],
    ["watched within grace", { watch: { watched: true, updatedAt: ago(2) } }, 6],
    ["stale prefetch", { watch: null, createdAt: ago(15) }, 4],
    ["fresh prefetch", { watch: null, createdAt: ago(3) }, 6],
    ["stale in-progress", { watch: { watched: false, updatedAt: ago(31) }, createdAt: ago(40) }, 5],
    ["recent in-progress", {}, 6],
  ] as const)("%s → %i", (_, o, cls) => {
    expect(evictionClass(v("x", o), NOW)).toBe(cls);
  });
  it.each([["playing", { playing: true }], ["pinned", { pinned: true }], ["protected", { protected: true }]] as const)(
    "never evicts %s, even when superseded",
    (_, o) => expect(evictionClass(v("x", { ...o, superseded: true }), NOW)).toBeNull(),
  );
  it("a recent play resets the clock for watched titles", () => {
    expect(evictionClass(v("x", { watch: { watched: true, updatedAt: ago(10) }, lastPlayedAt: ago(1) }), NOW)).toBe(6);
  });
});

describe("planEviction", () => {
  it("does nothing under the high watermark", () => {
    expect(planEviction([v("a")], 89 * GB, BUDGET, NOW).evict).toEqual([]);
  });
  it("evicts down to the low watermark in class order, then LRU", () => {
    const vs = [
      v("lru-old", { lastPlayedAt: ago(9), createdAt: ago(9), watch: null }),
      v("lru-new", { lastPlayedAt: ago(1), watch: null }),
      v("watched", { watch: { watched: true, updatedAt: ago(5) } }),
      v("super", { superseded: true }),
      v("pinned", { pinned: true, superseded: true }),
    ];
    const p = planEviction(vs, 95 * GB, BUDGET, NOW);
    expect(p.evict).toEqual(["super", "watched"]);
    expect(p.usedAfter).toBe(75 * GB);
    expect(p.satisfied).toBe(true);
    const more = planEviction(vs, 99 * GB, BUDGET, NOW);
    expect(more.evict).toEqual(["super", "watched", "lru-old"]);
  });
  it("reports unsatisfied when only protected things remain", () => {
    const p = planEviction([v("p", { playing: true, sizeBytes: 95 * GB })], 95 * GB, BUDGET, NOW);
    expect(p).toMatchObject({ evict: [], satisfied: false });
  });
  it("frees room for an incoming file even below the high watermark", () => {
    const p = planEviction([v("a", { superseded: true }), v("b")], 80 * GB, BUDGET, NOW, 25 * GB);
    expect(p.evict).toEqual(["a"]);
    expect(p.usedAfter + 25 * GB).toBeLessThanOrEqual(BUDGET.budgetBytes);
  });
});

describe("admit", () => {
  it("admits without evicting when there is room", () => {
    expect(admit(20 * GB, [], 50 * GB, BUDGET, NOW)).toEqual({ ok: true, evict: [] });
  });
  it("admits by evicting, counting a 10% margin", () => {
    const r = admit(20 * GB, [v("a", { superseded: true, sizeBytes: 15 * GB })], 85 * GB, BUDGET, NOW);
    expect(r).toEqual({ ok: true, evict: ["a"] });
  });
  it("refuses with a human reason when nothing can go", () => {
    const r = admit(20 * GB, [v("a", { pinned: true, sizeBytes: 85 * GB })], 85 * GB, BUDGET, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("Waiting for space: 7.0 GB more needed");
  });
  it("refuses files larger than the whole budget", () => {
    expect(admit(95 * GB, [], 0, BUDGET, NOW).ok).toBe(false);
  });
});
