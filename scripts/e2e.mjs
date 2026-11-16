// End-to-end: build, start the server in demo mode, drive the UI in headless
// Chromium with the remote's keys, and assert the seamless upgrade.
// Usage: npm run test:e2e   (needs ffmpeg and Playwright's Chromium)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const data = fs.mkdtempSync(path.join(os.tmpdir(), "chill-e2e-"));
const out = path.join(root, "test-results");
fs.mkdirSync(out, { recursive: true });
const PORT = 7979;
const base = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ["--import", "tsx", "server/src/main.ts"], {
  cwd: root,
  env: {
    ...process.env, CHILL_FAKE: "1", DATA_DIR: data, STATIC_DIR: path.join(root, "server/public"), PORT: String(PORT),
    FAKE_INSTANT_S: "4", FAKE_TARGET_S: "12", FAKE_MIRROR_KBPS: "0", NODE_NO_WARNINGS: "1",
    // Reuse generated sample films across runs.
    LIBRARY_DIR: path.join(data, "library"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));

const failures = [];
const check = (cond, msg) => (cond ? console.log(`  ✓ ${msg}`) : (failures.push(msg), console.log(`  ✗ ${msg}`)));

async function waitHealthy() {
  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server never became healthy:\n${log}`);
}

try {
  await waitHealthy();
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const press = async (k, n = 1) => {
    for (let i = 0; i < n; i++) (await page.keyboard.press(k), await page.waitForTimeout(150));
  };
  const focused = () => page.evaluate(() => document.querySelector("[data-focused=true]")?.getAttribute("data-testid") ?? null);

  console.log("remote-only navigation");
  await page.goto(`${base}/tv`);
  await page.waitForSelector("[data-testid=profile-1]");
  await page.waitForFunction(() => document.querySelector("[data-focused=true]"));
  await press("Enter");
  await page.waitForSelector("[data-testid=hero-play]");
  await page.waitForFunction(() => document.querySelector("[data-focused=true]")?.getAttribute("data-testid") === "hero-play");
  check((await focused()) === "hero-play", "home opens with Play focused");
  await press("ArrowDown");
  check((await focused())?.startsWith("card-"), "Down moves into the first row");
  await press("ArrowRight", 2);
  const card = await focused();
  check(card?.startsWith("card-"), `Right moves along the row (${card})`);
  await press("Enter");
  await page.waitForSelector("[data-testid=detail-title]");
  check(true, "OK opens the detail page");
  await page.keyboard.down("Escape"), await page.keyboard.up("Escape");
  await page.waitForSelector("[data-testid=hero]");
  check(true, "Back returns home");
  await page.screenshot({ path: path.join(out, "home.png") });

  console.log("play → fast copy → seamless upgrade");
  await page.goto(`${base}/title/949`);
  await page.waitForFunction(() => /Starts in|Ready/.test(document.querySelector("[data-testid=availability]")?.textContent ?? ""), null, { timeout: 20000 });
  check(true, "detail page knows a copy is available");
  await page.waitForFunction(() => document.querySelector("[data-focused=true]")?.getAttribute("data-testid") === "detail-play");
  const t0 = Date.now();
  await press("Enter");
  await page.waitForSelector("[data-testid=preparing]");
  await page.waitForFunction(() => { const v = document.querySelector("video[data-active]"); return v && v.currentTime > 0.3; }, null, { timeout: 60000 });
  const ttff = (Date.now() - t0) / 1000;
  check(ttff < 15, `first frame ${ttff.toFixed(1)} s after Play (fake transfer: 4 s)`);
  const before = await page.textContent("[data-testid=quality-label]");
  await page.waitForFunction(() => (window.__chillHandoff ?? []).length > 0, null, { timeout: 120000 }).catch(() => {});
  const reports = await page.evaluate(() => window.__chillHandoff ?? []);
  const first = reports[0];
  check(!!first, "an upgrade happened with no input");
  if (first) {
    check(first.mode === "seamless", `handoff mode: ${first.mode}`);
    check(first.gapMs <= 42, `timeline error at the switch ${first.gapMs} ms (≤ 1 frame at 24 fps)`);
    check(Math.abs(first.atS - Math.round(first.atS / 20) * 20) < 0.1, `switched on a scene cut (${first.atS} s)`);
  }
  const after = await page.textContent("[data-testid=quality-label]");
  check(before !== after && /2160p/.test(after ?? ""), `quality label changed: "${before}" → "${after}"`);
  await page.screenshot({ path: path.join(out, "upgraded.png") });
  await press("Escape");
  await page.waitForTimeout(1000);

  console.log("resume");
  const st = await (await fetch(`${base}/api/titles/949/play?profile=1`)).json();
  check(st.phase === "ready" && st.stream.startAtS > 10, `resume point kept (${st.stream?.startAtS?.toFixed(1)} s on ${st.stream?.label})`);
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  await browser.close();
} catch (err) {
  failures.push(String(err));
  console.error(err);
} finally {
  server.kill("SIGTERM");
  fs.rmSync(data, { recursive: true, force: true });
}
if (failures.length) {
  console.log(`\n${failures.length} e2e check(s) failed`);
  process.exit(1);
}
console.log("\nall e2e checks passed");
