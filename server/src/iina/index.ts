import { logger } from '~/lib/log.ts';
import type { SshHostConfig, SshScreenConfig } from '@shared/config.ts';
import type { IinaCommand, IinaNext, IinaSkip, IinaState, IinaTrack } from '@shared/protocol.ts';

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
 * small loop on the Mac that every few seconds asks mpv for its state and its
 * tracks with `nc -U`, asks macOS for the output volume, and prints the
 * answers. A connection per question would be a login every five seconds for
 * the length of a film. The loop gives up on its own once the socket has
 * stopped answering for a couple of minutes (IINA quit, or was never set
 * up), and this side hangs up once IINA has been idle as long — so nothing
 * is left running on the Mac.
 *
 * ## Driving
 *
 * Each control is one fixed command, built here from the op and a clamped
 * number. The panel never sends text that reaches the shell.
 *
 * ## Displays
 *
 * IINA ignores mpv's `screen` options — it places its own windows — so
 * sending it to a display moves the window with System Events and then goes
 * fullscreen there. The displays and their positions come from the config.
 * macOS only lets that happen once the SSH login is allowed Accessibility.
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
const SPEED_MIN = 0.5;
const SPEED_MAX = 2;
/** Where on a display the window is put before going fullscreen there. */
const SCREEN_INSET = 40;
/** The exit code the display script uses for "System Events said no". */
const NOT_ALLOWED = 3;

/** One reading of mpv. */
export interface IinaStatus {
  position: number | null;
  duration: number | null;
  paused: boolean;
  volume: number | null;
  muted: boolean;
  /** mpv reached the end of the file and is holding there. */
  eof: boolean;
  fullscreen: boolean;
  speed: number | null;
  /** What mpv opened, exactly as it was given. Empty when nothing is. */
  path: string;
  title: string | null;
}

/** What a listener knows about a reading that mpv does not. */
export interface IinaDescription {
  /**
   * A better name than mpv has. A file streamed from Plex is `file.mkv` as
   * far as mpv knows; Plex knows the film.
   */
  title: string | null;
  /** Artwork, as an authenticated path on this backend. */
  art: string | null;
  skip: IinaSkip | null;
  next: IinaNext | null;
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

/** One line from the loop, sorted by what answered it. */
export type IinaLine =
  | { kind: 'status'; status: IinaStatus }
  | { kind: 'tracks'; tracks: IinaTrack[] }
  | { kind: 'system'; volume: number | null; muted: boolean };

const STATUS_ID = 1;
const TRACKS_ID = 2;

/**
 * mpv's `expand-text` fills one template from many properties, so a single
 * request answers everything but the tracks. `|` separates them; the title
 * goes last, since it is the one field that could contain one.
 */
const STATUS_REQUEST = JSON.stringify({
  command: [
    'expand-text',
    '${=time-pos:}|${=duration:}|${=pause:}|${=volume:}|${=mute:}|${=eof-reached:}|${=fullscreen:}|${=speed:}|${=path:}|${media-title:}',
  ],
  request_id: STATUS_ID,
});
const TRACKS_REQUEST = JSON.stringify({ command: ['get_property', 'track-list'], request_id: TRACKS_ID });

/** The Mac's output volume and mute, as `45,false` — or `missing value,false` over HDMI. */
const SYSTEM_VOLUME =
  `osascript -e 'set s to get volume settings' -e 'return ((output volume of s) as text) & "," & ((output muted of s) as text)'`;

/**
 * The loop that runs on the Mac. POSIX sh, so it means the same under zsh
 * (the default login shell) and bash. Every quoted piece is fixed text.
 */
const STATUS_LOOP = [
  `Q='${STATUS_REQUEST}'`,
  `T='${TRACKS_REQUEST}'`,
  'n=0',
  'while :; do',
  `o=$(printf '%s\\n%s\\n' "$Q" "$T" | nc -U -w 1 ${SOCKET} 2>/dev/null)`,
  `if [ -n "$o" ]; then printf '%s\\n' "$o"; n=0; else n=$((n+1)); [ "$n" -ge ${MISSES_TO_QUIT} ] && exit 0; fi`,
  `v=$(${SYSTEM_VOLUME} 2>/dev/null)`,
  `[ -n "$v" ] && printf '{"system":"%s"}\\n' "$v"`,
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
    return this.#macs().map((mac) => this.#state(mac));
  }

