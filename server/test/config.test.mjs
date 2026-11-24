import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigStore } from '../dist/testkit.js';

test('an SSH host can be offered to Plex as an IINA or Infuse Mac, and is not by default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navigator-config-'));
  const path = join(dir, 'dashboard.yaml');
  await writeFile(path, `
version: 1
controls:
  ssh:
    - id: mac_studio
      host: 192.168.1.200
      username: spencer
      name: Mac Studio
      iina: true
      infuse: true
      screens:
        - { name: Studio Display, x: 0, y: 0 }
        - { name: LG TV, x: 2560, y: -200 }
        - { name: No position }
    - { id: build_box, host: 192.168.1.201, username: ci }
`, 'utf8');

  const config = new ConfigStore(path);
  try {
    assert.equal(await config.load(), true);
    assert.deepEqual(config.current.controls.ssh, [
      {
        id: 'mac_studio', host: '192.168.1.200', username: 'spencer', name: 'Mac Studio', iina: true, infuse: true,
        // A display without a position cannot be moved to, so it is dropped.
        screens: [{ name: 'Studio Display', x: 0, y: 0 }, { name: 'LG TV', x: 2560, y: -200 }],
      },
      { id: 'build_box', host: '192.168.1.201', username: 'ci', name: 'build_box', iina: false, infuse: false, screens: [] },
    ]);
  } finally {
    config.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Apple TV app shortcuts are normalized and allow-listed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navigator-config-'));
  const path = join(dir, 'dashboard.yaml');
  await writeFile(path, `
version: 1
controls:
  appleTvs:
    - id: office
      name: Office Apple TV
      host: 192.168.1.80
      shortcuts:
        - { name: Plex, app: com.plexapp.plex }
        - { name: YouTube, bundleId: com.google.ios.youtube }
        - { name: Duplicate, app: com.plexapp.plex }
        - { name: Unsafe, app: https://example.com }
`, 'utf8');

  const config = new ConfigStore(path);
  try {
    assert.equal(await config.load(), true);
    assert.deepEqual(config.current.controls.appleTvs[0].shortcuts, [
      { name: 'Plex', bundleId: 'com.plexapp.plex' },
      { name: 'YouTube', bundleId: 'com.google.ios.youtube' },
    ]);
  } finally {
    config.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('switching a RoomOS device off in Settings takes it off every page, and back on restores it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navigator-config-'));
  const path = join(dir, 'dashboard.yaml');
  await writeFile(path, `
version: 1
controls:
  roomos:
    - { id: desk_pro, name: Desk Pro, host: 192.168.1.50, username: panel }
  tvs:
    - { id: office_lg, host: 192.168.1.67 }
  pages:
    - id: deskpro
      name: Desk Pro
      items:
        - device: { name: Desk Pro, prefix: desk_pro }
        - { volume: desk_pro, name: Volume }
        - { name: Wake, roomos: desk_pro, command: Standby Deactivate }
    - id: office
      name: Office
      items:
        - name: Office Power
          actions:
            - { roomos: desk_pro, command: Standby Deactivate }
            - { tv: office_lg, action: on }
        - { name: Share, roomos: desk_pro, action: next }
    - { id: empty, name: Empty }
`, 'utf8');

  const config = new ConfigStore(path);
  try {
    assert.equal(await config.load(), true);
    const on = config.current;
    assert.equal(on.controls.roomos[0].enabled, true);
    // The tile is linked to the device through its prefix.
    assert.equal(on.controls.pages[0].items[0].roomos, 'desk_pro');
    assert.deepEqual(on.controls.pages.map((p) => p.id), ['deskpro', 'office', 'empty']);

    let pushed = null;
    config.onChange((cfg) => { pushed = cfg; });
    assert.equal(config.setDeviceEnabled('desk_pro', false), null);

    const off = config.current;
    assert.equal(pushed, off, 'listeners hear about the switch');
    assert.equal(off.controls.roomos[0].enabled, false, 'the device stays listed, so it can be switched back');
    // The Desk Pro page had nothing else on it, so it goes; the empty page
    // was empty in the YAML and stays.
    assert.deepEqual(off.controls.pages.map((p) => p.id), ['office', 'empty']);
    const office = off.controls.pages[0].items;
    assert.equal(office.length, 1, 'a key that only drove the Desk Pro is gone');
    assert.deepEqual(office[0].actions, [{ kind: 'tv', tv: 'office_lg', op: 'on' }],
      'a multi-device key keeps its other steps');

    // Persisted beside the YAML, and read back by a fresh store.
    const saved = JSON.parse(await readFile(join(dir, 'device-switches.json'), 'utf8'));
    assert.deepEqual(saved.roomos, { desk_pro: false });
    const again = new ConfigStore(path);
    assert.equal(await again.load(), true);
    assert.equal(again.current.controls.roomos[0].enabled, false);
    assert.deepEqual(again.current.controls.pages.map((p) => p.id), ['office', 'empty']);
    again.close();

    assert.equal(config.setDeviceEnabled('desk_pro', true), null);
    assert.deepEqual(config.current.controls.pages, on.controls.pages);
    assert.equal(config.setDeviceEnabled('nope', false), 'Unknown device');
  } finally {
    config.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('enabled: false in dashboard.yaml starts a RoomOS device off, and Settings can still turn it on', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navigator-config-'));
  const path = join(dir, 'dashboard.yaml');
  await writeFile(path, `
version: 1
controls:
  roomos:
    - { id: desk_pro, host: 192.168.1.50, enabled: false }
  pages:
    - id: p
      name: P
      items:
        - { volume: desk_pro }
        - device: { name: Bar, prefix: room_bar }
`, 'utf8');

  const config = new ConfigStore(path);
  try {
    assert.equal(await config.load(), true);
    assert.equal(config.current.controls.roomos[0].enabled, false);
    const items = config.current.controls.pages[0].items;
    assert.equal(items.length, 1, 'the volume card is gone');
    // A prefix that names no device is not a link.
    assert.equal(items[0].type, 'device');
    assert.equal(items[0].roomos, undefined);

    config.setDeviceEnabled('desk_pro', true);
    assert.equal(config.current.controls.roomos[0].enabled, true);
    assert.equal(config.current.controls.pages[0].items.length, 2);
  } finally {
    config.close();
    await rm(dir, { recursive: true, force: true });
  }
});
