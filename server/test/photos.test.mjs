import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tcpConnect, createServer as netCreateServer } from 'node:net';
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

/**
 * Ask the OS for a free port.
 *
 * Fixed port numbers meant one crashed test run left a listener behind and
 * poisoned every later run with EADDRINUSE — a failure that looks like a
 * product bug and isn't.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = netCreateServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
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
  constructor(port = PANEL_PORT, panelId = null) {
    this.port = port;
    this.panelId = panelId;
    this.photos = [];
    this.config = null;
    this.health = null;
    this.prefs = null;
    this.errors = [];
  }

  async connect() {
    const id = this.panelId ? `&panel=${encodeURIComponent(this.panelId)}` : '';
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws?t=${TOKEN}${id}`);
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.t === 'hello') {
        this.config = msg.config;
        this.health = msg.health;
        this.prefs = msg.prefs;
      } else if (msg.t === 'photos') {
        this.photos.push(msg.photos);
      } else if (msg.t === 'health') {
        this.health = msg.health;
      } else if (msg.t === 'prefs') {
        this.prefs = msg.prefs;
      } else if (msg.t === 'error') {
        this.errors.push(msg);
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

  /** Send a raw client message, for cases with no helper. */
  send(msg) {
    this.ws.send(JSON.stringify(msg));
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
  // Comfortably more than every test in this file consumes. The playlist
  // deliberately allows repeats once a library is exhausted, so a fixture
  // that is merely "big enough" makes later tests fail for the wrong reason.
  immich.seed(400);
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

/**
 * Everything started by `isolated()`, torn down unconditionally.
 *
 * Without this a *failing* test skips its own cleanup, leaving a spawned
 * backend holding the event loop open — so the run hangs instead of
 * reporting the failure, which is the worst possible way to learn about it.
 */
const started = [];
after(async () => {
  for (const t of started.splice(0)) await t.stop();
});

/** Start an isolated backend + Immich pair. Returns both, plus a stop(). */
async function isolated(configure = () => {}, configPath = CONFIG) {
  const [immichPort, panelPort] = [await freePort(), await freePort()];

  const server = new MockImmich(immichPort);
  server.seed(60);
  configure(server);
  await server.start();

  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(panelPort),
      HOST: '127.0.0.1',
      PANEL_TOKEN: TOKEN,
      CONFIG_PATH: configPath,
      HA_URL: '',
      HA_TOKEN: '',
      IMMICH_URL: `http://127.0.0.1:${immichPort}`,
      IMMICH_API_KEY: 'mock-immich-key',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[isolated] ${d}`));

  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${panelPort}/api/health`)).ok;
    } catch {
      return false;
    }
  }, 'isolated backend to listen');

  const panel = new PhotoPanel(panelPort);
  await panel.connect();

  let stopped = false;
  const t = {
    immich: server,
    panel,
    async stop() {
      if (stopped) return;
      stopped = true;
      panel.close();
      child.kill('SIGKILL');
      await server.stop();
    },
  };
  started.push(t);
  return t;
}


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

  test("prefers the asset's own dimensions over raw EXIF", async () => {
    /*
     * `AssetResponseDto.width`/`height` are written by Immich already
     * corrected for orientation, and are required fields — so unlike
     * `exifInfo` they arrive whether or not the query asked for EXIF. That
     * makes them the authoritative source, and the one that keeps working if
     * a search ever comes back without EXIF attached.
     */
    const panel = new PhotoPanel();
    await panel.connect();
    const batch = await panel.request(40);
    panel.close();

    const withTopLevel = immich.assets.filter((a) => a.width && a.height);
    assert.ok(withTopLevel.length > 0, 'precondition: assets carry top-level dimensions');

    let checked = 0;
    for (const asset of withTopLevel) {
      const photo = batch.find((p) => p.id === asset.id);
      if (!photo) continue;
      checked += 1;
      assert.equal(photo.w, asset.width, `${asset.id}: width must come from the asset`);
      assert.equal(photo.h, asset.height, `${asset.id}: height must come from the asset`);
    }
    assert.ok(checked > 0, 'the batch must contain at least one such photo');
  });

  test('falls back to EXIF when the server is too old for asset dimensions', async () => {
    const panel = new PhotoPanel();
    await panel.connect();
    const batch = await panel.request(40);
    panel.close();

    // Immich <= 1.133 had no top-level width/height at all. Those assets must
    // still get usable dimensions, or nothing downstream can tell a portrait
    // from a landscape.
    const legacy = immich.assets.filter((a) => !a.width && !a.height);
    assert.ok(legacy.length > 0, 'precondition: some assets have no top-level dimensions');

    let checked = 0;
    for (const asset of legacy) {
      const photo = batch.find((p) => p.id === asset.id);
      if (!photo) continue;
      checked += 1;
      assert.ok(photo.w > 0 && photo.h > 0, `${asset.id}: dimensions must still be resolved`);
    }
    assert.ok(checked > 0, 'the batch must contain at least one legacy-shaped photo');
  });

  test('reports the dimensions a rotated photo is DISPLAYED at', async () => {
    /*
     * Immich stores `exifImageWidth`/`exifImageHeight` as the sensor read
     * them, before EXIF orientation is applied, but bakes the rotation into
     * the thumbnails it serves. So a phone-shot portrait arrives as an
     * upright picture carrying landscape numbers.
     *
     * Passing those numbers through unchanged made every such photo look
     * landscape to the panel, which is why portrait pairing appeared to do
     * nothing on a real library. Immich's own web client swaps them
     * (`isFlipped`); so must we.
     */
    const panel = new PhotoPanel();
    await panel.connect();
    const batch = await panel.request(40);
    panel.close();

    const rotated = immich.assets.filter((a) => a.exifInfo?.orientation === '6');
    assert.ok(rotated.length > 0, 'precondition: the library contains rotated photos');

    let checked = 0;
    for (const asset of rotated) {
      const photo = batch.find((p) => p.id === asset.id);
      if (!photo) continue;
      checked += 1;
      assert.equal(photo.w, asset.exifInfo.exifImageHeight, 'width must come from stored height');
      assert.equal(photo.h, asset.exifInfo.exifImageWidth, 'height must come from stored width');
      assert.ok(photo.h > photo.w, 'a rotated phone photo is portrait once displayed');
    }
    assert.ok(checked > 0, 'the batch must contain at least one rotated photo to check');
  });

  test('leaves unrotated photos alone', async () => {
    const panel = new PhotoPanel();
    await panel.connect();
    const batch = await panel.request(40);
    panel.close();

    const upright = immich.assets.filter((a) => !a.exifInfo?.orientation);
    let checked = 0;
    for (const asset of upright) {
      const photo = batch.find((p) => p.id === asset.id);
      if (!photo) continue;
      checked += 1;
      assert.equal(photo.w, asset.exifInfo.exifImageWidth);
      assert.equal(photo.h, asset.exifInfo.exifImageHeight);
    }
    assert.ok(checked > 0, 'the batch must contain at least one upright photo to check');
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
    // Its own backend, because this asserts zero overlap and the playlist
    // deliberately permits repeats once a library runs dry. On the shared
    // backend the result depended on how many photos earlier tests had
    // consumed — so adding a test elsewhere could fail this one.
    const t = await isolated();
    const batchA = await t.panel.request(20);
    t.panel.close();
    await sleep(200);

    // A new panel — as after RoomOS wipes storage overnight — must continue
    // the playlist, not restart it.
    const second = new PhotoPanel(t.panel.port);
    await second.connect();
    const batchB = await second.request(20);
    second.close();

    const overlap = batchA.filter((a) => batchB.some((b) => b.id === a.id));
    assert.equal(overlap.length, 0, 'a reconnecting panel must not replay the same photos');
    await t.stop();
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

describe('panel preferences', () => {
  /*
   * Lives in this file because it needs `isolated()`: a preference test wants
   * its own backend, so restarting one is meaningful.
   *
   * The property that matters is persistence. RoomOS deletes web storage
   * daily (docs/ROOMOS.md §3), so a preference held in the browser would
   * revert overnight — the worst kind of setting, one that appears to work
   * for a day.
   */

  const PREFS_FILE = join(tmpdir(), 'panel-prefs.json');

  test('defaults, then accepts and broadcasts a change', async () => {
    rmSync(PREFS_FILE, { force: true });
    const t = await isolated();

    assert.equal(t.panel.config.ui.title, 'Photos Test', 'sanity: config arrived');
    assert.equal(t.panel.prefs.homeSide, 'media', 'the default is Now Playing');

    // A second panel must learn about a change made on the first, or two
    // panels on the same wall disagree about what they are showing.
    const observer = new PhotoPanel(t.panel.port);
    await observer.connect();

    t.panel.send({ t: 'pref', id: 1, key: 'homeSide', value: 'photos' });

    await waitFor(() => observer.prefs.homeSide === 'photos', 'the other panel to be told');
    assert.equal(observer.prefs.homeSide, 'photos');
    observer.close();
    await t.stop();
  });

  test('survives a backend restart', async () => {
    rmSync(PREFS_FILE, { force: true });
    const first = await isolated();
    first.panel.send({ t: 'pref', id: 1, key: 'homeSide', value: 'photos' });
    await sleep(300);
    await first.stop();

    // A container restart — a nightly image pull, say — must not silently
    // put the panel back to a setting the user changed away from.
    const second = await isolated();
    assert.equal(second.panel.prefs.homeSide, 'photos', 'the choice outlived the process');
    await second.stop();
  });

  /*
   * Per-panel settings. Every panel is provisioned with the same URL and the
   * same token, so before this the office panel and the kitchen panel were
   * one setting that both of them edited — changing the Home screen on one
   * wall changed it on the other.
   */

  test('two named panels keep their own settings', async () => {
    rmSync(PREFS_FILE, { force: true });
    const t = await isolated();

    const office = new PhotoPanel(t.panel.port, 'office');
    const kitchen = new PhotoPanel(t.panel.port, 'kitchen');
    await office.connect();
    await kitchen.connect();

    office.send({ t: 'pref', id: 1, key: 'homeSide', value: 'photos' });
    await waitFor(() => office.prefs.homeSide === 'photos', 'the office panel to change');

    // The whole point: the other wall did not change.
    await sleep(200);
    assert.equal(kitchen.prefs.homeSide, 'media', 'the kitchen panel kept its own');

    office.close();
    kitchen.close();
    await t.stop();
  });

  test('a panel with no id still reads and writes the shared settings', async () => {
    // Every panel provisioned before this existed has no id. It must keep
    // working, and keep behaving exactly as it did.
    rmSync(PREFS_FILE, { force: true });
    const t = await isolated();

    const observer = new PhotoPanel(t.panel.port);
    await observer.connect();

    t.panel.send({ t: 'pref', id: 1, key: 'homeSide', value: 'photos' });
    await waitFor(() => observer.prefs.homeSide === 'photos', 'the other unnamed panel');

    observer.close();
    await t.stop();
  });

  test('a named panel inherits the shared setting until it overrides it', async () => {
    /*
     * The merge is per KEY. Setting the shared default has to reach a panel
     * that has its own block for something else, or "set it once for
     * everywhere, then adjust the odd one" quietly stops working the moment a
     * panel is touched.
     */
    rmSync(PREFS_FILE, { force: true });
    const t = await isolated();

    const office = new PhotoPanel(t.panel.port, 'office');
    await office.connect();

    // Give the office panel a block of its own, holding a DIFFERENT key.
    office.send({ t: 'layout', id: 1, layout: { sections: {}, hidden: [] } });
    await sleep(200);

    // Now change the shared default from an unnamed panel.
    t.panel.send({ t: 'pref', id: 2, key: 'homeSide', value: 'photos' });
    await waitFor(
      () => office.prefs.homeSide === 'photos',
      'the shared change to reach a panel that overrode something else',
    );

    // And an override still wins over it.
    office.send({ t: 'pref', id: 3, key: 'homeSide', value: 'media' });
    await waitFor(() => office.prefs.homeSide === 'media', 'the override to take');

    const shared = new PhotoPanel(t.panel.port);
    await shared.connect();
    assert.equal(shared.prefs.homeSide, 'photos', 'the shared value was not overwritten');

    shared.close();
    office.close();
    await t.stop();
  });

  test('each panel keeps its own settings across a restart', async () => {
    rmSync(PREFS_FILE, { force: true });
    const first = await isolated();
    const office = new PhotoPanel(first.panel.port, 'office');
    await office.connect();
    office.send({ t: 'pref', id: 1, key: 'homeSide', value: 'photos' });
    await sleep(300);
    office.close();
    await first.stop();

    const second = await isolated();
    const back = new PhotoPanel(second.panel.port, 'office');
    const other = new PhotoPanel(second.panel.port, 'kitchen');
    await back.connect();
    await other.connect();

    assert.equal(back.prefs.homeSide, 'photos', 'the office panel came back to its own choice');
    assert.equal(other.prefs.homeSide, 'media', 'and the kitchen panel to the default');

    back.close();
    other.close();
    await second.stop();
  });

  test('an old flat prefs file is read as the shared settings', async () => {
    /*
     * The file used to be one flat object. Upgrading must not silently reset
     * a setting somebody already chose — on a wall panel, with nothing
     * anywhere saying why it moved.
     */
    rmSync(PREFS_FILE, { force: true });
    writeFileSync(PREFS_FILE, JSON.stringify({ homeSide: 'photos' }));

    const t = await isolated();
    assert.equal(t.panel.prefs.homeSide, 'photos', 'the old file was carried forward');

    const named = new PhotoPanel(t.panel.port, 'office');
    await named.connect();
    assert.equal(named.prefs.homeSide, 'photos', 'and a named panel inherits it');

    named.close();
    await t.stop();
  });

  test('a panel id that is not one falls back to the shared settings', async () => {
    // The id ends up as a key in a JSON file on disk. Anything that could
    // confuse that is not an id, and a panel offering one is treated as a
    // panel that offered none.
    rmSync(PREFS_FILE, { force: true });
    const t = await isolated();

    const sneaky = new PhotoPanel(t.panel.port, '../../etc/passwd');
    await sneaky.connect();

    sneaky.send({ t: 'pref', id: 1, key: 'homeSide', value: 'photos' });
    await waitFor(() => sneaky.prefs.homeSide === 'photos', 'the change to apply somewhere');

    const shared = new PhotoPanel(t.panel.port);
    await shared.connect();
    assert.equal(shared.prefs.homeSide, 'photos', 'it landed in the shared block');

    const saved = JSON.parse(readFileSync(PREFS_FILE, 'utf8'));
    assert.deepEqual(Object.keys(saved.panels), [], 'and created no scope of its own');

    shared.close();
    sneaky.close();
    await t.stop();
  });

  test('a player layout is bounded and section-checked', async () => {
    /*
     * This ends up on disk and a client writes it, so everything about it is
     * bounded: ids must look like media players, headings must be ones the
     * config declares, and a speaker cannot appear twice.
     */
    const cfgPath = join(tmpdir(), 'navigator-layout.yaml');
    writeFileSync(
      cfgPath,
      `
version: 1
ui: { title: Layout, timezone: UTC }
immich: { enabled: true, sources: [{ type: random }] }
media:
  sections: [Downstairs, Outside]
  players: []
`,
    );
    rmSync(join(tmpdir(), 'panel-prefs.json'), { force: true });
    const t = await isolated(() => {}, cfgPath);

    t.panel.send({
      t: 'layout',
      id: 90,
      layout: {
        sections: {
          Downstairs: ['media_player.a', 'media_player.a', 'light.kitchen', 42],
          Nonexistent: ['media_player.b'],
        },
        hidden: ['media_player.c', 'not_an_entity'],
      },
    });

    await waitFor(
      () => t.panel.prefs.players.sections['Downstairs']?.length === 1,
      'the layout to be applied',
    );

    const saved = t.panel.prefs.players;
    assert.deepEqual(saved.sections['Downstairs'], ['media_player.a'], 'deduped, and non-players dropped');
    assert.ok(!('Nonexistent' in saved.sections), 'a heading the config does not declare is dropped');
    assert.deepEqual(saved.hidden, ['media_player.c'], 'hidden is filtered the same way');

    await t.stop();
  });

  test('refuses anything not on the allow-list', async () => {
    rmSync(PREFS_FILE, { force: true });
    const t = await isolated();

    // This arrives from a client. It reaching only a small enum is what makes
    // it uninteresting to anyone holding a panel token.
    for (const [key, value] of [
      ['homeSide', 'rm -rf'],
      ['homeSide', '../../etc/passwd'],
      ['homeSide', ''],
      ['__proto__', 'polluted'],
      ['haToken', 'stolen'],
    ]) {
      t.panel.send({ t: 'pref', id: 2, key, value });
    }
    await sleep(400);

    assert.equal(t.panel.prefs.homeSide, 'media', 'nothing invalid was applied');
    assert.ok(t.panel.errors.length > 0, 'and the panel was told why');
    // Name the keys rather than counting them: a count silently goes stale
    // the moment a legitimate preference is added, which is exactly what
    // happened when the player layout arrived.
    assert.deepEqual(
      Object.keys(t.panel.prefs).sort(),
      ['homeSide', 'players'],
      'no extra keys were introduced by a hostile payload',
    );
    await t.stop();
  });
});

describe('diagnosability', () => {
  /*
   * The bug these exist for: a working config returned zero photos, the panel
   * said "check your sources", and the backend logged nothing at all. Every
   * Immich failure except 401/403 was invisible at the default log level, so
   * the one place that knew what had happened threw it away.
   *
   * Each of these gets its own backend and its own Immich. They are about
   * what happens on a *fresh* start against a misconfigured server, and a
   * shared backend would answer them from a playlist filled earlier — which
   * is exactly the buffering that hid the problem in the first place.
   */

  test('an empty result is distinguishable from a failed query', async () => {
    const t = await isolated((s) => {
      s.failWith = 500;
    });

    const batch = await t.panel.request(5);
    assert.equal(batch.length, 0, 'precondition: a failing Immich yields no photos');

    // The panel must be able to tell the user WHY. Without this it shows an
    // empty grid that looks exactly like an empty library.
    await waitFor(() => t.panel.health.immichError !== null, 'an error reason to reach the panel');
    assert.match(t.panel.health.immichError, /500/, 'the reason names the actual status');

    await t.stop();
  });

  test('a rejected API key is reported as such, not as an empty library', async () => {
    // Real Immich leaves /server/ping unauthenticated, so a bad key pings
    // perfectly happily. Health must not be fooled by that.
    const t = await isolated((s) => {
      s.expectedKey = 'a-different-key';
    });

    // Crucially, WITHOUT asking for photos first. The startup health check is
    // the thing under test: it used to call /server/ping, which needs no
    // credentials at all, so a wrong key reported a healthy Immich until
    // something actually tried to use it.
    await waitFor(
      () => t.panel.health.immich === 'disconnected',
      'health to reflect that the key is refused',
    );
    await waitFor(() => t.panel.health.immichError !== null, 'an auth failure to reach the panel');
    assert.match(
      t.panel.health.immichError,
      /API key|401/i,
      `expected an auth reason, got: ${t.panel.health.immichError}`,
    );

    await t.stop();
  });

  test('the Home card interval defaults to 15s and is clamped', async () => {
    const t = await isolated();
    assert.equal(t.panel.config.immich.homeCardSeconds, 15, 'unset means 15 seconds');
    await t.stop();

    const cfgPath = join(tmpdir(), 'navigator-photos-cardsecs.yaml');
    // 0 must survive as 0 — it is the documented way to hold one photo, not a
    // missing value to be defaulted. A silly value gets clamped rather than
    // rejected, so a typo does not stop the card working.
    for (const [written, expected] of [
      [0, 0],
      [90, 90],
      [999999, 3600],
      [-5, 0],
    ]) {
      writeFileSync(
        cfgPath,
        `
version: 1
ui: { title: Card, timezone: UTC }
immich:
  enabled: true
  homeCardSeconds: ${written}
  sources: [{ type: random }]
media: { players: [] }
`,
      );
      const c = await isolated(() => {}, cfgPath);
      assert.equal(
        c.panel.config.immich.homeCardSeconds,
        expected,
        `homeCardSeconds: ${written} should reach the panel as ${expected}`,
      );
      await c.stop();
    }
  });

  test('portrait pairing is on by default and can be switched off', async () => {
    // The panel decides the collage layout, but it can only honour a setting
    // the backend actually parses and forwards.
    const t = await isolated();
    assert.equal(
      t.panel.config.immich.pairPortraits,
      true,
      'unset means on — a portrait alone wastes two thirds of a 16:9 panel',
    );
    await t.stop();

    const offConfig = join(tmpdir(), 'navigator-photos-nopair.yaml');
    writeFileSync(
      offConfig,
      `
version: 1
ui: { title: No Pair, timezone: UTC }
immich:
  enabled: true
  pairPortraits: false
  sources: [{ type: random }]
media: { players: [] }
`,
    );
    const off = await isolated(() => {}, offConfig);
    assert.equal(off.panel.config.immich.pairPortraits, false, 'an explicit false is honoured');
    await off.stop();
  });

  test('works against Immich older than 1.133, which had no `visibility`', async () => {
    // 1.133 renamed isArchived -> visibility. Immich rejects unknown
    // properties outright, so on an older server every query 400s and the
    // slideshow is empty forever — with no error anywhere near it.
    const t = await isolated((s) => {
      s.legacyArchiveField = true;
    });

    const batch = await t.panel.request(10);
    assert.ok(batch.length > 0, 'photos must still arrive from a pre-1.133 server');

    const random = t.immich.searches
      .filter((s) => s.path === '/api/search/random')
      .map((s) => s.dto);
    assert.ok(
      random.some((d) => 'visibility' in d),
      'it should try the modern field first',
    );
    assert.ok(
      random.some((d) => d.isArchived === false),
      'and fall back to the legacy one on rejection',
    );

    await t.stop();
  });
});
