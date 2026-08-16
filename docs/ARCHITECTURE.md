# Architecture

Read [`ROOMOS.md`](./ROOMOS.md) first. Every choice below is downstream of the
verified device constraints in that document.

---

## 1. Recommended technical architecture

Three moving parts, one of which is a Cisco appliance you cannot change:

```
Room Navigator (Chromium 102, kiosk, 10.1")
        │  one origin, HTTPS
        │  ├── GET  /            static shell (~40 KB gz)
        │  ├── WS   /ws          live state, one socket
        │  └── GET  /img/…       pre-sized JPEGs, immutable
        ▼
navigator-panel (Node 22, ~25 MB container)
        │  holds all credentials, all state, all retry logic
        ├── WS  ──▶ Home Assistant   (the house: lights, locks, sensors)
        ├── WS  ──▶ Music Assistant  (the music: speakers, queue, library)
        └── HTTP ──▶ Immich          (API key never leaves this process)
```

The organising principle: **the panel is a renderer, the backend is the
system of record.** The panel holds no credentials, does no protocol
negotiation, and can be wiped and restarted at any moment (RoomOS does exactly
that, daily) without losing anything. Everything hard — authentication,
reconnection, backoff, state reconciliation, image resizing — happens in a
process running on hardware you control, with a real filesystem and no memory
ceiling imposed by a video codec.

This is the inversion of the usual "SPA talks directly to Home Assistant"
design, and it is justified specifically by §2 and §5 of `ROOMOS.md`: the
panel has a small, unpublished memory budget and is terminated when it exceeds
it, and its storage is erased on a daily schedule.

---

## 2. Frontend framework: **Preact + `@preact/signals`**

**~6 KB gzipped of runtime, total.**

### Why not the alternatives

| Option | Verdict |
|---|---|
| **React** | ~45 KB gz. VDOM reconciliation on every state change, on a CPU deprioritised behind a video pipeline. A 200-entity dashboard receiving 20 state updates/second would re-render trees constantly. Rejected — and it is worth being explicit that "we use React" was never a technical conclusion here. |
| **Vanilla TS** | Genuinely tempting; zero runtime. Rejected because this app runs for *weeks* unattended. Hand-rolled subscribe/unsubscribe across ~40 components is where listener leaks come from, and per `ROOMOS.md` §2 a leak on this device is a crash, not a slowdown. A 6 KB library that makes teardown automatic is cheap insurance. |
| **Svelte 5** | The closest call. Comparable output size, excellent fine-grained runes. Rejected on *escape hatches*: several things here are hot enough to want raw DOM (slideshow crossfade, drag sliders at 60 fps, direct style writes during a drag). In Preact those are a `ref` and normal DOM calls. In Svelte they mean fighting the compiler. Also: one compiler-shaped idiom for the whole codebase vs. plain TSX that any tool understands. |
| **Lit / Web Components** | Fine, but no ecosystem advantage here and a heavier authoring model for a single-app codebase. |
| **Solid** | Excellent perf, but a smaller ecosystem than Preact for what is otherwise a wash on this workload. |

### Why Preact + signals specifically

The workload is: **a few hundred independent values changing at unpredictable
times, each affecting one or two small pieces of the screen.** That is exactly
the shape signals are for.

```ts
// A light's brightness changes in Home Assistant.
// With signals, precisely one text node and one transform are updated.
// No component function is called. No VDOM tree is diffed.
const brightness = computed(() => entity('light.kitchen').value?.attributes.brightness ?? 0);
```

Each entity is its own signal. `subscribe_entities` delivers a diff, we write
it into the affected signals, and the DOM updates surgically. Rendering cost
scales with *what changed*, not with *how much is on screen* — which is the
only way a 10" panel keeps up with a busy house.

Preact also gives us: JSX/TSX with full type-checking, `preact/compat` as an
escape hatch if some future library needs React, hooks for lifecycle-scoped
cleanup (the leak protection above), and first-class Vite support.

