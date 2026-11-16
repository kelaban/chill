import path from "node:path";
import { chillClient } from "./adapters/chill.js";
import { putioClient } from "./adapters/putio.js";
import { tmdbClient } from "./adapters/tmdb.js";
import { cinemetaClient, type IdStore } from "./adapters/cinemeta.js";
import { fixedGate, gatedCatalog, type CatalogGate } from "./adapters/catalogGate.js";
import type { Services } from "./adapters/types.js";
import type { Config } from "./config.js";
import type { Ctx } from "./context.js";
import { openDb, type DB } from "./db.js";
import { log } from "./log.js";
import { EventBus } from "./events.js";
import { ensureSamples, type Samples } from "./fakes/samples.js";
import { fakeServices } from "./fakes/services.js";
import { Jobs, systemClock, type Clock } from "./jobs.js";
import { registerAcquireJobs } from "./services/acquirer.js";
import { registerMirrorJobs } from "./services/mirror.js";
import { registerReleaseJobs } from "./services/releases.js";
import { registerStorageJobs } from "./services/storage.js";
import { registerUpgradeJobs } from "./services/upgrade.js";
import { registerSubtitleJobs } from "./services/subtitles.js";
import { registerTrickplayJobs } from "./services/trickplay.js";

export interface BootOptions {
  db?: DB;
  clock?: Clock;
  services?: Services;
  samples?: Samples | null;
  /** Tests: a gate to use with `services` (default: the fake catalog, TMDB features on). */
  catalog?: CatalogGate;
}

/** Wire config → services → job handlers. Shared by main.ts and the tests. */
export async function boot(cfg: Config, o: BootOptions = {}): Promise<Ctx> {
  const clock = o.clock ?? systemClock;
  const db = o.db ?? openDb(path.join(cfg.dataDir, "chill.db"));
  const selfBase = `http://127.0.0.1:${cfg.port}`;
  let fake: Ctx["fake"] = null;
  let svc: Services;
  let gate: CatalogGate = o.catalog ?? fixedGate("fake");
  if (o.services) {
    svc = o.services;
    if ("mediaPath" in svc.putio) fake = { putio: svc.putio as any, samples: o.samples ?? null };
  } else if (cfg.fake) {
    const samples = o.samples !== undefined ? o.samples : await ensureSamples(path.join(cfg.cacheDir, "samples"));
    const f = fakeServices({
      clock,
      samples,
      stateFile: path.join(cfg.dataDir, "fake-putio.json"),
      quotaBytes: cfg.budgets.putio.budgetBytes,
      timings: cfg.fakeTimings,
      mediaUrl: (id) => `/fake-putio/media/${id}`,
    });
    svc = f;
    fake = { putio: f.putio, samples };
  } else {
    const ids: IdStore = {
      imdbFor: (id) => (db.prepare("SELECT imdb_id FROM title_ids WHERE tmdb_id = ?").pluck().get(id) as string | undefined) ?? null,
      remember: (id, imdb) => void db.prepare("INSERT INTO title_ids (tmdb_id, imdb_id) VALUES (?, ?) ON CONFLICT(tmdb_id) DO UPDATE SET imdb_id = excluded.imdb_id").run(id, imdb),
    };
    // TMDB only when configured AND the key works; Cinemeta otherwise (catalogGate.ts).
    const cinemeta = cinemetaClient(ids);
    let catalog = cinemeta;
    if (cfg.tmdbToken) {
      const g = gatedCatalog(tmdbClient(cfg.tmdbToken), cinemeta, ids);
      catalog = g.api;
      gate = g.gate;
      const state = await gate.verify();
      log.info("catalog", { source: gate.source(), tmdb: state });
    } else {
      gate = fixedGate("cinemeta");
      log.info("catalog", { source: "cinemeta", tmdb: "off (TMDB_TOKEN not set)" });
    }
    svc = { tmdb: catalog, chill: chillClient(cfg.chillToken), putio: putioClient(cfg.putioToken) };
  }
  const ctx: Ctx = { cfg, db, svc, catalog: gate, jobs: new Jobs(db, clock), bus: new EventBus(), clock, fake, selfBase };
  registerReleaseJobs(ctx);
  registerAcquireJobs(ctx);
  registerMirrorJobs(ctx);
  registerUpgradeJobs(ctx);
  registerStorageJobs(ctx);
  registerSubtitleJobs(ctx);
  registerTrickplayJobs(ctx);
  return ctx;
}
