import { WebSocket } from 'ws';
import { logger } from '~/lib/log.ts';
import { Backoff } from '@shared/backoff.ts';
import type { RoomosState } from '@shared/protocol.ts';

const log = logger('roomos');

/** A device on the LAN answers in milliseconds, or it is not going to. */
const REQUEST_TIMEOUT_MS = 8000;
const CONNECT_TIMEOUT_MS = 8000;
/**
 * How long to let a burst of feedback settle before re-reading.
 *
 * Starting a presentation produces half a dozen events in a few tens of
 * milliseconds — the instance appears, its source is set, the mode changes.
 * Reading once after they stop costs one round trip instead of six.
 */
const SETTLE_MS = 120;

/** The two subtrees whose changes decide what the key shows. */
const PRESENTATION = ['Status', 'Conference', 'Presentation'];
const VIDEO_INPUT = ['Status', 'Video', 'Input'];
/** Volume and mute, for a volume control's live state. */
const AUDIO_VOLUME = ['Status', 'Audio', 'Volume'];
const AUDIO_MUTE = ['Status', 'Audio', 'VolumeMute'];

export interface RoomosOptions {
  id: string;
  /** Bare address, optionally with `:port`. */
  host: string;
  username: string;
  password: string;
}

interface Rpc {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

type Pending = (reply: Rpc) => void;

/**
 * One Cisco RoomOS device, over the xAPI's own WebSocket (JSON-RPC 2.0).
 *
 * This replaces a Companion key for the one thing Companion cannot do: say
 * what the device is showing. A Companion press is fire-and-forget, so a key
 * that flipped a Desk Pro between HDMI and USB-C knew nothing about the
 * laptop that was plugged in afterwards, or the source somebody chose on the
 * device's own screen, and the key's idea of "current" drifted.
 *
 * Here the device tells us. `xFeedback/Subscribe` on the presentation status
 * delivers an event for every change, whoever made it, and each one is
 * answered by re-reading what matters (presentation, inputs, volume) rather than by merging
 * the event into a local copy. RoomOS signals a removed instance with a
 * `ghost` entry, and a merge that mishandles one is a key stuck on an input
 * that stopped presenting ten minutes ago; a re-read cannot get that wrong.
 *
 * Unlike a television, a RoomOS device keeps its network up in standby, so
 * the connection is held permanently and re-established with backoff.
 */
export class RoomosClient {
  readonly #opts: RoomosOptions;
  readonly #backoff = new Backoff({ baseMs: 1000, maxMs: 60_000 });
  #socket: WebSocket | undefined;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #stopped = true;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #settle: ReturnType<typeof setTimeout> | undefined;
  #onChange: (() => void) | undefined;
  /** The last failure, logged once rather than on every retry. */
  #lastProblem = '';

  #reachable = false;
  #connector: number | null = null;
  /** The live instance's sending mode, kept so switching input keeps it. */
  #sendingMode: string | undefined;
  #instance: number | undefined;
  #connectors: RoomosState['connectors'] = [];
  #volume: number | null = null;
  #muted: boolean | null = null;

  constructor(opts: RoomosOptions) {
    this.#opts = opts;
  }

  get host(): string {
    return this.#opts.host;
  }

  /** True when this client would connect the same way as one built from `opts`. */
  matches(opts: RoomosOptions): boolean {
    const o = this.#opts;
    return o.host === opts.host && o.username === opts.username && o.password === opts.password;
  }

  /** One listener; the runner owns it. */
  onChange(fn: () => void): void {
    this.#onChange = fn;
  }

  get state(): RoomosState {
    return {
      id: this.#opts.id,
      reachable: this.#reachable,
      connector: this.#reachable ? this.#connector : null,
      connectors: this.#connectors,
      volume: this.#reachable ? this.#volume : null,
      muted: this.#reachable ? this.#muted : null,
    };
  }

  /** The connector being presented, or null. */
  get connector(): number | null {
    return this.#reachable ? this.#connector : null;
  }

