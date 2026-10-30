import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlib, gzip } from 'node:zlib';
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
 *
 * Text is sent compressed. The bundle is ~240 KB of JavaScript and ~100 KB
 * of CSS raw and about a quarter of that compressed, and the cold load after
 * each nightly cache wipe is the one load every panel pays. Each file is
 * compressed once per build and held in memory — the whole shell is a few
 * hundred kilobytes, so this costs less than one cached photo.
 */

/** Types worth compressing. Images and fonts already are. */
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg']);

/** Below this, the headers cost more than the saving. */
const MIN_COMPRESS_BYTES = 1024;

/** A file larger than this is streamed as it is rather than held in memory. */
const MAX_COMPRESS_BYTES = 4 * 1024 * 1024;

/** Bounds the cache if something unexpected ends up in the panel directory. */
const MAX_CACHED = 64;

type Encoding = 'br' | 'gzip';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // Its own type, not application/json: iOS is the fussiest consumer of this
  // file and the one that matters here, since a home-screen web app is the
  // only way to run this on an iPad without Safari's chrome around it.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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
  /** `path|etag|encoding` → compressed bytes, or the compression in flight. */
  readonly #compressed = new Map<string, Promise<Buffer | null>>();

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

    const etag = etagOf(info);

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': cacheControlFor(filePath) });
      res.end();
      return true;
    }

    const cacheControl = cacheControlFor(filePath);
    const compressible = COMPRESSIBLE.has(ext);
    const encoding =
      compressible && info.size >= MIN_COMPRESS_BYTES && info.size <= MAX_COMPRESS_BYTES
        ? preferredEncoding(req.headers['accept-encoding'])
        : null;

    if (encoding) {
      // Each representation has its own validator, or a cache could answer
      // a gzip request with brotli bytes it revalidated under one ETag.
      const tagged = `${etag.slice(0, -1)}-${encoding}"`;
      if (req.headers['if-none-match'] === tagged) {
        res.writeHead(304, { etag: tagged, 'cache-control': cacheControl, vary: 'accept-encoding' });
        res.end();
        return true;
      }
      const body = await this.#compress(filePath, etag, encoding);
      if (body) {
        res.writeHead(200, {
          'content-type': type,
          'content-encoding': encoding,
          'content-length': String(body.length),
          etag: tagged,
          'cache-control': cacheControl,
          vary: 'accept-encoding',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        return true;
      }
    }

    const headers: Record<string, string> = {
      'content-type': type,
      'content-length': String(info.size),
      etag,
      'cache-control': cacheControl,
    };
    if (compressible) headers['vary'] = 'accept-encoding';

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

  /**
   * Compress the shell ahead of the first request.
   *
   * Brotli at its best setting takes a few hundred milliseconds for the
   * bundle on a NAS-class CPU — fine once, but not for the first panel after
   * a deploy to wait out. Best-effort: anything missed is done on demand.
   */
  async warm(): Promise<void> {
    const files = [join(this.#root, 'index.html')];
    try {
      for (const name of await readdir(join(this.#root, 'a'))) files.push(join(this.#root, 'a', name));
    } catch {
      // No build (dev mode, where Vite serves the panel). Nothing to warm.
    }
    for (const file of files) {
      if (!COMPRESSIBLE.has(extname(file).toLowerCase())) continue;
      try {
        const info = await stat(file);
        if (info.size < MIN_COMPRESS_BYTES || info.size > MAX_COMPRESS_BYTES) continue;
        const etag = etagOf(info);
        await this.#compress(file, etag, 'br');
        await this.#compress(file, etag, 'gzip');
      } catch {
        // Gone between the listing and the stat; served on demand if it returns.
      }
    }
  }

  /**
   * The compressed bytes of one version of a file, or null to send it as is.
   *
   * Keyed by ETag, so a rebuild in place (a dev `vite build --watch`, a
   * bind-mounted panel directory) is picked up rather than served stale.
   * Concurrent first requests share one compression.
   */
  #compress(filePath: string, etag: string, encoding: Encoding): Promise<Buffer | null> {
    const key = `${filePath}|${etag}|${encoding}`;
    let pending = this.#compressed.get(key);
    if (pending) return pending;

    pending = (async () => {
      try {
        const raw = await readFile(filePath);
        return encoding === 'br'
          ? await brotli(raw, {
              params: {
                [zlib.BROTLI_PARAM_QUALITY]: 11,
                [zlib.BROTLI_PARAM_SIZE_HINT]: raw.length,
              },
            })
          : await gz(raw, { level: 9 });
      } catch (err) {
        log.warn(`Could not compress ${filePath}; sending it uncompressed:`, err);
        return null;
      }
    })();

    // Older versions of the same file are dead weight after a rebuild.
    for (const old of this.#compressed.keys()) {
      if (old.startsWith(`${filePath}|`) && !old.startsWith(`${filePath}|${etag}|`)) {
        this.#compressed.delete(old);
      }
    }
    if (this.#compressed.size >= MAX_CACHED) {
      const oldest = this.#compressed.keys().next().value;
      if (oldest !== undefined) this.#compressed.delete(oldest);
    }
    this.#compressed.set(key, pending);
    return pending;
  }
}

/** Brotli when the client takes it, then gzip, honouring an explicit `q=0`. */
export function preferredEncoding(header: string | string[] | undefined): Encoding | null {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  const accepted = new Set<string>();
  for (const part of raw.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    if (q !== undefined && !(Number(q.slice(2)) > 0)) continue;
    accepted.add(name);
  }
  if (accepted.has('br')) return 'br';
  if (accepted.has('gzip')) return 'gzip';
  return null;
}

/**
 * Weak ETag from size + mtime: cheap, and sufficient because the build
 * rewrites files wholesale rather than editing them in place.
 */
function etagOf(info: { size: number; mtimeMs: number }): string {
  return `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
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
