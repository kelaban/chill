import { describe, expect, it } from "vitest";
import { alignFromWindows, crossCorrelate, fitLinear } from "../src/domain/align.js";
import { libraryPath } from "../src/domain/naming.js";
import { decideHandoffMode, isWatched, mapPosition, nextCut, type PlayableVariant, selectVariant } from "../src/domain/playback.js";

const pv = (id: string, o: Partial<PlayableVariant>): PlayableVariant => ({
  id, tier: "putio", quality: "instant", resolution: 1080, dynamicRange: "SDR", durationS: 6000, ready: true, superseded: false, ...o,
});

describe("selectVariant", () => {
  it("prefers local over put.io, target over instant, then resolution", () => {
    const vs = [pv("putio-instant", {}), pv("putio-target", { quality: "target", resolution: 2160 }), pv("local-target", { tier: "local", quality: "target", resolution: 2160 })];
    expect(selectVariant(vs)?.id).toBe("local-target");
    expect(selectVariant(vs.slice(0, 2))?.id).toBe("putio-target");
  });
  it("ignores copies that aren't ready, and returns null when none are", () => {
    expect(selectVariant([pv("a", { ready: false })])).toBeNull();
  });
  it("prefers non-superseded copies", () => {
    expect(selectVariant([pv("old", { tier: "local", superseded: true }), pv("new", {})])?.id).toBe("new");
  });
});

describe("mapPosition", () => {
  it("uses alignment exactly, minus a 5 s rewind", () => {
    expect(mapPosition(1000, { durationS: 6000 }, { durationS: 6002 }, { a: 1, b: 2.5 })).toBe(997.5);
  });
  it("maps proportionally when durations differ by more than 2%", () => {
    expect(mapPosition(3000, { durationS: 6000 }, { durationS: 7200 })).toBe(3600 - 15);
  });
  it("keeps seconds when durations agree", () => {
    expect(mapPosition(3000, { durationS: 6000 }, { durationS: 6030 })).toBe(2995);
  });
  it("clamps to the file", () => {
    expect(mapPosition(2, null, { durationS: 100 })).toBe(0);
    expect(mapPosition(5000, null, { durationS: 100 })).toBe(90);
  });
  it("watched at 92%", () => {
    expect(isWatched(91, 100)).toBe(false);
    expect(isWatched(92, 100)).toBe(true);
  });
});

describe("handoff", () => {
  const base = { aligned: true, sameDynamicRange: true, twoDecoders: true, hasUsableBlackSegment: false };
  it.each([
    [base, "seamless"],
    [{ ...base, twoDecoders: false, hasUsableBlackSegment: true }, "black-segment"],
    [{ ...base, twoDecoders: false }, "natural-break"],
    [{ ...base, sameDynamicRange: false }, "natural-break"],
    [{ ...base, aligned: false }, "natural-break"],
  ] as const)("%o → %s", (i, mode) => expect(decideHandoffMode(i)).toBe(mode));
  it("nextCut needs 15 s of lead", () => {
    expect(nextCut([10, 20, 40, 60], 10)).toBe(40);
    expect(nextCut([10, 20], 10)).toBeNull();
  });
});

describe("alignment", () => {
  const RATE = 8000;
  // Deterministic noise-like signal: a sum of incommensurate tones with an envelope.
  function signal(seconds: number, seed = 1): Float32Array {
    const out = new Float32Array(Math.round(seconds * RATE));
    let x = seed;
    for (let i = 0; i < out.length; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      out[i] = (x / 0x7fffffff - 0.5) * (0.5 + 0.5 * Math.sin(i / 900));
    }
    return out;
  }
  const slice = (s: Float32Array, fromS: number, lenS: number) => s.slice(Math.round(fromS * RATE), Math.round((fromS + lenS) * RATE));

  it("finds a needle in a haystack", () => {
    const h = signal(20);
    const c = crossCorrelate(slice(h, 7.25, 5), h);
    expect(c.lag / RATE).toBeCloseTo(7.25, 3);
    expect(c.peak).toBeGreaterThan(0.99);
  });

  it("recovers a 2.5 s offset across three anchors (within 5 ms)", () => {
    const film = signal(120);
    // The "to" copy has 2.5 s of extra lead-in: film time t is at t + 2.5 in it.
    const lead = signal(2.5, 7);
    const to = new Float32Array(lead.length + film.length);
    to.set(lead);
    to.set(film, lead.length);
    const margin = 5;
    const windows = [20, 60, 100].map((t) => ({
      fromStartS: t,
      toStartS: t - margin,
      from: slice(film, t, 4),
      to: slice(to, t - margin, 4 + 2 * margin),
    }));
    const r = alignFromWindows(windows, RATE);
    expect(r.aligned).toBe(true);
    expect(r.b).toBeCloseTo(2.5, 2);
    expect(Math.abs(r.a - 1)).toBeLessThan(0.0005);
  });

  it("rejects unrelated audio", () => {
    const r = alignFromWindows([{ fromStartS: 10, toStartS: 5, from: slice(signal(30, 3), 10, 4), to: slice(signal(30, 9), 5, 14) }], RATE);
    expect(r.aligned).toBe(false);
  });

  it("fits drift and flags anchors that disagree", () => {
    const drift = fitLinear([{ tFrom: 100, tTo: 100.1, peak: 1 }, { tFrom: 3000, tTo: 3003, peak: 1 }, { tFrom: 6000, tTo: 6006, peak: 1 }]);
    expect(drift.a).toBeCloseTo(1.001, 4);
    expect(drift.residualMs).toBeLessThan(40);
    const cut = fitLinear([{ tFrom: 100, tTo: 102, peak: 1 }, { tFrom: 3000, tTo: 3002, peak: 1 }, { tFrom: 6000, tTo: 6140, peak: 1 }]);
    expect(cut.residualMs).toBeGreaterThan(40);
  });
});

describe("naming", () => {
  it("produces Plex/Jellyfin-style paths and strips illegal characters", () => {
    expect(libraryPath("Heat", 1995, 949, 2160, "mkv")).toBe("Movies/Heat (1995) {tmdb-949}/Heat (1995) {tmdb-949} - 2160p.mkv");
    expect(libraryPath('Mission: Impossible / "Dead"', 2023, 1, 1080, ".MP4")).toBe(
      "Movies/Mission Impossible Dead (2023) {tmdb-1}/Mission Impossible Dead (2023) {tmdb-1} - 1080p.mp4",
    );
  });
});

describe("TV naming", () => {
  it("uses Plex's TV layout", async () => {
    const { episodeLibraryPath } = await import("../src/domain/naming.js");
    expect(episodeLibraryPath("Stranger Things", 2016, 1, 2, "Chapter Two: The Weirdo on Maple Street", ".MKV")).toBe(
      "TV Shows/Stranger Things (2016)/Season 01/Stranger Things (2016) - S01E02 - Chapter Two The Weirdo on Maple Street.mkv",
    );
    expect(episodeLibraryPath("Show", null, 10, 1, null, "mp4")).toBe("TV Shows/Show/Season 10/Show - S10E01.mp4");
  });
});
