import { logger } from '~/lib/log.ts';
import { CastDevice, type CastTransport } from '~/cast/device.ts';
import type { CastConfig, CastDisplay, DashboardConfig } from '@shared/config.ts';

const log = logger('cast');

/**
 * Keeps the dashboard on the Cast displays listed in `dashboard.yaml`.
 *
 * ## Why this has to exist at all
 *
 * A Nest Hub has no persistent "show this" setting and no way to be given
 * one. Every reboot, every "hey Google", every timer, every photo-frame
 * timeout ends the cast session, and the display goes back to Google's
 * ambient screen. Nothing on the device will bring the dashboard back, so
 * something off the device has to notice and cast it again — forever, not
 * once at setup.
 *
 * ## Why it lives in the backend
 *
 * The obvious shape is a small script on a timer beside the container: it
 * works, and it means a second thing to install, a second thing to keep
 * running, and a second place the dashboard's URL and token are written down.
 * Here it is a few hundred lines sharing the process that already knows the
 * config, already knows the token, and is already the thing that has to be
 * running for there to be a dashboard to cast.
 *
 * Doing it in-process also removes the awkward part of the script version:
 * discovery. Displays are addressed by IP, so there is no mDNS, which is what
 * lets this stay on Docker's ordinary bridge network — mDNS does not cross
 * one, and a host-networked helper container was the price of using names.
 *
 * ## Quietness is a feature
 *
 * A display already showing the dashboard is not touched. If this re-cast on
 * every pass, every Hub in the house would visibly reload on a timer, which
 * is worse than the problem being solved. The check is one short connection
 * per display per interval and costs nothing that anyone can see.
 */

/** Sequential rather than parallel: see `sweep`. */
const GAP_MS = 150;

export interface CastKeeperDeps {
  /** Read live, not captured — the config is hot-reloadable. */
  getConfig(): DashboardConfig;
  /**
   * The panel token, appended to the cast URL.
   *
   * The point of the keeper knowing this is that nobody else has to: the
   * token stays in the backend's environment instead of being copied into a
   * script, a cron line or a second container's settings.
   */
  token: string;
  /** Test seam. See device.ts. */
  transport?: CastTransport;
}

export type VisitResult =
  | { display: string; outcome: 'already-showing' | 'cast' }
  | { display: string; outcome: 'failed'; error: string };

export class CastKeeper {
  readonly #deps: CastKeeperDeps;

  #timer: ReturnType<typeof setInterval> | null = null;
  #busy = false;
  #started = false;
  /** The `cast:` section as last seen, so an unrelated config edit is ignored. */
  #signature = '';
  /** Last failure per display, so a Hub that is simply off is not shouted about. */
  readonly #failing = new Map<string, string>();

  constructor(deps: CastKeeperDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#signature = this.#currentSignature();

    const cast = this.#deps.getConfig().cast;
    if (cast.displays.length === 0) return;

    if (!cast.baseUrl.trim()) {
      log.warn(
        `${cast.displays.length} cast display(s) configured but cast.baseUrl is empty — ` +
          'set it to how a display reaches this dashboard, e.g. http://192.168.1.10:8099',
      );
      return;
    }

    log.info(
      `Keeping the dashboard on ${cast.displays.length} display(s), ` +
        `checked every ${cast.checkSeconds}s`,
    );
    this.#schedule();
    // Not forced: a display that survived a container restart should not be
    // reloaded just because this process is new.
    void this.sweep(false);
  }

