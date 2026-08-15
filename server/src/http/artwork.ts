import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '~/lib/log.ts';
import type { Env } from '~/env.ts';

const log = logger('artwork');

/**
 * Proxy for Home Assistant media artwork.
 *
 * Home Assistant reports album art as a RELATIVE path in the entity's
 * `entity_picture` attribute:
 *
 *   /api/media_player_proxy/media_player.speaker?token=…&cache=…
 *
 * The panel cannot fetch that itself for two independent reasons: it does not
 * know Home Assistant's address (deliberately — see docs/ARCHITECTURE.md §3),
 * and most of those endpoints need the HA bearer token, which the panel must
 * never hold. So the backend fetches it and streams it back on our own origin.
 *
 * ## SSRF
 *
 * This route takes a path from the panel and turns it into an outbound
 * request, which is the classic shape of a server-side request forgery hole.
 * It is closed by construction rather than by filtering:
 *
 *  - the path is joined onto `HA_URL` and can never name another host —
 *    absolute URLs, protocol-relative `//evil.com`, backslashes and encoded
 *    variants are all rejected before the join
 *  - only `/api/` paths are allowed, so this cannot be used to sweep an
 *    internal network or reach HA's admin pages
 *  - responses are only forwarded when the upstream says they are an image
 *
 * The result is that the worst a compromised panel can do here is fetch
 * pictures from Home Assistant, which it can already see on screen.
 */

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 8000;

/** Everything HA realistically serves as artwork. */
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/svg+xml',
]);

/**
 * Validate a caller-supplied path.
 *
 * Returns the safe path, or null. Deliberately strict: an artwork URL that
 * does not look exactly like one HA produced is not worth fetching.
 */
export function safeHaPath(raw: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return null;
  }

  if (path.includes('\0') || path.includes('\\')) return null;

  // Must be a root-relative path. `//host` is protocol-relative and would
  // resolve to a different origin once joined onto a base URL.
  if (!path.startsWith('/') || path.startsWith('//')) return null;

  // Any scheme at all means it is not a path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null;

  // Traversal cannot escape the origin, but there is no legitimate reason for
  // it here and refusing keeps the surface obvious.
  if (path.includes('..')) return null;

  // HA serves artwork from /api/. Nothing outside it should be reachable.
  if (!path.startsWith('/api/')) return null;

  return path;
}

export class ArtworkProxy {
  readonly #env: Env['ha'];

  constructor(env: Env['ha']) {
    this.#env = env;
  }

  async serve(req: IncomingMessage, res: ServerResponse, rawPath: string): Promise<void> {
    if (!this.#env.enabled) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('Home Assistant is not configured');
      return;
    }

    const path = safeHaPath(rawPath);
    if (!path) {
      log.warn(`Refused artwork path: ${rawPath.slice(0, 120)}`);
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Bad path');
      return;
    }

    const target = this.#env.url + path;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const upstream = await fetch(target, {
        headers: { authorization: `Bearer ${this.#env.token}` },
        signal: controller.signal,
      });

      if (!upstream.ok || !upstream.body) {
        res.writeHead(upstream.status === 404 ? 404 : 502, { 'content-type': 'text/plain' });
        res.end('Artwork unavailable');
        return;
      }

      const type = (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
      if (!ALLOWED_TYPES.has(type)) {
        log.warn(`Upstream returned non-image content-type "${type}" for artwork`);
        res.writeHead(415, { 'content-type': 'text/plain' });
        res.end('Not an image');
        return;
      }

      /*
       * Artwork URLs from HA carry a cache-busting token that changes with
       * the track, so a given URL's bytes never change and can be cached
       * hard. That matters on this device: RoomOS wipes the panel's HTTP
       * cache daily, and re-fetching artwork on every track change over a
       * constrained link is exactly the kind of avoidable work that makes a
       * Now Playing screen feel slow.
       */
      res.writeHead(200, {
        'content-type': type,
        'cache-control': 'private, max-age=86400',
        'x-content-type-options': 'nosniff',
      });

      let sent = 0;
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sent += value.byteLength;
        if (sent > MAX_BYTES) {
          // A runaway response must not be streamed into a device with a
          // small memory budget.
          log.warn('Artwork exceeded size limit — truncating');
          await reader.cancel().catch(() => undefined);
          break;
        }
        if (!res.write(value)) {
          await new Promise((resolve) => res.once('drain', resolve));
        }
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('Artwork fetch failed');
      } else {
        res.end();
      }
      log.debug('Artwork fetch failed:', err);
    } finally {
      clearTimeout(timer);
    }
  }
}
