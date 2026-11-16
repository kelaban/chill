import fs from "node:fs";
import { http } from "../http.js";

// Resumable, multi-connection HTTP download (replaces aria2c; see
// documentation/DECISIONS.md). Progress per segment is checkpointed next to
// the partial file, so a restart continues where it stopped.

interface Segment {
  start: number;
  end: number; // inclusive
  done: number; // bytes completed from `start`
}

interface Checkpoint {
  url: string;
  size: number;
  segments: Segment[];
}

export interface DownloadOptions {
  connections?: number;
  onProgress?: (doneBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
  /** Throttle (bytes/s) — used by demo mode to look like a real download. */
  maxBytesPerSec?: number;
}

async function headInfo(url: string): Promise<{ size: number; ranges: boolean }> {
  const res = await http(url, { headers: { Range: "bytes=0-0" }, timeoutMs: 30_000 });
  if (res.status === 206) {
    const total = /\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1];
    await res.body?.cancel();
    if (total) return { size: Number(total), ranges: true };
  }
  if (!res.ok) throw new Error(`download probe → HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  await res.body?.cancel();
  return { size: len, ranges: false };
}

export async function download(url: string, dest: string, opts: DownloadOptions = {}): Promise<{ bytes: number }> {
  const ckFile = `${dest}.json`;
  let ck: Checkpoint | null = null;
  if (fs.existsSync(ckFile) && fs.existsSync(dest)) {
    try {
      ck = JSON.parse(fs.readFileSync(ckFile, "utf8")) as Checkpoint;
    } catch {
      ck = null;
    }
  }
  const info = await headInfo(url);
  if (!ck || ck.size !== info.size) {
    const n = info.ranges ? Math.max(1, Math.min(opts.connections ?? 8, Math.ceil(info.size / 8e6))) : 1;
    const per = Math.ceil(info.size / n);
    ck = { url: "", size: info.size, segments: Array.from({ length: n }, (_, i) => ({ start: i * per, end: Math.min(info.size, (i + 1) * per) - 1, done: 0 })) };
    fs.writeFileSync(dest, "");
    if (info.size > 0) fs.truncateSync(dest, info.size);
  }
  const fd = await fs.promises.open(dest, "r+");
  const save = () => fs.writeFileSync(ckFile, JSON.stringify(ck));
  let lastSave = 0;
  const total = () => ck!.segments.reduce((s, g) => s + g.done, 0);
  const startedAt = Date.now();
  const startBytes = total();

  async function runSegment(g: Segment) {
    let failures = 0;
    while (g.start + g.done <= g.end) {
      if (opts.signal?.aborted) throw new Error("aborted");
      const from = g.start + g.done;
      try {
        const res = await http(url, {
          headers: info.ranges ? { Range: `bytes=${from}-${g.end}` } : {},
          timeoutMs: 600_000,
          signal: opts.signal,
        });
        if (!res.ok || !res.body) throw new Error(`download → HTTP ${res.status}`);
        for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
          await fd.write(chunk, 0, chunk.length, g.start + g.done);
          g.done += chunk.length;
          failures = 0;
          opts.onProgress?.(total(), ck!.size);
          if (Date.now() - lastSave > 1000) (save(), (lastSave = Date.now()));
          if (opts.maxBytesPerSec) {
            const ahead = (total() - startBytes) / opts.maxBytesPerSec - (Date.now() - startedAt) / 1000;
            if (ahead > 0) await new Promise((r) => setTimeout(r, ahead * 1000));
          }
        }
      } catch (err) {
        // Dropped connections are normal on long downloads: resume this segment.
        if (opts.signal?.aborted || !info.ranges || ++failures > 5) throw err;
        await new Promise((r) => setTimeout(r, 200 * 2 ** failures));
        continue;
      }
      if (!info.ranges) break;
    }
  }

  try {
    await Promise.all(ck.segments.map(runSegment));
  } finally {
    save();
    await fd.close();
  }
  const bytes = (await fs.promises.stat(dest)).size;
  if (bytes !== info.size || total() < info.size) throw new Error(`download incomplete: ${total()}/${info.size} bytes`);
  fs.rmSync(ckFile, { force: true });
  return { bytes };
}
