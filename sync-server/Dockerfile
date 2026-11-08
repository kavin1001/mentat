# Build from the repository root:  docker build -f sync-server/Dockerfile -t mentat-sync .
FROM node:22-alpine AS build
WORKDIR /app
COPY packages/sync-core packages/sync-core
COPY sync-server sync-server
RUN cd sync-server && npm ci --no-audit --no-fund && npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/sync-server/dist/server.js ./server.js
ENV MENTAT_SYNC_DB=/data/mentat-sync.db PORT=8787
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
