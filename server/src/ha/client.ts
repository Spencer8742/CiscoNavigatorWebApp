import { WebSocket } from 'ws';
import { Backoff } from '@shared/backoff.ts';
import { logger } from '~/lib/log.ts';
import type { Env } from '~/env.ts';
import type { HaEntityEvent, HaIncoming } from '~/ha/protocol.ts';

const log = logger('ha');

/**
 * The single WebSocket connection to Home Assistant.
 *
 * One connection for the whole house, held by the backend, shared by every
 * panel. That is the point of the design: panels connect and disconnect
 * freely (RoomOS restarts the web view daily) without ever renegotiating with
 * Home Assistant, and the token stays in this process.
 *
 * Connection sequence, per HA's documented protocol:
 *
 *   HA  → { "type": "auth_required" }
 *   us  → { "type": "auth", "access_token": … }
 *   HA  → { "type": "auth_ok" }
 *   us  → { "id": 1, "type": "supported_features",
 *           "features": { "coalesce_messages": 1 } }
 *   us  → { "id": 2, "type": "subscribe_entities" }
 *   HA  → { "id": 2, "type": "event", "event": { "a": { …all states… } } }
 *
 * `coalesce_messages` matters more than it looks: a scene that switches
 * twenty lights arrives as ONE frame instead of twenty, which is twenty times
 * fewer parse-and-fan-out cycles during exactly the burst that would
 * otherwise be visible as jank on the panel.
 */

export type HaLinkState = 'connected' | 'connecting' | 'disconnected';

export interface HaClientEvents {
  onEntityEvent(event: HaEntityEvent): void;
  onStateChange(state: HaLinkState): void;
  /** Fired when a fresh subscription is about to replace the whole world. */
  onResubscribe(): void;
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** A service call that hasn't come back in this long is not coming back. */
const CALL_TIMEOUT_MS = 10_000;
/** Application-level ping interval — catches half-open sockets. */
const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;
/**
 * A rejected token will be rejected again in 500 ms. Retrying on the normal
 * curve would mean hammering HA's auth path forever and burying the one log
 * line that explains the problem.
 */
const AUTH_FAILURE_RETRY_MS = 300_000;

export class HaClient {
  readonly #env: Env['ha'];
  readonly #events: HaClientEvents;
  readonly #backoff = new Backoff({ baseMs: 500, maxMs: 30_000 });

  #ws: WebSocket | null = null;
  #state: HaLinkState = 'disconnected';
  #closed = false;

  /** HA requires ids to be monotonically increasing per connection. */
  #seq = 0;
  #subscriptionId = 0;
  #pending = new Map<number, Pending>();

  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #pongTimer: ReturnType<typeof setTimeout> | undefined;

  #lastMessageAt: number | null = null;

  constructor(env: Env['ha'], events: HaClientEvents) {
    this.#env = env;
    this.#events = events;
  }

  get state(): HaLinkState {
    return this.#state;
  }

  get lastMessageAt(): number | null {
    return this.#lastMessageAt;
  }

  start(): void {
    if (!this.#env.enabled) {
      log.warn('Home Assistant is not configured — client not started');
      return;
    }
    this.#closed = false;
    this.#open();
  }

  stop(): void {
    this.#closed = true;
    clearTimeout(this.#reconnectTimer);
    this.#clearTimers();
    this.#failPending(new Error('client stopped'));
    this.#ws?.close();
    this.#ws = null;
    this.#setState('disconnected');
  }

  /* ── Connection ────────────────────────────────────────────────────────*/

  #open(): void {
    if (this.#closed) return;

    const url = this.#wsUrl();
    this.#setState('connecting');
    log.debug(`Connecting to ${url}`);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, {
        // Opt-out only, and warned about at boot. Prefer mounting the CA.
        rejectUnauthorized: !this.#env.insecureTls,
        handshakeTimeout: 10_000,
      });
    } catch (err) {
      log.error('Failed to create WebSocket:', err);
      this.#scheduleReconnect();
      return;
    }

    this.#ws = ws;
    this.#seq = 0;

    ws.on('open', () => {
      log.debug('Socket open, waiting for auth_required');
    });

    ws.on('message', (data) => {
      this.#lastMessageAt = Date.now();
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        log.warn('Received unparseable frame from Home Assistant');
        return;
      }

      // With coalesce_messages enabled, HA batches several messages into a
      // single JSON array. Without this branch everything after the first
      // burst is silently dropped — and it only shows up under load, which
      // is the worst possible time to discover it.
      if (Array.isArray(parsed)) {
        for (const msg of parsed) this.#handle(msg);
      } else {
        this.#handle(parsed);
      }
    });

    ws.on('close', (code) => {
      if (ws !== this.#ws) return; // stale socket we already replaced
      this.#ws = null;
      this.#clearTimers();
      this.#failPending(new Error('connection closed'));
      this.#setState(this.#closed ? 'disconnected' : 'connecting');
      if (!this.#closed) {
        log.warn(`Connection closed (code ${code}) — reconnecting`);
        this.#scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      // 'close' always follows, and that is where reconnection happens.
      // Logged at debug because a down HA produces one of these per attempt
      // and they would otherwise drown the log during an outage.
      log.debug('Socket error:', err.message);
    });
  }

  #wsUrl(): string {
    const base = this.#env.url.replace(/^http/, 'ws');
    return `${base}/api/websocket`;
  }

