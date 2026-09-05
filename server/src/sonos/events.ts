import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '~/lib/log.ts';
import { authority, SONOS_PORT } from '~/sonos/soap.ts';
import { find, findAll, parseXml } from '~/sonos/xml.ts';

const log = logger('sonos-events');

/**
 * UPnP event subscriptions — the reason nothing polls any more.
 *
 * This is the one place in the whole app where an upstream connects **to us**.
 * Home Assistant, Immich and Companion are all outbound; a
 * Sonos speaker instead takes a callback URL and POSTs `NOTIFY` to it whenever
 * something changes. That inverts the trust and the networking, and both cost
 * something:
 *
 *  - **The route cannot carry a bearer token.** A speaker has nowhere to put
 *    one. See `#guard` for the three checks that replace it.
 *  - **The callback address has to be reachable from the speaker.** `0.0.0.0`
 *    is not one, and on a Docker bridge network neither is the container's own
 *    address. See `discoverCallbackHost`.
 *
 * ## The protocol
 *
 *   us → SUBSCRIBE /MediaRenderer/AVTransport/Event
 *        CALLBACK: <http://192.168.1.20:8099/sonos/event/<secret>>
 *        NT: upnp:event
 *        TIMEOUT: Second-3600
 *
 *   speaker → 200, SID: uuid:RINCON_…, TIMEOUT: Second-3600
 *   speaker → NOTIFY … (immediately, carrying current state)
 *   speaker → NOTIFY … (whenever anything changes)
 *
 * Two details are load-bearing:
 *
 * **The first event arrives unprompted, straight after subscribing.** That is
 * what makes this replace the poll rather than supplement it — the initial
 * read comes for free, and its absence is the signal that our callback URL is
 * unreachable.
 *
 * **Unsubscribing on shutdown is not optional.** A subscription outlives the
 * process that made it, so a container that restarts a few times a day leaves
 * speakers POSTing at a dead endpoint until each subscription ages out. Home
 * Assistant has a filed bug for exactly this.
 */

/** What we ask for. Speakers grant this or less; the reply is authoritative. */
const SUBSCRIBE_SECONDS = 3600;

/** Renew at half the granted lifetime, so one lost renewal is not a gap. */
const RENEW_FRACTION = 0.5;

/** A subscribe or renew that hangs should not hold up the rest. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * How long to wait for the first event before declaring the callback unusable.
 *
 * Generous: this is measuring a LAN round trip plus whatever the speaker feels
 * like, and calling it broken early would be worse than calling it late.
 */
const FIRST_EVENT_GRACE_MS = 20_000;

/** The services worth listening to, and where their event endpoints live. */
export const EVENT_PATHS = {
  ZoneGroupTopology: '/ZoneGroupTopology/Event',
  AVTransport: '/MediaRenderer/AVTransport/Event',
  RenderingControl: '/MediaRenderer/RenderingControl/Event',
} as const;

export type EventService = keyof typeof EVENT_PATHS;

/** One thing a speaker told us. */
export interface SonosEvent {
  service: EventService;
  /** The zone the subscription was made against. */
  uuid: string;
  /**
   * Property name → value, already unescaped one level.
   *
   * For AVTransport and RenderingControl the interesting content is inside
   * `LastChange`, which is itself XML. `parseLastChange` takes it from here.
   */
  properties: Map<string, string>;
}

interface Subscription {
  uuid: string;
  host: string;
  service: EventService;
  sid: string | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Set once this subscription has delivered anything at all. */
  heard: boolean;
}

export interface SonosEventsDeps {
  onEvent(event: SonosEvent): void;
  /**
   * Called when subscriptions exist but nothing has ever arrived.
   *
   * The single most likely cause is Docker bridge networking, where our
   * callback address is unreachable from the LAN. Commands still work, so
   * without this the panel simply goes stale and looks frozen — the exact
   * failure `docs/SONOS.md` §6 says to make loud rather than silent.
   */
  onSilence(message: string): void;
  /** Override for the callback address, from SONOS_CALLBACK_HOST. */
  callbackHost: string;
  /** The port this backend is listening on. */
  port: number;
}

export class SonosEvents {
  readonly #deps: SonosEventsDeps;

  /**
   * The secret in the callback path.
   *
   * Minted per boot, never persisted, never sent to the panel. It is not the
   * only guard — see `#guard` — but it means a scan of the LAN cannot find the
   * endpoint by guessing a path.
   */
  readonly #secret = randomBytes(16).toString('hex');

