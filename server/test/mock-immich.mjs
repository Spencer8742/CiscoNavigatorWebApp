import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';

/**
 * A mock Immich server.
 *
 * Implements just enough of API 3.1.0 to exercise the client, playlist and
 * image proxy: `/api/server/ping`, `/api/search/random`, `/api/search/metadata`
 * and `/api/assets/{id}/thumbnail`.
 *
 * It records every request so tests can assert the thing that matters most —
 * that **no request ever asks for `size=original`**. On the real device that
 * would pull a ~48 MB decoded bitmap into a web view that gets terminated for
 * using too much memory.
 */
export class MockImmich {
  #server;
  #port;

  /** Every thumbnail request, as { id, size }. */
  thumbnailRequests = [];
  /** Every search body received. */
  searches = [];
  /** Set to reject with this status instead of serving. */
  failWith = 0;

  /**
   * Emulate Immich ≤ 1.132, which had `isArchived` rather than `visibility`.
   *
   * Immich validates request bodies with `forbidNonWhitelisted`, so an
   * unknown property is a 400 for the whole query — not an ignored filter.
   * That is why a perfectly good config can return zero photos.
   */
  legacyArchiveField = false;

  /** The key this server accepts. Change it to simulate a wrong/revoked key. */
  expectedKey = 'mock-immich-key';

  /**
   * Optional: `(id, size) => { body: Buffer, type: string }` to serve real
   * image bytes. Unset means a 1×1 JPEG, which is all most tests need.
   */
  imageFor = null;

  assets = [];

  constructor(port) {
    this.#port = port;
  }

  /** Generate N fake assets with plausible metadata. */
  seed(count) {
    for (let i = 0; i < count; i += 1) {
      const portrait = i % 4 === 0;
      this.assets.push({
        id: uuidFor(i),
        type: i % 11 === 0 ? 'VIDEO' : 'IMAGE',
        thumbhash: makeThumbhash(i),
        localDateTime: new Date(Date.UTC(2020 + (i % 5), i % 12, 1 + (i % 27))).toISOString(),
        exifInfo: {
          exifImageWidth: portrait ? 3000 : 4000,
          exifImageHeight: portrait ? 4000 : 3000,
          city: i % 3 === 0 ? 'Edinburgh' : null,
          country: i % 3 === 0 ? 'Scotland' : null,
          dateTimeOriginal: new Date(Date.UTC(2021, i % 12, 1 + (i % 27))).toISOString(),
        },
      });
    }
  }

  async start() {
    this.#server = createServer((req, res) => this.#handle(req, res));
    await new Promise((resolve) => this.#server.listen(this.#port, '127.0.0.1', resolve));
  }

  #handle(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (this.failWith) {
      res.writeHead(this.failWith, { 'content-type': 'text/plain' });
      res.end('mock failure');
      return;
    }

    // `/api/server/ping` is UNAUTHENTICATED in real Immich (its OpenAPI
    // description gives it no security requirement), so it answers happily
    // with a wrong API key. Anything that treats a successful ping as proof
    // of working credentials is fooled — which is exactly what happened.
    if (url.pathname === '/api/server/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ res: 'pong' }));
      return;
    }

    // Immich authenticates with x-api-key, not a bearer token.
    if (req.headers['x-api-key'] !== this.expectedKey) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ statusCode: 401, message: 'Invalid API key', error: 'Unauthorized' }),
      );
      return;
    }

    const thumb = /^\/api\/assets\/([^/]+)\/thumbnail$/.exec(url.pathname);
    if (thumb) {
      const size = url.searchParams.get('size') ?? '(none)';
      this.thumbnailRequests.push({ id: thumb[1], size });
      // `imageFor` lets a test serve real pixels at a real aspect ratio,
      // which is the only way to check a layout decision like the collage.
      const custom = this.imageFor?.(thumb[1], size);
      if (custom) {
        res.writeHead(200, { 'content-type': custom.type });
        res.end(custom.body);
      } else {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end(onePixelJpeg());
      }
      return;
    }

    if (url.pathname === '/api/search/random' || url.pathname === '/api/search/metadata') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let dto = {};
        try {
          dto = JSON.parse(body || '{}');
        } catch {
          /* ignore */
        }
        this.searches.push({ path: url.pathname, dto });

        // Reject unknown properties the way Immich's ValidationPipe does.
        const rejected = this.legacyArchiveField ? 'visibility' : 'isArchived';
        if (rejected in dto) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              statusCode: 400,
              message: [`property ${rejected} should not exist`],
              error: 'Bad Request',
            }),
          );
          return;
        }

        let pool = this.assets;
        if (this.legacyArchiveField && dto.isArchived === false) {
          pool = pool.filter((a) => !a.isArchived);
        }
        if (dto.visibility === 'timeline') pool = pool.filter((a) => !a.isArchived);
        if (dto.type === 'IMAGE') pool = pool.filter((a) => a.type === 'IMAGE');
        if (dto.isFavorite) pool = pool.filter((_, i) => i % 3 === 0);
        if (Array.isArray(dto.albumIds) && dto.albumIds.length) pool = pool.slice(0, 12);

        const size = Math.min(dto.size ?? 50, pool.length);
        const items = pool.slice(0, size);

        res.writeHead(200, { 'content-type': 'application/json' });
        // The two endpoints have different response shapes, which the client
        // has to unwrap correctly.
        res.end(
          url.pathname === '/api/search/random'
            ? JSON.stringify(items)
            : JSON.stringify({ albums: { items: [] }, assets: { items, total: items.length } }),
        );
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  async stop() {
    if (!this.#server) return;
    await new Promise((resolve) => this.#server.close(resolve));
    this.#server = null;
  }
}

function uuidFor(i) {
  const hex = i.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

/**
 * A syntactically valid ThumbHash header.
 *
 * Only the first three bytes matter to us — the DC term the panel reads for
 * its average-colour placeholder.
 */
function makeThumbhash(i) {
  const l = 20 + (i % 40); // 6 bits
  const p = 20 + (i % 20); // 6 bits
  const q = 30 + (i % 20); // 6 bits
  const scale = 10; // 5 bits
  const header = l | (p << 6) | (q << 12) | (scale << 18);
  const bytes = Uint8Array.from([
    header & 255,
    (header >> 8) & 255,
    (header >> 16) & 255,
    0,
    0,
    0,
    0,
  ]);
  return Buffer.from(bytes).toString('base64');
}

/** Smallest valid JPEG, so content-type checks and streaming are exercised. */
function onePixelJpeg() {
  void deflateSync;
  return Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
      'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
      'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    'base64',
  );
}
