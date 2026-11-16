import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { boot } from "./boot.js";
import { loadConfig } from "./config.js";
import { log, setLogLevel } from "./log.js";
import { watchForUpdates } from "./services/selfUpdate.js";

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  if (!cfg.staticDir) cfg.staticDir = path.resolve(here, "../public");
  const ctx = await boot(cfg);
  const app = createApp(ctx);
  const server = serve({ fetch: app.fetch, port: cfg.port, hostname: cfg.host }, (info) =>
    log.info("chill listening", { port: info.port, fake: cfg.fake, library: cfg.libraryDir }),
  );
  ctx.jobs.start();
  ctx.jobs.enqueue("storage.cleanup", {}, { dedupeKey: "storage.cleanup", delayMs: 5000 });
  setInterval(() => ctx.jobs.enqueue("storage.cleanup", {}, { dedupeKey: "storage.cleanup" }), 3_600_000).unref();

  let closing = false;
  const shutdown = async (code = 0) => {
    if (closing) return;
    closing = true;
    log.info("shutting down", { code });
    ctx.jobs.stop();
    server.close();
    await Promise.race([ctx.jobs.idle(), new Promise((r) => setTimeout(r, 5000))]);
    ctx.db.close();
    process.exit(code);
  };
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  watchForUpdates(ctx, shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
