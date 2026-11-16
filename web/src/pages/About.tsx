import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Page } from "../components/ui";
import { CatalogAttribution } from "../components/Attribution";

export function About() {
  const h = useQuery({ queryKey: ["health"], queryFn: api.health });
  return (
    <Page>
      <div className="max-w-[60rem] px-16 text-xl leading-relaxed text-white/80">
        <h1 className="mb-6 text-4xl font-bold text-white">About chill</h1>
        <p className="mb-4">A personal streaming app: browse every movie, press Play, and chill finds a release on chill.institute, downloads it via put.io, and plays it here — a fast copy first, a better one later.</p>
        {h.data?.fake && <p className="mb-4 font-semibold text-yellow-300">Demo mode: TMDB, chill.institute and put.io are simulated, and every film is a generated test clip.</p>}
        <p className="mb-4">Browser: {navigator.userAgent}</p>
        {h.data && !h.data.fake && (
          <p className="mb-4" data-testid="catalog-status">
            Catalog: {h.data.catalog === "tmdb" ? "TMDB" : "Cinemeta"}
            {h.data.tmdb.state === "off" && " (no TMDB key configured)"}
            {h.data.tmdb.state === "rejected" && " — TMDB rejected the configured key; check the server’s .env"}
            {h.data.tmdb.state === "unreachable" && " — TMDB is unreachable right now; retrying every 15 minutes"}
          </p>
        )}
        <CatalogAttribution className="mt-10 text-base text-white/50" />
        <p className="text-base text-white/50">chill is not affiliated with chill.institute or put.io.</p>
      </div>
    </Page>
  );
}