  /** Every input connector the device reports, cameras excluded. */
  get inputConnectors(): RoomosState['connectors'] {
    return this.#connectors;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#open();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#retry);
    clearTimeout(this.#settle);
    this.#socket?.close();
    this.#socket = undefined;
  }

  /* ── Commands ──────────────────────────────────────────────────────────*/

  /**
   * Present one connector.
   *
   * When something is already being presented, the new source REPLACES that
   * instance and keeps its sending mode. Without the instance, a device that
   * supports several local presentations would add a second one beside the
   * first; without the mode, switching from HDMI to USB-C in a call would
   * quietly stop sending it to the far end.
   *
   * With nothing presented it starts LocalOnly: a key on a wall panel should
   * never be the thing that shares a screen into a call nobody meant to
   * share it into.
   */
  async present(connector: number): Promise<string | null> {
    const params: Record<string, unknown> = {
      ConnectorId: connector,
      SendingMode: this.#connector !== null && this.#sendingMode ? this.#sendingMode : 'LocalOnly',
    };
    if (this.#connector !== null && this.#instance !== undefined) {
      params['Instance'] = this.#instance;
    }

    const failure = await this.#command('Presentation/Start', params);
    if (failure && 'Instance' in params) {
      // Older software has no `Instance` parameter, and refuses the whole
      // command rather than ignoring it. On those a plain start replaces.
      delete params['Instance'];
      return this.#command('Presentation/Start', params);
    }
    return failure;
  }

  async stopPresenting(): Promise<string | null> {
    return this.#command('Presentation/Stop', {});
  }

  /**
   * Any xCommand, as written in dashboard.yaml: `['Standby', 'Deactivate']`.
   *
   * Refused while the connection is down rather than queued. These are
   * transport commands — volume, standby — and one delivered a minute late,
   * when the connection comes back, is worse than one that never arrives.
   */
  async xcommand(words: string[], params: Record<string, unknown>): Promise<string | null> {
    return this.#command(words.join('/'), params);
  }

  async #command(path: string, params: Record<string, unknown>): Promise<string | null> {
    try {
      const reply = await this.#request(`xCommand/${path}`, params);
      if (reply.error) {
        const message = reply.error.message ?? `error ${reply.error.code ?? '?'}`;
        log.warn(`${this.#opts.id}: ${path} refused: ${message}`);
        return message;
      }
      // Read now rather than waiting for the feedback to arrive: the panel's
      // label should move with the press, not a moment after it.
      this.#scheduleRefresh(0);
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`${this.#opts.id}: ${path} failed: ${message}`);
      return message;
    }
  }

  /* ── Connection ────────────────────────────────────────────────────────*/

