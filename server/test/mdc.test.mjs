import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockMdc } from './mock-mdc.mjs';

/*
 * The Samsung display, over MDC, with no Home Assistant in between.
 *
 * What this protects: the power toggle and volume slider on the Controls
 * screen reflect what the DISPLAY says — read back after every command — and
 * the frames on the wire are the ones a Samsung set accepts.
 */
const { MdcClient, mdcEncode, mdcDecode, mdcSourceName, Controls, ConfigStore } = await import(
  '../dist/testkit.js'
);

const PORT = 19870;
let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mdc-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function waitFor(check, what, timeoutMs = 4000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) assert.fail(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('MDC framing', () => {
  test('encodes the documented frames', () => {
    assert.deepEqual([...mdcEncode(0x11, 0)], [0xaa, 0x11, 0x00, 0x00, 0x11]);
    assert.deepEqual([...mdcEncode(0x11, 0, [1])], [0xaa, 0x11, 0x00, 0x01, 0x01, 0x13]);
    assert.deepEqual([...mdcEncode(0x12, 1, [30])], [0xaa, 0x12, 0x01, 0x01, 0x1e, 0x32]);
  });

  test('decodes an ACK, skips leading noise, and rejects a bad checksum', () => {
    const frame = Buffer.from([0x00, 0xaa, 0xff, 0x00, 0x03, 0x41, 0x11, 0x01, 0x55]);
    const out = mdcDecode(frame);
    assert.deepEqual(out.reply, { ack: true, cmd: 0x11, data: [1] });
    assert.equal(out.used, frame.length);
    assert.equal(mdcDecode(frame.subarray(0, 6)), null);
    const bad = Buffer.from([0xaa, 0xff, 0x00, 0x03, 0x41, 0x11, 0x01, 0x00]);
    assert.throws(() => mdcDecode(bad), /checksum/);
  });

  test('accepts the input names people actually write', () => {
    assert.equal(mdcSourceName('HDMI 1'), 'HDMI1');
    assert.equal(mdcSourceName('hdmi2'), 'HDMI2');
    assert.equal(mdcSourceName('DisplayPort 1'), 'DISPLAY_PORT_1');
    assert.equal(mdcSourceName('0x23'), 'HDMI2');
    assert.equal(mdcSourceName('Laptop'), null);
  });
});

describe('MdcClient', () => {
  test('reads status, powers on, sets volume and mute, switches input', async () => {
    const display = new MockMdc(PORT);
    await display.start();
    const client = new MdcClient({ id: 'room', host: `127.0.0.1:${PORT}`, displayId: 0 });
    try {
      await client.refresh();
      assert.deepEqual(client.state, {
        id: 'room', reachable: true, power: false, volume: 12, muted: false, input: 'HDMI1',
      });
      assert.equal(await client.isOn(), false);

      assert.equal(await client.turnOn(), null);
      assert.equal(display.state.power, 1);
      assert.equal(await client.setVolume(37.4), null);
      assert.equal(display.state.volume, 37);
      assert.equal(await client.setMute(true), null);
      assert.equal(display.state.mute, 1);
      assert.equal(await client.setInput('HDMI 2'), null);
      assert.equal(display.state.input, 0x23);

      await client.refresh();
      assert.deepEqual(client.state, {
        id: 'room', reachable: true, power: true, volume: 37, muted: true, input: 'HDMI2',
      });

      assert.equal(await client.turnOff(), null);
      assert.equal(display.state.power, 0);
      // In standby the set refuses volume; say so plainly.
      assert.equal(await client.setVolume(10), 'Display is off');
      // Several commands, one connection.
      assert.equal(display.connections, 1);
    } finally {
      client.stop();
      await display.stop();
    }
  });

  test('falls back to per-field reads when the status command is refused', async () => {
    const display = new MockMdc(PORT, { statusSupported: false });
    display.state = { power: 1, volume: 55, mute: 0, input: 0x25 };
    await display.start();
    const client = new MdcClient({ id: 'room', host: `127.0.0.1:${PORT}`, displayId: 0 });
    try {
      await client.refresh();
      assert.deepEqual(client.state, {
        id: 'room', reachable: true, power: true, volume: 55, muted: false, input: 'DISPLAY_PORT_1',
      });
    } finally {
      client.stop();
      await display.stop();
    }
  });

  test('a display that is not there is unreachable, not an exception', async () => {
    const client = new MdcClient({ id: 'room', host: '127.0.0.1:19871', displayId: 0 });
    const changed = await client.refresh();
    assert.equal(client.state.reachable, false);
    assert.equal(changed, false);
    assert.match(await client.setVolume(10), /refused|unreachable/i);
    client.stop();
  });

  test('a wrong display ID times out rather than hanging', async () => {
    const display = new MockMdc(PORT, { displayId: 1 });
    await display.start();
    const client = new MdcClient({ id: 'room', host: `127.0.0.1:${PORT}`, displayId: 0 });
    try {
      await client.refresh();
      assert.equal(client.state.reachable, false);
    } finally {
      client.stop();
      await display.stop();
    }
  });

  test('Secure MDC: TLS and PIN, and a clear error with no PIN set', async () => {
    const cert = join(dir, 'cert.pem');
    const key = join(dir, 'key.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert,
      '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1',
    ], { stdio: 'ignore' });
    const display = new MockMdc(PORT, { pin: '0042', cert, key });
    await display.start();
    const secure = new MdcClient({ id: 'room', host: `127.0.0.1:${PORT}`, displayId: 0, pin: '42' });
    const plain = new MdcClient({ id: 'room', host: `127.0.0.1:${PORT}`, displayId: 0 });
    const wrong = new MdcClient({ id: 'room', host: `127.0.0.1:${PORT}`, displayId: 0, pin: '9999' });
    try {
      await secure.refresh();
      assert.equal(secure.state.reachable, true);
      assert.equal(await secure.turnOn(), null);
      assert.equal(display.state.power, 1);

      assert.match(await plain.setVolume(5), /Secure MDC/);
      assert.match(await wrong.setVolume(5), /PIN/);
    } finally {
      secure.stop();
      plain.stop();
      wrong.stop();
      await display.stop();
    }
  });
});

