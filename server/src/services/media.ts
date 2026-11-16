import path from "node:path";
import type { Ctx } from "../context.js";
import type { VariantRow } from "./storage.js";

/** Something ffmpeg can read for a variant: a local path or a fresh put.io URL. */
export async function mediaInput(ctx: Ctx, v: VariantRow): Promise<string> {
  if (v.location === "local") {
    if (!v.local_path) throw new Error(`variant ${v.id} has no path`);
    return path.join(ctx.cfg.libraryDir, v.local_path);
  }
  if (!v.putio_file_id) throw new Error(`variant ${v.id} has no put.io file`);
  if (ctx.fake) {
    const p = ctx.fake.putio.mediaPath(v.putio_file_id);
    if (p) return p;
  }
  const url = await ctx.svc.putio.downloadUrl(v.putio_file_id);
  return url.startsWith("/") ? ctx.selfBase + url : url;
}

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mkv": "video/x-matroska", ".webm": "video/webm", ".mov": "video/quicktime", ".ts": "video/mp2t", ".avi": "video/x-msvideo",
};
export const contentTypeFor = (file: string) => TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
