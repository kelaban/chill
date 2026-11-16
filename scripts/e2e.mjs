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
  await page.waitForFunction(() => document.querySelector("[data-focused=true]")?.getAttribute("data-testid")?.startsWith("card-"));
  check(!(await page.$("[data-testid=hero]")), "nothing to resume yet: no hero");
  check((await focused())?.startsWith("card-"), "home opens with the first row focused");
  await press("ArrowRight", 2);
  const card = await focused();
  check(card?.startsWith("card-"), `Right moves along the row (${card})`);
  await press("Enter");
  await page.waitForSelector("[data-testid=detail-title]");
  check(true, "OK opens the detail page");
  await page.keyboard.down("Escape"), await page.keyboard.up("Escape");
  await page.waitForSelector("[data-row]");
  check(true, "Back returns home");
  await page.screenshot({ path: path.join(out, "home.png") });

  console.log("pointer-only browsing (Magic Remote)");
  const scrollY = () => page.evaluate(() => { const r = document.getElementById("root"); return r && r.scrollHeight > r.clientHeight ? r.scrollTop : document.scrollingElement.scrollTop; });
  await page.mouse.move(960, 300, { steps: 3 });
  const low = await page.evaluate(() => {
    const c = [...document.querySelectorAll("[data-testid^=card-]")].map((e) => ({ id: e.getAttribute("data-testid"), r: e.getBoundingClientRect() })).find((x) => x.r.top > 650 && x.r.top < 1000 && x.r.left > 80 && x.r.right < 1800);
    return c ? { id: c.id, x: c.r.left + c.r.width / 2, y: Math.min(1070, c.r.top + 40) } : null;
  });
  const y0 = await scrollY();
  if (low) {
    await page.mouse.move(low.x, low.y, { steps: 6 });
    await page.waitForTimeout(800);
    check((await scrollY()) === y0 && (await focused()) === low.id, `hovering a card low on screen highlights it without scrolling (${low.id}, page stays at ${y0}px)`);
    const rowId = await page.evaluate((id) => document.querySelector(`[data-testid=${id}]`).closest("[data-row]").getAttribute("data-row"), low.id);
    const paddle = await page.$(`[data-testid=paddle-next-${rowId}]`);
    check(!!paddle && (await paddle.isVisible()), `the row shows a › paddle for the pointer (${rowId})`);
    if (paddle) {
      const before = await page.evaluate((r) => document.querySelector(`[data-row=${r}] .no-scrollbar`).scrollLeft, rowId);
      await paddle.click();
      await page.waitForTimeout(900);
      const after = await page.evaluate((r) => document.querySelector(`[data-row=${r}] .no-scrollbar`).scrollLeft, rowId);
      check(after - before > 600 && after - before < 1700, `› pages the row by most of a screen (${before} → ${after}px)`);
      check((await scrollY()) === y0, "…and the page itself stays put");
    }
  } else check(false, "found a card low on the home screen to hover");
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(600);
  const y1 = await scrollY();
  check(y1 > y0 + 200 && y1 < y0 + 900, `the wheel scrolls the page a step (${y0} → ${y1}px)`);
  await press("ArrowDown");
  check(!(await page.evaluate(() => document.documentElement.classList.contains("pointer"))) && !(await page.$("[data-testid^=paddle-]:visible")), "a key press hides the pointer-only paddles");
  await page.screenshot({ path: path.join(out, "home-pointer.png") });

  console.log("where it streams");
  await page.goto(`${base}/title/438631`);
  await page.waitForSelector("[data-testid=services]");
  const dune = await page.$eval("[data-testid=services]", (e) => ({ text: e.textContent, source: e.getAttribute("data-source") }));
  check(dune.source === "tmdb" && /On\s*HBO Max/.test(dune.text) && /JustWatch/.test(dune.text), `TMDB says Dune is on HBO Max, credited to JustWatch (${dune.text})`);
  await page.goto(`${base}/title/496243`);
  await page.waitForSelector("[data-testid=services]");
  check(/Rent or buy on/.test(await page.textContent("[data-testid=services]")), "nothing streams Parasite: rent or buy");
  await page.goto(`${base}/title/949`);
  await page.waitForFunction(() => document.querySelector("[data-testid=services]")?.getAttribute("data-source") === "releases", null, { timeout: 20000 });
  check(/Netflix/.test(await page.textContent("[data-testid=services]")), "no TMDB data for Heat: falls back to the release tags (Netflix)");

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

  console.log("scrub previews");
  // This replay came from put.io again (playing Parasite emptied the home cache); previews follow its new home copy.
  for (let i = 0; i < 60; i++) {
    const id = await page.evaluate(() => window.__chillEngine.variantId);
    if ((await fetch(`${base}/api/stream/${id}/trickplay`)).ok) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(1500); // the player hears about them over SSE, without a reload
  await page.mouse.move(960, 400);
  await page.mouse.move(bar.x + bar.width * 0.4, bar.y + bar.height / 2, { steps: 4 });
  const thumb = await page.waitForSelector("[data-testid=scrub-thumb]", { timeout: 5000 }).catch(() => null);
  const why = thumb ? "" : await page.evaluate(async () => { const id = window.__chillEngine.variantId; const r = await fetch(`/api/stream/${id}/trickplay`); return ` (playing ${id}: manifest ${r.status}; tip ${document.querySelector("[data-testid=scrub-time]")?.textContent ?? "none"})`; });
  check(!!thumb, `hovering the bar shows a preview picture${why}`);
  if (thumb) {
    const sheet = await thumb.getAttribute("data-sheet");
    const r = await page.evaluate(async (u) => { const res = await fetch(u); return { status: res.status, type: res.headers.get("content-type") }; }, sheet);
    check(r.status === 200 && r.type === "image/jpeg", `the preview sheet loads (${sheet})`);
    await page.screenshot({ path: path.join(out, "scrub-preview.png") });
  }
  await page.mouse.click(bar.x + bar.width * 0.25, bar.y + bar.height / 2); // back to 25%, well clear of the end
  await page.mouse.move(bar.x + bar.width * 0.4, bar.y - 300); // off the bar
  await page.waitForTimeout(1000);
  const beforeRemote = await page.evaluate(() => window.__chillEngine.now());
  await press("ArrowRight", 3);
  await page.waitForSelector("[data-testid=scrub-time]");
  const shownTarget = await page.textContent("[data-testid=scrub-time]");
  const midway = await page.evaluate(() => window.__chillEngine.now());
  check(Math.abs(midway - beforeRemote) < 2 && !!(await page.$("[data-testid=scrub-thumb]")), `Right ×3 shows a target (${shownTarget}) with its preview, without seeking yet`);
  await page.waitForTimeout(1500);
  const afterRemote = await page.evaluate(() => window.__chillEngine.now());
  check(afterRemote > beforeRemote + 27 && afterRemote < beforeRemote + 34, `…then seeks once, 30 s ahead (${beforeRemote.toFixed(1)} → ${afterRemote.toFixed(1)} s)`);
  await press("Escape");
  await page.waitForTimeout(800);

  console.log("TV shows");
  await page.goto(`${base}/`);
  await page.waitForSelector("[data-testid=nav-tv-shows]");
  await page.click("[data-testid=nav-tv-shows]");
  await page.waitForSelector("[data-testid=row-tv-netflix]");
  check(true, "TV Shows lists shows by service");
  await page.click("[data-testid=card-tt4574334]");
  await page.waitForSelector("[data-testid=show-title]");
  await page.waitForFunction(() => document.querySelector("[data-focused=true]")?.getAttribute("data-testid") === "show-play");
  check((await page.textContent("[data-testid=show-play]"))?.includes("Play S1 E1"), "show page offers Play S1 E1");
  check((await page.locator("[data-testid=episodes] [role=button]").count()) === 3, "season 1 lists its 3 episodes");
  await press("Enter");
  await page.waitForFunction(() => { const v = document.querySelector("video[data-active]"); return v && v.currentTime > 0.5; }, null, { timeout: 60000 });
  const ep1 = page.url();
  check(/\/watch\/-\d+$/.test(ep1), "the episode plays");
  // Jump to the end: the next episode was prefetched halfway, and rolls in after the Up next card.
  await page.evaluate(() => window.__chillEngine.seekTo(window.__chillEngine.duration() - 1.5));
  await page.waitForSelector("[data-testid=up-next]", { timeout: 15000 });
  check((await page.textContent("[data-testid=up-next]"))?.includes("S1 E2"), "Up next: S1 E2");
  await page.waitForFunction((u) => location.href !== u && /\/watch\/-\d+$/.test(location.pathname), ep1, { timeout: 15000 });
  await page.waitForFunction(() => { const v = document.querySelector("video[data-active]"); return v && v.currentTime > 0.5; }, null, { timeout: 60000 });
  check(true, "the next episode starts by itself");
  await press("Escape");
  await page.waitForTimeout(800);

  console.log("resume");
  const st = await (await fetch(`${base}/api/titles/949/play?profile=1`)).json();
  check(st.phase === "ready" && st.stream.startAtS > 10, `resume point kept (${st.stream?.startAtS?.toFixed(1)} s on ${st.stream?.label})`);
  console.log("Resume hero");
  const homeNow = await (await fetch(`${base}/api/home?profile=1`)).json();
  await page.goto(`${base}/`);
  if (homeNow.hero) {
    await page.waitForFunction(() => document.querySelector("[data-focused=true]")?.getAttribute("data-testid") === "hero-play", null, { timeout: 10000 }).catch(() => null);
    const heroTitle = await page.textContent("[data-testid=hero-title]").catch(() => null);
    check(heroTitle === homeNow.hero.title && (await focused()) === "hero-play", `Home leads with ${heroTitle}, Resume focused (${await page.textContent("[data-testid=hero-left]").catch(() => "")})`);
    await page.screenshot({ path: path.join(out, "home-resume.png") });
    await press("Enter");
    await page.waitForFunction(() => { const v = document.querySelector("video[data-active]"); return v && v.currentTime > 0.2; }, null, { timeout: 60000 });
    const resumedAt = await page.evaluate(() => window.__chillEngine.now());
    check(resumedAt > homeNow.hero.positionS - 10, `Resume continues from ${homeNow.hero.positionS.toFixed(0)} s (now ${resumedAt.toFixed(1)} s)`);
    await press("Escape");
    await page.waitForTimeout(800);
  } else check(false, "something is unfinished by now, so Home should have a Resume hero");

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join("; ")}` : ""}`);
  await browser.close();
} catch (err) {
  failures.push(String(err));
  console.error(err);
} finally {
  fs.writeFileSync(path.join(out, "server.log"), log); // for diagnosing a failed run
  server.kill("SIGTERM");
  fs.rmSync(data, { recursive: true, force: true });
}
if (failures.length) {
  console.log(`\n${failures.length} e2e check(s) failed`);
  process.exit(1);
}
console.log("\nall e2e checks passed");
