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

Developer Mode sessions expire (community reports say ~1000 h) and take
sideloaded apps with them. `webos/renew-devmode.sh tv` renews the session; run
it daily from cron on the home server. **Unverified on the G3 yet** (DECISIONS
D21). If renewal ever fails, chill still works:

- **Google Cast**: the G3 has it built in; open chill on a phone and cast.
- **The TV's browser**: open `http://<server>:7878/tv`.
- **Plex/Jellyfin**: they can read chill's library folder (see `docker/compose.yml`).
