import fs from "node:fs";
import path from "node:path";
import { runProcess } from "../media/ffmpeg.js";

// Generated stand-in "films" for demo mode and the e2e tests. Both copies show
// the same synthetic film: a moving test pattern whose hue jumps every 20 s
// (scene cuts), over a deterministic noise soundtrack (so audio alignment has
// something to lock onto). The target copy adds a 2.5 s lead-in, like a release
// with an extra studio logo, so the seamless handoff has a real offset to fix.

export const SAMPLE_SECONDS = 180;
export const TARGET_LEAD_IN_S = 2.5;

export interface Samples {
  instant: string;
  target: string;
  /** Like `instant`, but MKV with E-AC3 5.1 audio — what most real releases look like, and what desktop Chrome can't decode. */
  instantEac3: string;
}

export async function ensureSamples(dir: string, seconds = SAMPLE_SECONDS): Promise<Samples> {
  fs.mkdirSync(dir, { recursive: true });
  // v2: the target copy carries an embedded English subtitle track (mov_text).
  const out = { instant: path.join(dir, `instant-${seconds}.mp4`), target: path.join(dir, `target-v2-${seconds}.mp4`), instantEac3: path.join(dir, `instant-eac3-${seconds}.mkv`) };
  if (fs.existsSync(out.instant) && fs.existsSync(out.target) && fs.existsSync(out.instantEac3)) return out;

  const film = path.join(dir, "film.wav");
  const lead = path.join(dir, "lead.wav");
  await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `anoisesrc=d=${seconds}:c=pink:r=48000:a=0.25:seed=42`, film]);
  await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `anoisesrc=d=${TARGET_LEAD_IN_S}:c=brown:r=48000:a=0.25:seed=7`, lead]);

  const font = ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"].find((f) => fs.existsSync(f));
  const text = (label: string, size: number) =>
    font
      ? `,drawtext=fontfile=${font}:text='${label}':x=40:y=40:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=12` +
        `,drawtext=fontfile=${font}:text='%{pts\\:hms}':x=40:y=h-th-40:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=12`
      : "";
  const pattern = (w: number, h: number, label: string) =>
    `testsrc2=size=${w}x${h}:rate=24:duration=${seconds},hue=h='floor(t/20)*67':s=1.3,eq=eval=frame:brightness='0.25*mod(floor(t/20),2)-0.1':contrast='1+0.4*mod(floor(t/20),2)'${text(label, Math.round(h / 14))}`;

  const enc = ["-c:v", "libx264", "-preset", "veryfast", "-profile:v", "main", "-pix_fmt", "yuv420p", "-g", "48", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart"];

  await runProcess("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", pattern(640, 360, "INSTANT 360p"), "-i", film, "-shortest", ...enc, "-b:v", "500k", out.instant]);

  const embedded = path.join(dir, "embedded-en.srt");
  fs.writeFileSync(embedded, sampleSubtitles("en", seconds, TARGET_LEAD_IN_S, "srt", "EMBEDDED"));
  await runProcess("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `color=c=black:size=1280x720:rate=24:duration=${TARGET_LEAD_IN_S}`,
    "-f", "lavfi", "-i", pattern(1280, 720, "TARGET 720p"),
    "-i", lead, "-i", film, "-i", embedded,
    "-filter_complex", "[0:v][2:a][1:v][3:a]concat=n=2:v=1:a=1[v][a]",
    "-map", "[v]", "-map", "[a]", "-map", "4:s", ...enc, "-b:v", "1500k",
    "-c:s", "mov_text", "-metadata:s:s:0", "language=eng", out.target,
  ]);
  // Same picture, E-AC3 5.1 audio in MKV.
  await runProcess("ffmpeg", ["-y", "-v", "error", "-i", out.instant, "-map", "0:v", "-map", "0:a", "-c:v", "copy", "-c:a", "eac3", "-ac", "6", "-b:a", "384k", out.instantEac3]);
  return out;
}

/**
 * Subtitles for the generated film: a cue every 4 s naming the film time, so a
 * test (or a person) can see they're in sync. `leadIn` shifts them onto a copy
 * whose timeline starts later (the target copy's 2.5 s lead-in).
 */
export function sampleSubtitles(lang: string, seconds: number, leadIn = 0, format: "srt" | "webvtt" = "srt", tag = ""): string {
  const ts = (t: number, sep: string) => {
    const ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000), s = Math.floor((ms % 60_000) / 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(ms % 1000).padStart(3, "0")}`;
  };
  const words: Record<string, string> = { en: "Line", es: "Línea", ko: "줄" };
  const out: string[] = format === "webvtt" ? ["WEBVTT", ""] : [];
  let n = 1;
  for (let t = 1; t + 3 <= seconds; t += 4, n++) {
    const film = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
    const sep = format === "webvtt" ? "." : ",";
    if (format === "srt") out.push(String(n));
    out.push(`${ts(t + leadIn, sep)} --> ${ts(t + 3 + leadIn, sep)}`, `${tag ? `${tag} ` : ""}[${lang.toUpperCase()}] ${words[lang] ?? "Line"} ${n} · ${film}`, "");
  }
  return out.join("\n");
}
