import { signal } from '@preact/signals';
import { authHeaders, getPanelId } from '~/net/auth.ts';
import { deviceInfo, isIOS, isStandalone } from '~/lib/device.ts';
import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type PushInfo,
  type PushSubscribeRequest,
} from '@shared/protocol.ts';

/**
 * Push notifications, from this device's side.
 *
 * A phone or iPad that has the panel on its home screen can be told about
 * things while the app is closed. The backend holds the subscriptions and does
 * the sending (server/src/push/); this registers the service worker, asks for
 * permission, and keeps the backend's copy of this device's subscription in
 * step with the browser's.
 *
 * iOS allows Web Push only for a web app launched from the home screen, so in
 * Safari itself the honest state is "add it to the home screen first" rather
 * than a switch that cannot work.
 */

export type PushStatus =
  /** No Web Push here: RoomOS, an old browser, plain http. */
  | 'unsupported'
  /** Served over plain http, where browsers allow no service worker at all. */
  | 'insecure'
  /** iPhone or iPad in Safari: works once added to the home screen. */
  | 'needs-install'
  /** The backend has no VAPID key — see its log. */
  | 'unavailable'
  /** Permission refused; only the system settings can undo that. */
  | 'denied'
  | 'off'
  | 'on';

export const pushStatus = signal<PushStatus>('off');
/** What this device is subscribed to, when `pushStatus` is 'on'. */
export const pushCategories = signal<NotificationCategory[]>([]);
/** A request is in flight; the buttons wait for it. */
export const pushBusy = signal(false);

let publicKey: string | null = null;

/** Whether this browser could ever receive a push, before asking anything. */
export function pushSupport(): 'supported' | 'unsupported' | 'insecure' | 'needs-install' {
  // A wall panel is on screen; it has nobody to notify.
  if (deviceInfo().isRoomOS) return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (isIOS() && !isStandalone()) return 'needs-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return 'unsupported';
  }
  return 'supported';
}

/**
 * Register the service worker. Called once at boot.
 *
 * Done on every launch where push could work, not only after notifications
 * are turned on, so the worker is already active by the time somebody taps
 * the switch — iOS wants the permission prompt to follow the tap directly.
 */
export function startPush(): void {
  const support = pushSupport();
  if (support !== 'supported') {
    pushStatus.value = support;
    return;
  }
  navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then(() => refreshPush())
    .catch((err: unknown) => {
      console.error('[panel] service worker registration failed', err);
      pushStatus.value = 'unsupported';
    });
}

/**
 * Work out where this device stands, and repair what can be repaired.
 *
 * Two repairs. A subscription the browser kept but the backend lost (its
 * config directory was wiped) is sent again. A subscription made with a key
 * the backend no longer has would never receive anything, so it is replaced.
 */
export async function refreshPush(): Promise<void> {
  if (pushSupport() !== 'supported') return;
  if (Notification.permission === 'denied') {
    pushStatus.value = 'denied';
    return;
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const info = await getInfo(sub?.endpoint ?? null);
    publicKey = info.publicKey;

    if (!info.enabled || !info.publicKey) {
      pushStatus.value = 'unavailable';
      return;
    }

    if (sub && !sameKey(sub, info.publicKey)) {
      await sub.unsubscribe();
      sub = Notification.permission === 'granted' ? await subscribeWith(reg, info.publicKey) : null;
    }

    if (!sub) {
      pushStatus.value = 'off';
      pushCategories.value = [];
      return;
    }

    const categories = info.categories ?? [...NOTIFICATION_CATEGORIES];
    if (info.categories === null) await sendSubscription(sub, categories);
    pushCategories.value = categories;
    pushStatus.value = 'on';
  } catch (err) {
    console.error('[panel] push status check failed', err);
  }
}

/**
 * Turn notifications on: ask, subscribe, tell the backend.
 *
 * Must be called straight from a tap. Safari only shows the permission prompt
 * in response to a user gesture, so nothing is awaited before asking.
 */
