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
| nginx | **Not used yet.** The host's nginx (`~/apps/nginx`) proxies other apps; see *Adding nginx* below |
| Docker | Engine 23.0, Compose v2.17 (old: keep compose files simple; `env_file` must be the plain-list form) |

## Layout on the host

```
~/apps/chill/
  docker-compose.yaml   # host-only file, reproduced below (not the repo's docker/compose.yml)
  .env                  # secrets + budgets, chmod 600. Never committed.
  src/                  # git clone of https://github.com/kelaban/chill (branch: main)
  data/                 # bind-mounted to /data: SQLite DB, cache, library/ (downloaded films)
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
with one host-specific override: `LOCAL_BUDGET_GB=100` (see DECISIONS D32).

## Routine operations

All commands run on the host in `~/apps/chill`. From the laptop, wrap with
`ssh keith@farnsworth 'cd ~/apps/chill && …'`.

| Task | Command |
|---|---|
| **Deploy latest `main`** | `git -C src pull && docker compose up -d --build` |
| Deploy a specific commit | `git -C src fetch && git -C src checkout <sha> && docker compose up -d --build` |
| Status / health | `docker ps --filter name=^chill$` · `curl -s localhost:7878/api/health` |
| Logs | `docker compose logs -f --tail 100` |
| Restart | `docker compose restart` |
| Stop | `docker compose down` (data in `./data` is kept) |
| Edit config | `nano .env` then `docker compose up -d` (re-creates the container with the new env) |
| Clean old images | `docker image prune -f` (after a few rebuilds) |

Deploys only pick up **pushed** commits: push to GitHub first. Fresh clone:
`git clone -b main https://github.com/kelaban/chill src` (`main` is the GitHub
default branch; `-b main` just makes it explicit). The clone is
anonymous HTTPS (the repo is publicly readable), so the host has no git credentials.

A healthy `/api/health` looks like `{"ok":true,"fake":false,"catalog":"cinemeta"}`
(`"tmdb"` once `TMDB_TOKEN` is set). `"fake":true` means demo mode is on, which is wrong for this host.

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
- `LOCAL_BUDGET_GB=100` means chill's library may use roughly all of that. If the disk runs
  low, lower it in `.env` and `docker compose up -d`. Admission control evicts down to
  the new budget. Check with `df -h /` and `du -sh ~/apps/chill/data`.
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
- [`webos.md`](webos.md): installing the TV app.
