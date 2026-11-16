import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import type { PlayStatus, ServerEvent, StorageReport, UpgradeReady } from "@chill/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { boot } from "../src/boot.js";
import { loadConfig } from "../src/config.js";
import type { Ctx } from "../src/context.js";
import { resetPutioFolderCache } from "../src/context.js";
import { openDb } from "../src/db.js";
import { FAKE_NO_RELEASES_ID } from "../src/fakes/catalog.js";
import { ensureSamples } from "../src/fakes/samples.js";
import { fakeServices, type FakePutio } from "../src/fakes/services.js";
import { setLogSink } from "../src/log.js";

// End to end through the HTTP API with fake TMDB / chill.institute / put.io,
// real SQLite, real ffmpeg (alignment, cut detection, probe) and a real HTTP
// mirror download. A manual clock drives transfers and job scheduling.

const SAMPLES_DIR = path.join(os.tmpdir(), "chill-test-samples");
const HEAT = 949;

let ctx: Ctx;
let server: ServerType;
let base = "";
let t = Date.parse("2026-11-16T20:00:00Z");
const clock = { now: () => t };
const logs: string[] = [];
const events: ServerEvent[] = [];
let dataDir = "";

async function api<T>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** Advance the clock in steps, running due jobs at each step. */
async function advance(ms: number, step = 1000) {
  for (let done = 0; done < ms; done += step) {
    t += Math.min(step, ms - done);
    await ctx.jobs.tick();
  }
  await ctx.jobs.idle();
  await ctx.jobs.tick();
}

beforeAll(async () => {
  setLogSink((l) => logs.push(l));
  resetPutioFolderCache();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chill-it-"));
  const samples = await ensureSamples(SAMPLES_DIR, 60);
  const cfg = loadConfig({ CHILL_FAKE: "1", DATA_DIR: dataDir, PORT: "0", FAKE_INSTANT_S: "6", FAKE_TARGET_S: "25", RACE_AFTER_S: "90" } as NodeJS.ProcessEnv);
  const services = fakeServices({ clock, samples, quotaBytes: cfg.budgets.putio.budgetBytes, timings: cfg.fakeTimings, mediaUrl: (id) => `/fake-putio/media/${id}`, chillLatencyMs: 1 });
  ctx = await boot(cfg, { db: openDb(":memory:"), clock, services, samples });
  ctx.bus.subscribe((e) => events.push(e));
  const app = createApp(ctx);
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      base = `http://127.0.0.1:${info.port}`;
      ctx.selfBase = base;
      resolve();
    });
  });
}, 120_000);

