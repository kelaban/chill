import type { Config } from "./config.js";
import type { DB } from "./db.js";
import type { Services } from "./adapters/types.js";
import type { EventBus } from "./events.js";
import type { Clock, Jobs } from "./jobs.js";
import type { FakePutio } from "./fakes/services.js";
import type { Samples } from "./fakes/samples.js";

/** Everything a service needs, passed explicitly (no globals). */
export interface Ctx {
  cfg: Config;
  db: DB;
  svc: Services;
  jobs: Jobs;
  bus: EventBus;
  clock: Clock;
  /** Set in demo mode. */
  fake: { putio: FakePutio; samples: Samples | null } | null;
  /** Base URL the server can reach itself on (fake media, tests). */
  selfBase: string;
}

let folderId: Promise<number> | null = null;

/** The put.io folder chill owns (created on first use). */
export function putioFolder(ctx: Ctx): Promise<number> {
  folderId ??= ctx.svc.putio.ensureFolder(ctx.cfg.putioFolder).catch((e) => {
    folderId = null;
    throw e;
  });
  return folderId;
}

export function resetPutioFolderCache() {
  folderId = null;
}

export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
