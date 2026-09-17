import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { BridgeHarness } from './apple-tv-bridge.mjs';

/**
 * End-to-end tests for the Apple TV bridge, in the style of bridge.test.mjs:
 * the real `bridge.py` as a subprocess, speaking its real NDJSON protocol,
 * with a fake pyatv underneath (server/test/fake-pyatv).
 *
 * The suite exists for one failure in particular. A tvOS update invalidates
 * the stored pairing and changes which Companion commands the device answers,
 * and pyatv reports both by raising exceptions whose str() is empty
 * (AuthenticationError, asyncio.TimeoutError, ConnectionResetError). Everything
 * below is about what the panel is told when that happens, and whether the
 * bridge can get itself back.
 *
 *   node --test server/test/apple-tv-bridge.test.mjs
 */

let harness;

afterEach(() => {
  harness?.stop();
  harness = undefined;
});

function start(settings = {}, env = {}) {
  harness = new BridgeHarness(env);
  harness.control(settings);
  return harness.start();
}

describe('Apple TV bridge', () => {
  it('presses a button on a healthy device', async () => {
    const bridge = start();
    await bridge.configure();

    const reply = await bridge.send({ t: 'command', device: 'living-room', op: 'select' });

    assert.equal(reply.ok, true);
    assert.ok(bridge.calls.some((call) => call.event === 'command' && call.op === 'select'));
  });

  it('names the failure when the device rejects the stored pairing', async () => {
    // What a tvOS upgrade looks like from here: the credentials are still on
    // disk, the device still answers a scan, but it refuses to act on them.
    // pyatv signals that with AuthenticationError(), whose str() is ''.
    const bridge = start({ command: 'auth' });
    await bridge.configure();

    const reply = await bridge.send({ t: 'command', device: 'living-room', op: 'select' });

    assert.equal(reply.ok, false);
    assert.ok(reply.error, 'the bridge must not report a failure with an empty message');
    assert.match(reply.error, /pair/i, `expected a re-pairing hint, got ${JSON.stringify(reply.error)}`);
  });

  it('asks the panel to pair again after the device rejects the stored pairing', async () => {
    const bridge = start({ command: 'auth' });
    await bridge.configure();
    await bridge.send({ t: 'command', device: 'living-room', op: 'select' });

    const state = await bridge.untilState((s) => s.paired === false);
    assert.equal(state.paired, false, 'a device that refuses its credentials is not paired');
  });

  it('gives up on a command the device silently drops', async () => {
    // tvOS 26/27 answer the session handshake and then drop some Companion
    // commands on the floor. pyatv's own call never returns.
    const bridge = start({ command: 'hang' });
    await bridge.configure();

    const reply = await bridge.send({ t: 'command', device: 'living-room', op: 'select' }, 30_000);

    assert.equal(reply.ok, false);
    assert.ok(reply.error, 'a dropped command must not report an empty message');
    assert.match(reply.error, /not answer|timed out|respond/i);
  });

  it('keeps answering while an earlier command is still hanging', async () => {
    // The regression that makes every button look broken: one command that
    // never returns must not stall the ones behind it in the queue.
    const bridge = start({ command: 'hang' });
    await bridge.configure();

    const stuck = bridge.send({ t: 'command', device: 'living-room', op: 'select' }, 30_000);
    // Only let the device recover once the first press is genuinely stuck,
    // otherwise this races and proves nothing.
    await bridge.untilCall((call) => call.event === 'command' && call.op === 'select');
    bridge.control({ command: 'ok' });

    const second = await bridge.send({ t: 'command', device: 'living-room', op: 'menu' }, 8_000);
    assert.equal(second.ok, true, 'a healthy command must not queue behind a hung one');

    await stuck;
  });

  it('reconnects when the session died without pyatv noticing', async () => {
    // A connection that is gone but never reported: pyatv's listener callback
    // never fires, so the bridge still holds an AppleTV object that cannot do
    // anything. Every press fails until the handle is dropped and remade.
    const bridge = start();
    await bridge.configure();
    await bridge.send({ t: 'command', device: 'living-room', op: 'select' });

    bridge.control({ command: 'reset' });
    const failed = await bridge.send({ t: 'command', device: 'living-room', op: 'select' });
    assert.equal(failed.ok, false);

    bridge.control({ command: 'ok' });
    const recovered = await bridge.send({ t: 'command', device: 'living-room', op: 'select' });
    assert.equal(recovered.ok, true, 'the bridge must recover without being restarted');
  });

  it('does not orphan a connection when a connect times out', async () => {
    // pyatv cleans up its own aiohttp session in a handler guarded by
    // `except Exception`, and a deadline cancels the connect with
    // CancelledError, which is not one. On a set that never finishes
    // connecting the poller retries for as long as the container lives, so a
    // session leaked per attempt is a leak without end.
    const bridge = start({ connect: 'hang' }, { APPLE_TV_CONNECT_TIMEOUT: '1' });
    await bridge.configure();

    // Let the poller make several attempts. At most one session may be open
    // at a time — the connect currently in flight. Anything beyond that is an
    // attempt whose session was never reclaimed, and on this device that
    // repeats for as long as the container runs.
    await bridge.untilCalls((call) => call.event === 'connect', 4, 30_000);
    const open = bridge.leakedSessions;
    assert.ok(open.length <= 1, `${open.length} sessions left open across 4 connect attempts`);
  });

  it('reports a connect failure in words rather than an empty string', async () => {
    const bridge = start({ connect: 'invalid-credentials' });
    await bridge.configure();

    const state = await bridge.untilState((s) => s.reachable === false && s.error);
    assert.ok(state.error, 'an unreachable device must carry a message');
    assert.notEqual(state.error.trim(), '');
  });
});

