import { WebSocket } from 'ws';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from '~/lib/log.ts';
import {
  URI,
  endpointsFor,
  inputOfAppId,
  failureOf,
  inputsOf,
  isAuthFailure,
  registerPayload,
  type SsapFrame,
  type TvInput,
} from '~/tv/protocol.ts';
import { wake } from '~/tv/wol.ts';
import { splitHost } from '~/cast/keeper.ts';

const log = logger('webos');

/** The TV answers in milliseconds on a LAN, or it is not going to. */
const REQUEST_TIMEOUT_MS = 6000;
/** Registration is slower: it waits for someone to accept a prompt on screen. */
const PAIR_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 5000;

export interface WebosOptions {
  host: string;
  /** Required to turn the set ON. Nothing else needs it. */
  mac?: string;
  /** Where the pairing key is kept between restarts. */
  keyFile: string;
  broadcast?: string;
}

/**
 * One LG webOS television, spoken to directly.
 *
 * Why direct rather than through Home Assistant: this is a transport control
 * on a panel that sits in front of the TV. Every hop is a place for the press
 * to die, and the panel already treats Home Assistant as the thing that might
 * be restarting.
 *
 * Two properties of webOS shape everything here:
 *
 * **1. Pairing is a physical act.** The first connection prompts on the TV's
 * own screen and someone has to accept it with the remote. The TV then
 * returns a client-key which is good forever. That key is written to disk,
 * because a container restart that re-prompts a TV in a meeting room is not
 * an acceptable failure mode.
 *
 * **2. The socket only exists while the TV is on.** Off means the network
 * stack is down, not that the socket is idle — so "turn on" is a magic packet
 * (see wol.ts) and every other command needs a connection established on
 * demand. Holding one open permanently would just mean holding a dead one.
 */
export class WebosClient {
  readonly #opts: WebosOptions;
  #socket: WebSocket | undefined;
  #clientKey: string | undefined;
  #keyLoaded = false;
  #nextId = 1;
  #pending = new Map<string, (frame: SsapFrame) => void>();
  /** In-flight connect, so concurrent presses share one handshake. */
  #connecting: Promise<void> | undefined;
  /** The endpoint that last worked, tried first next time. */
  #endpoint: string | undefined;
  /** The input the TV is showing, or undefined when we do not know. */
  #currentInput: string | undefined;
  /** The last input WE asked for: the cycle's anchor, and the weak label. */
  #requestedInput: string | undefined;
  /**
   * The TV's own map of foreground app id to input id, from
   * getExternalInputList. Empty on a set that does not report `appId` per
   * input, which is what `inputOfAppId` is for.
   */
  #appIds = new Map<string, string>();
  /**
   * The last foreground app id nothing could resolve.
   *
   * Kept because the two answers can arrive in either order: a set that
   * reports its foreground app before it answers the input list would
   * otherwise have that first report thrown away, and the label would stay
   * empty until the input changed again.
   */
  #unresolvedAppId: string | undefined;
  /** Called when the current input changes, so panels can be told. */
  #onInput: ((input: string | undefined) => void) | undefined;

  constructor(opts: WebosOptions) {
    this.#opts = opts;
  }

  get host(): string {
    return this.#opts.host;
  }

  /**
   * The input the TV is on, or undefined when it is off or showing something
   * that is not an input at all.
   *
   * Undefined is a real answer and is rendered as one. Guessing "probably
   * still the last one" would put a label on a button that is wrong exactly
   * when somebody has changed the input behind the panel's back.
   */
  get currentInput(): string | undefined {
    return this.#currentInput;
  }

  /**
   * The input we last successfully asked for, when the set has not confirmed
   * one itself.
   *
   * Reported separately from `currentInput` and rendered differently, because
   * it is a weaker claim: it is what this panel set, not what the television
   * says it is showing. Somebody with the remote can make it wrong.
   *
   * It exists because "no idea" is the permanent answer on a set that never
   * reports its foreground app — and a key whose label reads "—" forever is
   * no more honest than one that says where it last sent the TV, it is just
   * less useful.
   */
  get assumedInput(): string | undefined {
    return this.#currentInput ? undefined : this.#requestedInput;
  }

  /** Watch for input changes. One listener; the runner owns it. */
  onInputChange(fn: (input: string | undefined) => void): void {
    this.#onInput = fn;
  }

