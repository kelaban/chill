import type { HandoffMode, StreamInfo, SubtitleTrack, UpgradeReady } from "@chill/shared";

// The playback engine behind the player: two stacked <video> elements so a
// better copy can take over without anyone noticing (ARCHITECTURE.md →
// Seamless upgrade). Framework-free so it can be reasoned about and tested.

export interface SwitchReport {
  mode: HandoffMode;
  fromVariantId: string;
  toVariantId: string;
  /** Timeline error at the moment of the switch, ms (0 = frame-exact). */
  gapMs: number;
  droppedFrames: number;
  atS: number;
}

export interface EngineEvents {
  onTime?(positionS: number, durationS: number): void;
  onPlaying?(playing: boolean): void;
  onSwitched?(r: SwitchReport, stream: StreamInfo): void;
  onError?(err: MediaError | null, variantId: string): void;
  onEnded?(): void;
  onDebug?(msg: string): void;
  /** The subtitle now showing changed (null = none). */
  onSubtitle?(track: SubtitleTrack | null): void;
  /** The cues on screen right now (text with <i>/<b>/<u> markup); [] = nothing to show. */
  onCues?(cues: string[]): void;
}

/** What the viewer asked for, independent of which copy is playing. */
export interface SubChoice {
  language: string | null;
  forced: boolean;
  sdh: boolean;
}

/** A track plus the map from its copy's timeline to the playing copy's: t' = scale·t + shift. */
interface ActiveSub {
  track: SubtitleTrack;
  scale: number;
  shift: number;
}

/** Pure: the track on another copy equivalent to `choice` (same language and flags, then same language). */
export function matchSub(choice: SubChoice, tracks: SubtitleTrack[]): SubtitleTrack | null {
  return (
    tracks.find((t) => t.language === choice.language && t.forced === choice.forced && t.sdh === choice.sdh) ??
    tracks.find((t) => t.language === choice.language && t.forced === choice.forced) ??
    null
  );
}

/** Pure: the subtitle URL for an element whose clock is `offset` seconds behind film time. */
export function subtitleUrl(sub: ActiveSub, offset: number): string {
  return `${sub.track.url}?scale=${sub.scale}&shift=${(sub.shift - offset).toFixed(3)}`;
}

/** Pure: next cut at least `minLeadS` ahead. */
export function nextCut(cuts: number[], nowS: number, minLeadS: number): number | null {
  for (const c of cuts) if (c >= nowS + minLeadS) return c;
  return null;
}

/** Pure: playbackRate that closes a timeline error (s) over ~1 s, gently. */
export function correctionRate(errorS: number): number {
  return Math.min(1.08, Math.max(0.92, 1 - errorS));
}

type Frame = { mediaTime: number; presentedAt: number };
type RVFC = (cb: (now: number, meta: { mediaTime: number; presentedFrames: number }) => void) => number;

const PREROLL_S = 1.2;
const LEAD_S = 15;

function once(el: HTMLMediaElement, ev: string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => (cleanup(), reject(new Error(`timeout waiting for ${ev}`))), timeoutMs);
    const ok = () => (cleanup(), resolve());
    const bad = () => (cleanup(), reject(new Error(`media error waiting for ${ev}`)));
    const cleanup = () => {
      clearTimeout(t);
      el.removeEventListener(ev, ok);
      el.removeEventListener("error", bad);
    };
    el.addEventListener(ev, ok);
    el.addEventListener("error", bad);
  });
}

function bufferedAhead(el: HTMLMediaElement): number {
  const t = el.currentTime;
  for (let i = 0; i < el.buffered.length; i++) if (el.buffered.start(i) <= t + 0.05 && el.buffered.end(i) >= t) return el.buffered.end(i) - t;
  return 0;
}

export class HandoffEngine {
  private els: [HTMLVideoElement, HTMLVideoElement];
  private ai = 0;
  private stream: StreamInfo | null = null;
  private pending: UpgradeReady | null = null;
  private generation = 0; // bumps on seek/load to cancel in-flight handoffs
  private busy = false;
  private naturalBreak: UpgradeReady | null = null;
  private destroyed = false;
  private lastFrame: Frame | null = null;
  /** Compat streams start their clock at 0; this is where 0 sits in the film. */
  private offset = 0;
  private compat = false;
  private hls: { destroy(): void } | null = null;
  private choice: SubChoice | null = null;
  private sub: ActiveSub | null = null;
  /** Subtitle prepared on the standby element for a switch in progress. */
  private nextSub: ActiveSub | null | undefined = undefined;

