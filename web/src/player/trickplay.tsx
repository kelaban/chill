import type { TrickplayManifest } from "@chill/shared";

/** Which tile of which sheet shows player time `t` (mapped onto the sheets' file). */
export function thumbAt(m: TrickplayManifest, t: number): { sheet: string; x: number; y: number } | null {
  if (!m.count || !m.sheets.length) return null;
  const ft = m.a * t + m.b;
  const i = Math.min(m.count - 1, Math.max(0, Math.round(ft / m.intervalS)));
  const perSheet = m.cols * m.rows;
  const sheet = m.sheets[Math.floor(i / perSheet)];
  if (!sheet) return null;
  const within = i % perSheet;
  return { sheet, x: (within % m.cols) * m.width, y: Math.floor(within / m.cols) * m.height };
}

/** Shown 1.25× on the 1920-wide layout (~400 px), like the TV apps do. */
export const THUMB_SCALE = 1.25;

export function Thumb({ m, t }: { m: TrickplayManifest; t: number }) {
  const at = thumbAt(m, t);
  if (!at) return null;
  const s = THUMB_SCALE;
  return (
    <div
      data-testid="scrub-thumb"
      data-sheet={at.sheet}
      data-x={at.x}
      data-y={at.y}
      className="overflow-hidden rounded-md bg-black shadow-2xl ring-2 ring-white/80"
      style={{
        width: m.width * s,
        height: m.height * s,
        backgroundImage: `url(${at.sheet})`,
        backgroundSize: `${m.cols * m.width * s}px ${m.rows * m.height * s}px`,
        backgroundPosition: `${-at.x * s}px ${-at.y * s}px`,
      }}
    />
  );
}
