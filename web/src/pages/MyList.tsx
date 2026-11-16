import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { FocusGroup } from "../components/Focusable";
import { Card, Page, useInitialFocus } from "../components/ui";

export function MyList() {
  const nav = useNavigate();
  const { data } = useQuery({ queryKey: ["home"], queryFn: api.home });
  const row = data?.rows.find((r) => r.id === "my-list");
  useInitialFocus("my-list-grid", !!row?.items.length);
  return (
    <Page>
      <div className="px-16">
        <h1 className="mb-2 text-4xl font-bold">My List</h1>
        <p className="mb-8 text-xl text-white/60">Everything here downloads in the background when there's room, so it starts instantly.</p>
        {!row?.items.length && <div className="text-2xl text-white/50">Nothing yet. Add titles from their detail page.</div>}
        <FocusGroup focusKey="my-list-grid" className="grid grid-cols-7 gap-5">
          {row?.items.map((t) => (
            <div key={t.tmdbId} data-row="list">
              <Card fill t={t} onEnter={() => nav(`/title/${t.tmdbId}`)} />
            </div>
          ))}
        </FocusGroup>
      </div>
    </Page>
  );
}