  #scheduleReconnect(delayMs?: number): void {
    if (this.#closed) return;
    clearTimeout(this.#reconnectTimer);
    const delay = delayMs ?? this.#backoff.next();
    log.debug(`Reconnecting in ${delay}ms (attempt ${this.#backoff.attempt})`);
    this.#reconnectTimer = setTimeout(() => this.#open(), delay);
  }

  #setState(next: HaLinkState): void {
    if (this.#state === next) return;
    this.#state = next;
    this.#events.onStateChange(next);
  }

  /* ── Message handling ──────────────────────────────────────────────────*/

  #handle(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null || !('type' in raw)) return;
    const msg = raw as HaIncoming;

    switch (msg.type) {
      case 'auth_required':
        this.#send({ type: 'auth', access_token: this.#env.token });
        break;

      case 'auth_ok': {
        const version = 'ha_version' in msg ? msg.ha_version : 'unknown';
        log.info(`Authenticated with Home Assistant ${version}`);
        this.#afterAuth();
        break;
      }

      case 'auth_invalid': {
        const detail = 'message' in msg && msg.message ? msg.message : 'no reason given';
        log.error(
          `Home Assistant rejected the access token (${detail}). ` +
            'Check HA_TOKEN. Retrying in 5 minutes — a bad token will not fix ' +
            'itself, and retrying faster would only bury this message.',
        );
        this.#ws?.close();
        this.#scheduleReconnect(AUTH_FAILURE_RETRY_MS);
        break;
      }

      case 'event':
        if ('event' in msg && msg.id === this.#subscriptionId) {
          this.#events.onEntityEvent(msg.event);
        }
        break;

      case 'pong':
        clearTimeout(this.#pongTimer);
        this.#pongTimer = undefined;
        break;

      case 'result': {
        if (!('id' in msg)) break;
        const pending = this.#pending.get(msg.id);
        if (!pending) break;
        this.#pending.delete(msg.id);
        clearTimeout(pending.timer);

        if (msg.success) {
          pending.resolve(msg.result);
        } else {
          const error = msg.error;
          pending.reject(new Error(error ? `${error.code}: ${error.message}` : 'call failed'));
        }
        break;
      }

      default:
        // HA sends message types we don't subscribe to; ignoring them is
        // correct, not an error.
        break;
    }
  }

  #afterAuth(): void {
    // Must be id 1 and the first message after auth, per the protocol.
    this.#send({
      id: this.#nextId(),
      type: 'supported_features',
      features: { coalesce_messages: 1 },
    });

    // Tell the store the world is about to be replaced wholesale, so it can
    // diff the incoming snapshot against what it already had and send panels
    // only what actually changed while the link was down — rather than a
    // full repaint of every card.
    this.#events.onResubscribe();

    this.#subscriptionId = this.#nextId();
    this.#send({ id: this.#subscriptionId, type: 'subscribe_entities' });

    this.#setState('connected');
    this.#backoff.reset();
    this.#startPing();
  }

  /* ── Liveness ──────────────────────────────────────────────────────────*/

  #startPing(): void {
    clearInterval(this.#pingTimer);
    this.#pingTimer = setInterval(() => {
      if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
      this.#send({ id: this.#nextId(), type: 'ping' });

      if (this.#pongTimer) return;
      this.#pongTimer = setTimeout(() => {
        this.#pongTimer = undefined;
        // No pong. The socket is dead even though the OS still thinks it is
        // open — a Wi-Fi roam or an AP reboot does exactly this, and TCP can
        // take minutes to notice.
        log.warn('Home Assistant did not answer a ping — reconnecting');
        this.#ws?.terminate();
      }, PING_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  #clearTimers(): void {
    clearInterval(this.#pingTimer);
    clearTimeout(this.#pongTimer);
    this.#pingTimer = undefined;
    this.#pongTimer = undefined;
  }

  /* ── Sending ───────────────────────────────────────────────────────────*/

  #nextId(): number {
    this.#seq += 1;
    return this.#seq;
  }

  #send(msg: Record<string, unknown>): boolean {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.#ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      log.warn('Send failed:', err);
      return false;
    }
  }

  /**
   * Call a service and wait for Home Assistant's result.
   *
   * The panel does not wait for this — it has already updated optimistically
   * and the authoritative state arrives on the subscription. We await it here
   * only so a genuine failure (a bad service, an unavailable device) can be
   * surfaced as a toast rather than vanishing.
   */
  callService(
    domain: string,
    service: string,
    entityId: string,
    data?: Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.#state !== 'connected') {
        reject(new Error('Home Assistant is not connected'));
        return;
      }

      const id = this.#nextId();
      const sent = this.#send({
        id,
        type: 'call_service',
        domain,
        service,
        target: { entity_id: entityId },
        ...(data && Object.keys(data).length > 0 ? { service_data: data } : {}),
      });

      if (!sent) {
        reject(new Error('Home Assistant is not connected'));
        return;
      }

      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('Home Assistant did not respond'));
      }, CALL_TIMEOUT_MS);

      this.#pending.set(id, { resolve, reject, timer });
    });
  }

  #failPending(error: Error): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
