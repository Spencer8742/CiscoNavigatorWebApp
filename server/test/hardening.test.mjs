import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { WebSocket } from 'ws';
import { Hub, StaticFiles, preferredEncoding, streamUpstream } from '../dist/testkit.js';

/**
 * What a misbehaving panel does to the backend.
 *
 * The backend runs for months and every panel in the house shares it, so the
 * cases here are the ones that only show up over time: a panel that drops
 * mid-image, one that stops reading without closing, one that sends frames
 * that are valid JSON but not messages, and the cold load every panel makes
 * after RoomOS wipes its cache overnight.
 *
 *   node --test server/test/hardening.test.mjs
 */

/** An HTTP server on a random port whose handler is the function under test. */
async function serve(handler) {
  const server = createServer((req, res) => void handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

/** GET a URL and collect the whole body, or report how the response failed. */
function fetchRaw(port, path, headers = {}) {
  return new Promise((resolve) => {
    const req = get({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), complete: true }));
      res.on('aborted', () => resolve({ status: res.statusCode, headers: res.headers, complete: false }));
      res.on('error', () => resolve({ status: res.statusCode, headers: res.headers, complete: false }));
    });
    req.on('error', () => resolve({ complete: false }));
  });
}

/** An upstream Response whose body is produced chunk by chunk, recording cancellation. */
function slowUpstream({ chunks, chunkBytes = 16 * 1024, delayMs = 10, headers = {} }) {
  const record = { cancelled: false, produced: 0 };
  let sent = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (sent >= chunks) return controller.close();
      await new Promise((r) => setTimeout(r, delayMs));
      sent += 1;
      record.produced = sent;
      controller.enqueue(new Uint8Array(chunkBytes).fill(sent));
    },
    cancel() {
      record.cancelled = true;
    },
  });
  return { response: new Response(body, { headers: { 'content-type': 'image/jpeg', ...headers } }), record };
}

describe('streaming an upstream body to a panel', () => {
  test('a panel that disconnects mid-image releases the request and stops the upstream', async () => {
    const { response, record } = slowUpstream({ chunks: 400, delayMs: 5 });
    const controller = new AbortController();
    let finished;
    const done = new Promise((resolve) => (finished = resolve));

    const { server, port } = await serve(async (_req, res) => {
      await streamUpstream(response, res, {
        headers: { 'content-type': 'image/jpeg' },
        maxBytes: 64 * 1024 * 1024,
        controller,
      });
      finished();
    });

    await new Promise((resolve) => {
      const req = get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', () => undefined);
    });

    const outcome = await Promise.race([done.then(() => 'released'), new Promise((r) => setTimeout(() => r('stuck'), 3000))]);
    server.close();
    assert.equal(outcome, 'released', 'the request handler must return once its panel has gone');
    assert.ok(controller.signal.aborted, 'the upstream fetch is aborted');
    assert.ok(record.cancelled, 'the upstream body is cancelled');
    assert.ok(record.produced < 400, `the upstream stopped early (produced ${record.produced} of 400 chunks)`);
  });

  test('a panel that stops reading without disconnecting does not strand the request once it goes', async () => {
    // Large chunks fill the socket buffers, so the stream waits for `drain` —
    // the wait that used to last forever when the panel then went away.
    const { response } = slowUpstream({ chunks: 200, chunkBytes: 256 * 1024, delayMs: 0 });
    const controller = new AbortController();
    let finished;
    const done = new Promise((resolve) => (finished = resolve));

    const { server, port } = await serve(async (_req, res) => {
      await streamUpstream(response, res, { headers: {}, maxBytes: 1024 * 1024 * 1024, controller });
      finished();
    });

    const req = get({ host: '127.0.0.1', port, path: '/' }, (res) => res.pause());
    req.on('error', () => undefined);
    await new Promise((r) => setTimeout(r, 300));
    req.destroy();

    const outcome = await Promise.race([done.then(() => 'released'), new Promise((r) => setTimeout(() => r('stuck'), 3000))]);
    server.close();
    assert.equal(outcome, 'released');
  });

  test('a body over the limit fails the response rather than ending it as if complete', async () => {
    const { response } = slowUpstream({ chunks: 10, chunkBytes: 1024, delayMs: 0 });
    const reasons = [];
    const { server, port } = await serve((_req, res) =>
      streamUpstream(response, res, {
        headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=604800, immutable' },
        maxBytes: 4096,
        controller: new AbortController(),
        onFail: (reason) => reasons.push(reason),
      }),
    );

    const result = await fetchRaw(port, '/');
    server.close();
    assert.equal(result.complete, false, 'a truncated image must not arrive as a finished, cacheable response');
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /limit/);
  });

  test('an upstream that declares a length over the limit is refused before anything is sent', async () => {
    const { response, record } = slowUpstream({ chunks: 1, headers: { 'content-length': String(50 * 1024 * 1024) } });
    const controller = new AbortController();
    const { server, port } = await serve((_req, res) =>
      streamUpstream(response, res, { headers: { 'content-type': 'image/jpeg' }, maxBytes: 1024 * 1024, controller }),
    );

    const result = await fetchRaw(port, '/');
    server.close();
    assert.equal(result.status, 502);
    assert.ok(controller.signal.aborted);
    assert.equal(record.produced, 0, 'nothing was downloaded');
  });

  test('a complete body arrives whole, with its length', async () => {
    const payload = new Uint8Array(70_000).map((_, i) => i % 251);
    const response = new Response(payload, { headers: { 'content-type': 'image/png', 'content-length': String(payload.length) } });
    const { server, port } = await serve((_req, res) =>
      streamUpstream(response, res, { headers: { 'content-type': 'image/png' }, maxBytes: 1024 * 1024, controller: new AbortController() }),
    );

    const result = await fetchRaw(port, '/');
    server.close();
    assert.equal(result.status, 200);
    assert.equal(result.headers['content-length'], String(payload.length));
    assert.deepEqual(new Uint8Array(result.body), payload);
  });
});

