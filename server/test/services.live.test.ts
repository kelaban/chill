import { describe, expect, it } from "vitest";
import { chillClient } from "../src/adapters/chill.js";
import { putioClient } from "../src/adapters/putio.js";
import { tmdbClient } from "../src/adapters/tmdb.js";
import { HttpError } from "../src/http.js";
import { rank } from "../src/domain/ranker.js";

// `npm run test:live` — real TMDB, chill.institute and put.io. Tokens come from
// env vars, or are injected by the cloud dev environment's proxy (then any
// placeholder works). A suite whose service answers 401 skips itself.
//
// The put.io suite transfers *Sintel* (Blender Foundation, CC-BY, ~130 MB) into
// a `chill-test` folder and deletes it afterwards.
//
// OPT-IN ONLY. put.io flagged the dev environment's IP after repeated test
// transfers, and both put.io and chill.institute rate-limit (HTTP 429). Day to
// day, rely on the fakes and the recorded fixtures in test/fixtures/chill.
// Run a suite only deliberately: LIVE_CHILL=1 and/or LIVE_PUTIO=1.
const LIVE_CHILL = process.env.LIVE_CHILL === "1";
const LIVE_PUTIO = process.env.LIVE_PUTIO === "1";

const tok = (k: string) => process.env[k] || "placeholder-proxy-injects-the-real-one";
const unauthorized = (e: unknown) => e instanceof HttpError && (e.status === 401 || e.status === 403);

const SINTEL = "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=wss%3A%2F%2Ftracker.openwebtorrent.com";

describe("TMDB (live)", () => {
  it("searches and fetches details", async (t) => {
    const tmdb = tmdbClient(tok("TMDB_TOKEN"));
    const r = await tmdb.search("Heat").catch((e) => (unauthorized(e) ? t.skip() : Promise.reject(e)));
    expect(r!.some((m) => m.id === 949)).toBe(true);
    const d = await tmdb.movie(949);
    expect(d.imdb_id).toBe("tt0113277");
  });
});

describe.skipIf(!LIVE_CHILL)("chill.institute (live, opt-in: LIVE_CHILL=1)", () => {
  it("returns parsed releases the ranker can use", async (t) => {
    const chill = chillClient(tok("CHILL_TOKEN"));
    const rs = await chill.search("Heat 1995").catch((e) => (unauthorized(e) ? t.skip() : Promise.reject(e)));
    expect(rs!.length).toBeGreaterThan(0);
    const withInfo = rs!.filter((r) => r.info);
    expect(withInfo.length / rs!.length).toBeGreaterThan(0.5);
    const ranked = rank({ title: "Heat", year: 1995, imdbId: "tt0113277" }, rs!);
    console.log(`chill: ${rs!.length} results, ${ranked.instant.length} instant candidates, ${ranked.target.length} target`);
  });
});

describe.skipIf(!LIVE_PUTIO)("put.io (live, opt-in: LIVE_PUTIO=1)", () => {
  it("transfers Sintel, resolves a download URL, and cleans up", { timeout: 600_000 }, async (t) => {
    const putio = putioClient(tok("PUTIO_TOKEN"));
    const disk = await putio.accountDisk().catch((e) => (unauthorized(e) ? t.skip() : Promise.reject(e)));
    expect(disk!.size).toBeGreaterThan(0);
    const folder = await putio.ensureFolder("chill-test");
    const tr = await putio.addTransfer(SINTEL, folder);
    const started = Date.now();
    let cur = tr;
    try {
      while (cur.status !== "COMPLETED" && cur.status !== "SEEDING" && Date.now() - started < 540_000) {
        if (cur.status === "ERROR") throw new Error(`transfer error: ${cur.error}`);
        await new Promise((r) => setTimeout(r, 5000));
        cur = await putio.getTransfer(tr.id);
      }
      console.log(`put.io: Sintel ready in ${Math.round((Date.now() - started) / 1000)} s`);
      expect(cur.fileId).toBeTruthy();
      const url = await putio.downloadUrl(cur.fileId!).catch(async () => {
        const kids = await putio.listFiles(cur.fileId!);
        const v = kids.find((k) => k.fileType === "VIDEO");
        return putio.downloadUrl(v!.id);
      });
      expect(url).toMatch(/^https:\/\//);
    } finally {
      await putio.cancelTransfers([tr.id]).catch(() => {});
      await putio.deleteFiles([folder]);
    }
  });
});

describe("Cinemeta catalog (live, keyless)", () => {
  it("searches, lists, and resolves details with TMDB ids", async () => {
    const { cinemetaClient } = await import("../src/adapters/cinemeta.js");
    const map = new Map<number, string>();
    const c = cinemetaClient({ imdbFor: (id) => map.get(id) ?? null, remember: (id, imdb) => void map.set(id, imdb) });
    const hits = await c.search("Heat");
    const heat = hits.find((m) => m.id === 949);
    expect(heat?.title).toBe("Heat");
    const d = await c.movie(949);
    expect(d.imdb_id).toBe("tt0113277");
    expect(d.runtime).toBeGreaterThan(150);
    expect(d.original_language).toBe("en");
    const top = await c.list("trending");
    expect(top.length).toBeGreaterThan(20);
    const g = await c.discover({ genre: 878 });
    expect(g.results.length).toBeGreaterThan(20);
    const img = await c.image("w342", heat!.poster_path!);
    expect(img.body.byteLength).toBeGreaterThan(5000);
  });
});

describe.skipIf(!LIVE_CHILL)("chill.institute TV (live, opt-in: LIVE_CHILL=1)", () => {
  it("lists shows, a show's seasons, a season's episodes, and an episode download", async () => {
    const chill = chillClient(tok("CHILL_TOKEN"));
    const shows = await chill.tvShows("NETFLIX");
    expect(shows.length).toBeGreaterThan(0);
    const d = await chill.tvShowDetail(shows[0]!.imdbId);
    expect(d.seasons.length).toBeGreaterThan(0);
    const s = d.seasons.find((x) => x.seasonNumber > 0)!;
    const eps = await chill.tvSeason(d.show.imdbId, s.seasonNumber);
    expect(eps.length).toBeGreaterThan(0);
    const dl = await chill.tvEpisodeDownload(d.show.imdbId, s.seasonNumber, eps[0]!.episodeNumber);
    console.log(`chill TV: ${shows.length} Netflix shows; ${d.show.title} S${s.seasonNumber}: ${eps.length} episodes; pick: ${dl?.rawTitle ?? "none"}`);
  });
});
