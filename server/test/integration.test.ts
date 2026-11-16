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
import { fixedGate } from "../src/adapters/catalogGate.js";
import { home, watchOn } from "../src/services/catalog.js";

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

describe("audio the browser can't decode (E-AC3 in MKV)", () => {
  const PARASITE = 496243;
  it("tells the player the real codecs, and serves a compat remux with AAC audio from an exact keyframe", async () => {
    await api("POST", `/api/titles/${PARASITE}/play`);
    await advance(10_000);
    const st = await api<PlayStatus>("GET", `/api/titles/${PARASITE}/play`);
    expect(st.phase).toBe("ready");
    expect(st.stream).toMatchObject({ audioCodec: "eac3", container: "mkv", videoCodec: "h264" });

    const start = await api<{ start: number; url: string }>("GET", `/api/stream/${st.stream!.variantId}/compat-start?t=31`);
    expect(start.start).toBe(30); // 2 s GOP: the keyframe at or before 31 s
    const { probe } = await import("../src/media/ffmpeg.js");
    const p = await probe(base + start.url);
    expect(p.audioCodec).toBe("aac");
    expect(p.videoCodec).toBe("h264"); // copied, not re-encoded
  });
});

describe("the home library is a cache of what's on now", () => {
  const PARASITE = 496243;
  type LocalRow = { id: string; tmdb_id: number; local_path: string };
  const local = () => ctx.db.prepare("SELECT id, tmdb_id, local_path FROM variants WHERE location = 'local'").all() as LocalRow[];

  it("starting a title clears other titles' home copies (but a My List prefetch doesn't)", async () => {
    await advance(60_000, 5000); // let Parasite finish copying home
    const before = local().filter((v) => v.tmdb_id !== HEAT);
    expect(before.map((v) => v.tmdb_id)).toContain(PARASITE);

    await api("POST", "/api/my-list/603");
    expect(local().filter((v) => v.tmdb_id !== HEAT).map((v) => v.id)).toEqual(expect.arrayContaining(before.map((v) => v.id)));
    t += 1000;

    // Heat's own home copy went when 603 started (storage limits, above); this Play re-acquires it.
    await api("POST", `/api/titles/${HEAT}/play`);
    expect(local().filter((v) => v.tmdb_id !== HEAT)).toEqual([]);
    for (const v of before) expect(fs.existsSync(path.join(ctx.cfg.libraryDir, v.local_path))).toBe(false);
    const reasons = ctx.db.prepare("SELECT DISTINCT reason FROM storage_events WHERE action = 'evict' AND tier = 'local'").pluck().all();
    expect(reasons).toContain(`cache: started ${HEAT}`);
  });

  it("lists what was played or fetched under Recent, newest first, even once evicted", async () => {
    const home = await api<{ rows: { id: string; title: string; items: { tmdbId: number }[] }[] }>("GET", "/api/home");
    expect(home.rows.find((r) => r.id === "ready")).toBeUndefined();
    const recent = home.rows.find((r) => r.id === "recent")!;
    expect(recent.title).toBe("Recent");
    const ids = recent.items.map((x) => x.tmdbId);
    expect(ids.slice(0, 2)).toEqual([HEAT, 603]); // the latest Play, then the My List prefetch
    expect(ids).toEqual(expect.arrayContaining([HEAT, PARASITE, 27205]));
    expect(ids.indexOf(PARASITE)).toBeLessThan(ids.indexOf(27205));
    expect(ids).not.toContain(FAKE_NO_RELEASES_ID); // that Play failed
  });
});

