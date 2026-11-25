import { logger } from '~/lib/log.ts';
import type { DisplayState } from '@shared/protocol.ts';

const log = logger('ddc');

/**
 * A monitor driven over DDC/CI from the computer it is plugged into — the
 * Dell P4326QEB on the Mac Studio, through `m1ddc`, over SSH.
 *
 * **Why this way round.** A desktop monitor has no network control of its
 * own: the Dell's RJ45 port is a network adapter for the computer on its
 * USB-C, and its settings are reached over the video cable (DDC/CI). So the
 * one thing on the LAN that can talk to it is that computer. The backend
 * already reaches the Mac over SSH for `caffeinate` with a pinned host key,
 * so the commands go the same way rather than through a second, open HTTP
 * service on the Mac that anything on the network could call.
 *
 * Presents the same face as MdcClient, so a `display:` card and its keys
 * drive a Samsung over MDC and a Dell over DDC with one vocabulary.
 *
 * **States.** SSH fails → unreachable. SSH works but m1ddc finds no display
 * → reachable and OFF: the monitor is in standby, or the Mac has stopped
 * sending it a picture, and power is the button that can fix that.
 *
 * **What was learned on the real P4326QEB**, and shapes everything below:
 *   - DDC standby (VCP 0xD6) takes it off the bus entirely: nothing can
 *     wake it again. So it is turned off by switching to an input with no
 *     signal (`offInput`), where it sleeps by itself but still answers.
 *   - Asleep, it ignores a switch to HDMI but wakes for USB-C. So reaching
 *     HDMI from asleep goes by way of USB-C (`#switchTo`).
 *   - It shows its volume bar for a volume or mute write and keeps its old
 *     value, so those controls are switched off in its config.
 *   - Some replies carry a flag in the high byte (`max volume` reads
 *     0xFF64), so every value read is masked to its low byte.
 */

/** VCP 0x60 input codes, named the way `display:` keys already name inputs. */
export const DDC_SOURCES: Readonly<Record<string, number>> = {
  DISPLAY_PORT_1: 15,
  DISPLAY_PORT_2: 16,
  HDMI1: 17,
  HDMI2: 18,
  USB_C: 27,
};

const DDC_NAMES = new Map(Object.entries(DDC_SOURCES).map(([name, code]) => [code, name]));

/**
 * `HDMI 1`, `hdmi1`, `USB-C`, `usbc`, `DisplayPort 1`, `27` → the canonical
 * name, or null. A bare number outside the table is kept as `INPUT_<n>` so a
 * monitor with an unusual code can still be driven.
 */
export function ddcSourceName(input: string): string | null {
  const s = input.trim();
  if (/^\d{1,3}$/.test(s)) {
    const code = Number(s);
    if (code < 1 || code > 255) return null;
    return DDC_NAMES.get(code) ?? `INPUT_${code}`;
  }
  const custom = /^INPUT_(\d{1,3})$/i.exec(s);
  if (custom) return ddcSourceName(custom[1]!);
  const key = s
    .toUpperCase()
    .replace(/^(USB[\s_-]*C|TYPE[\s_-]*C|THUNDERBOLT)$/, 'USB_C')
    .replace(/DISPLAY\s*PORT|DP(?=\s*\d)/, 'DISPLAY_PORT_')
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^HDMI_(\d)/, 'HDMI$1')
    .replace(/^DISPLAY_PORT_?(\d)/, 'DISPLAY_PORT_$1');
  return key in DDC_SOURCES ? key : null;
}

function ddcCode(name: string): number | undefined {
  const custom = /^INPUT_(\d{1,3})$/.exec(name);
  return custom ? Number(custom[1]) : DDC_SOURCES[name];
}

export interface DdcRunResult {
  /** An error for the panel when the command could not be run, else null. */
  problem: string | null;
  lines: string[];
}

