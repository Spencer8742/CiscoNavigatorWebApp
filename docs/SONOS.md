# Sonos: direct integration

**Status: built, through music services and the full speaker-control surface.
Music Assistant has been removed.**

| Phase | | |
|---|---|---|
| 1 | Topology — the household | ✅ |
| 2 | Events — GENA, with a polling fallback | ✅ |
| 3 | Control — transport, volume, grouping | ✅ |
| 4 | Browse — favourites, playlists, library, radio, queue | ✅ |
| 5 | Spotify search | ✅ |
| 6 | Cut over — `mass/` deleted, types renamed | ✅ |
| 7 | Music services — SMAPI browse, search and device-link | ✅ |
| 8 | The rest of the app — sleep, EQ, inputs, group volume | ✅ |

Sonos is the music system: rooms, groups, live state, transport, volume, seek,
shuffle, repeat, grouping, the queue, favourites, playlists, the local library,
radio, every music service the household has linked, and search across all of
them — plus the sleep timer, tone controls, group volume and physical inputs.

Play history remains the one thing with no Sonos equivalent; §3 says why.

What each phase delivered, and what it deliberately did not, is in **§15**.

> **§1–§14 are the plan as it was written**, kept in the present tense because
> the reasoning is the point — why the cloud API was rejected, what removing
> Music Assistant would cost, which failures are silent. Where building it
> changed a decision, §15 says so and is authoritative.

The goal, stated as the decision it is: **Sonos becomes the music system this
panel talks to, and Music Assistant is removed.** The backend speaks the local
Sonos protocol on the LAN — no cloud, no Home Assistant, no Music Assistant —
and drives transport, volume, grouping, the queue, favourites, playlists, the
local library, Sonos Radio and Spotify search.

Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) §6 first. This document replaces the
"Music Assistant is a SECOND connection" section of it.

---

## 1. The one thing that makes this cheap

The panel does not know what a Music Assistant is.

```
panel/src/components/Browse.tsx        0 references to Music Assistant
panel/src/components/Queue.tsx         0
panel/src/components/GroupSheet.tsx    0
panel/src/components/PlayerPicker.tsx  0
panel/src/components/Progress.tsx      0
panel/src/components/Artwork.tsx       0
```

Every screen that draws music — the browser, the queue editor, the group
sheet, the player picker, the progress bar — talks to `shared/protocol.ts`
types and nothing else. Music Assistant appears by name in **seven files**, and
five of those are one-line mentions in copy or a health field.

| File | References | What they are |
|---|---|---|
| `panel/src/state/actions.ts` | 27 | `mass()` helper + MA command strings |
| `shared/protocol.ts` | 10 | `MassPlayer`, `MassQueue`, `MassMedia`, `health.mass` |
| `panel/src/state/players.ts` | 5 | type imports |
| `panel/src/screens/Media.tsx` | 4 | the empty-state copy |
| `panel/src/screens/Settings.tsx` | 3 | link status row |
| `panel/src/state/selectors.ts` | 2 | type imports |
| `panel/src/net/socket.ts` | 2 | `massCommand()` wrapper |

So this project is **not** a rewrite of the Media screen. It is a new backend
module behind an existing wire protocol, plus a rename. The protocol was
designed to describe *speakers, queues and browsable items*, which Sonos also
has — the abstraction happens to already be the right one, and that is worth
banking rather than redesigning.

**Concretely: `Mass*` types become `Player`, `PlayerQueue`, `NowPlaying`.**
Everything else in `shared/protocol.ts` — `MediaItem`, `BrowseRequest`,
`BrowseResult`, `QueueEntry`, `QueuePage`, `BROWSE_PAGE` — survives verbatim.

---

## 2. Which Sonos API

Three exist. Only one is usable here, and the reasons are RoomOS reasons.

| | Sonos Control API (cloud) | Local UPnP/SOAP | Music Assistant's Sonos provider |
|---|---|---|---|
| Transport, volume, grouping | ✅ | ✅ | ✅ |
| Queue editing | partial (cloud queue) | ✅ `Q:0` | ✅ |
| Favourites / playlists | ✅ | ✅ `FV:2` / `SQ:` | ✅ |
| **Music search** | ❌ **no search namespace at all** | ✅ via SMAPI / service APIs | ✅ |
| Works without internet | ❌ | ✅ | ✅ |
| Auth | OAuth 2.0, browser redirect | none on the LAN | one token |
| Push events | HTTPS webhook to a **public, CA-signed** callback | GENA `NOTIFY` on the LAN | WebSocket |

**The Control API is disqualified twice over.** Its authorization is an OAuth
redirect to a registered `redirect_uri`, and RoomOS gives us a single tab where
`window.open` *replaces the page* ([`ROOMOS.md`](./ROOMOS.md) §8) — there is
nowhere for a redirect to land. Its event subscriptions require a publicly
reachable HTTPS callback with a CA-signed certificate, which means exposing this
backend to the internet for a wall panel that never leaves the LAN. And it has
no catalog search namespace, which is one of the four things you asked for.

**The local UPnP/SOAP API is the answer.** It is what Home Assistant's Sonos
integration, SoCo, node-sonos-http-api and sonos2mqtt all use. It is on port
1400 of every speaker, it needs no credentials on the LAN, and it pushes state
changes over GENA — which maps onto this app's existing "nothing polls" design
without compromise.

**Music Assistant is being removed by your decision**, so it appears in the
table only to record what it was doing well; §3 accounts for what goes with it.

---

## 3. What removing Music Assistant costs

Three things go away. Two are replaceable, one is not, and pretending
otherwise is how a plan gets found out on a wall six weeks later.

