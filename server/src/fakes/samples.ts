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
}

export async function ensureSamples(dir: string, seconds = SAMPLE_SECONDS): Promise<Samples> {
  fs.mkdirSync(dir, { recursive: true });
  const out = { instant: path.join(dir, `instant-${seconds}.mp4`), target: path.join(dir, `target-${seconds}.mp4`) };
  if (fs.existsSync(out.instant) && fs.existsSync(out.target)) return out;

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

  await runProcess("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", `color=c=black:size=1280x720:rate=24:duration=${TARGET_LEAD_IN_S}`,
    "-f", "lavfi", "-i", pattern(1280, 720, "TARGET 720p"),
    "-i", lead, "-i", film,
    "-filter_complex", "[0:v][2:a][1:v][3:a]concat=n=2:v=1:a=1[v][a]",
    "-map", "[v]", "-map", "[a]", ...enc, "-b:v", "1500k", out.target,
  ]);
  return out;
}
