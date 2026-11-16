# Installing chill on the LG TV

chill's TV app is a tiny **hosted-app shell**: it opens `http://<server>/tv`, so
the real interface updates whenever the server does. The shell itself almost
never needs reinstalling.

## One-time setup

1. **LG developer account**: sign up at webostv.developer.lge.com.
2. **Developer Mode on the TV**: install *Developer Mode* from the LG Content
   Store, sign in, turn on *Dev Mode Status* and *Key Server*, and let the TV
   restart. Note the IP address it shows.
3. **Register the TV** from any computer on the same network:
   ```sh
   npx -p @webos-tools/cli@3 ares-setup-device   # add: name "tv", the TV's IP, port 9922, user prisoner
   npx -p @webos-tools/cli@3 ares-novacom --device tv --getkey   # enter the passphrase shown on the TV
   ```
   The passphrase is case-sensitive; type it in upper case exactly as shown. If
   `ares-*` later says *Malformed OpenSSH private key. Bad passphrase?*, fix it
   with `ares-setup-device -m tv -i "{'passphrase':'<AS SHOWN>'}"`.

## Build and install

```sh
CHILL_URL=http://192.168.1.20:7878 npm run webos:package     # your server's LAN address
npx -p @webos-tools/cli@3 ares-install -d tv webos/dist/com.kelaban.chill_1.0.0_all.ipk
npx -p @webos-tools/cli@3 ares-launch -d tv com.kelaban.chill
```

The chill tile then sits on the home screen like any app. Remote: arrows + OK to
navigate, **Back** to go back. In the player, ←/→ skip 10 s, ⏩/⏪ skip 60 s.

Debugging: `npx -p @webos-tools/cli@3 ares-inspect -d tv --app com.kelaban.chill`
opens Chrome DevTools for the app running on the TV.

## Keeping Developer Mode alive

Developer Mode sessions last 1000 h (~41 days) and take sideloaded apps with
them when they expire. `webos/renew-devmode.sh <tv-ip>` resets the clock to
999:59:59 using only `ssh` and `curl` (verified on the G3, DECISIONS D21). On
farnsworth:

```sh
# once, from the laptop: give farnsworth a passphrase-less copy of the TV key
cp ~/.ssh/tv_webos /tmp/k && ssh-keygen -p -N "" -f /tmp/k   # asks for the TV passphrase
scp /tmp/k keith@farnsworth:.ssh/tv_webos && rm /tmp/k
# the script itself comes from the checkout, which the cron job keeps pulled

# farnsworth crontab (hourly; renews at most once a day, silent while the TV is off).
# The pull keeps ~/apps/chill/src on main: self-update builds elsewhere and never touches it.
17 * * * * cd $HOME/apps/chill/src && git pull -q --ff-only; webos/renew-devmode.sh 192.168.1.193 >> $HOME/apps/chill/devmode.log 2>&1
```

`~/apps/chill/devmode.log` gets one line per renewal. If it's had none for a
couple of weeks while the TV has been in use, check it. If renewal ever fails,
chill still works:

- **Google Cast**: the G3 has it built in; open chill on a phone and cast.
- **The TV's browser**: open `http://<server>:7878/tv`.
- **Plex/Jellyfin**: they can read chill's library folder (see `docker/compose.yml`).
