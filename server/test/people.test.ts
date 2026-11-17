import { describe, expect, it } from "vitest";
import { filmography, nameMatch } from "../src/domain/people.js";

describe("nameMatch: does a search name this person?", () => {
  it("the full name, any case or accents", () => {
    expect(nameMatch("Denis Villeneuve", "denis villeneuve")).toBe("exact");
    expect(nameMatch("Pedro Almodóvar", "pedro almodovar")).toBe("exact");
  });
  it("part of a name, from the start of its words", () => {
    expect(nameMatch("Denis Villeneuve", "villeneuve")).toBe("partial");
    expect(nameMatch("Tom Hanks", "tom han")).toBe("partial");
    expect(nameMatch("Bong Joon Ho", "bong joon")).toBe("partial");
  });
  it("not a match: too short, or not word starts", () => {
    expect(nameMatch("Tom Hanks", "tom")).toBeNull();
    expect(nameMatch("Tom Hanks", "anks")).toBeNull();
    expect(nameMatch("Tom Hanks", "heat")).toBeNull();
    expect(nameMatch("Heath Ledger", "heat")).toBeNull(); // a title search, not Heath Ledger
    expect(nameMatch("Christopher Nolan", "nol")).toBeNull();
  });
});

describe("filmography", () => {
  const m = (id: number, vote_count: number, extra: Record<string, unknown> = {}) => ({ id, title: `#${id}`, poster_path: "/p.jpg", backdrop_path: null, release_date: "2010-01-01", vote_count, ...extra });
  const credits = {
    cast: [m(1, 500), m(2, 9000), m(3, 100, { release_date: "2030-01-01" }), m(4, 50, { poster_path: null })],
    crew: [m(10, 3000, { job: "Director" }), m(11, 8000, { job: "Director" }), m(2, 9000, { job: "Director" }), m(12, 99999, { job: "Writer" })],
  };
  it("directors lead with what they directed, best known first; no repeats", () => {
    expect(filmography(credits, "Directing", "2026-11-17").map((x) => x.id)).toEqual([2, 11, 10, 1]);
  });
  it("actors lead with what they acted in; unreleased and posterless films are left out", () => {
    expect(filmography(credits, "Acting", "2026-11-17").map((x) => x.id)).toEqual([2, 1, 11, 10]);
  });
});
