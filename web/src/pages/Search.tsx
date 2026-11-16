import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { FocusGroup, Focusable } from "../components/Focusable";
import { Card, Page, useInitialFocus } from "../components/ui";

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
  useInitialFocus("key-a", true);

  return (
    <Page>
      <div className="flex gap-12 px-16 pt-4">
        <div className="w-[26rem] shrink-0">
          <input
            data-testid="search-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Titles, people, genres"
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
          {debounced && !isFetching && data?.length === 0 && <div className="pt-10 text-2xl text-white/60">Nothing matches "{debounced}".</div>}
          <FocusGroup focusKey="results" className="grid grid-cols-5 gap-5 pb-10" testId="search-results">
            {data?.map((t) => (
              <div key={t.tmdbId} data-row="results">
                <Card fill t={t} onEnter={() => nav(`/title/${t.tmdbId}`)} />
              </div>
            ))}
          </FocusGroup>
        </div>
      </div>
    </Page>
  );
}