  constructor(
    private container: HTMLElement,
    private ev: EngineEvents = {},
    /** Does this stream need the server's compat remux on this device? */
    private needsCompat: (s: StreamInfo) => boolean = () => false,
  ) {
    this.els = [this.makeVideo(), this.makeVideo()];
    this.show(this.els[0]);
    this.hide(this.els[1]);
  }

  get active() {
    return this.els[this.ai]!;
  }
  private get standby() {
    return this.els[1 - this.ai]!;
  }
  get variantId() {
    return this.stream?.variantId ?? "";
  }
  get current() {
    return this.stream;
  }
  /** Position in the film (not the element's clock). */
  now(): number {
    return this.offset + this.active.currentTime;
  }
  duration(): number {
    return this.stream?.durationS || (this.active.duration ? this.offset + this.active.duration : 0);
  }
  get isCompat() {
    return this.compat;
  }

  private makeVideo(): HTMLVideoElement {
    const v = document.createElement("video");
    v.playsInline = true;
    v.preload = "auto";
    v.className = "absolute inset-0 h-full w-full bg-black object-contain";
    v.setAttribute("data-testid", "video");
    v.addEventListener("timeupdate", () => v === this.active && this.ev.onTime?.(this.now(), this.duration()));
    v.addEventListener("play", () => v === this.active && this.ev.onPlaying?.(true));
    v.addEventListener("pause", () => {
      if (v !== this.active || this.busy) return;
      this.ev.onPlaying?.(false);
      if (this.naturalBreak) void this.swapAtBreak();
    });
    v.addEventListener("ended", () => v === this.active && this.ev.onEnded?.());
    v.addEventListener("error", () => v === this.active && !this.busy && this.ev.onError?.(v.error, this.variantId));
    this.container.appendChild(v);
    return v;
  }

  private show(v: HTMLVideoElement) {
    v.style.opacity = "1";
    v.style.zIndex = "2";
    v.dataset.active = "true";
  }
  private hide(v: HTMLVideoElement) {
    v.style.opacity = "0";
    v.style.zIndex = "1";
    delete v.dataset.active;
  }

  private trackFrames(v: HTMLVideoElement) {
    const rvfc = (v as unknown as { requestVideoFrameCallback?: RVFC }).requestVideoFrameCallback?.bind(v);
    if (!rvfc) return;
    const tick: Parameters<RVFC>[0] = (now, meta) => {
      if (this.destroyed || v !== this.active) return;
      this.lastFrame = { mediaTime: meta.mediaTime, presentedAt: now };
      rvfc(tick);
    };
    rvfc(tick);
  }

  /** Show `track` (one of the current copy's tracks), or none. Remembered across copy switches. */
  setSubtitle(track: SubtitleTrack | null) {
    this.choice = track ? { language: track.language, forced: track.forced, sdh: track.sdh } : null;
    this.sub = track ? { track, scale: 1, shift: 0 } : null;
    this.applySubtitle(this.active, this.sub, this.offset);
    this.ev.onSubtitle?.(this.sub?.track ?? null);
  }
  get subtitle(): SubtitleTrack | null {
    return this.sub?.track ?? null;
  }

  /** The subtitle to use on `stream`: its own matching track, else the current one mapped through the switch's alignment. */
  private subFor(stream: StreamInfo, up?: UpgradeReady): ActiveSub | null {
    if (!this.choice) return null;
    const own = matchSub(this.choice, stream.subtitles ?? []);
    if (own) return { track: own, scale: 1, shift: 0 };
    if (up && this.sub) return { track: this.sub.track, scale: up.a * this.sub.scale, shift: up.a * this.sub.shift + up.b };
    return null;
  }

  /**
   * Attach a subtitle track to `el`. The browser parses and times the cues
   * ("hidden" mode); the player draws them itself so it can size them for the
   * TV and lift them above the controls.
   */
  private applySubtitle(el: HTMLVideoElement, sub: ActiveSub | null, offset: number) {
    for (const t of Array.from(el.querySelectorAll("track"))) t.remove();
    if (el === this.active) this.ev.onCues?.([]);
    if (!sub) return;
    const tr = document.createElement("track");
    tr.kind = "subtitles";
    tr.label = sub.track.label;
    if (sub.track.language) tr.srclang = sub.track.language;
    tr.src = subtitleUrl(sub, offset);
    el.appendChild(tr);
    tr.track.mode = "hidden";
    tr.track.addEventListener("cuechange", () => {
      if (el !== this.active) return;
      const cues = Array.from(tr.track.activeCues ?? []) as VTTCue[];
      this.ev.onCues?.(cues.map((c) => c.text));
    });
  }

