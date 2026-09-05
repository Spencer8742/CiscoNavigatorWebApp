# Deployment

Three parts: run the backend, put it behind TLS, point the Navigator at it.

**On Unraid, skip to [§1a](#1a-unraid).**

---

## 1. Backend

### Docker Compose (from source)

```bash
git clone <your-fork> navigator-panel
cd navigator-panel

cp .env.example .env
cp config/dashboard.example.yaml config/dashboard.yaml

# Generate the panel token
openssl rand -hex 32
# → paste into PANEL_TOKEN in .env

# Then fill in HA_URL / HA_TOKEN and IMMICH_URL / IMMICH_API_KEY

docker compose up -d --build
docker compose logs -f
```

The container:

- serves the built panel and the API on `:8099`
- mounts `./config` at `/config`, and **seeds a documented `dashboard.yaml`
  there on first run** if the folder is empty. After that the backend only
  reads it; hot reload works through the mount
- restarts unless stopped, and is capped at 256 MB so a leak surfaces as a
  restart in `docker ps` rather than as host memory pressure
- **runs Node as uid 1000, not root.** The entrypoint starts as root only long
  enough to seed the config and fix ownership, then drops privileges via
  `su-exec`. Override with `PUID`/`PGID`; CI asserts the server process is not
  root
- rotates its own logs (3 × 10 MB)

Verify:

```bash
curl -s http://localhost:8099/api/health
# {"ok":true,"uptime":12,"panels":0}
```

### Getting the credentials

**Home Assistant token.** Create a *dedicated non-admin user* called `panel`
first — the token inherits that user's permissions, so a leak costs you one
revocable account rather than your own admin session. Log in as that user →
click the user name at the bottom of the sidebar → **Security** → **Long-lived
access tokens** → **Create token**. It is shown once.

**Immich API key.** Immich → **Account Settings** → **API Keys** → **New API
Key**. Grant **only** `asset.read` and `album.read`. No upload, no delete, no
admin — the panel only ever reads.

**Album IDs** come from the Immich album URL:
`https://immich.your.lan/albums/6f1c0b2e-…` → the UUID is the `id`.

**Immich version.** Developed against API 3.1.0 (Immich 1.133+). Older servers
work too: 1.133 renamed the archive filter from `isArchived` to `visibility`,
and since Immich rejects unknown properties outright rather than ignoring
them, the wrong one fails the whole query. The client detects that from the
400 and retries with the older field, so both eras work — but if you are on
1.132 or earlier, upgrading is the tidier fix.

To check a key and URL from the machine running the container, before
involving the panel at all:

```bash
# Should print a JSON array of assets. 401 = key problem;
# 400 naming a property = version mismatch; connection refused = URL problem.
curl -s -X POST "$IMMICH_URL/api/search/random" \
  -H "x-api-key: $IMMICH_API_KEY" -H 'content-type: application/json' \
  -d '{"size":1,"withExif":true,"visibility":"timeline"}'
```

### Updating

```bash
git pull
docker compose up -d --build
```

Connected panels see the socket close, reconnect within a second or two, and
receive a fresh snapshot. No user action, no visible interruption beyond a
brief amber connection dot.

### Docker Compose (published image, no build)

If you just want to run it:

```bash
docker compose -f docker-compose.prebuilt.yml up -d
```

This pulls `ghcr.io/spencer8742/cisconavigatorwebapp:latest`, published by
GitHub Actions on every push to `main`. Update with `pull` then `up -d`.

---

## 1a. Unraid

The image is published to GHCR **publicly**, so Unraid pulls it with no
credentials and no registry login.

### Why not a GitHub Action that deploys straight to Unraid?

Because the two ways to do it are both worse than this:

- **SSH from Actions** needs your Unraid box reachable from the internet (or a
  tunnel), plus root-level credentials for your NAS sitting in GitHub secrets.
- **A self-hosted runner on Unraid** gives any workflow in the repo arbitrary
  code execution on your server.

Push-to-registry, pull-from-Unraid gets the same "push code, it deploys"
outcome, with nothing inbound and no secrets that can reach your NAS. Adding a
`git push` → Unraid path later is easy if you already run Tailscale or
similar; ask and I'll wire it up.

### Install

**1. Generate a panel token** — on Unraid, *Terminal*:

```bash
openssl rand -hex 32
```

Keep it; you need it twice (container config, and the Navigator's URL).

**2. Install the template.** In Unraid's *Terminal*:

```bash
mkdir -p /boot/config/plugins/dockerMan/templates-user
wget -O /boot/config/plugins/dockerMan/templates-user/my-navigator-panel.xml \
  https://raw.githubusercontent.com/Spencer8742/CiscoNavigatorWebApp/main/unraid/navigator-panel.xml
```

> **The Template field on Add Container is a dropdown of already-installed
> templates, not a URL box.** There is no "paste a template URL" input in
> current Unraid — the file has to be on the flash drive first. This step is
> what puts it there.

**3. Add the container.** *Docker* tab → **Add Container** → choose
**navigator-panel** from the **Template** dropdown. Image, port, appdata path
and every environment variable are filled in with descriptions.

**4. Fill in four fields:**

| Field | Value |
|---|---|
| Panel Token | the token from step 1 |
| Home Assistant URL | `http://192.168.1.x:8123` (no trailing slash) |
| Home Assistant Token | a long-lived access token — see [Getting the credentials](#getting-the-credentials) |
| Immich URL / API Key | optional; leave blank to disable photos |
| Sonos Speaker IP | optional; **one** speaker's address — see [Sonos](#sonos) |

<details>
<summary><strong>No terminal access? Fill the form in by hand instead.</strong></summary>

*Docker* → **Add Container**, leave the Template dropdown alone, and set:

| Field | Value |
|---|---|
| Name | `navigator-panel` |
| Repository | `ghcr.io/spencer8742/cisconavigatorwebapp:latest` |
| Icon URL | `https://raw.githubusercontent.com/Spencer8742/CiscoNavigatorWebApp/main/panel/public/icon-192.png` |
| WebUI | `http://[IP]:[PORT:8099]/` |
| Extra Parameters | `--memory=256m` |
| Network Type | Bridge (the default) |

Then click **+ Add another Path, Port, Variable, Label or Device** once for
each row:

| Type | Name | Container path / key | Host path / value |
|---|---|---|---|
| Port | WebUI | `8099` | `8099`, TCP |
| Path | Config | `/config` | `/mnt/user/appdata/navigator-panel`, Read/Write |
| Variable | Panel Token | `PANEL_TOKEN` | your token from step 1 |
| Variable | HA URL | `HA_URL` | `http://192.168.1.x:8123` |
| Variable | HA Token | `HA_TOKEN` | your long-lived token |
| Variable | PUID | `PUID` | `99` |
| Variable | PGID | `PGID` | `100` |

`IMMICH_URL` and `IMMICH_API_KEY` are optional, as is `COMPANION_URL` — set
that one to your Bitfocus Companion (`http://192.168.1.x:8000`) if you want
the `companion:` buttons on the Controls screen. `SONOS_HOST` is optional too;
see [Sonos](#sonos) below. Key lights are configured in `dashboard.yaml`, not
here.

</details>

**5. Apply.** On first start the container writes a fully documented
`dashboard.yaml` into `/mnt/user/appdata/navigator-panel/`.

**6. Edit that file** to list your entities. Unraid's file manager works, or:

```bash
nano /mnt/user/appdata/navigator-panel/dashboard.yaml
```

It hot-reloads — save and connected panels update within a second. **No
container restart.** If you make a YAML syntax error the container keeps
running the last good config and logs the problem, so a typo can't take the
panel down.

**7. Point the Navigator at it** (Persistent Web App mode, see [§3](#3-provisioning-the-room-navigator)):

```
http://YOUR-UNRAID-IP:8099/?t=YOUR_PANEL_TOKEN
```

> **The `?t=` part is not optional.** Without it the panel cannot authenticate
> and the server logs `Rejected unauthenticated WebSocket upgrade`. You only
> need the full URL once per device — the panel caches the token and strips it
> from the address bar. If you do forget it, the panel says so on screen and
> shows you the address to use, so this is self-correcting rather than a
> silent hang.

### Updating

Push to `main` → GitHub Actions builds and publishes → Unraid's *Docker* tab
shows **update ready** on the container. Click **Force Update**.

To do it automatically, install **Auto Update Applications** from Community
Applications and enable it for `navigator-panel`. During the pull the panel
shows an amber connection dot for a second or two and then reconnects on its
own — the backend closes panel sockets cleanly on SIGTERM specifically so a
deploy doesn't leave a wall-mounted device waiting out a heartbeat timeout.

To pin a specific build instead of tracking `latest`, change the repository to
a commit SHA tag:

```
ghcr.io/spencer8742/cisconavigatorwebapp:<full-commit-sha>
```

Every push publishes one, so rolling back is changing that string.

### Networking notes

- **Home Assistant on the same Unraid box?** Put both containers on the same
  custom Docker network and use HA's container name as the hostname. On
  `bridge`, use the Unraid host's LAN IP — `localhost` refers to the container
  itself.
- **Bridge is the right choice** here, unless you use Sonos. The panel needs
  one inbound port, and everything else it talks to is outbound — except Sonos
  speakers, which push events *to* the container. On bridge that needs
  `SONOS_CALLBACK_HOST` set to the Unraid host's LAN address; on `host`
  networking it is automatic. See [Sonos](#1b-sonos).

### File permissions

The container starts as root only long enough to seed the config and fix
ownership of the appdata folder, then drops to `PUID:PGID` (99:100, Unraid's
`nobody:users`) before running Node. CI asserts the server process is not
root. Leave PUID/PGID alone unless you know you need something else.

If the log says `WARNING: could not write ... (permissions?)`, the appdata
folder isn't writable. Fix it and restart:

```bash
mkdir -p /mnt/user/appdata/navigator-panel
chown -R 99:100 /mnt/user/appdata/navigator-panel
chmod -R 0775 /mnt/user/appdata/navigator-panel
```

The panel still starts in that state — it just shows an empty dashboard rather
than going dark.

---

## 1b. Sonos

Optional, and independent of everything above: skip it and the panel is
unchanged. Set it and your Sonos rooms appear on the Media screen.

The panel talks to Sonos **directly on your LAN** — no cloud account, no
developer key, no Home Assistant in the middle. Why the local protocol rather
than Sonos's cloud API is in [`SONOS.md`](./SONOS.md) §2.

> **Sonos is now the only music source.** Music Assistant has been removed —
> `MASS_URL` and `MASS_TOKEN` do nothing and can be deleted from your config.

### One address is all it needs

```bash
SONOS_HOST=192.168.1.51
```

From any single speaker the backend reads the whole household: every room,
every group, and every other speaker's address. So this is one line no matter
how many speakers you own, and unplugging the one you named does not break
anything — the others are already known.

**Find it** in the Sonos app: *Settings → System → About My System*, which
lists every product with its IP address. Any of them will do.

**Then give that speaker a DHCP reservation** on your router. This is the one
piece of setup outside the panel, and it matters: without it the address can
change on a lease renewal and the Media screen empties out for no visible
reason.

### Check UPnP is on

*Settings → App Preferences → Privacy → UPnP* in the Sonos app. It ships
enabled, but it is a toggle, and switching it off stops **every** local
integration — this panel, Home Assistant's Sonos integration, SoCo, all of
them. It is the first thing to check if nothing appears.

### Did it work?

*Settings* on the panel, under **Connection**:

| Row says | Meaning |
|---|---|
| `Backend → Sonos: connected` | Working. Rooms are on the Media screen |
| `Backend → Sonos: disabled` | `SONOS_HOST` is empty |
| `Backend → Sonos: disconnected` | Read the **Sonos says** row beneath it — it names the actual reason rather than leaving you to guess |

The container log says the same thing on startup:

```
INFO [sonos] Sonos household: 4 zones (Bedroom, Kitchen, Living Room, Study)
```

### Networking — read this if volumes look stale

Sonos **pushes** changes rather than being polled, which means the speakers
connect **inward** to this backend. It is the only upstream in the app that
does, and it is the one part of this integration that bridge networking breaks
*silently*: commands still work, so the panel does not look broken — it just
stops keeping up.

| Deployment | What to do |
|---|---|
| **Host networking** | Nothing. The address is worked out automatically |
| **Bridge + published port** | Set `SONOS_CALLBACK_HOST` to the Docker **host's** LAN address |
| **Bridge, nothing set** | Volumes and tracks go stale. The Settings screen says so |

The address is normally derived by asking the kernel which of our addresses
reached the first speaker — right on a multi-homed host, right across VLANs,
and no guess about which interface faces the speakers. What it cannot see
through is Docker's bridge NAT, which is the entire reason the override exists.

The backend expects the first event within twenty seconds of subscribing (a
speaker sends current state the moment you subscribe). If nothing arrives it
reports that on the Settings screen with the address it handed out, rather than
leaving you to notice the numbers have stopped moving.

`SONOS_DISCOVERY=1` searches the network instead of naming an address, and is
best treated as a laptop convenience: discovery uses multicast, which does not
cross a bridge network either, so in a container it usually finds nothing —
and that failure looks like an empty Media screen rather than an error. Name
the address.

### Searching Spotify

Optional, and only for the Search tab. Everything you have **favourited in the
Sonos app** already plays without it, and the local library is searchable
without it too.

Set `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` from a free app at
[developer.spotify.com](https://developer.spotify.com/dashboard). Any redirect
URI will do — this uses the client-credentials flow, which is server to server
with no user login and no redirect.

**Playback still runs through the Spotify account linked in your Sonos app.**
These credentials read the public catalog and nothing else; they give no access
to anybody's account.

**You can skip this entirely.** Spotify also appears under `Browse → Services`,
where connecting it needs no variables at all — see below. The Web API returns
richer results, so it is used when these are set and the service's own search
answers when they are not. One tab either way.

---

## Music services — Sonos Radio, Plex, SoundCloud, YouTube Music

Nothing to configure. `Browse → Services` lists whatever your household has
set up in the Sonos app.

A service that needs an account shows **Not connected**. Tapping it gives you a
URL and a short code to enter on your phone; the panel notices when you are
done. Connections are stored in `music-services.json` beside `dashboard.yaml`
(mode `0600` — they are service credentials) and survive a redeploy.

Two things worth knowing:

- **Favourites need none of this.** Anything you have favourited in the Sonos
  app plays with no connection here at all, whichever service it came from.
  Connecting a service adds *searching* and *browsing* its catalog.
- **This app links to a service in its own right.** Your speakers hold their
  own credentials and do not share them — `/status/accounts` gives account
  numbers and no tokens — so connecting here is a separate, one-time act.

---

## 2. TLS

**Recommended, and effectively required if you want to avoid a trap.** A page
served over HTTPS cannot open an insecure `ws://` socket, and a page served
over HTTP cannot be upgraded later without re-provisioning the device.
Choosing HTTPS once avoids ever hitting that.

RoomOS uses the same root CA bundle as the device itself, **and accepts custom
CA bundles added through the device's web portal** (`docs/ROOMOS.md` §4). So a
private CA works fine.

### Option A — reverse proxy with a real certificate (simplest)

If you already run Caddy or Traefik with a public DNS name and Let's Encrypt,
use it. Nothing needs to be installed on the Navigator.

```caddyfile
panel.example.com {
    reverse_proxy 127.0.0.1:8099
}
```

Caddy proxies WebSockets automatically. With nginx you must add the upgrade
headers explicitly:

```nginx
server {
    listen 443 ssl http2;
    server_name panel.example.com;

    ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8099;
        proxy_http_version 1.1;

        # Without these three lines the WebSocket silently fails and the
        # panel sits on "connecting" forever.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;

        # The panel holds a long-lived socket; the default 60s read timeout
        # would tear it down every minute.
        proxy_read_timeout 3600s;
    }
}
```

When binding behind a proxy on the same host, set `HOST=127.0.0.1` in `.env`
so the backend is not reachable directly.

### Option B — internal CA

1. Create a root CA and a server certificate for the panel's hostname.
2. Configure your reverse proxy with the server certificate.
3. Install the **root CA** on the Navigator: browse to the device's web portal
   → **Security** → **Certificates** → **Custom CAs** → add your root CA PEM.
4. Reboot the device.

### Option C — plain HTTP

Works, and is fine for a bench test. Not recommended for a wall-mounted panel:
the bearer token then travels in clear text on your LAN, and moving to HTTPS
later means re-provisioning the device.

---

## 3. Provisioning the Room Navigator

### The short way

```bash
scripts/provision-roombar.sh --host 192.168.1.243 \
  --url 'https://panel.example.com/?t=<PANEL_TOKEN>'
```

This applies everything in this section that can be applied remotely — the web
engine, the nightly storage wipe, the standby delay, and the URL — by POSTing
xConfiguration and xCommand XML to the device's `/putxml` with basic auth. It
prompts for the device password rather than taking it as a flag, so it does
not end up in your shell history.

It is **idempotent**: every step sets a value rather than changing one, so
running it against a working device changes nothing and tells you whether the
device still matches what this repository says it should be. `--dry-run`
prints the XML without sending it; `--insecure` accepts the device's own
self-signed certificate.

This is the artefact that makes a factory reset cheap. A RoomOS device holds
macros, UI Extension panel XML and `HttpClient` configuration *on the device*,
and a reset destroys all of it with nothing to reapply — which is exactly why
this dashboard puts only a URL there. The rest of this section is the same
thing done by hand.

One thing the script cannot do is the next heading: Persistent Web App mode is
chosen during onboarding and there is no configuration path for it.

### Put the Navigator into Persistent Web App mode

PWA mode is chosen **during onboarding**. If the device is already onboarded
in another mode you must factory reset it to change this.

1. Factory reset the Navigator if it is currently paired as a touch controller
   or scheduler.
2. During setup select **Persistent Web App**.
3. Enter the URL, **including the token**:

   ```
   https://panel.example.com/?t=<PANEL_TOKEN>
   ```

The app then fills the entire screen, replaces the RoomOS UI, and cannot be
dismissed by users.

**Why the token goes in the URL:** RoomOS deletes web storage daily by default
(`docs/ROOMOS.md` §5). Anything the panel must remember has to be recoverable
from the URL RoomOS reloads. The panel reads `?t=`, caches it in
`localStorage`, and strips it from the visible URL immediately.

### Device configuration

From the device web portal, or over SSH with `xConfiguration`:

```
# STRONGLY RECOMMENDED. Stops RoomOS erasing the panel's HTTP cache and
# localStorage every night. Cisco explicitly recommends Off for personal
# devices. Without it the panel still works — it just re-downloads its
# bundle every morning.
xConfiguration RoomCleanup AutoRun ContentType WebData: Off

# Only if you want the app to read device status via JSXAPI.
xConfiguration WebEngine Features Xapi Peripherals AllowedHosts Hosts: "panel.example.com"
xConfiguration Security Xapi WebSocket ApiKey Allowed: True
```

**Do not** enable `WebEngine Features WebGL` — this app does not use it, and
leaving GPU features at their defaults is one less thing to differ between
devices.

### Standby

In PWA/kiosk mode the device never enters half-wake but still goes to standby
after the configured delay. Set that longer than the app's own screensaver
timeout, or the screen will black out before the slideshow ever appears:

```
xConfiguration Standby Delay: 120          # minutes
xConfiguration Standby Control: On
```

With `idle.timeoutSeconds: 180` (3 minutes) in `dashboard.yaml`, the panel
shows photos from 3 minutes of inactivity and the display sleeps at 120
minutes.

---

## 3a. Google Nest Hub displays (cast mode)

A Nest Hub runs Fuchsia. It has no browser, no sideloading and no kiosk mode,
so **casting is the only way to put this dashboard on one**. What you get is a
display rather than a control panel — see the honest limits at the end of this
section before you invest in it.

### What cast mode is

A separate, read-only view: a few big panes that rotate on their own, sized to
be read from across a room. Configure it under `cast:` in `dashboard.yaml`:

```yaml
cast:
  panes: [clock, media, photos]   # clock | status | media | photos
  rotateSeconds: 30               # 0 pins the first pane
  followMusic: true               # jump to Now Playing when music starts
  audioKeepAlive: false           # see "If the session still drops"
```

The URL is your normal panel URL plus `cast=1`:

```
http://192.168.1.71:8099/?cast=1&t=YOUR_PANEL_TOKEN
```

Add `&pane=media` to pin one display to a single pane — the kitchen Hub can
show what is playing while the hallway one shows the clock, from the same
config.

### Or cast the real dashboard

`&pane=dashboard` renders the **full interactive dashboard** instead of the
panes, with the same keep-alive:

```
http://192.168.1.71:8099/?cast=1&pane=dashboard
```

Touch works on a Nest Hub (confirmed August 2026), so this is a genuine
control panel — rooms, media, the queue, all of it. It is laid out for the
Navigator's 1280x800 and also fits a 1024x600 Hub without scrolling.

Which to use is a per-display choice. The dashboard where you will actually
touch things; the panes where you only ever glance at it, since they are sized
to be read from across a room.

A `pane: dashboard` display falls into the photo screensaver after
`idle.timeoutSeconds`, the same as the Navigator, and a touch brings the
dashboard back. Turn it off per-house with `cast.screensaver: false` if you
would rather a Hub always be a control panel:

```yaml
cast:
  screensaver: true    # default
```

The reason it is a switch at all: the screensaver is dismissed by touch, and
Google has never promised a Hub will deliver any. On one that stopped, a
display that had gone to photos would stay there — a slideshow rather than a
disaster, but not a control panel.

The rotating panes are unaffected either way. They have their own idea of what
to show, and `photos` is already a slideshow.

### Casting it

**The backend does this itself.** List your displays under `cast:` and it
casts them, notices when a Hub drops back to Google's ambient screen, and
casts it again — forever. There is nothing else to install and no second
container.

```yaml
cast:
  # How a Hub reaches this dashboard. The LAN IP of the machine running the
  # container, not localhost and not a .local name — see below.
  baseUrl: http://192.168.1.71:8099

  displays:
    - host: 192.168.1.42
      name: Kitchen
      pane: dashboard
    - host: 192.168.1.43
      name: Hallway
      pane: clock
    - 192.168.1.44            # bare address: uses the panes rotation

  checkSeconds: 300           # 0 turns the keeper off
```

Restart is not needed — `dashboard.yaml` is watched, and editing the `cast:`
section re-casts every listed display immediately. Editing anything else does
not touch them.

Three things that will otherwise cost you an evening:

- **Use IP addresses, not names.** A Nest Hub is normally found by name over
  mDNS, and mDNS does not cross a Docker bridge network. Addressing devices
  directly is what lets this run in the ordinary container. Get each Hub's IP
  from your router, or from Google Home → device → settings → device
  information, and give it a DHCP reservation.
- **`baseUrl` cannot be guessed.** The backend knows the port it bound and
  nothing else. `localhost` is the container, and a `.local` name is resolved
  by a Nest Hub through Google rather than over your LAN. Write down the LAN
  address of the machine running this.
- **Do not put your panel token in `baseUrl`.** The backend appends it from
  `PANEL_TOKEN` in `.env`, so it stays in one place.

A display already showing the dashboard is left strictly alone, so the check
costs one short connection per display every `checkSeconds` and never causes a
visible reload.

#### Casting by hand

Nothing above stops you casting yourself, which is useful for trying a pane
before committing to it:

```bash
pipx install catt
catt --device "Kitchen display" cast_site \
  "http://192.168.1.71:8099/?cast=1&pane=media&t=YOUR_PANEL_TOKEN"
```

To stop, `catt --device "Kitchen display" stop`, or just say "hey Google, stop"
at the Hub. The keeper will cast it back at the next check.

#### What does not work: Home Assistant's cast service

This looks like it should work and does not:

```yaml
# DOES NOT WORK — answers "App DashCast is not supported"
action: media_player.play_media
data:
  media_content_type: cast
  media_content_id: '{"app_name":"DashCast","app_data":{"url":"…"}}'
```

Home Assistant can only launch receivers that pychromecast ships a controller
for — YouTube, BBC Sounds, Plex and a handful of others. DashCast is not among
them, so the call is rejected before it reaches the device. It is not a
configuration problem and no `app_data` fixes it. That gap is exactly why the
backend speaks the Cast protocol directly (`server/src/cast/`).

### Holding the screen

DashCast navigates away from itself, which destroys the receiver context that
would normally keep the session alive — historically the screen was reclaimed
after ten minutes, and after the Fuchsia update, after about thirty seconds.

Cast mode picks that role back up: it loads Google's Cast receiver SDK and
declares itself a long-lived receiver (`disableIdleTimeout`). This is why
`?cast=1` gets a slightly different Content-Security-Policy — it is the only
page allowed to load a script from `gstatic.com`, and it is the only exception
in the whole app.

**If the session still drops**, set `audioKeepAlive: true`. It plays a silent
loop, which is a stronger signal to the platform — but it takes the device's
audio focus, and on a Nest Hub that is *also* a speaker that
may interrupt playback on that speaker. Try without it first.

### What you will not get

Be clear-eyed about this before wiring up ten displays:

- **Touch works, but is not guaranteed to keep working.** Cast mode asks for
  it with `touchScreenOptimizedApp` and a Nest Hub honours it today (confirmed
  August 2026). Google's own framing is that Cast is for showing things rather
  than interacting with them, and they have never promised otherwise — so if
  it stops, `?pane=` panes are the fallback and need no changes.
- **The Hub still owns its screen.** Timers, alarms, voice answers and ambient
  mode will interrupt and take over. No amount of work on this side prevents
  that.
- **It can break.** None of this is a supported API. It has broken before.

If you want a display you can actually *use*, put a cheap Android tablet on the
wall with Fully Kiosk Browser pointed at the normal panel URL. This app is a
PWA built for exactly that, and no casting is involved.

---

## 4. On-device debugging

This is the only way to get real numbers. A laptop tells you nothing useful
about how this performs on the device.

```
xConfiguration WebEngine RemoteDebugging: On
```

Then open **`http://<device-ip>:9222`** in desktop Chrome.

- **IP address, not hostname. `http`, not `https`.** Neither substitution works.
- A prominent warning bar appears on the device while this is enabled.
- **Turn it off when you are done** — it degrades the user experience.

### Profiling checklist

Run this before declaring any performance work finished.

| Check | How | Pass |
|---|---|---|
| Cold load | Network tab, disable cache, reload | Interactive < 1.5 s |
| Bundle size | Network tab, transferred | JS < 50 KB, CSS < 12 KB gz |
| Touch latency | Performance tab, record a tap | Visual change within 1 frame |
| Screen transition | Performance tab, record a nav tap | No long tasks > 50 ms |
| Idle CPU | Performance monitor, leave it alone 60 s | ~0% between clock ticks |
| Heap after 1 h | Memory tab, snapshot, wait, snapshot | Flat, no growth |
| Heap after 24 h | Same, next day | Flat. **This is the real test.** |
| Slideshow | Leave 30 min | No visible load, heap flat |

If heap or DOM node count grew between the one-hour and 24-hour snapshots,
something is retaining. Start with the caches — every one of them is supposed
to be bounded (`panel/src/lib/lru.ts`).

---

## 5. Local development

```bash
npm install
cp .env.example .env          # fill in at least HA_URL and HA_TOKEN
cp config/dashboard.example.yaml config/dashboard.yaml
npm run dev
```

- Panel: <http://localhost:5173>
- Backend: <http://127.0.0.1:8099>

Vite proxies `/api`, `/img` and `/ws` to the backend, so **the panel is
same-origin in development exactly as it is in production**. This is
deliberate: it means CORS cannot work in development and then break on the
device, which is the single most common way this class of app fails at
deployment time.

If `PANEL_TOKEN` is set, open <http://localhost:5173/?t=YOUR_TOKEN> once —
the token is cached in `localStorage` from then on.

### Testing against the real constraints

You cannot feel RoomOS's performance envelope on a laptop. Two useful
approximations before you get to the device:

```
Chrome DevTools → Performance → CPU: 6× slowdown
Chrome DevTools → Network   → Fast 3G
```

And check the layout at both viewports the app is designed for:

```
DevTools → Toggle device toolbar → 1280 × 800   (Navigator panel)
                                 → 1920 × 1080  (room display)
```

Neither substitutes for testing on the device. Cisco's own advice, which is
worth taking literally:

> the performance is usually never as good as a developer expects, especially
> if doing initial development on a beefy laptop.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Blank screen, no spinner | Panel build missing | `npm run build`, or rebuild the image |
| Spinner forever | Should not happen — after two failed attempts the panel diagnoses itself and puts the cause and the fix on screen | If it really does spin, the page itself failed to load: check the container is running |
| "No panel token" on screen | The URL was opened without `?t=` | Open `http://host:8099/?t=YOUR_PANEL_TOKEN` once; the panel caches it |
| "This panel token is not accepted" | `PANEL_TOKEN` was changed on the server | Re-open with the current token |
| "Live connection blocked" | HTTP works, WebSocket does not | A reverse proxy is not forwarding `Upgrade`/`Connection` — see [§2](#2-tls) |
| Connection dot amber, never green | Backend cannot reach Home Assistant | `docker compose logs`; check `HA_URL` and `HA_TOKEN` |
| Dot green but no entities | Entities not in `dashboard.yaml` | Only configured entities are sent — that is the allow-list working |
| Panel re-downloads everything daily | `RoomCleanup` still on | `xConfiguration RoomCleanup AutoRun ContentType WebData: Off` |
| Home screen side card shows the wrong thing | It is a per-installation setting, not YAML | Settings → Home screen. Stored in `panel-prefs.json` beside `dashboard.yaml` |
| A setting reverts overnight | Should not happen — preferences are stored on the server, not in the browser | If it does, check the appdata volume is writable; the log warns when it cannot persist |
| Speakers missing from the Media screen | Sonos not reachable, or UPnP off | Settings → Connection names the reason. See [Sonos](#1b-sonos) |
| Grouping does nothing | The join was refused | Check the log: every zone id is validated against the household the backend actually read |
| No Sonos rooms at all | Several possible causes | Settings → Connection names the actual one in the **Sonos says** row. Start there, not here |
| Sonos: "refused the connection" | `SONOS_HOST` is wrong, or the speaker moved | Re-read the address in the Sonos app (Settings → System → About My System) and give it a DHCP reservation |
| Sonos: connected, then empty later | The speaker's DHCP lease changed | Same fix: a reservation. Any speaker's address works, so pick one that is never unplugged |
| Sonos rooms appear but volumes never change | Events are not reaching the backend | Almost always Docker bridge networking — see [Networking](#networking--read-this-if-volumes-look-stale). The Settings screen names the callback address it handed out |
| Sonos: buttons work but the panel lags a few seconds | Reconciliation is covering for lost events | The five-minute reconcile is a safety net, not the mechanism. If it is doing the work, events are not arriving — see the row above |
| A sub or "(R)" speaker in the picker | Should not happen — bonded members are filtered | If one appears, it is a real bug: the filter keys on `Invisible="1"` |
| Config edit does nothing | YAML failed to parse | `docker compose logs` — the last good config is still running, on purpose |
| Photos never load | Several possible causes | The Photos screen now names the actual one — it shows Immich's own error, not a guess. Start there |
| Photos: "API key rejected" | Key wrong, revoked, or too narrow | Needs `asset.read`, plus `album.read` for album sources |
| Photos: "cannot reach …" | `IMMICH_URL` wrong or unroutable from the container | Must be reachable *from inside the container*: not `localhost`, and no trailing `/api` |
| Photos: "No photos returned" | Immich answered, nothing matched | With `imagesOnly: true` a video-only library matches nothing. Archived and hidden assets are excluded by design |
| Photos worked, then stopped after an Immich upgrade | Immich changed a filter field | Logged as a 400 naming the property. The client already falls back for the 1.133 `isArchived`→`visibility` rename |
| Web view crashes / reloads itself | Memory ceiling hit | Remote DevTools → Memory → heap snapshot. See `docs/ROOMOS.md` §2 |
| Layout wrong / cut off | Unexpected viewport | Settings screen shows the measured viewport. Everything is fluid, so report the number |
| Unraid: no `dashboard.yaml` appears | appdata folder not writable | See [File permissions](#file-permissions) |
| Unraid: nowhere to paste the template URL | The Template field is a dropdown, not a URL box | Copy the XML to `/boot/config/plugins/dockerMan/templates-user/` first — see [Install](#install) |
| Unraid: template not in the dropdown after copying | Page was already open | Reload the Add Container page |
| Unraid: container won't pull | Image path is case-sensitive | Must be lowercase: `ghcr.io/spencer8742/cisconavigatorwebapp` |
| Unraid: HA unreachable from container | `localhost` points at the container | Use the Unraid host's LAN IP, or a shared Docker network + container name |

### Reading the connection indicator

The dot in the navigation reports the **worst** of the two links, because
"connected" while Home Assistant is unreachable would be a lie the user acts
on:

| Colour | Meaning |
|---|---|
| Green | Panel → backend → Home Assistant, all up |
| Amber (pulsing) | Reconnecting somewhere in that chain |
| Red | Panel cannot reach the backend |

The Settings screen breaks it down link by link.
