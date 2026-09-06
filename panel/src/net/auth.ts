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
 *
 * The panel's own id rides in the same URL for the same reason:
 *
 *     https://panel.your.lan/?t=<PANEL_TOKEN>&panel=office
 *
 * It is NOT stripped. It is not a secret, and leaving it visible is the only
 * way to tell from the address which panel a browser is pretending to be.
 */

import { PANEL_ID_PATTERN } from '@shared/protocol.ts';

const STORAGE_KEY = 'np.token';

let token: string | null = null;
let panelId: string | null = null;

/**
 * Resolve the token, in priority order:
 *   1. `?t=` in the URL   — the durable, provisioned source of truth
 *   2. localStorage       — a cache; may have been wiped at any time
 *
 * The panel's own id (`?panel=office`) is read the same way and for the same
 * reason: it decides which settings this panel gets, so it has to survive the
 * nightly wipe, and only the provisioned URL does.
 *
 * Call once at boot, before anything opens a socket.
 */
export function initAuth(): void {
  let fromUrl: string | null = null;
  let idFromUrl: string | null = null;

  try {
    const params = new URLSearchParams(window.location.search);
    fromUrl = params.get('t');
    idFromUrl = params.get('panel');
  } catch {
    /* malformed query string — fall through to storage */
  }

  /*
   * The URL and nothing else.
   *
   * The token is cached in localStorage because it is a secret the nightly
   * wipe destroys and the panel cannot ask for again. The id is neither: it
   * is in the URL RoomOS reloads every time, so there is nothing for a cache
   * to recover. Caching it anyway makes a browser that has opened two panels
   * keep answering with the first one — which is how this line was found —
   * and leaves no way back to the shared settings short of clearing storage.
   */
  panelId = readPanelId(idFromUrl);

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

/**
 * Which panel this is, or null for "use the shared settings".
 *
 * Validated here as well as on the server so a typo in a provisioned URL
 * fails the same way at both ends — the panel falls back to the shared
 * defaults rather than asking for a scope the backend will not honour.
 */
export function getPanelId(): string | null {
  return panelId;
}

function readPanelId(value: string | null): string | null {
  if (!value) return null;
  const id = value.trim().toLowerCase();
  return PANEL_ID_PATTERN.test(id) ? id : null;
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
  const query = new URLSearchParams();
  if (token) query.set('t', token);
  // The id has to be here rather than sent after connecting: the backend puts
  // this panel's preferences in `hello`, which it sends before the panel has
  // said anything at all.
  if (panelId) query.set('panel', panelId);
  const q = query.toString();
  return q ? `${proto}//${window.location.host}/ws?${q}` : `${proto}//${window.location.host}/ws`;
}
