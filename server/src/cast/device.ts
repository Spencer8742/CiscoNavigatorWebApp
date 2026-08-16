import { connect as tlsConnect } from 'node:tls';
import type { Duplex } from 'node:stream';
import { logger } from '~/lib/log.ts';
import { encodeFrame, FrameReader, type CastFrame } from '~/cast/protocol.ts';

const log = logger('cast');

/**
 * One conversation with one Cast device.
 *
 * ## What actually happens when you "cast a web page"
 *
 * A Nest Hub runs Fuchsia and has no browser, so there is no URL to open. The
 * only way to put a page on that screen is to launch a *receiver app* that
 * fetches a page itself. DashCast is a published receiver that exists to do
 * exactly one thing: it accepts a URL on its own channel and sets
 * `window.location` to it.
 *
 * That means a cast is four steps, not one:
 *
 *     1. CONNECT     to the platform receiver, `receiver-0`
 *     2. GET_STATUS  is DashCast already running? then there is nothing to do
 *     3. LAUNCH      appId 84912283, and wait for it to finish loading
 *     4. CONNECT     to the *app's* transport, and send it the URL
 *
 * Step 2 is what makes this quiet enough to run on a timer: a display that is
 * already showing the dashboard is left completely alone, so nothing reloads
 * and nothing flickers.
 *
 * Step 3's "wait for it to finish loading" is the part that is easy to get
 * wrong. `LAUNCH` is acknowledged as soon as the device accepts it, not when
 * the receiver is ready, and a URL sent to a receiver that has not registered
 * its channel yet is dropped without any error. So the app's status is polled
 * until it lists DashCast's namespace, and only then is the URL sent.
 *
 * ## Why not Home Assistant's cast integration
 *
 * It can only launch receivers that pychromecast ships a controller for —
 * YouTube, BBC Sounds, Plex, a handful of others. DashCast is not among them,
 * so `media_player.play_media` answers "App DashCast is not supported". That
 * is not a configuration problem, and no amount of `extra` payload fixes it.
 *
 * ## Why not CATT, or a helper container
 *
 * They work, and both mean a second thing to install, keep running and keep
 * updated to put a page on a screen. The protocol above is a few hundred
 * lines and no dependencies; the dashboard casting itself is simply less
 * machinery than anything that casts it from outside.
 */

/** DashCast's published receiver app id. */
export const DASHCAST_APP_ID = '84912283';

/** Every Cast device listens here. There is no discovery involved. */
const DEFAULT_PORT = 8009;

const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  /** DashCast's own channel. Named for its author, not for the app. */
  dashcast: 'urn:x-cast:com.madmod.dashcast',
} as const;

/** The platform receiver, present on every device whatever is running. */
const PLATFORM = 'receiver-0';

/** Our end of the conversation. Any stable string will do. */
const SENDER = 'sender-navigator';

/** How long to wait between status polls while a receiver is loading. */
const POLL_MS = 400;

/**
 * How long to hold the socket open after handing over the URL.
 *
 * DashCast navigates away the moment it reads the message, which tears down
 * its own channel — so this is not waiting for a reply that will never come,
 * it is making sure the bytes are read before the socket closes under it.
 */
const HANDOVER_MS = 400;

/**
 * How a connection to the device is made.
 *
 * Injectable for one reason: it lets the test suite put a mock device on a
 * plain TCP socket. TLS to a Cast device verifies nothing (see below), so
 * substituting it removes no coverage worth having.
 */
export type CastTransport = (host: string, port: number) => Promise<Duplex>;

/**
 * The real transport.
 *
 * `rejectUnauthorized: false` is not a shortcut here, and cannot be avoided:
 * a Cast device presents a certificate issued by Google's device CA for a
 * name like `2f7e...c9.local`, which is neither the IP being connected to nor
 * anything a public CA store contains. Chrome verifies it against a private
 * root that is not published. There is no verification available to do.
 *
 * What that costs is worth being precise about: anything that can intercept
 * traffic to the Hub can impersonate it, and would learn the dashboard URL —
 * including its panel token, if one is set. That is the same exposure as the
 * URL being typed into any other casting tool, on a LAN where the Hub itself
 * is discovered by unauthenticated mDNS. It is not a reason to skip a token;
 * a token still stops every device that is not on the path.
 */
