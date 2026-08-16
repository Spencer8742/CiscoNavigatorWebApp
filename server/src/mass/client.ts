import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { Backoff } from '@shared/backoff.ts';
import { logger } from '~/lib/log.ts';
import type { Env } from '~/env.ts';

const log = logger('mass');

/**
 * The direct connection to Music Assistant.
 *
 * Everything about music — which speakers exist, what they are playing, how
 * loud, what is in the queue, and the whole library — comes through here
 * rather than through Home Assistant. Home Assistant remains the source of
 * truth for the house: lights, locks, covers, sensors.
 *
 * ## Why a second connection at all
 *
 * The Music Assistant *integration* exposes a deliberately small slice of
 * Music Assistant through Home Assistant: play, pause, volume, join, and a
 * handful of services that answer library questions. Three things a wall panel
 * wants are simply not in that slice:
 *
 *  - **the queue.** `music_assistant.get_queue` returns the current item, the
 *    next item and a count. Reordering, removing and jumping to a track exist
 *    only here.
 *  - **real play history.** `music/recently_played_items` is an actual
 *    history; the integration can only sort a library by last-played, which
 *    cannot show something you played that you do not own.
 *  - **push.** Music Assistant emits `queue_items_updated` the moment anything
 *    changes it. Through Home Assistant the same fact has to be re-fetched.
 *
 * ## Protocol
 *
 *   us  → (connect ws://host:8095/ws)
 *   MA  → { server_id, server_version, schema_version, … }   ← unsolicited
 *   us  → { message_id, command: "auth", args: { token } }   ← schema ≥ 28
 *   MA  → { message_id, result: … }
 *   us  → { message_id, command: "players/all", args: {} }
 *   MA  → { message_id, result: [ … ] }
 *   MA  → { event: "player_updated", object_id: …, data: … }  ← any time
 *
 * Two details in there are easy to miss and expensive to get wrong:
 *
 * **Partial results.** A large library page comes back as several messages
 * with the same `message_id` and `partial: true`, terminated by one without
 * it. Treating the first as the whole answer silently truncates every long
 * list — and only for users with big libraries, which is the worst way to
 * find out.
 *
 * **The server info frame is unsolicited.** It arrives before anything is
 * asked for and has no `message_id`, so it has to be consumed as part of
 * connecting rather than dispatched like a reply.
 */

export type MassLinkState = 'connected' | 'connecting' | 'disconnected';

/** One event pushed by Music Assistant. */
export interface MassEvent {
  event: string;
  object_id?: string | null;
  data?: unknown;
}

export interface MassClientEvents {
  onEvent(event: MassEvent): void;
  onStateChange(state: MassLinkState): void;
  /** Fired once the link is up and authenticated — time to refetch state. */
  onReady(): void;
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  /** Accumulated chunks of a partial result. */
  partial: unknown[] | null;
}

/** Ordinary commands. Generous: a cold streaming provider is slow, not broken. */
const COMMAND_TIMEOUT_MS = 25_000;
const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;

/**
 * The schema version at which Music Assistant began requiring a token.
 * Below it, `auth` is not a command the server knows.
 */
const AUTH_FROM_SCHEMA = 28;

/**
 * A rejected or missing token will be rejected again in half a second.
 * Retrying on the normal curve would bury the one log line that says what to
 * fix — the same reasoning as the Home Assistant client.
 */
const AUTH_FAILURE_RETRY_MS = 300_000;

export interface MassServerInfo {
  serverId: string;
  serverVersion: string;
  schemaVersion: number;
  minSupportedSchemaVersion: number;
  /** Where images live. Prefer internal_url; base_url is its old name. */
  baseUrl: string;
  name: string | null;
}

export class MassClient {
  readonly #env: Env['mass'];
  readonly #events: MassClientEvents;
  readonly #backoff = new Backoff({ baseMs: 500, maxMs: 30_000 });

  #ws: WebSocket | null = null;
  #state: MassLinkState = 'disconnected';
  #closed = false;
  /** Set when the token was refused, so health can say so specifically. */
  #authError: string | null = null;

  #info: MassServerInfo | null = null;
  #pending = new Map<string, Pending>();

  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #pongTimer: ReturnType<typeof setTimeout> | undefined;

  #lastMessageAt: number | null = null;

  constructor(env: Env['mass'], events: MassClientEvents) {
    this.#env = env;
    this.#events = events;
  }

  get state(): MassLinkState {
    return this.#state;
  }

  get info(): MassServerInfo | null {
    return this.#info;
  }

  get lastMessageAt(): number | null {
    return this.#lastMessageAt;
  }

  /** A specific reason the link is down, for the Settings screen. */
  get lastError(): string | null {
    return this.#authError;
  }

