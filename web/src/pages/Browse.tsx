import type { TitleSummary } from "@chill/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, titleHref } from "../api";
import { FocusGroup, Focusable } from "../components/Focusable";
import { Card, Page, Spinner, useInitialFocus } from "../components/ui";

const SORTS = [
  { id: "popularity.desc", label: "Popular" },
  { id: "vote_average.desc", label: "Top rated" },
  { id: "primary_release_date.desc", label: "Newest" },
];

export function Browse() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const genre = params.get("genre") ? Number(params.get("genre")) : null;
  const sort = params.get("sort") ?? "popularity.desc";
  const genres = useQuery({ queryKey: ["genres"], queryFn: api.genres, staleTime: Infinity });
  const q = useInfiniteQuery({
    queryKey: ["discover", genre, sort],
    queryFn: ({ pageParam }) => api.discover(genre, pageParam, sort),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (all.length < last.totalPages ? all.length + 1 : undefined),
  });
  useInitialFocus("genre-all", !!genres.data);
  const items: TitleSummary[] = q.data?.pages.flatMap((p) => p.results) ?? [];
  const set = (g: number | null, s = sort) => setParams({ ...(g ? { genre: String(g) } : {}), sort: s }, { replace: true });

  return (
    <Page>
      <div className="px-16">
        <FocusGroup focusKey="genres" className="no-scrollbar mb-4 flex flex-wrap gap-3" testId="genres">
          <Chip focusKey="genre-all" active={!genre} onEnter={() => set(null)}>
            All
          </Chip>
          {genres.data?.map((g) => (
            <Chip key={g.id} active={genre === g.id} onEnter={() => set(g.id)}>
              {g.name}
            </Chip>
          ))}
        </FocusGroup>
        <FocusGroup focusKey="sorts" className="mb-8 flex gap-3">
          {SORTS.map((s) => (
            <Chip key={s.id} active={sort === s.id} onEnter={() => set(genre, s.id)}>
              {s.label}
            </Chip>
          ))}
        </FocusGroup>
        {q.isLoading && <Spinner />}
        <FocusGroup focusKey="grid" className="grid grid-cols-7 gap-5">
          {items.map((t, i) => (
            <div key={`${t.tmdbId}-${i}`} data-row="grid">
              <Card fill t={t} onEnter={() => nav(titleHref(t))} />
            </div>
          ))}
          {q.hasNextPage && (
            <Focusable onEnter={() => q.fetchNextPage()} onFocus={() => q.fetchNextPage()} className="flex aspect-[2/3] items-center justify-center rounded-md bg-white/5 text-xl text-white/60" focusedClassName="ring-4 ring-white">
              {q.isFetchingNextPage ? "Loading…" : "More"}
            </Focusable>
          )}
        </FocusGroup>
      </div>
    </Page>
  );
}

function Chip({ children, active, onEnter, focusKey }: { children: string; active: boolean; onEnter: () => void; focusKey?: string }) {
  return (
    <Focusable focusKey={focusKey} onEnter={onEnter} className={`rounded-full border-2 px-5 py-2 text-lg ${active ? "border-white bg-white/15 font-semibold" : "border-white/30 text-white/75"}`} focusedClassName="!border-white !bg-white !text-black">
      {children}
    </Focusable>
  );
}