**Recently played is gone and has no Sonos equivalent.** Sonos exposes no play
history — not locally, not in the cloud API. The `Recent` tab is currently
`music/recently_played_items`, a real history including things you streamed and
do not own. *Mitigation:* the backend records what it itself enqueues to a
small JSON file beside `dashboard.yaml`, the same place `panel-prefs.json` and
`tv-keys.json` already live. That gives "recently played **from this panel**",
which is honestly a narrower thing, and the tab should be labelled to match.
Anything played from the Sonos app will not appear. This is a real regression;
it is small, and it is the price of the ask.

**Cross-provider unified search is gone.** Music Assistant searches every
provider at once and returns one merged list. Sonos searches per-service. The
Browse sheet's search tab becomes *per-source* — Library, Spotify, Sonos Radio
— rather than one box over everything. §8 covers the shape.

**Anything Sonos cannot play is gone.** That is the honest framing of "Sonos
only": the set of playable things shrinks to what your household has linked.
Since the ask is explicitly *"anything I have access to in Sonos today"*, this
is a definition rather than a loss.

Not lost, and worth saying: **grouping gets better.** Music Assistant's
`can_group_with` was already an improvement on Home Assistant's feature
bitmask. Sonos's own topology is better still — any zone can group with any
other, group membership arrives as a push, and stereo pairs and bonded
surrounds are described exactly rather than inferred.

---

## 4. Architecture

`server/src/mass/` is deleted. `server/src/sonos/` takes its place, with the
same shape and the same contract to the hub.

```
navigator-panel (Node 22)
  │
  ├── ha/       Home Assistant     — the house. Unchanged.
  ├── immich/   photos             — unchanged.
  ├── controls/ Companion, lights  — unchanged.
  │
  └── sonos/    THE MUSIC          — new
        discovery.ts   SSDP + seed host → one reachable player
        topology.ts    ZoneGroupTopology → the household model
        soap.ts        SOAP envelope, POST :1400, parse
        xml.ts         DIDL-Lite + LastChange decoding
        events.ts      GENA subscribe / renew / unsubscribe
        didl.ts        DIDL-Lite: one track, and browse lists
        store.ts       players + queues, debounced
        commands.ts    the guard: verbs in, SOAP out
        browse.ts      favourites, playlists, library, radio, queue, search
        spotify.ts     catalog search + x-sonos-spotify URI construction
        uris.ts        opaque key → playable URI + DIDL
```

Every file in that list has a counterpart in `mass/` that already works,
already has tests, and already has the failure modes documented. This is a
port, and it should read like one.

**One connection per household, not per speaker.** SOAP control is stateless
HTTP; only the GENA subscriptions are long-lived, and those are one small
registry, not a socket per speaker.

---

## 5. Discovery and the household

### Finding the system

Two mechanisms, and the order matters more than it looks.

1. **`SONOS_HOST` — one speaker's IP, from config.** From any single player,
   `ZoneGroupTopology.GetZoneGroupState` returns *the entire household*: every
   zone, its UUID, its IP, its group, its coordinator. One known address is
   enough, forever.
2. **SSDP as a convenience.** `M-SEARCH` to `239.255.255.250:1900` with
   `ST: urn:schemas-upnp-org:device:ZonePlayer:1`, over `node:dgram`. No
   dependency.

**Recommendation: make `SONOS_HOST` the documented path and SSDP the fallback,
not the other way round.** This backend runs in a container. On Docker's
default bridge network multicast does not cross to the LAN, so SSDP finds
nothing and the failure is a silent empty screen. A static IP always works and
is one line in `.env`. Discovery that "usually works" is worse than
configuration that always does, on a device nobody can open DevTools on.

### The household model

`GetZoneGroupState` returns XML describing every group:

```xml
<ZoneGroups>
  <ZoneGroup Coordinator="RINCON_A1..." ID="RINCON_A1...:12">
    <ZoneGroupMember UUID="RINCON_A1..." ZoneName="Living Room"
                     Location="http://192.168.1.51:1400/xml/device_description.xml"
                     Invisible="0" ChannelMapSet="..."/>
    <ZoneGroupMember UUID="RINCON_B2..." ZoneName="Kitchen" .../>
  </ZoneGroup>
</ZoneGroups>
```

Mapping onto the existing protocol:

| Protocol field | From Sonos |
|---|---|
| `id` | `UUID` (`RINCON_…`) |
| `name` | `ZoneName` |
| `members` | every `ZoneGroupMember` in the same `ZoneGroup` |
| `syncedTo` | the group's `Coordinator`, when it is not this player |
| `canGroupWith` | every other *visible* zone — Sonos groups anything with anything |
| `type` | `stereo_pair` when `ChannelMapSet` names two channels, else `player` |
| `volume` | `RenderingControl.GetVolume`, already 0–100 — **no conversion** |
| `powered` | `null`. Sonos has no power concept, and the panel already draws no power button when this is null |
| `queueId` | the coordinator's UUID; Sonos has one queue per group |

**`Invisible="1"` members must be filtered out.** Bonded surrounds, subwoofers
and the right channel of a stereo pair are all real `ZoneGroupMember`s that
must never appear as speakers. This is the direct equivalent of
`mass/store.ts`'s `HIDDEN_TYPES`, and skipping it puts "Living Room (R)" and
"Sub" in the player picker.

### Coordinator versus member — the bug to design out

This is the single most common Sonos integration error and it deserves to be a
rule rather than a comment:

> **Transport commands go to the group's coordinator. Volume and mute go to the
> individual player. Group volume goes to the coordinator.**

`Play` sent to a grouped follower does nothing, silently. `SetVolume` sent to
the coordinator changes one speaker, not the group. `store.ts` therefore
resolves the coordinator for every transport command, and `commands.ts` refuses
to send a transport action to a non-coordinator rather than letting it no-op.

---

## 6. Events: GENA, and the problem it creates

This app does not poll. Key lights are the one documented exception and the
rationale for that exception is three paragraphs long
([`ARCHITECTURE.md`](./ARCHITECTURE.md) §6). Sonos pushes, so it should push.

### Subscribing

