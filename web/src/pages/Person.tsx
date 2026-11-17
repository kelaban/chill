import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { api, img, titleHref } from "../api";
import { FocusGroup } from "../components/Focusable";
import { Card, Page, Spinner, useInitialFocus } from "../components/ui";

/** A person's films (from people search; TMDB only). */
export function Person() {
  const id = Number(useParams().id);
  const nav = useNavigate();
  const { data: p, error } = useQuery({ queryKey: ["person", id], queryFn: () => api.person(id) });
  useInitialFocus(`person-film-${p?.movies[0]?.tmdbId ?? ""}`, !!p?.movies.length);

  if (error) return <Page><div className="p-16 text-2xl text-white/70">People need TMDB, and it isn't on right now.</div></Page>;
  if (!p)
    return (
      <Page>
        <div className="flex h-[70vh] items-center justify-center">
          <Spinner />
        </div>
      </Page>
    );
  return (
    <Page>
      <div className="flex items-center gap-10 px-16 pb-10 pt-4">
        <div className="h-48 w-48 shrink-0 overflow-hidden rounded-full bg-ink-3">
          {p.photoPath && <img src={img("w185", p.photoPath)} alt="" className="h-full w-full object-cover" />}
        </div>
        <div>
          <h1 className="text-6xl font-black" data-testid="person-name">
            {p.name}
          </h1>
          <div className="mt-2 text-2xl text-white/70">
            {p.department === "Directing" ? "Director" : p.department === "Acting" ? "Actor" : p.department} · {p.movies.length} films
          </div>
        </div>
      </div>
      <FocusGroup focusKey="person-films" className="grid grid-cols-7 gap-5 px-16" testId="person-films">
        {p.movies.map((t) => (
          <div key={t.tmdbId} data-row="person-films">
            <Card fill focusKey={`person-film-${t.tmdbId}`} t={t} onEnter={() => nav(titleHref(t))} />
          </div>
        ))}
      </FocusGroup>
      {p.movies.length === 0 && <div className="px-16 text-2xl text-white/60">No films to show.</div>}
    </Page>
  );
}
