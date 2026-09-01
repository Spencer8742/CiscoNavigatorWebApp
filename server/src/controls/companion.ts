import { logger } from '~/lib/log.ts';

const log = logger('companion');

/**
 * Bitfocus Companion, via its HTTP API.
 *
 * Companion 4.x presses a button by its position on the grid:
 *
 *   POST /api/location/<page>/<row>/<column>/press
 *
 * There is no state to read back — Companion's feedbacks live on its own
 * surfaces — so this is genuinely fire-and-forget, and the honest thing for
 * the panel to show is "the press was accepted", not "the thing happened".
 *
 * A press is intentionally NOT retried. These are transport commands: mute,
 * hang up, next input. Sending a duplicate half a second later because the
 * first response was slow is worse than not sending it at all.
 */

/** Companion is on the LAN and answers immediately or not at all. */
const TIMEOUT_MS = 4000;

export class CompanionClient {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl;
  }

  get enabled(): boolean {
    return this.#baseUrl !== '';
  }

  /** Returns an error message for the panel to show, or null on success. */
  async press(page: number, row: number, column: number): Promise<string | null> {
    if (!this.enabled) return 'Companion is not configured';

    const path = `/api/location/${page}/${row}/${column}/press`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(this.#baseUrl + path, {
        method: 'POST',
        signal: controller.signal,
      });

      if (!res.ok) {
        /*
         * 404 is the one worth naming. Companion returns it for a location
         * that has no button on it, which is what happens after a Companion
         * page is rearranged — and the fix is to re-derive the coordinates
         * from a config export, not to look at this panel.
         */
        const reason =
          res.status === 404
            ? `no button at ${page}/${row}/${column}`
            : `Companion returned ${res.status}`;
        log.warn(`Press ${path} failed: ${reason}`);
        return reason;
      }

      log.debug(`Pressed ${page}/${row}/${column}`);
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Press ${path} failed: ${message}`);
      return 'Companion unreachable';
    } finally {
      clearTimeout(timer);
    }
  }
}