```
SUBSCRIBE /MediaRenderer/AVTransport/Event HTTP/1.1
Host: 192.168.1.51:1400
CALLBACK: <http://192.168.1.20:8099/sonos/event/<boot-secret>>
NT: upnp:event
TIMEOUT: Second-3600
```

The reply carries a `SID`. Renew with `SUBSCRIBE` + `SID` at **half** the
granted timeout, and `UNSUBSCRIBE` + `SID` on shutdown.

**Unsubscribing on shutdown is not optional.** Home Assistant has a filed bug
where subscriptions outlive the thing that made them and speakers keep POSTing
to a dead endpoint. A container that restarts a few times a day accumulates
those. Tear-down goes in the existing `shutdown()` path in `server/src/index.ts`
next to `massClient.stop()`.

### What to subscribe to

| Service | Per | Carries |
|---|---|---|
| `/ZoneGroupTopology/Event` | **one player only** | the whole household topology; grouping changes |
| `/MediaRenderer/AVTransport/Event` | coordinator | transport state, current track, `LastChange` |
| `/MediaRenderer/RenderingControl/Event` | every player | volume, mute, `LastChange` |
| `/MediaRenderer/GroupRenderingControl/Event` | coordinator | group volume |
| `/MediaServer/ContentDirectory/Event` | one player | `FavoritesUpdateID`, `SystemUpdateID` — invalidate browse caches |
| `/Queue/Event` | coordinator | queue changed — refresh the Queue sheet |

### The doubly-encoded XML trap

`AVTransport` and `RenderingControl` events do not send fields. They send a
`LastChange` property whose value is **XML-escaped XML**, and inside that, the
track metadata is **DIDL-Lite, escaped again**. Three levels. A parser that
unescapes once produces plausible-looking garbage rather than an error, which
is the exact failure profile this repo has a mock server for.

`xml.ts` handles it in one place, and `mock-sonos.mjs` sends a real
triple-escaped event containing a track called `Rock & Roll <Live>` so the
test fails loudly if anyone simplifies it.

### The callback address problem

The speaker POSTs to a URL we give it, so that URL must be an address the
speaker can reach. `0.0.0.0` is not one.

**Derive it from the socket.** After the first successful SOAP call to a
speaker, `socket.localAddress` is by definition an address that reached it —
correct on multi-homed hosts, correct on VLANs, no guessing. Provide
`SONOS_CALLBACK_HOST` as an override for the cases below.

**Docker networking is a genuine constraint, and it is new.** Every other
upstream in this app is outbound-only. Sonos is the first that must connect
*in*. On a bridge network the container's address is unreachable from the LAN,
so events silently never arrive and the panel looks frozen while commands still
work — a confusing failure worth failing loudly on instead.

| Deployment | Works? |
|---|---|
| `network_mode: host` | ✅ recommended; SSDP works too |
| bridge + published port + `SONOS_CALLBACK_HOST=<docker host IP>` | ✅ events reach the host and are forwarded |
| bridge, no override | ❌ **silent** — no events, stale UI |

Mitigation: after subscribing, the backend expects Sonos's initial event within
a few seconds (GENA sends current state immediately on subscribe). If nothing
arrives, log a specific, actionable error and surface it on the Settings screen
as `sonosError` — the same treatment `massError` gets today for a rejected
token. `unraid/navigator-panel.xml` and `docker-compose.yml` both need updating.

### The unauthenticated inbound route

`NOTIFY` requests carry no bearer token and cannot be made to. The route is
therefore unauthenticated by necessity, which needs three compensating checks:

1. **A per-boot secret in the path.** `/sonos/event/<random>` minted at
   startup, never persisted, never sent to the panel.
2. **Source IP must be a known household member**, from the topology we already
   hold.
3. **`SID` must match a subscription we created.** An unknown SID is dropped.

Note also that `server/src/index.ts:351` currently rejects every method that is
not GET or HEAD. The `NOTIFY` branch goes **above** that check, and nothing
else about the method policy changes.

---

## 7. Commands: the guard

`mass/commands.ts` allow-lists Music Assistant command names because Music
Assistant's API is administrative. Sonos's local API is *worse*: the same port
that pauses a track can rename rooms (`DeviceProperties.SetZoneAttributes`),
rewrite alarms (`AlarmClock`), and write account credentials
(`SystemProperties.SetAccountX`).

So the guard gets stricter, and the change is structural rather than a longer
list:

> **The panel names a verb, never a SOAP action.**

```ts
type MusicCommand =
  | { verb: 'play' | 'pause' | 'stop' | 'next' | 'previous'; player: string }
  | { verb: 'seek'; player: string; seconds: number }
  | { verb: 'volume'; player: string; level: number }      // 0–100
  | { verb: 'mute'; player: string; muted: boolean }
  | { verb: 'groupVolume'; player: string; level: number }
  | { verb: 'group'; leader: string; members: string[] }
  | { verb: 'ungroup'; player: string }
  | { verb: 'shuffle' | 'repeat'; player: string; mode: string }
  | { verb: 'playItem'; player: string; item: string; how: Enqueue }
  | { verb: 'queueJump' | 'queueRemove' | 'queueMove' | 'queueClear'; … };
```

That is a closed set of about eighteen verbs. There is no string a compromised
panel can send that becomes a SOAP action we did not write, which is a stronger
property than the allow-list it replaces — and it is exactly the same reasoning
as `controls.pages`, where the panel sends `deskpro.hangup` rather than a URL
([`README.md`](../README.md) §Controls).

Every `player` is checked against the topology, as `MassCommands` checks
`store.hasPlayer`. Grouping is `SetAVTransportURI` with `x-rincon:<coordinator
UUID>` on each joiner; ungrouping is `BecomeCoordinatorOfStandaloneGroup`.

---

## 8. Browsing and search

Four sources. Three are free; one is the project.

### Free, day one, no authentication

