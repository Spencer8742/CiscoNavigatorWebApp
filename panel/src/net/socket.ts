import { Backoff } from '@shared/backoff.ts';
import { socketUrl } from '~/net/auth.ts';
import { applyPatch, applySnapshot } from '~/state/entities.ts';
import { setConfig } from '~/config/index.ts';
import { connectionProblem, health, prefs, ready, showToast, socketState } from '~/state/ui.ts';
import { diagnose } from '~/net/diagnose.ts';
import {
  HEARTBEAT_MS,
  HEARTBEAT_TIMEOUT_MS,
  type ClientMessage,
  type PanelPrefs,
  type PhotoRef,
  type ServerMessage,
} from '@shared/protocol.ts';

/**
 * The panel's single connection to the backend.
 *
 * Requirements this has to meet, all of which come from the device being a
 * permanently mounted appliance rather than a browser tab:
 *
 *  - It runs for weeks. Every timer is cleared on teardown; nothing accretes.
 *  - It must survive Home Assistant restarts, backend restarts, Wi-Fi roams,
 *    and RoomOS's nightly storage wipe, with no user action. There is no user.
 *  - It must never surface a modal error or unmount the UI. A wall panel
 *    showing a stack trace is bricked until someone fetches a ladder.
 *  - Reconnection must not stampede: after a power cut everything on the LAN
 *    comes back at once (see lib/backoff.ts).
 */

let ws: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let pongTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let closed = false;

const backoff = new Backoff({ baseMs: 500, maxMs: 30_000 });

let seq = 0;
const nextId = (): number => (seq += 1);

/** Resolvers for in-flight photo requests, keyed by message id. */
const photoWaiters = new Map<number, (photos: PhotoRef[]) => void>();

export function connect(): void {
  closed = false;
  open();
}

export function disconnect(): void {
  closed = true;
  clearTimers();
  ws?.close();
  ws = null;
}

function open(): void {
  if (closed) return;

  socketState.value = ws === null && backoff.attempt === 0 ? 'connecting' : socketState.value;

  let sock: WebSocket;
  try {
    sock = new WebSocket(socketUrl());
  } catch {
    // Malformed URL or the engine refused outright. Treat as a failed attempt
    // so we back off rather than spinning.
    scheduleReconnect();
    return;
  }

  ws = sock;

  sock.onopen = () => {
    // Not "connected" yet — that requires a `hello`. An open socket that
    // never authenticates would otherwise show a green dot forever.
    startHeartbeat();
  };

  sock.onmessage = (ev) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data as string) as ServerMessage;
    } catch {
      return; // ignore garbage rather than tearing down a working socket
    }
    handle(msg);
  };

  sock.onerror = () => {
    // Deliberately silent. onerror is always followed by onclose, which is
    // where reconnection is handled; logging here would just be noise in a
    // console nobody is watching.
  };

  sock.onclose = () => {
    if (sock !== ws) return; // a stale socket we already replaced
    ws = null;
    clearTimers();
    socketState.value = closed ? 'disconnected' : 'connecting';
    scheduleReconnect();
  };
}

/**
 * Failed attempts since the last successful `hello`.
 *
 * Only counted before the first success. Once the panel has data, a dropped
 * connection is a status-dot matter, not something that should replace a
 * working dashboard with an error page.
 */
let failuresBeforeFirstConnect = 0;
let diagnosing = false;

/** Two failures is past "the backend is still booting" and into "broken". */
const DIAGNOSE_AFTER_FAILURES = 2;

function scheduleReconnect(): void {
  if (closed) return;

  // A panel that has never connected shows nothing but a spinner, which is
  // indistinguishable from a crash on a device with no address bar and no
  // console. Work out what is actually wrong and put it on screen.
  if (!ready.peek()) {
    failuresBeforeFirstConnect += 1;
    if (failuresBeforeFirstConnect >= DIAGNOSE_AFTER_FAILURES && !diagnosing) {
      diagnosing = true;
      void diagnose()
        .then((problem) => {
          // Re-check: a connection may have succeeded while we were probing.
          if (!ready.peek()) connectionProblem.value = problem;
        })
        .catch(() => {
          /* diagnosis is best-effort; never let it break reconnection */
        })
        .finally(() => {
          diagnosing = false;
        });
    }
  }

  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(open, backoff.next());
}

