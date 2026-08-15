# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
#  Cisco Navigator Panel
#
#  Multi-stage: build the panel and the server with dev dependencies present,
#  then copy only the artefacts and the two runtime dependencies (`ws`,
#  `yaml`) into a slim image. Final image is ~150 MB, most of which is the
#  Node runtime itself.
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=22-alpine

# ── Stage 1: dependencies ────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps

WORKDIR /app

# Copy only manifests first so this layer is cached until a dependency
# actually changes — the difference between a 5 second rebuild and a 90
# second one on every source edit.
COPY package.json package-lock.json* ./
COPY panel/package.json ./panel/
COPY server/package.json ./server/

# `npm ci` when a lockfile exists (reproducible), `npm install` when it does
# not (first run in a fresh checkout).
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi


# ── Stage 2: build ───────────────────────────────────────────────────────────
FROM deps AS build

ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

WORKDIR /app

COPY shared/ ./shared/
COPY panel/ ./panel/
COPY server/ ./server/

RUN npm run build --workspace panel \
 && npm run build --workspace server


# ── Stage 3: runtime dependencies only ───────────────────────────────────────
FROM node:${NODE_VERSION} AS prod-deps

WORKDIR /app

COPY package.json package-lock.json* ./
COPY server/package.json ./server/

RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --workspace server; \
    else \
      npm install --omit=dev --workspace server; \
    fi \
 && npm cache clean --force


# ── Stage 4: runtime ─────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runtime

ARG APP_VERSION=dev

ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    PORT=8099 \
    HOST=0.0.0.0 \
    CONFIG_PATH=/config/dashboard.yaml

WORKDIR /app

# tini reaps zombies and forwards signals so SIGTERM reaches Node and the
# graceful shutdown path runs (panels then reconnect immediately on the new
# container instead of waiting out a heartbeat timeout).
# su-exec drops privileges in the entrypoint; wget backs the healthcheck.
RUN apk add --no-cache tini su-exec wget

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/panel/dist ./panel

# The server resolves the panel build relative to its own location:
#   new URL('../panel', import.meta.url)  →  /app/panel
# See server/src/index.ts.

# The example lives OUTSIDE /config on purpose. /config is a mount point, and
# anything baked in at that path is hidden the moment a host directory is
# mounted over it — which is exactly what Unraid does. The entrypoint copies
# this in on first run instead, so a fresh install gets a real, editable file.
COPY config/dashboard.example.yaml /app/dashboard.example.yaml

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Deliberately NOT `USER node`: the entrypoint needs root briefly to fix
# ownership of a freshly created appdata directory, then drops to PUID:PGID
# via su-exec. The Node process never runs as root — CI asserts this.
# Defaults match the `node` user so compose behaviour is unchanged.
ENV PUID=1000 \
    PGID=1000

EXPOSE 8099

VOLUME ["/config"]

# Hits the unauthenticated liveness endpoint — see server/src/index.ts for why
# that route deliberately requires no token.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:${PORT}/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--enable-source-maps", "dist/server.js"]