| Source | How | Notes |
|---|---|---|
| **Sonos favourites** | `ContentDirectory.Browse(ObjectID='FV:2')` | The highest-value tab. Each item carries both its URI and the `r:resMD` metadata needed to play it — including Spotify and Sonos Radio items, with no service auth |
| **Sonos playlists** | `Browse(ObjectID='SQ:')` | |
| **Local library** | `Browse('A:ALBUM' \| 'A:ARTIST' \| 'A:TRACKS' \| 'A:GENRE')`, and `ContentDirectory.Search` for text | Your NAS share as indexed by Sonos |
| **Radio favourites** | `Browse('R:0/0')` | Saved stations |
| **The queue** | `Browse('Q:0')`, paged | Maps directly onto the existing `QueuePage` |

All of these return DIDL-Lite, all page with `StartingIndex`/`RequestedCount`
(so `BROWSE_PAGE = 60` is unchanged), and all report `TotalMatches` — which is
actually **better** than the Music Assistant path, where `more` had to be
guessed from whether a full page came back (`mass/browse.ts:136`).

**Favourites do most of the work.** Anything you have favourited in the Sonos
app — a Spotify playlist, a Sonos Radio station, an album — plays from `FV:2`
with no auth and no search. It is worth shipping this alone before touching
SMAPI, because for a wall panel it may turn out to be most of what you reach
for.

### Spotify search — the recommendation

There are two ways to search Spotify, and they differ by about three weeks.

**A. SMAPI device-link.** The proper route: `MusicServices.ListAvailableServices`
gives each service's SMAPI SOAP endpoint and its authentication policy
(`Anonymous` / `UserId` / `DeviceLink` / `AppLink`). For Spotify this is
`AppLink`/`DeviceLink`, meaning a third-party controller must run its own
handshake — `getAppLink` → **the user approves at a URL** → `getDeviceAuthToken`
→ store the token. Then `search` and `getMetadata` work against Spotify's whole
catalog, and the same machinery serves Sonos Radio and every other linked
service.

The catch is the approval step. It needs a browser, and RoomOS gives us one tab
that cannot open another ([`ROOMOS.md`](./ROOMOS.md) §8). So the link has to be
completed **off-panel** — printed in the container log and shown on the
Settings screen for you to open on a phone — once, with the token persisted
beside `dashboard.yaml`. That is workable but it is a real sub-project.

**B. Spotify Web API for search, Sonos for playback.** Search
`api.spotify.com/v1/search` with a **client-credentials** token (a free Spotify
developer app; server-to-server, no user OAuth, no redirect). Then play the
result by constructing the URI Sonos already uses:

```
x-sonos-spotify:spotify%3atrack%3a<id>?sid=<sid>&flags=8224&sn=<sn>
```

with matching DIDL-Lite carrying the
`<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">`
service descriptor. **Playback still uses your household's own linked Spotify
account** — the `sid` and `sn` come from Sonos, not from us. Only *search*
touches Spotify's API. This is what node-sonos-http-api does and it is
well-trodden.

`sid`/`sn` discovery without decrypting anything: `MusicServices.ListAvailableServices`
gives the `sid`; the account serial `sn` is lifted from any existing Spotify
URI in your favourites or queue, then cached. `SONOS_SPOTIFY_SN` overrides it
if the household has an unusual account layout.

> **Recommendation: build B, and treat A as the phase after it.**
>
> B gets working Spotify search in a fraction of the time, needs no user
> approval flow, and its playback path — a constructed URI plus DIDL — is
> *the same code SMAPI results will need anyway*. Nothing is thrown away. If
> you later want Sonos Radio search, or you object to holding Spotify
> credentials, A drops in behind the same `browse.ts` interface.
>
> The one honest downside: B needs a Spotify client id and secret in `.env`.
> They are free, they are scoped to public catalog search, and they grant no
> access to your account.

### Sonos Radio

Sonos Radio stations you have **favourited** work day one via `FV:2` with no
auth. *Searching* Sonos Radio's catalog is SMAPI, so it lands with phase A.
Given the ask, that ordering should be explicit rather than discovered.

### The search tab

Music Assistant returned one merged list. Sonos cannot, so the search tab gains
a source selector — `Library · Spotify` — which is two taps rather than one and
is the honest shape of the underlying system. `BrowseRequest` gains one field:

```ts
| { kind: 'search'; text: string; source: 'library' | 'spotify' | 'radio' }
```

`BrowseGroups` already groups results by section, so the panel renders this
with no structural change.

---

## 9. The URI registry

Sonos will play whatever URI you hand it, including
`x-rincon-mp3radio://<anything>`. That is the same hole `mass/commands.ts`
closes by requiring a library URI with a non-network scheme — except that
Sonos's playable URIs *are* network URIs, so that defence does not port.

The answer is already in this codebase. `http/media-art.ts` solves the
identical problem for artwork: the panel never names a URL, it names an
**opaque key the backend minted** from a URL an upstream produced. Generalise
it.

```
browse result  →  uris.register(uri, didl)  →  MediaItem.u = "a3f9c1d2e8b40571"
panel plays    →  { verb: 'playItem', item: "a3f9c1d2e8b40571" }
backend        →  looks up the URI *and its DIDL metadata*, sends SOAP
```

The registry is bounded and FIFO-evicted, exactly like `MediaArt` — 4000
entries, a lookup table for what is on screen rather than a cache. There is no
request the panel can compose that makes a speaker fetch a host of its
choosing, and the DIDL metadata rides along, which the panel should never have
had to carry anyway.

Artwork needs no new mechanism at all: DIDL's `upnp:albumArtURI` is a relative
path on the coordinator, so absolute-ise it to `http://<coordinator>:1400<path>`
and hand it to the existing `MediaArt.register()`. The panel keeps receiving
`/img/art?k=…` and nothing about `Artwork.tsx` changes.

---

## 10. XML: the one new dependency

The server has two runtime dependencies (`ws`, `yaml`) and
[`ARCHITECTURE.md`](./ARCHITECTURE.md) §3 says that if it grew a database
"something went wrong". So adding a third needs an argument.

