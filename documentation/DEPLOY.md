# chill — Deployment (farnsworth)

> Living document. How chill runs on the home server and how to maintain it.
> Update it in place whenever the deployment changes.

First deployed 2026-11-16.

## At a glance

| | |
|---|---|
| Host | `farnsworth` (Ubuntu, x86_64, LAN IP `192.168.1.21`). SSH: `ssh keith@farnsworth` |
| URL | **http://192.168.1.21:7878** (also `http://chill.farnsworth.home:7878`; `*.farnsworth.home` is wildcard DNS to the host) |
| TV package | `CHILL_URL=http://192.168.1.21:7878 npm run webos:package` |
| App dir | `~/apps/chill/` (same pattern as the host's other apps in `~/apps/<app>/`) |
| Container | `chill`, compose project `chill`, image `chill:local` built **on the host** |
| Updates | **Automatic.** Push to `main`; farnsworth builds it and switches within ~5–10 min, never mid-movie (see *Self-update*) |
| nginx | **Not used yet.** The host's nginx (`~/apps/nginx`) proxies other apps; see *Adding nginx* below |
| Docker | Engine 23.0, Compose v2.17 (old: keep compose files simple; `env_file` must be the plain-list form) |

## Layout on the host

```
~/apps/chill/
  docker-compose.yaml   # host-only file, reproduced below (not the repo's docker/compose.yml)
  .env                  # secrets + budgets, chmod 600. Never committed.
  src/                  # git clone of https://github.com/kelaban/chill (branch: main): builds the image and
                        #   holds webos/renew-devmode.sh. Self-update doesn't touch it; the hourly
                        #   devmode cron job runs `git pull --ff-only` here (see webos.md)
  data/                 # bind-mounted to /data: SQLite DB, cache, library/ (downloaded films),
                        #   releases/ (self-update builds and state)
```

`docker-compose.yaml`:

```yaml
name: chill
services:
  chill:
    image: chill:local
    build:
      context: ./src
      dockerfile: docker/Dockerfile
    container_name: chill
    restart: unless-stopped
    ports:
      - "7878:7878"
    env_file:
      - .env
    volumes:
      - ./data:/data
```

`.env` started as a copy of the developer's `docker/.env` (format: `docker/.env.example`),
with host-specific overrides: `LOCAL_BUDGET_GB=100` (see DECISIONS D32) and
`CHILL_AUTO_UPDATE=1` (self-update).

## Self-update

The image's entrypoint is `docker/supervise.sh`. With `CHILL_AUTO_UPDATE=1` it keeps
chill on the latest `main`, with no cron, no Docker socket and no registry:

1. A poller inside the container fetches `main` every 5 min (`CHILL_UPDATE_POLL_S`).
   For a new commit it builds a release beside the running one in
   `data/releases/builds/<sha>/` (`npm ci` + build), then writes `data/releases/pending`.
2. The server checks `pending` every 30 s. Once nothing has played for 2 minutes it shuts
   down gracefully and **exits 75**. Interrupted downloads and jobs resume on restart.
3. The supervisor swaps `current → previous` and `pending → current`, and starts the new
   release in a few seconds. `/api/health` reports the running `commit` (`null` = the image's own build).

Failure handling:

- **Build fails:** the commit goes on `data/releases/bad` and is skipped. The running
  release is untouched. Build output is in `data/releases/logs/build-<sha>.log`.
- **New release crashes within 10 min of the swap** (`CHILL_ROLLBACK_WINDOW_S`): the commit is
  marked bad and the previous release starts again. Push a fix and it's picked up as usual.
- **Any other crash:** restarted in place with backoff (5 s doubling to 160 s).
  If the whole container exits, Docker's `restart: unless-stopped` brings it back.
- **Schema:** older code ignores migrations it doesn't know, so additive migrations
  roll back fine. A destructive migration needs a fix-forward (DECISIONS D35).

What self-update does **not** cover: changes to `docker/` itself (the Dockerfile, the
supervisor, system packages). The supervisor logs a warning when a commit touches
`docker/`. Apply those with a manual image rebuild (below).

State files in `data/releases/` (plain text, safe to read): `current`, `previous`,
`pending`, `bad`, `swapped_at`, plus `repo/` (bare clone), `builds/`, `logs/`, `.npm/`.

- Skip a commit by hand: `echo <full-sha> >> data/releases/bad`.
- Retry a commit that was marked bad: remove its line from `bad`.
- Pin a release: set `CHILL_AUTO_UPDATE=0` in `.env` and `docker compose up -d`.
  This runs the image's own build. To pin a specific commit, check it out in `src/` and rebuild.

## Routine operations

All commands run on the host in `~/apps/chill`. From the laptop, wrap with
`ssh keith@farnsworth 'cd ~/apps/chill && …'`.

| Task | Command |
|---|---|
| Deploy latest `main` | Nothing: push, and self-update picks it up |
| **Rebuild the image** (after `docker/` changes) | `git -C src pull && docker compose up -d --build` (interrupts playback: pick a quiet moment) |
| Status / health | `docker ps --filter name=^chill$` · `curl -s localhost:7878/api/health` |
| What's running / staged | `cat data/releases/current data/releases/pending 2>/dev/null` |
| Logs | `docker compose logs -f --tail 100` (supervisor lines start with `supervisor:`) |
| Self-update history | `docker compose logs \| grep supervisor:` |
| Restart | `docker compose restart` |
| Stop | `docker compose down` (data in `./data` is kept) |
| Edit config | `nano .env` then `docker compose up -d` (re-creates the container with the new env) |
| Clean old images | `docker image prune -f` (after a few rebuilds) |

Self-update and rebuilds only pick up **pushed** commits. Fresh clone:
`git clone -b main https://github.com/kelaban/chill src` (`main` is the GitHub
default branch; `-b main` just makes it explicit). The clone is
anonymous HTTPS (the repo is publicly readable), so the host has no git credentials.

A healthy `/api/health` looks like `{"ok":true,"fake":false,"catalog":"tmdb","tmdb":{"state":"ok",…}}`.
`"catalog":"cinemeta"` means TMDB is off: `tmdb.state` says why — `off` (no
`TMDB_TOKEN` in `.env`), `rejected` (TMDB refused the key: use the *API Read
Access Token*, not the short API key), or `unreachable` (re-checked every 15 min).
The About page shows the same. `"fake":true` means demo mode is on, which is wrong for this host.

## Verifying a build without touching real data

To smoke-test an image in demo mode alongside the live one (separate port, no
volume, removed afterwards):

```sh
docker run -d --rm --name chill-smoke -e CHILL_FAKE=1 -p 127.0.0.1:7879:7878 chill:local
curl -s localhost:7879/api/health   # wait a few seconds after start
docker stop chill-smoke
```

Never run demo mode against `./data`: fake titles and variants would land in the real DB.

## Secrets

- `CHILL_TOKEN`, `PUTIO_TOKEN` (required), `TMDB_TOKEN` (optional) live only in
  `~/apps/chill/.env` on the host and in the developer's gitignored `docker/.env`.
- To rotate: edit `.env` on the host, then `docker compose up -d`. Don't paste tokens
  into chat or commit them. Copy them with `scp`, or edit them in place.
- Agents: check whether a token is set without printing it, e.g.
  `awk -F= '/_TOKEN=/{print $1, (length($2)?"set":"EMPTY")}' .env`.

## Storage and disk

- The host has a single ~228 GB root disk, shared with Home Assistant, Frigate
  recordings, Plex metadata, etc. About 99 GB was free at first deploy.
- The home library is a **cache of what's on now** (DECISIONS D33): pressing Play clears
  every other title's home copy. Normally that's one film, plus My List prefetches that
  landed since the last Play.
- `LOCAL_BUDGET_GB=100` is the backstop on top of that. If the disk runs
  low, lower it in `.env` and `docker compose up -d`. Admission control evicts down to
  the new budget. Check with `df -h /` and `du -sh ~/apps/chill/data`.
- Self-update keeps up to three builds (current, previous, staged). Each is
  a few hundred MB, in `data/releases/builds/`.
- `./data` is runtime state. Not in git, and not backed up yet (farnsworth-mgmt's restic
  plan is not implemented). Losing it loses watch progress and the local library.
  put.io copies and the catalog are recoverable.

## Adding nginx (not done)

The host's nginx (linuxserver image, `~/apps/nginx/config/nginx/site-confs/*.conf`,
auto-reloads on change) proxies other apps as `<name>.farnsworth.home` →
`http://192.168.1.21:<port>`. A site conf for chill must disable buffering, because video uses
range requests and `/api/events` is SSE:

```nginx
server {
  listen          80;
  server_name     chill.farnsworth.home;

  location / {
    proxy_pass      http://192.168.1.21:7878;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;
    proxy_buffering         off;
    proxy_request_buffering off;
    proxy_read_timeout      1h;
    proxy_send_timeout      1h;
  }
}
```

If you add it, rebuild the TV package with `CHILL_URL=http://chill.farnsworth.home`
and test playback and the seamless upgrade through the proxy before relying on it.

## Related

- `../farnsworth-mgmt` (sibling repo on the laptop): the host's IaC **plan**
  (sops secrets, restic backups, push-deploy). Mostly unimplemented, so treat it as intent,
  not as the current state. If it lands, chill should move under it as `apps/chill/`.
- [`webos.md`](webos.md): installing the TV app, and the hourly Developer Mode
  renewal cron job on farnsworth (`~/apps/chill/src/webos/renew-devmode.sh`, log in `~/apps/chill/devmode.log`).
