import { defineConfig } from "vitest/config";

// Live smoke tests against the real TMDB / chill.institute / put.io APIs.
// Each suite skips itself unless its credential is configured.
export default defineConfig({
  test: { include: ["server/test/**/*.live.test.ts"], testTimeout: 300_000 },
});
