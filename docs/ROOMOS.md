# RoomOS Web Engine — Verified Constraints

Everything in this file was checked against Cisco's own developer documentation
(`cisco-ce/roomos.cisco.com`, `doc/Features/WebEngine.md`,
`doc/Features/WebAppsOnNavigator.md`, `doc/WhatsNew/ReleaseNotesRoomOS_26.md`)
rather than assumed. Where a fact could **not** be verified from a primary
source it is marked **[unverified]** and the app is designed so that being
wrong about it is harmless.

This document is the input to every design decision in `ARCHITECTURE.md`.
Read it before "optimising" anything.

---

## 1. Browser engine

| Property | Value | Source |
|---|---|---|
| Engine | Chromium via **Qt WebEngine**, V8 JavaScript | WebEngine.md |
| Version | Tracks Cisco's Qt bumps; **not** current Chrome. Documented as Chromium **102** as of April 2023, plus backported security patches | WebEngine.md |
| Tabs / windows | **Exactly one.** `window.open` *replaces* the current page | WebEngine.md |
| User agent | `Mozilla/5.0 (Linux; RoomOS; <device> ...) QtWebEngine/... Chrome/<ver> Safari/537.36` | WebEngine.md |

**Consequence:** we target a *floor* of Chromium 102, not "latest Chromium".
Cisco's own summary is: *"develop with a slightly older iPad web browser in
mind."*

### Baseline we build to

Build target is pinned to `chrome102` in `panel/vite.config.ts`. Anything
newer must be feature-detected or avoided.

**JavaScript — safe at 102:** ES2022 syntax, class fields & private methods,
optional chaining, nullish coalescing, top-level `await`, `Array.prototype.at`,
`Object.hasOwn`, `findLast`, `structuredClone`, `AbortController`,
`ResizeObserver`, `IntersectionObserver`, WebSockets, Web Workers,
WebAssembly, `requestIdleCallback`.

**JavaScript — NOT available at 102, do not use:**

| Feature | Landed in |
|---|---|
| `Array.prototype.toSorted` / `toReversed` / `with` | 110 |
| `Promise.withResolvers` | 119 |
| `Object.groupBy` / `Map.groupBy` | 117 |
| `Array.fromAsync` | 121 |
| View Transitions API | 111 |
| `navigator.scheduling.isInputPending` (partial) | assume no |

**CSS — safe at 102:** custom properties, flexbox, grid, `clamp()`/`min()`/`max()`,
`aspect-ratio`, `gap`, `inset`, `backdrop-filter`, `content-visibility`,
`overscroll-behavior`, `scroll-snap`, `conic-gradient`, `@supports`,
`prefers-reduced-motion`.

**CSS — NOT available at 102, do not use:**

| Feature | Landed in |
|---|---|
| `:has()` | 105 |
| Container queries (`@container`) | 105 |
| `color-mix()` | 111 |
| `oklch()` / `lab()` / `lch()` | 111 |
| Native CSS nesting | 112 |
| `text-wrap: balance` | 114 |
| `@property` | 85 (safe, but unused) |
| Subgrid | 117 |

This is why the stylesheet in `panel/src/styles/` is written with explicit
custom properties and flat selectors and looks slightly "old-fashioned". That
is deliberate — it is the only way the panel renders correctly on the device.

---

## 2. Performance envelope

Direct quote from Cisco:

> Because real-time audio/video is the main priority of the Webex devices, the
> web engine has lower priority than the main video features and is
> restricted, both in memory and CPU usage. If the web page requires more
> memory than allowed, Chromium will try to optimise usage with the memory
> pressure handler. Failing this, the web view will eventually be terminated
> and show an error page.

RoomOS 11 added a diagnostic message specifically for *"situations where the
web app consumes excessive memory, leading to crashes in the integrated web
engine."*

Cisco's exact memory/CPU budget is **not published** and varies by device and
current system load. **[unverified]**

**Consequences, all of which are load-bearing in this design:**

1. **A memory leak is not a slow degradation — it is a crash.** The panel is
   expected to run for weeks. Every cache in this app is explicitly bounded
   and evicted (see `panel/src/lib/lru.ts`).
2. Decoded images dominate memory. A 4000×3000 JPEG costs ~48 MB *decoded*
   regardless of its file size. We never load Immich originals. Ever.
3. Cisco's own performance advice, followed literally in this codebase:
   - Avoid images larger than needed; **resize them on the server**
   - Reduce the number of layers with opacity
   - **Avoid drop shadows**
   - Avoid huge canvases
   - Use only hardware-accelerated CSS animations
   - Avoid doing much work in event handlers, delegate to async tasks
   - Use `requestAnimationFrame`, not `setInterval`, for animation

