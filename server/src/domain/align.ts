// Timeline alignment between two copies of the same film, by audio
// cross-correlation. Pure and synchronous; ffmpeg extraction lives in media/.

/** In-place iterative radix-2 FFT. `re`/`im` length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) (re[i] = re[i]! / n), (im[i] = im[i]! / n);
}

export interface Correlation {
  /** Sample offset in `haystack` where `needle` best matches. */
  lag: number;
  /** Normalized correlation at that lag, −1…1. */
  peak: number;
}

/** Find `needle` (shorter) inside `haystack` by normalized cross-correlation. */
export function crossCorrelate(needle: Float32Array, haystack: Float32Array): Correlation {
  const n = needle.length;
  const m = haystack.length;
  if (n === 0 || m < n) return { lag: 0, peak: 0 };
  let size = 1;
  while (size < n + m) size <<= 1;
  const ar = new Float64Array(size), ai = new Float64Array(size);
  const br = new Float64Array(size), bi = new Float64Array(size);
  ar.set(needle);
  br.set(haystack);
  fft(ar, ai);
  fft(br, bi);
  // conj(A) * B
  for (let i = 0; i < size; i++) {
    const r = ar[i]! * br[i]! + ai[i]! * bi[i]!;
    const im = ar[i]! * bi[i]! - ai[i]! * br[i]!;
    ar[i] = r;
    ai[i] = im;
  }
  fft(ar, ai, true);

  let needleEnergy = 0;
  for (let i = 0; i < n; i++) needleEnergy += needle[i]! * needle[i]!;
  const prefix = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) prefix[i + 1] = prefix[i]! + haystack[i]! * haystack[i]!;

  let best = { lag: 0, peak: -Infinity };
  for (let k = 0; k <= m - n; k++) {
    const e = Math.sqrt(needleEnergy * (prefix[k + n]! - prefix[k]!));
    const v = e > 1e-12 ? ar[k]! / e : 0;
    if (v > best.peak) best = { lag: k, peak: v };
  }
  return best;
}

export interface AnchorMatch {
  tFrom: number;
  tTo: number;
  peak: number;
}

export interface LinearFit {
  a: number;
  b: number;
  residualMs: number;
}

/** Least-squares t_to = a·t_from + b; with one anchor, a = 1. */
export function fitLinear(points: AnchorMatch[]): LinearFit {
  if (points.length === 0) return { a: 1, b: 0, residualMs: Infinity };
  if (points.length === 1) return { a: 1, b: points[0]!.tTo - points[0]!.tFrom, residualMs: 0 };
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.tFrom, 0) / n;
  const my = points.reduce((s, p) => s + p.tTo, 0) / n;
  let sxx = 0, sxy = 0;
  for (const p of points) (sxx += (p.tFrom - mx) ** 2), (sxy += (p.tFrom - mx) * (p.tTo - my));
  const a = sxx > 0 ? sxy / sxx : 1;
  const b = my - a * mx;
  const residualMs = Math.max(...points.map((p) => Math.abs(a * p.tFrom + b - p.tTo))) * 1000;
  return { a, b, residualMs };
}

export const ALIGN_MAX_RESIDUAL_MS = 40;
export const ALIGN_MIN_PEAK = 0.3;

export interface AlignmentResult extends LinearFit {
  aligned: boolean;
  reason?: string;
}

/**
 * Align from anchors. `windows` gives, per anchor, the from-segment start time,
 * the to-segment start time (earlier, by the search margin), and both PCM
 * buffers at `sampleRate`.
 */
export function alignFromWindows(
  windows: { fromStartS: number; toStartS: number; from: Float32Array; to: Float32Array }[],
  sampleRate: number,
): AlignmentResult {
  const matches: AnchorMatch[] = [];
  for (const w of windows) {
    const c = crossCorrelate(w.from, w.to);
    if (c.peak < ALIGN_MIN_PEAK) return { a: 1, b: 0, residualMs: Infinity, aligned: false, reason: `weak match at ${w.fromStartS.toFixed(0)}s (${c.peak.toFixed(2)})` };
    matches.push({ tFrom: w.fromStartS, tTo: w.toStartS + c.lag / sampleRate, peak: c.peak });
  }
  const fit = fitLinear(matches);
  if (fit.residualMs > ALIGN_MAX_RESIDUAL_MS) return { ...fit, aligned: false, reason: `anchors disagree by ${fit.residualMs.toFixed(0)} ms (different cut?)` };
  if (Math.abs(fit.a - 1) > 0.05) return { ...fit, aligned: false, reason: `implausible speed ratio ${fit.a.toFixed(4)}` };
  return { ...fit, aligned: true };
}
