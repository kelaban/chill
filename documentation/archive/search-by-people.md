> Completed 2026-11-17 — people search shipped as planned (TMDB-gated): People section, person page, and a named person's films in the movie results. Deviation: a single-word query must be a whole word of the name (live data showed "heat" naming Heath Ledger under a prefix rule). DECISIONS D51.

# Search by people

**Problem:** the search box says "Titles, people, genres", but search only
matched titles: typing "denis villeneuve" or "tom hanks" found nothing useful.

**Needs TMDB** (key configured and working, DECISIONS D46). Cinemeta has no
people search, so with TMDB off the box says "Titles" and nothing else changes.

## Server

- `TmdbApi.searchPeople?(q)` → `/search/person` (id, name, photo, department,
  popularity, known-for titles); `TmdbApi.personCredits?(id)` →
  `/person/:id/movie_credits` (cast, and crew as Director). Cached 24 h / 7 d.
  Both go through the catalog gate: TMDB-only, empty when it's off.
- `GET /api/search/people?q=` → up to 6 people (with a photo, or well known).
- `GET /api/people/:id` → name, photo, department, films: directed (for
  directors) or acted in, by popularity, released, with posters.
- **Movie results include the person's films:** when the query names a person
  (normalized name equals the query, or starts with it for queries ≥ 4
  characters), their best-known films join the movie results — first when the
  name matches exactly, after the title matches otherwise. So "villeneuve" or
  "denis villeneuve" lists Dune, Arrival, Sicario….

## Web

- Search: **Movies**, then **People** (round photo, name, "Directing"/"Acting"),
  then TV shows. Placeholder says "Titles, people" only while TMDB is on.
- Person page `/person/:id`: photo, name, department, a grid of their films.

## Tests

- Unit: name-match rule. Integration (fakes): searching a director's name
  returns their films first and lists them under People; the person page lists
  their films; with TMDB off, nothing changes. e2e: search a name → People
  card → person page → a film.
