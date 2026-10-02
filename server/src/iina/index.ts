import { logger } from '~/lib/log.ts';
import type { SshHostConfig } from '@shared/config.ts';
import type { IinaCommand, IinaState } from '@shared/protocol.ts';

const log = logger('iina');

/**
 * IINA on a Mac, read and driven over SSH through mpv's IPC socket.
 *
 * IINA has no remote-control API of its own, but it embeds mpv, and mpv
 * answers JSON on a Unix socket when `input-ipc-server` is set. IINA will not
 * take that option from an `iina://` link (it is not on its safe list), so it
 * is a one-time setting on the Mac: Settings > Advanced > enable advanced
 * settings, then add the mpv option `input-ipc-server` with the value
 * {@link SOCKET}.
 *
 * ## Reading
 *
 * One SSH connection per Mac while something is being watched, running a
 * small loop on the Mac that asks mpv for its state every few seconds with
 * `nc -U` and prints the answer. A connection per question would be a login
 * every five seconds for the length of a film. The loop gives up on its own
 * once the socket has stopped answering for a couple of minutes (IINA quit,
 * or was never set up), and this side hangs up once IINA has been idle as
 * long — so nothing is left running on the Mac.
 *
 * ## Driving
 *
 * Each control is one fixed mpv command, built here from the op and a
 * clamped number. The panel never sends text that reaches the shell.
 */

/** Where mpv inside IINA listens. Must match the option set in IINA. */
export const SOCKET = '/tmp/iina-navigator.sock';
const POLL_SECONDS = 5;
/** Missed polls before the loop on the Mac stops: a little over two minutes. */
const MISSES_TO_QUIT = 24;
/** Idle reports (nothing loaded) before this side hangs up. */
const IDLE_TO_QUIT = 24;
const SEEK_BACK = 10;
const SEEK_FORWARD = 30;
const VOLUME_STEP = 5;

/** One reading of mpv. */
export interface IinaStatus {
  position: number | null;
  duration: number | null;
  paused: boolean;
  volume: number | null;
  muted: boolean;
  /** What mpv opened, exactly as it was given. Empty when nothing is. */
  path: string;
  title: string | null;
}

/** Someone who wants every reading while a stream runs — Plex, for sync. */
export interface IinaListener {
  status(status: IinaStatus): void;
  /**
   * A better name for what is playing than mpv has. A file streamed from
   * Plex is called `file.mkv` as far as mpv knows; Plex knows the film.
   */
  titleFor?(status: IinaStatus): string | null;
  /** Artwork for it, as an authenticated path on this backend. */
  artFor?(status: IinaStatus): string | null;
  /** The stream ended, or another listener took over. Called once. */
  end(): void;
}

export interface IinaDeps {
  /** Hosts in `controls.ssh`, current as of now. Those marked `iina` count. */
  sshHosts: () => SshHostConfig[];
  run: (host: string, command: string) => Promise<string | null>;
  stream: (host: string, command: string, onLine: (line: string) => void, signal: AbortSignal) => Promise<string | null>;
  onChange: (players: IinaState[]) => void;
}

interface Watch {
  abort: AbortController;
  listener: IinaListener | null;
  idle: number;
}

/**
 * mpv's `expand-text` fills one template from many properties, so a single
 * request answers everything. `|` separates them; the title goes last, since
 * it is the one field that could contain one.
 */
const STATUS_REQUEST = JSON.stringify({
  command: ['expand-text', '${=time-pos:}|${=duration:}|${=pause:}|${=volume:}|${=mute:}|${=path:}|${media-title:}'],
});

/**
 * The loop that runs on the Mac. POSIX sh, so it means the same under zsh
 * (the default login shell) and bash. Every quoted piece is fixed text.
 */
const STATUS_LOOP = [
  `Q='${STATUS_REQUEST}'`,
  'n=0',
  'while :; do',
  `o=$(printf '%s\\n' "$Q" | nc -U -w 1 ${SOCKET} 2>/dev/null)`,
  `if [ -n "$o" ]; then printf '%s\\n' "$o"; n=0; else n=$((n+1)); [ "$n" -ge ${MISSES_TO_QUIT} ] && exit 0; fi`,
  `sleep ${POLL_SECONDS}`,
  'done',
].join('\n');

