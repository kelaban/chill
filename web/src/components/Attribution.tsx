import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

/** Credit whichever catalog is answering. TMDB's terms require its notice whenever its data is shown. */
export function CatalogAttribution({ className = "" }: { className?: string }) {
  const h = useQuery({ queryKey: ["health"], queryFn: api.health, staleTime: 5 * 60_000 });
  const c = h.data?.catalog;
  if (!c) return null;
  return (
    <p className={className} data-testid="attribution" data-catalog={c}>
      {c === "cinemeta"
        ? "Movie data from Cinemeta (Stremio) and IMDb."
        : "Movie data and images from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB."}
    </p>
  );
}
