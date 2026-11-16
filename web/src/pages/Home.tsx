import type { TitleSummary } from "@chill/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, img, titleHref } from "../api";
import { FocusGroup } from "../components/Focusable";
import { Button, Page, PlayIcon, Row, Spinner, useInitialFocus } from "../components/ui";
import { useServerEvents } from "../events";
import { CatalogAttribution } from "../components/Attribution";

export function Home() {
  const nav = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["home"], queryFn: api.home, staleTime: 60_000 });
  useServerEvents((e) => {
    if (e.type === "play" && e.status.phase === "ready") void refetch();
  });
  // Resume when there's something to resume; otherwise straight into the first row.
  useInitialFocus(data?.hero ? "hero-play" : `row-${data?.rows[0]?.id ?? ""}`, !!data);
  const open = (t: TitleSummary) => nav(titleHref(t));

  if (isLoading)
    return (
      <Page>
        <div className="flex h-[70vh] items-center justify-center">
          <Spinner />
        </div>
      </Page>
    );
  if (error || !data)
    return (
      <Page>
        <div className="p-16 text-2xl text-white/70">Couldn't reach the server. {String(error ?? "")}</div>
      </Page>
    );

  const h = data.hero;
  return (
    <Page>
      {h && (
        <section data-row="hero" className="relative -mt-24 mb-4 h-[34rem] overflow-hidden" data-testid="hero" data-hero-id={h.tmdbId}>
          {h.backdropPath && <img src={img("w1280", h.backdropPath)} alt="" className="absolute inset-0 h-full w-full object-cover" />}
          <div className="hero-scrim absolute inset-0" />
          <div className="relative flex h-full max-w-[52rem] flex-col justify-end px-16 pb-12">
            <div className="mb-2 text-lg font-semibold uppercase tracking-wider text-white/60">Continue watching</div>
            <h1 className="mb-2 text-6xl font-black leading-none drop-shadow-lg" data-testid="hero-title">
              {h.title}
            </h1>
            {h.subtitle && <div className="mb-2 text-2xl text-white/85">{h.subtitle}</div>}
            <div className="mb-6 mt-3 flex items-center gap-4 text-xl text-white/80">
              <div className="h-1.5 w-64 overflow-hidden rounded-full bg-white/25">
                <div className="h-full bg-accent" style={{ width: `${Math.round((h.progress ?? 0) * 100)}%` }} />
              </div>
              <span data-testid="hero-left">{minutesLeft(h.positionS, h.durationS)}</span>
            </div>
            <FocusGroup focusKey="hero" className="flex gap-4">
              <Button primary focusKey="hero-play" testId="hero-play" icon={<PlayIcon />} onEnter={() => nav(`/watch/${h.tmdbId}`)}>
                Resume
              </Button>
              <Button testId="hero-restart" onEnter={() => nav(`/watch/${h.tmdbId}?from=0`)}>
                Start over
              </Button>
              <Button testId="hero-info" onEnter={() => open(h)}>
                {h.kind === "episode" ? "Episodes" : "More info"}
              </Button>
            </FocusGroup>
          </div>
        </section>
      )}
      {data.rows.map((r) => (
        <Row key={r.id} row={r} onOpen={open} wide={r.id === "continue"} />
      ))}
      <footer className="px-16 pt-8 text-sm text-white/40">
        <CatalogAttribution />
      </footer>
    </Page>
  );
}

/** "1 h 12 min left", "8 min left". */
export function minutesLeft(positionS: number, durationS: number): string {
  const m = Math.max(1, Math.round((durationS - positionS) / 60));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min left` : `${m} min left`;
}