### Animation

> Both CSS transitions and web animations are supported and hardware
> accelerated whenever possible. This typically means the `transform` and
> `opacity` CSS property. Try to avoid doing animations that requires DOM or
> layout operations.

**Rule for this project: animate `transform` and `opacity` only.** No
animated `width`, `height`, `top`, `left`, `filter`, `box-shadow`, or
`background-position`. Sliders move a child with `transform: translate3d()`,
they do not animate `width`.

### `backdrop-filter`

Supported by the engine, but it forces an offscreen pass per layer on a GPU
that is simultaneously doing video. It is available in this app as an opt-in
(`ui.blur: true` in the config) and is **off by default**. Cisco explicitly
warns about layer count and drop shadows; blur is the same class of cost.

---

## 3. WebGL

> WebGL is turned off by default, but can be enabled with
> `xConfiguration WebEngine Features WebGL`.

**We do not use WebGL.** Requiring a non-default device configuration to render
a home dashboard is a reliability liability, and nothing here needs it. Canvas
2D is used in exactly one place (ThumbHash placeholder decoding, ~8 KB of
pixels at a time).

---

## 4. Networking

| Capability | Status |
|---|---|
| WebSockets | **Supported** (WebEngine.md feature list) |
| Web Workers | Supported |
| WebAssembly | Supported |
| Fetch / XHR | Supported, standard CORS rules apply |
| Service Workers | Not stated either way. **[unverified]** — treated as unavailable |
| Offline operation | **Not possible.** *"currently the web views are disabled if the device does not have network"* |
| Downloads / uploads | **Not supported** |
| Notifications API | **Not supported** |
| PDF rendering | **Not supported** |

**Consequences:**

- Service Workers are **not** part of the caching strategy. All caching is
  HTTP-cache-based (`Cache-Control` / `ETag` set by our own backend) plus an
  in-memory LRU. This works on every engine version and cannot get "stuck"
  serving a stale build — a real risk with SW on a panel you cannot easily
  reach.
- Because the device drops the web view entirely when the network is gone,
  "offline mode" is about surviving *backend* outages, not *network* outages.
  Our backend is on the same LAN as the panel; Home Assistant and Immich may
  be elsewhere. The backend absorbs their outages.

### Certificates and CORS

> For root CAs, we use the same bundle as RoomOS. You can also add custom CA
> bundles, and disable built-in ones in the device's web portal.

So a private CA **is** workable: install your internal root CA on the device
via its web portal, then serve the panel over HTTPS with a cert from that CA.

RoomOS does not publish a hard HTTPS-only requirement for web apps
**[unverified]**, and plain HTTP does load. We still recommend HTTPS and the
deployment docs cover it, because:

- A page served over HTTPS cannot open a `ws://` (insecure) socket, and a page
  served over HTTP cannot be upgraded later without changing the device config.
  Picking HTTPS once avoids a mixed-content trap.
- Cisco tightened certificate handling in RoomOS 11 (OCSP "fail-open" was made
  explicit), which signals the direction of travel.

**CORS is designed away entirely.** The panel makes requests to exactly one
origin: the origin it was served from. No preflights, no CORS headers, no
credentials in cross-origin requests. See `ARCHITECTURE.md` §3.

---

## 5. Storage and data lifetime

This is the single most surprising RoomOS behaviour and it dictates the
authentication design.

> **Web apps: data is persisted but by default deleted once every day.** This
> can be disabled by setting `xConfiguration RoomCleanup AutoRun ContentType
> WebData` to `Off`. This is recommended for personal devices at home. All web
> apps share the same profile, so you cannot delete data for web apps
> individually.

Also: `xCommand WebEngine DeleteStorage` wipes it manually at any time.

**Consequences:**

1. `localStorage`, cookies, IndexedDB and the HTTP cache on the panel can all
   vanish at **any** daily cleanup, and *will* by default.
2. Therefore **no application state may live only on the panel.** The dashboard
   config, the entity state, the slideshow position, and the selected media
   player all live server-side or are re-derivable in under a second.
3. Therefore **session-cookie authentication is not durable.** If the panel
   token were a cookie, the panel would log itself out every night at 04:00
   and show a login screen to a wall-mounted device with no keyboard user.
4. `localStorage` is still used, but only as an *optimisation* (last known
   route, cached config ETag). Losing it costs one extra request, never
   correctness. Cisco's own advice — *"Use local storage to store temporary
   user data, to prevent data loss if the web view is closed unexpectedly"* —
   is followed in that spirit.

