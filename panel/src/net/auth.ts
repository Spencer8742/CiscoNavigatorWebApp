/**
 * Panel authentication.
 *
 * This looks over-engineered for "read a token" until you know the RoomOS
 * constraint driving it (docs/ROOMOS.md §5):
 *
 *   > Web apps: data is persisted but by default deleted once every day.
 *
 * So localStorage on this device is NOT durable. A session cookie or a
 * stored-only token would be wiped nightly and the panel would wake up
 * showing a login screen — to a wall-mounted device with no user and a soft
 * keyboard Cisco itself describes as unsuitable for text entry.
 *
 * The fix: the token is provisioned IN THE URL the device is configured with.
 *
 *     https://panel.your.lan/?t=<PANEL_TOKEN>
 *
 * RoomOS reloads exactly that URL every time, so the token is always
 * recoverable no matter what was erased. localStorage is used purely as a
 * cache, and we strip the token from the visible URL immediately so it does
 * not sit on screen in a room full of people.
 */

const STORAGE_KEY = 'np.token';

let token: string | null = null;

/**
 * Resolve the token, in priority order:
 *   1. `?t=` in the URL   — the durable, provisioned source of truth
 *   2. localStorage       — a cache; may have been wiped at any time
 *
 * Call once at boot, before anything opens a socket.
 */
export function initAuth(): void {
  let fromUrl: string | null = null;

  try {
    const params = new URLSearchParams(window.location.search);
    fromUrl = params.get('t');
  } catch {
    /* malformed query string — fall through to storage */
  }

  if (fromUrl) {
    token = fromUrl;
    try {
      localStorage.setItem(STORAGE_KEY, fromUrl);
    } catch {
      // Storage disabled or full. Harmless: the URL still has the token and
      // RoomOS reloads that URL, so we recover on every load anyway.
    }
    stripTokenFromUrl();
    return;
  }

  try {
    token = localStorage.getItem(STORAGE_KEY);
  } catch {
    token = null;
  }
}

/**
 * Remove `t` from the address bar without navigating.
 *
 * replaceState is safe here: RoomOS gives us no address bar and no back
 * button, and we never rely on the URL for routing (see state/ui.ts). This is
 * purely so the token is not visible if someone attaches remote DevTools or
 * the app is opened on a desktop browser for development.
 */
function stripTokenFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('t')) return;
    url.searchParams.delete('t');
    const clean = url.pathname + (url.searchParams.toString() ? '?' + url.searchParams : '') + url.hash;
    window.history.replaceState(null, '', clean);
  } catch {
    /* not fatal — worst case the token stays in a URL nobody can see */
  }
}

export function getToken(): string | null {
  return token;
}

/** Authorization header, or an empty object when auth is disabled. */
export function authHeaders(): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * The WebSocket URL, with the token as a query parameter.
 *
 * The browser WebSocket API cannot set request headers — that is a hard
 * limitation of the standard, not an oversight here — so the token has to
 * ride in the query string. It is acceptable in this deployment because the
 * connection is WSS on a LAN, the URL is never logged by the backend
 * (server/src/lib/log.ts redacts it), and the token grants access only to a
 * dashboard whose reachable entities are themselves allow-listed.
 */
export function socketUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${proto}//${window.location.host}/ws`;
  return token ? `${base}?t=${encodeURIComponent(token)}` : base;
}