Sonos is XML throughout: SOAP responses, `ZoneGroupState`, DIDL-Lite, and
`LastChange`'s triple-escaped payload. The shapes are fixed and
machine-generated, so a ~200-line tag scanner would work — until an album is
called `Rock & Roll`, or a playlist has a quote in it, and entity decoding is
subtly wrong. That failure is silent, cosmetic-looking, and on a wall.

**Recommendation: add `fast-xml-parser`.** Zero dependencies of its own, widely
used, and it makes entity handling correct by construction rather than by
review. Three runtime deps for a music system is proportionate.

If you would rather hold the line at two, the hand-rolled path is viable and
the containment is good — everything lives in `sonos/xml.ts` behind one
interface, and the mock server's escaped-entity fixtures are the same tests
either way. It is a reversible decision, which is why it does not need to be
settled before phase 1.

---

## 11. Panel changes

Small, and mostly mechanical.

| File | Change |
|---|---|
| `shared/protocol.ts` | `MassPlayer`→`Player`, `MassQueue`→`PlayerQueue`, `MassMedia`→`NowPlaying`; `health.mass`→`health.sonos`; `ClientMessage` `t:'mass'` → `t:'music'` carrying a verb; `BrowseRequest.search` gains `source` |
| `panel/src/state/actions.ts` | the `mass()` helper becomes `music()`; 27 command strings become verbs. Optimistic writes, throttling and `DRAG_INTERVAL_MS` all unchanged |
| `panel/src/state/players.ts`, `selectors.ts` | type renames only |
| `panel/src/net/socket.ts` | `massCommand()`→`musicCommand()` |
| `panel/src/screens/Media.tsx` | `NoPlayers` copy: `SONOS_HOST` instead of `MASS_URL`, and a specific message for "events are not arriving" |
| `panel/src/screens/Settings.tsx` | Sonos household + link status |
| `panel/src/components/Browse.tsx` | tab list changes; search gains a source selector |
| everything else | **untouched** |

Bundle budget is unaffected — the JS shell is 37.8 KB against a 50 KB ceiling
and this adds no runtime, only different strings.

---

## 12. Configuration

```bash
# ─── Sonos ─────────────────────────────────────────────────────────────────
# One speaker's IP. From any single player the backend learns the entire
# household, so this never needs to be more than one address — and a static
# address always works where SSDP multicast does not cross a Docker bridge.
SONOS_HOST=192.168.1.51

# Address the speakers should POST events back to. Derived from the socket
# that reached the first speaker; set this only when that is wrong — a bridge
# network, or a host with several interfaces.
SONOS_CALLBACK_HOST=

# Spotify catalog SEARCH only. Playback uses your household's own linked
# Spotify account; these credentials never touch it. Free, from
# developer.spotify.com — client-credentials flow, no user login, no redirect.
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
```

`MASS_URL`, `MASS_TOKEN` and `MASS_INSECURE_TLS` are removed from
`.env.example`, `env.ts`, `docker-compose.yml`, `Dockerfile` and
`unraid/navigator-panel.xml`.

`config/dashboard.yaml` needs **no change**. `media.players` is already only a
rename map, `media.sections` is already just headings, and `media.default:
active` works identically — Sonos zone names go straight in where Music
Assistant player names were. Existing configs keep working, which is the point
of having kept identity out of the YAML.

**Prerequisite, and the first thing to check when nothing works:** UPnP must be
enabled in the Sonos app under *Settings → App Preferences → Privacy → UPnP*
(wording varies by app version). Sonos ships it on, but it is a toggle, and
turning it off makes every local integration — this one, Home Assistant's,
SoCo's — stop dead.

---

## 13. Testing

`server/test/mock-sonos.mjs`, mirroring `mock-mass.mjs`: an HTTP server that
speaks the parts of the real protocol that fail *silently* rather than loudly.

- **Triple-escaped `LastChange`** containing `Rock & Roll <Live>` — a parser
  that unescapes once passes a naive test and mangles this one.
- **DIDL-Lite with entities** in titles, artists and album art paths.
- **GENA**: accepts `SUBSCRIBE`, returns a `SID`, POSTs the initial event
  immediately, and asserts that `UNSUBSCRIBE` arrives on shutdown.
- **`Invisible="1"` members** — a bonded sub and a stereo-pair right channel
  that must not appear as speakers.
- **Coordinator routing** — asserts `Play` went to the coordinator and
  `SetVolume` went to the individual player.
- **Paging** with a `TotalMatches` larger than one page.

`server/test/mass.test.mjs` becomes `sonos.test.mjs` and keeps its structure: a
real backend process, a mock upstream, and a WebSocket client standing in for
the panel. Home Assistant stays unconfigured throughout, so the suite proves
music works entirely without it — exactly as it does today.

---

## 14. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| UPnP disabled in the Sonos app | **fatal, invisible** | Detect at startup, name it precisely in the log and on Settings |
| Docker bridge networking eats GENA callbacks | **high, silent** | Expect the initial event; fail loudly; document `network_mode: host` |
| Sonos restricts local control in a future firmware | medium | The `shared/protocol.ts` boundary is source-agnostic — this project is itself the proof, having already swapped HA → MA → Sonos behind it |
| SMAPI device-link is more work than estimated | medium | Phase it last; Spotify Web API search (§8 B) delivers the capability first and shares the playback path |
| S1 vs S2 differences | low | S1 speaks the same UPnP surface; `ContentDirectory` object IDs differ slightly. Not designed for until you say S1 is in scope |
| Losing "Recently played" | low, certain | Backend-recorded history of what this panel played; labelled honestly |

---

## 15. Phases

Same rule as the rest of this repo: each phase ends with something that runs on
the device, and no phase starts before the last is verified there.

