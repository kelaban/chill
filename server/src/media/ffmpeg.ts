import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import type { DynamicRange } from "@chill/shared";

// Thin wrappers around ffprobe/ffmpeg. Inputs may be local paths or HTTP(S)
// URLs (ffmpeg range-reads remote files, so we never download a put.io copy
// just to align it).

function run(cmd: string, args: string[], opts: { stdout?: "buffer" | "text"; timeoutMs?: number; nice?: number } = {}): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    if (opts.nice && p.pid)
      try {
        os.setPriority(p.pid, opts.nice); // background work yields to playback and the compat remux
      } catch {}
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), opts.timeoutMs ?? 300_000);
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      if (err.length > 4_000_000) err = err.slice(-2_000_000);
    });
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new Error(`${cmd} exited ${code}: ${err.split("\n").slice(-4).join(" ")}`));
    });
  });
}

export interface Probe {
  durationS: number | null;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  dynamicRange: DynamicRange;
  audioChannels: number | null;
  /** Subtitle streams, in order (`index` is N in `-map 0:s:N`). */
  subtitles: ProbeSubtitle[];
}

export interface ProbeSubtitle {
  index: number;
  codec: string;
  /** Text tracks can become WebVTT; image tracks (PGS, VobSub) can't. */
  text: boolean;
  language: string | null;
  title: string | null;
  forced: boolean;
  sdh: boolean;
  default: boolean;
}

const TEXT_SUB_CODECS = new Set(["subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text", "tx3g"]);

export async function probe(input: string): Promise<Probe> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", input], { timeoutMs: 60_000 });
  const j = JSON.parse(stdout.toString()) as { format?: any; streams?: any[] };
  const v = j.streams?.find((s) => s.codec_type === "video");
  const a = j.streams?.find((s) => s.codec_type === "audio");
  const dovi = (v?.side_data_list ?? []).some((s: any) => String(s.side_data_type).includes("DOVI"));
  const pq = v?.color_transfer === "smpte2084";
  const subs = (j.streams ?? []).filter((s) => s.codec_type === "subtitle");
  return {
    durationS: j.format?.duration ? Number(j.format.duration) : null,
    container: j.format?.format_name ?? null,
    videoCodec: v?.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
    width: v?.width ?? null,
    height: v?.height ?? null,
    dynamicRange: dovi ? "DV" : pq ? "HDR10" : "SDR",
    audioChannels: a?.channels ?? null,
    subtitles: subs.map((s, index) => {
      const title: string | null = s.tags?.title ?? null;
      const t = (title ?? "").toLowerCase();
      return {
        index,
        codec: String(s.codec_name ?? "unknown"),
        text: TEXT_SUB_CODECS.has(String(s.codec_name)),
        language: s.tags?.language ?? null,
        title,
        forced: s.disposition?.forced === 1 || t.includes("forced"),
        sdh: s.disposition?.hearing_impaired === 1 || /\bsdh\b|hearing/.test(t),
        default: s.disposition?.default === 1,
      };
    }),
  };
}

/** Mono float PCM at `rate` Hz for [startS, startS + durS). */
export async function extractPcm(input: string, startS: number, durS: number, rate = 8000): Promise<Float32Array> {
  const { stdout } = await run(
    "ffmpeg",
    ["-v", "error", "-ss", String(Math.max(0, startS)), "-t", String(durS), "-i", input, "-vn", "-ac", "1", "-ar", String(rate), "-f", "f32le", "pipe:1"],
    { timeoutMs: 120_000 },
  );
  // Copy into an aligned buffer.
  const ab = new ArrayBuffer(stdout.length - (stdout.length % 4));
  new Uint8Array(ab).set(stdout.subarray(0, ab.byteLength));
  return new Float32Array(ab);
}

export interface Cuts {
  /** Scene changes, absolute seconds in the input's timeline. */
  scenes: number[];
  black: { start: number; end: number }[];
}

/** Scene cuts and black segments over [startS, startS + durS), on a downscaled decode. */
export async function detectCuts(input: string, startS: number, durS: number, threshold = 10): Promise<Cuts> {
  const { stderr } = await run(
    "ffmpeg",
    [
      "-hide_banner", "-nostats", "-ss", String(Math.max(0, startS)), "-t", String(durS), "-i", input, "-an",
      "-vf", `scale=320:-2,scdet=threshold=${threshold},blackdetect=d=0.1:pix_th=0.10,metadata=print:key=lavfi.scd.time`,
      "-f", "null", "-",
    ],
    { timeoutMs: 600_000 },
  );
  const base = Math.max(0, startS);
  const scenes = [...stderr.matchAll(/lavfi\.scd\.time=([\d.]+)/g)].map((m) => base + Number(m[1]));
  const black = [...stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)].map((m) => ({ start: base + Number(m[1]), end: base + Number(m[2]) }));
  return { scenes: [...new Set(scenes.map((s) => Math.round(s * 1000) / 1000))].sort((a, b) => a - b), black };
}

/** One text subtitle stream as WebVTT (reads the whole file: use on local copies). */
export async function extractSubtitle(input: string, index: number): Promise<string> {
  const { stdout } = await run("ffmpeg", ["-v", "error", "-nostdin", "-i", input, "-map", `0:s:${index}`, "-f", "webvtt", "pipe:1"], { timeoutMs: 600_000 });
  return stdout.toString("utf8");
}

export interface SheetLayout {
  intervalS: number;
  width: number;
  height: number;
  cols: number;
  rows: number;
}

/**
 * Scrub-preview sheets: a frame every `intervalS` (keyframes only, so it's a
 * fast decode), scaled to `width`, tiled cols×rows into `outDir/NNN.jpg`.
 * Frame i shows the keyframe at or just before i·intervalS (`round=up`; the
 * default takes the *last* keyframe of each window, up to a whole interval late). HDR is tone-mapped to SDR, falling back to
 * plain scaling if this ffmpeg can't. Returns the number of sheets written.
 */
export async function trickplaySheets(input: string, outDir: string, l: SheetLayout, hdr: boolean): Promise<number> {
  const scale = `scale=${l.width}:${l.height}:flags=bilinear`;
  const tonemap = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";
  const attempt = (vf: string) =>
    run(
      "ffmpeg",
      [
        "-v", "error", "-nostdin", "-y", "-threads", "2", "-skip_frame", "nokey", "-i", input, "-an", "-sn", "-dn", "-map", "0:v:0",
        "-vf", `fps=1/${l.intervalS}:round=up,${vf},tile=${l.cols}x${l.rows}`, "-fps_mode", "vfr", "-q:v", "6", `${outDir}/%03d.jpg`,
      ],
      { timeoutMs: 3_600_000, nice: 10 },
    );
  if (hdr) await attempt(`${scale},${tonemap}`).catch(() => attempt(scale));
  else await attempt(scale);
  return (await fs.promises.readdir(outDir)).filter((f) => /^\d{3}\.jpg$/.test(f)).length;
}

export async function hasFfmpeg(): Promise<boolean> {
  try {
    await run("ffmpeg", ["-version"], { timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}

export { run as runProcess };