  stop(): void {
    this.#started = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * The config file changed.
   *
   * Only acts when the `cast:` section itself changed — renaming a light must
   * not reload every Hub in the house. When it did change, the re-cast is
   * forced, because the pane a display should be showing may now be different
   * and "DashCast is running" can no longer be taken to mean "showing the
   * right thing".
   */
  reload(): void {
    if (!this.#started) return;
    const next = this.#currentSignature();
    if (next === this.#signature) return;
    this.#signature = next;
    log.info('Cast configuration changed — re-casting');
    this.#schedule();
    void this.sweep(true);
  }

  /**
   * Visit every configured display once.
   *
   * Sequential, with a small gap. These are wall displays, not a fleet: the
   * whole sweep is a handful of short connections, there is nothing to gain
   * from doing them at once, and a house full of Hubs all being launched in
   * the same millisecond is a good way to find out which of them handles that
   * badly.
   */
  async sweep(force = false): Promise<VisitResult[]> {
    if (this.#busy) return [];
    const cast = this.#deps.getConfig().cast;
    const base = cast.baseUrl.trim();
    if (cast.displays.length === 0 || !base) return [];

    this.#busy = true;
    const results: VisitResult[] = [];
    try {
      for (const display of cast.displays) {
        results.push(await this.#visit(display, cast, force));
        await delay(GAP_MS);
      }
    } finally {
      this.#busy = false;
    }
    return results;
  }

  async #visit(display: CastDisplay, cast: CastConfig, force: boolean): Promise<VisitResult> {
    const { host, port } = splitHost(display.host);
    const label = display.name?.trim() || display.host;
    const device = new CastDevice({ host, port, label, transport: this.#deps.transport });

    try {
      const outcome = await device.show(this.urlFor(display, cast), force);
      if (this.#failing.delete(label)) {
        log.info(`${label} is reachable again`);
      }
      if (outcome === 'cast') log.info(`Cast the dashboard to ${label}`);
      else log.debug(`${label} is already showing the dashboard`);
      return { display: label, outcome };
    } catch (err) {
      /*
       * Not an error worth escalating, and usually not an error at all: a Hub
       * that is powered off, mid-reboot or briefly off Wi-Fi fails here and
       * succeeds on the next pass. It is logged loudly the first time and
       * quietly after that, so a display left unplugged for a week does not
       * fill the log with the same line every five minutes.
       */
      const message = err instanceof Error ? err.message : String(err);
      const wasFailing = this.#failing.get(label);
      this.#failing.set(label, message);
      const line = `Could not cast to ${label} (${display.host}): ${message}`;
      if (wasFailing === message) log.debug(line);
      else log.warn(`${line} — will retry in ${cast.checkSeconds}s`);
      return { display: label, outcome: 'failed', error: message };
    }
  }

  /**
   * The URL a display is told to load.
   *
   * `?cast=1` is what puts the panel into cast mode, and is also what relaxes
   * the CSP enough to load Google's receiver SDK — see http/headers.ts. The
   * pane is omitted entirely rather than sent empty when a display has none,
   * so the panel falls through to the configured rotation.
   */
  urlFor(display: CastDisplay, cast: CastConfig): string {
    const params = new URLSearchParams();
    params.set('cast', '1');
    if (display.pane) params.set('pane', display.pane);
    // Which panel this display counts as, for the per-panel settings. Same
    // parameter the Navigators carry — a Hub showing the real dashboard is a
    // panel, and there is no reason for it to share the kitchen's settings
    // with the bedroom.
    if (display.panel) params.set('panel', display.panel);
    if (this.#deps.token) params.set('t', this.#deps.token);
    return `${cast.baseUrl.trim().replace(/\/+$/, '')}/?${params.toString()}`;
  }

  #schedule(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;

    const cast = this.#deps.getConfig().cast;
    if (cast.checkSeconds <= 0 || cast.displays.length === 0) return;

    this.#timer = setInterval(() => void this.sweep(false), cast.checkSeconds * 1000);
    // The keeper must never be the reason the process stays alive.
    this.#timer.unref();
  }

  #currentSignature(): string {
    return JSON.stringify(this.#deps.getConfig().cast);
  }
}

/**
 * Split `host` or `host:port`.
 *
 * The port is there for a test double rather than for real use — every Cast
 * device listens on 8009 — but a bare IPv6 literal is full of colons, so the
 * split has to be careful rather than clever.
 */
export function splitHost(raw: string, fallbackPort = 8009): { host: string; port: number } {
  const trimmed = raw.trim();

  const bracketed = /^\[(.+)]:(\d{1,5})$/.exec(trimmed);
  if (bracketed) return { host: bracketed[1] as string, port: Number(bracketed[2]) };

  const parts = trimmed.split(':');
  if (parts.length === 2 && /^\d{1,5}$/.test(parts[1] as string)) {
    return { host: parts[0] as string, port: Number(parts[1]) };
  }

  return { host: trimmed.replace(/^\[|]$/g, ''), port: fallbackPort };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
