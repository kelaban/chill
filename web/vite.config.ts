import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The household's LG OLED G3 runs webOS 11.2 = Chromium 132 (user agent read
// on the TV in Phase 0, 2026-11-15; documentation/DECISIONS.md D1).
export const TV_TARGET = "chrome132";

export default defineConfig({
  plugins: [react()],
  build: { target: TV_TARGET, outDir: "../server/public", emptyOutDir: true, sourcemap: false, cssTarget: TV_TARGET, chunkSizeWarningLimit: 700 },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:7878", "/img": "http://127.0.0.1:7878", "/fake-putio": "http://127.0.0.1:7878" },
  },
});
