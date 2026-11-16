import type { PlayStatus, StreamInfo, UpgradeReady } from "@chill/shared";
import { pause as pauseNav, resume as resumeNav } from "@noriginmedia/norigin-spatial-navigation";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, fmtTime, img, progress, telemetry } from "../api";
import { Spinner } from "../components/ui";
import { useServerEvents } from "../events";
import { isBack, KEY } from "../keys";
import { HandoffEngine } from "../player/handoff";

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
    return <Player tmdbId={id} title={title.data?.title ?? ""} stream={status.stream} startAtS={fromStart ? 0 : status.stream.startAtS} onExit={() => nav(-1)} />;
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

function Player({ tmdbId, title, stream, startAtS, onExit }: { tmdbId: number; title: string; stream: StreamInfo; startAtS: number; onExit: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const engine = useRef<HandoffEngine | null>(null);
  const [pos, setPos] = useState(startAtS);
  const [dur, setDur] = useState(stream.durationS ?? 0);
  const [playing, setPlaying] = useState(false);
  const [osd, setOsd] = useState(true);
  const [label, setLabel] = useState(stream.label);
  const [note, setNote] = useState<string | null>(null);
  const osdTimer = useRef<ReturnType<typeof setTimeout>>();

  const report = useCallback(
    (event: "heartbeat" | "pause" | "seek" | "stop" | "end") => {
      const e = engine.current;
      if (!e?.variantId) return;
      void progress({ tmdbId, variantId: e.variantId, positionS: e.active.currentTime, durationS: e.active.duration || 0, event });
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
      onTime: (p, d) => (setPos(p), d && setDur(d)),
      onPlaying: (p) => {
        setPlaying(p);
        if (!p) report("pause");
      },
      onEnded: () => (report("end"), onExit()),
      onSwitched: (r, to) => {
        setLabel(to.label);
        report("heartbeat");
        void telemetry({ kind: "handoff", tmdbId, ...r });
        (window as unknown as { __chillHandoff?: unknown[] }).__chillHandoff?.push(r);
      },
      onError: async (_err, variantId) => {
        // Original didn't decode: fall back to put.io's HLS.
        setNote("Switching to a compatible stream…");
        const fb = await api.fallback(variantId).catch(() => null);
        if (fb?.state === "ready" && fb.url) {
          const at = engine.current?.active.currentTime ?? startAtS;
          const canNative = document.createElement("video").canPlayType("application/vnd.apple.mpegurl");
          if (canNative) await engine.current?.replaceSource({ ...stream, url: fb.url, kind: "hls" }, at);
          else {
            const { default: Hls } = await import("hls.js");
            const h = new Hls();
            h.loadSource(fb.url);
            h.attachMedia(engine.current!.active);
          }
          setNote(null);
        } else setNote(fb?.state === "pending" ? "put.io is converting this file. Try again in a few minutes." : "This file can't be played on this device.");
      },
      onDebug: (m) => console.debug("[handoff]", m),
    });
    engine.current = e;
    (window as unknown as { __chillEngine?: HandoffEngine }).__chillEngine = e;
    (window as unknown as { __chillHandoff?: unknown[] }).__chillHandoff ??= [];
    void e.load(stream, startAtS).then(async () => {
      poke();
      report("heartbeat");
      const up = await api.upgrade(tmdbId, e.variantId).catch(() => null);
      if (up) void e.upgrade(up);
    });
    const hb = setInterval(() => report("heartbeat"), 10_000);
    return () => {
      clearInterval(hb);
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
      if (isBack(k) || k.keyCode === KEY.STOP) {
        k.preventDefault();
        onExit();
      } else if (k.key === "Enter" || k.key === " " || k.keyCode === KEY.PLAY_PAUSE) e.toggle();
      else if (k.keyCode === KEY.PLAY) e.play();
      else if (k.keyCode === KEY.PAUSE) e.pause();
      else if (k.key === "ArrowRight") (e.seekBy(10), report("seek"));
      else if (k.key === "ArrowLeft") (e.seekBy(-10), report("seek"));
      else if (k.keyCode === KEY.FF) (e.seekBy(60), report("seek"));
      else if (k.keyCode === KEY.RW) (e.seekBy(-60), report("seek"));
      else return;
      k.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit, poke, report]);

  return (
    <div className="fixed inset-0 bg-black" onMouseMove={poke} onClick={() => engine.current?.toggle()} data-testid="player">
      <div ref={box} className="absolute inset-0" />
      <div data-testid="osd" className={`pointer-events-none absolute inset-0 z-10 transition-opacity duration-300 ${osd || !playing ? "opacity-100" : "opacity-0"}`}>
        <div className="absolute inset-x-0 top-0 bg-gradient-to-b from-black/80 to-transparent px-16 pb-16 pt-10">
          <div className="text-4xl font-bold">{title}</div>
          <div className="mt-2 text-xl text-white/60" data-testid="quality-label">
            {label}
          </div>
        </div>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-16 pb-12 pt-24">
          <div className="mb-3 flex justify-between text-xl text-white/80">
            <span data-testid="position">{fmtTime(pos)}</span>
            <span>-{fmtTime(Math.max(0, dur - pos))}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-white/25">
            <div className="h-full bg-accent" style={{ width: `${dur ? (pos / dur) * 100 : 0}%` }} />
          </div>
          {!playing && <div className="mt-6 text-2xl text-white/70">Paused · OK to play · Back to exit</div>}
        </div>
      </div>
      {note && <div className="absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-black/80 px-8 py-5 text-2xl">{note}</div>}
    </div>
  );
}
