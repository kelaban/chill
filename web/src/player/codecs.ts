import type { StreamInfo } from "@chill/shared";

// What can *this* device decode? Asked of the browser with canPlayType, which
// is honest about codecs it can't decode (desktop Chrome: AC3/E-AC3/DTS → "").
// Unknown codecs return null: try the file directly and let the safety net
// (no audio bytes decoded) catch it.

const AUDIO_MIME: Record<string, string> = {
  aac: 'audio/mp4; codecs="mp4a.40.2"',
  ac3: 'audio/mp4; codecs="ac-3"',
  eac3: 'audio/mp4; codecs="ec-3"',
  dts: 'audio/mp4; codecs="dtsc"',
  truehd: 'audio/mp4; codecs="mlpa"',
  opus: 'audio/webm; codecs="opus"',
  mp3: "audio/mpeg",
  flac: "audio/flac",
};

const probe = () => document.createElement("video");

export function canDecodeAudio(codec: string | null): boolean | null {
  if (!codec) return null;
  const mime = AUDIO_MIME[codec];
  if (!mime) return null;
  return probe().canPlayType(mime) !== "";
}

export function canOpenContainer(container: string | null): boolean | null {
  if (!container) return null;
  if (container === "mp4") return true;
  if (container === "mkv") return probe().canPlayType("video/x-matroska") !== "" || probe().canPlayType('video/webm; codecs="vp9"') !== "" ? null : false;
  return null;
}

/** Should this stream go through the server's compat remux (AAC audio, MP4) instead of direct play? */
export function needsCompat(s: StreamInfo): boolean {
  if (s.kind !== "file") return false;
  return canDecodeAudio(s.audioCodec) === false || canOpenContainer(s.container) === false;
}

/** Chrome/Edge expose decoded byte counters; elsewhere this returns null (unknown). */
export function audioIsSilent(v: HTMLVideoElement): boolean | null {
  const a = (v as unknown as { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount;
  const vid = (v as unknown as { webkitVideoDecodedByteCount?: number }).webkitVideoDecodedByteCount;
  if (typeof a !== "number" || typeof vid !== "number") return null;
  return a === 0 && vid > 0;
}