`docs/DEPLOYMENT.md` instructs setting `RoomCleanup AutoRun ContentType
WebData: Off`, which Cisco explicitly recommends for personal devices. The app
is nonetheless correct without it.

---

## 6. Touch

> the Webex board supports up to 10 simultaneous touch events.
> Note that the ordering of touch events is not stable, so use the touch event
> `identifier` to keep track of simultaneous touches.
> The traditional `onclick` event is also supported.

Two-finger zoom is on by default "for accessibility and convenience" and must
be suppressed per-element with `preventDefault`, with this caveat:

> Be careful doing this on the whole document though, as prevent default on
> for example form elements such as input fields and textareas might cause
> them to behave poorly.

**Consequences:**

- Pointer Events are used, not raw touch events, and every drag handler keys
  off `pointerId` (the Pointer Events equivalent of `identifier`) so unstable
  event ordering is a non-issue.
- Zoom/pan suppression is applied to interactive surfaces (cards, sliders,
  the slideshow), **not** to `document`. Inputs in Settings keep native
  behaviour.
- `touch-action: manipulation` removes the ~300 ms click delay and double-tap
  zoom without breaking scroll. `touch-action: none` on slider tracks only.
- `:active` styling alone is not reliable feedback under a finger; we drive
  press states from `pointerdown` and give every control a `transform: scale()`
  response within one frame.

### Soft keyboard

> The RoomOS soft keyboard behaves similarly to the touch keyboards on Android
> and iOS, and pops up any time an input field gets focus. [...] It does not
> support specialised formats such as numeric, calendar and colour picker.
> A vertical soft keyboard does not encourage a lot of text input.

**Consequence:** the UI has essentially no text entry. There are no
`<input type="number">`, `date`, or `color` controls anywhere — brightness,
temperature and colour are all set by direct-manipulation touch controls.
Settings is read-mostly; the dashboard is configured by a YAML file on the
server, not by typing on the panel.

---

## 7. Viewport and screen

For the main room displays Cisco documents a **logical viewport of 1920×1080**,
rendered at native 4K on 4K panels (Retina-style), with the viewport meta tag
honoured:

> `<meta name="viewport" content="width=960, initial-scale=1">`

The Room Navigator is a 10.1" panel. Its exact **CSS** viewport in Persistent
Web App mode is **[unverified]** — Cisco's public datasheets are not reachable
from this environment and the WebEngine doc's 1920×1080 figure is written about
room displays. The device's physical panel is widely reported as 1280×800.
Cisco's own Navigator sample app (`cisco-ce/roomos-samples`,
`navigator/navigator-webapp/index.html`) pins no width at all:

```html
<meta name="viewport" content="initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
```

**Consequence — and this is why the uncertainty does not matter:** the layout
is fully fluid and resolution-independent. No pixel dimension is hard-coded.
The root font size is derived from the viewport:

```css
html { font-size: clamp(14px, min(1.25vw, 2vh), 21px); }
```

At 1280×800 that resolves to 16 px; at 1920×1080 to 21 px — larger text on the
larger, further-away screen, which is the behaviour you want anyway. Everything
else is expressed in `rem`. The app therefore renders correctly at 1280×800,
1920×1080, or anything in between, and Settings shows the *actual* measured
viewport so the on-device value can be confirmed in five seconds.

Note also from the RoomOS 26 release notes: *"Web Engine supports 1080p and
above. Full-screen web views at 720p are not supported."* — relevant if you
also run this on a room display.

---

## 8. Persistent Web App mode (the deployment target)

From `WebAppsOnNavigator.md`:

> Run web applications on Room Navigator by selecting Persistent Web App mode
> during onboarding [...] The app that you select displays on the Room
> Navigator's entire screen, replacing the RoomOS user interface, and it can't
> be dismissed by users.

- This *is* the kiosk/fullscreen behaviour. The Fullscreen API is not needed
  and is not called.
- There is no browser chrome, no back button, and no way for a user to exit.
  **A crash or a white screen is unrecoverable without physical access.** This
  is the reason for the global error boundary, the watchdog, and the rule that
  no API failure may ever unmount the shell.
- JSXAPI is injected automatically in this mode — the page gets a bound
  `xapi` object with no connection code. The supported surface is small
  (bookings, LED control, room analytics, system identity). We use only
  `xStatus SystemUnit ...` for the Settings diagnostics panel, and only if
  present, so the app runs identically in a desktop browser during development.