  async load(stream: StreamInfo, startAtS: number, autoplay = true): Promise<void> {
    if (this.needsCompat(stream)) return this.loadCompat(stream, startAtS, autoplay);
    this.generation++;
    this.stream = stream;
    this.dropHls();
    this.offset = 0;
    this.compat = false;
    const v = this.active;
    v.muted = false;
    v.volume = 1;
    v.src = stream.url;
    await once(v, "loadedmetadata", 60_000);
    if (startAtS > 0) {
      v.currentTime = startAtS;
      await once(v, "seeked").catch(() => {});
    }
    this.trackFrames(v);
    this.applySubtitle(v, this.sub, 0);
    if (autoplay) await v.play().catch(() => this.ev.onPlaying?.(false));
  }

  /**
   * Play `stream` through the server's compat remux (AAC audio, fragmented MP4)
   * from `atS`. The server starts at the keyframe at or before `atS` and tells
   * us where, so positions stay exact.
   */
  async loadCompat(stream: StreamInfo, atS: number, autoplay = true): Promise<void> {
    this.generation++;
    this.stream = stream;
    this.dropHls();
    const res = await fetch(`/api/stream/${encodeURIComponent(stream.variantId)}/compat-start?t=${Math.max(0, atS).toFixed(3)}`);
    const { start, url } = (await res.json()) as { start: number; url: string };
    const v = this.active;
    this.offset = start;
    this.compat = true;
    v.muted = false;
    v.volume = 1;
    v.src = url;
    await once(v, "loadedmetadata", 60_000);
    const into = atS - start;
    if (into > 0.2) {
      v.currentTime = into;
      await once(v, "seeked").catch(() => {});
    }
    this.ev.onDebug?.(`compat stream from ${start.toFixed(2)} s`);
    this.applySubtitle(v, this.sub, start); // cue times shifted onto the compat clock
    if (autoplay) await v.play().catch(() => this.ev.onPlaying?.(false));
  }

  /** The current copy plays without sound here: same copy, same moment, via compat. */
  async switchToCompat(): Promise<void> {
    if (!this.stream || this.compat) return;
    const at = this.now();
    const playing = !this.active.paused;
    await this.loadCompat(this.stream, at, playing);
  }

  /** Last resort: put.io's HLS (converted by put.io) at the current moment. */
  async attachHls(url: string, atS: number): Promise<void> {
    this.generation++;
    this.dropHls();
    const v = this.active;
    this.offset = 0;
    this.compat = false;
    if (v.canPlayType("application/vnd.apple.mpegurl") && !/Chrome|Chromium/.test(navigator.userAgent)) {
      v.src = url;
      await once(v, "loadedmetadata", 60_000);
    } else {
      const { default: Hls } = await import("hls.js");
      const h = new Hls();
      this.hls = h;
      h.loadSource(url);
      h.attachMedia(v);
      await new Promise<void>((resolve) => h.once(Hls.Events.MANIFEST_PARSED, () => resolve()));
    }
    if (atS > 0) v.currentTime = atS;
    this.applySubtitle(v, this.sub, 0);
    await v.play().catch(() => this.ev.onPlaying?.(false));
  }

  private dropHls() {
    this.hls?.destroy();
    this.hls = null;
  }

  play() {
    void this.active.play();
  }
  pause() {
    this.active.pause();
  }
  toggle() {
    if (this.active.paused) this.play();
    else this.pause();
  }
  seekBy(deltaS: number) {
    this.seekTo(this.now() + deltaS);
  }
  seekTo(t: number) {
    this.generation++; // any handoff in preparation is now stale
    const v = this.active;
    const target = Math.max(0, Math.min(t, (this.duration() || Infinity) - 1));
    if (this.compat && this.stream) {
      // A piped stream can't seek outside what it has buffered: restart it there.
      const inBuffer = target >= this.offset && Array.from({ length: v.buffered.length }, (_, i) => [v.buffered.start(i), v.buffered.end(i)]).some(([s, e]) => target - this.offset >= s! && target - this.offset <= e!);
      if (inBuffer) v.currentTime = target - this.offset;
      else void this.loadCompat(this.stream, target, !v.paused);
      if (this.naturalBreak) void this.swapAtBreak();
      return;
    }
    v.currentTime = target;
    if (this.naturalBreak) void this.swapAtBreak();
    else if (this.pending) void this.upgrade(this.pending);
  }

