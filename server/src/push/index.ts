import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KeyObject } from 'node:crypto';
import { logger } from '~/lib/log.ts';
import {
  NOTIFICATION_CATEGORIES,
  panelIdOf,
  type NotificationCategory,
  type PushInfo,
  type PushMessage,
} from '@shared/protocol.ts';
import {
  encryptPayload,
  generateVapidKeys,
  vapidAuthorization,
  vapidKeyObject,
  type PushTarget,
  type VapidKeys,
} from '~/push/webpush.ts';

const log = logger('push');

/**
 * Push notifications to the devices that asked for them.
 *
 * The panel on a wall never needs this — it is on screen. A phone or iPad
 * that has the panel on its home screen does: a notification is the only way
 * to reach it while the app is closed. iOS supports Web Push for home-screen
 * web apps (16.4 and later) and for nothing else, which is why the panel only
 * offers to subscribe once it has been added to the home screen.
 *
 * Two small machine-owned files beside the config, like the TV keys and the
 * panel prefs, because that directory is the one thing a deployment already
 * persists:
 *
 *  - `push-vapid.json` holds the server's signing key. Losing it orphans every
 *    subscription — the devices only accept pushes signed by the key they
 *    subscribed with — so it is generated once and kept, or supplied through
 *    VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.
 *  - `push-subscriptions.json` holds each device's endpoint and keys. A
 *    subscription the push service reports as gone (404/410) is dropped.
 *
 * Sending is deliberately generic: `notify()` takes a category, and anything
 * in this process — or outside it, through `POST /api/notify` — can call it.
 * What sends notifications is left to grow one category at a time.
 */

export interface StoredSubscription extends PushTarget {
  categories: NotificationCategory[];
  panel: string | null;
  createdAt: string;
}

export interface PushOptions {
  /** Directory for the two files. */
  dir: string;
  /** VAPID `sub` claim: a mailto: or https: URL a push service can contact. */
  subject: string;
  /** From the environment. When absent, a pair is loaded from disk or made. */
  keys?: VapidKeys | null;
  /** Which endpoints may be sent to. Defaults to the known push services. */
  allowEndpoint?: (url: URL) => boolean;
  fetch?: typeof fetch;
}

export interface SendReport {
  sent: number;
  failed: number;
  /** Subscriptions the push service said no longer exist, now forgotten. */
  removed: number;
}

/** A request the caller got wrong — a 400, not a 500. */
export class PushRequestError extends Error {}

/**
 * The push services browsers actually use.
 *
 * The endpoint comes from the device, and the backend POSTs to it: without
 * this list, anyone holding the panel token could aim this process at any URL
 * on the LAN. Apple (Safari and every iOS home-screen app), Google (Chrome,
 * Edge on Android), Mozilla and Microsoft cover every browser that does Web
 * Push at all.
 */
const PUSH_HOSTS = [
  /(^|\.)push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

export function isKnownPushService(url: URL): boolean {
  return url.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(url.hostname));
}

const MAX_SUBSCRIPTIONS = 100;
const LIMITS = { title: 120, body: 1000, tag: 64, url: 512 };

export class PushNotifier {
  readonly #keysPath: string;
  readonly #subsPath: string;
  readonly #options: PushOptions;
  readonly #fetch: typeof fetch;
  readonly #allow: (url: URL) => boolean;

  #keys: VapidKeys | null = null;
  #key: KeyObject | null = null;
  #subs = new Map<string, StoredSubscription>();

  constructor(options: PushOptions) {
    this.#options = options;
    this.#keysPath = join(options.dir, 'push-vapid.json');
    this.#subsPath = join(options.dir, 'push-subscriptions.json');
    this.#fetch = options.fetch ?? fetch;
    this.#allow = options.allowEndpoint ?? isKnownPushService;
  }

