# Deployment

Three parts: run the backend, put it behind TLS, point the Navigator at it.

---

## 1. Backend

### Docker Compose (recommended)

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
- mounts `./config` **read-only** at `/config` — hot reload still works, and a
  bug in the backend cannot corrupt your config
- restarts unless stopped, and is capped at 256 MB so a leak surfaces as a
  restart in `docker ps` rather than as host memory pressure
- runs as uid 1000 (`node`), not root
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

### Updating

```bash
git pull
docker compose up -d --build
```

Connected panels see the socket close, reconnect within a second or two, and
receive a fresh snapshot. No user action, no visible interruption beyond a
brief amber connection dot.

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
| Spinner forever | WebSocket blocked or rejected | Check reverse proxy `Upgrade` headers; check `PANEL_TOKEN` matches the `?t=` in the provisioned URL |
| Connection dot amber, never green | Backend cannot reach Home Assistant | `docker compose logs`; check `HA_URL` and `HA_TOKEN` |
| Dot green but no entities | Entities not in `dashboard.yaml` | Only configured entities are sent — that is the allow-list working |
| Panel re-downloads everything daily | `RoomCleanup` still on | `xConfiguration RoomCleanup AutoRun ContentType WebData: Off` |
| Config edit does nothing | YAML failed to parse | `docker compose logs` — the last good config is still running, on purpose |
| Photos never load | Immich key lacks scopes | Needs `asset.read` **and** `album.read` |
| Web view crashes / reloads itself | Memory ceiling hit | Remote DevTools → Memory → heap snapshot. See `docs/ROOMOS.md` §2 |
| Layout wrong / cut off | Unexpected viewport | Settings screen shows the measured viewport. Everything is fluid, so report the number |

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
