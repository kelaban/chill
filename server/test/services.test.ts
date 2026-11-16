import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Release } from "../src/domain/release.js";
import { providerKey, providerServices, serviceOf, titleServices } from "../src/domain/services.js";
import { rel } from "./helpers.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/chill");
const real = (slug: string) => (JSON.parse(fs.readFileSync(path.join(DIR, `${slug}.json`), "utf8")) as { results: Release[] }).results;
const names = (slug: string) => titleServices(real(slug)).map((s) => s.name);

describe("release source tags → services", () => {
  it.each([
    ["NF", "Netflix"], ["HMAX", "HBO Max"], ["MAX", "HBO Max"], ["DSNP", "Disney+"], ["ATVP", "Apple TV"],
    ["PMTP", "Paramount+"], ["PCOK", "Peacock"], ["AMZN", "Prime Video"], ["iT", "Apple TV Store"], ["hulu", "Hulu"],
  ] as const)("%s → %s", (tag, name) => expect(serviceOf(tag)?.name).toBe(name));
  it("ignores tags that aren't services", () => {
    expect(serviceOf("WEB")).toBeNull();
    expect(serviceOf("")).toBeNull();
    expect(serviceOf(undefined)).toBeNull();
  });
});

describe("a title's services, on 20 real chill.institute searches", () => {
  it.each([
    ["dune-2021", ["HBO Max"]], // a Warner film: Max, not the Amazon rental
    ["the-godfather-1972", ["Paramount+", "The Roku Channel", "Netflix"]], // Paramount's own service first
    ["the-grand-budapest-hotel-2014", ["Netflix"]],
    ["mad-max-fury-road-2015", ["Netflix", "HBO Max"]],
    ["sicario-2015", ["HBO Max", "Peacock"]],
    ["come-and-see-1985", ["Apple TV Store"]], // only a storefront: shown, as a last resort
    ["heat-1995", []], // BluRay rips only: nothing to say
  ] as const)("%s → %o", (slug, expected) => expect(names(slug)).toEqual(expected));

  it("a storefront that clearly dominates leads (likely a Prime Video original)", () => {
    const rs = [rel({ source: "AMZN", seeders: 900 }), rel({ source: "NF", seeders: 30 })];
    expect(titleServices(rs).map((s) => s.name)).toEqual(["Prime Video", "Netflix"]);
  });
  it("storefronts never outrank a real subscription service otherwise", () => {
    const rs = [rel({ source: "AMZN", seeders: 300 }), rel({ source: "HMAX", seeders: 200 })];
    expect(titleServices(rs).map((s) => s.name)).toEqual(["HBO Max"]);
  });
});

describe("TMDB watch providers → services", () => {
  const P = (provider_id: number, provider_name: string, display_priority = 50) => ({ provider_id, provider_name, display_priority });

  it("strips tiers and resellers", () => {
    expect(providerKey("Netflix Standard with Ads")).toBe("netflix");
    expect(providerKey("HBO Max Amazon Channel")).toBe("hbo max");
    expect(providerKey("Peacock Premium Plus")).toBe("peacock");
    expect(providerKey("AMC+ Roku Premium Channel")).toBe("amc+");
    expect(providerKey("Paramount Plus Essential")).toBe("paramount plus");
  });

  it("keeps Apple's subscription and its store apart (both are called 'Apple TV' something now)", () => {
    const r = providerServices({ flatrate: [P(350, "Apple TV", 6)], rent: [P(2, "Apple TV Store", 11)] });
    expect(r.services.map((s) => s.name)).toEqual(["Apple TV"]);
    expect(r.stores).toEqual([]);
    expect(providerServices({ rent: [P(2, "Apple TV Store")] }).stores.map((s) => s.code)).toEqual(["itunes"]);
  });

  it("orders by TMDB's display priority, subscription before free, max three, no duplicates", () => {
    const r = providerServices({
      flatrate: [P(1899, "HBO Max", 26), P(8, "Netflix", 4), P(1825, "HBO Max Amazon Channel", 14), P(9, "Amazon Prime Video", 5)],
      ads: [P(207, "The Roku Channel", 33)],
    });
    expect(r.services.map((s) => s.name)).toEqual(["Netflix", "Prime Video", "HBO Max"]);
  });

  it("keeps unknown services under TMDB's name, and drops JustWatch's own channels", () => {
    const r = providerServices({ flatrate: [P(2285, "JustWatch TV Free", 9), P(99, "Shudder", 57)], free: [P(191, "Kanopy", 39)] });
    expect(r.services).toEqual([{ code: "shudder", name: "Shudder" }, { code: "kanopy", name: "Kanopy" }]);
  });

  it("skips live-TV bundles and cable logins (real Dune / Godfather answers, 2026-11-16)", () => {
    const dune = providerServices({ flatrate: [P(1899, "HBO Max", 26), P(2528, "YouTube TV", 42), P(0, "TNT", 90), P(0, "tru TV", 91)] });
    expect(dune.services.map((s) => s.name)).toEqual(["HBO Max"]);
    const godfather = providerServices({ flatrate: [P(257, "fuboTV", 12), P(2303, "Paramount Plus Premium", 18), P(34, "MGM Plus", 53)] });
    expect(godfather.services.map((s) => s.name)).toEqual(["Paramount+", "MGM Plus"]);
  });

  it("nothing known → nothing shown", () => {
    expect(providerServices(null)).toEqual({ services: [], stores: [] });
    expect(providerServices({})).toEqual({ services: [], stores: [] });
  });
});
