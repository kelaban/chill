# chill

A personal, Netflix-style streaming app for the LG webOS TV.

Browse or search every movie (TMDB) → press **Play** → chill finds a release on
[chill.institute](https://chill.institute), sends it to [put.io](https://put.io),
and starts playing as soon as a watchable copy exists. A better copy downloads in
the background, is copied to the home server, and **swaps in mid-movie without a
visible seam**. Storage on put.io and at home is managed automatically; your
place in every movie is kept.

**Status:** Phases 1–2 built and tested in demo mode. Waiting on API keys and
the TV for real-world testing: see [`documentation/DECISIONS.md`](documentation/DECISIONS.md).

## Try it now (demo mode, no keys)

```sh
npm install
npm run dev            # http://localhost:5173 — fake TMDB/chill/put.io, generated test films
```

Or the production build: `npm run demo` → http://localhost:7878 (add `/tv` for TV mode).
Demo mode simulates the three services and plays generated test clips, so the
whole flow works: Play, the fast copy, the seamless upgrade, the copy home, and
cleanup.

## Run it for real

1. Get three tokens (all free):
   - **TMDB**: themoviedb.org → Settings → API → *API Read Access Token*
   - **chill.institute**: chill.institute/auth/chilly-token
   - **put.io**: app.put.io/oauth → create an app → key icon → *OAuth token*
2. On the home server: `cp docker/.env.example docker/.env`, fill in the tokens, then
   `docker compose -f docker/compose.yml up -d` → http://&lt;server&gt;:7878
3. On the TV (Developer Mode on, see [`documentation/webos.md`](documentation/webos.md)):
   `CHILL_URL=http://<server-ip>:7878 npm run webos:package`, then install the IPK.

## Commands

| Task | Command |
|---|---|
| Dev (server + Vite, demo mode without tokens) | `npm run dev` |
| Typecheck | `npm run typecheck` |
| Unit + integration tests | `npm test` |
| End-to-end (headless Chromium, remote keys) | `npm run test:e2e` |
| Live API smoke tests (need tokens) | `npm run test:live` |
| Build | `npm run build` |
| Bundle secret check | `npm run check:bundle` |
| TV app package | `CHILL_URL=… npm run webos:package` |

## Read more

| Doc | For |
|---|---|
| [`documentation/PRD.md`](documentation/PRD.md) | What and why; goals and acceptance criteria |
| [`documentation/ARCHITECTURE.md`](documentation/ARCHITECTURE.md) | How: components, data model, flows, the seamless upgrade |
| [`documentation/DECISIONS.md`](documentation/DECISIONS.md) | Calls made on assumptions, and what would change them |
| [`documentation/ROADMAP.md`](documentation/ROADMAP.md) | Phases 0–6 |
| [`documentation/TESTING.md`](documentation/TESTING.md) | What's tested where, and what needs a human at the TV |
| [`documentation/webos.md`](documentation/webos.md) | Installing on the LG TV |
| [`CLAUDE.md`](CLAUDE.md) | Conventions for agents (and humans) working here |
