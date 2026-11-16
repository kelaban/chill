#!/usr/bin/env bash
# Keep the TV's Developer Mode session alive so the sideloaded chill app isn't
# removed. Sessions last 1000 h; this resets the clock to 999:59:59.
# Verified on the G3 (webOS 11.2) 2026-11-15 — DECISIONS D21.
#
# Needs only ssh + curl (no Node), so it runs on the home server from cron:
#   17 * * * *  ~/apps/chill/src/webos/renew-devmode.sh 192.168.1.193 ~/.ssh/tv_webos >> ~/apps/chill/devmode.log 2>&1
#
# The key is the one `ares-novacom --device tv --getkey` downloads, with its
# passphrase removed (`ssh-keygen -p -N "" -f <key>`) so cron can use it. It only
# opens the TV's jailed developer shell, on the LAN.
set -euo pipefail
HOST="${1:?usage: renew-devmode.sh <tv-ip> [ssh-key]}"
KEY="${2:-$HOME/.ssh/tv_webos}"
API="https://developer.lge.com/secure"
# Cron runs this hourly because the TV is usually off (SSH closed) at any given
# hour. Renew at most once a day, and skip silently while the TV is off.
STAMP="${CHILL_DEVMODE_STAMP:-$HOME/.cache/chill-devmode-renewed}"
if [ -n "$(find "$STAMP" -mmin -1200 2>/dev/null)" ]; then exit 0; fi
if ! (exec 3<>"/dev/tcp/$HOST/9922") 2>/dev/null; then exit 0; fi

# webOS's dropbear only offers ssh-rsa, which modern OpenSSH disables by default.
TOKEN="$(ssh -i "$KEY" -p 9922 -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=accept-new -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedAlgorithms=+ssh-rsa \
  "prisoner@$HOST" 'cat /var/luna/preferences/devmode_enabled' 2>/dev/null | tr -d '[:space:]')" || true
if [ -z "$TOKEN" ]; then echo "$(date +%FT%T%z) could not read the dev-mode token from $HOST (TV off?)" >&2; exit 1; fi

# Responses look like {"result":"success","errorCode":"200","errorMsg":"999:36:05"}.
left() { curl -fsS --max-time 20 "$API/CheckDevModeSession.dev?sessionToken=$TOKEN" | sed -E 's/.*"errorMsg":"([^"]*)".*/\1/'; }
BEFORE="$(left)"
RESET="$(curl -fsS --max-time 20 "$API/ResetDevModeSession.dev?sessionToken=$TOKEN")"
case "$RESET" in *'"result":"success"'*) ;; *) echo "$(date +%FT%T%z) renewal failed: $RESET" >&2; exit 1 ;; esac
mkdir -p "$(dirname "$STAMP")" && touch "$STAMP"
echo "$(date +%FT%T%z) developer mode renewed on $HOST: $BEFORE -> $(left) left"
