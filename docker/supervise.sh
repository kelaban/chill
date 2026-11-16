#!/usr/bin/env bash
# chill supervisor: the container's entrypoint (under tini).
#
# Without CHILL_AUTO_UPDATE=1 it just runs the server baked into the image.
#
# With it, chill keeps itself on the latest commit of CHILL_BRANCH:
#   - a background poller fetches the branch every CHILL_UPDATE_POLL_S seconds, builds a
#     new commit beside the running one (git worktree + npm), and names it in $ROOT/pending.
#     A commit whose build fails goes on $ROOT/bad and is skipped.
#   - the server notices `pending`, waits until nothing is playing, shuts down gracefully
#     and exits 75 (server/src/services/selfUpdate.ts).
#   - on 75 this loop swaps current → previous, pending → current, and starts it.
#     If a release crashes within CHILL_ROLLBACK_WINDOW_S of being swapped in, it's marked
#     bad and the previous release comes back. Other crashes restart with backoff.
#
# State in $ROOT (default $DATA_DIR/releases): repo/ (bare clone), builds/<sha>/,
# current, previous, pending, bad, swapped_at, logs/. "baked" names the image's own code.
# This file is baked into the image: changes to it (or the Dockerfile) need an image rebuild.

set -uo pipefail

BAKED_DIR=${CHILL_BAKED_DIR:-/app}

case "${CHILL_AUTO_UPDATE:-0}" in
  1 | true) ;;
  *) exec node "$BAKED_DIR/server/dist/main.js" ;;
esac

