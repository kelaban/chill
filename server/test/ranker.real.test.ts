import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { languageOk, matchesTitle, needsUpgrade, rank } from "../src/domain/ranker.js";
import { releaseLabel, type Release } from "../src/domain/release.js";

// Real chill.institute search results for 20 films, recorded 2026-11-16 with
// `npm run test:live`-style calls (magnet links stripped). Invariants must hold
// for every film; the snapshot locks today's picks so weight changes show up
// as a reviewable diff.

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/chill");
const ORIGINAL_LANGUAGE: Record<string, string> = { "parasite-2019": "ko", "spirited-away-2001": "ja", "tampopo-1985": "ja", "come-and-see-1985": "ru" };
// Runtimes (minutes) so the 4K bytes-per-minute floor applies as in production.
const RUNTIME: Record<string, number> = {
  "arrival-2016": 116, "blade-runner-2049-2017": 164, "come-and-see-1985": 142, "dune-2021": 155, "dune-part-two-2024": 167,
  "everything-everywhere-all-at-once-2022": 139, "heart-of-the-beast-2026": 110, "heat-1995": 170, "inception-2010": 148, "knives-out-2019": 131,
  "mad-max-fury-road-2015": 120, "oppenheimer-2023": 180, "parasite-2019": 132, "sicario-2015": 121, "spirited-away-2001": 125, "tampopo-1985": 114,
  "the-godfather-1972": 175, "the-grand-budapest-hotel-2014": 100, "the-matrix-1999": 136, "top-gun-maverick-2022": 131,
};

interface Fixture {
  query: string;
  title: string;
  year: number;
  imdbId: string;
  results: Release[];
}

const fixtures = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ slug: f.replace(/\.json$/, ""), ...(JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")) as Fixture) }));

describe("ranker on real chill.institute results", () => {
  it("has the recorded fixtures", () => expect(fixtures.length).toBeGreaterThanOrEqual(20));

  for (const fx of fixtures) {
    describe(fx.query, () => {
      const facts = { title: fx.title, year: fx.year, imdbId: fx.imdbId, originalLanguage: ORIGINAL_LANGUAGE[fx.slug] ?? "en", runtimeMin: RUNTIME[fx.slug] };
      const r = rank(facts, fx.results);

      it("finds a fast copy", () => expect(r.instant.length).toBeGreaterThan(0));
      it("never picks a CAM, 3D, hardcoded-sub or wrong-film release", () => {
        for (const s of [...r.instant.slice(0, 3), ...r.target.slice(0, 3)]) {
          expect(s.facts.source).not.toBe("cam");
          expect(s.facts.threeD).toBe(false);
          expect(s.facts.hardcoded).toBe(false);
          expect(matchesTitle(facts, s.release)).toBe(true);
        }
      });
      it("keeps the fast copy small and well seeded", () => {
        const i = r.instant[0]!;
        expect(i.release.sizeBytes).toBeLessThanOrEqual(15e9);
        expect(i.release.seeders).toBeGreaterThanOrEqual(20);
      });
      it("keeps the upgrade inside the 25 GB cap", () => {
        for (const t of r.target.slice(0, 3)) expect(t.release.sizeBytes).toBeLessThanOrEqual(25e9);
      });
    });
  }

  it("locks today's picks (review the diff when weights change)", () => {
    const picks = Object.fromEntries(
      fixtures.map((fx) => {
        const r = rank({ title: fx.title, year: fx.year, imdbId: fx.imdbId, originalLanguage: ORIGINAL_LANGUAGE[fx.slug] ?? "en", runtimeMin: RUNTIME[fx.slug] }, fx.results);
        const i = r.instant[0];
        const t = r.target[0];
        // Mirrors acquirer.planTarget: an upgrade only when it's actually better.
        const up = t && i && needsUpgrade(i, t, undefined, undefined, RUNTIME[fx.slug]) ? t : null;
        const seamless = !up || !i ? null : up.facts.dynamicRange === i.facts.dynamicRange;
        return [fx.query, { instant: i ? `${releaseLabel(i.release)} · ${i.release.seeders} seeders` : null, upgrade: up ? releaseLabel(up.release) : null, seamless }];
      }),
    );
    expect(picks).toMatchSnapshot();
  });
});

describe("language tags as chill.institute reports them", () => {
  it.each([
    ["ita eng", true],
    ["ita.eng", true],
    ["vff vfq eng", true],
    ["Multi", true],
    ["ita", false],
    ["kor", false],
    ["jpn", false],
  ] as const)("%s → English ok: %s", (tag, ok) => expect(languageOk(tag, ["en"])).toBe(ok));
  it("accepts the film's original language", () => {
    expect(languageOk("kor", ["ko"])).toBe(true);
    expect(languageOk("jpn eng", ["ja"])).toBe(true);
  });
});