afterAll(() => {
  server?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("catalog", () => {
  it("serves home rows, search and detail", async () => {
    const home = await api<{ hero: unknown; rows: { id: string; items: unknown[] }[] }>("GET", "/api/home");
    expect(home.hero).toBeTruthy();
    expect(home.rows.map((r) => r.id)).toEqual(expect.arrayContaining(["trending", "popular", "top-rated"]));
    const s = await api<{ tmdbId: number }[]>("GET", "/api/search?q=heat");
    expect(s[0]?.tmdbId).toBe(HEAT);
    await advance(1000); // pre-warm job runs
    const d = await api<{ title: string; availability: { state: string; instantLabel?: string } }>("GET", `/api/titles/${HEAT}`);
    expect(d.title).toBe("Heat");
    expect(d.availability.state).toBe("available");
    expect(d.availability.instantLabel).toContain("1080p HDR10 WEB-DL");
  });

  it("says so when a title has no releases", async () => {
    await api("POST", `/api/titles/${FAKE_NO_RELEASES_ID}/play`);
    await advance(1000);
    const st = await api<PlayStatus>("GET", `/api/titles/${FAKE_NO_RELEASES_ID}/play`);
    expect(st).toMatchObject({ phase: "failed", message: "No releases found" });
  });

  it("never exposes magnet links through the releases endpoint", async () => {
    const r = await api<{ instant: { release: { link?: string } }[] }>("GET", `/api/titles/${HEAT}/releases`);
    expect(r.instant.length).toBeGreaterThan(0);
    expect(r.instant.every((x) => x.release.link === undefined)).toBe(true);
  });
});

describe("play → instant → seamless upgrade → home copy", () => {
  let instantId = "";

  it("starts the fast copy and the upgrade together, and plays the fast one first", async () => {
    const st = await api<PlayStatus>("POST", `/api/titles/${HEAT}/play`);
    expect(st.phase).toBe("searching");
    await advance(2000);
    const mid = await api<PlayStatus>("GET", `/api/titles/${HEAT}/play`);
    expect(mid.phase).toBe("transferring");
    expect(mid.releaseLabel).toContain("1080p HDR10");
    const acqs = ctx.db.prepare("SELECT tier, state, release_id FROM acquisitions WHERE tmdb_id = ? ORDER BY id").all(HEAT);
    expect(acqs).toEqual([
      { tier: "instant", state: "transferring", release_id: "949-1080hdr" },
      { tier: "target", state: "transferring", release_id: "949-2160hdr" },
    ]);
    await advance(6000);
    const ready = await api<PlayStatus>("GET", `/api/titles/${HEAT}/play`);
    expect(ready.phase).toBe("ready");
    expect(ready.stream?.label).toContain("put.io");
    instantId = ready.stream!.variantId;
    // The stream endpoint serves bytes with range support.
    const res = await fetch(base + ready.stream!.url, { headers: { Range: "bytes=0-99" } });
    expect(res.status).toBe(206);
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  it("prepares an aligned, cut-synchronized switch while playing, then copies home", async () => {
    await api("POST", "/api/progress", { profileId: 1, tmdbId: HEAT, variantId: instantId, positionS: 30, durationS: 60, event: "heartbeat" });
    events.length = 0;
    await advance(20_000);
    // Keep the heartbeat alive like a real player.
    await api("POST", "/api/progress", { profileId: 1, tmdbId: HEAT, variantId: instantId, positionS: 30, durationS: 60, event: "heartbeat" });
    await advance(10_000);
    const ups = events.filter((e): e is { type: "upgrade"; upgrade: UpgradeReady } => e.type === "upgrade").map((e) => e.upgrade);
    expect(ups.length).toBeGreaterThanOrEqual(1);
    const first = ups[0]!;
    expect(first.fromVariantId).toBe(instantId);
    expect(first.mode).toBe("seamless");
    expect(first.b).toBeCloseTo(2.5, 1); // the target copy has a 2.5 s lead-in
    expect(first.a).toBeCloseTo(1, 3);
    expect(first.cutsFrom[0]).toBeCloseTo(40, 0); // the film's cut at 40 s, in the instant timeline

    const local = ctx.db.prepare("SELECT * FROM variants WHERE tmdb_id = ? AND location = 'local'").get(HEAT) as { local_path: string } | undefined;
    expect(local?.local_path).toBe("Movies/Heat (1995) {tmdb-949}/Heat (1995) {tmdb-949} - 2160p.mp4");
    expect(fs.existsSync(path.join(ctx.cfg.libraryDir, local!.local_path))).toBe(true);
    // The latest upgrade points at the local copy.
    const last = ups[ups.length - 1]!;
    expect(last.to.label).toContain("Home");
  });

  it("keeps the playing put.io copy until playback stops, then cleans staging", async () => {
    let rep = await api<StorageReport>("GET", "/api/storage");
    const putio = rep.tiers.find((x) => x.tier === "putio")!;
    expect(putio.variants.map((v) => v.id)).toEqual([instantId]); // target copy already deleted: it's home
    expect(putio.variants[0]!.status).toBe("playing");
    await api("POST", "/api/progress", { profileId: 1, tmdbId: HEAT, variantId: instantId, positionS: 45, durationS: 60, event: "stop" });
    await advance(3000);
    rep = await api<StorageReport>("GET", "/api/storage");
    expect(rep.tiers.find((x) => x.tier === "putio")!.variants).toEqual([]);
    expect(rep.tiers.find((x) => x.tier === "local")!.variants).toHaveLength(1);
    expect((ctx.svc.putio as FakePutio).state().files.filter((f) => f.fileType === "VIDEO")).toHaveLength(0);
  });

  it("resumes on the home copy at the same moment of the film", async () => {
    const st = await api<PlayStatus>("POST", `/api/titles/${HEAT}/play`);
    expect(st.phase).toBe("ready");
    expect(st.stream?.label).toContain("Home");
    // Stopped at 45 s in the instant copy = 47.5 s in the home copy, minus a 5 s rewind.
    expect(st.stream!.startAtS).toBeCloseTo(42.5, 0);
  });
});

describe("storage limits", () => {
  it("queues a transfer with a human reason when put.io has no room", async () => {
    ctx.db.prepare("INSERT INTO settings (key, value_json) VALUES ('budgets', ?)").run(JSON.stringify({ putio: { budgetBytes: 2e9 } }));
    await api("POST", "/api/titles/603/play");
    await advance(2000);
    const st = await api<PlayStatus>("GET", "/api/titles/603/play");
    expect(st.phase).toBe("queued");
    expect(st.message).toMatch(/Waiting for space|larger than the whole/);
    await api("DELETE", "/api/titles/603/play");
    expect((await api<PlayStatus>("GET", "/api/titles/603/play")).phase).toBe("idle");
    ctx.db.prepare("DELETE FROM settings WHERE key = 'budgets'").run();
  });
});

describe("secrets", () => {
  it("never logs magnets, bearer tokens or signed URL parameters", () => {
    const all = logs.join("\n");
    expect(all).not.toMatch(/magnet:\?xt/);
    expect(all).not.toMatch(/Bearer [A-Za-z0-9]{8,}/);
    expect(all).not.toMatch(/oauth_token=[^[]/);
  });
});

describe("race", () => {
  it("starts the runner-up when the fast copy stalls, and keeps whichever finishes first", async () => {
    const putio = ctx.svc.putio as FakePutio;
    // Make the first transfer for Inception crawl: patch its duration after it starts.
    await api("POST", "/api/titles/27205/play");
    await advance(2000);
    const first = putio.state().transfers.find((x) => x.name.startsWith("27205.") && x.link.endsWith("/1080hdr"))!;
    first.durationMs = 3_600_000;
    await advance(110_000, 5000);
    const acqs = ctx.db.prepare("SELECT tier, state, release_id, races FROM acquisitions WHERE tmdb_id = 27205 AND tier = 'instant' ORDER BY id").all() as { state: string; races: number | null; release_id: string }[];
    expect(acqs.length).toBe(2);
    expect(acqs[1]!.races).not.toBeNull();
    expect(acqs[1]!.state).toBe("ready");
    expect(acqs[0]!.state).toBe("cancelled");
    const st = await api<PlayStatus>("GET", "/api/titles/27205/play");
    expect(st.phase).toBe("ready");
  });
});
