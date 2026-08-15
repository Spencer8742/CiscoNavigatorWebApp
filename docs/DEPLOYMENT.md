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

`IMMICH_URL` and `IMMICH_API_KEY` are optional.

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
- **Bridge is the right choice** here. `host` mode gains nothing; the panel
  only needs one inbound port.

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
| Speakers missing from the Media screen | Not Music Assistant players | Discovery keys on MA's own `mass_player_type` attribute. A plain Sonos/Chromecast entity is not discovered — list it under `media.players` |
| A speaker cannot be grouped | It does not advertise GROUPING | Music Assistant only sets that feature on players that support it; those are shown but not offered in the group sheet |
| Grouping does nothing | The join was refused | Check the log: every id in `group_members` is validated against the same allow-list as the target |
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
