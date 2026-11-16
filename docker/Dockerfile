# chill: one image, served from the home server.
#   docker compose -f docker/compose.yml up -d

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY shared shared
COPY server server
COPY web web
RUN npm run build -w web && npm run build -w server \
 && npm prune --omit=dev

FROM node:22-bookworm-slim
# ffmpeg: probe, alignment, cut detection (and demo sample films); fonts for demo overlays.
# git: self-update mode (docker/supervise.sh, CHILL_AUTO_UPDATE=1) builds new commits in place.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates tini git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data LIBRARY_DIR=/data/library PORT=7878 NODE_NO_WARNINGS=1
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/migrations server/migrations
COPY --from=build /app/server/public server/public
COPY docker/supervise.sh /app/supervise.sh
VOLUME ["/data"]
EXPOSE 7878
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:7878/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/supervise.sh"]