  /** True once the TV has handed us a key — i.e. pairing is done. */
  get paired(): boolean {
    return this.#clientKey !== undefined;
  }

  async stop(): Promise<void> {
    this.#socket?.close();
    this.#socket = undefined;
  }

  /* ── The operations the panel asks for ─────────────────────────────────*/

  /**
   * Turn the set on. This is the one command that does NOT use the socket.
   *
   * Returns an error for the panel when there is no MAC configured, rather
   * than failing silently: "the TV will not turn on" is otherwise a very
   * confusing symptom of a missing line of YAML.
   */
  async turnOn(): Promise<string | null> {
    const mac = this.#opts.mac;
    if (!mac) return 'No MAC address configured for this TV, so it cannot be woken';
    try {
      await wake(mac, this.#opts.broadcast);
      return null;
    } catch (err) {
      log.warn(`Wake-on-LAN to ${mac} failed:`, err);
      return 'Could not send the wake packet';
    }
  }

  async turnOff(): Promise<string | null> {
    return this.#command(URI.turnOff);
  }

  /**
   * On when the socket connects, off when it does not.
   *
   * There is no status endpoint that answers while the set is off, for the
   * obvious reason, so reachability IS the power state. Deliberately does not
   * try to wake anything — asking a question must never change the answer.
   */
  async isOn(): Promise<boolean> {
    try {
      await this.#connect();
      return true;
    } catch {
      return false;
    }
  }

  async listInputs(): Promise<TvInput[]> {
    const frame = await this.#request(URI.listInputs);
    const failure = failureOf(frame);
    if (failure) {
      log.warn(`Could not list inputs on ${this.#opts.host}: ${failure}`);
      return [];
    }
    return inputsOf(frame.payload);
  }

  /** `inputId` is the TV's own id — HDMI_2, not "HDMI 2". */
  async switchInput(inputId: string): Promise<string | null> {
    const failure = await this.#command(URI.switchInput, { inputId });
    if (failure) return failure;

    // Worth announcing even though the television may confirm it a moment
    // later: on a set that never reports its foreground app, this is the only
    // notification the panel will ever get, and without it the label stays
    // blank however many times the key is pressed.
    const changed = this.#requestedInput !== inputId;
    this.#requestedInput = inputId;
    if (changed && !this.#currentInput) this.#onInput?.(inputId);
    return null;
  }

  /**
   * Bring the socket up if it is not, but only on a television we are already
   * paired with.
   *
   * Called from the poll, so the input shows on the panel before anybody
   * presses anything and keeps up with the TV's own remote. The pairing guard
   * matters: connecting to an UNPAIRED set puts a prompt on its screen, and a
   * poll that did that would put one there every few seconds, in a room where
   * people are trying to have a meeting.
   */
  async ensureConnected(): Promise<void> {
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    await this.#loadKey();
    if (!this.#clientKey) return;
    try {
      await this.#connect();
    } catch {
      // The set is off, which is the normal case and not news.
    }
  }

  /**
   * Where a cycle should count from — what the TV says, or failing that what
   * we last asked for.
   *
   * Deliberately NOT the same as `currentInput`, which is what the label
   * shows. The label may only claim what the television confirmed; a cycle
   * just has to keep moving. Without this fallback, a set whose input
   * reporting we cannot read leaves every press computing "unknown, so start
   * at the first" — which looks exactly like a key that only ever selects one
   * input.
   */
  get cycleAnchor(): string | undefined {
    return this.#currentInput ?? this.#requestedInput;
  }

  /* ── Transport ─────────────────────────────────────────────────────────*/

  async #command(uri: string, payload?: Record<string, unknown>): Promise<string | null> {
    const once = async (): Promise<string | null> => {
      try {
        const frame = await this.#request(uri, payload);
        return failureOf(frame);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`${uri} failed on ${this.#opts.host}: ${message}`);
        return message;
      }
    };

    const failure = await once();
    if (!failure || !isAuthFailure(failure) || !this.#clientKey) return failure;

    /*
     * The television knows us but will not let us do anything. That means the
     * key on disk is no good — and it is offered again on every reconnect, so
     * without this the panel is stuck saying "insufficient permissions"
     * forever with no way out except deleting a file inside the container.
     *
     * Throw the key away and try once more, which registers from scratch and
     * puts the pairing prompt back on the TV.
     */
    log.warn(
      `${this.#opts.host} refused the stored pairing key (${failure}) — ` +
        'discarding it and asking to pair again. Accept the prompt on the TV.',
    );
    await this.#forgetKey();
    return once();
  }

  /** Drop the pairing key, in memory and on disk, and close the socket. */
  async #forgetKey(): Promise<void> {
    this.#clientKey = undefined;
    this.#socket?.close();
    this.#socket = undefined;

    try {
      const stored = JSON.parse(await readFile(this.#opts.keyFile, 'utf8')) as Record<
        string,
        unknown
      >;
      delete stored[this.#opts.host];
      await writeFile(this.#opts.keyFile, JSON.stringify(stored, null, 2));
    } catch {
      // No file, or unreadable. Either way there is no key left to offer.
    }
  }

  async #request(uri: string, payload?: Record<string, unknown>): Promise<SsapFrame> {
    await this.#connect();
    const socket = this.#socket;
    if (!socket) throw new Error('The TV is not reachable');

    const id = String(this.#nextId++);
    const frame: Record<string, unknown> = { id, type: 'request', uri };
    if (payload) frame['payload'] = payload;

    return this.#send(socket, frame, id, REQUEST_TIMEOUT_MS);
  }

  #send(
    socket: WebSocket,
    frame: Record<string, unknown>,
    id: string,
    timeoutMs: number,
  ): Promise<SsapFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('The TV did not answer'));
      }, timeoutMs);

      this.#pending.set(id, (reply) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve(reply);
      });

      socket.send(JSON.stringify(frame), (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(err);
      });
    });
  }

  /** Connect and register, or reuse the open socket. */
  #connect(): Promise<void> {
    if (this.#socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    // Concurrent presses must not each start their own handshake — the TV
    // would prompt more than once, and the second registration invalidates
    // nothing but confuses everyone watching the screen.
    this.#connecting ??= this.#openAndRegister().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #openAndRegister(): Promise<void> {
    await this.#loadKey();

    // The address is split rather than concatenated: `host` follows the same
    // convention as the key lights and cast displays, where an explicit
    // `:port` is allowed and wins. Appending a port unconditionally produced
    // `ws://host:19810:3000`, which fails as an invalid URL and reads exactly
    // like the TV being off.
    //
    // Port 0 is the sentinel for "not written down" — splitHost always
    // returns one, and which endpoints to try depends on whether the config
    // actually pinned it.
    const { host, port } = splitHost(this.#opts.host, 0);
    const candidates = endpointsFor(host, port === 0 ? undefined : port);

    // The one that worked last time goes first. Without this every command
    // after a TV reboot pays for a failed 3001 attempt before falling back.
    const ordered = this.#endpoint
      ? [this.#endpoint, ...candidates.filter((c) => c !== this.#endpoint)]
      : candidates;

    let socket: WebSocket | undefined;
    let lastError: Error | undefined;

    for (const url of ordered) {
      try {
        socket = await this.#open(url);
        this.#endpoint = url;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        log.debug(`${url} did not answer: ${lastError.message}`);
      }
    }

    if (!socket) {
      throw lastError ?? new Error('The TV is not reachable — it is probably off');
    }

    this.#socket = socket;
    this.#attach(socket);
    await this.#register(socket);
    this.#learnInputs();
    this.#watchInput(socket);
  }

  /**
   * Subscribe to the foreground app, which is how webOS reports the input.
   *
   * A subscription rather than a poll. The socket is already open while the
   * TV is on, so updates cost nothing and arrive when the input actually
   * changes — including when somebody uses the TV's own remote. Polling would
   * mean repeatedly opening connections to a device that spends most of its
   * life asleep, to answer a question it will tell us the answer to.
   */
  #watchInput(socket: WebSocket): void {
    const id = String(this.#nextId++);

    // Stays registered for the life of the socket: every update reuses this
    // id, so unlike a request the handler is never removed.
    this.#pending.set(id, (frame) => {
      if (failureOf(frame)) return;
      this.#reportForeground(frame.payload?.['appId']);
    });

    socket.send(JSON.stringify({ id, type: 'subscribe', uri: URI.foregroundApp }), (err) => {
      if (err) this.#pending.delete(id);
    });

    /*
     * And ask once, outright.
     *
     * A subscription is supposed to deliver the current value first, and on
     * most sets it does. Where it does not, the panel would show no input
     * until somebody changed one — so the first question is asked directly
     * rather than waited for.
     */
    void this.#request(URI.foregroundApp)
      .then((frame) => {
        if (failureOf(frame)) return;
        /*
         * Only when it actually answers the question.
         *
         * A response carrying no `appId` at all is not "the TV is on
         * nothing", it is "this reply does not say" — and treating the two
         * alike lets a late, empty answer to this one-shot query wipe out an
         * input the SUBSCRIPTION had already reported. Which is a race the
         * panel would show as a label that appears and then vanishes.
         */
        if (!('appId' in (frame.payload ?? {}))) return;
        this.#reportForeground(frame.payload?.['appId']);
      })
      .catch(() => {
        // The set answered the subscribe and not this; not worth a word.
      });
  }

  /**
   * Ask the television which app id belongs to which socket.
   *
   * This is the difference between reading the set's answer and guessing at
   * it. `inputOfAppId` can only recognise app ids shaped the way LG has
   * historically shaped them, and a set that names an input anything else —
   * a soundbar's passthrough, an ARC socket, a firmware that renamed them —
   * is unreadable to it. The TV publishes the mapping itself, so ask.
   *
   * Failure is not worth a word: `listInputs` already logs a refusal, and a
   * set that does not answer this simply falls back to the pattern.
   */
  #learnInputs(): void {
    void this.listInputs()
      .then((inputs) => {
        this.#appIds.clear();
        for (const input of inputs) {
          if (input.appId) this.#appIds.set(input.appId.toLowerCase(), input.id);
        }
        // The foreground app may have been reported before this arrived, in
        // which case it was set aside rather than thrown away.
        if (this.#appIds.size > 0 && this.#unresolvedAppId) {
          this.#reportForeground(this.#unresolvedAppId);
        }
      })
      .catch(() => {
        // The socket went away mid-question. The commands report that.
      });
  }

  /** What the TV says it is showing, turned into an input id if it is one. */
  #reportForeground(appId: unknown): void {
    const input = this.#resolveInput(appId);
    if (input) {
      this.#unresolvedAppId = undefined;
      this.#setInput(input);
      return;
    }

    // Say what was not understood. An app id in a shape neither the TV's own
    // table nor the pattern recognises is otherwise completely silent — the
    // label falls back to what we last set and nothing anywhere names why.
    if (typeof appId === 'string' && appId) {
      this.#unresolvedAppId = appId;
      log.debug(`${this.#opts.host} is showing "${appId}", which is not an input`);
    }
    this.#setInput(undefined);
  }

  /** The TV's own mapping first; the naming pattern only as a fallback. */
  #resolveInput(appId: unknown): string | undefined {
    if (typeof appId !== 'string' || !appId) return undefined;
    return this.#appIds.get(appId.trim().toLowerCase()) ?? inputOfAppId(appId) ?? undefined;
  }

  #setInput(next: string | undefined): void {
    if (next === this.#currentInput) return;
    this.#currentInput = next;
    this.#onInput?.(next);
  }

  /** Open one endpoint, or throw. */
  #open(url: string): Promise<WebSocket> {
    const socket = new WebSocket(url, {
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      /*
       * The TV's certificate is self-signed, issued to itself, and never
       * rotated — and the config names an IP, so there is no name to check it
       * against even in principle. Verification cannot succeed, so this
       * connection is encrypted but not authenticated.
       *
       * Scoped to this socket deliberately: it is one LAN device the operator
       * named by address, not a global relaxation of TLS anywhere else in
       * this process.
       */
      rejectUnauthorized: false,
    });

    return new Promise<WebSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('The TV is not reachable — it is probably off'));
      }, CONNECT_TIMEOUT_MS);

      socket.once('open', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        socket.terminate();
        reject(new Error(`Could not reach the TV: ${err.message}`));
      });
    });
  }

  /** Wire the long-lived handlers onto a socket that is already open. */
  #attach(socket: WebSocket): void {
    socket.on('message', (data) => {
      let frame: SsapFrame;
      try {
        frame = JSON.parse(String(data)) as SsapFrame;
      } catch {
        return;
      }
      const id = frame.id;
      if (id) this.#pending.get(id)?.(frame);
    });

    socket.on('close', () => {
      if (this.#socket === socket) this.#socket = undefined;
      // The TV is gone, so what it was showing is no longer known. Keeping
      // the last value would leave a stale input on the panel for as long as
      // the set stays off.
      //
      // The input we ASKED for goes too, and the app id table with it. A set
      // that has been off is a set somebody may have put on something else
      // with the remote, so the weak claim is no better than the strong one
      // here — and the mapping is re-read on the next connection anyway.
      this.#requestedInput = undefined;
      this.#unresolvedAppId = undefined;
      this.#appIds.clear();
      this.#setInput(undefined);
      // Fail anything still waiting rather than leaving it to time out: the
      // socket closing IS the answer, and six seconds of nothing is a worse
      // way to deliver it.
      for (const [id, resolve] of this.#pending) {
        this.#pending.delete(id);
        resolve({ id, type: 'error', error: 'The TV closed the connection' });
      }
    });

    socket.on('error', (err) => {
      log.warn(`Socket error to ${this.#opts.host}:`, err.message);
    });

  }

  /**
   * The registration handshake.
   *
   * With a stored key the TV answers `registered` immediately. Without one it
   * answers `PROMPT` first, then `registered` only once somebody accepts on
   * the TV — which is why this waits a minute rather than six seconds.
   */
  async #register(socket: WebSocket): Promise<void> {
    const id = String(this.#nextId++);
    const payload = registerPayload(this.#clientKey);

    let waitingOnPrompt = false;

    const reply = await new Promise<SsapFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(
            waitingOnPrompt
              ? 'Nobody accepted the pairing prompt on the TV'
              : 'The TV did not answer the pairing request',
          ),
        );
      }, PAIR_TIMEOUT_MS);

      this.#pending.set(id, (frame) => {
        // PROMPT is an interim reply, not the answer: the TV is asking
        // someone to press Yes with the remote. Keep waiting for `registered`
        // rather than treating it as either success or failure.
        if (frame.payload?.['pairingType'] === 'PROMPT' && frame.type !== 'registered') {
          waitingOnPrompt = true;
          log.warn(`${this.#opts.host} is asking to be paired — accept the prompt on the TV`);
          return;
        }
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve(frame);
      });

      socket.send(JSON.stringify({ id, type: 'register', payload }), (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(err);
      });
    });

    const failure = failureOf(reply);
    if (failure) throw new Error(`The TV refused to pair: ${failure}`);

    const key = reply.payload?.['client-key'];
    if (typeof key === 'string' && key && key !== this.#clientKey) {
      this.#clientKey = key;
      await this.#saveKey(key);
      log.info(`Paired with ${this.#opts.host}; key stored`);
    }
  }

  /* ── The pairing key on disk ───────────────────────────────────────────*/

  async #loadKey(): Promise<void> {
    if (this.#keyLoaded) return;
    this.#keyLoaded = true;
    try {
      const text = await readFile(this.#opts.keyFile, 'utf8');
      const stored = JSON.parse(text) as Record<string, unknown>;
      const key = stored[this.#opts.host];
      if (typeof key === 'string' && key) this.#clientKey = key;
    } catch {
      // No key yet, or the file is unreadable. Either way the next connection
      // pairs from scratch, which is the correct recovery.
    }
  }

  async #saveKey(key: string): Promise<void> {
    let stored: Record<string, unknown> = {};
    try {
      stored = JSON.parse(await readFile(this.#opts.keyFile, 'utf8')) as Record<string, unknown>;
    } catch {
      // First key, or an unreadable file we are about to replace.
    }
    stored[this.#opts.host] = key;
    try {
      await mkdir(dirname(this.#opts.keyFile), { recursive: true });
      await writeFile(this.#opts.keyFile, JSON.stringify(stored, null, 2));
    } catch (err) {
      // Not fatal: the TV stays paired for this process, and the cost of
      // failing is one more prompt after a restart. Worth saying loudly
      // though, because that prompt appears on a screen in a meeting.
      log.warn(`Could not write the pairing key to ${this.#opts.keyFile}:`, err);
    }
  }
}
