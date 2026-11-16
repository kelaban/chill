import { describe, expect, it } from "vitest";
import { DEFAULT_DEVICE, DEFAULT_PROFILE, isBetter, matchesTitle, meetsTarget, rank } from "../src/domain/ranker.js";
import { factsOf, normalizeTitle, releaseLabel } from "../src/domain/release.js";
import { HEAT, rel } from "./helpers.js";

describe("identity", () => {
  it("matches on IMDb id when both sides have one, ignoring the parsed title", () => {
    expect(matchesTitle(HEAT, rel({ title: "Heat Directors Cut", imdbId: "tt0113277" }))).toBe(true);
    expect(matchesTitle(HEAT, rel({ title: "Heat", imdbId: "tt9999999" }))).toBe(false);
  });
  it("never matches a wrong-year remake", () => {
    expect(matchesTitle({ title: "Dune", year: 2021 }, rel({ title: "Dune", year: 1984 }))).toBe(false);
    expect(matchesTitle({ title: "Dune", year: 2021 }, rel({ title: "Dune", year: 2022 }))).toBe(true); // ±1 year
  });
  it("normalizes punctuation, accents, leading articles and ampersands", () => {
    expect(normalizeTitle("The Lord of the Rings: The Fellowship")).toBe(normalizeTitle("Lord.of.the.Rings The Fellowship"));
    expect(normalizeTitle("Amélie")).toBe("amelie");
    expect(normalizeTitle("Fast & Furious")).toBe(normalizeTitle("Fast and Furious"));
  });
  it("accepts the original title", () => {
    expect(matchesTitle({ title: "Spirited Away", originalTitle: "Sen to Chihiro no Kamikakushi", year: 2001 }, rel({ title: "Sen to Chihiro no Kamikakushi", year: 2001 }))).toBe(true);
  });
});

describe("hard filters", () => {
  const dropped = (r: ReturnType<typeof rel>) => rank(HEAT, [r]).dropped[0]?.reason;
  it("a CAM with 5,000 seeders never wins", () => {
    const cam = rel({ quality: "CAM", seeders: 5000 });
    const ok = rel({ seeders: 3 });
    const r = rank(HEAT, [cam, ok]);
    expect(r.instant[0]?.release.id).toBe(ok.id);
    expect(r.dropped).toEqual([{ id: cam.id, reason: "cam/telesync" }]);
  });
  it.each([
    [{ quality: "TS" }, "cam/telesync"],
    [{ quality: "HDCAM" }, "cam/telesync"],
    [{ threeD: true }, "3D"],
    [{ hardcoded: true }, "hardcoded subtitles"],
    [{ size: 100e6 }, "too small (sample?)"],
    [{ seeders: 1 }, "too few seeders"],
    [{ size: 60e9 }, "too large"],
    [{ language: "French" }, "language french"],
  ] as const)("drops %o", (o, reason) => {
    expect(dropped(rel(o))).toBe(reason);
  });
  it("keeps multi-language releases", () => {
    expect(dropped(rel({ language: "Multi" }))).toBeUndefined();
  });
  it("drops audio the device cannot decode", () => {
    const r = rank(HEAT, [rel({ audio: "DTS-HD MA" })], DEFAULT_PROFILE, { ...DEFAULT_DEVICE, unsupportedAudio: ["dts"] });
    expect(r.dropped[0]?.reason).toBe("unsupported audio dts");
  });
  it("dedupes the same release from several indexers", () => {
    const a = rel({ id: "same" });
    expect(rank(HEAT, [a, { ...a, indexer: "other" }]).instant).toHaveLength(1);
  });
});

