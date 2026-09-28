import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockRoomos } from './mock-roomos.mjs';

/*
 * The Desk Pro's presentation, driven over its own xAPI instead of Companion.
 *
 * What this protects: the key's idea of "current input" comes from the
 * DEVICE, so it follows a laptop plugged in or a source picked on the Desk
 * Pro's own screen — the thing a Companion key could never know.
 */
const { RoomosClient, Controls, ConfigStore } = await import('../dist/testkit.js');

const PORT = 19830;
let device;
let dir;

async function waitFor(check, what, timeoutMs = 4000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) assert.fail(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'roomos-'));
  const cert = join(dir, 'cert.pem');
  const key = join(dir, 'key.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert,
    '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1',
  ], { stdio: 'ignore' });
  device = new MockRoomos(PORT, { cert, key });
  await device.start();
});

after(async () => {
  await device?.stop();
  await rm(dir, { recursive: true, force: true });
});

function client(opts = {}) {
  return new RoomosClient({
    id: 'desk_pro',
    host: `127.0.0.1:${PORT}`,
    username: 'panel',
    password: 'secret',
    ...opts,
  });
}

describe('RoomosClient', () => {
  test('reads what is presented on connect, mapping source ids to connectors', async () => {
    device.presentLocally(3);
    const c = client();
    c.start();
    try {
      const state = await waitFor(() => c.state.reachable && c.state, 'connected');
      assert.equal(state.connector, 3);
      // The camera is not an input anybody switches to.
      assert.deepEqual(state.connectors, [
        { id: 2, type: 'HDMI', connected: true },
        { id: 3, type: 'USB-C', connected: true },
      ]);
    } finally {
      c.stop();
    }
  });

  test('follows a change made on the device itself', async () => {
    device.presentLocally(2);
    const c = client();
    let changes = 0;
    c.onChange(() => changes++);
    c.start();
    try {
      await waitFor(() => c.connector === 2, 'HDMI presented');
      device.presentLocally(3);
      await waitFor(() => c.connector === 3, 'switch to USB-C noticed');
      // A ghost entry is how RoomOS says the instance is gone.
      device.stopLocally();
      await waitFor(() => c.connector === null, 'stop noticed');
      assert.ok(changes >= 3);
    } finally {
      c.stop();
    }
  });

  test('switching replaces the instance and keeps sharing into the call', async () => {
    device.presentLocally(2, 'LocalRemote');
    device.commands.length = 0;
    const c = client();
    c.start();
    try {
      await waitFor(() => c.connector === 2, 'HDMI presented');
      assert.equal(await c.present(3), null);
      assert.deepEqual(device.commands.at(-1), {
        path: 'Presentation/Start',
        params: { ConnectorId: 3, SendingMode: 'LocalRemote', Instance: 1 },
      });
      await waitFor(() => c.connector === 3, 'USB-C presented');
    } finally {
      c.stop();
    }
  });

  test('starting from nothing never shares into a call', async () => {
    device.stopLocally();
    device.commands.length = 0;
    const c = client();
    c.start();
    try {
      await waitFor(() => c.state.reachable, 'connected');
      assert.equal(await c.present(2), null);
      assert.deepEqual(device.commands.at(-1).params, { ConnectorId: 2, SendingMode: 'LocalOnly' });
    } finally {
      c.stop();
    }
  });

  test('software without Instance gets a plain start', async () => {
    device.presentLocally(2);
    device.rejectInstance = true;
    device.commands.length = 0;
    const c = client();
    c.start();
    try {
      await waitFor(() => c.connector === 2, 'HDMI presented');
      assert.equal(await c.present(3), null);
      assert.equal(device.commands.length, 2);
      assert.equal('Instance' in device.commands[1].params, false);
    } finally {
      device.rejectInstance = false;
      c.stop();
    }
  });

  test('a wrong password is unreachable, not a crash', async () => {
    const c = client({ password: 'wrong' });
    c.start();
    try {
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(c.state.reachable, false);
      assert.equal(c.state.connector, null);
      assert.match(await c.present(2), /not connected/);
    } finally {
      c.stop();
    }
  });
});

