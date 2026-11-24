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
  run: (host: string, command: string) => Promise<DdcRunResult>;
  /** For tests. */
  settleMs?: number;
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

export class DdcClient {
  readonly #opts: DdcOptions;
  readonly #base: string;
  #state: DisplayState;
  #onChange: (() => void) | undefined;
  #stopped = false;
  /** One command at a time: m1ddc reads and writes the same I2C bus. */
  #queue: Promise<unknown> = Promise.resolve();
  #hold: { power: boolean; until: number } | undefined;
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #lastProblem = '';
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
    this.#base = opts.display ? `${opts.m1ddc} display ${opts.display}` : opts.m1ddc;
    this.#state = { id: opts.id, reachable: false, power: null, volume: null, muted: null, input: null };
  }

  get state(): DisplayState {
    return { ...this.#state };
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

  /** Re-read power, volume, mute and input. Never throws. */
  async refresh(): Promise<boolean> {
    if (this.#stopped) return false;
    // One SSH session for all four reads. Each line is `name=value`; a value
    // m1ddc could not read is empty. `missing` means m1ddc is not installed.
    const gets = ['standby', 'volume', 'mute', 'input']
      .map((c) => `printf '%s=%s\\n' ${c} "$(${this.#base} get ${c} 2>/dev/null)"`)
      .join('; ');
    const command = `[ -x ${this.#opts.m1ddc} ] || { echo missing; exit 0; }; ${gets}`;
    const { problem, lines } = await this.#exec(command);

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
      const m = /^(standby|volume|mute|input)=(-?\d+)\s*$/.exec(line);
      if (m) read.set(m[1]!, Number(m[2]));
    }
    this.#problem('');

    let next: Partial<Omit<DisplayState, 'id'>>;
    if (read.size === 0) {
      // m1ddc ran and found nothing to talk to: asleep, or no picture.
      next = { reachable: true, power: false };
    } else {
      const standby = read.get('standby');
      const mute = read.get('mute');
      const input = read.get('input');
      next = {
        reachable: true,
        // Some monitors do not report 0xD6; answering at all means it is on.
        power: standby === undefined ? true : standby === 1,
        volume: read.get('volume') ?? null,
        muted: mute === undefined ? null : mute === 1,
        // Some Dells put a flag in the high byte; the input is the low one.
        input: input === undefined ? null : ddcSourceName(String(input & 0xff)),
      };
    }

    if (this.#opts.offInput && next.power !== false) {
      if (this.#parked && next.input === this.#opts.offInput) next = { ...next, power: false };
      else if (next.input && next.input !== this.#opts.offInput) this.#parked = false;
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
   * Wake the Mac's display output, then ask the monitor to come out of
   * standby. Either can be what works: a monitor the Mac has stopped
   * driving answers nothing over DDC until the picture comes back, which is
   * what `caffeinate -u` brings.
   */
  async turnOn(): Promise<string | null> {
    const off = this.#opts.offInput;
    if (off) {
      // Back to what was showing before Off, by way of the wake input: a
      // sleeping P4326QEB ignores a switch to HDMI but wakes for USB-C.
      // Waking the Mac's output first covers a Mac whose display had slept.
      const target = this.#resume ?? this.#opts.onInput ?? 'HDMI1';
      const code = ddcCode(target);
      if (code === undefined) return `Unknown input "${target}"`;
      const problem = await this.#write(`/usr/bin/caffeinate -u -t 1; ${this.#wakeThen(target, code)}`);
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

    /*
     * Asleep, this monitor ignores a switch to any input but the wake one,
     * so wake it first — but only when it IS asleep: on an awake monitor
     * the detour would flash whatever is on the wake input (a laptop) for a
     * few seconds. Asleep is read fresh, not taken from the last poll, which
     * may be fifteen seconds old.
     */
    let command = `${this.#base} set input ${code}`;
    if (this.#opts.offInput && name !== this.#opts.offInput) {
      await this.refresh();
      if (this.#state.power !== true) command = this.#wakeThen(name, code);
    }

    const problem = await this.#write(command);
    if (!problem) {
      // Choosing an input — even the "off" one, as a laptop — is turning it on.
      this.#parked = false;
      this.#hold = undefined;
      this.#apply({ reachable: true, input: name, power: true });
    }
    return problem;
  }

  /* ── Internals ─────────────────────────────────────────────────────────*/

  /** Switch to the wake input, give it time to come up, then to `name`. */
  #wakeThen(name: string, code: number): string {
    const off = this.#opts.offInput;
    const offCode = off ? ddcCode(off) : undefined;
    if (!off || offCode === undefined || name === off) return `${this.#base} set input ${code}`;
    const wait = Math.max(0, Math.min(30, Math.round(this.#opts.wakeSeconds ?? WAKE_SECONDS)));
    return `${this.#base} set input ${offCode}; sleep ${wait}; ${this.#base} set input ${code}`;
  }

  async #write(command: string): Promise<string | null> {
    const { problem, lines } = await this.#exec(`${command} 2>&1`);
    if (!problem) return null;
    // m1ddc's own words ("Could not find a suitable display") say more
    // than "exited 1".
    const said = lines.filter(Boolean).at(-1);
    return said ? `${this.#opts.id}: ${said}` : problem;
  }

  #exec(command: string): Promise<DdcRunResult> {
    const next = this.#queue.then(() => this.#opts.run(this.#opts.ssh, command));
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