  /** `${uuid}:${service}` → subscription. */
  readonly #subs = new Map<string, Subscription>();
  /** SID → key, so a NOTIFY can be matched to something we asked for. */
  readonly #bySid = new Map<string, string>();
  /** Addresses we will accept a NOTIFY from: the household, as last known. */
  #allowedHosts = new Set<string>();

  #callbackUrl: string | null = null;
  #closed = false;
  #silenceTimer: ReturnType<typeof setTimeout> | undefined;
  #reportedSilence = false;
  #lastEventAt: number | null = null;

  constructor(deps: SonosEventsDeps) {
    this.#deps = deps;
  }

  /** The path the HTTP router matches. Constant for the life of the process. */
  get path(): string {
    return `/sonos/event/${this.#secret}`;
  }

  get subscriptionCount(): number {
    return this.#subs.size;
  }

  /** The address we asked the speakers to POST to, once it is known. */
  get callbackUrl(): string | null {
    return this.#callbackUrl;
  }

  /** When a speaker last told us anything. Null if one never has. */
  get lastEventAt(): number | null {
    return this.#lastEventAt;
  }

  /**
   * Whether pushed events are actually reaching us.
   *
   * A speaker sends its current state the moment you subscribe, without being
   * asked — so having heard nothing from ANY subscription is a reliable
   * verdict on the callback path rather than a guess about how quiet the
   * house is. That is what makes it safe to switch to polling on.
   */
  get healthy(): boolean {
    for (const sub of this.#subs.values()) {
      if (sub.heard) return true;
    }
    return false;
  }

