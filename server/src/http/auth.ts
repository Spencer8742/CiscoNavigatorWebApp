import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Panel authentication.
 *
 * A single shared bearer token, accepted from two places:
 *
 *  - `Authorization: Bearer <token>` for HTTP requests
 *  - `?t=<token>` for the WebSocket handshake, because the browser WebSocket
 *    API cannot set request headers. That is a limitation of the standard,
 *    not a shortcut here.
 *
 * See panel/src/net/auth.ts for why the token is provisioned in the URL
 * rather than obtained through a login: RoomOS erases the device's web
 * storage daily, so anything the panel must remember has to be recoverable
 * from the URL RoomOS reloads.
 */

export class PanelAuth {
  readonly #expected: Buffer | null;

  constructor(token: string) {
    // Empty token = auth disabled. Warned about loudly at boot in env.ts.
    this.#expected = token ? Buffer.from(token, 'utf8') : null;
  }

  get enabled(): boolean {
    return this.#expected !== null;
  }

  check(req: IncomingMessage): boolean {
    if (!this.#expected) return true;

    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      return this.#matches(header.slice(7));
    }

    // WebSocket upgrade, or an <img> the browser will not attach headers to.
    const url = req.url ?? '';
    const q = url.indexOf('?');
    if (q !== -1) {
      const token = new URLSearchParams(url.slice(q + 1)).get('t');
      if (token) return this.#matches(token);
    }

    return false;
  }

  /**
   * Constant-time comparison.
   *
   * `timingSafeEqual` throws on a length mismatch, which would itself leak
   * the expected length, so lengths are compared first and a mismatch is
   * still run through a dummy comparison to keep the timing flat.
   */
  #matches(candidate: string): boolean {
    if (!this.#expected) return true;
    const given = Buffer.from(candidate, 'utf8');
    if (given.length !== this.#expected.length) {
      // Burn roughly the same time as a real comparison.
      timingSafeEqual(this.#expected, this.#expected);
      return false;
    }
    return timingSafeEqual(given, this.#expected);
  }
}
