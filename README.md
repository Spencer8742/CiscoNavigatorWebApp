# Cisco Navigator Panel

A smart home, media and photo dashboard built specifically for the **Cisco Room
Navigator** running RoomOS, in Persistent Web App mode.

It is designed as an appliance, not as a website that happens to be shown on a
touchscreen: a left navigation rail, direct-manipulation controls, real-time
state over a single WebSocket, and a photo screensaver that takes over when the
room goes quiet.

```
Home  ·  Rooms  ·  Controls  ·  Media  ·  Photos  ·  Settings
```

---

## Why it is built this way

Every significant decision comes from a **verified** RoomOS constraint, not
from an assumption about "some Chromium". The device is not a desktop browser:

| Constraint | Consequence |
|---|---|
| Chromium **102** floor (Qt WebEngine) | No `:has()`, container queries, `color-mix()`, `oklch()`, CSS nesting, View Transitions |
| Memory-capped — **the web view is terminated** on overrun | Every cache is bounded and evicted; originals are never fetched |
| Cisco: *"avoid drop shadows"*, *"resize images on the server"* | Zero `box-shadow`; the backend picks the image size |
| Only `transform`/`opacity` are hardware accelerated | Nothing else is ever animated |
| **Web storage wiped daily** by default | No state lives only on the panel; the auth token is recoverable from the provisioned URL |
| Single tab; `window.open` replaces the page | No external links, no popups, no OAuth redirects |
| Kiosk mode — **the user cannot exit or reload** | Global error boundary with self-recovery; no failure path can blank the screen |
| Soft keyboard has no numeric/date/colour modes | Essentially no text input; config lives in a YAML file on the server |
| Emoji are monochrome and partial | Zero emoji; all icons are inline SVG |

Full detail, with citations: **[`docs/ROOMOS.md`](docs/ROOMOS.md)**.

## Architecture in one picture

```
Room Navigator ──── one origin, HTTPS ────▶ navigator-panel (Node)
  Preact + signals                            │  holds ALL credentials
  ~17 KB gz                                   ├──▶ Home Assistant  (WebSocket)
  no credentials                              ├──▶ Sonos           (SOAP + events)
                                              ├──▶ Immich          (REST)
                                              ├──▶ Bitfocus Companion
                                              └──▶ Elgato Key Lights
```

Everything reaches its upstream **through the backend**, and on a RoomOS
device that is not a preference. The page is served over HTTPS, so it may not
fetch `http://192.168.1.x` at all — mixed content is blocked before CORS is
even consulted, and an Elgato Key Light sends no CORS headers either way.
One origin makes both problems disappear and keeps every address in a config file
rather than in the page.

The panel is a renderer. The backend is the system of record: it holds the
tokens, keeps one warm WebSocket to Home Assistant, absorbs upstream outages,
and sends a **complete snapshot in the first frame** after every reconnect — so
recovering from RoomOS's nightly storage wipe is invisible.

Full rationale, including why Preact over React/Svelte/vanilla and why the
backend is not optional: **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**.

## Quick start

### Unraid

Install the template from Unraid's *Terminal* (the Template field on Add
Container is a dropdown of installed templates — there is no URL box):

```bash
mkdir -p /boot/config/plugins/dockerMan/templates-user
wget -O /boot/config/plugins/dockerMan/templates-user/my-navigator-panel.xml \
  https://raw.githubusercontent.com/Spencer8742/CiscoNavigatorWebApp/main/unraid/navigator-panel.xml
```

Then *Docker* → **Add Container** → pick **navigator-panel** from the Template
dropdown. Fill in your panel token and Home Assistant URL + token, hit Apply.
A documented `dashboard.yaml` is written to
`/mnt/user/appdata/navigator-panel/` on first start — edit it to list your
entities and the panel updates within a second, no restart.