  /** A better copy is ready. Never asks; picks the least visible way in. */
  async upgrade(up: UpgradeReady): Promise<void> {
    if (up.fromVariantId !== this.variantId || up.to.variantId === this.variantId) return;
    this.pending = up;
    this.ev.onDebug?.(`upgrade ${up.mode} → ${up.to.label}`);
    // Frame-exact handoffs need the element clock to be the film clock; compat
    // streams (either side) switch at the next pause or seek instead.
    if (up.mode === "natural-break" || this.compat || this.needsCompat(up.to)) {
      this.naturalBreak = up;
      return;
    }
    if (this.busy) return;
    const gen = this.generation;
    for (;;) {
      const c = nextCut(up.cutsFrom, this.active.currentTime, up.mode === "seamless" ? LEAD_S : 5);
      if (c === null) {
        // No cut planned far enough ahead: fall back to the next natural break.
        this.naturalBreak = up;
        return;
      }
      try {
        const ok = up.mode === "seamless" ? await this.seamlessAt(up, c, gen) : await this.blackSegmentAt(up, c, gen);
        if (ok) return;
        if (gen !== this.generation) return; // seeked/reloaded: seekTo re-arms
      } catch (err) {
        this.ev.onDebug?.(`handoff failed: ${(err as Error).message}`);
        this.resetStandby();
        this.naturalBreak = up;
        return;
      }
    }
  }

  /** Wait until the active element's media time reaches `t` (frame-accurate where supported). */
  private waitFor(t: number, gen: number): Promise<boolean> {
    const v = this.active;
    const rvfc = (v as unknown as { requestVideoFrameCallback?: RVFC }).requestVideoFrameCallback?.bind(v);
    return new Promise((resolve) => {
      const check = (mt: number) => {
        if (gen !== this.generation || this.destroyed) return resolve(false);
        if (mt >= t) return resolve(true);
        if (v.paused && !v.seeking) {
          // Paused before the cut: keep waiting without spinning.
          setTimeout(() => (rvfc ? rvfc((_n, m) => check(m.mediaTime)) : check(v.currentTime)), 250);
          return;
        }
        if (rvfc) rvfc((_n, m) => check(m.mediaTime));
        else setTimeout(() => check(v.currentTime), 10);
      };
      check(v.currentTime);
    });
  }

