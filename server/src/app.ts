import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { HandoffTelemetry, ServerEvent } from "@chill/shared";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { Ctx } from "./context.js";
import { isWatched } from "./domain/playback.js";
import { log } from "./log.js";
import { cancel, play, playStatus } from "./services/acquirer.js";
import * as catalog from "./services/catalog.js";
import { contentTypeFor, mediaInput } from "./services/media.js";
import { availability, ranking } from "./services/releases.js";
import { evictVariant, publishStorage, report, variant } from "./services/storage.js";
import { pendingUpgrade } from "./services/upgrade.js";
import { compatResponse, compatStart } from "./services/compat.js";
import { saveChoice, vttFor } from "./services/subtitles.js";
import { isEpisode, nextEpisode, searchShows, seasonEpisodes, showDetail, showsHome } from "./services/shows.js";

const hlsCache = new Map<string, { url: string; until: number }>();

const int = (s: string | undefined, d: number) => {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
};

/** Range-aware file response (local library, fake put.io media). */
function serveFile(c: Context, file: string): Response {
  const stat = fs.statSync(file);
  const type = contentTypeFor(file);
  const range = c.req.header("range");
  const headers: Record<string, string> = { "Accept-Ranges": "bytes", "Content-Type": type, "Cache-Control": "no-store" };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m?.[1] ? Number(m[1]) : 0;
    let end = m?.[2] ? Number(m[2]) : stat.size - 1;
    if (!m?.[1] && m?.[2]) (start = stat.size - Number(m[2])), (end = stat.size - 1);
    if (start >= stat.size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });
    end = Math.min(end, stat.size - 1);
    const body = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
    return new Response(body, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": String(end - start + 1) } });
  }
  if (c.req.method === "HEAD") return new Response(null, { status: 200, headers: { ...headers, "Content-Length": String(stat.size) } });
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, { status: 200, headers: { ...headers, "Content-Length": String(stat.size) } });
}

