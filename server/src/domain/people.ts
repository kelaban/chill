// Searching by people: does a query name this person, and which of their films
// to show. Pure.

import type { TmdbCredit } from "../adapters/types.js";

const words = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * "exact": the query is the name ("Denis Villeneuve", "denis villeneuve").
 * "partial": the query's words are whole words of the name ("villeneuve",
 * "bong joon"), except that the last of several may be cut short ("tom han");
 * at least 4 letters. So "heat" doesn't name Heath Ledger. Otherwise null.
 */
export function nameMatch(name: string, query: string): "exact" | "partial" | null {
  const n = words(name);
  const q = words(query);
  if (!q.length || !n.length) return null;
  if (n.join(" ") === q.join(" ")) return "exact";
  if (q.join("").length < 4) return null;
  const ok = q.every((w, i) => n.some((x) => x === w || (q.length > 1 && i === q.length - 1 && x.startsWith(w))));
  return ok ? "partial" : null;
}

const DIRECTED = new Set(["Director"]);

/**
 * Someone's films, best known first (by vote count, which tracks how widely a
 * film was seen better than TMDB's day-to-day popularity). Directors lead with
 * what they directed, everyone else with what they acted in; the other list
 * follows. Released films with a poster only, no repeats.
 */
export function filmography(credits: { cast: TmdbCredit[]; crew: TmdbCredit[] }, department: string | null | undefined, today: string, max = 40): TmdbCredit[] {
  const usable = (m: TmdbCredit) => !!m.poster_path && !!m.release_date && m.release_date <= today;
  const known = (xs: TmdbCredit[]) => [...xs].filter(usable).sort((a, b) => (b.vote_count ?? 0) - (a.vote_count ?? 0));
  const directed = known(credits.crew.filter((c) => DIRECTED.has(c.job ?? "")));
  const acted = known(credits.cast);
  const ordered = department === "Directing" ? [...directed, ...acted] : [...acted, ...directed];
  const seen = new Set<number>();
  return ordered.filter((m) => !seen.has(m.id) && seen.add(m.id)).slice(0, max);
}
