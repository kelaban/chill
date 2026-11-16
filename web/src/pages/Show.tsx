import type { EpisodeItem } from "@chill/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, fmtTime, img } from "../api";
import { FocusGroup, Focusable } from "../components/Focusable";
import { Button, Page, PlayIcon, Spinner, useInitialFocus } from "../components/ui";

/** A show: Play/Resume the right episode, season tabs, and the episode list. */
export function Show() {
  const imdb = useParams().imdb!;
  const nav = useNavigate();
  const { data: show } = useQuery({ queryKey: ["show", imdb], queryFn: () => api.show(imdb) });
  const [season, setSeason] = useState<number | null>(null);
  useEffect(() => {
    if (show && season === null) setSeason(show.next?.season ?? show.seasons[0]?.number ?? 1);
  }, [show, season]);
  const eps = useQuery({ queryKey: ["season", imdb, season], queryFn: () => api.season(imdb, season!), enabled: season !== null });
  useInitialFocus("show-play", !!show);

  if (!show)
    return (
      <Page>
        <div className="flex h-[70vh] items-center justify-center">
          <Spinner />
        </div>
      </Page>
    );

  const n = show.next;
  return (
    <Page>
      <section className="relative -mt-24 h-[40rem] overflow-hidden" data-row="show-hero">
        {show.backdropPath && <img src={img("w1280", show.backdropPath)} alt="" className="absolute inset-0 h-full w-full object-cover" />}
        <div className="hero-scrim absolute inset-0" />
        <div className="relative flex h-full max-w-[56rem] flex-col justify-end px-16 pb-10">
          <h1 className="mb-3 text-7xl font-black leading-none" data-testid="show-title">
            {show.title}
          </h1>
          <div className="mb-4 flex flex-wrap items-center gap-4 text-xl text-white/80">
            {show.year && <span>{show.year}</span>}
            {show.rating && <span className="font-semibold text-ok">★ {show.rating.toFixed(1)}</span>}
            <span>
              {show.seasons.length} season{show.seasons.length === 1 ? "" : "s"}
            </span>
            {show.networks.length > 0 && <span className="rounded-md bg-white/15 px-3 py-0.5 font-semibold">{show.networks.join(" · ")}</span>}
            <span>{show.genres.slice(0, 3).join(" · ")}</span>
          </div>
          <p className="mb-6 line-clamp-3 text-xl text-white/90">{show.overview}</p>
          <FocusGroup focusKey="show-actions" className="flex gap-4">
            {n && (
              <Button primary focusKey="show-play" testId="show-play" icon={<PlayIcon />} onEnter={() => nav(`/watch/${n.tmdbId}`)}>
                {n.resume ? `Resume S${n.season} E${n.episode} · ${fmtTime(n.positionS)}` : `Play S${n.season} E${n.episode}`}
              </Button>
            )}
          </FocusGroup>
        </div>
      </section>

      <FocusGroup focusKey="seasons" className="mb-6 flex flex-wrap gap-3 px-16" testId="seasons">
        {show.seasons.map((s) => (
          <Focusable
            key={s.number}
            testId={`season-${s.number}`}
            onEnter={() => setSeason(s.number)}
            onFocus={() => setSeason(s.number)}
            className={`rounded-full border-2 px-5 py-2 text-lg ${season === s.number ? "border-white bg-white/15 font-semibold" : "border-white/30 text-white/75"}`}
            focusedClassName="!border-white !bg-white !text-black"
          >
            {s.name}
          </Focusable>
        ))}
      </FocusGroup>

      <FocusGroup focusKey="episodes" className="flex flex-col gap-3 px-16 pb-10" testId="episodes">
        {eps.isLoading && <Spinner />}
        {eps.data?.map((e) => (
          <Episode key={e.tmdbId} e={e} poster={show.backdropPath} onPlay={() => nav(`/watch/${e.tmdbId}`)} />
        ))}
      </FocusGroup>
    </Page>
  );
}

function Episode({ e, poster, onPlay }: { e: EpisodeItem; poster: string | null; onPlay: () => void }) {
  return (
    <div data-row={`ep-${e.tmdbId}`}>
      <Focusable testId={`episode-${e.season}-${e.episode}`} onEnter={onPlay} className="flex gap-6 rounded-xl bg-white/5 p-4" focusedClassName="!bg-white/15 ring-4 ring-white">
        <div className="relative aspect-video w-[18rem] shrink-0 overflow-hidden rounded-lg bg-ink-3">
          {(e.stillPath ?? poster) && <img src={img("w500", e.stillPath ?? poster)} alt="" loading="lazy" className="h-full w-full object-cover" />}
          {e.progress !== null && (
            <div className="absolute inset-x-0 bottom-0 h-1.5 bg-white/30">
              <div className="h-full bg-accent" style={{ width: `${Math.round(e.progress * 100)}%` }} />
            </div>
          )}
          {e.ready && <div className="absolute left-2 top-2 rounded bg-ok px-2 py-0.5 text-xs font-bold text-black">READY</div>}
        </div>
        <div className="min-w-0 py-1">
          <div className="text-2xl font-semibold">
            {e.episode}. {e.name}
            {e.watched && <span className="ml-3 text-lg text-ok">✓ watched</span>}
          </div>
          <div className="mb-2 text-lg text-white/50">
            {e.runtimeMin ? `${e.runtimeMin} min` : ""}
            {e.airDate ? `${e.runtimeMin ? " · " : ""}${e.airDate}` : ""}
          </div>
          <p className="line-clamp-2 text-lg text-white/75">{e.overview}</p>
        </div>
      </Focusable>
    </div>
  );
}