- A useful extra on the Navigator: `xCommand UserInterface LedControl Color Set`
  can tint the device's light bar. Wired up as an optional status indicator.

### Standby / burn-in

In Kiosk mode the device *"will never enter half wake state, but it will go to
standby after the specified number of minutes."* The Navigator's panel is an
IPS LCD, so burn-in risk is far lower than OLED, but persistent static
elements over weeks are still not ideal. The screensaver therefore drifts its
overlay elements slowly across the screen (`transform` only) and repositions
them on each photo change — see `panel/src/screens/Screensaver`.

---

## 9. Fonts, icons, media

- **Only the RoomOS system sans-serif is guaranteed.** Web fonts (`@font-face`,
  woff2) are supported. This app uses a system font stack by default so first
  paint costs zero extra bytes, with a documented hook to self-host a woff2.
- **Emoji support is limited — "only a sub-set, and in monochrome only."**
  Therefore: no emoji in the UI, ever. All icons are inline SVG paths shipped
  in the bundle.
- Video: WebM and MPEG-4, hardware accelerated, "not recommended to go beyond
  1080p". **HLS is not natively supported.**
- Audio autoplay: the standard Chrome "requires user interaction" policy is
  **not** applied. Audio and video can autoplay. We don't need this, but it
  means no autoplay-unlock workarounds are required.
- Favicon for the web-app tile must be **between 60 and 1200 px**; smaller
  icons are silently ignored. We ship a 192 px PNG plus `apple-touch-icon`,
  which is the first thing RoomOS looks for.

---

## 10. Debugging on-device

```
xConfiguration WebEngine RemoteDebugging: On
```

Then open `http://<device-ip>:9222` in desktop Chrome — **IP address, not
hostname; http, not https.** This gives the full Chrome DevTools, including
the performance profiler and heap snapshots, against the live panel. Cisco
notes a prominent warning bar is displayed while it is on, and to turn it off
afterwards.

This is the only way to get real numbers. Cisco's advice is blunt and correct:

> the performance is usually never as good as a developer expects, especially
> if doing initial development on a beefy laptop.

`docs/DEPLOYMENT.md` includes a profiling checklist to run against the device
before declaring any performance work finished.

---

## Summary of design rules extracted from this document

1. Target Chromium 102. No `:has()`, no container queries, no `color-mix()`,
   no `oklch()`, no CSS nesting, no View Transitions.
2. Animate `transform` and `opacity` only.
3. No drop shadows. Blur is opt-in and off by default.
4. No WebGL. No Service Worker. No PDF, downloads, uploads, or notifications.
5. Every cache is bounded and evicted. Assume a crash on leak.
6. Never fetch a full-resolution image.
7. Panel storage is wiped daily by default — no state may live only on the panel.
8. One origin only. CORS is designed out, not worked around.
9. Pointer Events keyed by `pointerId`; `preventDefault` scoped to elements,
   never `document`.
10. Almost no text input; nothing that needs a numeric, date or colour keyboard.
11. Fully fluid layout; no hard-coded pixel dimensions.
12. The app cannot be dismissed or reloaded by the user. It must not be able
    to die.

---

## Sources

- [`cisco-ce/roomos.cisco.com` — `doc/Features/WebEngine.md`](https://github.com/cisco-ce/roomos.cisco.com/blob/master/doc/Features/WebEngine.md)
- [`cisco-ce/roomos.cisco.com` — `doc/Features/WebAppsOnNavigator.md`](https://github.com/cisco-ce/roomos.cisco.com/blob/master/doc/Features/WebAppsOnNavigator.md)
- [`cisco-ce/roomos.cisco.com` — `doc/WhatsNew/ReleaseNotesRoomOS_26.md`](https://github.com/cisco-ce/roomos.cisco.com/blob/master/doc/WhatsNew/ReleaseNotesRoomOS_26.md)
- [`cisco-ce/roomos.cisco.com` — `doc/WhatsNew/ReleaseNotesRoomOS_11.md`](https://github.com/cisco-ce/roomos.cisco.com/blob/master/doc/WhatsNew/ReleaseNotesRoomOS_11.md)
- [`cisco-ce/roomos-samples` — `navigator/navigator-webapp`](https://github.com/cisco-ce/roomos-samples/tree/main/navigator/navigator-webapp)
- [Configure a persistent web app on Room Navigator](https://help.webex.com/en-us/article/ohq3u6/Configure-a-persistent-web-app-on-Room-Navigator)
- [Best practices for using the Web Engine](https://help.webex.com/en-us/article/pdybr5/Best-Practices-For-Using-the-Web-Engine)
