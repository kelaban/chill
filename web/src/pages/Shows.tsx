import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, titleHref } from "../api";
import { Page, Row, Spinner, useInitialFocus } from "../components/ui";

/** TV Shows: Continue Watching, then what's popular on each service (from chill.institute). */
export function Shows() {
  const nav = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ["shows"], queryFn: api.shows, staleTime: 60_000 });
  useInitialFocus(data?.rows[0] ? `row-${data.rows[0].id}` : "nav", !!data);
  return (
    <Page>
      <h1 className="mb-6 px-16 text-4xl font-bold">TV Shows</h1>
      {isLoading && (
        <div className="flex h-[50vh] items-center justify-center">
          <Spinner />
        </div>
      )}
      {data?.rows.length === 0 && <div className="px-16 text-2xl text-white/60">No shows right now. Try again in a little while.</div>}
      {data?.rows.map((r) => (
        <Row key={r.id} row={r} wide={r.id === "continue-tv"} onOpen={(t) => nav(titleHref(t))} />
      ))}
    </Page>
  );
}