  private async prepareStandby(up: UpgradeReady, toAt: number) {
    const s = this.standby;
    s.muted = true;
    s.volume = 0;
    if (s.getAttribute("src") !== up.to.url) {
      s.src = up.to.url;
      await once(s, "loadedmetadata", 60_000);
    }
    s.currentTime = Math.max(0, toAt);
    await once(s, "seeked");
    // Let it buffer a few seconds before we commit.
    const t0 = performance.now();
    while (bufferedAhead(s) < 4 && performance.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 100));
  }

  private async seamlessAt(up: UpgradeReady, c: number, gen: number): Promise<boolean> {
    this.busy = true;
    try {
      const map = (t: number) => up.a * t + up.b;
      const prerollAt = c - PREROLL_S;
      await this.prepareStandby(up, map(prerollAt));
      this.nextSub = this.subFor(up.to, up);
      this.applySubtitle(this.standby, this.nextSub, 0);
      if (gen !== this.generation || this.active.currentTime > prerollAt) return false; // too late for this cut
      if (!(await this.waitFor(prerollAt, gen))) return false;

      // Both decoders run for ~1 s; nudge the hidden one onto the active timeline.
      const a = this.active;
      const s = this.standby;
      s.currentTime = map(a.currentTime) + 0.02;
      await s.play();
      const fixDrift = () => {
        const err = s.currentTime - map(a.currentTime);
        if (Math.abs(err) > 0.3) s.currentTime = map(a.currentTime);
        else s.playbackRate = correctionRate(err);
      };
      const drift = setInterval(fixDrift, 50);
      const reached = await this.waitFor(c, gen);
      clearInterval(drift);
      if (!reached) {
        s.pause();
        return false;
      }
      // The cut: swap pictures, cross-fade audio over ~120 ms.
      const err = s.currentTime - map(a.currentTime);
      s.playbackRate = 1;
      this.show(s);
      this.hide(a);
      s.muted = false;
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        s.volume = i / steps;
        a.volume = 1 - i / steps;
        await new Promise((r) => setTimeout(r, 20));
      }
      this.finishSwitch(up, "seamless", Math.abs(err) * 1000, c);
      return true;
    } finally {
      this.busy = false;
    }
  }

  private async blackSegmentAt(up: UpgradeReady, c: number, gen: number): Promise<boolean> {
    if (!(await this.waitFor(c, gen))) return false;
    this.busy = true;
    try {
      const at = up.a * this.active.currentTime + up.b;
      const v = this.active;
      v.src = up.to.url;
      await once(v, "loadedmetadata");
      v.currentTime = at;
      await once(v, "seeked");
      await v.play();
      this.sub = this.subFor(up.to, up);
      this.applySubtitle(v, this.sub, 0);
      this.ev.onSubtitle?.(this.sub?.track ?? null);
      this.stream = up.to;
      this.pending = null;
      this.ev.onSwitched?.({ mode: "black-segment", fromVariantId: up.fromVariantId, toVariantId: up.to.variantId, gapMs: 0, droppedFrames: 0, atS: c }, up.to);
      return true;
    } finally {
      this.busy = false;
    }
  }

  /** Paused or seeked: the screen is static anyway, so switch now. */
  private async swapAtBreak() {
    const up = this.naturalBreak;
    if (!up || this.busy || up.fromVariantId !== this.variantId) return;
    this.busy = true;
    try {
      const a = this.active;
      const wasPlaying = !a.paused;
      const from = this.now();
      const at = up.a * from + up.b;
      if (this.needsCompat(up.to)) {
        this.sub = this.subFor(up.to, up);
        await this.loadCompat(up.to, at, wasPlaying);
        this.ev.onSubtitle?.(this.sub?.track ?? null);
        this.pending = null;
        this.naturalBreak = null;
        this.ev.onSwitched?.({ mode: "natural-break", fromVariantId: up.fromVariantId, toVariantId: up.to.variantId, gapMs: 0, droppedFrames: 0, atS: from }, up.to);
        return;
      }
      await this.prepareStandby(up, at);
      this.nextSub = this.subFor(up.to, up);
      this.applySubtitle(this.standby, this.nextSub, 0);
      const s = this.standby;
      s.muted = false;
      s.volume = 1;
      this.show(s);
      this.hide(a);
      if (wasPlaying) await s.play();
      this.naturalBreak = null;
      this.offset = 0;
      this.compat = false;
      this.dropHls();
      this.finishSwitch(up, "natural-break", 0, from);
    } catch (err) {
      this.ev.onDebug?.(`natural-break swap failed: ${(err as Error).message}`);
      this.resetStandby();
    } finally {
      this.busy = false;
    }
  }

  private finishSwitch(up: UpgradeReady, mode: HandoffMode, gapMs: number, atS: number) {
    const old = this.active;
    this.ai = 1 - this.ai;
    const dropped = (this.active as HTMLVideoElement & { getVideoPlaybackQuality?: () => VideoPlaybackQuality }).getVideoPlaybackQuality?.().droppedVideoFrames ?? 0;
    old.pause();
    for (const t of Array.from(old.querySelectorAll("track"))) t.remove();
    old.removeAttribute("src");
    old.load();
    this.stream = up.to;
    this.pending = null;
    this.naturalBreak = null;
    if (this.nextSub !== undefined) {
      this.sub = this.nextSub;
      this.nextSub = undefined;
      this.ev.onSubtitle?.(this.sub?.track ?? null);
    }
    const t = Array.from(this.active.textTracks).find((x) => x.mode === "hidden");
    this.ev.onCues?.(Array.from(t?.activeCues ?? []).map((c) => (c as VTTCue).text));
    this.trackFrames(this.active);
    this.ev.onSwitched?.({ mode, fromVariantId: up.fromVariantId, toVariantId: up.to.variantId, gapMs: Math.round(gapMs * 10) / 10, droppedFrames: dropped, atS }, up.to);
  }

  private resetStandby() {
    const s = this.standby;
    this.nextSub = undefined;
    for (const t of Array.from(s.querySelectorAll("track"))) t.remove();
    s.pause();
    s.playbackRate = 1;
    this.hide(s);
  }

  destroy() {
    this.destroyed = true;
    this.generation++;
    this.dropHls();
    for (const v of this.els) {
      v.pause();
      v.removeAttribute("src");
      v.load();
      v.remove();
    }
  }
}