  /**
   * Make sure this Mac is being read, and optionally follow it.
   *
   * A new listener replaces the last one, which is told it has ended: only
   * the most recent thing sent to a Mac is the thing being watched there.
   */
  watch(macId: string, listener?: IinaListener): void {
    const mac = this.#mac(macId);
    if (!mac) return;
    const running = this.#watches.get(mac.id);
    if (running) {
      if (listener) {
        const old = running.listener;
        running.listener = listener;
        old?.end();
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
    const mac = this.#mac(macId);
    if (!mac) return 'That Mac is not set up for IINA';
    const number = typeof value === 'number' && Number.isFinite(value) ? value : null;
    switch (op) {
      case 'status':
        this.watch(mac.id);
        return null;
      case 'skip': {
        const skip = this.#state(mac).skip;
        if (!skip) return 'There is nothing to skip right now';
        return this.command(mac.id, 'seek', skip.to);
      }
      case 'next': {
        const listener = this.#watches.get(mac.id)?.listener;
        if (!listener?.playNext || !this.#state(mac).next) return 'There is no next episode';
        return listener.playNext();
      }
      case 'system_volume': {
        if (number === null) return 'Unknown IINA control';
        const level = Math.max(0, Math.min(100, Math.round(number)));
        return this.#macOs(mac, `osascript -e 'set volume output volume ${level}'`, { systemVolume: level, systemMuted: false });
      }
      case 'system_mute':
        return this.#macOs(
          mac,
          `osascript -e 'set volume output muted (not (output muted of (get volume settings)))'`,
          { systemMuted: !this.#state(mac).systemMuted },
        );
      case 'screen': {
        const screen = number === null ? undefined : mac.screens[Math.round(number)];
        if (!screen) return 'Unknown display';
        return this.#toScreen(mac, screen);
      }
      default: {
        const args = mpvCommand(op, number ?? undefined);
        if (!args) return 'Unknown IINA control';
        const problem = await this.mpv(mac.id, args);
        if (problem) return problem;
        this.#optimistic(mac, op, number);
        this.watch(mac.id);
        return null;
      }
    }
  }

  /**
   * Send mpv one command. Null on success, otherwise a sentence for the panel.
   * For Plex too, which adds its subtitle files this way.
   */
  async mpv(macId: string, args: (string | number | boolean)[]): Promise<string | null> {
    const mac = this.#mac(macId);
    if (!mac) return 'That Mac is not set up for IINA';
    const problem = await this.#deps.run(mac.id, `${mpvShell(args)} | grep -q '"error":"success"'`);
    if (!problem) return null;
    const message = /exited 1$/.test(problem)
      ? `IINA is not playing on ${mac.name}, or its mpv socket is not set up (input-ipc-server=${SOCKET}).`
      : `Could not reach ${mac.name}: ${problem}`;
    this.#update(mac, { error: message });
    return message;
  }

  /** A command to macOS itself, with what it is expected to change. */
  async #macOs(mac: SshHostConfig, command: string, expect: Partial<IinaState>): Promise<string | null> {
    const problem = await this.#deps.run(mac.id, command);
    if (problem) {
      const message = /exited \d+$/.test(problem)
        ? `${mac.name} did not change its volume. Its sound output may not have one (HDMI).`
        : `Could not reach ${mac.name}: ${problem}`;
      this.#update(mac, { error: message });
      return message;
    }
    this.#update(mac, { ...expect, error: null });
    this.watch(mac.id);
    return null;
  }

  /**
   * Move IINA's window onto a display and go fullscreen there.
   *
   * Out of fullscreen first: a fullscreen window is its own Space and cannot
   * be moved. The pauses give macOS's animations time to finish.
   */
  async #toScreen(mac: SshHostConfig, screen: SshScreenConfig): Promise<string | null> {
    const x = Math.round(screen.x) + SCREEN_INSET;
    const y = Math.round(screen.y) + SCREEN_INSET;
    const script = [
      `${mpvShell(['set_property', 'fullscreen', false])} >/dev/null 2>&1`,
      'sleep 1',
      `osascript -e 'tell application "System Events" to tell process "IINA" to set position of window 1 to {${x}, ${y}}' >/dev/null 2>&1 || exit ${NOT_ALLOWED}`,
      'sleep 1',
      `${mpvShell(['set_property', 'fullscreen', true])} | grep -q '"error":"success"'`,
    ].join('\n');
    const problem = await this.#deps.run(mac.id, script);
    if (!problem) {
      this.#update(mac, { fullscreen: true, error: null });
      this.watch(mac.id);
      return null;
    }
    const message = problem.endsWith(`exited ${NOT_ALLOWED}`)
      ? `macOS did not let IINA's window be moved on ${mac.name}. Allow sshd-keygen-wrapper under ` +
        'Privacy & Security > Accessibility, then try again.'
      : /exited 1$/.test(problem)
        ? `IINA moved to ${screen.name} but did not go fullscreen. Is something playing?`
        : `Could not reach ${mac.name}: ${problem}`;
    this.#update(mac, { error: message });
    return message;
  }

  #onLine(mac: SshHostConfig, watch: Watch, line: string): void {
    const parsed = parseLine(line);
    if (!parsed) return;
    if (parsed.kind === 'system') {
      const state = this.#state(mac);
      if (state.systemVolume !== parsed.volume || state.systemMuted !== parsed.muted) {
        this.#update(mac, { systemVolume: parsed.volume, systemMuted: parsed.muted });
      }
      return;
    }
    if (parsed.kind === 'tracks') {
      if (JSON.stringify(this.#state(mac).tracks) !== JSON.stringify(parsed.tracks)) {
        this.#update(mac, { tracks: parsed.tracks });
      }
      return;
    }
    const { status } = parsed;
    const listener = watch.listener;
    listener?.status(status);
    if (!status.path) {
      watch.idle += 1;
      this.#update(mac, { active: false, skip: null, next: null, tracks: [], error: null });
      if (watch.idle >= IDLE_TO_QUIT) watch.abort.abort();
      return;
    }
    watch.idle = 0;
    // The listener may have been replaced by `status` (an episode ending
    // into the next), so ask whoever is listening now.
    const about = watch.listener?.describe?.(status) ?? null;
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
      fullscreen: status.fullscreen,
      speed: status.speed ?? 1,
      error: null,
    });
  }

  #ended(mac: SshHostConfig, watch: Watch, problem: string | null): void {
    if (this.#watches.get(mac.id) === watch) this.#watches.delete(mac.id);
    watch.listener?.end();
    watch.listener = null;
    if (problem) log.debug(`${mac.id}: status stream ended: ${problem}`);
    this.#update(mac, {
      active: false,
      skip: null,
      next: null,
      ...(problem ? { error: `Could not read IINA on ${mac.name}: ${problem}` } : {}),
    });
  }

  /** Show a press straight away rather than at the next reading. */
  #optimistic(mac: SshHostConfig, op: IinaCommand, value: number | null): void {
    const state = this.#state(mac);
    const now = Date.now();
    const at = state.position !== null && state.positionAt !== null && !state.paused
      ? state.position + ((now - state.positionAt) / 1000) * state.speed
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
      case 'fullscreen':
        this.#update(mac, { fullscreen: !state.fullscreen, error: null });
        break;
      case 'speed':
        this.#update(mac, { speed: clampSpeed(value ?? 1), position: at, positionAt: now, error: null });
        break;
      case 'sid':
      case 'aid': {
        const type = op === 'sid' ? 'sub' : 'audio';
        this.#update(mac, {
          tracks: state.tracks.map((track) => (track.type === type ? { ...track, selected: track.id === value } : track)),
          error: null,
        });
        break;
      }
      case 'stop':
        this.#update(mac, { active: false, skip: null, next: null, error: null });
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
    const screens = mac.screens.map((screen) => screen.name);
    const known = this.#states.get(mac.id);
    if (known) return { ...known, name: mac.name, screens };
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
      fullscreen: false,
      speed: 1,
      tracks: [],
      systemVolume: null,
      systemMuted: false,
      screens,
      skip: null,
      next: null,
      error: null,
    };
  }

  #mac(id: string): SshHostConfig | undefined {
    return this.#macs().find((host) => host.id === id);
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
    case 'fullscreen': return ['cycle', 'fullscreen'];
    case 'speed': return number === null ? null : ['set_property', 'speed', clampSpeed(number)];
    case 'sid':
    case 'aid':
      if (number === null) return null;
      return ['set_property', op, number < 0 ? 'no' : Math.round(number)];
    default: return null;
  }
}

