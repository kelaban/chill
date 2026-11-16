import type { Availability } from "@chill/shared";
import type { Ctx } from "../context.js";
import { DEFAULT_DEVICE, DEFAULT_PROFILE, needsUpgrade, rank, type DeviceCaps, type QualityProfile, type Ranking } from "../domain/ranker.js";
import { releaseLabel, type Release } from "../domain/release.js";
import { getSetting } from "../db.js";
import { ensureTitle } from "./catalog.js";

const SEARCH_TTL_MS = 12 * 3_600_000;

export function qualityProfile(ctx: Ctx): QualityProfile {
  return getSetting(ctx.db, "quality", DEFAULT_PROFILE);
}

export function deviceCaps(ctx: Ctx): DeviceCaps {
  return getSetting(ctx.db, "device", DEFAULT_DEVICE);
}

function load(ctx: Ctx, tmdbId: number): Release[] {
  const rows = ctx.db.prepare("SELECT * FROM releases WHERE tmdb_id = ?").all(tmdbId) as any[];
  return rows.map((r) => ({
    id: r.id, rawTitle: r.raw_title, indexer: r.indexer, link: r.link, imdbId: r.imdb_id ?? undefined,
    seeders: r.seeders, peers: r.peers, sizeBytes: r.size_bytes, info: r.info_json ? JSON.parse(r.info_json) : undefined,
  }));
}

export function releaseById(ctx: Ctx, tmdbId: number, id: string): Release | null {
  return load(ctx, tmdbId).find((r) => r.id === id) ?? null;
}

/** chill.institute search for a title, cached 12 h per title. */
export async function searchReleases(ctx: Ctx, tmdbId: number, opts: { force?: boolean } = {}): Promise<Release[]> {
  const s = ctx.db.prepare("SELECT searched_at FROM searches WHERE tmdb_id = ?").get(tmdbId) as { searched_at: number } | undefined;
  if (s && !opts.force && ctx.clock.now() - s.searched_at < SEARCH_TTL_MS) return load(ctx, tmdbId);
  const { facts } = await ensureTitle(ctx, tmdbId);
  const query = facts.year ? `${facts.title} ${facts.year}` : facts.title;
  const results = await ctx.svc.chill.search(query);
  const now = ctx.clock.now();
  ctx.db.transaction(() => {
    ctx.db.prepare("DELETE FROM releases WHERE tmdb_id = ?").run(tmdbId);
    const ins = ctx.db.prepare(
      "INSERT OR REPLACE INTO releases (id, tmdb_id, raw_title, indexer, link, imdb_id, seeders, peers, size_bytes, info_json, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const r of results) ins.run(r.id, tmdbId, r.rawTitle, r.indexer, r.link, r.imdbId ?? null, r.seeders, r.peers, r.sizeBytes, r.info ? JSON.stringify(r.info) : null, now);
    ctx.db.prepare("INSERT INTO searches (tmdb_id, searched_at, result_count) VALUES (?,?,?) ON CONFLICT(tmdb_id) DO UPDATE SET searched_at = excluded.searched_at, result_count = excluded.result_count").run(tmdbId, now, results.length);
  })();
  return results;
}

export async function ranking(ctx: Ctx, tmdbId: number, prefer?: { releaseId?: string | null; edition?: string | null }): Promise<Ranking> {
  const [releases, { facts }] = await Promise.all([searchReleases(ctx, tmdbId), ensureTitle(ctx, tmdbId)]);
  return rank(facts, releases, qualityProfile(ctx), deviceCaps(ctx), prefer);
}

/** Cheap, synchronous: what the detail page says about playability. */
export function availability(ctx: Ctx, tmdbId: number): Availability {
  const v = ctx.db.prepare("SELECT label FROM variants WHERE tmdb_id = ? AND ready = 1 AND superseded_by IS NULL ORDER BY (location = 'local') DESC, (quality = 'target') DESC LIMIT 1").get(tmdbId) as
    | { label: string }
    | undefined;
  if (v) return { state: "ready", label: v.label };
  const s = ctx.db.prepare("SELECT searched_at FROM searches WHERE tmdb_id = ?").get(tmdbId) as { searched_at: number } | undefined;
  if (!s) {
    const pending = ctx.db.prepare("SELECT 1 FROM jobs WHERE type = 'releases.search' AND state IN ('queued','running') AND json_extract(payload_json, '$.tmdbId') = ?").get(tmdbId);
    return pending ? { state: "searching" } : { state: "unknown" };
  }
  const row = ctx.db.prepare("SELECT title, original_title, year, imdb_id, runtime_min FROM titles WHERE tmdb_id = ?").get(tmdbId) as any;
  if (!row) return { state: "unknown" };
  const r = rank({ title: row.title, originalTitle: row.original_title, year: row.year, imdbId: row.imdb_id, runtimeMin: row.runtime_min }, load(ctx, tmdbId), qualityProfile(ctx), deviceCaps(ctx));
  const top = r.instant[0];
  if (!top) return { state: "none" };
  const t = r.target[0];
  const upgrade = t && needsUpgrade(top, t, qualityProfile(ctx), deviceCaps(ctx), row.runtime_min) ? t : null;
  return { state: "available", instantLabel: releaseLabel(top.release), targetLabel: upgrade ? releaseLabel(upgrade.release) : null, releases: r.instant.length };
}

export function registerReleaseJobs(ctx: Ctx) {
  ctx.jobs.register("releases.search", async ({ tmdbId }: { tmdbId: number }) => {
    await searchReleases(ctx, tmdbId);
  });
}
