import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import type { Ctx } from "../context.js";
import { runProcess } from "../media/ffmpeg.js";
import { log } from "../log.js";
import { mediaInput } from "./media.js";
import type { VariantRow } from "./storage.js";

// "Compat" stream: the same file, repackaged on the fly for players that can't
// decode its audio (desktop Chrome and AC3/E-AC3/DTS/TrueHD) or its container
// (MKV in Safari). Video is copied untouched — no quality loss, almost no CPU —
// and audio becomes stereo AAC. Output is fragmented MP4 piped to the player.
//
// The browser's clock for such a stream starts at 0, so the player keeps an
// offset: it asks /compat-start for the keyframe at or before the wanted time,
// then plays /compat?start=<keyframe>, knowing exactly where 0 is.

/** Latest video keyframe at or before `t` (seconds), read from packet flags only. */
export async function keyframeAtOrBefore(input: string, t: number): Promise<number> {
  if (t <= 0.5) return 0;
  const from = Math.max(0, t - 20);
  try {
    const { stdout } = await runProcess(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-read_intervals", `${from}%${t + 0.05}`, "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", input],
      { timeoutMs: 30_000 },
    );
    let best = -1;
    for (const line of stdout.toString().split("\n")) {
      const [pts, flags] = line.split(",");
      const x = Number(pts);
      if (flags?.startsWith("K") && Number.isFinite(x) && x <= t + 0.001 && x > best) best = x;
    }
    return best >= 0 ? best : Math.max(0, t - 10);
  } catch (err) {
    log.warn("keyframe probe failed", { err });
    return t;
  }
}

export async function compatStart(ctx: Ctx, v: VariantRow, t: number): Promise<number> {
  return keyframeAtOrBefore(await mediaInput(ctx, v), Math.max(0, t));
}

/** Spawn the remux and return a streaming Response; the process dies with the request. */
export async function compatResponse(ctx: Ctx, v: VariantRow, start: number, signal: AbortSignal): Promise<Response> {
  const input = await mediaInput(ctx, v);
  const hevc = (v.video_codec ?? "").toLowerCase().includes("hevc") || (v.video_codec ?? "").includes("265");
  const args = [
    "-v", "error", "-nostdin",
    ...(start > 0 ? ["-ss", String(start)] : []),
    "-i", input,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "copy", ...(hevc ? ["-tag:v", "hvc1"] : []),
    "-c:a", "aac", "-ac", "2", "-b:a", "192k",
    "-sn", "-dn",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4", "pipe:1",
  ];
  const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  ff.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
  ff.on("close", (code) => {
    if (code && code !== 255 && !signal.aborted) log.warn("compat remux exited", { code, variant: v.id, err: err.split("\n").slice(-3).join(" ") });
  });
  signal.addEventListener("abort", () => ff.kill("SIGKILL"));
  return new Response(Readable.toWeb(ff.stdout) as ReadableStream, {
    status: 200,
    headers: { "Content-Type": "video/mp4", "Cache-Control": "no-store", "X-Chill-Start": String(start) },
  });
}
