import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

/**
 * What happens to an unanswered request when the socket goes away.
 *
 * Browse, link and assist all reject on close, so a spinner never outlives
 * the connection that would have filled it. Photo requests were the
 * exception: they carry their own ten-second timeout and were left to it.
 *
 * That is not harmless, because `fill()` in media/photos.ts deliberately
 * shares one in-flight promise between concurrent callers. A request
 * stranded by a dropped socket therefore strands the next refill too, and
 * the slideshow stays empty for the rest of those ten seconds — typically
 * well after the panel has visibly reconnected. On a Wi-Fi roam that is a
 * blank screen for no reason.
 */

const bundle = await build({
  entryPoints: [new URL('../src/net/socket.ts', import.meta.url).pathname],
  tsconfig: new URL('../tsconfig.json', import.meta.url).pathname,
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  define: { __APP_VERSION__: '"test"' },
});

let moduleId = 0;

/** The last socket the module opened, with the handlers it attached. */
let live = null;

class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = FakeSocket.OPEN;
  sent = [];
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;

  constructor(url) {
    this.url = url;
    live = this;
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  /** What the engine does when the AP reboots mid-request. */
  drop() {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  close() {
    this.drop();
  }
}

async function setup(t) {
  const saved = {
    window: globalThis.window,
    WebSocket: globalThis.WebSocket,
    localStorage: globalThis.localStorage,
  };

  globalThis.window = {
    location: { protocol: 'http:', host: 'panel.test', search: '', href: 'http://panel.test/' },
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.WebSocket = FakeSocket;
  globalThis.localStorage = {
    getItem: () => null,
    setItem() {},
  };
  live = null;

  const socket = await import('data:text/javascript;base64,'
    + Buffer.from(bundle.outputFiles[0].text).toString('base64') + `#${++moduleId}`);

  t.after(() => {
    socket.disconnect();
    globalThis.window = saved.window;
    globalThis.WebSocket = saved.WebSocket;
    globalThis.localStorage = saved.localStorage;
    live = null;
  });

  socket.connect();
  assert.ok(live, 'the module should have opened a socket');
  live.onopen?.();
  return socket;
}

test('a photo request stranded by a dropped socket resolves at once, not on its timeout', async (t) => {
  const socket = await setup(t);

  const pending = socket.requestPhotos(24);
  assert.equal(live.sent.at(-1)?.t, 'photos', 'the request should have gone out');

  const started = Date.now();
  live.drop();

  // The ten-second fallback timer must not be what settles this.
  const photos = await pending;
  const waited = Date.now() - started;

  assert.deepEqual(photos, [], 'an unanswered batch is "nothing yet", not an error');
  assert.ok(waited < 1000, `resolved after ${waited}ms — its own timeout was still running`);
});

test('a reconnect can ask again immediately', async (t) => {
  const socket = await setup(t);

  const first = socket.requestPhotos(24);
  const dropped = live;
  dropped.drop();
  assert.deepEqual(await first, []);

  // Stand a fresh socket up the way reconnection does, and check the module
  // has not been left holding the old request's id.
  socket.connect();
  live.onopen?.();

  const second = socket.requestPhotos(24);
  const request = live.sent.find((msg) => msg.t === 'photos');
  assert.ok(request, 'the second request should have been sent on the new socket');

  live.onmessage?.({
    data: JSON.stringify({ t: 'photos', ref: request.id, photos: [{ id: 'a', w: 1, h: 1 }] }),
  });

  assert.deepEqual(
    (await second).map((photo) => photo.id),
    ['a'],
    'the reply must land on the new request, not a stale waiter from before the drop',
  );
});

test('a half-open socket that misses its pong is replaced without waiting for its close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const socket = await setup(t);

  // Half-open: the engine still says OPEN, nothing ever answers, and close()
  // starts a closing handshake that nobody will finish — so no onclose.
  const stale = live;
  let closeCalled = false;
  stale.close = () => {
    closeCalled = true;
  };

  const photos = socket.requestPhotos(24);
  socket.probe();
  assert.equal(stale.sent.at(-1)?.t, 'ping', 'probing sends a ping at once');

  t.mock.timers.tick(12_000);
  assert.ok(closeCalled, 'the dead socket is asked to close');
  assert.deepEqual(await photos, [], 'what it was holding is released straight away');

  // Reconnection is on its normal backoff, not on the stale socket's onclose.
  t.mock.timers.tick(30_000);
  assert.notEqual(live, stale, 'a fresh socket has been opened');

  // The stale socket's close arriving late must not tear the new one down.
  const fresh = live;
  stale.onclose?.();
  t.mock.timers.tick(30_000);
  assert.equal(live, fresh, 'the late close of the old socket is ignored');
});

test('a frame the panel cannot apply does not stop the frames after it', async (t) => {
  const socket = await setup(t);
  const pending = socket.requestPhotos(3);
  const request = live.sent.find((msg) => msg.t === 'photos');

  for (const data of ['null', '7', '{"t":"patch"}']) live.onmessage?.({ data });
  live.onmessage?.({ data: JSON.stringify({ t: 'photos', ref: request.id, photos: [{ id: 'b', w: 1, h: 1 }] }) });

  assert.deepEqual((await pending).map((p) => p.id), ['b']);
});