  /**
   * Bring subscriptions in line with the household.
   *
   * Idempotent, and called after every topology change: a speaker that joined
   * a group needs its AVTransport subscription dropped (its coordinator's now
   * speaks for it) and one that left needs its own back.
   */
  async sync(
    zones: { uuid: string; host: string; coordinator: string }[],
    seedHost: string,
  ): Promise<void> {
    if (this.#closed) return;

    this.#allowedHosts = new Set(zones.map((z) => hostOnly(z.host)));

    if (!this.#callbackUrl) {
      const host = await this.#resolveCallbackHost(seedHost);
      if (!host) {
        this.#deps.onSilence(
          'Could not work out an address for Sonos speakers to send events to. ' +
            'Set SONOS_CALLBACK_HOST to this machine’s LAN address.',
        );
        return;
      }
      this.#callbackUrl = `http://${host}:${this.#deps.port}${this.path}`;
      log.info(`Sonos events will be delivered to ${this.#callbackUrl}`);
    }

    const wanted = new Map<string, { uuid: string; host: string; service: EventService }>();

    // Topology is household-wide, so exactly one subscription serves it. The
    // seed is whichever zone sorts first, purely so a reconnect picks the same
    // one rather than churning subscriptions for no reason.
    const [first] = [...zones].sort((a, b) => a.uuid.localeCompare(b.uuid));
    if (first) {
      wanted.set(key(first.uuid, 'ZoneGroupTopology'), {
        uuid: first.uuid,
        host: first.host,
        service: 'ZoneGroupTopology',
      });
    }

    for (const zone of zones) {
      // Volume and mute are per speaker, always.
      wanted.set(key(zone.uuid, 'RenderingControl'), {
        uuid: zone.uuid,
        host: zone.host,
        service: 'RenderingControl',
      });

      // Transport is per GROUP. A follower's own AVTransport reports STOPPED
      // while it is audibly playing, so subscribing to it would deliver a
      // stream of confidently wrong states.
      if (zone.coordinator === zone.uuid) {
        wanted.set(key(zone.uuid, 'AVTransport'), {
          uuid: zone.uuid,
          host: zone.host,
          service: 'AVTransport',
        });
      }
    }

    for (const [k, sub] of [...this.#subs]) {
      if (!wanted.has(k)) await this.#unsubscribe(k, sub);
    }

    for (const [k, want] of wanted) {
      const existing = this.#subs.get(k);
      if (existing) {
        // The speaker may have moved. Re-subscribing at the new address is
        // cheaper than reasoning about whether the old SID still routes.
        if (existing.host === want.host) continue;
        await this.#unsubscribe(k, existing);
      }
      await this.#subscribe(k, want.uuid, want.host, want.service);
    }

    this.#armSilenceCheck();
  }

  /** Drop every subscription. Speakers stop sending immediately. */
  async stop(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#silenceTimer);
    this.#silenceTimer = undefined;

    const all = [...this.#subs];
    // In parallel and best-effort: this runs inside SIGTERM's ten-second
    // window, and a speaker that is itself offline must not hold up shutdown.
    await Promise.all(all.map(([k, sub]) => this.#unsubscribe(k, sub)));
  }

  /* ── Inbound ───────────────────────────────────────────────────────────*/

  /**
   * Handle one NOTIFY.
   *
   * Answers 200 for anything it accepts and 412 for anything it does not,
   * which is the code UPnP defines for "that subscription is not valid" and
   * makes a well-behaved speaker stop rather than retry.
   */
  handle(req: IncomingMessage, res: ServerResponse): void {
    const problem = this.#guard(req);
    if (problem) {
      log.debug(`Refused a NOTIFY: ${problem}`);
      res.writeHead(412, { 'content-type': 'text/plain' });
      res.end('Precondition Failed');
      return;
    }

    const sid = String(req.headers['sid'] ?? '');
    const k = this.#bySid.get(sid);
    const sub = k ? this.#subs.get(k) : undefined;
    if (!sub) {
      res.writeHead(412, { 'content-type': 'text/plain' });
      res.end('Unknown subscription');
      return;
    }

    let body = '';
    let size = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      size += chunk.length;
      // A speaker sends a few kilobytes. Anything vastly larger is not a
      // speaker, and this endpoint is unauthenticated.
      if (size > 512 * 1024) {
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      // Acknowledge first. A speaker that does not get a prompt 200 retries,
      // and parsing is not something it should be made to wait on.
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('OK');

      this.#lastEventAt = Date.now();

      if (!sub.heard) {
        sub.heard = true;
        // Info rather than debug: the FIRST event is the one that proves the
        // callback path works at all, and it is the single fact anyone
        // debugging a stale panel needs from the log.
        log.info(`Sonos events are arriving (${sub.service} from ${sub.uuid})`);
      }

      const properties = parsePropertySet(body);
      if (properties.size === 0) return;

      this.#deps.onEvent({ service: sub.service, uuid: sub.uuid, properties });
    });

    req.on('error', () => {
      // The socket died mid-body. Nothing to do; the speaker will resend on
      // the next change.
    });
  }

  /**
   * Three checks, standing in for the bearer token this route cannot have.
   *
   * Any one of them alone would be weak. Together they mean an attacker needs
   * to be on the LAN, at a household member's address, holding a subscription
   * id this process minted, and to have guessed a 128-bit path.
   */
  #guard(req: IncomingMessage): string | null {
    const url = req.url ?? '';
    const path = url.split('?')[0] ?? '';
    if (path !== this.path) return 'wrong path';

    const from = normaliseIp(req.socket.remoteAddress ?? '');
    if (from && this.#allowedHosts.size > 0 && !this.#allowedHosts.has(from)) {
      return `${from} is not a household member`;
    }

    const sid = req.headers['sid'];
    if (typeof sid !== 'string' || !this.#bySid.has(sid)) return 'unknown SID';

    return null;
  }

  /* ── Outbound ──────────────────────────────────────────────────────────*/

  async #subscribe(k: string, uuid: string, host: string, service: EventService): Promise<void> {
    if (this.#closed || !this.#callbackUrl) return;

    const sub: Subscription = { uuid, host, service, sid: null, timer: undefined, heard: false };
    this.#subs.set(k, sub);

    try {
      const reply = await request(host, EVENT_PATHS[service], {
        CALLBACK: `<${this.#callbackUrl}>`,
        NT: 'upnp:event',
        TIMEOUT: `Second-${SUBSCRIBE_SECONDS}`,
      });

      const sid = reply.headers['sid'];
      if (!sid) {
        log.warn(`${host} accepted a ${service} subscription but sent no SID`);
        this.#subs.delete(k);
        return;
      }

      sub.sid = sid;
      this.#bySid.set(sid, k);
      this.#scheduleRenew(k, sub, secondsOf(reply.headers['timeout']));
    } catch (err) {
      // Warn, not debug: a subscription that never happened is the difference
      // between a live panel and one that quietly stops keeping up, and the
      // reason is worth having in the log without raising the level.
      const detail = err instanceof Error ? err.message : String(err);
      log.warn(`Could not subscribe to ${service} on ${host}: ${detail}`);
      this.#subs.delete(k);
    }
  }

  #scheduleRenew(k: string, sub: Subscription, granted: number): void {
    clearTimeout(sub.timer);
    const delay = Math.max(60, Math.floor(granted * RENEW_FRACTION)) * 1000;

    sub.timer = setTimeout(() => void this.#renew(k, sub), delay);
    sub.timer.unref();
  }

  async #renew(k: string, sub: Subscription): Promise<void> {
    if (this.#closed || !sub.sid) return;

    try {
      const reply = await request(sub.host, EVENT_PATHS[sub.service], { SID: sub.sid });
      this.#scheduleRenew(k, sub, secondsOf(reply.headers['timeout']));
    } catch (err) {
      /*
       * A renewal fails when the subscription has already lapsed — the speaker
       * answers 412 — or when it rebooted and forgot. Both are fixed the same
       * way: forget the SID and subscribe fresh. Retrying the renewal would
       * fail identically forever.
       */
      log.debug(`Renewing ${sub.service} on ${sub.host} failed, resubscribing:`, err);
      this.#forget(k, sub);
      await this.#subscribe(k, sub.uuid, sub.host, sub.service);
    }
  }

  async #unsubscribe(k: string, sub: Subscription): Promise<void> {
    const sid = sub.sid;
    this.#forget(k, sub);
    if (!sid) return;

    try {
      await request(sub.host, EVENT_PATHS[sub.service], { SID: sid }, 'UNSUBSCRIBE');
    } catch {
      // Best effort. A speaker that is already gone has already forgotten us,
      // and one that is merely slow will age the subscription out by itself.
    }
  }

  #forget(k: string, sub: Subscription): void {
    clearTimeout(sub.timer);
    sub.timer = undefined;
    if (sub.sid) this.#bySid.delete(sub.sid);
    sub.sid = null;
    this.#subs.delete(k);
  }

  /* ── Is anything actually arriving? ────────────────────────────────────*/

  #armSilenceCheck(): void {
    if (this.#reportedSilence || this.#subs.size === 0) return;
    clearTimeout(this.#silenceTimer);

    this.#silenceTimer = setTimeout(() => {
      this.#silenceTimer = undefined;
      if (this.healthy || this.#subs.size === 0) return;

      this.#reportedSilence = true;
      this.#deps.onSilence(
        `The speakers cannot reach ${this.#callbackUrl ?? 'this backend'}, so live updates ` +
          'are off and the panel is polling instead. On Docker this means bridge ' +
          'networking: use host networking, or set SONOS_CALLBACK_HOST to an address the ' +
          'speakers can reach (your Docker host’s LAN IP) and publish the port.',
      );
    }, FIRST_EVENT_GRACE_MS);
    this.#silenceTimer.unref();
  }

