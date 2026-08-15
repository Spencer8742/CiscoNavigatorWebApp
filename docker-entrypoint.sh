#!/bin/sh
set -eu

# ─────────────────────────────────────────────────────────────────────────────
#  Container entrypoint.
#
#  Two jobs, both of which exist because of how Unraid mounts appdata:
#
#  1. **Seed a default config.** The image ships an example dashboard, but
#     mounting a host directory over /config hides anything baked in at that
#     path. On a fresh Unraid install the appdata folder is empty, so without
#     this the user gets a running-but-blank panel and no file to edit. We copy
#     the example in only when nothing is there — an existing config is never
#     touched.
#
#  2. **Run as the right user.** Unraid creates missing appdata directories as
#     root, and its convention is nobody:users (99:100) via PUID/PGID. We start
#     as root purely to fix ownership, then drop privileges before exec'ing
#     node — the application itself never runs as root.
#
#  Defaults to 1000:1000 (the `node` user) so behaviour under plain
#  docker-compose is unchanged; the Unraid template sets 99:100.
# ─────────────────────────────────────────────────────────────────────────────

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
CONFIG_PATH="${CONFIG_PATH:-/config/dashboard.yaml}"
CONFIG_DIR="$(dirname "$CONFIG_PATH")"
EXAMPLE="/app/dashboard.example.yaml"

log() { echo "entrypoint: $*"; }

# ── 1. Seed ──────────────────────────────────────────────────────────────────
if [ ! -f "$CONFIG_PATH" ]; then
  if [ -f "$EXAMPLE" ]; then
    if mkdir -p "$CONFIG_DIR" 2>/dev/null && cp "$EXAMPLE" "$CONFIG_PATH" 2>/dev/null; then
      log "no config found — seeded a default at $CONFIG_PATH"
      log "edit it to add your Home Assistant entities; it hot-reloads on save"
    else
      # Non-fatal by design: the backend starts fine without a config and the
      # panel still shows the clock and a message explaining what to do. A
      # permission problem must not leave a wall-mounted panel dark.
      log "WARNING: could not write $CONFIG_PATH (permissions?)"
      log "WARNING: starting with built-in defaults — the dashboard will be empty"
    fi
  fi
else
  log "using existing config at $CONFIG_PATH"
fi

# ── 2. Drop privileges ───────────────────────────────────────────────────────
if [ "$(id -u)" = "0" ]; then
  if [ "$CONFIG_DIR" != "/" ]; then
    # Best-effort. On a fuse-backed Unraid share this can fail harmlessly when
    # ownership is already correct.
    chown -R "$PUID:$PGID" "$CONFIG_DIR" 2>/dev/null || true
  fi
  log "starting as ${PUID}:${PGID}"
  exec su-exec "$PUID:$PGID" "$@"
fi

# Already unprivileged (e.g. `docker run --user`), so just run.
log "starting as $(id -u):$(id -g)"
exec "$@"
