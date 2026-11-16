import { describe, expect, it } from "vitest";
import { fixedGate, gatedCatalog } from "../src/adapters/catalogGate.js";
import type { TmdbApi, TmdbDetail, TmdbMovie } from "../src/adapters/types.js";
import { HttpError } from "../src/http.js";

const movie = (id: number, title: string): TmdbMovie => ({ id, title, poster_path: `/${title}.jpg`, backdrop_path: null });

function stub(name: string, over: Partial<TmdbApi> = {}): TmdbApi & { calls: string[] } {
  const calls: string[] = [];
  const api: TmdbApi & { calls: string[] } = {
    calls,
    async list() { calls.push("list"); return [movie(1, name)]; },
    async discover() { calls.push("discover"); return { results: [movie(2, name)], totalPages: 1 }; },
    async search() { calls.push("search"); return [movie(3, name)]; },
    async movie(id) { calls.push("movie"); return { ...movie(id, name), runtime: 100, genres: [], imdb_id: "tt0113277" } as TmdbDetail; },
    async byImdb() { calls.push("byImdb"); return movie(4, name); },
    async genres() { calls.push("genres"); return [{ id: 28, name }]; },
    async image(_s, p) { calls.push(`image:${p}`); return { body: new Uint8Array(), contentType: "image/jpeg" }; },
    ...over,
  };
  return api;
}

const memIds = () => {
  const m = new Map<number, string>();
  return { m, store: { imdbFor: (id: number) => m.get(id) ?? null, remember: (id: number, imdb: string) => void m.set(id, imdb) } };
};

describe("catalog gate: TMDB only when configured and the key works", () => {
  it("uses TMDB once the key checks out", async () => {
    const tmdb = Object.assign(stub("tmdb"), { verify: async () => {} });
    const { api, gate } = gatedCatalog(tmdb, stub("cinemeta"), memIds().store);
    expect(await gate.verify()).toBe("ok");
    expect(gate.tmdb).toBe(true);
    expect(gate.source()).toBe("tmdb");
    expect((await api.list("trending"))[0]!.title).toBe("tmdb");
  });

  it("stays on Cinemeta, with TMDB features off, when the key is rejected", async () => {
    const tmdb = Object.assign(stub("tmdb"), { verify: async () => Promise.reject(new HttpError(401, "Invalid API key", "TMDB")) });
    const cine = stub("cinemeta");
    const { api, gate } = gatedCatalog(tmdb, cine, memIds().store);
    expect(await gate.verify()).toBe("rejected");
    expect(gate.tmdb).toBe(false);
    expect(gate.source()).toBe("cinemeta");
    expect((await api.search("heat"))[0]!.title).toBe("cinemeta");
    expect(tmdb.calls).toEqual([]);
    expect(gate.status().reason).toMatch(/401/);
  });

  it("treats TMDB being down as unreachable (not a bad key), and recovers on a later check", async () => {
    let up = false;
    let t = 0;
    const tmdb = Object.assign(stub("tmdb"), { verify: async () => (up ? undefined : Promise.reject(new Error("ECONNRESET"))) });
    const { api, gate } = gatedCatalog(tmdb, stub("cinemeta"), memIds().store, () => t);
    expect(await gate.verify()).toBe("unreachable");
    expect((await api.list("popular"))[0]!.title).toBe("cinemeta");
    up = true;
    t += 5 * 60_000;
    await api.list("popular"); // too soon to re-check
    expect(gate.status().state).toBe("unreachable");
    t += 15 * 60_000;
    await api.list("popular"); // triggers a background re-check
    await gate.verify();
    expect(gate.status().state).toBe("ok");
    expect((await api.list("popular"))[0]!.title).toBe("tmdb");
  });

  it("falls back mid-flight when TMDB starts refusing the key", async () => {
    const tmdb = Object.assign(stub("tmdb", { discover: async () => Promise.reject(new HttpError(401, "", "TMDB")) }), { verify: async () => {} });
    const { api, gate } = gatedCatalog(tmdb, stub("cinemeta"), memIds().store);
    await gate.verify();
    const r = await api.discover({ genre: 28 });
    expect(r.results[0]!.title).toBe("cinemeta");
    expect(gate.tmdb).toBe(false);
  });

  it("does not hide real TMDB errors behind the fallback", async () => {
    const tmdb = Object.assign(stub("tmdb", { search: async () => Promise.reject(new HttpError(500, "", "TMDB")) }), { verify: async () => {} });
    const { api, gate } = gatedCatalog(tmdb, stub("cinemeta"), memIds().store);
    await gate.verify();
    await expect(api.search("x")).rejects.toThrow(/500/);
    expect(gate.tmdb).toBe(true);
  });

  it("remembers IMDb ids from TMDB details, so Cinemeta can answer for them later", async () => {
    const ids = memIds();
    const tmdb = Object.assign(stub("tmdb"), { verify: async () => {} });
    const { api, gate } = gatedCatalog(tmdb, stub("cinemeta"), ids.store);
    await gate.verify();
    await api.movie(949);
    expect(ids.m.get(949)).toBe("tt0113277");
  });

  it("routes images by where the path came from, whatever the key's state", async () => {
    const tmdb = Object.assign(stub("tmdb"), { verify: async () => Promise.reject(new HttpError(401, "", "TMDB")) });
    const cine = stub("cinemeta");
    const { api, gate } = gatedCatalog(tmdb, cine, memIds().store);
    await gate.verify();
    await api.image("w342", "/abc.jpg");
    await api.image("w342", "/mh/poster/tt0113277");
    expect(tmdb.calls).toEqual(["image:/abc.jpg"]);
    expect(cine.calls).toEqual(["image:/mh/poster/tt0113277"]);
  });

  it("fixed gates: no token means Cinemeta with TMDB features off; demo mode counts as TMDB", () => {
    expect(fixedGate("cinemeta").tmdb).toBe(false);
    expect(fixedGate("cinemeta").status().state).toBe("off");
    expect(fixedGate("fake").tmdb).toBe(true);
    expect(fixedGate("fake").source()).toBe("fake");
  });
});