**Constraint applied:** Vite `build.target = 'chrome102'`, and an ESLint rule
set that fails the build on the banned APIs listed in `ROOMOS.md` §1.

---

## 3. Backend/proxy: **yes — and it is not optional**

A small Node service, ~25 MB container, three runtime dependencies (`ws`,
`yaml`, and nothing else). It exists for six concrete reasons, in order of
weight:

**1. Credentials.** A Home Assistant long-lived access token in frontend code
is a permanent, unscoped, non-expiring key to the whole house, sitting in a
JS bundle on a device whose storage is wiped and re-fetched daily and which
anyone in the room can touch. An Immich API key is the same problem for your
entire photo library. Both stay in the backend's environment. The panel never
sees either. This alone settles the question.

**2. CORS stops existing.** The panel is served *from* the backend. Same
origin for HTML, WebSocket, API and images. Zero preflight requests, zero CORS
configuration in Home Assistant, zero `Access-Control-Allow-Origin` debugging
at 11pm. Contrast with the direct-connect design, which needs
`cors_allowed_origins` in HA's `http:` config *and* Immich CORS *and* a
matching TLS story for three different hosts.

**3. One HA connection, shared, and always warm.** The backend keeps a single
authenticated WebSocket to Home Assistant with the full entity state in
memory. When the panel reconnects — after a nightly storage wipe, a web-view
restart, or a Wi-Fi blip — it receives a complete state snapshot in one frame
and paints immediately. No auth handshake, no `get_states` round trip, no
"Connecting…" screen. Reconnect-to-painted is a single RTT on the LAN.

**4. Images are resized where there is CPU to do it.** `ROOMOS.md` §2 quotes
Cisco directly: *"Avoid using images that are larger than needed, resize them
on the server."* The backend requests the right Immich thumbnail size, sets
`Cache-Control: immutable`, and never lets an original reach the panel. A
mis-sized image here is not slow, it is an out-of-memory kill.

**5. Outages are absorbed.** Home Assistant restarting for an update is a
15-second event. The backend rides it out with exponential backoff while the
panel keeps showing last-known state with a subtle degraded indicator. The
user sees a dimmed connection dot, not an error screen.

**6. Response normalisation.** HA's `light` attributes vary by integration;
Immich's asset shape carries far more than we need. Normalising server-side
means less JSON on the wire and less parsing on the constrained CPU.

**What the backend deliberately does *not* do:** no database, no user
accounts, no business logic, no rendering, no image *processing* (it asks
Immich for the right size, it does not run Sharp). It is a credential vault, a
connection manager, and a cache. If it grew a Postgres dependency, something
went wrong.

---

## 4. Architecture diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│  Cisco Room Navigator — RoomOS, Persistent Web App mode              │
│  Chromium 102 · single tab · no chrome · storage wiped daily         │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  panel  (Preact + signals, ~40 KB gz)                          │  │
│  │                                                                 │  │
│  │   Shell ── Router ── NavRail                                    │  │
│  │     │                                                           │  │
│  │     ├─ Home    Rooms   Media   Photos   Settings                │  │
│  │     │                                                           │  │
│  │   ┌─┴──────────────────────────────────────────────┐            │  │
│  │   │ state/  entity signals · derived selectors     │            │  │
│  │   │ net/    ws client · backoff · heartbeat        │            │  │
│  │   │ idle/   activity monitor → screensaver         │            │  │
│  │   │ media/  LRU image cache · preloader            │            │  │
│  │   └────────────────────────────────────────────────┘            │  │
│  └────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────┬──────────────────────────────────────┘
                                │  HTTPS + WSS · same origin · LAN
                                │  Bearer PANEL_TOKEN