export class Iina {
  readonly #deps: IinaDeps;
  readonly #states = new Map<string, IinaState>();
  readonly #watches = new Map<string, Watch>();

  constructor(deps: IinaDeps) {
    this.#deps = deps;
  }

  /** Every IINA Mac, watched or not. */
  snapshot(): IinaState[] {
    return this.#macs().map((mac) => ({ ...this.#state(mac) }));
  }

  /**
   * Make sure this Mac is being read, and optionally follow it.
   *
   * A new listener replaces the last one, which is told it has ended: only
   * the most recent thing sent to a Mac is the thing being watched there.
   */
  watch(macId: string, listener?: IinaListener): void {
    const mac = this.#macs().find((host) => host.id === macId);
    if (!mac) return;
    const running = this.#watches.get(mac.id);
    if (running) {
      if (listener) {
        running.listener?.end();
        running.listener = listener;
      }
      return;
    }
    const watch: Watch = { abort: new AbortController(), listener: listener ?? null, idle: 0 };
    this.#watches.set(mac.id, watch);
    this.#deps
      .stream(mac.id, STATUS_LOOP, (line) => this.#onLine(mac, watch, line), watch.abort.signal)
      .then((problem) => this.#ended(mac, watch, problem))
      .catch((error: unknown) => this.#ended(mac, watch, error instanceof Error ? error.message : String(error)));
  }

  /** Null on success, otherwise a sentence for the panel. */
  async command(macId: string, op: IinaCommand, value?: number): Promise<string | null> {
    const mac = this.#macs().find((host) => host.id === macId);
    if (!mac) return 'That Mac is not set up for IINA';
    if (op === 'status') {
      this.watch(mac.id);
      return null;
    }
    const args = mpvCommand(op, value);
    if (!args) return 'Unknown IINA control';
    const request = JSON.stringify({ command: args });
    // Fixed ops and numbers only — but this reaches a shell, so check anyway.
    if (!/^[A-Za-z0-9{}[\]":,._ -]+$/.test(request)) return 'Refusing an unsafe IINA command';
    const problem = await this.#deps.run(
      mac.id,
      `printf '%s\\n' '${request}' | nc -U -w 1 ${SOCKET} | grep -q '"error":"success"'`,
    );
    if (problem) {
      const message = /exited 1$/.test(problem)
        ? `IINA is not playing on ${mac.name}, or its mpv socket is not set up (input-ipc-server=${SOCKET}).`
        : `Could not reach ${mac.name}: ${problem}`;
      this.#update(mac, { error: message });
      return message;
    }
    this.#optimistic(mac, op, value);
    this.watch(mac.id);
    return null;
  }

  #onLine(mac: SshHostConfig, watch: Watch, line: string): void {
    const status = parseStatus(line);
    if (!status) return;
    watch.listener?.status(status);
    if (!status.path) {
      watch.idle += 1;
      this.#update(mac, { active: false, error: null });
      if (watch.idle >= IDLE_TO_QUIT) watch.abort.abort();
      return;
    }
    watch.idle = 0;
    this.#update(mac, {
      active: true,
      title: watch.listener?.titleFor?.(status) ?? status.title ?? fileName(status.path),
      art: watch.listener?.artFor?.(status) ?? null,
      paused: status.paused,
      position: status.position,
      positionAt: Date.now(),
      duration: status.duration,
      volume: status.volume,
      muted: status.muted,
      error: null,
    });
  }

  #ended(mac: SshHostConfig, watch: Watch, problem: string | null): void {
    if (this.#watches.get(mac.id) === watch) this.#watches.delete(mac.id);
    watch.listener?.end();
    watch.listener = null;
    if (problem) log.debug(`${mac.id}: status stream ended: ${problem}`);
    this.#update(mac, { active: false, ...(problem ? { error: `Could not read IINA on ${mac.name}: ${problem}` } : {}) });
  }

  /** Show a press straight away rather than at the next reading. */
  #optimistic(mac: SshHostConfig, op: IinaCommand, value?: number): void {
    const state = this.#state(mac);
    const now = Date.now();
    const at = state.position !== null && state.positionAt !== null && !state.paused
      ? state.position + (now - state.positionAt) / 1000
      : state.position;
    const clampTo = (seconds: number): number =>
      Math.max(0, state.duration ? Math.min(state.duration, seconds) : seconds);
    switch (op) {
      case 'play_pause':
        this.#update(mac, { paused: !state.paused, position: at, positionAt: now, error: null });
        break;
      case 'seek_back':
      case 'seek_forward':
      case 'seek':
        if (at === null && op !== 'seek') break;
        this.#update(mac, {
          position: clampTo(op === 'seek' ? value ?? 0 : (at ?? 0) + (op === 'seek_back' ? -SEEK_BACK : SEEK_FORWARD)),
          positionAt: now,
          error: null,
        });
        break;
      case 'volume_up':
      case 'volume_down':
      case 'volume': {
        const base = state.volume ?? 100;
        const next = op === 'volume' ? value ?? base : base + (op === 'volume_up' ? VOLUME_STEP : -VOLUME_STEP);
        this.#update(mac, { volume: Math.max(0, Math.min(100, next)), error: null });
        break;
      }
      case 'mute':
        this.#update(mac, { muted: !state.muted, error: null });
        break;
      case 'stop':
        this.#update(mac, { active: false, error: null });
        break;
      default:
        break;
    }
  }

  #update(mac: SshHostConfig, patch: Partial<IinaState>): void {
    this.#states.set(mac.id, { ...this.#state(mac), ...patch });
    this.#deps.onChange(this.snapshot());
  }

  #state(mac: SshHostConfig): IinaState {
    const known = this.#states.get(mac.id);
    if (known) return { ...known, name: mac.name };
    return {
      id: mac.id,
      name: mac.name,
      active: false,
      title: null,
      art: null,
      paused: false,
      position: null,
      positionAt: null,
      duration: null,
      volume: null,
      muted: false,
      error: null,
    };
  }

  #macs(): SshHostConfig[] {
    return this.#deps.sshHosts().filter((host) => host.iina);
  }
}

