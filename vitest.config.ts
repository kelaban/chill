import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/test/**/*.test.ts", "web/src/**/*.test.ts"],
    exclude: ["**/*.live.test.ts", "**/node_modules/**"],
    testTimeout: 30_000,
  },
});