┌───────────────────────────────▼──────────────────────────────────────┐
│  navigator-panel  (Node 22 · Docker · deps: ws, yaml)                │
│                                                                       │
│  http/      static (immutable hashed assets) · /api · /img           │
│  hub/       panel socket registry · snapshot on connect · fan-out    │
│  ha/        ┌──────────────────────────────────────────┐             │
│             │ WS client · auth · subscribe_entities    │             │
│             │ StateStore (authoritative entity map)    │             │
│             │ reconnect w/ exponential backoff + jitter │            │
│             └──────────────────────────────────────────┘             │
│  immich/    REST client · album/asset queries · image streaming      │
│  config/    dashboard.yaml → validated, versioned, hot-reloaded      │
└───────────┬───────────────────────────────────┬──────────────────────┘
            │ WebSocket (persistent)            │ HTTPS (on demand)
            │ Bearer: long-lived token          │ x-api-key
┌───────────▼──────────────┐        ┌───────────▼──────────────────────┐
│  Home Assistant          │        │  Immich                          │
│  /api/websocket          │        │  /api/search/random              │
│  subscribe_entities      │        │  /api/albums/{id}                │
│  call_service            │        │  /api/assets/{id}/thumbnail      │
└──────────────────────────┘        └──────────────────────────────────┘
```

### The one data flow that matters

```
Someone flips a physical light switch
  → HA state machine fires state_changed
  → HA pushes a compressed diff on the existing socket        (~2 ms)
  → backend merges into StateStore, fans out to panels        (~1 ms)
  → panel writes one signal                                   (<1 ms)
  → one DOM text node + one transform update, next frame     (~16 ms)

Total: ~20 ms, no polling, no re-render, no HTTP request.
```

And the reverse:

```
Finger down on a brightness slider
  → optimistic local signal write, thumb moves in the SAME frame
  → pointermove updates the signal continuously (no network)
  → pointerup sends ONE call_service over the open socket
  → HA confirms via the normal state push, reconciling the optimism
```

The control never waits for the network to feel responsive. That is the
difference between "a webpage on a touchscreen" and "a panel."

---

## 5. Project structure

```
CiscoNavigatorWebApp/
├── docs/
│   ├── ROOMOS.md              # verified device constraints (read first)
│   ├── ARCHITECTURE.md        # this file
│   └── DEPLOYMENT.md          # Docker, TLS, RoomOS provisioning
│
├── config/
│   ├── dashboard.yaml         # YOUR config — rooms, favourites, albums
│   └── dashboard.example.yaml # documented reference
│
├── panel/                     # frontend — everything the Navigator runs
│   ├── index.html
│   ├── vite.config.ts         # target: chrome102
│   └── src/
│       ├── main.tsx
│       ├── app.tsx            # shell, error boundary, idle wiring
│       ├── config/            # typed view of dashboard.yaml
│       ├── net/
│       │   ├── socket.ts      # backend WS: backoff, heartbeat, resync
│       │   └── api.ts         # thin fetch wrapper w/ timeout + abort
│       ├── state/
│       │   ├── entities.ts    # per-entity signals, diff application
│       │   ├── selectors.ts   # derived: rooms, favourites, now-playing
│       │   └── ui.ts          # route, idle, connection, toasts
│       ├── domains/           # ← extension point for new HA domains
│       │   ├── registry.ts    # domain → control component + summariser
│       │   ├── light.tsx
│       │   ├── switch.tsx
│       │   ├── fan.tsx
│       │   ├── cover.tsx
│       │   ├── climate.tsx
│       │   ├── lock.tsx
│       │   ├── scene.tsx
│       │   ├── script.tsx
│       │   ├── sensor.tsx
│       │   └── media_player.tsx
│       ├── components/        # Card, Slider, Toggle, Sheet, Icon, …
│       ├── screens/
│       │   ├── Home/  Rooms/  Media/  Photos/  Settings/
│       │   └── Screensaver/
│       ├── lib/               # lru.ts, thumbhash.ts, format.ts, raf.ts
│       └── styles/
│           ├── tokens.css     # the design system, in custom properties
│           └── base.css
│
├── server/                    # backend — deps: ws, yaml
│   └── src/
│       ├── index.ts
│       ├── env.ts             # env parsing + validation, fail-fast
│       ├── config/            # YAML load, validate, watch
│       ├── http/              # router, static, security headers
│       ├── hub/               # panel sockets, snapshot, fan-out
│       ├── ha/                # client.ts, store.ts, services.ts
│       ├── immich/            # client.ts, images.ts
│       └── lib/               # backoff.ts, log.ts, lru.ts
│
├── Dockerfile                 # multi-stage: build panel → run server
├── docker-compose.yml
└── .env.example
```

**Why the split is where it is:** `panel/` and `server/` are separate npm
workspaces with separate `package.json` files, so a frontend dependency can
never accidentally end up in the server bundle or vice versa, and `npm ci
--omit=dev` in the container installs two runtime dependencies.

**The `domains/` directory is the designed extension point.** Adding support
for a new Home Assistant domain — `vacuum`, `humidifier`, `water_heater` —
means adding one file and one line in `registry.ts`. Nothing else in the app
knows what a `light` is; it asks the registry.

---

## 6. Home Assistant communication strategy

### Transport: one WebSocket, backend-held

`ws(s)://<ha>/api/websocket`, authenticated with a **long-lived access token**.
The handshake, per the official protocol:

```
server → { "type": "auth_required", "ha_version": "…" }
client → { "type": "auth", "access_token": "…" }
server → { "type": "auth_ok" }
```

Immediately after auth, before anything else, we negotiate:

```json
{ "id": 1, "type": "supported_features", "features": { "coalesce_messages": 1 } }
```

This makes Home Assistant batch messages instead of sending them individually —
meaningfully fewer socket frames and fewer JS parse ticks during a burst (a
scene activating 20 lights at once arrives as one frame, not 20).

### Subscription: `subscribe_entities`, not `subscribe_events`

```json
{ "id": 2, "type": "subscribe_entities" }
```

This is the command Home Assistant's own frontend uses. It matters:

| | `subscribe_events` (`state_changed`) | `subscribe_entities` |
|---|---|---|
| Initial state | separate `get_states` round trip | included, as `a` (added) |
| Update payload | **full old state + full new state** | changed keys only |
| Typical light dim | ~1.2 KB | ~90 bytes |
| Attribute handling | whole dict resent | `+`/`-` key diffs |

On a constrained CPU parsing JSON, that ratio is the difference between smooth
and janky when the house is busy. The compressed format is:

```jsonc
{ "type": "event", "event": {
    "a": { "light.kitchen": { "s": "on", "a": {…}, "c": "…", "lc": 1, "lu": 1 } },  // added
    "c": { "light.hall": { "+": { "s": "off", "lc": 2 } } },                         // changed
    "d": [ "light.gone" ]                                                            // deleted
}}
```

`server/src/ha/store.ts` applies these diffs to an authoritative `Map`. The
backend then forwards *the same shape* to panels, so the panel's diff-apply
code is the same code — written once, tested once.

Entities are filtered against the dashboard config before fan-out: a house
with 900 entities where the config references 60 sends 60. The rest are never
serialised.

### Commands: `call_service` on the same socket

```json
{ "id": 42, "type": "call_service",
  "domain": "light", "service": "turn_on",
  "target": { "entity_id": "light.kitchen" },
  "service_data": { "brightness_pct": 60 } }
```

