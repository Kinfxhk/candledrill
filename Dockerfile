# SPDX-License-Identifier: AGPL-3.0-or-later
# CandleDrill container image. Local, single-user, no auth: publish the port on the
# host loopback ONLY, e.g.  docker run -p 127.0.0.1:4870:4870 -v candledrill:/data candledrill
# (or use compose.yaml, which already does this). Never use a bare `-p 4870:4870`.
FROM node:22-bookworm-slim

WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build && mkdir -p /data && chown node:node /data

# Inside the container the server must listen on the container interface so the port can
# be forwarded; this is only permitted with CANDLEDRILL_CONTAINER=1. The Host-header
# loopback check still applies, so the UI only answers to 127.0.0.1 / localhost.
ENV CANDLEDRILL_CONTAINER=1 \
    CANDLEDRILL_HOST=0.0.0.0 \
    CANDLEDRILL_PORT=4870 \
    CANDLEDRILL_DATA_DIR=/data

USER node
VOLUME ["/data"]
EXPOSE 4870
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:4870/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "packages/server/src/main.ts"]
