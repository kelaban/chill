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
  // The cue on screen and the film time; cues carry their film time ("· 0:05").
  const cueSync = () =>
    page.waitForFunction(() => {
      const e = window.__chillEngine;
      const t = Array.from(e.active.textTracks).find((x) => x.mode !== "disabled");
      const shown = document.querySelector("[data-testid=subtitle-text]")?.textContent ?? "";
      const cue = t && t.activeCues && t.activeCues[0];
      if (!cue) return null;
      const m = /· (\d+):(\d+)/.exec(cue.text);
      return m && shown.includes(cue.text) ? { film: Number(m[1]) * 60 + Number(m[2]), now: e.now(), text: cue.text } : null;
    }, null, { timeout: 15000 }).then((h) => h.jsonValue());

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
  // English film: subtitles start off. Turn English on, then watch them survive the switch.
  check((await page.textContent("[data-testid=subtitle-label]")) === "Subtitles: Off", "English film starts with subtitles off");
  await press("ArrowDown");
  await page.waitForSelector("[data-testid=subtitle-menu]");
  await press("ArrowDown"); // Off → English
  await press("Enter");
  let heatCue = await cueSync();
  // Cues last 3 s and are labelled with their film start time: in sync ⇔ film position ∈ [label, label + 3].
  const inSync = (c, leadIn = 0) => c.now - leadIn >= c.film - 0.1 && c.now - leadIn <= c.film + 3.1;
  check(inSync(heatCue), `English on, in sync (cue ${heatCue.film} s, film ${heatCue.now.toFixed(1)} s)`);
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
  heatCue = await cueSync();
  // The 4K demo copy has a 2.5 s lead-in: its clock runs 2.5 s ahead of film time.
  check(inSync(heatCue, 2.5), `subtitles stayed in sync through the switch (cue ${heatCue.film} s at 4K-copy time ${heatCue.now.toFixed(1)} s = film ${(heatCue.now - 2.5).toFixed(1)} s)`);
  check(before !== after && /2160p/.test(after ?? ""), `quality label changed: "${before}" → "${after}"`);
  await page.screenshot({ path: path.join(out, "upgraded.png") });
  await press("Escape");
  await page.waitForTimeout(1000);

  console.log("audio a desktop browser can't decode (E-AC3 in MKV)");
  await page.goto(`${base}/watch/496243`);
  await page.waitForFunction(() => { const v = document.querySelector("video[data-active]"); return v && v.currentTime > 2; }, null, { timeout: 60000 });
  await page.waitForTimeout(3000);
  const aud = await page.evaluate(() => { const e = window.__chillEngine; const v = e.active; return { compat: e.isCompat, audioBytes: v.webkitAudioDecodedByteCount, now: e.now() }; });
  check(aud.compat, "switched to the compat stream up front");
  check(aud.audioBytes > 0, `audio is decoding (${aud.audioBytes} bytes)`);
  // Subtitles: a Korean film starts with English on, in sync with the film.
  let cue = await cueSync();
  check(/\[EN\]/.test(cue.text), `English subtitles on by default (${cue.text})`);
  check(cue.now >= cue.film - 0.1 && cue.now <= cue.film + 3.1, `cue in sync on the compat stream (cue ${cue.film} s, film ${cue.now.toFixed(1)} s)`);
  await press("ArrowRight");
  await page.waitForTimeout(2500);
  const afterSeek = await page.evaluate(() => window.__chillEngine.now());
  cue = await cueSync();
  check(cue.now >= cue.film - 0.1 && cue.now <= cue.film + 3.1, `still in sync after seeking (cue ${cue.film} s, film ${cue.now.toFixed(1)} s)`);
  await press("ArrowDown");
  await page.waitForSelector("[data-testid=subtitle-menu]");
  await press("ArrowUp"); // from English to Off
  await press("Enter");
  await page.waitForTimeout(500);
  const offNow = await page.evaluate(() => ({ showing: Array.from(window.__chillEngine.active.textTracks).filter((x) => x.mode !== "disabled").length + (document.querySelector("[data-testid=subtitle-text]") ? 1 : 0), label: document.querySelector("[data-testid=subtitle-label]")?.textContent }));
  check(offNow.showing === 0 && offNow.label === "Subtitles: Off", "the menu turns subtitles off with the remote");
  check(/Stereo · converted/.test((await page.textContent("[data-testid=audio-label]")) ?? ""), "audio line says it's converted for this device");
  check(afterSeek > aud.now + 8, `seeking works on the compat stream (${aud.now.toFixed(1)} s → ${afterSeek.toFixed(1)} s)`);
  await press("Escape");
  await page.waitForTimeout(800);

  console.log("click to scrub");
  await page.goto(`${base}/watch/949`);
  await page.waitForFunction(() => { const v = document.querySelector("video[data-active]"); return v && !v.paused && v.currentTime > 0.5; }, null, { timeout: 60000 });
  await page.mouse.move(960, 540); // pointer activity shows the controls
  const bar = await page.locator("[data-testid=scrubber]").boundingBox();
  const durS = await page.evaluate(() => window.__chillEngine.duration());
  await page.mouse.move(bar.x + bar.width * 0.25, bar.y + bar.height / 2);
  const tip = await page.textContent("[data-testid=scrub-time]");
  await page.mouse.click(bar.x + bar.width * 0.25, bar.y + bar.height / 2);
  await page.waitForTimeout(800);
  const clicked = await page.evaluate(() => ({ now: window.__chillEngine.now(), paused: window.__chillEngine.active.paused }));
  check(Math.abs(clicked.now - durS * 0.25) < 2 && !clicked.paused, `click at 25% seeks to ${clicked.now.toFixed(1)} s of ${durS.toFixed(0)} (preview said ${tip}) and keeps playing`);
  await page.mouse.move(bar.x + bar.width * 0.25, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(bar.x + bar.width * 0.6, bar.y + bar.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const dragged = await page.evaluate(() => window.__chillEngine.now());
  check(Math.abs(dragged - durS * 0.6) < 2, `drag to 60% scrubs to ${dragged.toFixed(1)} s`);
  await press("Escape");
  await page.waitForTimeout(800);

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
