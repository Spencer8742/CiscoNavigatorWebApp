import { Socket, connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { logger } from '~/lib/log.ts';
import { wake, wakeTargets } from '~/tv/wol.ts';
import type { DisplayState } from '@shared/protocol.ts';

const log = logger('mdc');

/**
 * A Samsung commercial display, over MDC (Multiple Display Control).
 *
 * This is the protocol the Home Assistant `ha-samsungtv-mdc` integration
 * speaks (through vgavro's python-samsung-mdc), spoken here directly so the
 * Controls screen does not depend on Home Assistant being up to turn a
 * screen on.
 *
 * The whole protocol, as far as this panel needs it:
 *
 *   request   AA  CMD  ID  LEN  DATA…  CS
 *   response  AA  FF   ID  LEN  'A'|'N'  CMD  DATA…  CS
 *
 * CS is the low byte of the sum of every byte after the AA. 'A' is an ACK,
 * 'N' a NAK whose one data byte is an error code. Commands used here:
 *
 *   0x00  status  → power, volume, mute, input, aspect, …
 *   0x11  power   0 off · 1 on
 *   0x12  volume  0–100
 *   0x13  mute    0 off · 1 on   (0xFF: no audio on this model)
 *   0x14  input   source code, see SOURCES
 *
 * SECURE MDC. Newer firmware can require TLS and a PIN. The display then
 * opens the conversation itself with `MDCSTART<<TLS>>`; the client upgrades
 * the socket to TLS (self-signed, nothing to verify against an IP), sends
 * the four ASCII digits of the PIN, and is answered `MDCAUTH<<PASS>>` or
 * `MDCAUTH<<FAIL:xxxx>>`. With no PIN configured, that greeting is reported
 * as such rather than as a garbled frame.
 *
 * ONE CONVERSATION AT A TIME. A display answers frames in order and many
 * accept only one or two MDC connections, so requests are queued on one
 * socket and the socket is closed after a short idle — leaving the display
 * free for MagicINFO or anything else that wants it between polls.
 */

const DEFAULT_PORT = 1515;
/** A display on the LAN answers in tens of milliseconds, or it is not going to. */
const REQUEST_TIMEOUT_MS = 4000;
const CONNECT_TIMEOUT_MS = 4000;
/** Close the socket once it has been quiet this long. */
const IDLE_CLOSE_MS = 20_000;
/**
 * After power on, how long to keep asking until the display says it is on.
 * A panel coming out of standby takes several seconds, and some refuse
 * every command but power for part of that.
 */
const POWER_ON_SETTLE_MS = 15_000;

const CMD = {
  status: 0x00,
  power: 0x11,
  volume: 0x12,
  mute: 0x13,
  input: 0x14,
} as const;

/** MDC input source codes, by the names the HA integration and Samsung's spec use. */
export const SOURCES: Readonly<Record<string, number>> = {
  S_VIDEO: 0x04,
  COMPONENT: 0x08,
  AV: 0x0c,
  AV2: 0x0d,
  SCART1: 0x0e,
  PC: 0x14,
  DVI: 0x18,
  BNC: 0x1e,
  DVI_VIDEO: 0x1f,
  MAGIC_INFO: 0x20,
  HDMI1: 0x21,
  HDMI1_PC: 0x22,
  HDMI2: 0x23,
  HDMI2_PC: 0x24,
  DISPLAY_PORT_1: 0x25,
  DISPLAY_PORT_2: 0x26,
  DISPLAY_PORT_3: 0x27,
  HDMI3: 0x31,
  HDMI3_PC: 0x32,
  HDMI4: 0x33,
  HDMI4_PC: 0x34,
  TV_DTV: 0x40,
  PLUG_IN_MODE: 0x50,
  HD_BASE_T: 0x55,
  OCM: 0x56,
  MEDIA_MAGIC_INFO_S: 0x60,
  WIDI_SCREEN_MIRRORING: 0x61,
  INTERNAL_USB: 0x62,
  URL_LAUNCHER: 0x63,
  IWB: 0x64,
  WEB_BROWSER: 0x65,
  REMOTE_WORKSPACE: 0x66,
};

const SOURCE_NAMES = new Map(Object.entries(SOURCES).map(([name, code]) => [code, name]));

/**
 * `HDMI 1`, `hdmi1`, `HDMI1`, `DisplayPort 1`, `0x21` → the canonical name,
 * or null. Forgiving on purpose: the HA integration showed "HDMI 1", the spec
 * says HDMI1, and a config written from either should work.
 */
export function sourceName(input: string): string | null {
  const hex = /^0x([0-9a-f]{1,2})$/i.exec(input.trim());
  if (hex) return SOURCE_NAMES.get(parseInt(hex[1]!, 16)) ?? null;
  const key = input
    .trim()
    .toUpperCase()
    .replace(/DISPLAY\s*PORT|DP(?=\s*\d)/, 'DISPLAY_PORT_')
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^HDMI_(\d)/, 'HDMI$1')
    .replace(/^DISPLAY_PORT_?(\d)/, 'DISPLAY_PORT_$1');
  return key in SOURCES ? key : null;
}

