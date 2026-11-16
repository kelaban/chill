import type { TitleSummary } from "@chill/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, img, titleHref } from "../api";
import { FocusGroup } from "../components/Focusable";
import { Button, Page, PlayIcon, Row, Spinner, useInitialFocus } from "../components/ui";
import { useServerEvents } from "../events";

export function Home() {
  const nav = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["home"], queryFn: api.home, staleTime: 60_000 });
  useServerEvents((e) => {
    if (e.type === "play" && e.status.phase === "ready") void refetch();
  });
  useInitialFocus(data?.rows[0]?.id === "continue" ? "row-continue" : "hero-play", !!data);
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
        <section data-row="hero" className="relative -mt-24 mb-6 h-[42rem] overflow-hidden" data-testid="hero">
          {h.backdropPath && <img src={img("w1280", h.backdropPath)} alt="" className="absolute inset-0 h-full w-full object-cover" />}
          <div className="hero-scrim absolute inset-0" />
          <div className="relative flex h-full max-w-[48rem] flex-col justify-end px-16 pb-16">
            <h1 className="mb-4 text-7xl font-black leading-none drop-shadow-lg">{h.title}</h1>
            <div className="mb-4 flex gap-4 text-xl text-white/80">
              {h.year && <span>{h.year}</span>}
              {h.rating && <span className="font-semibold text-ok">★ {h.rating.toFixed(1)}</span>}
              {h.ready && <span className="font-bold text-ok">Ready to play</span>}
            </div>
            <p className="mb-8 line-clamp-3 text-xl text-white/85">{h.overview}</p>
            <FocusGroup focusKey="hero" className="flex gap-4">
              <Button primary focusKey="hero-play" testId="hero-play" icon={<PlayIcon />} onEnter={() => nav(`/watch/${h.tmdbId}`)}>
                Play
              </Button>
              <Button testId="hero-info" onEnter={() => open(h)}>
                More info
              </Button>
            </FocusGroup>
          </div>
        </section>
      )}
      {data.rows.map((r) => (
        <Row key={r.id} row={r} onOpen={open} wide={r.id === "continue"} />
      ))}
      <footer className="px-16 pt-8 text-sm text-white/40">Movie data and images from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.</footer>
    </Page>
  );
}
