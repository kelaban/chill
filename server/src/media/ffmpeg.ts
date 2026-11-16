import { spawn } from "node:child_process";
import type { DynamicRange } from "@chill/shared";

// Thin wrappers around ffprobe/ffmpeg. Inputs may be local paths or HTTP(S)
// URLs (ffmpeg range-reads remote files, so we never download a put.io copy
// just to align it).

function run(cmd: string, args: string[], opts: { stdout?: "buffer" | "text"; timeoutMs?: number } = {}): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
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
}

export async function probe(input: string): Promise<Probe> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", input], { timeoutMs: 60_000 });
  const j = JSON.parse(stdout.toString()) as { format?: any; streams?: any[] };
  const v = j.streams?.find((s) => s.codec_type === "video");
  const a = j.streams?.find((s) => s.codec_type === "audio");
  const dovi = (v?.side_data_list ?? []).some((s: any) => String(s.side_data_type).includes("DOVI"));
  const pq = v?.color_transfer === "smpte2084";
  return {
    durationS: j.format?.duration ? Number(j.format.duration) : null,
    container: j.format?.format_name ?? null,
    videoCodec: v?.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
    width: v?.width ?? null,
    height: v?.height ?? null,
    dynamicRange: dovi ? "DV" : pq ? "HDR10" : "SDR",
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

export async function hasFfmpeg(): Promise<boolean> {
  try {
    await run("ffmpeg", ["-version"], { timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}

export { run as runProcess };