describe('Apple TV probe', () => {
  it('reports a healthy device as reachable and paired', async () => {
    const bridge = start();
    const { code, out } = await bridge.probe();

    assert.equal(code, 0, out);
    assert.match(out, /Companion: credentials stored/);
    assert.match(out, /Everything answered/);
  });

  it('points at the pairing when credentials are stored but refused', async () => {
    // The shape of a tvOS upgrade: the pairing looks intact on disk, and the
    // device refuses it anyway. Saying only "not reachable" would send someone
    // hunting the network instead of re-pairing.
    const bridge = start({ appList: 'auth' });
    const { code, out } = await bridge.probe();

    assert.equal(code, 1);
    assert.match(out, /remote control \(Companion\) paired/);
    assert.match(out, /FAIL\s+Companion \(app list\)/);
    assert.match(out, /Pair it again/);
  });

  it('says so plainly when nothing answers at the address', async () => {
    const bridge = start({ scanEmpty: true });
    const { code, out } = await bridge.probe('10.0.0.99');

    assert.equal(code, 1);
    assert.match(out, /Nothing answered at 10\.0\.0\.99/);
  });
});

describe('Apple TV AirPlay remote control channel', () => {
  it('keeps the buttons working when the tunnel will not start', async () => {
    // pyatv fails the whole connect — Companion included — when AirPlay's
    // MRP tunnel refuses to set up, so a set that could still take every
    // button press looks completely dead instead.
    const bridge = start({ tunnel: 'fail' });
    await bridge.configure();

    const state = await bridge.untilState((s) => s.reachable === true, 20_000);
    assert.equal(state.reachable, true, 'the connection must come up without the tunnel');

    const reply = await bridge.send({ t: 'command', device: 'living-room', op: 'select' });
    assert.equal(reply.ok, true, 'buttons must work on the reduced connection');
  });

  it('says that now playing is missing rather than showing an empty card', async () => {
    const bridge = start({ tunnel: 'fail' });
    await bridge.configure();

    const state = await bridge.untilState((s) => s.reachable === true, 20_000);
    assert.match(state.error ?? '', /now playing is unavailable/i);
  });

  it('only gives up the tunnel when that is what failed', async () => {
    const bridge = start({ connect: 'reset' });
    await bridge.configure();

    await bridge.untilState((s) => s.reachable === false && s.error, 20_000);
    const tunnels = bridge.calls.filter((c) => c.event === 'connect').map((c) => c.tunnel);
    assert.ok(
      tunnels.every((t) => t !== 'disable'),
      `an unrelated failure must not disable the tunnel; saw ${JSON.stringify(tunnels)}`,
    );
  });
});

