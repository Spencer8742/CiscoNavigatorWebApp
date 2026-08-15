import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tcpConnect } from 'node:net';
import { MockImmich } from './mock-immich.mjs';

/**
 * End-to-end tests for the photo pipeline: Immich client, playlist and image
 * proxy, driven through the real backend over the real panel protocol.
 *
 * The assertion that matters most is that no code path can request
 * `size=original` from Immich. On a Room Navigator that would decode to tens
 * of megabytes against an unpublished memory ceiling whose overrun terminates
 * the web view (docs/ROOMOS.md §2) — so it is a crash, not a slow load.
 */

const IMMICH_PORT = 18333;
const PANEL_PORT = 18299;
const TOKEN = 'photo-test-token';

const SERVER = fileURLToPath(new URL('../dist/server.js', import.meta.url));
const CONFIG = join(tmpdir(), 'navigator-photos-test.yaml');

let immich;
let backend;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Send a raw request line, bypassing the URL normalisation `fetch` performs.
 *
 * `fetch('/img/..')` rewrites the path to `/` before it leaves the process, so
 * it tests the client, not the server. A hostile client does no such thing —
 * this puts the exact bytes on the wire and returns the status code.
 */
function rawGet(path) {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect(PANEL_PORT, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error('raw request timed out'));
    });
    socket.on('data', (c) => (data += c));
    socket.on('end', () => {
      const match = /^HTTP\/1\.\d (\d{3})/.exec(data);
      resolve(match ? Number(match[1]) : 0);
    });
    socket.on('error', reject);
  });
}

async function waitFor(check, description, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await check();
    if (v) return v;
    await sleep(25);
  }
  assert.fail(`Timed out waiting for: ${description}`);
}

/** Minimal panel client that can request photo batches. */
class PhotoPanel {
  constructor() {
    this.photos = [];
    this.config = null;
    this.health = null;
  }

  async connect() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PANEL_PORT}/ws?t=${TOKEN}`);
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.t === 'hello') {
        this.config = msg.config;
        this.health = msg.health;
      } else if (msg.t === 'photos') {
        this.photos.push(msg.photos);
      } else if (msg.t === 'health') {
        this.health = msg.health;
      }
    });
    await new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
    await waitFor(() => this.config !== null, 'hello');
  }

  async request(count) {
    const before = this.photos.length;
    this.ws.send(JSON.stringify({ t: 'photos', id: Date.now() % 10000, count }));
    await waitFor(() => this.photos.length > before, 'photos response');
    return this.photos[this.photos.length - 1];
  }

  close() {
    this.ws?.close();
  }
}

before(async () => {
  writeFileSync(
    CONFIG,
    `
version: 1
ui: { title: Photos Test, timezone: UTC }
immich:
  enabled: true
  intervalSeconds: 30
  imagesOnly: true
  sources:
    - type: random
    - type: favorites
media: { players: [] }
`,
  );

  immich = new MockImmich(IMMICH_PORT);
  immich.seed(120);
  await immich.start();

  backend = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(PANEL_PORT),
      HOST: '127.0.0.1',
      PANEL_TOKEN: TOKEN,
      CONFIG_PATH: CONFIG,
      HA_URL: '',
      HA_TOKEN: '',
      IMMICH_URL: `http://127.0.0.1:${IMMICH_PORT}`,
      IMMICH_API_KEY: 'mock-immich-key',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  backend.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`));

  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${PANEL_PORT}/api/health`)).ok;
    } catch {
      return false;
    }
  }, 'backend to listen');
});

after(async () => {
  if (backend && backend.exitCode === null) {
    backend.kill('SIGTERM');
    await new Promise((r) => {
      backend.once('exit', r);
      setTimeout(r, 3000);
    });
  }
  await immich?.stop();
});