| # | Phase | Delivers | Done when |
|---|---|---|---|
| **1** ✅ | Topology | `discovery.ts`, `soap.ts`, `xml.ts`, `didl.ts`, `topology.ts`, `client.ts`, `store.ts`. Players in `hello`, read-only | The Media screen lists your real zones with correct names, groups and volumes. Bonded subs and pair channels do not appear |
| **2** | Events | `events.ts`: subscribe, renew, unsubscribe, `NOTIFY` route with all three guards | Change volume in the Sonos app → panel moves within ~200 ms. Restart the container → no orphaned subscriptions. Kill the network → the link goes degraded, not stale |
| **3** | Control | `commands.ts` verbs, coordinator routing, grouping, `uris.ts` | Transport, volume, mute, seek and grouping all work from the panel. A transport command aimed at a follower is refused, not silently dropped |
| **4** ✅ | Browse | `browse.ts`, `uris.ts`: `FV:2`, `SQ:`, `Q:0`, `A:*`, `R:0/0`, library search, queue editing | Every existing Browse and Queue interaction works against Sonos with no panel changes beyond the tab list |
| **5** ✅ | Spotify search | Spotify Web API search + `x-sonos-spotify` URI construction + DIDL | Searching an artist on the panel plays them on a Sonos speaker through your own linked account |
| **6** ✅ | Cut over | Deleted `server/src/mass/`, renamed `Mass*` types, stripped `MASS_*` from env, compose and the Unraid template | `npm test` green, bundle under budget, no reference to Music Assistant remains |
| **7** | SMAPI *(optional)* | `smapi.ts`, device-link with off-panel approval, Sonos Radio search | Sonos Radio and any other linked service are searchable |
| **8** | History *(optional)* | Backend-recorded play history | The Recent tab shows what this panel played |

Phases 1–3 are the system. Phase 4 is where it becomes better than what it
replaced. Phase 6 is the point of no return and deliberately comes after
everything is proven, so the two can run side by side while you are still
deciding whether you like it.

### What phase 1 actually built

Five decisions differ from what is written above, and each is worth recording
rather than leaving to be rediscovered:

**The XML parser is hand-rolled, not `fast-xml-parser`.** §10 recommended the
dependency and said the choice was reversible because it lives behind one
interface. Building it showed the interface is four functions and the risky
part is entity decoding alone — ten lines, and now covered by direct tests for
the cases that fail silently, including `&amp;lt;` decoding to `&lt;` rather
than `<`. So the server still has two runtime dependencies and the decision
stays open: swapping in a library means reimplementing `sonos/xml.ts` and
nothing else.

**Sonos players appear beside Music Assistant's, in the same list.** Ids cannot
collide — Sonos uses `RINCON_…` UUIDs — so a household reachable through both
is listed twice rather than ambiguously, and `env.ts` warns at boot when both
are configured. Phase 6 deletes the Music Assistant half.

**There is one timer, and it is a poll.** Phase 1 has no event subscriptions,
so a volume changed in the Sonos app is only noticed by asking. It polls every
five seconds, **only while a panel is connected** — the same gate the key-light
poll uses, for the same reason. Phase 2 deletes it. The client deliberately
holds no timer of its own: `refresh()` is both the liveness check and the way
state is read, so one cadence lives in one place instead of a retry loop racing
a poll.

**`canGroupWith` is empty on purpose.** Sonos can group any zone with any
other, so populating it is a one-liner — and it would immediately put a
"Playing on" bar on the Media screen whose button sends a command nothing yet
handles. A control that is drawn but inert is worse than one that is absent, so
grouping appears when phase 3 can honour it. A test asserts this rather than
leaving it to a comment.

**A speaker's address carries its port.** `Location` in the topology is a full
URL, so the port travels with the host instead of 1400 being assumed. On real
hardware it is always 1400 and this is a no-op; it is what lets the test suite
run a household of five mock speakers on five ordinary ports, which is in turn
what catches a store that reads one speaker and reports it for all of them.

**Still inert in phase 1:** the transport buttons on a Sonos player. They send
commands the backend has no handler for and will report "Not permitted" — which
is honest, and fixed by phase 3.

### What phases 2 and 3 actually built

**The panel stopped sending command names.** `t: 'mass'` carried a Music
Assistant command string straight through; it is now `t: 'music'` carrying one
of twenty verbs, and the backend routes by player id. Two consequences, and the
second was not in the plan:

- The panel no longer knows which music system owns a speaker, which is what
  lets both run at once and makes phase 6 a deletion.
- **The guard got stronger.** With a command name on the wire the safety
  property is "the allow-list is complete" — something that can be overlooked
  into being false. With a verb it is "no other action exists", which cannot.
  `mass/commands.ts` gains a `runVerb` translating back; that function is
  throwaway and dies with the file in phase 6.

**Transport is routed to the coordinator, not refused.** Phase 3's acceptance
criterion said a transport command aimed at a follower should be *refused*.
Routing is the better answer: the panel legitimately shows a follower, and its
buttons should work rather than explain themselves. The failure being designed
out — `Play` on a grouped follower is accepted by Sonos and silently does
nothing — is avoided either way, and a test asserts the command physically
arrived at the coordinator's address.

**The reconcile timer is not the poll wearing a hat.** Phase 1's five-second
poll is gone. What remains is a five-minute reconciliation, gated on a panel
being connected, and it exists for one case renewal does not cover: a single
dropped `NOTIFY` leaves one value wrong with nothing to correct it. If it is
ever doing real work, events are not arriving and something is misconfigured.

**Subscriptions are shaped by the topology, not the speaker list.** Volume is
per speaker so every zone gets a `RenderingControl` subscription; transport is
per group so only coordinators get `AVTransport`. Grouping a speaker elsewhere
drops its transport subscription — properly, with `UNSUBSCRIBE`, rather than
letting it lapse.

**The inbound route landed as designed**, with all three guards: a per-boot
secret in the path, a source address that must be a household member, and a SID
that must name a subscription this process created. It is matched *before* the
method check, so an unknown path gets the same 405 as any other non-GET rather
than revealing that a NOTIFY route exists.