/** Low byte of the sum of every byte after the header. */
export function checksum(bytes: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum += bytes[i]!;
  return sum & 0xff;
}

/** One request frame. */
export function encodeFrame(cmd: number, displayId: number, data: number[] = []): Buffer {
  const body = [cmd, displayId & 0xff, data.length, ...data.map((b) => b & 0xff)];
  return Buffer.from([0xaa, ...body, checksum(body)]);
}

export interface MdcReply {
  ack: boolean;
  cmd: number;
  /** Data after the echoed command; for a NAK, the error code. */
  data: number[];
}

/**
 * Take one response frame off the front of `buf`. Returns the reply and the
 * bytes it used, or null when the frame is not all here yet. Garbage before
 * a header is skipped; a frame with a bad checksum throws.
 */
export function decodeFrame(buf: Buffer): { reply: MdcReply; used: number } | null {
  const start = buf.indexOf(0xaa);
  if (start < 0) return null;
  if (buf.length < start + 4) return null;
  const len = buf[start + 3]!;
  const end = start + 4 + len + 1;
  if (buf.length < end) return null;
  if (buf[start + 1] !== 0xff) throw new Error('Not an MDC response');
  const body = buf.subarray(start + 1, end - 1);
  if (checksum(body) !== buf[end - 1]) throw new Error('MDC checksum mismatch');
  const payload = [...buf.subarray(start + 4, end - 1)];
  const ackByte = payload[0];
  return {
    reply: {
      ack: ackByte === 0x41,
      cmd: payload[1] ?? -1,
      data: payload.slice(2),
    },
    used: end,
  };
}

export interface MdcOptions {
  id: string;
  /** Bare address, optionally with `:port`. */
  host: string;
  displayId: number;
  /** Secure MDC PIN, when the display requires one. */
  pin?: string;
  mac?: string;
  broadcast?: string;
}

interface Waiter {
  cmd: number;
  resolve: (reply: MdcReply) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class MdcClient {
  readonly #opts: MdcOptions;
  readonly #address: string;
  readonly #port: number;
  #socket: Socket | undefined;
  #connecting: Promise<Socket> | undefined;
  #buffer = Buffer.alloc(0);
  #waiter: Waiter | undefined;
  /** Serialises requests: one frame in flight on the socket at a time. */
  #queue: Promise<unknown> = Promise.resolve();
  #idle: ReturnType<typeof setTimeout> | undefined;
  #onChange: (() => void) | undefined;
  #stopped = false;
  /** Logged once per distinct problem rather than on every poll. */
  #lastProblem = '';
  /** Some models NAK the 0x00 status read; fall back to one read per field. */
  #statusUnsupported = false;

  #state: DisplayState;

  constructor(opts: MdcOptions) {
    this.#opts = opts;
    const [address, port] = splitHostPort(opts.host);
    this.#address = address;
    this.#port = port;
    this.#state = {
      id: opts.id,
      reachable: false,
      power: null,
      volume: null,
      muted: null,
      input: null,
    };
  }

