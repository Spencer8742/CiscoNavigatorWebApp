import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

/**
 * The Cast side of the backend: framing, one conversation with a device, and
 * the loop that keeps a Nest Hub showing the dashboard.
 *
 * The mock in mock-cast.mjs implements the protocol independently — see the
 * note at the top of that file for why that matters more than it usually does
 * here. What is *not* tested is TLS, which is Node's code and which verifies
 * nothing against a Cast device anyway.
 */

const { encodeFrame, decodeFrame, FrameReader, CastDevice, CastKeeper, splitHost, DASHCAST_APP_ID } =
  await import(fileURLToPath(new URL('../dist/testkit.js', import.meta.url)));

const { MockCastDevice } = await import('./mock-cast.mjs');

/** Plain TCP in place of TLS. Everything above the socket is unchanged. */
const plainTransport = (host, port) =>
  new Promise((resolve, reject) => {
    const socket = connect({ host, port }, () => {
      socket.removeListener('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });

function deviceFor(address, options = {}) {
  const [host, port] = address.split(':');
  return new CastDevice({ host, port: Number(port), transport: plainTransport, ...options });
}

async function withDevice(options, body) {
  const mock = new MockCastDevice(options);
  const address = await mock.start();
  try {
    return await body(mock, address);
  } finally {
    await mock.stop();
  }
}

const URL_A = 'http://192.168.1.71:8099/?cast=1&pane=dashboard';

const SERVER = fileURLToPath(new URL('../dist/server.js', import.meta.url));

/** OS-assigned, so a crashed run never leaves the next one with EADDRINUSE. */
function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(check, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for: ${description}`);
}

describe('frame encoding', () => {
  test('round-trips a frame', () => {
    const frame = {
      namespace: 'urn:x-cast:com.google.cast.receiver',
      source: 'sender-navigator',
      destination: 'receiver-0',
      payload: JSON.stringify({ type: 'GET_STATUS', requestId: 7 }),
    };
    const encoded = encodeFrame(frame);
    assert.equal(encoded.readUInt32BE(0), encoded.length - 4, 'length prefix covers the body');
    assert.deepEqual(decodeFrame(encoded.subarray(4)), frame);
  });

  test('survives multi-byte UTF-8 in the payload', () => {
    // Device names come from whatever the household typed into Google Home.
    const frame = {
      namespace: 'urn:x-cast:com.madmod.dashcast',
      source: 'sender-navigator',
      destination: 'web-9',
      payload: JSON.stringify({ url: 'http://x/?q=café-日本', force: true }),
    };
    const decoded = decodeFrame(encodeFrame(frame).subarray(4));
    assert.deepEqual(decoded, frame, 'length must be in bytes, not characters');
  });

  test('encodes a payload longer than one varint byte', () => {
    // Anything over 127 bytes needs a two-byte length; a receiver status is
    // always longer than that, so getting this wrong breaks everything.
    const payload = 'x'.repeat(5000);
    const decoded = decodeFrame(
      encodeFrame({ namespace: 'n', source: 's', destination: 'd', payload }).subarray(4),
    );
    assert.equal(decoded.payload.length, 5000);
  });

  test('skips unknown fields instead of failing', () => {
    // Forward compatibility is the reason protobuf is used at all: a firmware
    // that adds a field must not stop us reading the ones we know.
    const known = encodeFrame({ namespace: 'n', source: 's', destination: 'd', payload: 'p' });
    const body = known.subarray(4);
    // field 9, wire type 0 (varint), value 1
    const extra = Buffer.from([9 * 8 + 0, 1]);
    const decoded = decodeFrame(Buffer.concat([body, extra]));
    assert.equal(decoded.namespace, 'n');
    assert.equal(decoded.payload, 'p');
  });

  test('rejects a body whose last field runs off the end', () => {
    // Cut inside the payload, so the length says seven bytes and four are
    // there. Returning a short string here would be worse than failing.
    const body = encodeFrame({
      namespace: 'n',
      source: 's',
      destination: 'd',
      payload: 'payload',
    }).subarray(4);
    assert.equal(decodeFrame(body.subarray(0, body.length - 3)), null);
  });
});

describe('stream framing', () => {
  const frame = (payload) =>
    encodeFrame({ namespace: 'ns', source: 'a', destination: 'b', payload });

  test('reassembles a frame split across chunks', () => {
    const reader = new FrameReader();
    const bytes = frame('hello');
    assert.deepEqual(reader.push(bytes.subarray(0, 3)), [], 'not even the length yet');
    assert.deepEqual(reader.push(bytes.subarray(3, 9)), []);
    const done = reader.push(bytes.subarray(9));
    assert.equal(done.length, 1);
    assert.equal(done[0].payload, 'hello');
  });

  test('returns several frames delivered in one chunk', () => {
    const reader = new FrameReader();
    const frames = reader.push(Buffer.concat([frame('one'), frame('two'), frame('three')]));
    assert.deepEqual(
      frames.map((f) => f.payload),
      ['one', 'two', 'three'],
    );
  });

  test('keeps a trailing partial frame for the next chunk', () => {
    const reader = new FrameReader();
    const both = Buffer.concat([frame('one'), frame('two')]);
    const cut = both.length - 2;
    assert.deepEqual(
      reader.push(both.subarray(0, cut)).map((f) => f.payload),
      ['one'],
    );
    assert.deepEqual(
      reader.push(both.subarray(cut)).map((f) => f.payload),
      ['two'],
    );
  });

  test('refuses an implausible length instead of allocating it', () => {
    const reader = new FrameReader();
    const evil = Buffer.alloc(8);
    evil.writeUInt32BE(0xffffffff, 0);
    assert.throws(() => reader.push(evil), /refusing to buffer/);
  });
});

describe('casting to a device', () => {
  test('launches DashCast and hands it the URL', async () => {
    await withDevice({}, async (mock, address) => {
      const outcome = await deviceFor(address).show(URL_A);
      assert.equal(outcome, 'cast');
      assert.equal(mock.launches, 1);
      assert.deepEqual(mock.loads, [{ url: URL_A, force: true, reload: false, reload_time: 0 }]);
      // The mock enforces cast_channel.proto's required fields, as a real
      // device's parser does. A message missing one is silently dropped
      // there, which is the hardest kind of bug to find on a wall.
      assert.deepEqual(mock.protocolErrors, []);
    });
  });

  test('leaves a display that is already showing the dashboard alone', async () => {
    // The whole reason this can run on a timer. Re-casting every pass would
    // reload every Hub in the house on a schedule.
    await withDevice({ running: true }, async (mock, address) => {
      const outcome = await deviceFor(address).show(URL_A);
      assert.equal(outcome, 'already-showing');
      assert.equal(mock.launches, 0);
      assert.deepEqual(mock.loads, []);
    });
  });

  test('force re-sends the URL without relaunching', async () => {
    // Relaunching would blank the screen; DashCast will reload in place.
    await withDevice({ running: true }, async (mock, address) => {
      const outcome = await deviceFor(address).show(URL_A, true);
      assert.equal(outcome, 'cast');
      assert.equal(mock.launches, 0, 'no relaunch');
      assert.equal(mock.loads.length, 1);
    });
  });

  test('waits for the receiver to register its channel', async () => {
    // A URL sent before DashCast has its channel is dropped silently by a
    // real device, leaving a blank screen and no error anywhere.
    await withDevice({ readyAfter: 3 }, async (mock, address) => {
      const outcome = await deviceFor(address).show(URL_A);
      assert.equal(outcome, 'cast');
      assert.deepEqual(
        mock.loads.map((l) => l.url),
        [URL_A],
        'the URL must arrive after the channel exists, not before',
      );
    });
  });

  test('answers the heartbeat so a slow launch is not hung up on', async () => {
    await withDevice({ readyAfter: 2, ping: true }, async (mock, address) => {
      await deviceFor(address).show(URL_A);
      assert.equal(mock.pongs, 1);
    });
  });

  test('reports a refused launch rather than hanging', async () => {
    await withDevice({ refuseLaunch: true }, async (_mock, address) => {
      await assert.rejects(
        deviceFor(address, { timeoutMs: 4000 }).show(URL_A),
        /refused to launch DashCast \(NOT_AVAILABLE\)/,
      );
    });
  });

  test('gives up on a display that is switched off', async () => {
    // Nothing is listening: connecting must fail quickly and by name, because
    // this is the single most common "failure" and it is not really one.
    const device = new CastDevice({
      host: '127.0.0.1',
      port: 1, // reserved, and nothing binds it
      transport: plainTransport,
      timeoutMs: 3000,
    });
    await assert.rejects(device.show(URL_A));
  });

  test('gives up on a connection that never completes', async () => {
    // The dangerous shape: not a refusal, but a host that accepts TCP and
    // then never finishes the handshake. Unbounded, this leaves the keeper's
    // sweep in progress forever and it silently stops checking anything.
    const device = new CastDevice({
      host: '192.0.2.1',
      timeoutMs: 400,
      transport: () => new Promise(() => {}),
    });
    await assert.rejects(device.show(URL_A), /timed out connecting/);
  });

  test('gives up on a device that connects and then says nothing', async () => {
    await withDevice({ mute: true }, async (_mock, address) => {
      await assert.rejects(
        deviceFor(address, { timeoutMs: 500 }).show(URL_A),
        /timed out waiting for GET_STATUS/,
      );
    });
  });

  test('re-casts after something else takes the screen', async () => {
    await withDevice({}, async (mock, address) => {
      assert.equal(await deviceFor(address).show(URL_A), 'cast');
      assert.equal(await deviceFor(address).show(URL_A), 'already-showing');

      mock.interrupt(); // a timer, a voice answer, a reboot
      assert.equal(await deviceFor(address).show(URL_A), 'cast');
      assert.equal(mock.launches, 2);
    });
  });

  test('addresses the app transport, not the platform receiver', async () => {
    await withDevice({}, async (mock, address) => {
      await deviceFor(address).show(URL_A);
      const load = mock.received.find((f) => f.namespace === 'urn:x-cast:com.madmod.dashcast');
      assert.equal(load.destination, 'web-9');
      const launch = mock.received.find((f) => f.payload.includes('LAUNCH'));
      assert.equal(launch.destination, 'receiver-0');
      assert.ok(launch.payload.includes(DASHCAST_APP_ID));
    });
  });
});

describe('the keeper', () => {
  const config = (cast) => ({
    getConfig: () => ({
      cast: {
        baseUrl: 'http://192.168.1.71:8099',
        displays: [],
        checkSeconds: 300,
        panes: ['clock'],
        rotateSeconds: 30,
        followMusic: true,
        audioKeepAlive: false,
        ...cast,
      },
    }),
    token: '',
    transport: plainTransport,
  });

  test('visits every configured display', async () => {
    await withDevice({}, async (kitchen, kitchenAddress) => {
      await withDevice({}, async (hall, hallAddress) => {
        const keeper = new CastKeeper(
          config({
            displays: [
              { host: kitchenAddress, name: 'Kitchen', pane: 'dashboard' },
              { host: hallAddress, name: 'Hall', pane: 'clock' },
            ],
          }),
        );
        const results = await keeper.sweep();
        assert.deepEqual(
          results.map((r) => `${r.display}:${r.outcome}`),
          ['Kitchen:cast', 'Hall:cast'],
        );
        assert.match(kitchen.loads[0].url, /\?cast=1&pane=dashboard$/);
        assert.match(hall.loads[0].url, /\?cast=1&pane=clock$/);
      });
    });
  });

  test('one unreachable display does not stop the others', async () => {
    await withDevice({}, async (kitchen, kitchenAddress) => {
      const keeper = new CastKeeper(
        config({
          displays: [
            { host: '127.0.0.1:1', name: 'Broken' },
            { host: kitchenAddress, name: 'Kitchen' },
          ],
        }),
      );
      const results = await keeper.sweep();
      assert.equal(results[0].outcome, 'failed');
      assert.equal(results[1].outcome, 'cast');
      assert.equal(kitchen.loads.length, 1);
    });
  });

  test('does nothing at all without a base URL', async () => {
    await withDevice({}, async (mock, address) => {
      const keeper = new CastKeeper(config({ baseUrl: '  ', displays: [{ host: address }] }));
      assert.deepEqual(await keeper.sweep(), []);
      assert.equal(mock.launches, 0);
    });
  });

  describe('the URL a display is given', () => {
    const url = (cast, display) => {
      const deps = config(cast);
      return new CastKeeper(deps).urlFor(display, deps.getConfig().cast);
    };

    test('omits the pane entirely when none is set', () => {
      // Not `&pane=`: the panel reads an empty pane as a pane, and falls out
      // of the configured rotation.
      assert.equal(url({}, { host: 'x' }), 'http://192.168.1.71:8099/?cast=1');
    });

    test('appends the panel token when auth is on', () => {
      const deps = { ...config({}), token: 'sec ret&' };
      const keeper = new CastKeeper(deps);
      assert.equal(
        keeper.urlFor({ host: 'x', pane: 'media' }, deps.getConfig().cast),
        'http://192.168.1.71:8099/?cast=1&pane=media&t=sec+ret%26',
      );
    });

    test('carries the display\'s panel id, so two Hubs differ', () => {
      // Without this every display resolves to the same settings block, and
      // changing the kitchen changes the bedroom.
      assert.equal(
        url({}, { host: 'x', pane: 'dashboard', panel: 'kitchen' }),
        'http://192.168.1.71:8099/?cast=1&pane=dashboard&panel=kitchen',
      );
    });

    test('omits it entirely when a display has none', () => {
      assert.equal(url({}, { host: 'x', pane: 'dashboard' }), 'http://192.168.1.71:8099/?cast=1&pane=dashboard');
    });

    test('tolerates a trailing slash on the base URL', () => {
      assert.equal(
        url({ baseUrl: 'http://192.168.1.71:8099///' }, { host: 'x' }),
        'http://192.168.1.71:8099/?cast=1',
      );
    });
  });

  /**
   * The wiring, in the real process: YAML → config → a keeper that dials.
   *
   * This is deliberately not an end-to-end cast. The real backend uses TLS,
   * and a mock device would need a certificate committed to the repository to
   * complete a handshake — for a connection that verifies nothing anyway (see
   * device.ts). So the mock is used purely as something that answers on a
   * port, and what is asserted is that the running server parsed the display
   * list and connected to the right address on its own.
   */
  test('a configured display is dialled by the real server process', async () => {
    const mock = new MockCastDevice({});
    const address = await mock.start();
    const dir = await mkdtemp(join(tmpdir(), 'navigator-cast-'));
    const configPath = join(dir, 'dashboard.yaml');
    const port = await freePort();

    await writeFile(
      configPath,
      [
        'version: 1',
        'cast:',
        `  baseUrl: http://127.0.0.1:${port}`,
        '  checkSeconds: 1',
        '  displays:',
        `    - host: ${address}`,
        '      name: Kitchen',
        '      pane: dashboard',
        '      panel: kitchen',
      ].join('\n'),
    );

    const backend = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        PANEL_TOKEN: 'panel-token',
        CONFIG_PATH: configPath,
        HA_URL: '',
        HA_TOKEN: '',
        IMMICH_URL: '',
        IMMICH_API_KEY: '',
        LOG_LEVEL: 'error',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      const config = await waitFor(async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
          headers: { authorization: 'Bearer panel-token' },
        }).catch(() => null);
        return res?.ok ? res.json() : null;
      }, 'the backend to serve its config');

      assert.deepEqual(config.cast.displays, [
        { host: address, name: 'Kitchen', panel: 'kitchen', pane: 'dashboard' },
      ]);
      assert.equal(config.cast.baseUrl, `http://127.0.0.1:${port}`);
      // Unwritten in the YAML above: a cast dashboard screensaves by default,
      // because a wall display that never dims is the surprising one.
      assert.equal(config.cast.screensaver, true);

      // A connection is the whole assertion: the TLS handshake will not
      // complete against a plain socket, and completing it is not what this
      // test is about.
      await waitFor(
        async () => mock.connections > 0,
        'the keeper to connect to the configured display',
      );
    } finally {
      backend.kill('SIGKILL');
      await mock.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('addresses', () => {
    test('defaults to the Cast port', () => {
      assert.deepEqual(splitHost('192.168.1.42'), { host: '192.168.1.42', port: 8009 });
    });

    test('accepts an explicit port', () => {
      assert.deepEqual(splitHost('192.168.1.42:9000'), { host: '192.168.1.42', port: 9000 });
    });

    test('does not mistake an IPv6 literal for a port', () => {
      assert.deepEqual(splitHost('fd00::1'), { host: 'fd00::1', port: 8009 });
      assert.deepEqual(splitHost('[fd00::1]:9000'), { host: 'fd00::1', port: 9000 });
    });
  });
});