export async function enablePush(): Promise<string | null> {
  if (pushSupport() !== 'supported') return 'Notifications are not supported here';
  const permission = Notification.requestPermission();
  pushBusy.value = true;
  try {
    if ((await permission) !== 'granted') {
      pushStatus.value = Notification.permission === 'denied' ? 'denied' : 'off';
      return Notification.permission === 'denied' ? null : 'Notifications were not allowed';
    }
    const reg = await navigator.serviceWorker.ready;
    const key = publicKey ?? (await getInfo(null)).publicKey;
    if (!key) {
      pushStatus.value = 'unavailable';
      return 'The server cannot send notifications';
    }
    const sub = (await reg.pushManager.getSubscription()) ?? (await subscribeWith(reg, key));
    const categories = [...NOTIFICATION_CATEGORIES];
    await sendSubscription(sub, categories);
    pushCategories.value = categories;
    pushStatus.value = 'on';
    return null;
  } catch (err) {
    console.error('[panel] enabling push failed', err);
    return 'Notifications could not be turned on';
  } finally {
    pushBusy.value = false;
  }
}

export async function disablePush(): Promise<string | null> {
  pushBusy.value = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      // The backend first: if the browser forgets the endpoint before the
      // backend is told, nothing is left that could name it.
      await post('/api/push/unsubscribe', { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    pushStatus.value = 'off';
    pushCategories.value = [];
    return null;
  } catch (err) {
    console.error('[panel] disabling push failed', err);
    return 'Notifications could not be turned off';
  } finally {
    pushBusy.value = false;
  }
}

export async function setPushCategory(category: NotificationCategory, on: boolean): Promise<string | null> {
  const next = NOTIFICATION_CATEGORIES.filter((c) =>
    c === category ? on : pushCategories.value.includes(c),
  );
  pushBusy.value = true;
  try {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (!sub) {
      pushStatus.value = 'off';
      return 'Notifications are off on this device';
    }
    await sendSubscription(sub, next);
    pushCategories.value = next;
    return null;
  } catch (err) {
    console.error('[panel] updating push categories failed', err);
    return 'That change could not be saved';
  } finally {
    pushBusy.value = false;
  }
}

/** Ask the backend to send this device a notification, to see one arrive. */
export async function sendTestPush(): Promise<string | null> {
  pushBusy.value = true;
  try {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    if (!sub) return 'Notifications are off on this device';
    const report = (await post('/api/push/test', { endpoint: sub.endpoint })) as { sent?: number };
    return report.sent ? null : 'The notification service did not accept it — see the server log';
  } catch (err) {
    console.error('[panel] test push failed', err);
    return 'The test notification could not be sent';
  } finally {
    pushBusy.value = false;
  }
}

function subscribeWith(reg: ServiceWorkerRegistration, key: string): Promise<PushSubscription> {
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(key) });
}

async function sendSubscription(sub: PushSubscription, categories: NotificationCategory[]): Promise<void> {
  const json = sub.toJSON();
  const body: PushSubscribeRequest = {
    subscription: {
      endpoint: sub.endpoint,
      keys: { p256dh: json.keys?.['p256dh'] ?? '', auth: json.keys?.['auth'] ?? '' },
    },
    categories,
    panel: getPanelId(),
  };
  await post('/api/push/subscribe', body);
}

async function getInfo(endpoint: string | null): Promise<PushInfo> {
  const q = endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : '';
  const res = await fetch(`/api/push${q}`, { headers: authHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(`GET /api/push: ${res.status}`);
  return (await res.json()) as PushInfo;
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const reply = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(reply.error ?? `${path}: ${res.status}`);
  return reply;
}

function sameKey(sub: PushSubscription, key: string): boolean {
  const current = sub.options.applicationServerKey;
  // Some browsers do not report it; assume it matches rather than churn.
  if (!current) return true;
  return toBase64Url(new Uint8Array(current)) === key;
}

function fromBase64Url(value: string): ArrayBuffer {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const raw = atob(b64);
  const out = new ArrayBuffer(raw.length);
  const view = new Uint8Array(out);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
