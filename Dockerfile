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

# wget is used by the healthcheck below; tini reaps zombies and forwards
# signals so SIGTERM reaches Node and the graceful shutdown path runs.
RUN apk add --no-cache tini wget

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/panel/dist ./panel

# The server resolves the panel build relative to its own location:
#   new URL('../panel', import.meta.url)  →  /app/panel
# See server/src/index.ts.

# Config is mounted read-only at /config. Shipping a default means the
# container starts and serves a working (empty) dashboard even with nothing
# mounted, rather than failing in a way that looks like a broken image.
COPY config/dashboard.example.yaml /config/dashboard.yaml

# Drop privileges. The node image already provides uid/gid 1000.
USER node

EXPOSE 8099

# Hits the unauthenticated liveness endpoint — see server/src/index.ts for why
# that route deliberately requires no token.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:${PORT}/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/server.js"]