describe('serving the panel bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'panel-static-'));
  await mkdir(join(root, 'a'));
  const script = 'export const greeting = "hello from the panel";\n'.repeat(400);
  await writeFile(join(root, 'a', 'index.abc123.js'), script);
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Panel</title>' + '<p>shell</p>'.repeat(200));
  await writeFile(join(root, 'tiny.json'), '{"ok":true}');

  const files = new StaticFiles(root);
  await files.warm();
  const { server, port } = await serve((req, res) => files.serve(req, res, new URL(req.url, 'http://x').pathname));

  after(async () => {
    server.close();
    await rm(root, { recursive: true, force: true });
  });

  test('brotli to a client that takes it, and it decodes to the file', async () => {
    const r = await fetchRaw(port, '/a/index.abc123.js', { 'accept-encoding': 'gzip, deflate, br' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], 'br');
    assert.equal(r.headers['vary'], 'accept-encoding');
    assert.match(r.headers['cache-control'], /immutable/);
    assert.ok(r.body.length < script.length / 4, `compressed to ${r.body.length} of ${script.length} bytes`);
    assert.equal(brotliDecompressSync(r.body).toString(), script);
  });

  test('gzip when brotli is not offered', async () => {
    const r = await fetchRaw(port, '/a/index.abc123.js', { 'accept-encoding': 'gzip' });
    assert.equal(r.headers['content-encoding'], 'gzip');
    assert.equal(gunzipSync(r.body).toString(), script);
  });

  test('as it is when nothing is offered, and still says it varies', async () => {
    const r = await fetchRaw(port, '/a/index.abc123.js');
    assert.equal(r.headers['content-encoding'], undefined);
    assert.equal(r.headers['vary'], 'accept-encoding');
    assert.equal(r.body.toString(), script);
  });

  test('the SPA fallback is compressed too', async () => {
    const r = await fetchRaw(port, '/some/route', { 'accept-encoding': 'br' });
    assert.equal(r.headers['content-encoding'], 'br');
    assert.match(brotliDecompressSync(r.body).toString(), /<title>Panel<\/title>/);
    assert.equal(r.headers['cache-control'], 'no-cache');
  });

  test('each encoding revalidates against its own ETag', async () => {
    const first = await fetchRaw(port, '/index.html', { 'accept-encoding': 'br' });
    const again = await fetchRaw(port, '/index.html', { 'accept-encoding': 'br', 'if-none-match': first.headers.etag });
    assert.equal(again.status, 304);

    const gz = await fetchRaw(port, '/index.html', { 'accept-encoding': 'gzip', 'if-none-match': first.headers.etag });
    assert.equal(gz.status, 200, 'a brotli validator does not vouch for gzip bytes');
    assert.equal(gz.headers['content-encoding'], 'gzip');
  });

  test('small files are not worth compressing', async () => {
    const r = await fetchRaw(port, '/tiny.json', { 'accept-encoding': 'br' });
    assert.equal(r.headers['content-encoding'], undefined);
    assert.equal(r.body.toString(), '{"ok":true}');
  });

  test('accept-encoding is read properly, q=0 included', () => {
    assert.equal(preferredEncoding('gzip, deflate, br'), 'br');
    assert.equal(preferredEncoding('br;q=0, gzip'), 'gzip');
    assert.equal(preferredEncoding('BR;q=0.5'), 'br');
    assert.equal(preferredEncoding('gzip;q=0'), null);
    assert.equal(preferredEncoding('identity'), null);
    assert.equal(preferredEncoding(undefined), null);
    assert.equal(preferredEncoding(['gzip', 'br']), 'br');
  });
});