  /**
   * Work out what address a speaker would see us at.
   *
   * Opening a socket and asking the kernel which local address it chose beats
   * every alternative: it is right on a multi-homed host, right across VLANs,
   * and needs no guess about which interface faces the speakers. What it
   * cannot do is see through Docker's bridge NAT — hence the override, and
   * hence `#armSilenceCheck` above.
   */
  async #resolveCallbackHost(seedHost: string): Promise<string | null> {
    if (this.#deps.callbackHost) return this.#deps.callbackHost;
    return localAddressFor(seedHost);
  }
}

/* ── Parsing ─────────────────────────────────────────────────────────────*/

/**
 * The outer envelope: `<e:propertyset><e:property><X>…</X></e:property>…`
 *
 * Values come back decoded exactly one level, which leaves `LastChange` as a
 * document for `parseLastChange` and `ZoneGroupState` as one for the topology
 * parser. Decoding further here would be the classic Sonos mistake.
 */
export function parsePropertySet(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const root = parseXml(body);
  if (!root) return out;

  for (const property of findAll(root, 'property')) {
    for (const child of property.children) {
      const name = localName(child.name);
      if (name) out.set(name, child.text);
    }
  }
  return out;
}

/**
 * The inner `LastChange` document.
 *
 * Shaped unlike anything else in Sonos: values live in `val` ATTRIBUTES rather
 * than in text, one `<InstanceID>` wraps them all, and RenderingControl
 * repeats several of them per channel.
 *
 *   <Event><InstanceID val="0">
 *     <TransportState val="PLAYING"/>
 *     <Volume channel="Master" val="35"/>
 *     <CurrentTrackMetaData val="&lt;DIDL-Lite&gt;…"/>
 *   </InstanceID></Event>
 *
 * Only the Master channel is kept: a stereo pair reports LF and RF separately
 * and neither is the number anyone means by "the volume".
 */
