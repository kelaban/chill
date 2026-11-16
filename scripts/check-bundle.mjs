// After `npm run build`: the SPA bundle is public on the LAN. Fail if any
// secret, token value, or provider endpoint that needs one leaked into it.
import fs from "node:fs";
import path from "node:path";

const dir = "server/public";
if (!fs.existsSync(dir)) {
  console.error("no build found — run npm run build first");
  process.exit(1);
}
const files = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name))));
walk(dir);
const banned = [/api\.put\.io/, /api\.chill\.institute/, /api\.themoviedb\.org/, /magnet:\?xt/, /PUTIO_TOKEN|CHILL_TOKEN|TMDB_TOKEN/];
for (const k of ["TMDB_TOKEN", "CHILL_TOKEN", "PUTIO_TOKEN"]) if (process.env[k] && process.env[k].length > 8) banned.push(new RegExp(process.env[k].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
let bad = 0;
for (const f of files.filter((f) => /\.(js|html|css|json)$/.test(f))) {
  const s = fs.readFileSync(f, "utf8");
  for (const re of banned) if (re.test(s)) (console.error(`✗ ${f} matches ${re}`), bad++);
}
if (bad) process.exit(1);
console.log(`✓ ${files.length} bundle files clean`);