No terminal? [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md#1a-unraid) lists the
fields to enter by hand.

Pushes to `main` publish a new image automatically, so updating is **Force
Update** in the Docker tab (or the *Auto Update Applications* plugin).

### Anywhere else

```bash
cp .env.example .env                    # add tokens
docker compose -f docker-compose.prebuilt.yml up -d
```

Then provision the Navigator with `https://your-host/?t=<PANEL_TOKEN>` in
Persistent Web App mode. Step by step, including TLS and on-device DevTools:
**[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)**.

### Development

```bash
npm install
npm run dev     # panel :5173, backend :8099
npm test        # integration tests against a mock Home Assistant
```

The test suite runs a real backend process against a mock Home Assistant that
speaks the actual protocol — compressed `a`/`c`/`r` diffs, `+`/`-` nesting,
float-second timestamps, coalesced multi-message frames — so the parts that
are easy to get quietly wrong are checked rather than assumed.

Vite proxies `/api`, `/img` and `/ws` to the backend, so the panel is
same-origin in development exactly as it is on the device — CORS cannot work
in dev and then break in production.

## Configuration

One file, `config/dashboard.yaml`, hot-reloaded on save. No entity ID appears
anywhere in the UI code.

```yaml
rooms:
  - id: living_room
    name: Living Room
    icon: sofa
    entities:
      # Bare id: uses Home Assistant's friendly_name
      - light.living_room_ceiling
      # Or override the name, for when HA's is too long for a tile
      - entity: light.living_room_lamps_dimmer_switch_2
        name: Lamps
      - climate.living_room

home:
  favorites:
    - entity: light.kitchen_ceiling
      name: Kitchen
    - lock.front_door
  scenes: [scene.movie_night, scene.all_off]
```

Every entity list takes either form, mixed freely. Override the name when
Home Assistant's is written for a list rather than a 13rem tile — "Living
Room Ceiling Light Bulb 3" is accurate and unreadable.

It is also a **security allow-list**: the backend refuses any service call
targeting an entity this file does not name, so a tampered panel cannot reach
a door that was never on the dashboard.

The same file holds the **Controls** pages — see below — under `controls:`.

See [`config/dashboard.example.yaml`](config/dashboard.example.yaml) for the
fully documented reference.

## Controls: the macro pages

The Room Bar this was built alongside used to run a RoomOS macro,
`companion_bridge.js`, that mapped Navigator UI Extension widget taps onto HTTP
calls — Bitfocus Companion, Home Assistant webhooks, Elgato Key Lights. The
macro, the panel XML and the `HttpClient` configuration all lived **on the
device**, and a factory reset destroyed every one of them with no single
artefact to put back.

The Controls screen is that macro, inverted. The device holds one URL; the
buttons live in `config/dashboard.yaml`:

```yaml
controls:
  keylights:
    - { id: key_left,  name: Key Left,  host: 192.168.1.201 }
    - { id: key_right, name: Key Right, host: 192.168.1.148 }

  appleTvs:
    - id: living_room_apple_tv
      name: Living Room Apple TV
      host: 192.168.1.80
      shortcuts:
        - { name: Plex, app: com.plexapp.plex }
        - { name: YouTube, app: com.google.ios.youtube }

  pages:
    - id: deskpro
      name: Desk Pro
      icon: phone
      items:
        - { name: Join,     icon: phone,     tone: accent, wide: true, companion: 1/0/0 }
        - { name: Hang Up,  icon: phoneDown, tone: danger, companion: 1/0/1 }
        - { name: Listen,   icon: mic,       webhook: office_voice_listen }
        - { name: Meeting,  entity: scene.office_meeting }
        - { light: all, name: Key Lights }   # power + brightness + temperature
```

A button reaches Companion (`POST /api/location/<page>/<row>/<column>/press`),
a Home Assistant webhook, an ordinary service call, or an Elgato Key Light. A
bare `light:` item is not a button at all — it is the full light control, with
live state.

Configured Apple TVs appear on their own page with pairing, power, directional
navigation, Home/Back, playback, skipping, volume, live media metadata and
allow-listed app shortcuts. Each shortcut names an installed app's bundle id;
the backend verifies both the configuration and the Apple TV's installed app
list before launching it. Pairing credentials are stored in
`/config/apple-tv.json` and never sent to the panel.

Two properties are worth stating explicitly:

- **The panel names a button, never a request.** It sends `deskpro.hangup`;
  the backend resolves that against this file. A screen on a wall that anyone
  in the room can touch is trusted to drive the dashboard, not to compose HTTP
  requests to your LAN — the same reasoning as the entity allow-list above,
  and `entity:` buttons go through that guard unchanged.
- **A macro button does not pretend to have state.** Companion sends no
  feedback here and Home Assistant answers `200` for a webhook that does not
  exist, so a tap confirms that the request went and nothing more. Key lights
  are the exception, and the only thing on the screen drawn as a control
  rather than a key.

What this screen **cannot** do is read the Room Bar itself. RoomOS does inject
a bound `xapi` object in Persistent Web App mode, but its supported surface is
small — bookings, LED control, room analytics, system identity — and call
state, mic mute and driving a paired codec are not in it
([`docs/ROOMOS.md`](docs/ROOMOS.md) §8). Those need a device-side macro or an
authenticated jsxapi socket, which is precisely the thing this replaced. Start
without them; add one only if a specific button demands it.

### Recovering from a factory reset

```bash
scripts/provision-roombar.sh --host 192.168.1.243 \
  --url 'https://panel.example.com/?t=<PANEL_TOKEN>'
```

Idempotent, so it also answers "is this device configured the way the repo
says?". It sets the web engine on, turns off RoomOS's nightly storage wipe,
sets the standby delay and points the device at the panel. Everything else is
already in this repository. `--dry-run` prints the XML without sending it.

## Status

| Phase | | |
|---|---|---|
| 0 | Constraints research and architecture | ✅ |
| 1 | Shell: build system, backend, design system, navigation, diagnostics | ✅ |
| 2 | Home Assistant connectivity | ✅ |
| 3 | Real-time entity state | ✅ |
| 4 | Entity controls (light, climate, cover, …) | ✅ |
| 5 | Media player / Now Playing | ✅ |
| 6 | Immich gallery | ✅ |
| 7 | Photo slideshow | ✅ |
| 8 | Idle and screensaver | ✅ |
| 9 | Controls: Companion, webhooks and key lights — replaces the RoomOS macro | ✅ |
| 10 | Failure hardening | ⬜ |
| 11 | Performance pass on-device | ⬜ |
| 12 | Deployment polish | 🟡 CI, GHCR images, Unraid template and the device provisioning script done |
| 13 | Sonos direct — replaced Music Assistant | ✅ [`docs/SONOS.md`](docs/SONOS.md) |

Each phase is verified working before the next begins.

## Performance budget

Enforced, not aspirational.

| Metric | Budget | Now |
|---|---|---|
| Shell JS (gzip) | < 50 KB | **37.8 KB** |
| CSS (gzip) | < 12 KB | **7.5 KB** |
| HA state change → DOM update | — | **5–34 ms** |
| Cold load → interactive | < 1.5 s | — |
| Touch → visual feedback | < 100 ms | one frame |
| Steady-state heap | < 60 MB, flat over 24 h | — |
| Requests after first paint | 0 until the user acts | 0 |

## Project layout

```
.github/    CI (typecheck, tests, bundle budget) + GHCR image publish
docs/       ROOMOS.md · ARCHITECTURE.md · DEPLOYMENT.md · SONOS.md
unraid/     Unraid container template
config/     dashboard.yaml — rooms, favourites, scenes, albums, control pages
scripts/    provision-roombar.sh — reapply the device side after a reset
shared/     types and helpers used verbatim by both ends
panel/      frontend (Preact + signals, Vite, target chrome102)
  domains/    ← add a Home Assistant domain here, nowhere else
              registry.tsx = how it looks · controls.tsx = how it works
server/     backend  (Node 22, deps: ws + yaml)
  ha/         WebSocket client · state store · service allow-list
  sonos/      Sonos, direct on the LAN · topology, events, control, browsing
  immich/     REST client · playlist · image proxy (originals unreachable)
  cast/       Cast v2 — keeps Google Nest Hubs showing the dashboard
  controls/   Companion presses · Elgato Key Lights · HA webhooks
  test/       integration tests + mock Home Assistant and Immich
```

## Licence

MIT
