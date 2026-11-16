import path from "node:path";
import { z } from "zod";

const bool = z.enum(["1", "0", "true", "false"]).transform((v) => v === "1" || v === "true");

const Env = z.object({
  PORT: z.coerce.number().int().default(7878),
  HOST: z.string().default("0.0.0.0"),
  DATA_DIR: z.string().default("./data"),
  LIBRARY_DIR: z.string().optional(),
  /** Run with fake TMDB / chill.institute / put.io and generated sample films. */
  CHILL_FAKE: bool.default("0"),
  TMDB_TOKEN: z.string().optional(),
  CHILL_TOKEN: z.string().optional(),
  PUTIO_TOKEN: z.string().optional(),
  PUTIO_FOLDER: z.string().default("chill"),
  PUTIO_BUDGET_GB: z.coerce.number().positive().default(100),
  LOCAL_BUDGET_GB: z.coerce.number().positive().default(100),
  RACE_AFTER_S: z.coerce.number().positive().default(90),
  /** Phase 0 measures this on the TV; until then assume the best case. */
  TV_TWO_DECODERS: bool.default("1"),
  /** Measured single-element swap latency on the TV (ms), for black-segment handoffs. */
  TV_SWAP_LATENCY_MS: z.coerce.number().default(800),
  MIRROR_CONNECTIONS: z.coerce.number().int().min(1).max(16).default(8),
  /** Fake mode: seconds a fake put.io transfer takes (instant / target). */
  FAKE_INSTANT_S: z.coerce.number().default(6),
  FAKE_TARGET_S: z.coerce.number().default(25),
  /** Fake mode: seconds the fake put.io → local mirror takes. */
  FAKE_MIRROR_KBPS: z.coerce.number().default(0),
  STATIC_DIR: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  const e = parsed.data;
  if (!e.CHILL_FAKE) {
    // TMDB is optional: without it the keyless Cinemeta catalog is used.
    const missing = (["CHILL_TOKEN", "PUTIO_TOKEN"] as const).filter((k) => !e[k]);
    if (missing.length)
      throw new Error(`Missing ${missing.join(", ")}. Set them in .env (see docker/.env.example), or run with CHILL_FAKE=1 for the demo.`);
  }
  const dataDir = path.resolve(e.DATA_DIR);
  return {
    port: e.PORT,
    host: e.HOST,
    dataDir,
    libraryDir: path.resolve(e.LIBRARY_DIR ?? path.join(dataDir, "library")),
    cacheDir: path.join(dataDir, "cache"),
    fake: e.CHILL_FAKE,
    tmdbToken: e.TMDB_TOKEN ?? "",
    catalog: (e.TMDB_TOKEN ? "tmdb" : "cinemeta") as "tmdb" | "cinemeta",
    chillToken: e.CHILL_TOKEN ?? "",
    putioToken: e.PUTIO_TOKEN ?? "",
    putioFolder: e.PUTIO_FOLDER,
    budgets: {
      putio: { budgetBytes: e.PUTIO_BUDGET_GB * 1e9, highWatermark: 0.9, lowWatermark: 0.75 },
      local: { budgetBytes: e.LOCAL_BUDGET_GB * 1e9, highWatermark: 0.9, lowWatermark: 0.75 },
    },
    raceAfterMs: e.RACE_AFTER_S * 1000,
    tv: { twoDecoders: e.TV_TWO_DECODERS, swapLatencyMs: e.TV_SWAP_LATENCY_MS },
    mirrorConnections: e.MIRROR_CONNECTIONS,
    fakeTimings: { instantS: e.FAKE_INSTANT_S, targetS: e.FAKE_TARGET_S, mirrorKbps: e.FAKE_MIRROR_KBPS },
    staticDir: e.STATIC_DIR ? path.resolve(e.STATIC_DIR) : null,
    logLevel: e.LOG_LEVEL,
  };
}
