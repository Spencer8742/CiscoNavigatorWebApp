#!/bin/sh
#
# provision-roombar.sh — put a factory-reset RoomOS device back to work.
#
# This is the reset-recovery artefact. A Room Bar or Room Navigator holds
# almost nothing about this dashboard — one URL and a handful of
# xConfiguration values — and that is the entire point: macros, UI Extension
# panel XML and HttpClient configs all live on the device and are destroyed by
# a factory reset, with no single file to put back. Everything that used to be
# on the device is now in this repository, and this script is what reapplies
# the small remainder.
#
# Usage:
#
#   scripts/provision-roombar.sh --host 192.168.1.243 \
#       --url https://panel.example.com/?t=YOUR_PANEL_TOKEN \
#       --panel office
#
#   DEVICE_HOST=192.168.1.243 DEVICE_USER=admin DEVICE_PASSWORD=... \
#   PANEL_URL='https://panel.example.com/?t=...' scripts/provision-roombar.sh
#
# Flags:
#   --host HOST        device address                 (env DEVICE_HOST)
#   --user USER        device API user                (env DEVICE_USER, default admin)
#   --password PASS    device API password            (env DEVICE_PASSWORD)
#   --url URL          the panel URL, token included  (env PANEL_URL)
#   --panel ID         this panel's name, so it keeps its own settings
#                      (env PANEL_ID; letters, digits, - and _)
#   --target NAME      Controller | OSD | PersistentWebApp  (env WEBVIEW_TARGET)
#   --standby-delay N  minutes before the display sleeps, 0 to leave alone
#   --insecure         accept the device's self-signed certificate
#   --dry-run          print what would be sent and send nothing
#
# Idempotent: every step is a set-to-this-value, so running it twice changes
# nothing the second time. Safe to run against a device that is already
# working — which is what makes it usable as a "is this device configured the
# way the repo says?" check rather than only as a recovery tool.
#
# Prompting for the password is deliberate: passing it as a flag puts it in
# your shell history and in the process list of a shared machine.

set -eu

DEVICE_HOST="${DEVICE_HOST:-}"
DEVICE_USER="${DEVICE_USER:-admin}"
DEVICE_PASSWORD="${DEVICE_PASSWORD:-}"
PANEL_URL="${PANEL_URL:-}"
PANEL_ID="${PANEL_ID:-}"
WEBVIEW_TARGET="${WEBVIEW_TARGET:-Controller}"
STANDBY_DELAY="${STANDBY_DELAY:-120}"
INSECURE=""
DRY_RUN=""

die() {
  echo "provision-roombar: $*" >&2
  exit 1
}

usage() {
  sed -n '2,38p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --host) DEVICE_HOST="${2:-}"; shift 2 ;;
    --user) DEVICE_USER="${2:-}"; shift 2 ;;
    --password) DEVICE_PASSWORD="${2:-}"; shift 2 ;;
    --url) PANEL_URL="${2:-}"; shift 2 ;;
    --panel) PANEL_ID="${2:-}"; shift 2 ;;
    --target) WEBVIEW_TARGET="${2:-}"; shift 2 ;;
    --standby-delay) STANDBY_DELAY="${2:-}"; shift 2 ;;
    --insecure) INSECURE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "provision-roombar: unknown option $1" >&2; usage 1 ;;
  esac
done

command -v curl >/dev/null 2>&1 || die "curl is required"

[ -n "$DEVICE_HOST" ] || die "no device address. Pass --host or set DEVICE_HOST."
[ -n "$PANEL_URL" ] || die "no panel URL. Pass --url or set PANEL_URL."

case "$PANEL_URL" in
  https://*) ;;
  http://*)
    # Not fatal — a bench device on a trusted LAN is a real case — but it is
    # worth being loud about, because it cannot be upgraded later without
    # re-provisioning, and because the panel's own token travels over it.
    echo "provision-roombar: WARNING — $PANEL_URL is not HTTPS." >&2
    echo "  The panel token travels in clear text, and switching to HTTPS later" >&2
    echo "  means provisioning the device again." >&2
    ;;
  *) die "--url must start with http:// or https://" ;;
esac

# Append the panel's own id, so this device keeps its own settings rather than
# sharing one set with every other panel. Appended rather than required in
# --url because the URL is usually copied verbatim between devices and the id
# is the one part that must differ.
if [ -n "$PANEL_ID" ]; then
  case "$PANEL_ID" in
    *[!A-Za-z0-9_-]*) die "--panel may contain only letters, digits, - and _" ;;
  esac
  case "$PANEL_URL" in
    *'?panel='*|*'&panel='*)
      die "--panel given, but --url already names a panel. Use one or the other." ;;
    *'?'*) PANEL_URL="$PANEL_URL&panel=$PANEL_ID" ;;
    *)     PANEL_URL="$PANEL_URL?panel=$PANEL_ID" ;;
  esac
fi

case "$PANEL_URL" in
  *'?t='*|*'&t='*) ;;
  *)
    echo "provision-roombar: WARNING — no ?t=<PANEL_TOKEN> in the URL." >&2
    echo "  RoomOS wipes web storage nightly, so the URL is the only thing the" >&2
    echo "  panel can recover its token from. Unless PANEL_TOKEN is empty, the" >&2
    echo "  panel will show its connection-help screen every morning." >&2
    ;;
esac