**Still absent after phase 3:** anything that starts new music. That arrived
with phase 4.

### What phases 4, 5 and 6 built

**Events became a preference, not an assumption.** Reported from a real
household: every speaker visible, volume and play/pause lagging or never
updating. Subscriptions were being accepted while nothing came back —
`SUBSCRIBE` is outbound and succeeds, `NOTIFY` is inbound and on a Docker
bridge network never arrives. The store now polls every five seconds while
events are absent, retries subscribing every minute, and recovers to push on
its own. `Settings → Sonos updates` says which mode is live, because the
symptom is otherwise impossible to attribute.

**The URI registry generalised the artwork one.** Sonos plays whatever URI it
is handed, so the panel is handed none: a browse registers each URI plus the
`r:resMD` that goes with it and returns an opaque key. That closes the hole the
Music Assistant guard closed differently — it required a library URI with a
non-network scheme, which does not port, because Sonos's playable URIs *are*
network URIs.

**Streams and tracks are two playback paths.** A radio favourite goes through
`SetAVTransportURI`; a track goes through `AddURIToQueue` and then needs the
player pointed at `x-rincon-queue:<uuid>#0`, without which a speaker on a radio
station stays on it while the album sits in a queue nothing is reading.
`r:resMD` is not optional either: play a favourite without it and the speaker
accepts the command and plays silence.

**"Recently played" is gone, as predicted in §3.** No Sonos equivalent exists,
and synthesising one from what this panel happened to start would be a narrower
thing wearing the same label. The Favorites tab took its place at the front.

**Spotify search took the Web API route** (§8 option B). The `sid` and `sn` in
a Sonos Spotify URI belong to the household, so they are learned from it — any
existing Spotify favourite is a URI Sonos itself built, carrying the right
values — with `ListAvailableServices` as the fallback.

**One thing found by CI rather than by review:** `parseDidlList` collected all
items and then all containers, which silently re-sorted every mixed result.
Favorites holds playlists, stations and albums interleaved in the order
somebody chose in the Sonos app, and that order is the whole value of the list.
It walks in document order now.

### What phases 7 and 8 built

**A favourite that would not play, and the reason the tests missed it.**
Reported from the real household: `Play … failed (UPnP 701)`. 701 is
"transition not available", and the transition it could not make was into an
empty queue. A favourited playlist is a *container* — the speaker resolves it
for itself — and it was going down the path built for single tracks:
`AddURIToQueue`, point the transport at `x-rincon-queue:`, `Play`. The service
answered that enqueue with **200 OK and `NumTracksAdded: 0`**, a refusal
wearing a success, so the transport was aimed at nothing.

Underneath was a smaller mistake with a wide blast radius. Every row in `FV:2`
carries `object.itemobject.item.sonos-favorite` — the class of *being* a
favourite, which says nothing about the content. What the row points at is
stated one level down, inside `r:resMD`. Reading the outer class made every
favourite look like a track.

Playback is now classified into **three** styles rather than two:

| Style | Play now | Add to queue |
|---|---|---|
| `stream` | `SetAVTransportURI` | impossible |
| `container` | `SetAVTransportURI` | `AddURIToQueue` |
| `track` | `AddURIToQueue`, then point at the queue | `AddURIToQueue` |

Only the last was ever right for the others. §8's "two paths" was wrong, and
the mock's fixtures were what hid it: they carried the inner class on the outer
row, which is tidier than reality and made a favourite that could not play in a
real household play perfectly in CI. The fixtures now say what a speaker says.

**Music services arrived (SMAPI).** Favourites carry everything needed to play
anything from any service with no login on this side — but they cannot be
searched, and they cannot answer "what else does this artist have". Three
layers: `services.ts` learns which services the household *has*
(`ListAvailableServices` for the catalog of hundreds, `/status/accounts` for
the handful somebody actually added, favourite URIs to confirm the account
number); `smapi.ts` speaks the protocol; `music.ts` owns the tokens.

Connecting is a URL and a short code typed on a phone — Sonos's own
device-link flow, and the only one that can work here at all, because RoomOS
gives the panel a single tab and an OAuth redirect would navigate away from the
dashboard and never come back. This is §8's option A, which was deferred as
"needs a browser"; the device-link flow turns out not to.

All of it fails soft. A service that is down, a token that expired, a catalog
row in an unanticipated shape — each loses that service and nothing else.

**Two bugs found on the way.** Spotify albums and playlists were being built as
`x-sonos-spotify:` *track* URIs; they are containers and need
`x-rincon-cpcontainer:` with Sonos's type prefix — the same mistake as the 701.
And `#learnFromServices` stringified a parsed XML node to JSON and searched for
`"Name": "Spotify"` followed by `"Id"`, a pattern that cannot occur in the XML
or in its JSON form in either order, so that fallback had never once returned
an account.

**The rest of the Sonos app.** Sleep timer, bass, treble, loudness, crossfade,
group volume and the physical inputs, behind one more tap on the Media screen
because each is real but occasional.

Two distinctions are load-bearing. Tone is **per speaker** — it describes the
room the speaker stands in, and two grouped speakers in different rooms want
different bass and the same music. Group volume is **per group**, and goes to
`GroupRenderingControl` rather than to each member in turn: Sonos scales the
members proportionally, so a speaker somebody deliberately turned down stays
quieter, which setting each one to the same number would destroy.

The `input` verb is the one command routed to the speaker the panel *named*
rather than to its coordinator: a TV socket is on one box, and routing it to
the group leader would select the wrong speaker's input. Inputs are offered to
every speaker rather than only to the ones that have them — the speaker's own
refusal is both accurate and permanently up to date, where a table of models
would be wrong the day after the next one ships.

