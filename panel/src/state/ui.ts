import { signal, computed } from '@preact/signals';
import { DEFAULT_PREFS, type BackendHealth, type LinkState, type PanelPrefs } from '@shared/protocol.ts';
import type { ConnectionProblem } from '~/net/diagnose.ts';

/**
 * UI-level state: which screen is showing, how healthy the link is, whether
 * we are idle.
 *
 * All of it is signals. Nothing here triggers a component re-render — writing
 * `route.value` updates exactly the subscribers that read it.
 */

export type Route = 'home' | 'rooms' | 'controls' | 'media' | 'photos' | 'settings';

export const ROUTES: Route[] = ['home', 'rooms', 'controls', 'media', 'photos', 'settings'];

/* ── Navigation ──────────────────────────────────────────────────────────
   No History API and no hash routing. RoomOS runs this in a kiosk web view
   with no back button and no address bar, and `window.open` replaces the page
   (docs/ROOMOS.md §1) — so a URL-driven router would buy nothing and could
   only cause a navigation we cannot recover from. A signal IS the router. */

export const route = signal<Route>('home');

/** Room drill-down. null = the room list. */
export const activeRoom = signal<string | null>(null);

/** Entity whose detail sheet is open. null = closed. */
export const openEntity = signal<string | null>(null);

/**
 * Which macro page the Controls screen is showing. null = the first one.
 *
 * A signal rather than screen-local state so the page survives the screen
 * being unmounted — which happens on every trip to Home and back, because
 * only the active screen is mounted (see app.tsx). Coming back to the
 * Controls screen on a different page than you left it is exactly the kind of
 * small wrongness that makes a panel feel like a web page.
 */
export const controlPage = signal<string | null>(null);

/**
 * The `sources:` CONTROL ITEM whose input picker is open. null = closed.
 *
 * The item id, not the entity id: the panel names controls, and the backend
 * resolves what they point at. Separate from `openEntity` because that opens
 * the full entity sheet, which for a TV is transport and volume — the whole
 * point of this key is that it goes straight to the input list.
 */
export const openSources = signal<string | null>(null);

/**
 * The `select` entity whose option picker is open, from a device tile.
 * null = closed.
 *
 * Holds the ENTITY id rather than a control item id, unlike `openSources`:
 * a device tile's share source is one slot of a tile, not a control of its
 * own, and there is nothing else to name it by. It is allow-listed the same
 * way — the tile's entities all go into allReferencedEntities().
 */
export const openDeviceSource = signal<string | null>(null);

export function navigate(to: Route): void {
  if (route.value === to) return;
  // Leaving Rooms always resets the drill-down, so coming back lands on the
  // list rather than a room the user has forgotten they were in.
  if (to !== 'rooms') activeRoom.value = null;
  openEntity.value = null;
  route.value = to;
  markActivity();
}

/* ── Connection ──────────────────────────────────────────────────────────*/

/** Panel -> backend socket. */
export const socketState = signal<LinkState>('connecting');

/** Backend -> HA / Immich, as reported by the backend. */
export const health = signal<BackendHealth | null>(null);

/**
 * Settings chosen at the panel, held by the backend.
 *
 * Server-side because RoomOS deletes web storage daily (docs/ROOMOS.md §3) —
 * a preference kept here would quietly revert overnight.
 */
export const prefs = signal<PanelPrefs>({ ...DEFAULT_PREFS });

/**
 * What the connection dot shows. Deliberately conservative: we report the
 * WORST of the two links, because "connected" while Home Assistant is
 * unreachable would be a lie the user acts on.
 */
export const linkStatus = computed<LinkState>(() => {
  if (socketState.value !== 'connected') return socketState.value;
  const h = health.value;
  if (!h) return 'connecting';
  return h.ha;
});

/**
 * Why Immich is failing, if it is. Surfaced on the Photos screen so an empty
 * grid explains itself instead of sending the user to the container logs.
 */
export const immichError = computed<string | null>(() => health.value?.immichError ?? null);

/**
 * True once we have received a `hello` and have something real to draw.
 * Until then the boot spinner stays up rather than flashing an empty
 * dashboard.
 */
export const ready = signal(false);

/**
 * Why the panel cannot connect, once it has failed often enough that this is
 * clearly not a transient blip.
 *
 * Set only while `ready` is false — i.e. we have never successfully
 * connected, so there is nothing on screen but a spinner. Once the panel has
 * data, a dropped connection is handled by the status dot and cached state
 * instead; we do not replace a working dashboard with an error page.
 */
export const connectionProblem = signal<ConnectionProblem | null>(null);

/* ── Idle ────────────────────────────────────────────────────────────────
   The panel is permanently mounted and permanently on. Idle handling is not a
   nicety, it is most of what makes it feel like an appliance. */

/** Epoch ms of the last user interaction. */
export const lastActivity = signal(Date.now());

/** True when the photo screensaver has taken over. */
export const screensaverActive = signal(false);

export function markActivity(): void {
  lastActivity.value = Date.now();
  if (screensaverActive.value) screensaverActive.value = false;
}

/* ── Transient messages ──────────────────────────────────────────────────
   One slot, not a queue. A wall panel that stacks five toasts is a panel
   nobody reads. The newest message replaces the previous one. */

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

export const toast = signal<Toast | null>(null);

let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function showToast(message: string, kind: Toast['kind'] = 'info'): void {
  toastSeq += 1;
  const id = toastSeq;
  toast.value = { id, message, kind };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    // Only clear if a newer toast has not replaced this one.
    if (toast.value?.id === id) toast.value = null;
  }, kind === 'error' ? 6000 : 3000);
}