  get state(): DisplayState {
    return { ...this.#state };
  }

  /** Whether a new config entry describes the same display, so it can be kept. */
  matches(opts: MdcOptions): boolean {
    const o = this.#opts;
    return (
      o.id === opts.id &&
      o.host === opts.host &&
      o.displayId === opts.displayId &&
      (o.pin ?? '') === (opts.pin ?? '') &&
      (o.mac ?? '') === (opts.mac ?? '') &&
      (o.broadcast ?? '') === (opts.broadcast ?? '')
    );
  }

  onChange(fn: () => void): void {
    this.#onChange = fn;
  }

  stop(): void {
    this.#stopped = true;
    this.#close();
  }

  /* ── Reading ───────────────────────────────────────────────────────────*/

  /**
   * Re-read power, volume, mute and input. Resolves to whether anything
   * changed; never throws — a display that does not answer is a state, not
   * an error.
   */
  async refresh(): Promise<boolean> {
    try {
      const next = await this.#readStatus();
      this.#problem('');
      return this.#apply({ ...next, reachable: true });
    } catch (err) {
      this.#problem(err instanceof Error ? err.message : String(err));
      return this.#apply({ reachable: false });
    }
  }

  async #readStatus(): Promise<Omit<DisplayState, 'id' | 'reachable'>> {
    if (!this.#statusUnsupported) {
      const reply = await this.#request(CMD.status);
      if (reply.ack && reply.data.length >= 4) {
        const [power, volume, mute, input] = reply.data as [number, number, number, number];
        return {
          power: power === 0x01,
          volume: volume === 0xff ? null : volume,
          muted: mute === 0xff ? null : mute === 0x01,
          input: SOURCE_NAMES.get(input) ?? null,
        };
      }
      // A NAK for status on a set that answers everything else: remember,
      // and read the fields one at a time from now on.
      this.#statusUnsupported = true;
      log.info(`${this.#opts.id}: status read not supported, reading fields individually`);
    }

    const power = await this.#request(CMD.power);
    if (!power.ack) throw new Error(`Display refused power read (error ${power.data[0] ?? '?'})`);
    const on = power.data[0] === 0x01;
    // In standby many sets NAK everything but power. Keep the last-known
    // volume rather than blanking it, so the slider does not jump to 0.
    if (!on) {
      return { power: false, volume: this.#state.volume, muted: this.#state.muted, input: this.#state.input };
    }
    const volume = await this.#request(CMD.volume);
    const mute = await this.#request(CMD.mute);
    const input = await this.#request(CMD.input);
    return {
      power: true,
      volume: volume.ack && volume.data[0] !== 0xff ? (volume.data[0] ?? null) : null,
      muted: mute.ack && mute.data[0] !== 0xff ? mute.data[0] === 0x01 : null,
      input: input.ack ? (SOURCE_NAMES.get(input.data[0] ?? -1) ?? null) : null,
    };
  }

  /* ── Commands ──────────────────────────────────────────────────────────
     Each resolves to null on success or a reason for the panel, and
     re-reads afterwards so the card shows what the display says rather
     than what was asked for. */

  async isOn(): Promise<boolean> {
    await this.refresh();
    return this.#state.reachable && this.#state.power === true;
  }

  async turnOn(): Promise<string | null> {
    if (this.#opts.mac) {
      // Only matters on a set whose Network Standby is off; harmless otherwise.
      try {
        await wake(this.#opts.mac, wakeTargets(this.#address, this.#opts.broadcast));
      } catch (err) {
        log.debug(`${this.#opts.id}: wake-on-LAN failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    const until = Date.now() + POWER_ON_SETTLE_MS;
    let problem: string | null = 'Display did not answer';
    // Retried: a set whose network is only just coming up (after WOL) refuses
    // the connection for the first second or two.
    while (Date.now() < until && !this.#stopped) {
      problem = await this.#set(CMD.power, [0x01], 'power on');
      if (!problem) break;
      await delay(1000);
    }
    if (problem) {
      await this.refresh();
      return problem;
    }
    // The ACK comes before the picture does. Optimistically say "on" so the
    // toggle flips at once, then let the re-read confirm.
    this.#apply({ reachable: true, power: true });
    void this.refresh();
    return null;
  }

  async turnOff(): Promise<string | null> {
    const problem = await this.#set(CMD.power, [0x00], 'power off');
    if (!problem) this.#apply({ reachable: true, power: false });
    void this.refresh();
    return problem;
  }

  async setVolume(level: number): Promise<string | null> {
    const value = Math.max(0, Math.min(100, Math.round(level)));
    const problem = await this.#set(CMD.volume, [value], 'volume');
    if (!problem) this.#apply({ reachable: true, volume: value });
    void this.refresh();
    return problem;
  }

  async setMute(muted: boolean): Promise<string | null> {
    const problem = await this.#set(CMD.mute, [muted ? 0x01 : 0x00], muted ? 'mute' : 'unmute');
    if (!problem) this.#apply({ reachable: true, muted });
    void this.refresh();
    return problem;
  }

  async setInput(input: string): Promise<string | null> {
    const name = sourceName(input);
    const code = name ? SOURCES[name] : undefined;
    if (!name || code === undefined) return `Unknown input "${input}"`;
    const problem = await this.#set(CMD.input, [code], `input ${name}`);
    if (!problem) this.#apply({ reachable: true, input: name });
    void this.refresh();
    return problem;
  }

  async #set(cmd: number, data: number[], what: string): Promise<string | null> {
    try {
      const reply = await this.#request(cmd, data);
      this.#problem('');
      if (!reply.ack) {
        // A NAK most often means the set is in standby and refusing
        // everything but power — worth saying in those words.
        const standby = this.#state.power === false && cmd !== CMD.power;
        return standby ? 'Display is off' : `Display refused ${what} (error ${reply.data[0] ?? '?'})`;
      }
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#problem(message);
      this.#apply({ reachable: false });
      return message;
    }
  }

  /* ── Transport ─────────────────────────────────────────────────────────*/

  #request(cmd: number, data: number[] = []): Promise<MdcReply> {
    const run = async (): Promise<MdcReply> => {
      if (this.#stopped) throw new Error('Stopped');
      const socket = await this.#connect();
      this.#armIdle();
      return new Promise<MdcReply>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#waiter = undefined;
          // A frame that went unanswered leaves the stream in an unknown
          // place; start the next request on a fresh socket.
          this.#close();
          reject(new Error('Display did not answer'));
        }, REQUEST_TIMEOUT_MS);
        this.#waiter = { cmd, resolve, reject, timer };
        socket.write(encodeFrame(cmd, this.#opts.displayId, data));
      });
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #connect(): Promise<Socket> {
    if (this.#socket && !this.#socket.destroyed) return Promise.resolve(this.#socket);
    if (this.#connecting) return this.#connecting;

    this.#connecting = this.#open().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #open(): Promise<Socket> {
    const raw = await new Promise<Socket>((resolve, reject) => {
      const s = tcpConnect({ host: this.#address, port: this.#port });
      s.setNoDelay(true);
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error('Display did not answer'));
      }, CONNECT_TIMEOUT_MS);
      s.once('connect', () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        s.destroy();
        reject(new Error(describeSocketError(err)));
      });
    });

    let socket: Socket = raw;
    if (this.#opts.pin) {
      socket = await this.#secure(raw, this.#opts.pin);
    }

    this.#buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => this.#onData(chunk));
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (this.#socket === socket) this.#socket = undefined;
      const w = this.#waiter;
      if (w) {
        this.#waiter = undefined;
        clearTimeout(w.timer);
        w.reject(new Error('Display closed the connection'));
      }
    });
    this.#socket = socket;
    socket.resume();
    return socket;
  }

  /** The Secure MDC handshake: greeting, TLS, PIN, verdict. */
  async #secure(raw: Socket, pin: string): Promise<Socket> {
    const greeting = await readBytes(raw, 15);
    if (greeting.toString('latin1') !== 'MDCSTART<<TLS>>') {
      raw.destroy();
      throw new Error('A PIN is set but the display is not using Secure MDC — remove MDC_PIN');
    }
    const tls = await new Promise<Socket>((resolve, reject) => {
      const s = tlsConnect({ socket: raw, rejectUnauthorized: false, checkServerIdentity: () => undefined });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error('Secure MDC handshake timed out'));
      }, CONNECT_TIMEOUT_MS);
      s.once('secureConnect', () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once('error', (err) => {
        clearTimeout(timer);
        s.destroy();
        reject(new Error(`Secure MDC handshake failed: ${err.message}`));
      });
    });
    tls.write(pin.padStart(4, '0'));
    const verdict = (await readBytes(tls, 15)).toString('latin1');
    if (verdict !== 'MDCAUTH<<PASS>>') {
      tls.destroy();
      throw new Error('Display rejected the MDC PIN');
    }
    return tls;
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);

    // Secure MDC greeting on a connection with no PIN configured: say so
    // rather than waiting for a frame that is never coming.
    if (!this.#opts.pin && this.#buffer.toString('latin1').startsWith('MDCSTART')) {
      this.#fail(new Error('Display requires Secure MDC — set MDC_PIN (or MDC_PIN_<ID>) in .env'));
      return;
    }

    for (;;) {
      let decoded: ReturnType<typeof decodeFrame>;
      try {
        decoded = decodeFrame(this.#buffer);
      } catch (err) {
        this.#fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (!decoded) return;
      this.#buffer = this.#buffer.subarray(decoded.used);
      const w = this.#waiter;
      // A reply for some other command is a stray from a timed-out request.
      if (!w || decoded.reply.cmd !== w.cmd) continue;
      this.#waiter = undefined;
      clearTimeout(w.timer);
      w.resolve(decoded.reply);
    }
  }

  #fail(err: Error): void {
    const w = this.#waiter;
    this.#waiter = undefined;
    if (w) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.#close();
  }

  #armIdle(): void {
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.#close(), IDLE_CLOSE_MS);
    this.#idle.unref();
  }

  #close(): void {
    clearTimeout(this.#idle);
    this.#idle = undefined;
    const s = this.#socket;
    this.#socket = undefined;
    this.#buffer = Buffer.alloc(0);
    s?.destroy();
  }

  /* ── State ─────────────────────────────────────────────────────────────*/

  #apply(patch: Partial<Omit<DisplayState, 'id'>>): boolean {
    const prev = this.#state;
    const next = { ...prev, ...patch };
    const changed =
      next.reachable !== prev.reachable ||
      next.power !== prev.power ||
      next.volume !== prev.volume ||
      next.muted !== prev.muted ||
      next.input !== prev.input;
    this.#state = next;
    if (changed) this.#onChange?.();
    return changed;
  }

  #problem(message: string): void {
    if (message === this.#lastProblem) return;
    this.#lastProblem = message;
    if (message) log.warn(`${this.#opts.id} (${this.#opts.host}): ${message}`);
    else log.info(`${this.#opts.id}: connected`);
  }
}

function splitHostPort(host: string): [string, number] {
  const m = /^(.*):(\d+)$/.exec(host);
  if (m) return [m[1]!, Number(m[2])];
  return [host, DEFAULT_PORT];
}

function describeSocketError(err: NodeJS.ErrnoException): string {
  switch (err.code) {
    case 'ECONNREFUSED':
      return 'Display refused the connection — is MDC enabled on the network (port 1515)?';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'ETIMEDOUT':
      return 'Display unreachable — off with Network Standby disabled, or wrong address';
    default:
      return err.message;
  }
}

/** Read exactly `n` bytes, for the Secure MDC handshake's fixed-size messages. */
function readBytes(socket: Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error('Display did not answer')), CONNECT_TIMEOUT_MS);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= n) {
        // Anything past the message belongs to whatever reads next.
        const rest = buf.subarray(n);
        done(null, buf.subarray(0, n));
        if (rest.length > 0) socket.unshift(rest);
      }
    };
    const onError = (err: Error): void => done(err);
    const onClose = (): void => done(new Error('Display closed the connection'));
    function done(err: Error | null, value?: Buffer): void {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        resolve(value!);
      }
    }
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.resume();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