export const tlsTransport: CastTransport = (host, port) =>
  new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port, rejectUnauthorized: false }, () => {
      socket.removeListener('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });

export interface CastDeviceOptions {
  host: string;
  port?: number;
  /** Used in logs and error messages. Defaults to the host. */
  label?: string;
  /** Budget for the whole visit, connection included. */
  timeoutMs?: number;
  transport?: CastTransport;
}

/** What a visit did. `already-showing` means nothing was touched. */
export type CastOutcome = 'already-showing' | 'cast';

interface AppInfo {
  appId: string;
  transportId: string;
  namespaces: string[];
}

interface Waiter {
  match(frame: CastFrame, payload: Record<string, unknown>): boolean;
  resolve(payload: Record<string, unknown>): void;
  reject(error: Error): void;
}

export class CastDevice {
  readonly host: string;
  readonly port: number;
  readonly label: string;

  readonly #timeoutMs: number;
  readonly #transport: CastTransport;
  readonly #reader = new FrameReader();
  readonly #waiters = new Set<Waiter>();

  #socket: Duplex | null = null;
  #requestId = 1;
  #failure: Error | null = null;

  constructor(options: CastDeviceOptions) {
    this.host = options.host;
    this.port = options.port ?? DEFAULT_PORT;
    this.label = options.label ?? options.host;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#transport = options.transport ?? tlsTransport;
  }

  /**
   * Put `url` on this display, unless it is already showing the dashboard.
   *
   * `force` skips that check and re-sends the URL to the running receiver.
   * It does not relaunch: DashCast handles being told to load a page while it
   * is showing one, and going through a launch again would blank the screen
   * for no reason.
   */
  async show(url: string, force = false): Promise<CastOutcome> {
    const deadline = Date.now() + this.#timeoutMs;
    await this.#open(deadline);
    try {
      this.#send(NS.connection, PLATFORM, { type: 'CONNECT' });

      const running = appFrom(await this.#status(deadline));
      if (running && !force) return 'already-showing';

      if (!running) {
        const reply = await this.#request(
          NS.receiver,
          PLATFORM,
          { type: 'LAUNCH', appId: DASHCAST_APP_ID },
          deadline,
        );
        if (reply['type'] === 'LAUNCH_ERROR') {
          throw new Error(`the device refused to launch DashCast (${reasonFrom(reply)})`);
        }
      }

      const app = await this.#awaitReady(deadline);

      // A receiver has its own transport, and its own connection to open.
      this.#send(NS.connection, app.transportId, { type: 'CONNECT' });
      this.#send(NS.dashcast, app.transportId, {
        url,
        // `force` here is DashCast's own flag, unrelated to this method's:
        // it tells the receiver to load the URL even if that is the page it
        // is already on, which is what makes a re-cast actually refresh.
        force: true,
        reload: false,
        reload_time: 0,
      });

      await delay(HANDOVER_MS);
      return 'cast';
    } finally {
      this.#close();
    }
  }

  /* ── Connection ──────────────────────────────────────────────────────── */

  /**
   * Connect, within the same budget as everything else.
   *
   * Connecting has to be bounded explicitly, and it is easy to assume it is
   * not: a device that is off refuses immediately and a device that is absent
   * fails on ARP, so both look self-limiting. The case that is neither is a
   * host that accepts TCP and then never finishes the TLS handshake — a
   * different service on 8009, a half-crashed device, a firewall that
   * swallows the reply. `tls.connect` waits for that forever, which would
   * leave the keeper's sweep permanently in progress and quietly stop it ever
   * checking any display again.
   */
  async #open(deadline: number): Promise<void> {
    const attempt = this.#transport(this.host, this.port);
    let abandoned = false;
    // A socket that arrives after we have given up must still be closed.
    attempt.then((s) => abandoned && s.destroy()).catch(() => undefined);

    const socket = await Promise.race([
      attempt,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => {
            abandoned = true;
            reject(new Error(`timed out connecting to ${this.label} — is it switched on?`));
          },
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
    this.#socket = socket;

    socket.on('data', (chunk: Buffer) => this.#receive(chunk));
    socket.on('error', (err: Error) => this.#fail(err));
    socket.on('close', () => this.#fail(new Error('the device closed the connection')));
  }

  #close(): void {
    const socket = this.#socket;
    if (!socket) return;
    this.#socket = null;
    // Politeness, and it matters: a device that is never told the sender has
    // gone keeps the session in its status for a while.
    try {
      socket.write(
        encodeFrame({
          namespace: NS.connection,
          source: SENDER,
          destination: PLATFORM,
          payload: JSON.stringify({ type: 'CLOSE' }),
        }),
      );
    } catch {
      // Already gone. Nothing to do and nothing worth saying.
    }
    socket.destroy();
    this.#fail(new Error('connection closed'));
  }

  /** Fails every outstanding wait. Harmless when there are none. */
  #fail(error: Error): void {
    this.#failure ??= error;
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
  }

  #receive(chunk: Buffer): void {
    let frames: CastFrame[];
    try {
      frames = this.#reader.push(chunk);
    } catch (err) {
      this.#fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    for (const frame of frames) {
      let payload: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(frame.payload);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        payload = parsed as Record<string, unknown>;
      } catch {
        continue;
      }

      /*
       * The device pings every five seconds and hangs up on a sender that
       * does not answer. Visits here are short enough that it may never
       * happen — but a display that is slow to launch a receiver is exactly
       * the case where it does, and dropping the connection there would turn
       * a slow cast into a failed one.
       */
      if (frame.namespace === NS.heartbeat && payload['type'] === 'PING') {
        this.#send(NS.heartbeat, frame.source || PLATFORM, { type: 'PONG' });
        continue;
      }

      for (const waiter of this.#waiters) {
        if (!waiter.match(frame, payload)) continue;
        this.#waiters.delete(waiter);
        waiter.resolve(payload);
        break;
      }
    }
  }

  #send(namespace: string, destination: string, payload: Record<string, unknown>): void {
    const socket = this.#socket;
    if (!socket) throw this.#failure ?? new Error('not connected');
    socket.write(
      encodeFrame({
        namespace,
        source: SENDER,
        destination,
        payload: JSON.stringify(payload),
      }),
    );
  }

  /**
   * Send something with a `requestId` and wait for the reply carrying it back.
   *
   * Matching on the id rather than on message type is what keeps this correct
   * while the device is also broadcasting: an unsolicited `RECEIVER_STATUS`
   * (someone else casting, a volume change, a timer starting) arrives with
   * `requestId: 0` and must not be mistaken for the answer to our question.
   */
  async #request(
    namespace: string,
    destination: string,
    payload: Record<string, unknown>,
    deadline: number,
  ): Promise<Record<string, unknown>> {
    const requestId = this.#requestId++;
    const promise = this.#await(
      (frame, body) => frame.namespace === namespace && body['requestId'] === requestId,
      deadline,
      `${String(payload['type'])} from ${this.label}`,
    );
    this.#send(namespace, destination, { ...payload, requestId });
    return promise;
  }

  #await(
    match: Waiter['match'],
    deadline: number,
    description: string,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const remaining = deadline - Date.now();
      if (this.#failure) {
        reject(this.#failure);
        return;
      }
      if (remaining <= 0) {
        reject(new Error(`timed out waiting for ${description}`));
        return;
      }

      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new Error(`timed out waiting for ${description}`));
      }, remaining);

      const waiter: Waiter = {
        match,
        resolve(payload) {
          clearTimeout(timer);
          resolve(payload);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.#waiters.add(waiter);
    });
  }

  #status(deadline: number): Promise<Record<string, unknown>> {
    return this.#request(NS.receiver, PLATFORM, { type: 'GET_STATUS' }, deadline);
  }

  /**
   * Poll until DashCast is running *and* has registered its channel.
   *
   * See the class comment: a URL sent before the namespace appears is
   * discarded silently, and the display sits on a blank receiver forever.
   */
  async #awaitReady(deadline: number): Promise<AppInfo> {
    for (;;) {
      const app = appFrom(await this.#status(deadline));
      if (app && app.transportId && app.namespaces.includes(NS.dashcast)) return app;

      if (Date.now() + POLL_MS >= deadline) {
        throw new Error(
          app
            ? 'DashCast launched but did not finish loading in time'
            : 'DashCast did not start — the device may have refused it',
        );
      }
      log.debug(`${this.label}: waiting for DashCast to finish loading`);
      await delay(POLL_MS);
    }
  }
}

