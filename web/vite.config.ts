import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The LG OLED G3 shipped with webOS 23 = Chromium 94. Build for that floor
// until Phase 0 reads the TV's real engine (documentation/DECISIONS.md).
export const TV_TARGET = "chrome94";

export default defineConfig({
  plugins: [react()],
  build: { target: TV_TARGET, outDir: "../server/public", emptyOutDir: true, sourcemap: false, cssTarget: TV_TARGET, chunkSizeWarningLimit: 700 },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:7878", "/img": "http://127.0.0.1:7878", "/fake-putio": "http://127.0.0.1:7878" },
  },
});
