import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, titleHref } from "../api";
import { FocusGroup, Focusable } from "../components/Focusable";
import { Card, Page, PersonCard, useInitialFocus } from "../components/ui";

const KEYS = "abcdefghijklmnopqrstuvwxyz1234567890".split("");

/** On-screen keyboard (D-pad friendly) plus a real input for phones and laptops. */
export function Search() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [debounced, setDebounced] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    setParams(debounced ? { q: debounced } : {}, { replace: true });
  }, [debounced, setParams]);
  const { data, isFetching } = useQuery({ queryKey: ["search", debounced], queryFn: () => api.search(debounced), enabled: debounced.trim().length > 0, staleTime: 60_000 });
  const people = useQuery({ queryKey: ["search-people", debounced], queryFn: () => api.searchPeople(debounced), enabled: debounced.trim().length > 1, staleTime: 60_000 });
  // People search needs TMDB (key configured and working); say only what works.
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, staleTime: 5 * 60_000 });
  const peopleOn = health.data?.catalog === "tmdb" || health.data?.catalog === "fake";
  const shows = useQuery({ queryKey: ["search-shows", debounced], queryFn: () => api.searchShows(debounced), enabled: debounced.trim().length > 1, staleTime: 60_000 });
  useInitialFocus("key-a", true);

  return (
    <Page>
      <div className="flex gap-12 px-16 pt-4">
        <div className="w-[26rem] shrink-0">
          <input
            data-testid="search-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={peopleOn ? "Titles or people" : "Titles"}
            className="mb-6 w-full rounded bg-white/10 px-5 py-4 text-2xl outline-none ring-2 ring-transparent focus:ring-white"
          />
          <FocusGroup focusKey="keyboard" className="grid grid-cols-6 gap-2">
            {KEYS.map((k) => (
              <Focusable key={k} focusKey={`key-${k}`} testId={`key-${k}`} onEnter={() => setQ((s) => s + k)} className="flex h-14 items-center justify-center rounded bg-white/10 text-2xl uppercase" focusedClassName="!bg-white text-black">
                {k}
              </Focusable>
            ))}
            <Focusable testId="key-space" onEnter={() => setQ((s) => s + " ")} className="col-span-3 flex h-14 items-center justify-center rounded bg-white/10 text-xl" focusedClassName="!bg-white text-black">
              Space
            </Focusable>
            <Focusable testId="key-del" onEnter={() => setQ((s) => s.slice(0, -1))} className="col-span-3 flex h-14 items-center justify-center rounded bg-white/10 text-xl" focusedClassName="!bg-white text-black">
              Delete
            </Focusable>
          </FocusGroup>
        </div>
        <div className="min-w-0 flex-1">
          {!debounced && <div className="pt-10 text-2xl text-white/50">Search every movie. chill finds a copy in the background.</div>}
          {debounced && !isFetching && data?.length === 0 && !shows.data?.length && !people.data?.length && <div className="pt-10 text-2xl text-white/60">Nothing matches "{debounced}".</div>}
          {/* Movies first; TV shows after them. */}
          {!!data?.length && (!!shows.data?.length || !!people.data?.length) && <h2 className="mb-3 text-2xl font-bold text-white/80">Movies</h2>}
          <FocusGroup focusKey="results" className="grid grid-cols-5 gap-5 pb-10" testId="search-results">
            {data?.map((t) => (
              <div key={t.tmdbId} data-row="results">
                <Card fill t={t} onEnter={() => nav(titleHref(t))} />
              </div>
            ))}
          </FocusGroup>
          {/* Then people (TMDB only), then TV shows. */}
          {!!people.data?.length && (
            <>
              <h2 className="mb-3 text-2xl font-bold text-white/80">People</h2>
              <FocusGroup focusKey="people-results" className="grid grid-cols-6 gap-4 pb-10" testId="people-results">
                {people.data.map((p) => (
                  <div key={p.id} data-row="people-results">
                    <PersonCard p={p} onEnter={() => nav(`/person/${p.id}`)} />
                  </div>
                ))}
              </FocusGroup>
            </>
          )}
          {!!shows.data?.length && (
            <>
              <h2 className="mb-3 text-2xl font-bold text-white/80">TV shows</h2>
              <FocusGroup focusKey="show-results" className="grid grid-cols-5 gap-5 pb-10" testId="show-results">
                {shows.data.map((t) => (
                  <div key={t.showId} data-row="show-results">
                    <Card fill t={t} onEnter={() => nav(titleHref(t))} />
                  </div>
                ))}
              </FocusGroup>
            </>
          )}
        </div>
      </div>
    </Page>
  );
}