/** The mpv command for one control, or null for an op that is not one. */
export function mpvCommand(op: IinaCommand, value?: number): (string | number)[] | null {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : null;
  switch (op) {
    case 'play_pause': return ['cycle', 'pause'];
    case 'seek_back': return ['seek', -SEEK_BACK, 'relative'];
    case 'seek_forward': return ['seek', SEEK_FORWARD, 'relative'];
    case 'seek': return number === null ? null : ['seek', Math.max(0, Math.round(number)), 'absolute'];
    case 'stop': return ['stop'];
    case 'volume_up': return ['add', 'volume', VOLUME_STEP];
    case 'volume_down': return ['add', 'volume', -VOLUME_STEP];
    case 'volume': return number === null ? null : ['set_property', 'volume', Math.max(0, Math.min(100, Math.round(number)))];
    case 'mute': return ['cycle', 'mute'];
    default: return null;
  }
}

/**
 * One line from the loop. mpv also pushes events on the same socket
 * (`{"event":...}`), which carry no `data` and are skipped.
 */
export function parseStatus(line: string): IinaStatus | null {
  let body: unknown;
  try {
    body = JSON.parse(line);
  } catch {
    return null;
  }
  const data = (body as { data?: unknown } | null)?.data;
  if (typeof data !== 'string') return null;
  const [position, duration, pause, volume, mute, path, ...title] = data.split('|');
  if (path === undefined) return null;
  return {
    position: seconds(position),
    duration: seconds(duration),
    paused: pause === 'yes',
    volume: seconds(volume),
    muted: mute === 'yes',
    path,
    title: title.join('|') || null,
  };
}

function seconds(text: string | undefined): number | null {
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** The last path segment, without a query — for a file with no title. */
function fileName(path: string): string {
  const bare = path.split('?')[0] ?? path;
  const last = bare.slice(bare.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last) || path;
  } catch {
    return last || path;
  }
}
