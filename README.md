# Cisco Navigator Panel

A smart home, media and photo dashboard built specifically for the **Cisco Room
Navigator** running RoomOS, in Persistent Web App mode.

It is designed as an appliance, not as a website that happens to be shown on a
touchscreen: a left navigation rail, direct-manipulation controls, real-time
state over a single WebSocket, and a photo screensaver that takes over when the
room goes quiet.

```
Home  ·  Rooms  ·  Media  ·  Photos  ·  Settings
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
  no credentials                              └──▶ Immich          (REST)
```

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

See [`config/dashboard.example.yaml`](config/dashboard.example.yaml) for the
fully documented reference.

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
| 9 | Failure hardening | ⬜ |
| 10 | Performance pass on-device | ⬜ |
| 11 | Deployment polish | 🟡 CI, GHCR images and Unraid template done |

Each phase is verified working before the next begins.

## Performance budget

Enforced, not aspirational.

| Metric | Budget | Now |
|---|---|---|
| Shell JS (gzip) | < 50 KB | **27.9 KB** |
| CSS (gzip) | < 12 KB | **5.4 KB** |
| HA state change → DOM update | — | **5–34 ms** |
| Cold load → interactive | < 1.5 s | — |
| Touch → visual feedback | < 100 ms | one frame |
| Steady-state heap | < 60 MB, flat over 24 h | — |
| Requests after first paint | 0 until the user acts | 0 |

## Project layout

```
.github/    CI (typecheck, tests, bundle budget) + GHCR image publish
docs/       ROOMOS.md · ARCHITECTURE.md · DEPLOYMENT.md
unraid/     Unraid container template
config/     dashboard.yaml — rooms, favourites, scenes, albums
shared/     types and helpers used verbatim by both ends
panel/      frontend (Preact + signals, Vite, target chrome102)
  domains/    ← add a Home Assistant domain here, nowhere else
              registry.tsx = how it looks · controls.tsx = how it works
server/     backend  (Node 22, deps: ws + yaml)
  ha/         WebSocket client · state store · service allow-list
  immich/     REST client · playlist · image proxy (originals unreachable)
  test/       integration tests + mock Home Assistant and Immich
```

## Licence

MIT