REPO=${CHILL_REPO:-https://github.com/kelaban/chill}
BRANCH=${CHILL_BRANCH:-main}
POLL_S=${CHILL_UPDATE_POLL_S:-300}
ROLLBACK_WINDOW_S=${CHILL_ROLLBACK_WINDOW_S:-600}
ROOT=${CHILL_RELEASES_DIR:-${DATA_DIR:-/data}/releases}
BUILD_CMD=${CHILL_BUILD_CMD:-"npm ci --include=dev --no-audit --no-fund && npm run build -w web && npm run build -w server && npm prune --omit=dev --no-audit --no-fund"}
EXIT_UPDATE=75

log() { local m=${1//\\/\/} && m=${m//\"/\'}; printf '{"t":"%s","level":"%s","msg":"supervisor: %s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${2:-info}" "$m"; }
get() { cat "$ROOT/$1" 2>/dev/null || true; }
put() { printf '%s\n' "$2" >"$ROOT/$1.tmp" && mv "$ROOT/$1.tmp" "$ROOT/$1"; }
dir_for() { if [[ "$1" == baked ]]; then echo "$BAKED_DIR"; else echo "$ROOT/builds/$1"; fi; }
is_bad() { grep -qx "$1" "$ROOT/bad" 2>/dev/null; }
short() { echo "${1:0:7}"; }

# ---- poller: fetch, build, stage ------------------------------------------------

gc_builds() {
  local keep=" $(get current) $(get previous) $(get pending) $1 " d
  for d in "$ROOT"/builds/*/; do
    [[ -d "$d" ]] || continue
    d=${d%/}
    [[ "$keep" == *" ${d##*/} "* ]] && continue
    git -C "$ROOT/repo" worktree remove --force "$d" 2>/dev/null || rm -rf "$d"
  done
  git -C "$ROOT/repo" worktree prune
}

build() {
  local sha=$1 d="$ROOT/builds/$1" blog="$ROOT/logs/build-$(short "$1").log"
  gc_builds "$sha"
  rm -rf "$d"
  git -C "$ROOT/repo" worktree prune
  git -C "$ROOT/repo" worktree add --quiet --detach "$d" "$sha" >"$blog" 2>&1 || return 1
  (cd "$d" && NODE_ENV=production npm_config_cache="$ROOT/.npm" nice -n 10 bash -c "$BUILD_CMD") >>"$blog" 2>&1 || return 1
  [[ -f "$d/server/dist/main.js" ]]
}

check_once() {
  git -C "$ROOT/repo" fetch --quiet "$REPO" "$BRANCH" 2>"$ROOT/logs/fetch.log" || { log "fetch of $BRANCH failed: $(tail -1 "$ROOT/logs/fetch.log")" warn; return; }
  local sha cur
  sha=$(git -C "$ROOT/repo" rev-parse FETCH_HEAD) || return
  cur=$(get current)
  [[ "$sha" == "$cur" || "$sha" == "$(get pending)" ]] && return
  is_bad "$sha" && return
  log "new commit $(short "$sha") on $BRANCH; building"
  if build "$sha"; then
    if [[ "$cur" != baked ]] && ! git -C "$ROOT/repo" diff --quiet "$cur" "$sha" -- docker/ 2>/dev/null; then
      log "$(short "$sha") changes docker/; rebuild the image to pick that part up (docker compose up -d --build)" warn
    fi
    put pending "$sha"
    log "staged $(short "$sha"); chill switches to it when nothing is playing"
  else
    echo "$sha" >>"$ROOT/bad"
    log "build of $(short "$sha") failed (logs/build-$(short "$sha").log); skipping that commit" error
  fi
}

poll() {
  trap - TERM INT
  while :; do
    check_once
    sleep "$POLL_S" &
    wait $!
  done
}

# ---- main loop: run, swap, roll back --------------------------------------------

child=""
poller=""
stopping=0
on_stop() {
  stopping=1
  [[ -n "$child" ]] && kill -TERM "$child" 2>/dev/null
  [[ -n "$poller" ]] && kill -TERM "$poller" 2>/dev/null
}

swap_in_pending() {
  local next cur
  next=$(get pending)
  cur=$(get current)
  [[ -z "$next" ]] && { log "server asked for an update but nothing is staged; restarting as is" warn; return; }
  put previous "$cur"
  put current "$next"
  put swapped_at "$(date +%s)"
  rm -f "$ROOT/pending"
  log "switched $(short "$cur") → $(short "$next")"
}

main() {
  mkdir -p "$ROOT/builds" "$ROOT/logs"
  [[ -d "$ROOT/repo" ]] || git init --quiet --bare "$ROOT/repo"
  [[ -n "$(get current)" ]] || put current baked
  export CHILL_RELEASES_DIR="$ROOT"

  trap on_stop TERM INT
  poll &
  poller=$!

  local crashes=0
  while :; do
    local cur dir started code
    cur=$(get current)
    dir=$(dir_for "$cur")
    if [[ ! -f "$dir/server/dist/main.js" ]]; then
      log "release $(short "$cur") is missing; falling back to the image's own build" warn
      cur=baked
      put current baked
      dir=$BAKED_DIR
    fi
    started=$(date +%s)
    log "starting $(short "$cur")"
    if [[ "$cur" == baked ]]; then
      (unset CHILL_COMMIT; exec node "$dir/server/dist/main.js") &
    else
      CHILL_COMMIT=$cur node "$dir/server/dist/main.js" &
    fi
    child=$!
    while :; do
      wait "$child"
      code=$?
      kill -0 "$child" 2>/dev/null || break # still alive: a trap interrupted wait
    done
    child=""

    if ((stopping)); then
      log "stopped"
      wait "$poller" 2>/dev/null
      exit 0
    fi
    case $code in
      "$EXIT_UPDATE")
        crashes=0
        swap_in_pending
        ;;
      0)
        log "server exited cleanly"
        kill -TERM "$poller" 2>/dev/null
        exit 0
        ;;
      *)
        local swapped prev now
        swapped=$(get swapped_at)
        prev=$(get previous)
        now=$(date +%s)
        if [[ -n "$swapped" && -n "$prev" && "$cur" != baked ]] && ((now - swapped < ROLLBACK_WINDOW_S)); then
          log "$(short "$cur") crashed (exit $code) $((now - swapped))s after it was switched in; rolling back to $(short "$prev")" error
          echo "$cur" >>"$ROOT/bad"
          put current "$prev"
          rm -f "$ROOT/swapped_at"
          crashes=0
        else
          if ((now - started < 60)); then crashes=$((crashes + 1)); else crashes=1; fi
          local delay=$((5 * (1 << (crashes < 6 ? crashes - 1 : 5))))
          log "$(short "$cur") crashed (exit $code); restarting in ${delay}s" error
          sleep "$delay" &
          wait $!
          ((stopping)) && exit 0
        fi
        ;;
    esac
  done
}

main "$@"
exit $?