export function parseLastChange(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  const root = parseXml(xml);
  const instance = find(root, 'InstanceID');
  if (!instance) return out;

  for (const child of instance.children) {
    const channel = child.attrs['channel'];
    if (channel !== undefined && channel !== 'Master') continue;

    const val = child.attrs['val'];
    if (val === undefined) continue;

    const name = localName(child.name);
    if (name) out.set(name, val);
  }
  return out;
}

function localName(raw: string): string {
  const colon = raw.indexOf(':');
  return colon === -1 ? raw : raw.slice(colon + 1);
}

/* ── HTTP with methods `fetch` will not send ─────────────────────────────*/

interface SubscribeReply {
  headers: Record<string, string>;
}

/**
 * SUBSCRIBE / UNSUBSCRIBE, over a raw socket.
 *
 * `fetch` cannot send these — they are not HTTP methods it recognises — and
 * this is the only place in the app that needs anything but GET and POST.
 * Small enough to write out; the alternative is a dependency for two verbs.
 */
function request(
  host: string,
  path: string,
  headers: Record<string, string>,
  method: 'SUBSCRIBE' | 'UNSUBSCRIBE' = 'SUBSCRIBE',
): Promise<SubscribeReply> {
  const target = authority(host);
  const [hostname, port] = splitAuthority(target);

  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port });
    let raw = '';
    let settled = false;

    const done = (err: Error | null, reply?: SubscribeReply): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(reply as SubscribeReply);
    };

    const timer = setTimeout(() => done(new Error('timed out')), REQUEST_TIMEOUT_MS);

    socket.on('connect', () => {
      const lines = [
        `${method} ${path} HTTP/1.1`,
        `HOST: ${target}`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        'CONTENT-LENGTH: 0',
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));
    });

    socket.on('data', (chunk) => {
      raw += chunk.toString('latin1');
      const end = raw.indexOf('\r\n\r\n');
      if (end === -1) {
        if (raw.length > 64 * 1024) done(new Error('reply too large'));
        return;
      }

      const head = raw.slice(0, end).split('\r\n');
      const status = Number.parseInt(head[0]?.split(' ')[1] ?? '', 10);

      if (!Number.isFinite(status) || status < 200 || status >= 300) {
        done(new Error(`${method} failed (HTTP ${status || '?'})`));
        return;
      }

      const parsed: Record<string, string> = {};
      for (const line of head.slice(1)) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        parsed[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      done(null, { headers: parsed });
    });

    socket.on('error', (err) => done(err));
    socket.on('close', () => done(new Error('connection closed')));
  });
}

/** `Second-3600` → 3600. Anything else, including `infinite`, falls back. */
function secondsOf(raw: string | undefined): number {
  const match = /second-(\d+)/i.exec(raw ?? '');
  const n = match?.[1] ? Number.parseInt(match[1], 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : SUBSCRIBE_SECONDS;
}

/** Ask the kernel which of our addresses reaches this speaker. */
export function localAddressFor(host: string): Promise<string | null> {
  const [hostname, port] = splitAuthority(authority(host));

  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port });
    let settled = false;

    const finish = (address: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(address);
    };

    const timer = setTimeout(() => finish(null), REQUEST_TIMEOUT_MS);
    socket.on('connect', () => finish(normaliseIp(socket.localAddress ?? '') || null));
    socket.on('error', () => finish(null));
  });
}

function splitAuthority(target: string): [string, number] {
  const bracket = target.lastIndexOf(']');
  const colon = target.lastIndexOf(':');
  if (colon > bracket) {
    const port = Number.parseInt(target.slice(colon + 1), 10);
    const host = target.slice(0, colon).replace(/^\[|]$/g, '');
    return [host, Number.isFinite(port) ? port : SONOS_PORT];
  }
  return [target.replace(/^\[|]$/g, ''), SONOS_PORT];
}

/** Drop the port, and unwrap the IPv4-mapped IPv6 form Node hands back. */
function hostOnly(target: string): string {
  return normaliseIp(splitAuthority(target)[0]);
}

/**
 * `::ffff:192.168.1.51` → `192.168.1.51`.
 *
 * Node reports a remote address in that form on a dual-stack listener, so
 * comparing it to an address parsed out of a device description would never
 * match and every event would be refused as "not a household member".
 */
function normaliseIp(raw: string): string {
  const lower = raw.trim().toLowerCase();
  return lower.startsWith('::ffff:') ? lower.slice(7) : lower;
}

function key(uuid: string, service: EventService): string {
  return `${uuid}:${service}`;
}
