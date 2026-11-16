import path from "node:path";
import { chillClient } from "./adapters/chill.js";
import { putioClient } from "./adapters/putio.js";
import { tmdbClient } from "./adapters/tmdb.js";
import type { Services } from "./adapters/types.js";
import type { Config } from "./config.js";
import type { Ctx } from "./context.js";
import { openDb, type DB } from "./db.js";
import { EventBus } from "./events.js";
import { ensureSamples, type Samples } from "./fakes/samples.js";
import { fakeServices } from "./fakes/services.js";
import { Jobs, systemClock, type Clock } from "./jobs.js";
import { registerAcquireJobs } from "./services/acquirer.js";
import { registerMirrorJobs } from "./services/mirror.js";
import { registerReleaseJobs } from "./services/releases.js";
import { registerStorageJobs } from "./services/storage.js";
import { registerUpgradeJobs } from "./services/upgrade.js";

export interface BootOptions {
  db?: DB;
  clock?: Clock;
  services?: Services;
  samples?: Samples | null;
}

/** Wire config → services → job handlers. Shared by main.ts and the tests. */
export async function boot(cfg: Config, o: BootOptions = {}): Promise<Ctx> {
  const clock = o.clock ?? systemClock;
  const db = o.db ?? openDb(path.join(cfg.dataDir, "chill.db"));
  const selfBase = `http://127.0.0.1:${cfg.port}`;
  let fake: Ctx["fake"] = null;
  let svc: Services;
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
    svc = { tmdb: tmdbClient(cfg.tmdbToken), chill: chillClient(cfg.chillToken), putio: putioClient(cfg.putioToken) };
  }
  const ctx: Ctx = { cfg, db, svc, jobs: new Jobs(db, clock), bus: new EventBus(), clock, fake, selfBase };
  registerReleaseJobs(ctx);
  registerAcquireJobs(ctx);
  registerMirrorJobs(ctx);
  registerUpgradeJobs(ctx);
  registerStorageJobs(ctx);
  return ctx;
}