  get enabled(): boolean {
    return this.#env.enabled;
  }

  start(): void {
    if (!this.#env.enabled) {
      log.info('MASS_URL not set — Music Assistant client not started');
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

  #wsUrl(): string {
    const base = this.#env.url.replace(/^http/, 'ws');
    return base.endsWith('/ws') ? base : `${base}/ws`;
  }

  #open(): void {
    if (this.#closed) return;

    const url = this.#wsUrl();
    this.#setState('connecting');
    log.debug(`Connecting to ${url}`);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, {
        rejectUnauthorized: !this.#env.insecureTls,
        handshakeTimeout: 10_000,
        // Music Assistant sends whole library pages in one frame. The default
        // cap would drop the largest and most important replies.
        maxPayload: 32 * 1024 * 1024,
      });
    } catch (err) {
      log.error('Failed to create WebSocket:', err);
      this.#scheduleReconnect();
      return;
    }

    this.#ws = ws;
    this.#info = null;

    // Registered once per socket, NOT per ping. A `once` handler inside the
    // ping interval would add a listener every 30 seconds to a process that
    // runs for months.
    ws.on('pong', () => {
      clearTimeout(this.#pongTimer);
      this.#pongTimer = undefined;
    });

    ws.on('message', (data) => {
      this.#lastMessageAt = Date.now();
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        log.warn('Received unparseable frame from Music Assistant');
        return;
      }
      this.#handle(parsed);
    });

    ws.on('close', (code) => {
      if (ws !== this.#ws) return; // stale socket we already replaced
      this.#ws = null;
      this.#info = null;
      this.#clearTimers();
      this.#failPending(new Error('connection closed'));
      this.#setState(this.#closed ? 'disconnected' : 'connecting');
      if (!this.#closed) {
        log.warn(`Connection closed (code ${code}) — reconnecting`);
        this.#scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      // 'close' always follows and drives reconnection. Debug because a down
      // server produces one of these per attempt.
      log.debug('Socket error:', err.message);
    });
  }

  #scheduleReconnect(delayMs?: number): void {
    if (this.#closed) return;
    clearTimeout(this.#reconnectTimer);
    const delay = delayMs ?? this.#backoff.next();
    log.debug(`Reconnecting in ${delay}ms (attempt ${this.#backoff.attempt})`);
    this.#reconnectTimer = setTimeout(() => this.#open(), delay);
  }

  #setState(next: MassLinkState): void {
    if (this.#state === next) return;
    this.#state = next;
    this.#events.onStateChange(next);
  }

  /* ── Message handling ──────────────────────────────────────────────────*/

  #handle(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const msg = raw as Record<string, unknown>;

    // The server info frame: unsolicited, no message_id, sent once on connect.
    if (this.#info === null && typeof msg['server_id'] === 'string') {
      void this.#onServerInfo(msg);
      return;
    }

    if (typeof msg['event'] === 'string') {
      this.#events.onEvent(msg as unknown as MassEvent);
      return;
    }

    const id = msg['message_id'];
    if (typeof id !== 'string') return;
    const pending = this.#pending.get(id);
    if (!pending) return;

    if ('error_code' in msg) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      const detail = typeof msg['details'] === 'string' ? msg['details'] : null;
      pending.reject(new Error(detail ?? `error ${String(msg['error_code'])}`));
      return;
    }

    const result = msg['result'];

    /*
     * Chunked results. Every chunk but the last carries `partial: true`, and
     * each one's `result` is a slice of the eventual array. Anything that
     * treats the first chunk as the whole answer truncates long lists.
     */
    if (msg['partial'] === true) {
      pending.partial ??= [];
      if (Array.isArray(result)) pending.partial.push(...result);
      return;
    }

    this.#pending.delete(id);
    clearTimeout(pending.timer);

    if (pending.partial) {
      if (Array.isArray(result)) pending.partial.push(...result);
      pending.resolve(pending.partial);
    } else {
      pending.resolve(result);
    }
  }

  async #onServerInfo(msg: Record<string, unknown>): Promise<void> {
    const schema = typeof msg['schema_version'] === 'number' ? msg['schema_version'] : 0;
    const base =
      (typeof msg['internal_url'] === 'string' ? msg['internal_url'] : null) ??
      (typeof msg['base_url'] === 'string' ? msg['base_url'] : null) ??
      this.#env.url;

