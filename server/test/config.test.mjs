import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigStore } from '../dist/testkit.js';

test('an SSH host can be offered to Plex as an IINA Mac, and is not by default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navigator-config-'));
  const path = join(dir, 'dashboard.yaml');
  await writeFile(path, `
version: 1
controls:
  ssh:
    - { id: mac_studio, host: 192.168.1.200, username: spencer, name: Mac Studio, iina: true }
    - { id: build_box, host: 192.168.1.201, username: ci }
`, 'utf8');

  const config = new ConfigStore(path);
  try {
    assert.equal(await config.load(), true);
    assert.deepEqual(config.current.controls.ssh, [
      { id: 'mac_studio', host: '192.168.1.200', username: 'spencer', name: 'Mac Studio', iina: true },
      { id: 'build_box', host: '192.168.1.201', username: 'ci', name: 'build_box', iina: false },
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
