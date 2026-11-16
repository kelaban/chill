import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { Page } from "../components/ui";

export function About() {
  const h = useQuery({ queryKey: ["health"], queryFn: api.health });
  return (
    <Page>
      <div className="max-w-[60rem] px-16 text-xl leading-relaxed text-white/80">
        <h1 className="mb-6 text-4xl font-bold text-white">About chill</h1>
        <p className="mb-4">A personal streaming app: browse every movie, press Play, and chill finds a release on chill.institute, downloads it via put.io, and plays it here — a fast copy first, a better one later.</p>
        {h.data?.fake && <p className="mb-4 font-semibold text-yellow-300">Demo mode: TMDB, chill.institute and put.io are simulated, and every film is a generated test clip.</p>}
        <p className="mb-4">Browser: {navigator.userAgent}</p>
        <p className="mt-10 text-base text-white/50">This product uses the TMDB API but is not endorsed or certified by TMDB. chill is not affiliated with chill.institute or put.io.</p>
      </div>
    </Page>
  );
}