if [ -z "$DEVICE_PASSWORD" ] && [ -z "$DRY_RUN" ]; then
  # Read without echo where the shell can, so the password does not end up on
  # screen or in scrollback.
  printf 'Password for %s@%s: ' "$DEVICE_USER" "$DEVICE_HOST" >&2
  stty -echo 2>/dev/null || true
  read -r DEVICE_PASSWORD
  stty echo 2>/dev/null || true
  printf '\n' >&2
fi

SCHEME="https"
CURL_OPTS="--silent --show-error --max-time 20"
[ -n "$INSECURE" ] && CURL_OPTS="$CURL_OPTS --insecure"

# XML-escape, because a panel URL legitimately contains & and ? and a token
# can contain anything. Only the five predefined entities matter here.
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

# One /putxml POST. The device answers with XML naming each element it
# applied, so a rejected setting is visible rather than silent.
put() {
  description="$1"
  body="$2"

  if [ -n "$DRY_RUN" ]; then
    printf '%s\n  %s\n' "$description" "$body"
    return 0
  fi

  # shellcheck disable=SC2086 # CURL_OPTS is a deliberate word list
  response=$(curl $CURL_OPTS \
    --user "$DEVICE_USER:$DEVICE_PASSWORD" \
    --header 'Content-Type: text/xml' \
    --data "$body" \
    --write-out '\n%{http_code}' \
    "$SCHEME://$DEVICE_HOST/putxml" 2>&1) || {
      echo "  FAILED  $description" >&2
      echo "$response" | sed 's/^/          /' >&2
      return 1
    }

  code=$(printf '%s' "$response" | tail -n 1)
  payload=$(printf '%s' "$response" | sed '$d')

  case "$code" in
    200)
      # RoomOS returns 200 with status="Error" in the body for a path that
      # does not exist on this software version — which is the single most
      # likely failure here, because several of these moved between RoomOS
      # 11.x and 26.x. Checking only the HTTP code would report success.
      case "$payload" in
        *'status="Error"'*|*'status="ParameterError"'*)
          echo "  REJECTED  $description" >&2
          printf '%s\n' "$payload" | sed 's/^/            /' >&2
          return 1
          ;;
        *) echo "  ok        $description" ;;
      esac
      ;;
    401)
      die "authentication failed for $DEVICE_USER@$DEVICE_HOST"
      ;;
    *)
      echo "  FAILED    $description (HTTP $code)" >&2
      printf '%s\n' "$payload" | sed 's/^/            /' >&2
      return 1
      ;;
  esac
}

echo "Provisioning $DEVICE_HOST as $DEVICE_USER"
[ -n "$DRY_RUN" ] && echo "(dry run — nothing is sent)"

failures=0

# ── The web engine ────────────────────────────────────────────────────────
# Without this the device cannot show a web page at all, and the failure looks
# like the URL being wrong.
put 'WebEngine Mode: On' \
  '<Configuration><WebEngine><Mode>On</Mode></WebEngine></Configuration>' || failures=$((failures + 1))

# ── The nightly storage wipe ──────────────────────────────────────────────
# RoomOS clears web storage every night by default. The panel survives it —
# the token is recoverable from the URL and the backend sends a complete
# snapshot on connect — but it re-downloads its whole bundle every morning for
# no reason. Cisco recommends Off for personal devices.
put 'RoomCleanup AutoRun ContentType WebData: Off' \
  '<Configuration><RoomCleanup><AutoRun><ContentType><WebData>Off</WebData></ContentType></AutoRun></RoomCleanup></Configuration>' \
  || failures=$((failures + 1))

# ── Standby ───────────────────────────────────────────────────────────────
# Must be LONGER than idle.timeoutSeconds in dashboard.yaml, or the display
# sleeps before the photo screensaver is ever seen. 0 leaves the device's own
# setting alone.
if [ "$STANDBY_DELAY" != "0" ]; then
  put "Standby Delay: $STANDBY_DELAY minutes" \
    "<Configuration><Standby><Delay>$STANDBY_DELAY</Delay></Standby></Configuration>" \
    || failures=$((failures + 1))
fi

# ── The URL ───────────────────────────────────────────────────────────────
# The only device-side thing that is genuinely about THIS deployment. Sent
# last so a failure above is visible before the screen changes.
escaped_url=$(xml_escape "$PANEL_URL")
put "WebView Display: $WEBVIEW_TARGET" \
  "<Command><UserInterface><WebView><Display><Url>$escaped_url</Url><Mode>Fullscreen</Mode><Target>$WEBVIEW_TARGET</Target></Display></WebView></UserInterface></Command>" \
  || failures=$((failures + 1))

echo
if [ "$failures" -gt 0 ]; then
  cat >&2 <<'NOTE'
Some settings were not applied.

The usual cause is a configuration path that moved between RoomOS versions —
several of these differ between 11.x and 26.x. Check the exact path for the
software this device is running before assuming the device is at fault:

    xConfiguration WebEngine
    xConfiguration RoomCleanup

A device registered to Control Hub may also have some settings locked by a
Control Hub configuration template, which overrides anything sent here.
NOTE
  exit 1
fi

cat <<NOTE
Done.

The device should now be showing the panel. If it is not:

  - Persistent Web App mode is chosen during ONBOARDING and cannot be set
    from here. A device onboarded as a touch controller has to be factory
    reset to change it. Until then, the WebView command above still puts the
    page on screen; it is just dismissible.

  - A self-signed certificate fails SILENTLY in the RoomOS web engine — a
    blank screen, no error. Use a real certificate; that failure has cost an
    evening before.

  - Everything else lives in config/dashboard.yaml on the server and is
    hot-reloaded. There is nothing more to install on the device.
NOTE
