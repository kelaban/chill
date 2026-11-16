import type { Availability } from "@chill/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { api, fmtTime, img } from "../api";
import { FocusGroup } from "../components/Focusable";
import { Button, Page, PlayIcon, Row, Spinner, useInitialFocus } from "../components/ui";
import { useServerEvents } from "../events";

function availabilityText(a: Availability): { text: string; tone: string } {
  switch (a.state) {
    case "ready":
      return { text: `Ready to play · ${a.label}`, tone: "text-ok" };
    case "available":
      return { text: `Starts in about a minute · ${a.instantLabel}${a.targetLabel ? ` → upgrades to ${a.targetLabel.split(" · ")[0]}` : ""}`, tone: "text-white/85" };
    case "none":
      return { text: "No releases found for this title yet.", tone: "text-yellow-300" };
    case "searching":
      return { text: "Looking for releases…", tone: "text-white/60" };
    default:
      return { text: "Press Play and chill will find a copy.", tone: "text-white/60" };
  }
}

export function Detail() {
  const id = Number(useParams().id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: t, refetch } = useQuery({ queryKey: ["title", id], queryFn: () => api.title(id) });
  // The release search may still be running: poll availability briefly.
  const avail = useQuery({
    queryKey: ["availability", id],
    queryFn: () => api.availability(id),
    refetchInterval: (q) => (q.state.data && (q.state.data.state === "unknown" || q.state.data.state === "searching") ? 1500 : false),
    initialData: t?.availability,
    enabled: !!t,
  });
  useServerEvents((e) => {
    if (e.type === "play" && e.status.tmdbId === id) void avail.refetch();
  });
  useInitialFocus("detail-play", !!t);

  if (!t)
    return (
      <Page>
        <div className="flex h-[70vh] items-center justify-center">
          <Spinner />
        </div>
      </Page>
    );

  const a = availabilityText(avail.data ?? t.availability);
  const cur = avail.data ?? t.availability;
  const services = cur.state === "available" || cur.state === "ready" ? cur.services : [];
  const resumable = t.watch && !t.watch.watched && t.watch.positionS > 30;
  const toggleList = async () => {
    await (t.inMyList ? api.removeFromList(id) : api.addToList(id));
    await refetch();
    void qc.invalidateQueries({ queryKey: ["home"] });
  };

  return (
    <Page>
      <section className="relative -mt-24 h-[46rem] overflow-hidden" data-row="detail-hero">
        {t.backdropPath && <img src={img("w1280", t.backdropPath)} alt="" className="absolute inset-0 h-full w-full object-cover" />}
        <div className="hero-scrim absolute inset-0" />
        <div className="relative flex h-full max-w-[56rem] flex-col justify-end px-16 pb-12">
          <h1 className="mb-3 text-7xl font-black leading-none" data-testid="detail-title">
            {t.title}
          </h1>
          {t.tagline && <div className="mb-4 text-2xl italic text-white/70">{t.tagline}</div>}
          <div className="mb-4 flex flex-wrap items-center gap-4 text-xl text-white/80">
            {t.year && <span>{t.year}</span>}
            {t.certification && <span className="rounded border border-white/50 px-2 text-base">{t.certification}</span>}
            {t.runtimeMin && <span>{Math.floor(t.runtimeMin / 60)}h {t.runtimeMin % 60}m</span>}
            {t.rating && <span className="font-semibold text-ok">★ {t.rating.toFixed(1)}</span>}
            <span>{t.genres.join(" · ")}</span>
          </div>
          <p className="mb-4 line-clamp-4 text-xl text-white/90">{t.overview}</p>
          <div className="mb-2 text-lg text-white/60">
            {t.director && <>Director: {t.director} · </>}
            {t.cast.slice(0, 4).map((c) => c.name).join(", ")}
          </div>
          {services.length > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-3 text-xl text-white/70" data-testid="services">
              <span>On</span>
              {services.map((s) => (
                <span key={s.code} className="rounded-md px-3 py-1 text-lg font-bold" style={SERVICE_STYLE[s.code] ?? { background: "rgba(255,255,255,0.15)", color: "#fff" }}>
                  {s.name}
                </span>
              ))}
            </div>
          )}
          <div className={`mb-8 text-xl ${a.tone}`} data-testid="availability">
            {a.text}
          </div>
          <FocusGroup focusKey="detail-actions" className="flex gap-4">
            <Button primary focusKey="detail-play" testId="detail-play" icon={<PlayIcon />} onEnter={() => nav(`/watch/${id}`)}>
              {resumable ? `Resume ${fmtTime(t.watch!.positionS)}` : "Play"}
            </Button>
            {resumable && (
              <Button testId="detail-restart" onEnter={() => nav(`/watch/${id}?from=0`)}>
                Start over
              </Button>
            )}
            <Button testId="detail-list" onEnter={toggleList}>
              {t.inMyList ? "✓ My List" : "+ My List"}
            </Button>
          </FocusGroup>
        </div>
      </section>
      {t.recommendations.length > 0 && <Row row={{ id: "more-like", title: "More like this", items: t.recommendations }} onOpen={(r) => nav(`/title/${r.tmdbId}`)} />}
    </Page>
  );
}

/** Brand-ish colours for service chips (text only, no logos). */
const SERVICE_STYLE: Record<string, { background: string; color: string }> = {
  netflix: { background: "#e50914", color: "#fff" },
  max: { background: "#002be7", color: "#fff" },
  disney: { background: "#113ccf", color: "#fff" },
  hulu: { background: "#1ce783", color: "#0b0c0f" },
  appletv: { background: "#f5f5f7", color: "#000" },
  peacock: { background: "#000", color: "#fff" },
  paramount: { background: "#0064ff", color: "#fff" },
  prime: { background: "#00a8e1", color: "#fff" },
  itunes: { background: "#fb5bc5", color: "#fff" },
  roku: { background: "#662d91", color: "#fff" },
  amc: { background: "#000", color: "#fff" },
  showtime: { background: "#b10000", color: "#fff" },
  starz: { background: "#000", color: "#fff" },
  mubi: { background: "#001489", color: "#fff" },
  criterion: { background: "#111", color: "#fff" },
  tubi: { background: "#fa382f", color: "#fff" },
};