function handle(msg: ServerMessage): void {
  switch (msg.t) {
    case 'hello': {
      // A complete snapshot in one frame. This is what makes reconnecting —
      // including after RoomOS wipes storage overnight — invisible: no auth
      // round trip, no get_states, straight to a correct screen.
      setConfig(msg.config);
      applySnapshot(msg.states);
      health.value = msg.health;
      prefs.value = msg.prefs;
      socketState.value = 'connected';
      ready.value = true;
      // Clear any diagnosis: whatever was wrong is now demonstrably fixed.
      connectionProblem.value = null;
      failuresBeforeFirstConnect = 0;
      // Only reset backoff once we have a WORKING connection, not merely an
      // open one. A backend that accepts sockets and immediately drops them
      // would otherwise defeat the backoff entirely.
      backoff.reset();
      break;
    }

    case 'patch':
      applyPatch(msg.patch);
      break;

    case 'config':
      setConfig(msg.config);
      break;

    case 'health':
      health.value = msg.health;
      break;

    case 'prefs':
      prefs.value = msg.prefs;
      break;

    case 'photos': {
      // Resolve whichever request is outstanding. Photos are also pushed
      // unsolicited by the backend when it refills the playlist.
      const waiter = photoWaiters.values().next();
      if (!waiter.done) {
        for (const [id, resolve] of photoWaiters) {
          photoWaiters.delete(id);
          resolve(msg.photos);
          break;
        }
      }
      break;
    }

    case 'pong':
      clearTimeout(pongTimer);
      pongTimer = undefined;
      break;

    case 'error':
      // Surfaced as a transient toast, never as a blocking dialog.
      showToast(msg.message, 'error');
      break;
  }
}

/* ── Heartbeat ────────────────────────────────────────────────────────────
   A Wi-Fi roam or an AP reboot can leave a socket half-open: the panel thinks
   it is connected, no data ever arrives, and TCP will not notice for minutes.
   On a device that is supposed to respond to a light switch instantly, that
   is indistinguishable from broken. An application-level ping catches it in
   ~35 seconds. */

function startHeartbeat(): void {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    send({ t: 'ping', id: nextId() });
    if (pongTimer) return; // already awaiting one
    pongTimer = setTimeout(() => {
      pongTimer = undefined;
      // No pong: the socket is dead even though the engine thinks otherwise.
      // Force it closed; onclose drives the normal reconnect path.
      ws?.close();
    }, HEARTBEAT_TIMEOUT_MS);
  }, HEARTBEAT_MS);
}

function clearTimers(): void {
  clearInterval(heartbeatTimer);
  clearTimeout(pongTimer);
  heartbeatTimer = undefined;
  pongTimer = undefined;
}

/* ── Sending ─────────────────────────────────────────────────────────────*/

function send(msg: ClientMessage): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

/**
 * Call a Home Assistant service.
 *
 * Fire-and-forget by design. The UI has already updated optimistically, and
 * the authoritative result arrives as a normal state push. Waiting for an ack
 * would add latency to every tap for no user-visible benefit.
 *
 * Returns false if the socket is down, so the caller can show a hint rather
 * than pretending the command landed.
 */
export function callService(
  domain: string,
  service: string,
  entity: string,
  data?: Record<string, unknown>,
): boolean {
  return send({ t: 'call', id: nextId(), domain, service, entity, data });
}

/**
 * Change a panel preference.
 *
 * Applied optimistically so the setting responds to the tap immediately; the
 * backend's broadcast then confirms it, and corrects it if the value was
 * refused. Preferences are stored server-side because RoomOS clears web
 * storage nightly (docs/ROOMOS.md §3).
 */
export function setPref<K extends keyof PanelPrefs>(key: K, value: PanelPrefs[K]): boolean {
  prefs.value = { ...prefs.value, [key]: value };
  return send({ t: 'pref', id: nextId(), key, value });
}

/** Request the next batch of slideshow photos. Resolves empty on timeout. */
export function requestPhotos(count: number): Promise<PhotoRef[]> {
  return new Promise((resolve) => {
    const id = nextId();
    if (!send({ t: 'photos', id, count })) {
      resolve([]);
      return;
    }
    photoWaiters.set(id, resolve);
    setTimeout(() => {
      if (photoWaiters.delete(id)) resolve([]);
    }, 10_000);
  });
}