describe('a Presentation key', () => {
  async function controlsWith(yaml) {
    const path = join(dir, `dashboard-${Math.random().toString(36).slice(2)}.yaml`);
    await writeFile(path, yaml);
    const config = new ConfigStore(path);
    assert.equal(await config.load(), true);
    const pushes = [];
    const controls = new Controls({
      getConfig: () => config.current,
      companionUrl: '',
      haUrl: '',
      callService: async () => null,
      getEntity: () => null,
      onLights: () => {},
      onTvs: () => {},
      onRoomos: (devices) => pushes.push(devices),
      roomosPassword: (id) => (id === 'desk_pro' ? 'secret' : ''),
      hasPanels: () => false,
      tvKeyFile: join(dir, 'tv-keys.json'),
    });
    return { config, controls, pushes };
  }

  const YAML = `
version: 1
controls:
  pollSeconds: 0
  roomos:
    - id: desk_pro
      name: Desk Pro
      host: 127.0.0.1:${PORT}
      username: panel
      inputs:
        - { connector: 2, name: HDMI }
        - { connector: 3, name: USB-C }
  pages:
    - id: desk
      name: Desk
      items:
        - { id: present, name: Presentation, roomos: desk_pro, action: next }
        - { id: stop, name: Stop, roomos: desk_pro, action: stop }
`;

  test('parses, and keeps the password out of the config', async () => {
    const { config, controls } = await controlsWith(YAML);
    try {
      assert.deepEqual(config.current.controls.roomos, [
        {
          id: 'desk_pro',
          name: 'Desk Pro',
          host: `127.0.0.1:${PORT}`,
          username: 'panel',
          inputs: [
            { connector: 2, name: 'HDMI' },
            { connector: 3, name: 'USB-C' },
          ],
        },
      ]);
      const [key] = config.current.controls.pages[0].items;
      assert.deepEqual(key.actions, [{ kind: 'roomos', device: 'desk_pro', op: 'next' }]);
      assert.equal(JSON.stringify(config.current).includes('secret'), false);
    } finally {
      controls.stop();
      config.close();
    }
  });

  test('steps from what the device is showing, not from its own last press', async () => {
    device.presentLocally(2);
    const { config, controls, pushes } = await controlsWith(YAML);
    try {
      await waitFor(() => pushes.at(-1)?.[0]?.connector === 2, 'HDMI reported');

      assert.equal(await controls.press('present'), null);
      await waitFor(() => pushes.at(-1)?.[0]?.connector === 3, 'USB-C after one press');

      // Somebody switches back on the Desk Pro itself. The next press must
      // go to USB-C again — a key counting its own presses would go to HDMI.
      device.presentLocally(2);
      await waitFor(() => pushes.at(-1)?.[0]?.connector === 2, 'device-side change pushed');
      assert.equal(await controls.press('present'), null);
      await waitFor(() => pushes.at(-1)?.[0]?.connector === 3, 'USB-C again');

      assert.equal(await controls.press('stop'), null);
      await waitFor(() => pushes.at(-1)?.[0]?.connector === null, 'stopped');

      // From nothing, the first configured input.
      assert.equal(await controls.press('present'), null);
      await waitFor(() => pushes.at(-1)?.[0]?.connector === 2, 'HDMI from nothing');
    } finally {
      controls.stop();
      config.close();
    }
  });

  test('skips an input with nothing plugged in', async () => {
    device.presentLocally(3);
    device.connectors = device.connectors.map((c) => (c.id === 2 ? { ...c, Connected: 'False' } : c));
    const { config, controls, pushes } = await controlsWith(YAML);
    try {
      await waitFor(() => pushes.at(-1)?.[0]?.connector === 3, 'USB-C reported');
      device.commands.length = 0;
      assert.equal(await controls.press('present'), null);
      // HDMI is empty and USB-C is already up: nothing to do.
      assert.equal(device.commands.length, 0);
    } finally {
      device.connectors = device.connectors.map((c) => ({ ...c, Connected: 'True' }));
      controls.stop();
      config.close();
    }
  });
});
