import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from '~/lib/log.ts';

const log = logger('static');

/**
 * Static file serving for the built panel.
 *
 * Small enough to write directly, and worth writing directly: the caching
 * policy here is the difference between a panel that cold-starts in under a
 * second and one that re-downloads its whole bundle every morning after
 * RoomOS wipes the device's HTTP cache (docs/ROOMOS.md §5).
 *
 * The policy:
 *
 *  - Files under `/a/` carry a content hash in their name (see the Vite
 *    rollup output config) and are served `immutable` for a year. A hashed
 *    filename can never have different content, so revalidation is pure waste.
 *  - `index.html` is `no-cache`: it must be revalidated so a deploy is picked
 *    up on the next load. ETag makes that revalidation a 304 with no body.
 *
 * Combined: after a deploy the panel fetches one small HTML document and
 * whichever hashed assets actually changed.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export class StaticFiles {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  /**
   * Serve `urlPath`, falling back to index.html.
   *
   * The fallback is what makes this a single-page app: any unknown path
   * returns the shell rather than a 404, so the panel is reachable at any URL
   * the device happens to be provisioned with.
   */
  async serve(req: IncomingMessage, res: ServerResponse, urlPath: string): Promise<void> {
    const filePath = this.#resolveSafe(urlPath);

    if (filePath) {
      const served = await this.#sendFile(req, res, filePath);
      if (served) return;
    }

    // SPA fallback.
    const index = join(this.#root, 'index.html');
    const served = await this.#sendFile(req, res, index);
    if (!served) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        'Panel build not found.\n\n' +
          'Run `npm run build` (or use the Docker image, which builds it for you).\n',
      );
    }
  }

  /**
   * Resolve a URL path to a file inside the root, or null.
   *
   * Path traversal defence: normalise first, then require the result to still
   * be inside the root. Checking for ".." in the raw string is not enough —
   * percent-encoding and mixed separators get past that.
   */
  #resolveSafe(urlPath: string): string | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    if (decoded.includes('\0')) return null;

    const candidate = resolve(join(this.#root, normalize(decoded)));
    if (candidate !== this.#root && !candidate.startsWith(this.#root + sep)) {
      log.warn(`Blocked path traversal attempt: ${urlPath}`);
      return null;
    }
    return candidate;
  }

  async #sendFile(req: IncomingMessage, res: ServerResponse, filePath: string): Promise<boolean> {
    let info;
    try {
      info = await stat(filePath);
      if (!info.isFile()) return false;
    } catch {
      return false;
    }

    const ext = extname(filePath).toLowerCase();
    const type = MIME[ext] ?? 'application/octet-stream';

    // Weak ETag from size + mtime: cheap, and sufficient because the build
    // rewrites files wholesale rather than editing them in place.
    const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': cacheControlFor(filePath) });
      res.end();
      return true;
    }

    const headers: Record<string, string> = {
      'content-type': type,
      'content-length': String(info.size),
      etag,
      'cache-control': cacheControlFor(filePath),
    };

    res.writeHead(200, headers);

    if (req.method === 'HEAD') {
      res.end();
      return true;
    }

    const stream = createReadStream(filePath);
    stream.on('error', (err) => {
      log.error(`Read error for ${filePath}:`, err);
      res.destroy();
    });
    stream.pipe(res);
    return true;
  }
}

function cacheControlFor(filePath: string): string {
  // Hashed assets live under /a/ — see rollupOptions.output in vite.config.ts.
  if (filePath.includes(`${sep}a${sep}`)) {
    return 'public, max-age=31536000, immutable';
  }
  // The shell and anything else: revalidate every load, but a 304 costs one
  // small round trip rather than a full re-download.
  return 'no-cache';
}
