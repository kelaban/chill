import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasFfmpeg, runProcess, trickplaySheets } from "../src/media/ffmpeg.js";

const ffmpeg = await hasFfmpeg();

describe.skipIf(!ffmpeg)("scrub-preview sheets (real ffmpeg)", () => {
  it("tile i shows the moment i·interval (within one keyframe gap), never a whole interval late", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chill-tp-"));
    const clip = path.join(dir, "ramp.mp4");
    // Brightness = 2·t (t in seconds): a tile's mean luma says which moment it shows.
    // Keyframes every 3 s, so the 10 s marks fall between them.
    await runProcess("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=24:d=100", "-vf", "format=gray,geq=lum='2*T':cb=128:cr=128,format=yuv420p",
      "-c:v", "libx264", "-preset", "ultrafast", "-g", "72", "-sc_threshold", "0", clip,
    ]);
    const out = path.join(dir, "sheets");
    fs.mkdirSync(out);
    const sheets = await trickplaySheets(clip, out, { intervalS: 10, width: 160, height: 90, cols: 10, rows: 10 }, false);
    expect(sheets).toBe(1);
    const { stdout } = await runProcess("ffmpeg", ["-v", "error", "-i", path.join(out, "001.jpg"), "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
    const W = 1600;
    const meanOfTile = (i: number) => {
      let sum = 0;
      for (let y = 20; y < 70; y++) for (let x = 40; x < 120; x++) sum += stdout[(y + Math.floor(i / 10) * 90) * W + (i % 10) * 160 + x]!;
      return sum / (50 * 80);
    };
    for (let i = 1; i < 10; i++) {
      const shownS = meanOfTile(i) / 2;
      expect(shownS, `tile ${i}`).toBeGreaterThan(10 * i - 3.6); // at most one 3 s keyframe gap early (+ JPEG noise)
      expect(shownS, `tile ${i}`).toBeLessThan(10 * i + 0.6);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
