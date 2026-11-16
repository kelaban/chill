// npm run dev — server (watch) on :7878 + Vite on :5173.
// With no tokens in the environment or docker/.env, runs in demo mode.
import { spawn } from "node:child_process";
import fs from "node:fs";

const env = { ...process.env, NODE_NO_WARNINGS: "1" };
if (fs.existsSync("docker/.env")) {
  for (const line of fs.readFileSync("docker/.env", "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[2] && !env[m[1]]) env[m[1]] = m[2];
  }
}
if (!env.TMDB_TOKEN || !env.CHILL_TOKEN || !env.PUTIO_TOKEN) {
  env.CHILL_FAKE ??= "1";
  console.log("No API tokens found: starting in demo mode (CHILL_FAKE=1).");
}
const procs = [
  spawn("npx", ["tsx", "watch", "server/src/main.ts"], { stdio: "inherit", env }),
  spawn("npx", ["vite", "--host"], { stdio: "inherit", cwd: "web", env }),
];
const stop = () => procs.forEach((p) => p.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