    this.#info = {
      serverId: String(msg['server_id']),
      serverVersion: typeof msg['server_version'] === 'string' ? msg['server_version'] : 'unknown',
      schemaVersion: schema,
      minSupportedSchemaVersion:
        typeof msg['min_supported_schema_version'] === 'number'
          ? msg['min_supported_schema_version']
          : 0,
      baseUrl: base.replace(/\/+$/, ''),
      name: typeof msg['name'] === 'string' ? msg['name'] : null,
    };

    if (schema >= AUTH_FROM_SCHEMA) {
      if (!this.#env.token) {
        this.#failAuth(
          `Music Assistant ${this.#info.serverVersion} (API schema ${schema}) requires a ` +
            'token. Create one in Music Assistant under Settings → Users, and set MASS_TOKEN.',
        );
        return;
      }
      try {
        const ok = await this.#request('auth', { token: this.#env.token });
        if (ok === false || ok === null || ok === undefined) {
          this.#failAuth('Music Assistant rejected MASS_TOKEN — it is invalid or expired.');
          return;
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.#failAuth(`Music Assistant rejected MASS_TOKEN (${detail}).`);
        return;
      }
    }

    this.#authError = null;
    log.info(
      `Connected to Music Assistant ${this.#info.serverVersion} ` +
        `(API schema ${schema}) at ${this.#info.baseUrl}`,
    );

    this.#setState('connected');
    this.#backoff.reset();
    this.#startPing();
    this.#events.onReady();
  }

  #failAuth(message: string): void {
    // Recorded so the Settings screen can show the actual reason rather than
    // a generic "disconnected" that gives nobody anything to act on.
    this.#authError = message;
    log.error(`${message} Retrying in 5 minutes.`);
    this.#ws?.close();
    this.#scheduleReconnect(AUTH_FAILURE_RETRY_MS);
  }

  /* ── Liveness ──────────────────────────────────────────────────────────*/

  #startPing(): void {
    clearInterval(this.#pingTimer);
    this.#pingTimer = setInterval(() => {
      const ws = this.#ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      // Protocol-level ping rather than an application command: Music
      // Assistant has no ping command, and a half-open socket after a Wi-Fi
      // roam is invisible to TCP for minutes.
      try {
        ws.ping();
      } catch {
        ws.terminate();
        return;
      }

      if (this.#pongTimer) return;
      this.#pongTimer = setTimeout(() => {
        this.#pongTimer = undefined;
        log.warn('Music Assistant did not answer a ping — reconnecting');
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

  /**
   * Run a command and wait for its result.
   *
   * Rejects rather than resolving empty when the link is down, so a caller
   * cannot mistake "not connected" for "your library is empty".
   */
  command(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#state !== 'connected') {
      return Promise.reject(new Error('Music Assistant is not connected'));
    }
    return this.#request(command, args);
  }

  /**
   * Fire a command without waiting.
   *
   * For transport controls, where the authoritative result arrives moments
   * later as a `player_updated` event anyway. Awaiting the ack would add a
   * round trip to every tap for nothing the user can see.
   */
  send(command: string, args: Record<string, unknown> = {}): boolean {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.#state !== 'connected') return false;
    try {
      ws.send(JSON.stringify({ message_id: randomUUID(), command, args }));
      return true;
    } catch (err) {
      log.warn(`Send of ${command} failed:`, err);
      return false;
    }
  }

  /**
   * The inner request, usable during the auth handshake — when `#state` is
   * deliberately not yet 'connected'.
   */
  #request(command: string, args: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const ws = this.#ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Music Assistant is not connected'));
        return;
      }

      const id = randomUUID();
      try {
        ws.send(JSON.stringify({ message_id: id, command, args }));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('Music Assistant did not respond'));
      }, COMMAND_TIMEOUT_MS);

      this.#pending.set(id, { resolve, reject, timer, partial: null });
    });
  }

  #failPending(error: Error): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  /**
   * Turn a Music Assistant image reference into a URL we can fetch.
   *
   * From schema 31 the server exposes a stable proxy id; before that the
   * original path has to be handed back with its provider. Both forms are
   * absolute URLs on the Music Assistant server, which is exactly why they
   * never reach the panel directly — see http/media-art.ts.
   */
  imageUrl(image: unknown, size = 512): string | null {
    const info = this.#info;
    if (!info || !image || typeof image !== 'object') return null;
    const img = image as Record<string, unknown>;

    const proxyId = img['proxy_id'];
    if (info.schemaVersion >= 31 && typeof proxyId === 'string' && proxyId) {
      return `${info.baseUrl}/imageproxy/${encodeURIComponent(proxyId)}?size=${size}`;
    }

    const path = img['path'];
    if (typeof path !== 'string' || !path) return null;
    const provider = typeof img['provider'] === 'string' ? img['provider'] : '';
    return (
      `${info.baseUrl}/imageproxy?path=${encodeURIComponent(path)}` +
      `&provider=${encodeURIComponent(provider)}&size=${size}`
    );
  }
}