export function createApp(ctx: Ctx) {
  const app = new Hono();
  const profileOf = (c: Context) => int(c.req.query("profile"), 1);

  app.onError((err, c) => {
    const status = (err as { status?: number }).status;
    log.error("request failed", { path: c.req.path, err });
    return c.json({ error: err.message }, status === 404 ? 404 : 500);
  });

  app.get("/api/health", (c) => {
    const { state, checkedAt } = ctx.catalog.status();
    return c.json({ ok: true, fake: ctx.cfg.fake, catalog: ctx.catalog.source(), tmdb: { state, checkedAt: checkedAt ? new Date(checkedAt).toISOString() : null }, commit: ctx.cfg.commit });
  });

  // ---- profiles
  app.get("/api/profiles", (c) => c.json(ctx.db.prepare("SELECT id, name, color FROM profiles ORDER BY id").all()));
  app.post("/api/profiles", async (c) => {
    const { name, color } = await c.req.json<{ name: string; color?: string }>();
    if (!name?.trim()) return c.json({ error: "name required" }, 400);
    const r = ctx.db.prepare("INSERT INTO profiles (name, color, created_at) VALUES (?, ?, ?)").run(name.trim().slice(0, 30), color ?? "#46d369", ctx.clock.now());
    return c.json({ id: Number(r.lastInsertRowid), name: name.trim(), color: color ?? "#46d369" }, 201);
  });

  // ---- catalog
  app.get("/api/home", async (c) => c.json(await catalog.home(ctx, profileOf(c))));
  app.get("/api/genres", async (c) => c.json(await catalog.genres(ctx)));
  app.get("/api/discover", async (c) => {
    const q = c.req.query();
    return c.json(
      await catalog.discover(ctx, {
        genre: q.genre ? Number(q.genre) : undefined,
        sort: (q.sort as any) || undefined,
        yearFrom: q.yearFrom ? Number(q.yearFrom) : undefined,
        yearTo: q.yearTo ? Number(q.yearTo) : undefined,
        minRating: q.minRating ? Number(q.minRating) : undefined,
        page: int(q.page, 1),
      }),
    );
  });
  app.get("/api/search", async (c) => c.json(await catalog.search(ctx, c.req.query("q") ?? "")));
  app.get("/api/titles/:id", async (c) => c.json(await catalog.detail(ctx, Number(c.req.param("id")), profileOf(c))));
  app.get("/api/titles/:id/availability", (c) => c.json(availability(ctx, Number(c.req.param("id")))));
  app.get("/api/titles/:id/releases", async (c) => {
    const r = await ranking(ctx, Number(c.req.param("id")));
    const strip = (s: { release: { link: string }; score: number }) => ({ ...s, release: { ...s.release, link: undefined }, score: Math.round(s.score * 100) / 100 });
    return c.json({ instant: r.instant.map(strip), target: r.target.map(strip), dropped: r.dropped });
  });

  // ---- TV shows
  app.get("/api/shows", async (c) => c.json(await showsHome(ctx, profileOf(c))));
  app.get("/api/shows/search", async (c) => c.json(await searchShows(ctx, c.req.query("q") ?? "")));
  app.get("/api/shows/:imdb", async (c) => c.json(await showDetail(ctx, profileOf(c), c.req.param("imdb"))));
  app.get("/api/shows/:imdb/seasons/:n", async (c) => c.json(await seasonEpisodes(ctx, profileOf(c), c.req.param("imdb"), Number(c.req.param("n")))));
  /** The episode after this one (null for films and finales). */
  app.get("/api/titles/:id/next", async (c) => {
    const id = Number(c.req.param("id"));
    return c.json(isEpisode(id) ? await nextEpisode(ctx, id) : null);
  });
  /** Start fetching without clearing the home cache (next episode, My List). */
  app.post("/api/titles/:id/prefetch", async (c) => c.json(await play(ctx, Number(c.req.param("id")), profileOf(c), { prefetch: true })));

  // ---- play
  app.post("/api/titles/:id/play", async (c) => c.json(await play(ctx, Number(c.req.param("id")), profileOf(c))));
  app.get("/api/titles/:id/play", (c) => c.json(playStatus(ctx, Number(c.req.param("id")), profileOf(c))));
  app.delete("/api/titles/:id/play", async (c) => {
    await cancel(ctx, Number(c.req.param("id")));
    return c.json({ ok: true });
  });
  app.get("/api/titles/:id/upgrade", (c) => {
    const up = pendingUpgrade(ctx, Number(c.req.param("id")), c.req.query("from") ?? "");
    return c.json(up);
  });
  app.post("/api/titles/:id/upgrade/refresh", async (c) => {
    const { fromVariantId, toVariantId, positionS } = await c.req.json<{ fromVariantId: string; toVariantId: string; positionS: number }>();
    ctx.jobs.enqueue("upgrade.prepare", { fromVariantId, toVariantId, atS: positionS }, { dedupeKey: `upgrade:${fromVariantId}:${toVariantId}` });
    return c.json({ ok: true });
  });

  app.on(["GET", "HEAD"], "/api/stream/:variantId", async (c) => {
    const v = variant(ctx, c.req.param("variantId"));
    if (!v) return c.json({ error: "not found" }, 404);
    if (v.location === "local" || ctx.fake) {
      const input = await mediaInput(ctx, v);
      if (input.startsWith("http")) return c.redirect(input, 302);
      return serveFile(c, input);
    }
    // put.io original: a fresh, short-lived URL per request; never logged or stored.
    const url = await ctx.svc.putio.downloadUrl(v.putio_file_id!);
    return c.redirect(url, 302);
  });

  // Repackaged stream for players that can't decode the file's audio/container.
  app.get("/api/stream/:variantId/compat-start", async (c) => {
    const v = variant(ctx, c.req.param("variantId"));
    if (!v) return c.json({ error: "not found" }, 404);
    const start = await compatStart(ctx, v, Number(c.req.query("t") ?? 0) || 0);
    return c.json({ start, url: `/api/stream/${v.id}/compat?start=${start}` });
  });
  app.get("/api/stream/:variantId/compat", async (c) => {
    const v = variant(ctx, c.req.param("variantId"));
    if (!v) return c.json({ error: "not found" }, 404);
    return compatResponse(ctx, v, Math.max(0, Number(c.req.query("start") ?? 0) || 0), c.req.raw.signal);
  });

  /**
   * Last resort when even the compat stream fails: put.io's own HLS (converted
   * by put.io), via chill.institute so the player never sees our put.io token.
   * Both services rate-limit, so resolved URLs are cached in memory (never
   * persisted or logged) and 429s come back as "busy" for the player to retry.
   */
  app.post("/api/variants/:id/fallback", async (c) => {
    const v = variant(ctx, c.req.param("id"));
    if (!v?.putio_file_id) return c.json({ state: "unavailable" });
    const hit = hlsCache.get(v.id);
    if (hit && hit.until > Date.now()) return c.json({ state: "ready", url: hit.url, kind: "hls" });
    try {
      const r = await ctx.svc.chill.resolvePlayback(v.putio_file_id, "HLS");
      if (r.kind === "ready") {
        hlsCache.set(v.id, { url: r.url, until: Date.now() + 10 * 60_000 });
        return c.json({ state: "ready", url: r.url, kind: "hls", subtitles: r.subtitles });
      }
      if (r.kind === "unavailable" && r.reason.includes("CONVERSION_REQUIRED")) return c.json({ state: await ctx.svc.chill.startConversion(v.putio_file_id) });
      return c.json({ state: r.kind });
    } catch (err) {
      if ((err as { status?: number }).status === 429) return c.json({ state: "busy" });
      throw err;
    }
  });

  // ---- subtitles
  app.get("/api/subtitles/:file", async (c) => {
    const id = c.req.param("file").replace(/\.vtt$/, "");
    const scale = Number(c.req.query("scale") ?? 1) || 1;
    const shift = Number(c.req.query("shift") ?? 0) || 0;
    const text = await vttFor(ctx, id, { scale, shift });
    return new Response(text, { headers: { "Content-Type": "text/vtt; charset=utf-8", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" } });
  });
  /** Remember a profile's subtitle choice for a title; language null = off. */
  app.post("/api/titles/:id/subtitle", async (c) => {
    const b = await c.req.json<{ language: string | null; forced?: boolean; sdh?: boolean }>();
    saveChoice(ctx, profileOf(c), Number(c.req.param("id")), b);
    return c.json({ ok: true });
  });

  app.post("/api/progress", async (c) => {
    const b = await c.req.json<{ profileId: number; tmdbId: number; variantId: string; positionS: number; durationS: number; event?: "heartbeat" | "pause" | "seek" | "stop" | "end" }>();
    const v = variant(ctx, b.variantId);
    const now = ctx.clock.now();
    const duration = b.durationS || v?.duration_s || 0;
    const watched = b.event === "end" || isWatched(b.positionS, duration);
    ctx.db
      .prepare(
        `INSERT INTO watch_state (profile_id, tmdb_id, position_s, duration_s, watched, last_variant_id, last_release_id, last_edition, updated_at)
         VALUES (@p, @t, @pos, @dur, @w, @v, @r, @e, @now)
         ON CONFLICT(profile_id, tmdb_id) DO UPDATE SET position_s=@pos, duration_s=@dur, watched=@w, last_variant_id=@v,
           last_release_id=COALESCE(@r, last_release_id), last_edition=COALESCE(@e, last_edition), updated_at=@now`,
      )
      .run({ p: b.profileId, t: b.tmdbId, pos: watched ? 0 : b.positionS, dur: duration, w: watched ? 1 : 0, v: v ? b.variantId : null, r: v?.release_id ?? null, e: v?.edition ?? null, now });
    if (v) {
      const stop = b.event === "stop" || b.event === "end";
      ctx.db.prepare("UPDATE variants SET last_played_at = ?, last_heartbeat_at = ? WHERE id = ?").run(now, stop ? null : now, v.id);
      if (stop) ctx.jobs.enqueue("storage.cleanup", {}, { dedupeKey: "storage.cleanup", delayMs: 2000 });
    }
    return c.json({ ok: true, watched });
  });

  // ---- my list (adding prefetches, so it starts instantly on movie night)
  app.get("/api/my-list", (c) => c.json(ctx.db.prepare("SELECT tmdb_id FROM my_list WHERE profile_id = ? ORDER BY added_at DESC").pluck().all(profileOf(c))));
  app.post("/api/my-list/:id", async (c) => {
    const id = Number(c.req.param("id"));
    await catalog.ensureTitle(ctx, id);
    ctx.db.prepare("INSERT OR IGNORE INTO my_list (profile_id, tmdb_id, added_at) VALUES (?, ?, ?)").run(profileOf(c), id, ctx.clock.now());
    await play(ctx, id, profileOf(c), { prefetch: true }).catch((err) => log.warn("prefetch failed", { err }));
    return c.json({ ok: true });
  });
  app.delete("/api/my-list/:id", (c) => {
    ctx.db.prepare("DELETE FROM my_list WHERE profile_id = ? AND tmdb_id = ?").run(profileOf(c), Number(c.req.param("id")));
    return c.json({ ok: true });
  });

  // ---- storage
  app.get("/api/storage", (c) => c.json(report(ctx)));
  app.post("/api/variants/:id/pin", async (c) => {
    const { pinned } = await c.req.json<{ pinned: boolean }>();
    ctx.db.prepare("UPDATE variants SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, c.req.param("id"));
    publishStorage(ctx);
    return c.json({ ok: true });
  });
  app.post("/api/variants/:id/evict", async (c) => {
    await evictVariant(ctx, c.req.param("id"), "deleted by user");
    publishStorage(ctx);
    return c.json({ ok: true });
  });

  // ---- telemetry from the TV
  app.post("/api/telemetry", async (c) => {
    const body = await c.req.json<{ kind: string } & Partial<HandoffTelemetry>>();
    ctx.db.prepare("INSERT INTO telemetry (kind, json, at) VALUES (?, ?, ?)").run(String(body.kind ?? "event").slice(0, 40), JSON.stringify(body).slice(0, 10_000), ctx.clock.now());
    return c.json({ ok: true });
  });
  app.get("/api/telemetry", (c) =>
    c.json((ctx.db.prepare("SELECT kind, json, at FROM telemetry ORDER BY id DESC LIMIT 100").all() as { kind: string; json: string; at: number }[]).map((r) => ({ ...r, json: JSON.parse(r.json) }))),
  );

  // ---- live events
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: ServerEvent[] = [];
      let wake: (() => void) | null = null;
      const off = ctx.bus.subscribe((e) => {
        queue.push(e);
        wake?.();
      });
      stream.onAbort(() => off());
      await stream.writeSSE({ data: JSON.stringify({ type: "hello" }) });
      while (!stream.aborted) {
        if (!queue.length) await new Promise<void>((r) => ((wake = r), setTimeout(r, 15_000)));
        wake = null;
        if (!queue.length) {
          await stream.writeSSE({ event: "ping", data: "{}" });
          continue;
        }
        while (queue.length) await stream.writeSSE({ data: JSON.stringify(queue.shift()) });
      }
      off();
    }),
  );

  // ---- images (TMDB proxy with a disk cache; generated posters in demo mode)
  app.get("/img/:size/*", async (c) => {
    const size = c.req.param("size");
    if (!/^(w\d{2,4}|original)$/.test(size)) return c.text("bad size", 400);
    const p = c.req.path.slice(`/img/${size}/`.length);
    if (!/^[A-Za-z0-9_./-]+$/.test(p) || p.includes("..")) return c.text("bad path", 400);
    const cacheFile = path.join(ctx.cfg.cacheDir, "img", size, p.replace(/\//g, "_"));
    const type = p.endsWith(".svg") ? "image/svg+xml" : p.endsWith(".png") ? "image/png" : "image/jpeg";
    if (fs.existsSync(cacheFile)) return new Response(fs.readFileSync(cacheFile), { headers: { "Content-Type": type, "Cache-Control": "public, max-age=604800" } });
    const img = await ctx.svc.tmdb.image(size, p);
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, img.body);
    return new Response(Buffer.from(img.body), { headers: { "Content-Type": img.contentType, "Cache-Control": "public, max-age=604800" } });
  });

  // ---- demo mode: fake put.io media
  if (ctx.fake) {
    app.on(["GET", "HEAD"], "/fake-putio/media/:id", (c) => {
      const p = ctx.fake!.putio.mediaPath(Number(c.req.param("id")));
      return p ? serveFile(c, p) : c.text("not found", 404);
    });
  }

  // ---- the SPA
  if (ctx.cfg.staticDir && fs.existsSync(ctx.cfg.staticDir)) {
    const root = ctx.cfg.staticDir;
    const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
    app.get("*", (c) => {
      const rel = decodeURIComponent(c.req.path).replace(/^\/+/, "");
      const file = path.join(root, rel);
      if (rel && file.startsWith(root) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const cache = rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
        const types: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".woff2": "font/woff2" };
        return new Response(fs.readFileSync(file), { headers: { "Content-Type": types[path.extname(file)] ?? "application/octet-stream", "Cache-Control": cache } });
      }
      if (rel.startsWith("api/")) return c.json({ error: "not found" }, 404);
      return c.html(index, 200, { "Cache-Control": "no-cache" });
    });
  }
  return app;
}
