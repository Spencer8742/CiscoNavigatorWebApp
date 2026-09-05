import type { ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { logger } from '~/lib/log.ts';

const log = logger('media-art');

/**
 * Cover art for browsing, fetched on the panel's behalf.
 *
 * Upstreams hand out artwork as an absolute URL on their own host — a Sonos
 * speaker answers `http://192.168.1.51:1400/getaa?…`. Two things are wrong
 * with giving that to the panel:
 *
 *  - it is frequently a container hostname or a Docker-network address that
 *    nothing outside Home Assistant's host can resolve, so half the covers
 *    would silently fail to load and the other half would depend on how the
 *    speaker happened to be answering
 *  - it tells the panel where another service on the LAN lives, which the rest
 *    of this app deliberately never does (docs/ARCHITECTURE.md §3)
 *
 * ## Why this is not an open proxy
 *
 * The obvious implementation — `/img/art?url=…` — is a server-side request
 * forgery hole: the panel would be choosing which host this process connects
 * to, and this process sits on a trusted LAN.
 *
 * So the panel never names a URL. When a browse response comes back from
 * an upstream, the backend registers each artwork URL here and replaces it
 * with an opaque key. The panel can only ask for keys, and a key can only
 * exist because an upstream itself produced the URL it stands for. There
 * is no request the panel can compose that reaches a host of its choosing.
 *
 * The registry is bounded and evicts oldest-first: it is a lookup table for
 * what is currently on screen, not a cache.
 */

/** Roughly a few library pages' worth. Well under a megabyte of strings. */
const MAX_ENTRIES = 4000;
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

/** Keys are hex digests, so this rejects anything the registry did not mint. */
const KEY_RE = /^[0-9a-f]{16}$/;

export class MediaArt {
  /** key → upstream URL. Insertion-ordered, which is what makes eviction FIFO. */
  readonly #urls = new Map<string, string>();

  /**
   * Register an artwork URL and return the path the panel should use.
   *
   * Returns null for anything that is not an http(s) URL, so a provider that
   * hands back a `data:` or `file:` URL simply produces an item with no
   * artwork rather than a fetch we should not be making.
   */
  register(raw: unknown): string | null {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000) return null;

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    const key = createHash('sha256').update(url.href).digest('hex').slice(0, 16);

    // Re-registering moves the entry to the back of the eviction queue, so
    // artwork that is still being looked at does not age out from under a
    // panel that is idling on one screen.
    this.#urls.delete(key);
    this.#urls.set(key, url.href);

    while (this.#urls.size > MAX_ENTRIES) {
      const oldest = this.#urls.keys().next().value;
      if (oldest === undefined) break;
      this.#urls.delete(oldest);
    }

    return `/img/art?k=${key}`;
  }

  async serve(res: ServerResponse, key: string | null): Promise<void> {
    if (!key || !KEY_RE.test(key)) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Bad key');
      return;
    }

    const target = this.#urls.get(key);
    if (!target) {
      // Expected after a backend restart, or once a key has aged out. The
      // panel shows its placeholder, which is the right outcome.
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Unknown artwork');
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const upstream = await fetch(target, { signal: controller.signal, redirect: 'follow' });
      if (!upstream.ok || !upstream.body) {
        res.writeHead(upstream.status === 404 ? 404 : 502, { 'content-type': 'text/plain' });
        res.end('Artwork unavailable');
        return;
      }

      const type = (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
      if (!ALLOWED_TYPES.has(type)) {
        log.warn(`Artwork upstream returned "${type}" — not forwarding`);
        res.writeHead(415, { 'content-type': 'text/plain' });
        res.end('Not an image');
        return;
      }

      // The key is a digest of the URL, so a given key's bytes never change.
      // Worth caching hard: scrolling a library back and forth would otherwise
      // re-fetch every cover through this process.
      res.writeHead(200, {
        'content-type': type,
        'cache-control': 'private, max-age=604800, immutable',
        'x-content-type-options': 'nosniff',
      });

      let sent = 0;
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sent += value.byteLength;
        if (sent > MAX_BYTES) {
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