describe('playlist', () => {
  test('serves photos to the panel', async () => {
    const panel = new PhotoPanel();
    await panel.connect();

    const batch = await panel.request(10);
    assert.equal(batch.length, 10);
    assert.ok(batch[0].id, 'each photo has an id');
    panel.close();
  });

  test('normalises assets down to what the panel needs', async () => {
    const panel = new PhotoPanel();
    await panel.connect();
    const [photo] = await panel.request(1);

    // Present: what the slideshow uses.
    assert.equal(typeof photo.id, 'string');
    assert.equal(typeof photo.w, 'number');
    assert.equal(typeof photo.h, 'number');
    assert.equal(typeof photo.th, 'string', 'thumbhash forwarded for the placeholder');
    assert.ok(photo.taken, 'capture date forwarded for the caption');

    // Absent: the ~95% of AssetResponseDto the panel has no use for. Sending
    // it would be bytes and parse time on a constrained device for nothing.
    for (const key of ['owner', 'ownerId', 'checksum', 'originalPath', 'exifInfo', 'people']) {
      assert.ok(!(key in photo), `${key} must not reach the panel`);
    }
    panel.close();
  });

  test('does not repeat photos within a batch', async () => {
    const panel = new PhotoPanel();
    await panel.connect();
    const batch = await panel.request(40);
    const ids = new Set(batch.map((p) => p.id));
    assert.equal(ids.size, batch.length, 'ids within a batch must be unique');
    panel.close();
  });

  test('applies imagesOnly by asking Immich to filter', async () => {
    const random = immich.searches.filter((s) => s.path === '/api/search/random');
    assert.ok(random.length > 0, 'expected random searches');
    assert.ok(
      random.every((s) => s.dto.type === 'IMAGE'),
      'imagesOnly must be pushed to the server, not filtered client-side',
    );
  });

  test('excludes archived and hidden photos', async () => {
    const random = immich.searches.filter((s) => s.path === '/api/search/random');
    assert.ok(
      random.every((s) => s.dto.visibility === 'timeline'),
      'archived/hidden photos were put there to stay off screens',
    );
  });

  test('position survives a panel reconnect', async () => {
    const first = new PhotoPanel();
    await first.connect();
    const batchA = await first.request(20);
    first.close();
    await sleep(200);

    // A new panel — as after RoomOS wipes storage overnight — must continue
    // the playlist, not restart it.
    const second = new PhotoPanel();
    await second.connect();
    const batchB = await second.request(20);
    second.close();

    const overlap = batchA.filter((a) => batchB.some((b) => b.id === a.id));
    assert.equal(overlap.length, 0, 'a reconnecting panel must not replay the same photos');
  });
});

describe('image proxy', () => {
  test('serves an image and caches it immutably', async () => {
    const panel = new PhotoPanel();
    await panel.connect();
    const [photo] = await panel.request(1);
    panel.close();

    const res = await fetch(`http://127.0.0.1:${PANEL_PORT}/img/${photo.id}?s=full&t=${TOKEN}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.match(res.headers.get('cache-control') ?? '', /immutable/);
    assert.match(res.headers.get('cache-control') ?? '', /max-age=31536000/);
  });

  test('NEVER requests an original from Immich', async () => {
    const panel = new PhotoPanel();
    await panel.connect();
    const [photo] = await panel.request(1);
    panel.close();

    // Every way a caller might try to name a bigger render.
    for (const attempt of ['original', 'fullsize', 'ORIGINAL', '../original', '', 'preview']) {
      await fetch(
        `http://127.0.0.1:${PANEL_PORT}/img/${photo.id}?s=${encodeURIComponent(attempt)}&t=${TOKEN}`,
      );
    }

    const sizes = new Set(immich.thumbnailRequests.map((r) => r.size));
    assert.ok(
      !sizes.has('original') && !sizes.has('fullsize'),
      `only thumbnail/preview may ever be requested, saw: ${[...sizes].join(', ')}`,
    );
    assert.deepEqual(
      [...sizes].sort(),
      ['preview', 'thumbnail'],
      'the panel-facing sizes map onto exactly these two',
    );
  });

  test('s=grid uses the small thumbnail, s=full uses preview', async () => {
    const panel = new PhotoPanel();
    await panel.connect();
    const [photo] = await panel.request(1);
    panel.close();

    const before = immich.thumbnailRequests.length;
    await fetch(`http://127.0.0.1:${PANEL_PORT}/img/${photo.id}?s=grid&t=${TOKEN}`);
    await fetch(`http://127.0.0.1:${PANEL_PORT}/img/${photo.id}?s=full&t=${TOKEN}`);

    const recent = immich.thumbnailRequests.slice(before);
    assert.equal(recent[0].size, 'thumbnail');
    assert.equal(recent[1].size, 'preview');
  });

  test('refuses a non-UUID asset id', async () => {
    // Sent raw, so the path reaches the server exactly as written rather than
    // being normalised away by the client.
    for (const bad of [
      '../../etc/passwd',
      'not-a-uuid',
      '..',
      '%2e%2e%2f',
      '00000000-0000-4000-8000-000000000001/../../secret',
    ]) {
      const status = await rawGet(`/img/${bad}?s=full&t=${TOKEN}`);
      assert.equal(status, 400, `${bad} should be refused, got ${status}`);
    }
  });

  test('requires the panel token', async () => {
    const res = await fetch(
      `http://127.0.0.1:${PANEL_PORT}/img/00000000-0000-4000-8000-000000000001?s=full`,
    );
    assert.equal(res.status, 401);
  });
});

describe('resilience', () => {
  test('an Immich outage does not break the panel connection', async () => {
    immich.failWith = 500;

    const panel = new PhotoPanel();
    await panel.connect();
    assert.ok(panel.config, 'the panel still connects and gets its config');

    // The request must still answer — with whatever is buffered, or empty —
    // rather than hanging the slideshow.
    const batch = await panel.request(5);
    assert.ok(Array.isArray(batch), 'a photo request always answers');

    panel.close();
    immich.failWith = 0;
  });

  test('health reports Immich reachability', async () => {
    const panel = new PhotoPanel();
    await panel.connect();
    assert.ok(
      panel.health.immich === 'connected' || panel.health.immich === 'disconnected',
      'health carries an Immich link state',
    );
    panel.close();
  });
});
