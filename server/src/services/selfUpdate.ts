import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "../context.js";
import { EXIT_UPDATE, shouldHandOver } from "../domain/selfUpdate.js";
import { log } from "../log.js";
import { anythingPlaying } from "./storage.js";

const CHECK_MS = 30_000;

/**
 * Self-update, server half. docker/supervise.sh builds new commits beside the running one
 * and names the finished build in `<releasesDir>/pending`; once nothing is playing we shut
 * down gracefully with EXIT_UPDATE and the supervisor starts the new release.
 */
export function watchForUpdates(ctx: Ctx, shutdown: (code: number) => Promise<void>): void {
  const dir = ctx.cfg.releasesDir;
  if (!dir) return;
  let handingOver = false;
  setInterval(() => {
    if (handingOver) return;
    const staged = readStaged(dir);
    if (!shouldHandOver({ running: ctx.cfg.commit, staged, playing: anythingPlaying(ctx) })) return;
    handingOver = true;
    log.info("update staged; restarting into it", { from: ctx.cfg.commit, to: staged });
    void shutdown(EXIT_UPDATE);
  }, CHECK_MS).unref();
}

function readStaged(dir: string): string | null {
  try {
    return fs.readFileSync(path.join(dir, "pending"), "utf8").trim() || null;
  } catch {
    return null;
  }
}