describe("instant tier", () => {
  it("prefers a well-seeded 1080p WEB-DL over a 4K with similar seeders", () => {
    const hd = rel({ resolution: "1080p", seeders: 200, size: 5e9 });
    const uhd = rel({ resolution: "2160p", hdr: "HDR10", codec: "x265", seeders: 200, size: 14e9 });
    expect(rank(HEAT, [uhd, hd]).instant[0]?.release.id).toBe(hd.id);
  });
  it("seeders dominate: a 720p with 10× the seeders beats a dead 1080p", () => {
    const dead = rel({ resolution: "1080p", seeders: 4 });
    const alive = rel({ resolution: "720p", seeders: 400, size: 2.5e9 });
    expect(rank(HEAT, [dead, alive]).instant[0]?.release.id).toBe(alive.id);
  });
  it("matching the target's dynamic range breaks ties but never beats a doubling of seeders", () => {
    const sdr = rel({ seeders: 100 });
    const hdr = rel({ seeders: 100, hdr: "HDR10", codec: "x265" });
    expect(rank(HEAT, [sdr, hdr]).instant[0]?.release.id).toBe(hdr.id);
    const sdrBusy = rel({ seeders: 210 });
    expect(rank(HEAT, [hdr, sdrBusy]).instant[0]?.release.id).toBe(sdrBusy.id);
  });
  it("penalizes unverified audio (TrueHD) for the instant pick", () => {
    const truehd = rel({ audio: "TrueHD Atmos", seeders: 150 });
    const ddp = rel({ audio: "DDP5.1", seeders: 100 });
    expect(rank(HEAT, [truehd, ddp]).instant[0]?.release.id).toBe(ddp.id);
  });
  it("excludes anything over the instant size cap", () => {
    expect(rank(HEAT, [rel({ size: 20e9, resolution: "2160p" })]).instant).toHaveLength(0);
  });
});

describe("target tier", () => {
  it("prefers 2160p Dolby Vision WEB-DL within the cap", () => {
    const dv = rel({ resolution: "2160p", hdr: "DV HDR10", codec: "H.265", size: 18e9, seeders: 40 });
    const hdr = rel({ resolution: "2160p", hdr: "HDR10", codec: "x265", size: 16e9, seeders: 60 });
    const hd = rel({ resolution: "1080p", codec: "x265", quality: "BluRay", size: 8e9, seeders: 300 });
    expect(rank(HEAT, [hd, hdr, dv]).target.map((s) => s.release.id)).toEqual([dv.id, hdr.id, hd.id]);
  });
  it("skips Dolby Vision on a device without it", () => {
    const dv = rel({ resolution: "2160p", hdr: "DV", size: 18e9, seeders: 40 });
    const r = rank(HEAT, [dv], DEFAULT_PROFILE, { ...DEFAULT_DEVICE, dolbyVision: false });
    expect(r.target).toHaveLength(0);
  });
  it("falls back to 1080p only within the fallback cap", () => {
    expect(rank(HEAT, [rel({ resolution: "1080p", size: 11e9 })]).target).toHaveLength(1);
    expect(rank(HEAT, [rel({ resolution: "1080p", size: 13e9 })]).target).toHaveLength(0);
  });
  it("requires min seeders", () => {
    expect(rank(HEAT, [rel({ resolution: "2160p", hdr: "HDR10", size: 15e9, seeders: 3 })]).target).toHaveLength(0);
  });
  it("prefers the same release and edition when resuming after eviction", () => {
    const a = rel({ resolution: "2160p", hdr: "HDR10", size: 15e9, seeders: 80 });
    const b = rel({ resolution: "2160p", hdr: "HDR10", size: 15e9, seeders: 40, edition: "Extended" });
    expect(rank(HEAT, [a, b], undefined, undefined, { releaseId: b.id }).target[0]?.release.id).toBe(b.id);
  });
});

describe("helpers", () => {
  it("meetsTarget / isBetter", () => {
    const uhd = rank(HEAT, [rel({ resolution: "2160p", hdr: "HDR10", size: 9e9 })]).instant[0]!;
    expect(meetsTarget(uhd)).toBe(true);
    const hd = factsOf(rel({}));
    expect(isBetter(hd, uhd.facts)).toBe(true);
    expect(isBetter(uhd.facts, hd)).toBe(false);
  });
  it("labels releases for humans", () => {
    expect(releaseLabel(rel({ resolution: "2160p", hdr: "DV", quality: "WEB-DL", size: 18.24e9 }))).toBe("2160p Dolby Vision WEB-DL · 18.2 GB");
  });
});

describe("instant pick follows the expected upgrade's dynamic range", () => {
  it("prefers HDR10 over DV for the instant pick when the top target is HDR10", () => {
    const tHdr = rel({ resolution: "2160p", hdr: "HDR10", codec: "x265", size: 16e9, seeders: 140 });
    const iHdr = rel({ resolution: "1080p", hdr: "HDR10", codec: "x265", size: 3e9, seeders: 100 });
    const iDv = rel({ resolution: "1080p", hdr: "DV", codec: "x265", size: 3e9, seeders: 100 });
    const r = rank(HEAT, [tHdr, iDv, iHdr]);
    expect(r.target[0]?.release.id).toBe(tHdr.id);
    expect(r.instant[0]?.release.id).toBe(iHdr.id);
  });
});