/** How a command is to be run on the host. */
export interface DdcRunHow {
  /**
   * Wait for a host that does not answer yet — true for a command somebody
   * asked for (a key, the card), which is often pressed in the same instant
   * as the Wake-on-LAN that wakes the Mac. False for a background read.
   */
  wait: boolean;
  /** Once connected, how long the command may take. */
  timeoutMs: number;
}

export interface DdcOptions {
  id: string;
  /** The `controls.ssh` host the monitor is plugged into. */
  ssh: string;
  /** Absolute path to m1ddc on that host. */
  m1ddc: string;
  /** m1ddc's `display <selector>`, when the host has more than one screen. */
  display?: string;
  /** The VCP 0xD6 value that turns the monitor off: 4 (standby) or 5 (off). */
  standby: number;
  /**
   * Off by switching to this input rather than DDC standby (canonical name).
   * See DdcConfig.offInput.
   */
  offInput?: string;
  /** With `offInput`: where On goes when the input before Off is unknown. */
  onInput?: string;
  /**
   * With `offInput`: seconds between the wake (switching to `offInput`) and
   * switching on to the input that was asked for. Default WAKE_SECONDS.
   */
  wakeSeconds?: number;
  /** Runs a shell command on `ssh` and returns what it printed. */
  run: (host: string, command: string, how: DdcRunHow) => Promise<DdcRunResult>;
  /** For tests. */
  settleMs?: number;
  /** For tests: the pause before retrying a write the monitor fumbled. */
  retryMs?: number;
}

/**
 * How long the P4326QEB takes to come up after a switch to USB-C wakes it,
 * before it will take a switch to another input. A guess with margin.
 */
const WAKE_SECONDS = 3;

/** How long a power change is believed over a read that disagrees. */
const SETTLE_MS = 20_000;
/** Re-reads while it settles. */
const SETTLE_READS_MS = [3000, 8000, 15000];

/**
 * How often to re-read in the background: often while the monitor is on (so
 * the card follows an input changed at the monitor itself), rarely while it
 * is off or the Mac does not answer.
 *
 * Each read is an SSH connection to the Mac. A Mac asleep for the night is
 * woken by one when a Bonjour Sleep Proxy (an Apple TV or HomePod) is on the
 * network — Wake on Demand — so reading every fifteen seconds all night would
 * keep it from ever staying asleep. Rarely is once every ten minutes.
 */
const POLL_ON_MS = 60_000;
const POLL_IDLE_MS = 10 * 60_000;

/** Commands are one-liners; a wake sequence adds its own pause. */
const COMMAND_TIMEOUT_MS = 15_000;
/** A write the monitor fumbles is tried once more after this. */
const RETRY_MS = 1500;
/** m1ddc's default 50 ms wait for a reply is short for this Dell. */
const READ_WAIT_MS = 100;

export class DdcClient {
  readonly #opts: DdcOptions;
  /** `m1ddc [display <selector>]`, for writes. */
  readonly #base: string;
  /** The same, with a longer wait for replies, for reads. */
  readonly #reader: string;
  #state: DisplayState;
  #onChange: (() => void) | undefined;
  #stopped = false;
  /** One command at a time: m1ddc reads and writes the same I2C bus. */
  #queue: Promise<unknown> = Promise.resolve();
  #hold: { power: boolean; until: number } | undefined;
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #lastProblem = '';
  /** When the last read was started, for the background poll's pacing. */
  #lastRead = 0;
  /** A read in flight: the poll does not stack another behind it. */
  #reading = false;
  /**
   * With `offInput`: true while the monitor sits on the "off" input because
   * WE put it there. The input alone cannot say off — the same input is
   * also a laptop somebody chose to show — so it is off only while this
   * holds, and it clears the moment the input is anything else.
   */
  #parked = false;
  /** With `offInput`: the input to return to on On. */
  #resume: string | undefined;

  constructor(opts: DdcOptions) {
    this.#opts = opts;
    const select = opts.display ? ` display ${opts.display}` : '';
    this.#base = `${opts.m1ddc}${select}`;
    this.#reader = `${opts.m1ddc} --read-wait ${READ_WAIT_MS}${select}`;
    this.#state = { id: opts.id, reachable: false, power: null, volume: null, muted: null, input: null };
  }