No REST calls, no new TCP connections, no auth per request. The panel sends an
intent to the backend over its own socket; the backend validates it against the
config allow-list (a panel may only touch entities the config names — the panel
cannot be coerced into unlocking a door that isn't on the dashboard) and
forwards it.

Slider drags are **rate-limited to one command per ~120 ms while dragging plus
a guaranteed final command on release**, so a 3-second drag sends ~25 messages
instead of ~180, and always ends on the exact value.

### Music Assistant is a SECOND connection, not a Home Assistant feature

Home Assistant owns the house — lights, locks, covers, sensors. **Music
Assistant owns the music**, and the backend talks to it directly on its own
WebSocket (`ws://host:8095/ws`) rather than through Home Assistant's
`music_assistant.*` services.

That is a deliberate reversal of the "one connection, one source of truth"
rule everywhere else in this document, so it is worth being specific about
what it bought. The Home Assistant integration exposes a small slice of Music
Assistant. Three things a wall panel wants are not in it:

| | Through Home Assistant | Direct |
| --- | --- | --- |
| Queue | current item, next item, a count | the rows, paged — plus move, remove, jump, clear |
| "Recently played" | the library re-sorted by last-played | a real play history, including things you do not own |
| Updates | re-fetch after each track change | pushed the instant anything changes it |
| Drill-down | album → (nothing) | album → tracks, artist → albums, playlist → tracks |
| Groupable-with | inferred from a feature bitmask | `can_group_with`, exactly |

Protocol notes, being the parts that fail silently rather than loudly:

- **The server info frame is unsolicited.** It arrives before anything is
  asked for and carries no `message_id`, so it is consumed as part of
  connecting rather than dispatched like a reply.
- **Auth from schema 28.** Newer servers require a token
  (`MASS_TOKEN`); older ones have no `auth` command at all, so sending one
  would break them. The schema version in the info frame decides.
- **Partial results.** A long list arrives as several messages sharing one
  `message_id`, all but the last flagged `partial`. Treating the first as the
  whole answer truncates every long list — and only for people with big
  libraries.

The command surface is allow-listed by exact name, and that matters more here
than on the Home Assistant side, not less: Music Assistant's API is an
*administrative* API. The same socket that skips a track can delete a
playlist, remove a provider and trigger a full resync. Every player and queue
id in a command is checked against what Music Assistant actually told us
about, and `media` must be a library URI — Music Assistant will otherwise
happily play `file:///etc/passwd` or fetch a URL of the caller's choosing.

Cover art never reaches the panel as a Music Assistant URL. Those are
frequently container hostnames nothing else can resolve, and handing them over
would tell the panel where another service lives. The backend registers each
one and returns an opaque key on our own origin — see
`server/src/http/media-art.ts` for why a key rather than a `?url=` parameter
is the whole point.

**Without `MASS_URL` the panel still runs.** Home Assistant, photos and the
clock are unaffected; the Media screen explains what is missing rather than
sitting empty.

### Reconnection

Exponential backoff with full jitter: `min(30s, 500ms · 2^n) · random(0.5–1.0)`.
Jitter matters when HA and the panel restart together after a power cut. On
reconnect the backend re-subscribes and diffs the fresh snapshot against its
last known state, so panels receive only what actually changed while the link
was down — not a full repaint.

A 30-second application-level ping (`{"type":"ping"}`) detects half-open
sockets, which a Wi-Fi roam produces and TCP does not report for minutes.

---

## 7. Immich communication strategy

Verified against the Immich OpenAPI spec, **API version 3.1.0**.

### Auth

Header `x-api-key: <key>`, scoped to `asset.read` and `album.read`. Created in
Immich under *Account Settings → API Keys*. **Backend only.** The panel is
never given a value it could use to reach Immich directly.

### Asset selection

| Source | Endpoint |
|---|---|
| Random | `POST /api/search/random` |
| Favourites | `POST /api/search/random` with `isFavorite: true` |
| Album | `GET /api/albums/{id}` |
| Recent | `POST /api/search/metadata` ordered by date |

`RandomSearchDto` gives us everything the slideshow needs server-side:
`albumIds`, `isFavorite`, `takenAfter`/`takenBefore`, `personIds`, `type`,
`withExif`, `size`. So "random favourites from these two albums, photos only,
last five years, with EXIF" is **one request**, not a fetch-and-filter loop.

The backend maintains a shuffled **playlist of ~200 asset IDs**, refilled in
the background when it drops below 50. The panel asks for "the next N" and
never runs a search itself. Restarting the panel does not restart the
slideshow — the backend remembers the position.

### Images — the critical part

`GET /api/assets/{id}/thumbnail?size=…` where `size` ∈ `thumbnail`, `preview`,
`fullsize`, `original`.

**The rule: `original` is never requested. There is no code path that can.**

| Use | `size` | Approx. |
|---|---|---|
| Grid tile | `thumbnail` | ~250 px |
| Slideshow, 1280×800 panel | `preview` | ~1440 px |
| Slideshow, 1920×1080 panel | `preview` | ~1440 px |

`preview` at ~1440 px is already ≥ the panel's long edge. A 4000×3000 original
would decode to ~48 MB of RAM against an unpublished budget that terminates
the web view when exceeded (`ROOMOS.md` §2). `preview` decodes to ~6 MB. This
single decision is the difference between a slideshow that runs for a month
and one that dies overnight.

The backend re-serves these at `/img/{id}?s=preview` with
`Cache-Control: public, max-age=31536000, immutable` — Immich asset IDs are
UUIDs and content never changes, so caching is unconditionally safe. The
panel's HTTP cache is wiped daily by RoomOS, which is fine: the backend's own
copy is not.

### Slideshow mechanics

- **Two stacked `<img>` layers**, crossfaded with `opacity` only — a compositor
  operation, no layout, no repaint.
- **`decode()` before display.** `img.decode()` resolves once the bitmap is
  ready; only then does the crossfade start. This is what removes the
  half-drawn-image flash that `onload` alone still allows.
- **N+1 and N+2 preloaded**, no more. Bounded LRU of **6 decoded images**
  (~36 MB at `preview` size) with explicit eviction: `img.src = ''` and drop
  the reference, so V8 and the image cache can both release it.
- **ThumbHash placeholder — average colour only.** Immich returns a
  `thumbhash` on every asset: ~25 bytes encoding a tiny blurred version. We
  decode only its **DC term**, the average colour, and paint that behind the
  image. So a slow fetch shows a colour close to the incoming photo rather
  than an empty frame.

  A full decode would give a blurred thumbnail, which is prettier. It is also
  ~80 lines of DCT maths whose failure mode is silent — get a coefficient
  wrong and you render plausible-looking noise on a device nobody inspects for
  weeks. With no reference vectors to check a full decoder against, the
  average colour is the version that can be *verified*: it is six lines, and
  a neutral-chroma hash must decode to grey, which the browser test asserts
  (measured: `rgb(133, 129, 127)`, channel spread 6). Upgrading later is a
  self-contained change to `panel/src/lib/thumbhash.ts`.
- **Orientation.** Landscape photos `cover` the screen. A portrait is paired
  with another portrait and the two are shown side by side, each filling half
  — a portrait alone on a 16:9 panel uses about a third of the screen and
  fills the rest with nothing. Paired halves are close enough to their own
  aspect ratio to `cover` without losing anything worth keeping; an *unpaired*
  portrait still falls back to `contain`, which is why `pairPortraits` can be
  turned off without breaking the layout.

  The partner is found by looking a bounded distance ahead in the queue,
  because portraits are scattered through a mixed library and strict adjacency
  would almost never pair. Both halves are decoded before the crossfade
  starts, or the collage would assemble itself on screen one photo at a time.

  This is also why the preloader predicts the next slide's pairing rather than
  taking the next two from the queue: the image cache is sized at exactly
  three slides (previous, current, next), so fetching the wrong photos evicts
  one that is still fading out and clears its `src` mid-transition. A browser
  test asserts no on-screen image ever loses its `src`.

---

## 8. Authentication strategy

Three separate trust boundaries. Deliberately different mechanisms.

### Backend → Home Assistant: long-lived access token

Created under your HA profile, stored as `HA_TOKEN` in the backend's
environment (Docker secret or `.env` that is `.gitignore`d), never in git,
never in the panel bundle. Ideally on a **dedicated non-admin HA user**
("panel") so its capabilities are scoped and it is independently revocable —
if the token ever leaks you revoke one user, not your own session.

*Why not OAuth?* HA's OAuth flow needs an interactive login and a redirect,
which is exactly the "type a password on a wall-mounted device with a vertical
soft keyboard" problem Cisco calls out (`ROOMOS.md` §6). A long-lived token in
a server-side vault is both more secure and more reliable here.

### Backend → Immich: scoped API key

`x-api-key`, with only `asset.read` and `album.read` granted. No upload, no
delete, no admin. A compromised panel cannot alter your library — the worst
case is reading photos it was already displaying on a wall.

### Navigator → Backend: bearer token, provisioned in the URL

This is the interesting one, because `ROOMOS.md` §5 rules out the obvious
answer. A session cookie would be **deleted by RoomOS's daily storage cleanup**,
and the panel would present a login screen to a device with no user.

So:

1. The device is provisioned once with `https://panel.lan/?t=<PANEL_TOKEN>`.
2. On load the panel stores the token in `localStorage` and immediately
   `history.replaceState`s it out of the visible URL.
3. Every request and the WebSocket handshake carry it.
4. **If `localStorage` was wiped, the token is still in the provisioned URL** —
   RoomOS reloads that URL, the panel re-reads `t`, and recovers with no user
   interaction. `localStorage` is a cache, the URL is the source of truth.

Properties: survives the daily wipe, survives reboots, needs no keyboard,
revocable by changing one env var, and constant-time compared server-side.

Set `PANEL_TOKEN=` (empty) to disable auth entirely for a bench-test on a
trusted LAN — but it is on by default, because "trusted LAN" and "every device
on the guest VLAN can unlock the front door" are the same sentence.

### What is deliberately *not* built

No user accounts, no roles, no login UI, no password reset. A wall panel has
one user: whoever is standing in front of it. Building an auth system for a
device that cannot type is complexity with no security benefit.

### Reasonable practice on a trusted LAN

- TLS between panel and backend (also required to avoid mixed-content when the
  page is HTTPS and the socket must be WSS).
- Backend binds to the LAN interface; not exposed to the internet, not port-
  forwarded. If you want it remotely, put it behind your existing VPN.
- Service allow-list: the backend will only call domains/services on the
  allow-list, targeting only entities named in `dashboard.yaml`. A panel that
  someone tampers with cannot reach entities the config never mentioned.
- Security headers on every response (CSP with no `unsafe-eval`, `frame-
  ancestors 'none'`, `X-Content-Type-Options: nosniff`).
- No token, entity ID, or photo path is ever logged at default log level.

---

## 9. RoomOS-specific considerations

Each of these is a direct response to a verified constraint. Full detail and
citations in [`ROOMOS.md`](./ROOMOS.md).

| Constraint | Response in this design |
|---|---|
| Chromium **102** floor | `build.target: 'chrome102'`; no `:has()`, container queries, `color-mix()`, `oklch()`, CSS nesting, View Transitions, `toSorted`, `Promise.withResolvers` |
| Memory-capped; **web view is killed** on overrun | Every cache bounded + explicitly evicted; never fetch originals; ≤6 decoded images; no unbounded arrays; heap watched via remote DevTools |
| Cisco: *"resize them on the server"* | Backend picks the Immich size; panel cannot request a large one |
| Cisco: *"avoid drop shadows"*, *"reduce layers with opacity"* | Zero `box-shadow` in the design system. Depth comes from layered surface tokens and hairline borders |
| Only `transform`/`opacity` are accelerated | Enforced by convention and review; sliders translate, they don't resize |
| **WebGL off by default** | Not used at all — no device reconfiguration required to render a dashboard |
| **Single tab**; `window.open` replaces the page | No external links, no `target="_blank"`, no OAuth popups anywhere |
| **Storage wiped daily** | No panel-only state; token recoverable from the provisioned URL; server holds slideshow position and config |
| **No offline mode** (web view disabled without network) | Resilience targets *backend/HA/Immich* outages, not link loss |
| Touch order unstable; use `identifier` | Pointer Events keyed by `pointerId` throughout |
| Zoom suppression must not hit `document` | `touch-action` scoped to interactive elements; `preventDefault` never global |
| Soft keyboard is crude; no numeric/date/colour input | No text entry in normal operation; all values set by direct manipulation |
| Only system sans-serif guaranteed | System font stack, zero font bytes on first paint; woff2 hook documented |
| Emoji **monochrome subset only** | Zero emoji; all icons are inline SVG |
| Viewport size unconfirmed | Fully fluid layout; root font size from `clamp(14px, min(1.25vw,2vh), 21px)`; Settings displays measured viewport |
| Kiosk mode: **user cannot exit or reload** | Global error boundary + watchdog; no failure path unmounts the shell; last-resort self-recovery reload |
| IPS panel, permanently on | Screensaver overlays drift via `transform` and reposition per photo |
| JSXAPI auto-injected in PWA mode | Used only if present, only for read-only diagnostics + optional LED tint; app runs identically in a desktop browser |
| Favicon must be 60–1200 px | 192 px PNG + `apple-touch-icon` (checked first by RoomOS) |
| Remote DevTools on `:9222` | Profiling checklist in `DEPLOYMENT.md` |

---

## 10. Phased implementation plan

Each phase ends with something that **runs on the device**. No phase begins
before the previous one is verified there. This is the sequence you asked for,
with the acceptance criteria that make "functional" checkable.

| # | Phase | Delivers | Done when |
|---|---|---|---|
| **0** | Constraints | `ROOMOS.md`, `ARCHITECTURE.md` | ✅ this document |
| **1** | Shell | Monorepo, Vite/Preact, Node server, design tokens, nav, 5 stub screens, Docker | Loads on the Navigator; nav responds in <100 ms; container builds |
| **2** | HA connectivity | HA WS client, auth, `subscribe_entities`, StateStore, panel relay, backoff, connection indicator | Entity states visible; HA restart recovers with no user action |
| **3** | Real-time state | Signal store, diff application, selectors, optimistic writes | Physical switch → UI in <100 ms; no full re-render (verified in DevTools) |
| **4** | Entity controls | `domains/` registry + light, switch, fan, cover, climate, lock, scene, script, sensor | Every configured entity controllable; adding a domain = one file |
| **5** | Media player | Now Playing screen, artwork, transport, volume, source, multi-player switching | Reflects external playback changes live |
| **6** | Immich | Backend client, playlist, `/img` proxy, cache headers, grid | Grid scrolls at 60 fps; no original ever requested (verified in logs) |
| **7** | Slideshow | Crossfade, `decode()` gating, N+1/N+2 preload, ThumbHash, LRU, overlays | 30 min unattended with zero visible load; heap flat in DevTools |
| **8** | Idle | Activity monitor, screensaver transitions, burn-in drift, wake-to-dashboard | Idles in, touches out instantly, survives overnight |
| **9** | Hardening | Error boundary, watchdog, degraded modes, resync, self-recovery | Kill HA, Immich, and the backend in turn — UI degrades, never blanks |
| **10** | Performance | Profile on-device, budget enforcement, bundle audit | <50 KB gz shell, <1.5 s cold to interactive, flat heap over 24 h |
| **11** | Deployment | Compose, TLS, provisioning docs, update path | Reproducible from a clean machine following `DEPLOYMENT.md` |

**Long-run acceptance test, run before calling this finished:** leave the panel
mounted and untouched for seven days with the slideshow cycling. Then check
heap and DOM node count against hour one. If either grew, phase 10 is not done.

---

## Performance budget

Enforced, not aspirational. Phase 10 fails the build if these regress.

| Metric | Budget |
|---|---|
| Shell JS, gzipped | **< 50 KB** |
| CSS, gzipped | < 12 KB |
| Cold load → interactive (LAN) | **< 1.5 s** |
| Touch → visual feedback | **< 100 ms** (one frame is the target) |
| Screen transition | < 250 ms |
| Steady-state JS heap | **< 60 MB**, flat over 24 h |
| Requests after first paint | 0 until the user acts |
| Idle CPU (dashboard, clock ticking) | ~0% between seconds |
