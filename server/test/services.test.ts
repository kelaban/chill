import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Release } from "../src/domain/release.js";
import { serviceOf, titleServices } from "../src/domain/services.js";
import { rel } from "./helpers.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/chill");
const real = (slug: string) => (JSON.parse(fs.readFileSync(path.join(DIR, `${slug}.json`), "utf8")) as { results: Release[] }).results;
const names = (slug: string) => titleServices(real(slug)).map((s) => s.name);

describe("release source tags → services", () => {
  it.each([
    ["NF", "Netflix"], ["HMAX", "Max"], ["MAX", "Max"], ["DSNP", "Disney+"], ["ATVP", "Apple TV+"],
    ["PMTP", "Paramount+"], ["PCOK", "Peacock"], ["AMZN", "Prime Video"], ["iT", "iTunes"], ["hulu", "Hulu"],
  ] as const)("%s → %s", (tag, name) => expect(serviceOf(tag)?.name).toBe(name));
  it("ignores tags that aren't services", () => {
    expect(serviceOf("WEB")).toBeNull();
    expect(serviceOf("")).toBeNull();
    expect(serviceOf(undefined)).toBeNull();
  });
});

describe("a title's services, on 20 real chill.institute searches", () => {
  it.each([
    ["dune-2021", ["Max"]], // a Warner film: Max, not the Amazon rental
    ["the-godfather-1972", ["Paramount+", "The Roku Channel", "Netflix"]], // Paramount's own service first
    ["the-grand-budapest-hotel-2014", ["Netflix"]],
    ["mad-max-fury-road-2015", ["Netflix", "Max"]],
    ["sicario-2015", ["Max", "Peacock"]],
    ["come-and-see-1985", ["iTunes"]], // only a storefront: shown, as a last resort
    ["heat-1995", []], // BluRay rips only: nothing to say
  ] as const)("%s → %o", (slug, expected) => expect(names(slug)).toEqual(expected));

  it("a storefront that clearly dominates leads (likely a Prime Video original)", () => {
    const rs = [rel({ source: "AMZN", seeders: 900 }), rel({ source: "NF", seeders: 30 })];
    expect(titleServices(rs).map((s) => s.name)).toEqual(["Prime Video", "Netflix"]);
  });
  it("storefronts never outrank a real subscription service otherwise", () => {
    const rs = [rel({ source: "AMZN", seeders: 300 }), rel({ source: "HMAX", seeders: 200 })];
    expect(titleServices(rs).map((s) => s.name)).toEqual(["Max"]);
  });
});