describe('Controls with a Samsung display', () => {
  test('config, the display card, and key actions', async () => {
    const display = new MockMdc(PORT);
    await display.start();
    const path = join(dir, 'dashboard.yaml');
    await writeFile(path, `
version: 1
controls:
  pollSeconds: 0
  displays:
    - id: room_samsung
      name: Samsung
      host: 127.0.0.1:${PORT}
      pin: "1234"
      inputs:
        - { source: HDMI1, name: Room Kit }
        - { source: HDMI 2, name: Laptop }
  pages:
    - id: room
      name: Room
      items:
        - { id: tv, display: room_samsung, name: Samsung TV }
        - { id: power, name: Power, display: room_samsung, action: toggle }
        - { id: next, name: Input, display: room_samsung, action: next }
        - id: all_on
          name: Room On
          actions:
            - { display: room_samsung, action: on }
            - { display: room_samsung, action: volume, value: 25 }
`);
    const config = new ConfigStore(path);
    assert.equal(await config.load(), true);

    const cfg = config.current.controls;
    assert.deepEqual(cfg.displays, [{
      id: 'room_samsung', name: 'Samsung', host: `127.0.0.1:${PORT}`, displayId: 0,
      inputs: [{ source: 'HDMI1', name: 'Room Kit' }, { source: 'HDMI 2', name: 'Laptop' }],
    }]);
    const items = cfg.pages[0].items;
    assert.deepEqual(items[0], { type: 'display', id: 'tv', display: 'room_samsung', name: 'Samsung TV' });
    assert.equal(items[1].type, 'button');
    assert.deepEqual(items[1].actions, [{ kind: 'display', display: 'room_samsung', op: 'toggle' }]);
    assert.deepEqual(items[3].actions[1], { kind: 'display', display: 'room_samsung', op: 'volume', value: 25 });

    const pushes = [];
    const controls = new Controls({
      getConfig: () => config.current,
      haUrl: '',
      callService: async () => null,
      getEntity: () => null,
      onLights: () => {},
      onTvs: () => {},
      onRoomos: () => {},
      onDisplays: (d) => pushes.push(d),
      mdcPin: () => '',
      roomosPassword: () => '',
      appleTvCommand: async () => null,
      sshCredential: async () => ({}),
      sshKnownHostsFile: join(dir, 'ssh-known-hosts.json'),
      hasPanels: () => false,
      tvKeyFile: join(dir, 'tv-keys.json'),
    });
    try {
      await waitFor(() => controls.displaySnapshot()[0]?.reachable, 'first read');
      assert.equal(controls.displaySnapshot()[0].power, false);

      // The card's power and volume.
      assert.equal(await controls.displayControl('tv', 'on'), null);
      assert.equal(display.state.power, 1);
      assert.equal(await controls.displayControl('tv', 'level', 140), null);
      assert.equal(display.state.volume, 100);
      assert.equal(await controls.displayControl('tv', 'mute'), null);
      assert.equal(display.state.mute, 1);
      await waitFor(() => controls.displaySnapshot()[0].muted === true, 'mute read back');
      assert.ok(pushes.length > 0);

      // Only a display item can be driven as one.
      assert.equal(await controls.displayControl('power', 'on'), 'Unknown control');

      // Keys: toggle reads the state and goes the other way; next cycles.
      assert.equal(await controls.press('next'), null);
      assert.equal(display.state.input, 0x23);
      assert.equal(await controls.press('next'), null);
      assert.equal(display.state.input, 0x21);
      assert.equal(await controls.press('power'), null);
      assert.equal(display.state.power, 0);
      assert.equal(await controls.press('all_on'), null);
      assert.equal(display.state.power, 1);
      assert.equal(display.state.volume, 25);
    } finally {
      controls.stop();
      config.close();
      await display.stop();
    }
  });
});