describe("subtitles", () => {
  const PARASITE = 496243;
  type Stream = NonNullable<PlayStatus["stream"]>;
  const stream = async (id: number) => (await api<PlayStatus>("GET", `/api/titles/${id}/play`)).stream as Stream;

  it("a Korean film starts with English on; its put.io copy lists put.io's tracks", async () => {
    await api("POST", `/api/titles/${PARASITE}/play`);
    await advance(10_000);
    const s = await stream(PARASITE);
    expect(s.subtitles.map((t) => t.language).sort()).toEqual(["en", "es"]);
    const en = s.subtitles.find((t) => t.language === "en")!;
    expect(s.subtitleId).toBe(en.id);
    const vtt = await (await fetch(base + en.url)).text();
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:00:01.000 --> 00:00:04.000\n[EN] Line 1 · 0:01");
  });

  it("shifts cues for a compat stream that starts mid-film", async () => {
    const s = await stream(PARASITE);
    const en = s.subtitles.find((t) => t.language === "en")!;
    const vtt = await (await fetch(`${base}${en.url}?shift=-30`)).text();
    // Film 29–32 s → 0 (clamped) to 2 s on the compat clock.
    expect(vtt.split("\n").slice(2, 4)).toEqual(["00:00:00.000 --> 00:00:02.000", "[EN] Line 8 · 0:29"]);
  });

  it("an English film starts with none; its home copy kept put.io's English as a Plex-style sidecar", async () => {
    await api("POST", `/api/titles/${HEAT}/play`);
    await advance(40_000); // fast copy, 4K copy, then the copy home
    const s = await stream(HEAT);
    expect(s.label).toContain("Home");
    expect(s.subtitleId).toBeNull();
    expect(s.subtitles.map((t) => t.label)).toEqual(["English"]); // es not saved (not wanted); embedded en duplicates the sidecar
    const local = ctx.db.prepare("SELECT local_path FROM variants WHERE tmdb_id = ? AND location = 'local'").pluck().get(HEAT) as string;
    // Replaying a cleaned-up title still upgrades to 4K (regression: the "same
    // release as last time" preference used to pin the upgrade to the 1080p copy).
    expect(local).toMatch(/2160p\.mp4$/);
    expect(fs.existsSync(path.join(ctx.cfg.libraryDir, local.replace(/\.mp4$/, ".en.srt")))).toBe(true);
    const vtt = await (await fetch(base + s.subtitles[0]!.url)).text();
    // The home copy is the 4K one: its subtitles are in its own timeline (1 s + 2.5 s lead-in).
    expect(vtt).toContain("00:00:03.500 --> 00:00:06.500\n[EN] Line 1 · 0:01");
  });

  it("extracts subtitle tracks embedded in a file", async () => {
    const { extractSubtitle, probe } = await import("../src/media/ffmpeg.js");
    const samples = await ensureSamples(SAMPLES_DIR, 60);
    const p = await probe(samples.target);
    expect(p.subtitles).toMatchObject([{ index: 0, codec: "mov_text", text: true, language: "eng" }]);
    expect(await extractSubtitle(samples.target, 0)).toContain("EMBEDDED [EN] Line 1 · 0:01");
  });

  it("remembers a choice per title, including off", async () => {
    await api("POST", `/api/titles/${HEAT}/subtitle`, { language: "en" });
    const heat = await stream(HEAT);
    expect(heat.subtitleId).toBe(heat.subtitles[0]!.id);
    await api("POST", `/api/titles/${PARASITE}/subtitle`, { language: null });
    expect((await stream(PARASITE)).subtitleId).toBeNull();
  });

  it("deleting a home copy deletes its sidecars and subtitle records", async () => {
    const v = ctx.db.prepare("SELECT id, local_path FROM variants WHERE tmdb_id = ? AND location = 'local'").get(HEAT) as { id: string; local_path: string };
    await api("POST", `/api/variants/${v.id}/evict`);
    expect(fs.existsSync(path.join(ctx.cfg.libraryDir, v.local_path.replace(/\.mp4$/, ".en.srt")))).toBe(false);
    expect(ctx.db.prepare("SELECT COUNT(*) FROM subtitles WHERE variant_id = ?").pluck().get(v.id)).toBe(0);
  });
});

describe("where a film streams", () => {
  it("names services from the releases' source tags, and the playing copy's service", async () => {
    const d = await api<{ availability: { state: string; services?: { name: string }[] } }>("GET", `/api/titles/${HEAT}`);
    expect(d.availability.services?.map((s) => s.name)).toEqual(["Netflix"]); // fake: three NF releases; one small HMAX one is noise
    await api("POST", `/api/titles/${HEAT}/play`);
    await advance(10_000);
    const st = await api<PlayStatus>("GET", `/api/titles/${HEAT}/play`);
    expect(st.stream?.label).toMatch(/· Netflix · (put\.io|Home)$/);
  });

  type WithOn = { watchOn: { source: string; region: string; services: { name: string }[]; stores: { name: string }[] } | null };
  it("with TMDB on, says where it streams now (JustWatch data), one chip per service", async () => {
    const dune = await api<WithOn>("GET", "/api/titles/438631");
    expect(dune.watchOn).toMatchObject({ source: "tmdb", region: "US", stores: [] });
    expect(dune.watchOn!.services.map((s) => s.name)).toEqual(["HBO Max"]); // "HBO Max" + "HBO Max Amazon Channel" → once
    const godfather = await api<WithOn>("GET", "/api/titles/238");
    expect(godfather.watchOn!.services.map((s) => s.name)).toEqual(["Paramount+", "The Roku Channel"]); // subscription, then ad-supported
  });

  it("lists storefronts only when nothing streams it", async () => {
    const parasite = await api<WithOn>("GET", "/api/titles/496243");
    expect(parasite.watchOn!.services).toEqual([]);
    expect(parasite.watchOn!.stores.map((s) => s.name)).toEqual(["Prime Video", "Apple TV Store"]);
  });

  it("falls back to the release tags when TMDB has nothing, or TMDB is off", async () => {
    expect((await api<WithOn>("GET", `/api/titles/${HEAT}`)).watchOn).toBeNull();
    const off = { ...ctx, catalog: fixedGate("cinemeta") };
    expect(await watchOn(off, 438631)).toBeNull();
    expect(await watchOn(ctx, 438631)).not.toBeNull();
  });
});