describe('Apple TV error reporting', () => {
  it('carries the reason behind a wrapped pyatv error', async () => {
    // "Failed to set up remote control channel" is the same sentence whatever
    // went wrong underneath; the useful half is the __cause__.
    const bridge = start({ tunnel: 'fail' }, { APPLE_TV_MRP_TUNNEL: 'force' });
    await bridge.configure();

    const state = await bridge.untilState((s) => s.reachable === false && s.error, 20_000);
    assert.match(state.error, /remote control channel/i);
    assert.match(state.error, /HttpError/, `the cause must survive; got ${state.error}`);
  });
});

describe('Apple TV network routing', () => {
  it('names the routing problem instead of only the RTSP timeout', async () => {
    // From a container on Docker's bridge network the Apple TV is handed an
    // address it cannot route to, so it never answers the SETUP. The raw
    // timeout sends people hunting pairing and tvOS versions for hours.
    const bridge = start({ tunnel: 'fail', offSubnet: true }, { APPLE_TV_MRP_TUNNEL: 'force' });
    await bridge.configure();

    const state = await bridge.untilState((s) => s.reachable === false && s.error, 20_000);
    assert.match(state.error, /same subnet/i, `got ${state.error}`);
    assert.match(state.error, /network_mode: host/i);
  });

  it('says nothing about routing when the machine is on the right network', async () => {
    const bridge = start({ tunnel: 'fail' }, { APPLE_TV_MRP_TUNNEL: 'force' });
    await bridge.configure();

    const state = await bridge.untilState((s) => s.reachable === false && s.error, 20_000);
    assert.doesNotMatch(state.error, /subnet|network_mode/i, `got ${state.error}`);
  });

  it('leads the probe with it, since nothing else can be trusted until it is fixed', async () => {
    const bridge = start({ offSubnet: true, connect: 'hang' });
    const { code, out } = await bridge.probe();

    assert.equal(code, 1);
    assert.match(out, /FAIL\s+this machine is not on the Apple TV's network/);
    assert.match(out, /Fix the networking first/);
    assert.match(out, /network_mode: host/);
  });
});

describe('Apple TV client identity', () => {
  it('finds the identity a picky device will answer', async () => {
    // A Companion connect opens with _systemInfo, which says who we are. When
    // a device stops answering it, the question is whether it dislikes what we
    // claim to be — and the only way to know is to ask the device.
    const bridge = start({ needsUnicastId: true });
    const { code, out } = await bridge.identities();

    assert.equal(code, 0, out);
    assert.match(out, /FAIL\s+pyatv defaults \(baseline\)/);
    assert.match(out, /OK\s+valid unicast device id/);
    assert.match(out, /APPLE_TV_CLIENT_DEVICE_ID=02:/);
  });

  it('says the identity is not the problem when the defaults already work', async () => {
    const bridge = start();
    const { code, out } = await bridge.identities();

    assert.equal(code, 0, out);
    assert.match(out, /defaults answered, so the identity is not the problem/i);
  });

  it('honours an identity set on the container', async () => {
    const bridge = start(
      { needsUnicastId: true },
      { APPLE_TV_CLIENT_DEVICE_ID: '02:ab:cd:ef:01:02', APPLE_TV_CLIENT_MAC: '02:ab:cd:ef:01:02' },
    );
    await bridge.configure();

    const state = await bridge.untilState((s) => s.reachable === true, 20_000);
    assert.equal(state.reachable, true, 'the override must reach pyatv');
    const ids = bridge.calls.filter((c) => c.event === 'connect').map((c) => c.deviceId);
    assert.ok(ids.includes('02:ab:cd:ef:01:02'), `got ${JSON.stringify(ids)}`);
  });

  it('is stable across restarts, so a paired identity keeps working', async () => {
    const a = start({ needsUnicastId: true });
    const first = await a.identities();
    a.stop();
    const b = start({ needsUnicastId: true });
    const second = await b.identities();

    const mac = (out) => out.match(/APPLE_TV_CLIENT_DEVICE_ID=(\S+)/)?.[1];
    assert.ok(mac(first.out), 'expected a suggested id');
    assert.equal(mac(first.out), mac(second.out), 'the derived id must not change per run');
  });
});
