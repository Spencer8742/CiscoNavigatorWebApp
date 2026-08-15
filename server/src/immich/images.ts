import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '~/lib/log.ts';
import type { Env } from '~/env.ts';

const log = logger('immich-img');

/**
 * The Immich image proxy.
 *
 * This route is the single most important performance control in the
 * application, and it exists mainly to make one mistake impossible.
 *
 * ## `original` is unreachable
 *
 * Immich's thumbnail endpoint takes `size` ∈ `thumbnail | preview | fullsize |
 * original`. A 4000×3000 original decodes to roughly **48 MB of bitmap** in
 * the renderer regardless of how well the JPEG compresses. The RoomOS web
 * engine has an unpublished memory ceiling and **terminates the web view**
 * when it is exceeded (docs/ROOMOS.md §2), so fetching one original is not
 * "slow", it is a crash on a wall-mounted panel.
 *
 * So the panel does not get to choose a size. It sends `s=grid` or `s=full`,
 * which this file maps onto Immich's `thumbnail` and `preview`. There is no
 * value of `s` that reaches `original` or `fullsize` — not a filter that
 * could be bypassed, simply no mapping that produces them.
 *
 * `preview` is ~1440 px on the long edge, already larger than the panel, and
 * decodes to about 6 MB.
 *
 * ## Caching
 *
 * Immich asset ids are UUIDs and a given asset's rendered thumbnail does not
 * change, so these are served `immutable` for a year. That matters more than
 * usual here: RoomOS wipes the panel's HTTP cache daily, so the panel will
 * re-fetch each morning — but a browser that has an image will never
 * revalidate it during the day, which is exactly the behaviour a slideshow
 * cycling a few hundred photos wants.
 */

/** The only sizes the panel can ask for, and what they mean upstream. */
const SIZE_MAP = {
  /** Grid tiles. ~250 px. */
  grid: 'thumbnail',
  /** Slideshow and full-screen viewing. ~1440 px. */
  full: 'preview',
} as const;

type PanelSize = keyof typeof SIZE_MAP;

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
const MAX_BYTES = 24 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

/** Immich asset ids are UUIDs. Anything else is not worth a request. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ImmichImages {
  readonly #env: Env['immich'];

  constructor(env: Env['immich']) {
    this.#env = env;
  }

  async serve(
    req: IncomingMessage,
    res: ServerResponse,
    assetId: string,
    rawSize: string | null,
  ): Promise<void> {
    if (!this.#env.enabled) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('Immich is not configured');
      return;
    }

    if (!UUID_RE.test(assetId)) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Bad asset id');
      return;
    }

    // Unknown or absent size falls back to the grid thumbnail — the smallest
    // option, so a mistake costs bandwidth rather than memory.
    const panelSize: PanelSize = rawSize === 'full' ? 'full' : 'grid';
    const immichSize = SIZE_MAP[panelSize];

    const url = `${this.#env.url}/api/assets/${assetId}/thumbnail?size=${immichSize}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const upstream = await fetch(url, {
        headers: { 'x-api-key': this.#env.apiKey },
        signal: controller.signal,
      });

      if (!upstream.ok || !upstream.body) {
        if (upstream.status === 401 || upstream.status === 403) {
          log.error('Immich rejected the API key for an image request');
        }
        res.writeHead(upstream.status === 404 ? 404 : 502, { 'content-type': 'text/plain' });
        res.end('Image unavailable');
        return;
      }

      const type = (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
      if (!ALLOWED_TYPES.has(type)) {
        log.warn(`Immich returned unexpected content-type "${type}"`);
        res.writeHead(415, { 'content-type': 'text/plain' });
        res.end('Not an image');
        return;
      }

      res.writeHead(200, {
        'content-type': type,
        // Safe unconditionally: the id is a UUID and the rendering is fixed.
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      });

      let sent = 0;
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sent += value.byteLength;
        if (sent > MAX_BYTES) {
          log.warn(`Image ${assetId} exceeded ${MAX_BYTES} bytes — truncating`);
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
        res.end('Image fetch failed');
      } else {
        res.end();
      }
      log.debug(`Image ${assetId} failed:`, err);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Exposed for tests: proves no panel-facing size maps to a full-size render. */
export function immichSizeFor(panelSize: string): string {
  return SIZE_MAP[panelSize === 'full' ? 'full' : 'grid'];
}