  async start(): Promise<void> {
    try {
      this.#keys = this.#options.keys ?? (await this.#loadOrCreateKeys());
      this.#key = vapidKeyObject(this.#keys);
    } catch (err) {
      // Notifications are an extra. The panel runs without them, and Settings
      // says they are unavailable rather than offering a switch that fails.
      this.#keys = null;
      this.#key = null;
      log.error('Push notifications disabled — no usable VAPID key:', err);
    }

    try {
      const raw = JSON.parse(await readFile(this.#subsPath, 'utf8')) as { subscriptions?: unknown };
      for (const item of Array.isArray(raw.subscriptions) ? raw.subscriptions : []) {
        const sub = parseStored(item);
        if (sub) this.#subs.set(sub.endpoint, sub);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`Could not read ${this.#subsPath}; starting with no subscriptions:`, err);
      }
    }
    if (this.#key) log.info(`Push notifications ready (${this.#subs.size} device${this.#subs.size === 1 ? '' : 's'})`);
  }

  /** What a device needs to subscribe, and what `endpoint` already has. */
  info(endpoint?: string | null): PushInfo {
    return {
      enabled: this.#key !== null,
      publicKey: this.#keys?.publicKey ?? null,
      categories: endpoint ? (this.#subs.get(endpoint)?.categories ?? null) : null,
    };
  }

  get count(): number {
    return this.#subs.size;
  }

  /** Add or update one device. `body` is a `PushSubscribeRequest` off the wire. */
  async subscribe(body: unknown): Promise<void> {
    if (!this.#key) throw new PushRequestError('Push notifications are not available');
    const req = (body ?? {}) as Record<string, unknown>;
    const target = parseTarget(req['subscription']);
    if (!target) throw new PushRequestError('Not a push subscription');

    let url: URL;
    try {
      url = new URL(target.endpoint);
    } catch {
      throw new PushRequestError('Not a push subscription');
    }
    if (!this.#allow(url)) {
      log.warn(`Refused a subscription to ${url.origin}: not a known push service`);
      throw new PushRequestError('That push service is not supported');
    }

    const existing = this.#subs.get(target.endpoint);
    if (!existing && this.#subs.size >= MAX_SUBSCRIPTIONS) {
      throw new PushRequestError('Too many devices are subscribed');
    }

    this.#subs.set(target.endpoint, {
      ...target,
      categories: parseCategories(req['categories']),
      panel: panelIdOf(req['panel']),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    });
    await this.#save();
    log.info(`Device subscribed via ${url.origin}${existing ? ' (updated)' : ''}`);
  }

  async unsubscribe(body: unknown): Promise<void> {
    const endpoint = (body as Record<string, unknown> | null)?.['endpoint'];
    if (typeof endpoint !== 'string') throw new PushRequestError('Missing endpoint');
    if (this.#subs.delete(endpoint)) await this.#save();
  }

  /** A test notification to one device, whatever its categories. */
  async test(body: unknown): Promise<SendReport> {
    const endpoint = (body as Record<string, unknown> | null)?.['endpoint'];
    const sub = typeof endpoint === 'string' ? this.#subs.get(endpoint) : undefined;
    if (!sub) throw new PushRequestError('This device is not subscribed');
    return this.#deliver([sub], {
      title: 'Notifications are on',
      body: 'This device will be told about the things you turned on in Settings.',
      tag: 'test',
    });
  }

  /**
   * Send one notification to every device that wants its category.
   *
   * Never throws for a delivery failure: the caller is usually an automation
   * that has nothing useful to do about one phone being offline.
   */
  async notify(input: unknown): Promise<SendReport> {
    const message = parseMessage(input);
    const category = message.category ?? 'general';
    const targets = [...this.#subs.values()].filter(
      (sub) => sub.categories.includes(category) && (!message.panel || sub.panel === message.panel),
    );
    return this.#deliver(targets, { ...message, category });
  }

  async #deliver(targets: StoredSubscription[], message: PushMessage): Promise<SendReport> {
    const report: SendReport = { sent: 0, failed: 0, removed: 0 };
    if (!this.#key || !this.#keys || targets.length === 0) return report;

    await Promise.all(targets.map(async (sub) => {
      const payload = Buffer.from(JSON.stringify({
        title: message.title,
        body: message.body ?? '',
        tag: message.tag ?? null,
        // A tap opens the panel the device subscribed as, so it comes back
        // with its own settings rather than the shared ones.
        url: message.url ?? (sub.panel ? `/?panel=${sub.panel}` : '/'),
        category: message.category ?? null,
      }));
      const status = await this.#send(sub, payload);
      if (status >= 200 && status < 300) {
        report.sent++;
      } else if (status === 404 || status === 410) {
        // Unsubscribed, uninstalled, or the browser's data was cleared. The
        // endpoint will never work again.
        this.#subs.delete(sub.endpoint);
        report.removed++;
      } else {
        report.failed++;
      }
    }));

    if (report.removed > 0) await this.#save();
    if (report.failed > 0 || report.removed > 0) {
      log.info(`Push: ${report.sent} sent, ${report.failed} failed, ${report.removed} expired`);
    }
    return report;
  }

  /** One POST to one push service. Returns the HTTP status, or 0. */
  async #send(sub: StoredSubscription, payload: Buffer): Promise<number> {
    if (!this.#key || !this.#keys) return 0;
    try {
      const res = await this.#fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          authorization: vapidAuthorization(sub.endpoint, this.#keys, this.#key, this.#options.subject),
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          // A day: long enough for a phone that is off overnight, short
          // enough that "the door is open" does not arrive next week.
          ttl: '86400',
          urgency: 'normal',
        },
        body: encryptPayload(sub, payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok && res.status !== 404 && res.status !== 410) {
        // Apple and Google both say why in the body; it is the only clue
        // when, say, the subject is one they will not accept.
        const reason = (await res.text().catch(() => '')).slice(0, 200);
        log.warn(`Push to ${new URL(sub.endpoint).origin} refused: ${res.status} ${reason}`);
      } else {
        await res.body?.cancel();
      }
      return res.status;
    } catch (err) {
      log.warn(`Push to ${new URL(sub.endpoint).origin} failed:`, err);
      return 0;
    }
  }

  async #loadOrCreateKeys(): Promise<VapidKeys> {
    try {
      const raw = JSON.parse(await readFile(this.#keysPath, 'utf8')) as Partial<VapidKeys>;
      if (typeof raw.publicKey === 'string' && typeof raw.privateKey === 'string') {
        return { publicKey: raw.publicKey, privateKey: raw.privateKey };
      }
      throw new Error(`${this.#keysPath} does not hold a key pair`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    const keys = generateVapidKeys();
    await mkdir(this.#options.dir, { recursive: true });
    await writeFile(this.#keysPath, `${JSON.stringify(keys, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(this.#keysPath, 0o600).catch(() => undefined);
    log.info(`Created a VAPID key pair in ${this.#keysPath} — keep it with the rest of the config`);
    return keys;
  }

  async #save(): Promise<void> {
    try {
      await mkdir(this.#options.dir, { recursive: true });
      // Write-then-rename, as prefs.ts does, so a container killed mid-write
      // keeps the previous file rather than a truncated one.
      const tmp = `${this.#subsPath}.tmp`;
      const file = { schema: 1, subscriptions: [...this.#subs.values()] };
      await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, this.#subsPath);
    } catch (err) {
      log.warn(`Could not persist push subscriptions to ${this.#subsPath}:`, err);
    }
  }
}

function parseTarget(value: unknown): PushTarget | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const keys = v['keys'] as Record<string, unknown> | undefined;
  const endpoint = v['endpoint'];
  const p256dh = keys?.['p256dh'];
  const auth = keys?.['auth'];
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return null;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  if (Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length !== 16) return null;
  return { endpoint, keys: { p256dh, auth } };
}

function parseStored(value: unknown): StoredSubscription | null {
  const target = parseTarget(value);
  if (!target) return null;
  const v = value as Record<string, unknown>;
  return {
    ...target,
    categories: parseCategories(v['categories']),
    panel: panelIdOf(v['panel']),
    createdAt: typeof v['createdAt'] === 'string' ? v['createdAt'] : new Date().toISOString(),
  };
}

function parseCategories(value: unknown): NotificationCategory[] {
  if (!Array.isArray(value)) return [];
  return NOTIFICATION_CATEGORIES.filter((c) => value.includes(c));
}

function parseMessage(input: unknown): PushMessage {
  const v = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const title = typeof v['title'] === 'string' ? v['title'].trim() : '';
  if (!title) throw new PushRequestError('A notification needs a title');

  const category = v['category'];
  if (category !== undefined && !NOTIFICATION_CATEGORIES.includes(category as NotificationCategory)) {
    throw new PushRequestError(`Unknown category "${String(category)}"`);
  }

  // Same-origin paths only: the service worker opens this, and a notification
  // that could open any site would be a phishing link with the panel's name.
  const url = typeof v['url'] === 'string' ? v['url'] : undefined;
  if (url !== undefined && (!url.startsWith('/') || url.startsWith('//') || url.length > LIMITS.url)) {
    throw new PushRequestError('url must be a path on this server, like /');
  }

  const panel = v['panel'];
  if (panel !== undefined && panel !== null && panelIdOf(panel) === null) {
    throw new PushRequestError(`"${String(panel)}" is not a panel id`);
  }

  return {
    title: title.slice(0, LIMITS.title),
    ...(typeof v['body'] === 'string' ? { body: v['body'].slice(0, LIMITS.body) } : {}),
    ...(category !== undefined ? { category: category as NotificationCategory } : {}),
    ...(typeof v['tag'] === 'string' && v['tag'] ? { tag: v['tag'].slice(0, LIMITS.tag) } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(panel !== undefined && panel !== null ? { panel: panelIdOf(panel) } : {}),
  };
}
