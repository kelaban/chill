#!/usr/bin/env bash
# Keep the TV's Developer Mode session alive so the sideloaded chill app isn't
# removed. Run from cron on the home server, e.g. daily:
#   17 4 * * *  /opt/chill/webos/renew-devmode.sh my-tv
# Requires the TV registered with `ares-setup-device` under the given name.
# UNVERIFIED on the G3 (Phase 0, S1 step 6): this is the community-documented
# approach (webosbrew); confirm before relying on it.
set -euo pipefail
DEVICE="${1:-tv}"
ARES="npx --yes -p @webos-tools/cli@3"
TOKEN="$($ARES ares-novacom -d "$DEVICE" --run "cat /var/luna/preferences/devmode_enabled" | tr -d '[:space:]')"
if [ -z "$TOKEN" ]; then echo "could not read the dev-mode session token" >&2; exit 1; fi
curl -fsS "https://developer.lge.com/secure/ResetDevModeSession.dev?sessionToken=${TOKEN}" >/dev/null
echo "developer mode session renewed for $DEVICE"
