# Local tier as a cache · "Recent" row · self-updating server

**Goal:** three small changes requested after the first farnsworth deploy.

1. The home server's library is a **cache of what's being watched now**, not a
   collection. Starting a video clears every other title's home copy.
2. The home row "Ready to Play" becomes **"Recent"**.
3. farnsworth **updates itself** when `main` gets a new commit, without a Docker
   socket, without interrupting playback, and with rollback if a new build is bad.

## 1. Local cache

- Pure `cacheEvictions(localVariants, keepTmdbId, now)` in `domain/storage.ts`:
  every local copy of another title that `evictionClass` allows to go (so never
  playing, pinned or protected copies).
- `clearLocalCache(ctx, tmdbId)` in `services/storage.ts` applies it
  (reason `cache: started <tmdbId>`), called from `play()` on a real Play (not a
  My List prefetch), before the new title's acquisition or resume.
- Budgets, watermarks, admission control and the hourly sweep stay as they are.
  They still apply to put.io, and they cover local copies that land between Plays (prefetches).
- Consequence: replaying an evicted title re-acquires it; resume position survives (PRD G5).

## 2. "Recent" row

- Row id `recent`, title "Recent". It lists titles this profile played, plus titles the household
  acquired (not failed or cancelled), newest activity first, max 20. It no longer depends on a copy
  still existing, since the cache now empties often. The ready badge still shows which ones are on hand.

## 3. Self-update (exit-code handoff)

- Image: `docker/supervise.sh` becomes the entrypoint (under `tini -g`). Without
  `CHILL_AUTO_UPDATE=1` it just execs the baked server, so behaviour is unchanged.
- With it, the supervisor keeps releases in `/data/releases/` (a clone, plus one build
  dir per commit, symlinks `current` / `previous`, a `bad` list):
  - **poller** (background, every `CHILL_UPDATE_POLL_S`, default 300): fetches the
    branch. For a new commit that's not in the bad list, it builds it beside the running one
    (`git worktree` → `npm ci` → `npm run build` → `npm prune --omit=dev`), then
    writes `pending`. A failed build goes on the bad list.
  - **server** (`services/selfUpdate.ts`): every 30 s, if `pending` names a different
    commit and nothing has played in the last 2 minutes, it shuts down gracefully and exits **75**.
  - **supervisor** on exit 75: `previous ← current ← pending`, start the new release.
    On a crash within 10 min of a swap: add the commit to the bad list and roll back to `previous`.
    Other crashes restart with backoff. Exit 0/143 (container stop) ends the container.
- Without a built release yet (first boot) it runs the baked code, and the poller
  stages the latest commit right away.
- `/api/health` reports `commit`.
- Changes under `docker/` (Dockerfile, the supervisor) still need a manual image rebuild.
  The poller logs a warning when a new commit touches them.

## Acceptance

- Unit tests: `cacheEvictions`; the update decision.
- Integration: starting another title evicts the previous title's home copy and file;
  "Recent" lists the evicted title.
- Supervisor: tested locally against a scratch repo (swap on 75, rollback on fast crash,
  bad build skipped).
- farnsworth: runs with `CHILL_AUTO_UPDATE=1`. A pushed commit shows up in
  `/api/health.commit` within ~10 min without manual steps.
- Docs: PRD storage section, ARCHITECTURE eviction, DEPLOY, DECISIONS.
