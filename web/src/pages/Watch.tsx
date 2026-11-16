import type { PlayStatus, StreamInfo, SubtitleTrack, UpgradeReady } from "@chill/shared";
import { pause as pauseNav, resume as resumeNav } from "@noriginmedia/norigin-spatial-navigation";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, fmtTime, img, progress, telemetry } from "../api";
import { Spinner } from "../components/ui";
import { useServerEvents } from "../events";
import { isBack, KEY } from "../keys";
import { audioIsSilent, needsCompat } from "../player/codecs";
import { HandoffEngine } from "../player/handoff";
import { THUMB_SCALE, Thumb } from "../player/trickplay";
import type { TrickplayManifest } from "@chill/shared";

const STEPS: { phase: PlayStatus["phase"][]; label: string }[] = [
  { phase: ["searching"], label: "Finding the best copy" },
  { phase: ["queued"], label: "Sending to put.io" },
  { phase: ["transferring"], label: "Downloading" },
  { phase: ["ready"], label: "Starting" },
];

export function Watch() {
  const id = Number(useParams().id);
  const [params] = useSearchParams();
  const fromStart = params.get("from") === "0";
  const nav = useNavigate();
  const title = useQuery({ queryKey: ["title", id], queryFn: () => api.title(id) });
  const [status, setStatus] = useState<PlayStatus | null>(null);

  // Press Play; then follow progress over SSE, with polling as a safety net.
  useEffect(() => {
    let alive = true;
    void api.play(id).then((s) => alive && setStatus(s));
    const t = setInterval(() => void api.playStatus(id).then((s) => alive && setStatus((cur) => (cur?.phase === "ready" ? cur : s))), 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);
  useServerEvents((e) => {
    if (e.type === "play" && e.status.tmdbId === id && status?.phase !== "ready") {
      if (e.status.phase === "ready") void api.playStatus(id).then(setStatus); // re-fetch with our profile's resume point
      else setStatus(e.status);
    }
  });

  useEffect(() => {
    pauseNav();
    const onKey = (e: KeyboardEvent) => {
      if (isBack(e) && status?.phase !== "ready") {
        e.preventDefault();
        nav(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      resumeNav();
    };
  }, [nav, status?.phase]);

  if (status?.phase === "ready" && status.stream) {
    return (
      <Player
        tmdbId={id}
        title={title.data?.title ?? ""}
        subtitleLine={id < 0 ? (title.data?.tagline ?? null) : null}
        stream={status.stream}
        startAtS={fromStart ? 0 : status.stream.startAtS}
        onExit={() => nav(-1)}
        onNext={(next) => nav(`/watch/${next}`, { replace: true })}
      />
    );
  }

  const t = title.data;
  const stepIndex = Math.max(0, STEPS.findIndex((s) => status && s.phase.includes(status.phase)));
  const failed = status?.phase === "failed";
  return (
    <div className="relative flex h-screen items-center overflow-hidden bg-black" data-testid="preparing">
      {t?.backdropPath && <img src={img("w1280", t.backdropPath)} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40" />}
      <div className="hero-scrim absolute inset-0" />
      <div className="relative px-24">
        <div className="mb-2 text-2xl text-white/60">{failed ? "Can't play this yet" : "Getting it ready"}</div>
        <h1 className="mb-10 text-7xl font-black">{t?.title ?? ""}</h1>
        {failed ? (
          <div className="max-w-[44rem] text-2xl text-yellow-300" data-testid="play-failed">
            {status?.message ?? "Something went wrong."} Press Back to choose something else.
          </div>
        ) : (
          <ol className="space-y-5">
            {STEPS.map((s, i) => (
              <li key={s.label} className={`flex items-center gap-5 text-3xl ${i < stepIndex ? "text-white/50" : i === stepIndex ? "font-semibold text-white" : "text-white/25"}`}>
                <span className="flex h-10 w-10 items-center justify-center">{i < stepIndex ? "✓" : i === stepIndex ? <Spinner className="h-8 w-8" /> : "•"}</span>
                <span>
                  {s.label}
                  {i === stepIndex && status?.phase === "transferring" && status.percent !== undefined && (
                    <span className="ml-4 font-normal text-white/70" data-testid="percent">
                      {status.percent}%{status.etaSeconds ? ` · about ${fmtTime(status.etaSeconds)} left` : ""}
                    </span>
                  )}
                  {i === stepIndex && status?.phase === "queued" && status.message && <span className="ml-4 text-xl font-normal text-yellow-300">{status.message}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
        {status?.releaseLabel && !failed && <div className="mt-10 text-xl text-white/50">{status.releaseLabel}</div>}
      </div>
    </div>
  );
}

type NextEp = { tmdbId: number; season: number; episode: number; name: string };

function Player({ tmdbId, title, subtitleLine, stream, startAtS, onExit, onNext }: { tmdbId: number; title: string; subtitleLine: string | null; stream: StreamInfo; startAtS: number; onExit: () => void; onNext: (tmdbId: number) => void }) {
  // Episodes: what plays next, prefetched halfway through; an "Up next" card at the end.
  const nextRef = useRef<NextEp | null>(null);
  const prefetched = useRef(false);
  const [upNext, setUpNext] = useState<{ ep: NextEp; left: number } | null>(null);
  const upNextRef = useRef(upNext);
  upNextRef.current = upNext;
  useEffect(() => {
    if (tmdbId < 0) void api.next(tmdbId).then((n) => (nextRef.current = n)).catch(() => {});
  }, [tmdbId]);
  useEffect(() => {
    if (!upNext) return;
    if (upNext.left <= 0) return onNext(upNext.ep.tmdbId);
    const t = setTimeout(() => setUpNext((u) => (u ? { ...u, left: u.left - 1 } : u)), 1000);
    return () => clearTimeout(t);
  }, [upNext, onNext]);
  const box = useRef<HTMLDivElement>(null);
  const engine = useRef<HandoffEngine | null>(null);
  const [pos, setPos] = useState(startAtS);
  const [dur, setDur] = useState(stream.durationS ?? 0);
  const [playing, setPlaying] = useState(false);
  const [osd, setOsd] = useState(true);
  const [label, setLabel] = useState(stream.label);
  // Scrub previews for the copy playing now (re-fetched after a switch; retried each minute until a home copy has them).
  const [variantId, setVariantId] = useState(stream.variantId);
  const thumbs = useQuery({
    queryKey: ["trickplay", variantId],
    queryFn: () => api.trickplay(variantId),
    refetchInterval: (q) => (q.state.data ? false : 60_000),
  });
  useServerEvents((ev) => {
    if (ev.type === "trickplay" && ev.tmdbId === tmdbId && !thumbs.data) void thumbs.refetch();
  });
  /** Remote scrubbing: Left/Right add up to a target, shown with its preview; the seek happens once, 0.7 s after the last press. */
  const [pending, setPending] = useState<number | null>(null);
  const pendingRef = useRef<{ t: number; presses: number; timer?: ReturnType<typeof setTimeout> } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const osdTimer = useRef<ReturnType<typeof setTimeout>>();
  // Subtitles + audio
  const [subs, setSubs] = useState<SubtitleTrack[]>(stream.subtitles ?? []);
  const [curSub, setCurSub] = useState<SubtitleTrack | null>(null);
  const [cues, setCues] = useState<string[]>([]);
  const [audio, setAudio] = useState({ codec: stream.audioCodec, channels: stream.audioChannels });
  const [path, setPath] = useState<PlaybackPath>("direct");
  /** Index into [Off, ...subs] while the subtitle menu is open; null when closed. */
  const [menu, setMenu] = useState<number | null>(null);
  const menuRef = useRef<number | null>(null);
  menuRef.current = menu;
  const subsRef = useRef(subs);
  subsRef.current = subs;

  const report = useCallback(
    (event: "heartbeat" | "pause" | "seek" | "stop" | "end") => {
      const e = engine.current;
      if (!e?.variantId) return;
      void progress({ tmdbId, variantId: e.variantId, positionS: e.now(), durationS: e.duration(), event });
    },
    [tmdbId],
  );

  const poke = useCallback(() => {
    setOsd(true);
    if (osdTimer.current) clearTimeout(osdTimer.current);
    osdTimer.current = setTimeout(() => setOsd(false), 4000);
  }, []);

  useEffect(() => {
    const e = new HandoffEngine(box.current!, {
      onTime: (p, d) => {
        setPos(p);
        if (d) setDur(d);
        const n = nextRef.current;
        if (n && !prefetched.current && d && p / d > 0.5) {
          prefetched.current = true;
          void api.prefetch(n.tmdbId).catch(() => {});
        }
      },
      onPlaying: (p) => {
        setPlaying(p);
        if (!p) report("pause");
      },
      onEnded: () => {
        report("end");
        const n = nextRef.current;
        if (n) setUpNext({ ep: n, left: 5 });
        else onExit();
      },
      onSubtitle: (t) => setCurSub(t),
      onCues: (c) => setCues(c),
      onSwitched: (r, to) => {
        setLabel(to.label);
        setVariantId(to.variantId);
        setSubs(to.subtitles ?? []);
        setAudio({ codec: to.audioCodec, channels: to.audioChannels });
        setPath(engine.current?.isCompat ? "compat" : "direct");
        report("heartbeat");
        void telemetry({ kind: "handoff", tmdbId, ...r });
        (window as unknown as { __chillHandoff?: unknown[] }).__chillHandoff?.push(r);
      },
      onError: async () => {
        const e = engine.current;
        if (!e) return;
        // 1) The server's compat remux (same copy, AAC audio, MP4) — instant.
        if (!e.isCompat) {
          setNote(null);
          await e.switchToCompat().catch(() => undefined);
          if (e.isCompat) return setPath("compat");
        }
        // 2) Last resort: put.io's own HLS conversion, retried while busy or converting.
        await hlsFallback();
      },
      onDebug: (m) => console.debug("[handoff]", m),
    }, needsCompat);
    engine.current = e;
    (window as unknown as { __chillEngine?: HandoffEngine }).__chillEngine = e;
    (window as unknown as { __chillHandoff?: unknown[] }).__chillHandoff ??= [];
    const hlsFallback = async () => {
      const at = engine.current?.now() ?? startAtS;
      for (let attempt = 0; attempt < 12 && engine.current; attempt++) {
        const fb = await api.fallback(engine.current.variantId).catch(() => null);
        if (fb?.state === "ready" && fb.url) {
          setNote(null);
          await engine.current?.attachHls(fb.url, at);
          setPath("hls");
          return;
        }
        if (fb?.state !== "pending" && fb?.state !== "busy") break;
        setNote(fb.state === "pending" ? "put.io is preparing a version this device can play…" : "Waiting for put.io…");
        await new Promise((r) => setTimeout(r, Math.min(60_000, 10_000 * (attempt + 1))));
      }
      setNote("This file can't be played on this device.");
    };
    // Safety net: picture decoding but no sound (a codec canPlayType didn't
    // warn about) → same copy, same moment, via the compat remux.
    const silenceCheck = setInterval(() => {
      const cur = engine.current;
      if (!cur || cur.isCompat || cur.active.paused || cur.active.currentTime < 3) return;
      clearInterval(silenceCheck); // judge once, after 3 s of real playback
      if (audioIsSilent(cur.active)) {
        console.debug("[handoff] no audio decoded: switching to compat stream");
        void cur.switchToCompat().then(() => setPath("compat"));
      }
    }, 1000);
    void e.load(stream, startAtS).then(async () => {
      poke();
      report("heartbeat");
      e.setSubtitle(stream.subtitles?.find((t) => t.id === stream.subtitleId) ?? null);
      const p: PlaybackPath = e.isCompat ? "compat" : "direct";
      setPath(p);
      void telemetry({ kind: "playback", tmdbId, variantId: stream.variantId, path: p, audioCodec: stream.audioCodec, audioChannels: stream.audioChannels, subtitle: stream.subtitleId ? "on" : "off" });
      const up = await api.upgrade(tmdbId, e.variantId).catch(() => null);
      if (up) void e.upgrade(up);
    });
    const hb = setInterval(() => report("heartbeat"), 10_000);
    return () => {
      clearInterval(hb);
      clearInterval(silenceCheck);
      report("stop");
      e.destroy();
      engine.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useServerEvents((ev) => {
    if (ev.type === "upgrade" && ev.upgrade.tmdbId === tmdbId && engine.current) void engine.current.upgrade(ev.upgrade as UpgradeReady);
  });

  useEffect(() => {
    const onKey = (k: KeyboardEvent) => {
      const e = engine.current;
      if (!e) return;
      poke();
      const un = upNextRef.current;
      if (un) {
        // "Up next" card: OK plays it now, Back leaves.
        if (k.key === "Enter" || k.key === " ") onNext(un.ep.tmdbId);
        else if (isBack(k)) onExit();
        else return;
        k.preventDefault();
        return;
      }
      const m = menuRef.current;
      if (m !== null) {
        // Subtitle menu: Up/Down to move, OK to choose, Back to close.
        const n = subsRef.current.length + 1;
        if (k.key === "ArrowDown") setMenu((m + 1) % n);
        else if (k.key === "ArrowUp") setMenu((m - 1 + n) % n);
        else if (k.key === "Enter" || k.key === " ") chooseSub(m);
        else if (isBack(k)) setMenu(null);
        else return;
        k.preventDefault();
        return;
      }
      if (k.key === "ArrowDown") {
        const cur = e.subtitle;
        setMenu(cur ? Math.max(0, subsRef.current.findIndex((t) => t.id === cur.id) + 1) : 0);
      } else if (pendingRef.current && isBack(k)) cancelScrub();
      else if (pendingRef.current && (k.key === "Enter" || k.key === " ")) commitScrub();
      else if (isBack(k) || k.keyCode === KEY.STOP) {
        k.preventDefault();
        onExit();
      } else if (k.key === "Enter" || k.key === " " || k.keyCode === KEY.PLAY_PAUSE) e.toggle();
      else if (k.keyCode === KEY.PLAY) e.play();
      else if (k.keyCode === KEY.PAUSE) e.pause();
      else if (k.key === "ArrowRight") nudge(1, 10);
      else if (k.key === "ArrowLeft") nudge(-1, 10);
      else if (k.keyCode === KEY.FF) nudge(1, 60);
      else if (k.keyCode === KEY.RW) nudge(-1, 60);
      else return;
      k.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onExit, poke, report]);

  /** One remote press while scrubbing: steps grow when held (10 s, then 30 s, then 60 s). */
  function nudge(dir: 1 | -1, base: number) {
    const e = engine.current;
    if (!e) return;
    const p = pendingRef.current ?? { t: e.now(), presses: 0 };
    p.presses++;
    const step = base >= 60 ? base : p.presses > 15 ? 60 : p.presses > 5 ? 30 : base;
    const d = e.duration() || dur;
    p.t = Math.min(Math.max(0, p.t + dir * step), d ? Math.max(0, d - 1) : Infinity);
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(commitScrub, 700);
    pendingRef.current = p;
    setPending(p.t);
  }
  function commitScrub() {
    const p = pendingRef.current;
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    pendingRef.current = null;
    setPending(null);
    engine.current?.seekTo(p.t);
    setPos(p.t);
    report("seek");
  }
  function cancelScrub() {
    const p = pendingRef.current;
    if (p?.timer) clearTimeout(p.timer);
    pendingRef.current = null;
    setPending(null);
  }

  /** Choose item `i` of [Off, ...subs], show it, and remember it for this title. */
  function chooseSub(i: number) {
    const t = i === 0 ? null : (subsRef.current[i - 1] ?? null);
    engine.current?.setSubtitle(t);
    setMenu(null);
    void api.setSubtitle(tmdbId, t ? { language: t.language, forced: t.forced, sdh: t.sdh } : { language: null }).catch(() => {});
  }

  return (
    <div className="fixed inset-0 bg-black" onMouseMove={poke} onClick={() => engine.current?.toggle()} data-testid="player">
      <div ref={box} className="absolute inset-0" />
      <div data-testid="osd" className={`pointer-events-none absolute inset-0 z-10 transition-opacity duration-300 ${osd || !playing ? "opacity-100" : "opacity-0"}`}>
        <div className="absolute inset-x-0 top-0 bg-gradient-to-b from-black/80 to-transparent px-16 pb-16 pt-10">
          <div className="text-4xl font-bold">{title}</div>
          {subtitleLine && <div className="mt-1 text-2xl text-white/80">{subtitleLine}</div>}
          <div className="mt-2 text-xl text-white/60" data-testid="quality-label">
            {label}
          </div>
          <div className="mt-1 text-lg text-white/50" data-testid="audio-label">
            {describeAudio(audio.codec, audio.channels, path)}
          </div>
        </div>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-16 pb-12 pt-24">
          <div className="mb-3 flex justify-between text-xl text-white/80">
            <span data-testid="position">{fmtTime(pos)}</span>
            <span>-{fmtTime(Math.max(0, dur - pos))}</span>
          </div>
          <Scrubber
            pos={pos}
            dur={dur}
            pending={pending}
            thumbs={thumbs.data ?? null}
            active={osd || !playing}
            onActivity={poke}
            onSeek={(t) => {
              engine.current?.seekTo(t);
              setPos(t);
              report("seek");
            }}
          />
          <div className="mt-5 flex gap-8 text-xl text-white/70">
            <span data-testid="subtitle-label">Subtitles: {curSub ? curSub.label : "Off"}</span>
            <span className="text-white/40">↓ subtitles · OK pause · Back exit</span>
          </div>
        </div>
      </div>
      {cues.length > 0 && (
        <div
          data-testid="subtitle-text"
          className={`pointer-events-none absolute inset-x-0 z-20 flex flex-col items-center gap-1 px-[10%] text-center transition-[bottom] duration-300 ${osd || !playing || menu !== null ? "bottom-[22%]" : "bottom-[7%]"}`}
        >
          {cues.map((c, i) => (
            <div
              key={i}
              className="whitespace-pre-line rounded-md bg-black/60 px-4 py-1 text-[2.6rem] font-medium leading-tight text-white"
              style={{ textShadow: "0 0 0.35rem rgba(0,0,0,0.9)" }}
              dangerouslySetInnerHTML={{ __html: cueHtml(c) }}
            />
          ))}
        </div>
      )}
      {upNext && (
        <div className="absolute bottom-24 right-16 z-30 w-[32rem] rounded-xl bg-black/85 p-6" data-testid="up-next" onClick={(ev) => ev.stopPropagation()}>
          <div className="text-lg uppercase tracking-wider text-white/50">Up next</div>
          <div className="mt-1 text-3xl font-bold">
            S{upNext.ep.season} E{upNext.ep.episode}
            {upNext.ep.name ? ` · ${upNext.ep.name}` : ""}
          </div>
          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/20">
            <div className="h-full bg-white transition-[width] duration-1000 ease-linear" style={{ width: `${((5 - upNext.left) / 5) * 100}%` }} />
          </div>
          <div className="mt-4 flex gap-4 text-xl">
            <button className="rounded-md bg-white px-6 py-2 font-semibold text-black" onClick={() => onNext(upNext.ep.tmdbId)}>
              Play now · {upNext.left}
            </button>
            <button className="rounded-md bg-white/20 px-6 py-2" onClick={onExit}>
              Back
            </button>
          </div>
        </div>
      )}
      {menu !== null && (
        <div className="absolute bottom-40 right-16 z-30 w-[26rem] rounded-xl bg-black/85 p-4" onClick={(ev) => ev.stopPropagation()} data-testid="subtitle-menu">
          <div className="mb-3 px-3 text-lg uppercase tracking-wider text-white/50">Subtitles</div>
          {[null, ...subs].map((t, i) => (
            <div
              key={t?.id ?? "off"}
              data-testid={`subtitle-option-${t ? t.id : "off"}`}
              onMouseEnter={() => setMenu(i)}
              onClick={() => chooseSub(i)}
              className={`flex items-center justify-between rounded-lg px-4 py-3 text-2xl ${menu === i ? "bg-white text-black" : "text-white/85"}`}
            >
              <span>{t ? t.label : "Off"}</span>
              {(t ? curSub?.id === t.id : !curSub) && <span aria-hidden>✓</span>}
            </div>
          ))}
          {subs.length === 0 && <div className="px-4 py-2 text-lg text-white/50">No subtitles found for this copy.</div>}
        </div>
      )}
      {note && <div className="absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-black/80 px-8 py-5 text-2xl">{note}</div>}
    </div>
  );
}

type PlaybackPath = "direct" | "compat" | "hls";

const CODEC_NAMES: Record<string, string> = {
  eac3: "Dolby Digital Plus", ac3: "Dolby Digital", truehd: "Dolby TrueHD", dts: "DTS", aac: "AAC", opus: "Opus", flac: "FLAC", mp3: "MP3",
};

/** "Dolby Digital Plus 5.1", or what the converted streams deliver. */
export function describeAudio(codec: string | null, channels: number | null, path: PlaybackPath): string {
  if (path === "compat") return "Stereo · converted for this device";
  if (path === "hls") return "Stereo · put.io stream";
  const name = codec ? (CODEC_NAMES[codec] ?? codec.toUpperCase()) : "Audio";
  const layout = channels === 8 ? "7.1" : channels === 6 ? "5.1" : channels === 2 ? "Stereo" : channels === 1 ? "Mono" : channels ? `${channels} ch` : "";
  return [name, layout].filter(Boolean).join(" ");
}

/** Cue text → safe HTML: escape everything, then re-allow only <i>, <b>, <u>. */
export function cueHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/&lt;(\/?)(i|b|u)&gt;/g, "<$1$2>");
}

/**
 * The progress bar, as a pointer target (mouse, Magic Remote): click to jump,
 * drag to scrub with a time preview. Inert while the controls are hidden so a
 * stray click on the picture never seeks.
 */
function Scrubber({
  pos, dur, pending, thumbs, active, onSeek, onActivity,
}: { pos: number; dur: number; pending: number | null; thumbs: TrickplayManifest | null; active: boolean; onSeek: (t: number) => void; onActivity: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const frac = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    return r && r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;
  };
  const remote = pending !== null && dur ? pending / dur : null;
  const shown = drag ?? remote ?? (dur ? pos / dur : 0);
  const tip = drag ?? remote ?? hover;
  return (
    <div
      ref={ref}
      data-testid="scrubber"
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(dur)}
      aria-valuenow={Math.round(pos)}
      className={`group relative -my-4 py-4 ${active ? "pointer-events-auto cursor-pointer" : "pointer-events-none"}`}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        if (!dur) return;
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        setDrag(frac(e.clientX));
        onActivity();
      }}
      onPointerMove={(e) => {
        setHover(frac(e.clientX));
        if (drag !== null) setDrag(frac(e.clientX));
        onActivity();
      }}
      onPointerUp={(e) => {
        if (drag === null) return;
        e.stopPropagation();
        onSeek(frac(e.clientX) * dur);
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
      onPointerLeave={() => setHover(null)}
    >
      <div className={`relative overflow-visible rounded-full bg-white/25 transition-[height] ${tip !== null ? "h-3" : "h-2"}`}>
        <div className="h-full rounded-full bg-accent" style={{ width: `${shown * 100}%` }} />
        <div
          className={`absolute top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow-lg transition-opacity ${tip !== null ? "opacity-100" : "opacity-0"}`}
          style={{ left: `${shown * 100}%` }}
        />
      </div>
      {tip !== null && dur > 0 && (
        // The preview stays inside the bar's width at the ends.
        <div
          className="pointer-events-none absolute bottom-full mb-3 flex -translate-x-1/2 flex-col items-center gap-2"
          style={{ left: thumbs ? `clamp(${(thumbs.width * THUMB_SCALE) / 2}px, ${tip * 100}%, calc(100% - ${(thumbs.width * THUMB_SCALE) / 2}px))` : `${tip * 100}%` }}
        >
          {thumbs && <Thumb m={thumbs} t={tip * dur} />}
          <div className="rounded bg-black/85 px-3 py-1 text-xl tabular-nums" data-testid="scrub-time">
            {fmtTime(tip * dur)}
          </div>
        </div>
      )}
    </div>
  );
}