/* ── Payload reading ───────────────────────────────────────────────────── */

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** DashCast's entry in a `RECEIVER_STATUS`, if it is running. */
function appFrom(reply: Record<string, unknown>): AppInfo | null {
  const status = record(reply['status']);
  const apps = status?.['applications'];
  if (!Array.isArray(apps)) return null;

  for (const entry of apps) {
    const app = record(entry);
    if (!app || app['appId'] !== DASHCAST_APP_ID) continue;
    const namespaces = Array.isArray(app['namespaces'])
      ? app['namespaces']
          .map((n) => record(n)?.['name'])
          .filter((n): n is string => typeof n === 'string')
      : [];
    return {
      appId: DASHCAST_APP_ID,
      transportId: typeof app['transportId'] === 'string' ? app['transportId'] : '',
      namespaces,
    };
  }
  return null;
}

function reasonFrom(reply: Record<string, unknown>): string {
  const reason = reply['reason'];
  return typeof reason === 'string' ? reason : 'no reason given';
}

/**
 * Deliberately not `unref`'d.
 *
 * Every timer in this file exists only while a visit is in flight and is
 * bounded by that visit's budget. An unref'd one lets the event loop decide
 * the visit is over while it is still waiting — which shows up as a cast that
 * silently never happens rather than as an error.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
