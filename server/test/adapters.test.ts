import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chillClient, mapSearchResult } from "../src/adapters/chill.js";
import { download } from "../src/services/downloader.js";

// A Connect-JSON SearchResult as chill.institute's v4 API returns it (int64 as
// strings, lowerCamelCase). Synthetic until `npm run test:live` records real ones.
const RESULT = {
  id: "rel-123",
  title: "Heat.1995.2160p.UHD.BluRay.x265.HDR.DTS-HD.MA.5.1-GROUP",
  indexer: "idx",
  link: "magnet:?xt=urn:btih:abc",
  imdbId: "tt0113277",
  peers: "40",
  seeders: "33",
  size: "21474836480",
  releaseInfo: { title: "Heat", year: 1995, resolution: "2160p", quality: "BluRay", codec: "x265", hdr: "HDR", audio: "DTS-HD MA 5.1", threeD: false },
};

describe("chill.institute mapping", () => {
  it("maps Connect JSON (camelCase, int64 strings)", () => {
    const r = mapSearchResult(RESULT)!;
    expect(r).toMatchObject({ id: "rel-123", seeders: 33, peers: 40, sizeBytes: 21474836480, imdbId: "tt0113277" });
    expect(r.info).toMatchObject({ title: "Heat", year: 1995, resolution: "2160p", hdr: "HDR" });
  });
  it("also accepts proto field names (snake_case)", () => {
    const r = mapSearchResult({ ...RESULT, imdbId: undefined, imdb_id: "tt1", releaseInfo: undefined, release_info: { title: "X", three_d: true } })!;
    expect(r.imdbId).toBe("tt1");
    expect(r.info?.threeD).toBe(true);
  });
  it("drops rows without an id or link", () => {
    expect(mapSearchResult({ ...RESULT, link: "" })).toBeNull();
  });
});

describe("chill.institute client", () => {
  let down: http.Server, up: http.Server;
  const seen: { auth?: string; path?: string; body?: string }[] = [];
  let downUrl = "", upUrl = "";
  beforeAll(async () => {
    down = http.createServer((_q, s) => s.writeHead(503).end());
    up = http.createServer((q, s) => {
      let body = "";
      q.on("data", (d) => (body += d));
      q.on("end", () => {
        seen.push({ auth: q.headers.authorization, path: q.url, body });
        s.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ query: "heat 1995", results: [RESULT] }));
      });
    });
    await Promise.all([new Promise<void>((r) => down.listen(0, "127.0.0.1", r)), new Promise<void>((r) => up.listen(0, "127.0.0.1", r))]);
    downUrl = `http://127.0.0.1:${(down.address() as any).port}`;
    upUrl = `http://127.0.0.1:${(up.address() as any).port}`;
  });
  afterAll(() => (down.close(), up.close()));

  it("fails over from a 503 host and sends the bearer + Connect path", async () => {
    const c = chillClient("tok-123", [downUrl, upUrl]);
    const rs = await c.search("heat 1995");
    expect(rs).toHaveLength(1);
    expect(seen[0]).toMatchObject({ auth: "Bearer tok-123", path: "/v4/chill.v4.UserService/Search", body: JSON.stringify({ query: "heat 1995" }) });
  });
});

describe("downloader", () => {
  let srv: http.Server;
  let url = "";
  const data = Buffer.alloc(20_000_000); // > 8 MB so it splits into several segments
  for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 0xff;
  let failOnce = true;
  beforeAll(async () => {
    srv = http.createServer((q, s) => {
      const m = /bytes=(\d+)-(\d*)/.exec(q.headers.range ?? "");
      const start = m ? Number(m[1]) : 0;
      const end = m?.[2] ? Number(m[2]) : data.length - 1;
      s.writeHead(m ? 206 : 200, { "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${data.length}`, "Accept-Ranges": "bytes" });
      if (failOnce && start > 0 && end - start > 1000) {
        failOnce = false;
        s.write(data.subarray(start, start + 1000));
        s.destroy(); // drop the connection mid-segment
        return;
      }
      s.end(data.subarray(start, end + 1));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(srv.address() as any).port}/file.bin`;
  });
  afterAll(() => srv.close());

  it("recovers from a dropped connection within the same download", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chill-dl-"));
    const dest = path.join(dir, "out.bin");
    const { bytes } = await download(url, dest, { connections: 4 });
    expect(failOnce).toBe(false); // the server really did drop one
    expect(bytes).toBe(data.length);
    expect(fs.readFileSync(dest).equals(data)).toBe(true);
    expect(fs.existsSync(`${dest}.json`)).toBe(false);
  });

  it("resumes from its checkpoint after being stopped", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chill-dl-"));
    const dest = path.join(dir, "out.bin");
    const ac = new AbortController();
    let seenBytes = 0;
    await expect(
      download(url, dest, { connections: 4, signal: ac.signal, maxBytesPerSec: 2_000_000, onProgress: (d) => ((seenBytes = d), d > 500_000 && ac.abort()) }),
    ).rejects.toThrow();
    expect(fs.existsSync(`${dest}.json`)).toBe(true);
    const ck = JSON.parse(fs.readFileSync(`${dest}.json`, "utf8")) as { segments: { done: number }[] };
    const resumedFrom = ck.segments.reduce((s, g) => s + g.done, 0);
    expect(resumedFrom).toBeGreaterThan(0);
    let firstProgress = -1;
    const { bytes } = await download(url, dest, { connections: 4, onProgress: (d) => firstProgress < 0 && (firstProgress = d) });
    expect(firstProgress).toBeGreaterThan(resumedFrom); // continued, didn't restart
    expect(bytes).toBe(data.length);
    expect(fs.readFileSync(dest).equals(data)).toBe(true);
    void seenBytes;
  });
});
