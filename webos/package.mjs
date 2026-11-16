// Build the webOS hosted-app IPK:  CHILL_URL=http://192.168.1.20:7878 npm run webos:package
// Uses LG's ares-package from @webos-tools/cli (fetched by npx on first use).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const url = (process.env.CHILL_URL ?? "").replace(/\/+$/, "");
if (!/^https?:\/\/[^/]+$/.test(url)) {
  console.error("Set CHILL_URL to your server, e.g. CHILL_URL=http://192.168.1.20:7878 npm run webos:package");
  process.exit(1);
}
const stage = path.join(here, "dist", "app");
fs.rmSync(path.join(here, "dist"), { recursive: true, force: true });
fs.mkdirSync(path.join(stage, "assets"), { recursive: true });
fs.copyFileSync(path.join(here, "appinfo.json"), path.join(stage, "appinfo.json"));
fs.writeFileSync(path.join(stage, "index.html"), fs.readFileSync(path.join(here, "index.html"), "utf8").replaceAll("__CHILL_URL__", url));
for (const f of fs.readdirSync(path.join(here, "assets"))) fs.copyFileSync(path.join(here, "assets", f), path.join(stage, "assets", f));
execFileSync("npx", ["--yes", "-p", "@webos-tools/cli@3", "ares-package", stage, "-o", path.join(here, "dist")], { stdio: "inherit" });
const ipk = fs.readdirSync(path.join(here, "dist")).find((f) => f.endsWith(".ipk"));
console.log(`\nBuilt webos/dist/${ipk} → install with: npx -p @webos-tools/cli@3 ares-install -d <your-tv> webos/dist/${ipk}`);