  async #open(): Promise<void> {
    if (this.#stopped) return;
    const auth = Buffer.from(`${this.#opts.username}:${this.#opts.password}`).toString('base64');
    const socket = new WebSocket(`wss://${this.#opts.host}/ws`, {
      headers: { Authorization: `Basic ${auth}` },
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      /*
       * A RoomOS device serves a self-signed certificate by default, and the
       * config names it by IP, so there is nothing to verify against. Scoped
       * to this socket, like the webOS client: encrypted, not authenticated.
       */
      rejectUnauthorized: false,
    });
    this.#socket = socket;

    // Set once the handshake's own failure has been named, so the generic
    // "closed before the connection was established" that follows it does
    // not replace the useful message.
    let named = false;
    socket.on('message', (data) => this.#onMessage(String(data)));
    socket.on('unexpected-response', (_req, res) => {
      named = true;
      // 401 is the one case worth naming: it looks like the device being
      // down, and the fix is in .env rather than on the network.
      this.#problem(
        res.statusCode === 401
          ? 'the device refused the username or password (ROOMOS_PASSWORD)'
          : `the device answered HTTP ${res.statusCode ?? '?'}`,
      );
      socket.terminate();
    });
    socket.on('error', (err) => {
      if (!named) this.#problem(err.message);
    });
    socket.on('close', () => this.#onClose(socket));

    socket.once('open', () => {
      void this.#onOpen(socket);
    });
  }

  async #onOpen(socket: WebSocket): Promise<void> {
    try {
      for (const query of [PRESENTATION, VIDEO_INPUT, AUDIO_VOLUME, AUDIO_MUTE]) {
        const reply = await this.#request('xFeedback/Subscribe', {
          Query: query,
          NotifyCurrentValue: false,
        });
        // The presentation is what the connection is for; audio is only for
        // a volume control, and a device that will not report it should
        // still present. So only the first two are fatal.
        if (reply.error && (query === PRESENTATION || query === VIDEO_INPUT)) {
          throw new Error(reply.error.message ?? 'subscribe refused');
        }
      }
      await this.#refresh();
    } catch (err) {
      this.#problem(err instanceof Error ? err.message : String(err));
      socket.terminate();
      return;
    }

    if (this.#lastProblem) log.info(`${this.#opts.id}: connected to ${this.#opts.host}`);
    else log.debug(`${this.#opts.id}: connected to ${this.#opts.host}`);
    this.#lastProblem = '';
    this.#backoff.reset();
    this.#setReachable(true);
  }

  #onClose(socket: WebSocket): void {
    if (this.#socket !== socket) return;
    this.#socket = undefined;
    for (const [id, resolve] of this.#pending) {
      this.#pending.delete(id);
      resolve({ id, error: { message: 'The device closed the connection' } });
    }
    // What was being presented is no longer known. Showing the last value
    // would be claiming something nobody can check.
    this.#setReachable(false);
    if (this.#stopped) return;
    this.#retry = setTimeout(() => void this.#open(), this.#backoff.next());
    this.#retry.unref?.();
  }

  #problem(message: string): void {
    if (message === this.#lastProblem) return;
    this.#lastProblem = message;
    log.warn(`${this.#opts.id}: cannot reach ${this.#opts.host}: ${message}`);
  }

  #setReachable(reachable: boolean): void {
    if (this.#reachable === reachable) return;
    this.#reachable = reachable;
    this.#onChange?.();
  }

  #onMessage(text: string): void {
    let msg: Rpc;
    try {
      msg = JSON.parse(text) as Rpc;
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && ('result' in msg || 'error' in msg)) {
      this.#pending.get(msg.id)?.(msg);
      return;
    }
    // Any feedback at all is only a prompt to look; the re-read is the truth.
    if (msg.method === 'xFeedback/Event') this.#scheduleRefresh(SETTLE_MS);
  }

  #request(method: string, params: Record<string, unknown>): Promise<Rpc> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`${this.#opts.id} is not connected`));
    }
    const id = this.#nextId++;
    return new Promise<Rpc>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('The device did not answer'));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, (reply) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve(reply);
      });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(err);
      });
    });
  }

  /* ── State ─────────────────────────────────────────────────────────────*/

  #scheduleRefresh(delayMs: number): void {
    clearTimeout(this.#settle);
    this.#settle = setTimeout(() => {
      this.#refresh().catch((err: unknown) => {
        log.debug(`${this.#opts.id}: refresh failed: ${err instanceof Error ? err.message : err}`);
      });
    }, delayMs);
    this.#settle.unref?.();
  }

  async #refresh(): Promise<void> {
    const [presentation, input, volume, mute] = await Promise.all([
      this.#get(PRESENTATION),
      this.#get(VIDEO_INPUT),
      this.#leaf(AUDIO_VOLUME),
      this.#leaf(AUDIO_MUTE),
    ]);
    const level = int(volume);
    const nextVolume = level === undefined ? null : level;
    const muteWord = leaf(mute);
    const nextMuted = muteWord === undefined ? null : muteWord.toLowerCase() === 'on';

    const sources = new Map<number, number>();
    for (const source of list(input['Source'])) {
      const id = int(source['id']);
      const connector = int(source['ConnectorId']);
      if (id !== undefined && connector !== undefined) sources.set(id, connector);
    }

    const connectors: RoomosState['connectors'] = [];
    for (const c of list(input['Connector'])) {
      const id = int(c['id']);
      const type = leaf(c['Type']) ?? '';
      if (id === undefined || /camera/i.test(type)) continue;
      const connected = leaf(c['Connected']);
      connectors.push({
        id,
        type: prettyType(type),
        connected: connected === undefined ? null : connected.toLowerCase() === 'true',
      });
    }
    connectors.sort((a, b) => a.id - b.id);

    // The lowest-numbered local instance is the one on screen; a device with
    // one presentation — which is every Desk Pro in practice — has only it.
    const instances = list(presentation['LocalInstance'])
      .filter((i) => leaf(i['ghost']) !== 'True' && i['Source'] !== undefined)
      .sort((a, b) => (int(a['id']) ?? 0) - (int(b['id']) ?? 0));
    const live = instances[0];

    let connector: number | null = null;
    if (live) {
      const source = int(live['Source']);
      // Source ids and connector ids coincide on every current device, but
      // the device publishes the mapping, so it is read rather than assumed.
      if (source !== undefined) connector = sources.get(source) ?? source;
    }

    this.#sendingMode = live ? leaf(live['SendingMode']) : undefined;
    this.#instance = live ? int(live['id']) : undefined;

    const changed =
      connector !== this.#connector ||
      nextVolume !== this.#volume ||
      nextMuted !== this.#muted ||
      JSON.stringify(connectors) !== JSON.stringify(this.#connectors);
    this.#connector = connector;
    this.#connectors = connectors;
    this.#volume = nextVolume;
    this.#muted = nextMuted;
    if (changed && this.#reachable) this.#onChange?.();
  }

  /** One leaf value — `Audio Volume` is a number, not a subtree. */
  async #leaf(path: string[]): Promise<unknown> {
    const reply = await this.#request('xGet', { Path: path });
    if (reply.error) return undefined;
    let node: unknown = reply.result;
    if (isObj(node) && path[0]! in node) {
      for (const key of path) node = isObj(node) ? node[key] : undefined;
    }
    return node;
  }

  /**
   * One subtree, or an empty object when the device has nothing there.
   *
   * xGet answers with the value AT the path. Some firmware wraps it in the
   * full path from the root instead, so both shapes are accepted.
   */
  async #get(path: string[]): Promise<Record<string, unknown>> {
    const reply = await this.#request('xGet', { Path: path });
    if (reply.error) return {};
    let node: unknown = reply.result;
    if (isObj(node) && path[0]! in node) {
      for (const key of path) node = isObj(node) ? node[key] : undefined;
    }
    return isObj(node) ? node : {};
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A multi-instance node: an array, or a single object when there is one. */
function list(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.filter(isObj);
  return isObj(v) ? [v] : [];
}

/** A leaf, bare or `{Value: ...}`-wrapped, as a string. */
function leaf(v: unknown): string | undefined {
  if (isObj(v)) v = v['Value'];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s || undefined;
}

function int(v: unknown): number | undefined {
  const s = leaf(v);
  if (s === undefined) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** `USBC` is how the xAPI spells it, and nobody in the room does. */
function prettyType(type: string): string {
  if (/^usb-?c$/i.test(type)) return 'USB-C';
  return type || 'Input';
}