describe('the panel hub', async () => {
  const listeners = [];
  const deps = {
    auth: { check: () => true },
    config: { current: { rooms: [] }, onChange: (fn) => listeners.push(fn) },
    getStates: () => ({}),
    getHealth: () => ({}),
    getPlayers: () => ({ players: [], queues: [] }),
    getPrefs: () => ({}),
    getKeyLights: () => [],
    getTvs: () => [],
    getRoomos: () => [],
    getAppleTvs: () => [],
    getIina: () => [],
    getSources: () => [],
    onControl: async (button) => {
      if (button === 'explodes') throw new Error('handler threw instead of returning a reason');
      return null;
    },
  };
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const hub = new Hub(server, deps);

  after(() => {
    hub.close();
    server.close();
  });

  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const next = async (pred, ms = 2000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const found = messages.find(pred);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 10));
      }
      return null;
    };
    await next((m) => m.t === 'hello');
    return { ws, messages, next };
  }

  test('frames that are JSON but not messages leave the socket working', async () => {
    const panel = await connect();
    for (const frame of ['null', '3', '"text"', '[]', '{}', '{"t":7}']) panel.ws.send(frame);
    panel.ws.send(JSON.stringify({ t: 'ping', id: 42 }));
    const pong = await panel.next((m) => m.t === 'pong' && m.ref === 42);
    assert.ok(pong, 'still answering after nonsense');
    panel.ws.close();
  });

  test('a handler that throws still answers the panel', async () => {
    const panel = await connect();
    panel.ws.send(JSON.stringify({ t: 'control', id: 7, button: 'explodes' }));
    const error = await panel.next((m) => m.t === 'error' && m.ref === 7);
    assert.ok(error, 'the panel is told the request failed rather than left waiting');
    assert.equal(error.code, 'request_failed');
    panel.ws.close();
  });

  test('a panel that stops reading is dropped instead of buffering the house', async () => {
    const panel = await connect();
    const closed = new Promise((resolve) => panel.ws.once('close', resolve));
    // Stop reading at the TCP level: the kernel buffers fill, then ours do.
    panel.ws._socket.pause();

    const big = { t: 'config', config: { filler: 'x'.repeat(512 * 1024) } };
    const deadline = Date.now() + 10_000;
    while (hub.panelCount > 0 && Date.now() < deadline) {
      hub.broadcast(big);
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(hub.panelCount, 0, 'the stalled panel was let go');
    panel.ws._socket.resume();
    await closed;
  });
});