An empty `NewSleepTimerDuration` cancels a timer; `0:00:00` is what an obvious
implementation sends and what a real speaker rejects. And the sleep-timer read
is tolerated separately from the other four in `#readGroup`, because
`Promise.all` rejects as a unit and an older speaker that does not implement it
would otherwise lose its transport state, its track and its queue — a blank
Media screen because of a timer nobody set.

### What the first real use changed

Reported after living with it: four tabs empty, search finding nothing, and
Services showing "a ton of lists I can't make sense of".

**The tab strip was asserting what a household has.** Favorites, Playlists,
Albums, Artists, Radio — five fixed tabs, and in a house with no NAS share and
nothing saved in the Sonos app, four of them were correctly and permanently
blank. There is now **one Browse tab** that opens on the household's own list
of sources, each with a real count, and an empty source is left out rather than
offered as a row leading nowhere. It is how the Sonos app's Browse screen
works, and it turns "which of these six tabs has anything in it" into a list
you can read.

**`ListAvailableServices` is the catalog, not the household.** It returns every
service Sonos supports in the region — hundreds — and the filter let all the
`Anonymous` ones through, so the Services list became every podcast aggregator
Sonos has ever heard of. The bar is now an ACCOUNT: `/status/accounts`, plus
the `sid`/`sn` pairs found inside the household's own favourites, which is the
source that keeps working on firmware that does not serve the status page.

**An empty list now says why.** A container this household does not have
answers with a UPnP fault rather than an empty list — `R:0/0` on a house that
never used TuneIn — and that fault was being flattened into "Sonos could not
answer that". The speaker *answered*; that is a fact about the household, not a
failure. It now becomes the same empty list, with the same explanation, as a
container that exists and holds nothing. A transport failure still throws,
because "could not answer" is the right thing to say when nothing did.

Search defaults to a connected service rather than the library, for the same
reason: searching an empty shelf reads as a broken search.

### Discovery, and the three things it could not see

Three reports from the household, each a different hole in reading a household
from the outside.

**`&amp;` survives one decode.** Sonos escapes a URI's own `&` writing the
DIDL, then escapes the DIDL again putting it in `<Result>`, so one decode
leaves `?sid=200&amp;flags=8300&amp;sn=4`. A scanner wanting a literal `&`
matched nothing, anywhere, and the household appeared to have no services at
all. Third bug in this integration from Sonos's layered escaping, and the first
two were caught because `xml.ts` exists for exactly this — these scanners
bypassed it with a regex. No fixture carried a query string, so the mock's
correct double-escaping had nothing to escape.

**`sn` is optional.** A third-party service names the account it plays through;
Sonos's own do not, because there is no separate login — Sonos Radio and TuneIn
are `?sid=254&flags=32` with no `sn`. Insisting on the pair lost every one of
them. An absent `sn` now means account 0, which is Sonos's own value for it,
and saved stations (`R:0/0`) are scanned as well as favourites, because that is
where a station somebody listens to daily but never favourited appears.

**Some services leave no trace at all.** Detection reads accounts, favourites
and saved stations. A service set up in the Sonos app with none of those — and
on firmware that does not serve `/status/accounts` — is invisible, and was
therefore unreachable. `Add a service…` at the foot of Browse lists the whole
catalog: hundreds of rows nobody has to look at unless something they know they
have is missing, which is the shape that keeps the everyday screen readable.

**An explanation is not an affordance.** "Connect SoundCloud first" was shown on
a screen with nothing to press. A service that refuses now comes back as an
empty list carrying `connect: <sid>`, and the empty state draws the button. It
is typed rather than matched on the text of an error, because deciding to draw
a button by reading a message is the kind of thing that quietly stops working
when the wording changes.

That path also covers a service whose catalog entry claims `Anonymous` and then
demands a login anyway — SoundCloud does exactly this, and believing the
catalog is what produced the dead end.

**Spotify's Premium requirement is Spotify's.** Linking a third-party
controller needs Premium, and nothing here can waive it. The Web API path
(`SPOTIFY_CLIENT_ID`/`SECRET`) reads the public catalog with no user login and
no Premium requirement, and playback still runs through the household's own
linked account — so it remains the better option for Spotify specifically, and
the only one that works on a free account.

---

## Sources

- [Sonos local communication (SOAP, SSDP, services)](https://sonos.svrooij.io/sonos-communication) — Stephan van Rooij
- [Sonos SOAP service reference](https://sonos.svrooij.io/services/) · [AVTransport](https://sonos.svrooij.io/services/av-transport) · [ZoneGroupTopology](https://sonos.svrooij.io/services/zone-group-topology) · [ContentDirectory](https://sonos.svrooij.io/services/content-directory) · [MusicServices](https://sonos.svrooij.io/services/music-services)
- [sonos-api-docs](https://github.com/svrooij/sonos-api-docs) — generated from device service discovery
- [SoCo: Sonos UPnP Services and Functions](https://github.com/SoCo/SoCo/wiki/Sonos-UPnP-Services-and-Functions)
- [Sonos Control API: Subscribe](https://docs.sonos.com/docs/subscribe) · [Authorize](https://docs.sonos.com/docs/authorize) — the cloud path, and why it is unusable here
- [Sonos Music API (SMAPI)](https://docs.sonos.com/docs/smapi)
- [node-sonos-http-api](https://github.com/jishi/node-sonos-http-api) — [`lib/actions/spotify.js`](https://github.com/jishi/node-sonos-http-api/blob/master/lib/actions/spotify.js) for the `x-sonos-spotify` URI and DIDL shape
- [sonoscli: Spotify & SMAPI](https://sonoscli.sh/spotify-and-smapi.html) — device-link handshake
- [Home Assistant Sonos integration](https://www.home-assistant.io/integrations/sonos/) — the UPnP prerequisite
- [HA issue #168908](https://github.com/home-assistant/core/issues/168908) — subscriptions not torn down
- [Music Assistant: Sonos player support](https://www.music-assistant.io/player-support/sonos/) — what is being replaced