  get state(): DisplayState {
    return { ...this.#state };
  }

  /** The `controls.ssh` host this monitor is reached through. */
  get host(): string {
    return this.#opts.ssh;
  }

  matches(opts: Omit<DdcOptions, 'run'>): boolean {
    const o = this.#opts;
    return (
      o.id === opts.id &&
      o.ssh === opts.ssh &&
      o.m1ddc === opts.m1ddc &&
      (o.display ?? '') === (opts.display ?? '') &&
      o.standby === opts.standby &&
      (o.offInput ?? '') === (opts.offInput ?? '') &&
      (o.onInput ?? '') === (opts.onInput ?? '') &&
      o.wakeSeconds === opts.wakeSeconds
    );
  }

  onChange(fn: () => void): void {
    this.#onChange = fn;
  }

  stop(): void {
    this.#stopped = true;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
  }

  /** The canonical name for an input as this monitor names them. */
  inputName(input: string): string | null {
    return ddcSourceName(input);
  }

  /* ── Reading ───────────────────────────────────────────────────────────*/

  /**
   * The background poll's read: only when one is due (see POLL_ON_MS), and
   * never stacked on a read already in flight.
   */
  async poll(): Promise<boolean> {
    if (this.#stopped || this.#reading) return false;
    const every = this.#state.reachable && this.#state.power === true ? POLL_ON_MS : POLL_IDLE_MS;
    if (Date.now() - this.#lastRead < every) return false;
    return this.refresh();
  }

  /** Re-read power, volume, mute and input. Never throws. */
  async refresh(): Promise<boolean> {
    if (this.#stopped) return false;
    this.#lastRead = Date.now();
    this.#reading = true;
    try {
      return await this.#read();
    } finally {
      this.#reading = false;
    }
  }

  async #read(): Promise<boolean> {
    // One SSH session for all four reads. Each line is `name=value`; a value
    // m1ddc could not read is empty. `missing` means m1ddc is not installed.
    const gets = ['standby', 'volume', 'mute', 'input']
      .map((c) => `printf '%s=%s\\n' ${c} "$(${this.#reader} get ${c} 2>/dev/null)"`)
      .join('; ');
    const command = `[ -x ${this.#opts.m1ddc} ] || { echo missing; exit 0; }; ${gets}`;
    const { problem, lines } = await this.#exec(command, { wait: false, timeoutMs: COMMAND_TIMEOUT_MS });

    if (problem) {
      this.#problem(problem);
      return this.#apply({ reachable: false });
    }
    if (lines.includes('missing')) {
      this.#problem(`m1ddc is not installed at ${this.#opts.m1ddc} on ${this.#opts.ssh} (brew install m1ddc)`);
      return this.#apply({ reachable: false });
    }

    const read = new Map<string, number>();
    for (const line of lines) {
      const m = /^(standby|volume|mute|input)=(\d+)\s*$/.exec(line);
      // Low byte only: this Dell sets flags in the high byte of some replies.
      if (m) read.set(m[1]!, Number(m[2]) & 0xff);
    }
    this.#problem('');

    let next: Partial<Omit<DisplayState, 'id'>>;
    if (read.size === 0) {
      // m1ddc ran and found nothing to talk to: asleep, or no picture. The
      // rest is left as last known — "off" says all there is to say.
      next = { reachable: true, power: false };
    } else {
      const standby = read.get('standby');
      const volume = read.get('volume');
      const mute = read.get('mute');
      const input = read.get('input');
      next = {
        reachable: true,
        // Some monitors do not report 0xD6; answering at all means it is on.
        power: standby === undefined ? true : standby === 1,
      };
      // A value that did not come back this time keeps the last one read,
      // rather than blanking the card for a reply that was only slow.
      if (volume !== undefined) next.volume = volume;
      if (mute !== undefined) next.muted = mute === 1;
      if (input !== undefined) next.input = ddcSourceName(String(input));
    }

    if (this.#opts.offInput && next.power !== false) {
      const showing = next.input === undefined ? this.#state.input : next.input;
      if (this.#parked && showing === this.#opts.offInput) next = { ...next, power: false };
      else if (showing && showing !== this.#opts.offInput) this.#parked = false;
    }

    const hold = this.#hold && Date.now() < this.#hold.until ? this.#hold : undefined;
    if (hold && next.power !== hold.power) next = { ...next, power: hold.power };
    else this.#hold = undefined;
    return this.#apply(next);
  }

  async isOn(): Promise<boolean> {
    await this.refresh();
    return this.#state.reachable && this.#state.power === true;
  }

  /* ── Writing ───────────────────────────────────────────────────────────*/

  /**
   * With `offInput`: back to the input it was on before Off, waking it on
   * the way (see `#switchTo`).
   *
   * Without: wake the Mac's display output, then ask the monitor to come out
   * of DDC standby. Either can be what works: a monitor the Mac has stopped
   * driving answers nothing over DDC until the picture comes back, which is
   * what `caffeinate -u` brings.
   */
  async turnOn(): Promise<string | null> {
    const off = this.#opts.offInput;
    if (off) {
      const target = this.#resume ?? this.#opts.onInput ?? 'HDMI1';
      const code = ddcCode(target);
      if (code === undefined) return `Unknown input "${target}"`;
      const problem = await this.#switchTo(target, code);
      if (problem) return problem;
      this.#parked = false;
      this.#apply({ input: target });
      this.#settle(true);
      return null;
    }
    const problem = await this.#write(
      `/usr/bin/caffeinate -u -t 2; ${this.#base} set standby 1 >/dev/null 2>&1; exit 0`,
    );
    if (problem) return problem;
    this.#settle(true);
    return null;
  }

  async turnOff(): Promise<string | null> {
    const off = this.#opts.offInput;
    if (off) {
      const code = ddcCode(off);
      if (code === undefined) return `Unknown input "${off}"`;
      const showing = this.#state.input;
      if (showing && showing !== off) this.#resume = showing;
      const problem = await this.#write(`${this.#base} set input ${code}`);
      if (problem) return problem;
      this.#parked = true;
      this.#apply({ input: off });
      this.#settle(false);
      return null;
    }
    const problem = await this.#write(`${this.#base} set standby ${this.#opts.standby}`);
    if (problem) return problem;
    this.#settle(false);
    return null;
  }

  async setVolume(level: number): Promise<string | null> {
    const value = Math.max(0, Math.min(100, Math.round(level)));
    const problem = await this.#write(`${this.#base} set volume ${value}`);
    if (!problem) this.#apply({ reachable: true, volume: value });
    return problem;
  }

  async setMute(muted: boolean): Promise<string | null> {
    const problem = await this.#write(`${this.#base} set mute ${muted ? 'on' : 'off'}`);
    if (!problem) this.#apply({ reachable: true, muted });
    return problem;
  }

  async setInput(input: string): Promise<string | null> {
    const name = ddcSourceName(input);
    const code = name ? ddcCode(name) : undefined;
    if (!name || code === undefined) return `Unknown input "${input}"`;

    const problem = await this.#switchTo(name, code);
    if (!problem) {
      // Choosing an input — even the "off" one, as a laptop — is turning it
      // on. Read back shortly, so a switch the monitor did not take does not
      // sit on the card until the next poll.
      this.#parked = false;
      this.#apply({ reachable: true, input: name });
      this.#settle(true);
    }
    return problem;
  }

  /* ── Internals ─────────────────────────────────────────────────────────*/

  /**
   * Put the monitor on `name`, waking it first when it may be asleep.
   *
   * Without `offInput`, or when `name` IS the wake input, a plain switch:
   * switching to the wake input is itself what wakes it.
   *
   * Otherwise the monitor is read fresh, and:
   *   - awake on an input that is not the wake one → a plain switch (with
   *     the Mac's display output lit first if it is already on `name`). The
   *     detour would flash the wake input — a laptop — for no reason.
   *   - anything else — parked, asleep, on the wake input, unreadable, the
   *     Mac not answering yet → light the Mac's output, switch to the wake
   *     input, give it time to come up, then switch to `name`.
   *
   * The detour is the safe answer whenever the read cannot be trusted:
   * skipping it when it was needed is a key that does nothing, taking it
   * when it was not is a moment on the wake input. Being "off" is only known
   * for certain when WE parked it, and that is forgotten on a restart; asleep
   * on USB-C may well read as on. Already on the wake input, the detour costs
   * nothing but its pause.
   */
  async #switchTo(name: string, code: number): Promise<string | null> {
    const off = this.#opts.offInput;
    const offCode = off ? ddcCode(off) : undefined;
    const plain = `${this.#base} set input ${code}`;
    if (!off || offCode === undefined || name === off) return this.#write(plain);

    await this.refresh();
    const s = this.#state;
    const lit = '/usr/bin/caffeinate -u -t 1';
    if (s.reachable && s.power === true && s.input !== null && s.input !== off) {
      return this.#write(s.input === name ? `${lit}; ${plain}` : plain);
    }

    const wait = Math.max(0, Math.min(30, Math.round(this.#opts.wakeSeconds ?? WAKE_SECONDS)));
    return this.#write(`${lit}; ${this.#base} set input ${offCode}; sleep ${wait}; ${plain}`, wait);
  }

  /**
   * Run a command somebody asked for: waits for a Mac that is still waking,
   * and tries once more if the monitor fumbles it.
   *
   * The retry is for m1ddc's own failures — "DDC communication failure",
   * or the display briefly missing while the Mac re-reads its screens (the
   * LG on the same Mac being turned on by the same key does exactly that).
   * Every write here is idempotent, so a second go costs nothing.
   */
  async #write(command: string, pauseSeconds = 0): Promise<string | null> {
    const how = { wait: true, timeoutMs: COMMAND_TIMEOUT_MS + pauseSeconds * 1000 };
    let { problem, lines } = await this.#exec(`${command} 2>&1`, how);
    if (problem && fumbled(lines)) {
      await delay(this.#opts.retryMs ?? RETRY_MS);
      ({ problem, lines } = await this.#exec(`${command} 2>&1`, how));
    }
    if (!problem) return null;
    // m1ddc's own words ("Could not find a suitable display") say more
    // than "exited 1".
    const said = lines.filter((l) => !/^Writing \d+$/.test(l)).at(-1);
    return said ? `${this.#opts.id}: ${said}` : problem;
  }

  #exec(command: string, how: DdcRunHow): Promise<DdcRunResult> {
    const next = this.#queue.then(() => this.#opts.run(this.#opts.ssh, command, how));
    this.#queue = next.catch(() => undefined);
    return next.catch((err: unknown) => ({
      problem: err instanceof Error ? err.message : String(err),
      lines: [],
    }));
  }

  /** Believe a power change for a while, and read back as it lands. */
  #settle(power: boolean): void {
    this.#hold = { power, until: Date.now() + (this.#opts.settleMs ?? SETTLE_MS) };
    this.#apply({ reachable: true, power });
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    for (const ms of SETTLE_READS_MS) {
      const t = setTimeout(() => {
        this.#timers.delete(t);
        void this.refresh();
      }, ms);
      t.unref?.();
      this.#timers.add(t);
    }
  }

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
    if (changed && !this.#stopped) this.#onChange?.();
    return changed;
  }

  #problem(message: string): void {
    if (message === this.#lastProblem) return;
    this.#lastProblem = message;
    if (message) log.warn(`${this.#opts.id} (via ${this.#opts.ssh}): ${message}`);
    else log.info(`${this.#opts.id}: answering over DDC via ${this.#opts.ssh}`);
  }
}

/** m1ddc reported a DDC-level failure, as opposed to SSH failing. */
function fumbled(lines: string[]): boolean {
  return lines.some((l) => /DDC communication failure|does not exist|suitable display/i.test(l));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