describe("home rows follow what a profile watches", () => {
  type Home = { rows: { id: string; title: string; items: { tmdbId: number }[] }[] };
  it("Horror rises to the first genre row, and 'Because you watched' skips what was seen", async () => {
    const p = await api<{ id: number }>("POST", "/api/profiles", { name: "Horror fan" });
    const before = await api<Home>("GET", `/api/home?profile=${p.id}`);
    const genres = (h: Home) => h.rows.filter((r) => r.id.startsWith("genre-")).map((r) => r.id);
    expect(genres(before)[0]).toBe("genre-action");
    expect(before.rows.some((r) => r.id.startsWith("because"))).toBe(false);

    const seen = [348, 578, 419430]; // Alien, Jaws, Get Out
    for (const tmdbId of seen) {
      await api("POST", "/api/progress", { profileId: p.id, tmdbId, variantId: "none", positionS: 100, durationS: 100, event: "end" });
      await advance(1000);
    }
    const after = await api<Home>("GET", `/api/home?profile=${p.id}`);
    expect(genres(after)[0]).toBe("genre-horror");
    const because = after.rows.filter((r) => r.id.startsWith("because"));
    expect(because[0]!.title).toBe("Because you watched Get Out");
    const shown = because.flatMap((r) => r.items.map((i) => i.tmdbId));
    expect(shown.some((id) => seen.includes(id))).toBe(false);
    expect(new Set(shown).size).toBe(shown.length); // the two rows never repeat a film
    expect(because.length).toBe(2); // TMDB on: a row for each of the two latest films
    // TMDB off (Cinemeta has no real recommendations): one row at most.
    const off = await home({ ...ctx, catalog: fixedGate("cinemeta") }, p.id);
    expect(off.rows.filter((r) => r.id.startsWith("because")).length).toBe(1);
    // Another profile's home is untouched.
    expect(genres(await api<Home>("GET", "/api/home?profile=1"))[0]).not.toBe("genre-horror");
  });
});