/**
 * Send one mpv command through the socket, as shell.
 *
 * The request is single-quoted, so the one character that matters is `'`:
 * JSON may spell it `'`, and does here. Anything else in a string —
 * a subtitle URL, a track title — is inert inside single quotes.
 */
export function mpvShell(args: (string | number | boolean)[]): string {
  const request = JSON.stringify({ command: args }).replace(/'/g, '\\u0027');
  return `printf '%s\\n' '${request}' | nc -U -w 1 ${SOCKET}`;
}

function clampSpeed(value: number): number {
  return Math.round(Math.max(SPEED_MIN, Math.min(SPEED_MAX, value)) * 100) / 100;
}

/**
 * One line from the loop. mpv also pushes events on the same socket
 * (`{"event":...}`), which answer nothing and are skipped.
 */
export function parseLine(line: string): IinaLine | null {
  let body: unknown;
  try {
    body = JSON.parse(line);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const reply = body as { data?: unknown; request_id?: unknown; system?: unknown };
  if (typeof reply.system === 'string') {
    const [volume, muted] = reply.system.split(',');
    return { kind: 'system', volume: seconds(volume), muted: muted === 'true' };
  }
  if (reply.request_id === TRACKS_ID) {
    return Array.isArray(reply.data) ? { kind: 'tracks', tracks: tracksOf(reply.data) } : null;
  }
  if (reply.request_id !== STATUS_ID || typeof reply.data !== 'string') return null;
  const [position, duration, pause, volume, mute, eof, fullscreen, speed, path, ...title] = reply.data.split('|');
  if (path === undefined) return null;
  return {
    kind: 'status',
    status: {
      position: seconds(position),
      duration: seconds(duration),
      paused: pause === 'yes',
      volume: seconds(volume),
      muted: mute === 'yes',
      eof: eof === 'yes',
      fullscreen: fullscreen === 'yes',
      speed: seconds(speed),
      path,
      title: title.join('|') || null,
    },
  };
}

/** mpv's track-list, down to what can be chosen: audio and subtitles. */
function tracksOf(list: unknown[]): IinaTrack[] {
  const out: IinaTrack[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const track = raw as { id?: unknown; type?: unknown; title?: unknown; lang?: unknown; selected?: unknown; external?: unknown };
    if (typeof track.id !== 'number' || (track.type !== 'audio' && track.type !== 'sub')) continue;
    const title = typeof track.title === 'string' && track.title.trim() ? track.title.trim() : null;
    const lang = typeof track.lang === 'string' && track.lang.trim() ? track.lang.trim().toUpperCase() : null;
    const label = title && lang && !title.toUpperCase().includes(lang) ? `${title} (${lang})` : title ?? lang ?? `Track ${track.id}`;
    out.push({ id: track.id, type: track.type, label, selected: track.selected === true });
  }
  return out;
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