describe("TV shows", () => {
  const ST = "tt4574334"; // Stranger Things (fake: Netflix, 2 seasons × 3 episodes)
  type Ep = { tmdbId: number; season: number; episode: number; name: string; progress: number | null; watched: boolean };
  type Show = { title: string; seasons: { number: number }[]; next: { tmdbId: number; season: number; episode: number; resume: boolean } | null };

  it("lists shows by service, with search", async () => {
    const home = await api<{ rows: { id: string; title: string; items: { showId?: string; kind?: string }[] }[] }>("GET", "/api/shows");
    const nf = home.rows.find((r) => r.id === "tv-netflix")!;
    expect(nf.title).toBe("Popular on Netflix");
    expect(nf.items[0]).toMatchObject({ kind: "show", showId: ST });
    expect(home.rows.map((r) => r.id)).toEqual(expect.arrayContaining(["tv-hbo_max", "tv-amc_plus"]));
    const found = await api<{ showId: string }[]>("GET", "/api/shows/search?q=stranger");
    expect(found.map((s) => s.showId)).toContain(ST);
  });

  it("opens a show with seasons, episodes, and 'play S1 E1'", async () => {
    const show = await api<Show>("GET", `/api/shows/${ST}`);
    expect(show.title).toBe("Stranger Things");
    expect(show.seasons.map((s) => s.number)).toEqual([1, 2]);
    expect(show.next).toMatchObject({ season: 1, episode: 1, resume: false });
    const eps = await api<Ep[]>("GET", `/api/shows/${ST}/seasons/1`);
    expect(eps.map((e) => e.episode)).toEqual([1, 2, 3]);
    expect(eps.every((e) => e.tmdbId < 0)).toBe(true);
    expect(eps[0]!.tmdbId).toBe(show.next!.tmdbId);
  });

  it("plays an episode end to end: chill's pick, one copy (no 4K upgrade), home under TV Shows/", async () => {
    const [e1] = await api<Ep[]>("GET", `/api/shows/${ST}/seasons/1`);
    await api("POST", `/api/titles/${e1!.tmdbId}/play`);
    await advance(15_000);
    const st = await api<PlayStatus>("GET", `/api/titles/${e1!.tmdbId}/play`);
    expect(st.phase).toBe("ready");
    expect(st.stream?.label).toContain("1080p WEB-DL");
    expect(ctx.db.prepare("SELECT COUNT(*) FROM acquisitions WHERE tmdb_id = ? AND tier = 'target'").pluck().get(e1!.tmdbId)).toBe(0);
    const local = ctx.db.prepare("SELECT local_path FROM variants WHERE tmdb_id = ? AND location = 'local'").pluck().get(e1!.tmdbId) as string;
    expect(local).toBe("TV Shows/Stranger Things (2016)/Season 01/Stranger Things (2016) - S01E01 - Chapter 11.mp4");
    const d = await api<{ title: string; tagline: string }>("GET", `/api/titles/${e1!.tmdbId}`);
    expect(d).toMatchObject({ title: "Stranger Things · S1 E1", tagline: "Chapter 11" });
  });

  it("resumes from Continue Watching, then moves on to the next episode", async () => {
    const [e1, e2] = await api<Ep[]>("GET", `/api/shows/${ST}/seasons/1`);
    const v = ctx.db.prepare("SELECT id FROM variants WHERE tmdb_id = ? ORDER BY location = 'local' DESC").pluck().get(e1!.tmdbId) as string;
    await api("POST", "/api/progress", { profileId: 1, tmdbId: e1!.tmdbId, variantId: v, positionS: 60, durationS: 180, event: "stop" });
    const home = await api<{ rows: { id: string; items: { tmdbId: number; kind?: string; subtitle?: string }[] }[] }>("GET", "/api/home");
    const cont = home.rows.find((r) => r.id === "continue")!.items.find((i) => i.kind === "episode");
    expect(cont).toMatchObject({ tmdbId: e1!.tmdbId, subtitle: "S1 E1 · Chapter 11" });
    expect((await api<Show>("GET", `/api/shows/${ST}`)).next).toMatchObject({ tmdbId: e1!.tmdbId, resume: true });

    await api("POST", "/api/progress", { profileId: 1, tmdbId: e1!.tmdbId, variantId: v, positionS: 179, durationS: 180, event: "end" });
    expect(await api("GET", `/api/titles/${e1!.tmdbId}/next`)).toMatchObject({ tmdbId: e2!.tmdbId, season: 1, episode: 2 });
    expect((await api<Show>("GET", `/api/shows/${ST}`)).next).toMatchObject({ tmdbId: e2!.tmdbId, resume: false });
  });

  it("rolls from a season finale into the next season, and ends after the last episode", async () => {
    const s1 = await api<Ep[]>("GET", `/api/shows/${ST}/seasons/1`);
    const s2 = await api<Ep[]>("GET", `/api/shows/${ST}/seasons/2`);
    expect(await api("GET", `/api/titles/${s1[2]!.tmdbId}/next`)).toMatchObject({ tmdbId: s2[0]!.tmdbId, season: 2, episode: 1 });
    expect(await api("GET", `/api/titles/${s2[2]!.tmdbId}/next`)).toBeNull();
    expect(await api("GET", `/api/titles/${HEAT}/next`)).toBeNull(); // films have no next
  });

  it("prefetching the next episode doesn't clear the one being watched", async () => {
    const [e1, e2] = await api<Ep[]>("GET", `/api/shows/${ST}/seasons/1`);
    await api("POST", `/api/titles/${e2!.tmdbId}/prefetch`);
    await advance(15_000);
    expect((await api<PlayStatus>("GET", `/api/titles/${e2!.tmdbId}/play`)).phase).toBe("ready");
    expect(ctx.db.prepare("SELECT COUNT(*) FROM variants WHERE tmdb_id = ? AND location = 'local'").pluck().get(e1!.tmdbId)).toBe(1);
  });
});
