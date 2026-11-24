import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * A desktop monitor over DDC/CI — the Dell on the Mac Studio, through m1ddc
 * over SSH. What this protects: the card reads the monitor back the way it
 * reads a Samsung, a monitor the Mac cannot find reads as OFF (so power is
 * the button offered) rather than broken, and nothing unsafe reaches a shell.
 */
const { DdcClient, ddcSourceName, ConfigStore } = await import('../dist/testkit.js');

const M = '/opt/homebrew/bin/m1ddc';

/** An m1ddc on a Mac, answering the commands DdcClient sends. */
function fakeMac(initial = {}) {
  const mon = { present: true, installed: true, standby: 1, volume: 30, mute: 2, input: 17, ...initial };
  const commands = [];
  const run = async (host, command) => {
    commands.push({ host, command });
    if (command.includes('|| { echo missing')) {
      if (!mon.installed) return { problem: null, lines: ['missing'] };
      const lines = ['standby', 'volume', 'mute', 'input'].map((c) => {
        if (!mon.present) return `${c}=`;
        // A Dell reporting a flag in the high byte of the input.
        return `${c}=${c === 'input' ? mon.input | 0x0f00 : mon[c]}`;
      });
      return { problem: null, lines };
    }
    if (command.includes('caffeinate -u')) {
      mon.present = true;
      mon.standby = 1;
      return { problem: null, lines: [] };
    }
    const set = /set (standby|volume|mute|input) (\w+)/.exec(command);
    if (!set) return { problem: 'unexpected command', lines: [] };
    if (!mon.present) return { problem: 'mac_studio: command exited 1', lines: ['Could not find a suitable display'] };
    const [, what, value] = set;
    if (what === 'mute') mon.mute = value === 'on' ? 1 : 2;
    else mon[what] = Number(value);
    if (what === 'standby' && Number(value) !== 1) mon.present = false;
    return { problem: null, lines: [] };
  };
  return { mon, commands, run };
}

function client(mac, extra = {}) {
  return new DdcClient({ id: 'dell', ssh: 'mac_studio', m1ddc: M, standby: 4, run: mac.run, settleMs: 0, ...extra });
}

describe('DDC input names', () => {
  test('accepts the names people write, and numbers', () => {
    assert.equal(ddcSourceName('HDMI 1'), 'HDMI1');
    assert.equal(ddcSourceName('USB-C'), 'USB_C');
    assert.equal(ddcSourceName('usbc'), 'USB_C');
    assert.equal(ddcSourceName('DisplayPort 1'), 'DISPLAY_PORT_1');
    assert.equal(ddcSourceName('27'), 'USB_C');
    assert.equal(ddcSourceName('40'), 'INPUT_40');
    assert.equal(ddcSourceName('nonsense'), null);
  });
});

describe('DdcClient', () => {
  test('reads power, volume, mute and input in one SSH session', async () => {
    const mac = fakeMac({ volume: 42, mute: 1, input: 27 });
    const c = client(mac);
    await c.refresh();
    assert.deepEqual(c.state, { id: 'dell', reachable: true, power: true, volume: 42, muted: true, input: 'USB_C' });
    assert.equal(mac.commands.length, 1);
    assert.equal(mac.commands[0].host, 'mac_studio');
    c.stop();
  });

  test('a monitor the Mac cannot find is off, not unreachable', async () => {
    const mac = fakeMac({ present: false });
    const c = client(mac);
    await c.refresh();
    assert.equal(c.state.reachable, true);
    assert.equal(c.state.power, false);
    c.stop();
  });

  test('an SSH failure is unreachable; m1ddc missing is said plainly', async () => {
    const down = client({ run: async () => ({ problem: 'mac_studio: connect ECONNREFUSED', lines: [] }) });
    await down.refresh();
    assert.equal(down.state.reachable, false);
    down.stop();

    const mac = fakeMac({ installed: false });
    const c = client(mac);
    await c.refresh();
    assert.equal(c.state.reachable, false);
    c.stop();
  });

  test('sets volume, mute and input with the m1ddc commands, and holds the result', async () => {
    const mac = fakeMac();
    const c = client(mac, { display: '2' });
    assert.equal(await c.setVolume(123.4), null);
    assert.equal(await c.setMute(true), null);
    assert.equal(await c.setInput('USB-C'), null);
    assert.equal(await c.setInput('Composite'), 'Unknown input "Composite"');
    assert.deepEqual(mac.commands.map((x) => x.command), [
      `${M} display 2 set volume 100 2>&1`,
      `${M} display 2 set mute on 2>&1`,
      `${M} display 2 set input 27 2>&1`,
    ]);
    assert.equal(c.state.volume, 100);
    assert.equal(c.state.muted, true);
    assert.equal(c.state.input, 'USB_C');
    c.stop();
  });

  test('turns off with the configured standby value, and back on through caffeinate', async () => {
    const mac = fakeMac();
    const c = client(mac, { standby: 5 });
    assert.equal(await c.turnOff(), null);
    assert.equal(c.state.power, false);
    assert.match(mac.commands.at(-1).command, /set standby 5/);
    await c.refresh();
    assert.equal(c.state.power, false, 'the Mac no longer finds it');

    assert.equal(await c.turnOn(), null);
    assert.match(mac.commands.at(-1).command, /caffeinate -u -t 2; .* set standby 1/);
    await c.refresh();
    assert.equal(c.state.power, true);
    c.stop();
  });

  test("a failed write carries m1ddc's own words", async () => {
    const mac = fakeMac({ present: false });
    const c = client(mac);
    assert.equal(await c.setVolume(10), 'dell: Could not find a suitable display');
    c.stop();
  });
});

describe('a DDC monitor in dashboard.yaml', () => {
  test('parses under controls.displays, and refuses what is not safe in a shell', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ddc-config-'));
    const path = join(dir, 'dashboard.yaml');
    await writeFile(path, `
version: 1
controls:
  ssh:
    - { id: mac_studio, host: 192.168.1.200, username: spencer }
  displays:
    - id: dell
      name: Dell
      ddc: mac_studio
      screen: 1
      inputs:
        - { source: HDMI1, name: Mac Studio }
        - { source: USB-C, name: Laptop }
    - { id: bad_path, ddc: mac_studio, m1ddc: "m1ddc; rm -rf ~" }
    - { id: bad_host, ddc: "mac studio" }
    - { id: odd_screen, ddc: mac_studio, screen: "1; reboot", standby: 5 }
`);
    const config = new ConfigStore(path);
    try {
      assert.equal(await config.load(), true);
      const displays = config.current.controls.displays;
      assert.deepEqual(displays.map((d) => d.id), ['dell', 'odd_screen']);
      assert.deepEqual(displays[0].ddc, { ssh: 'mac_studio', m1ddc: M, standby: 4, display: '1' });
      assert.equal(displays[0].host, '');
      assert.deepEqual(displays[1].ddc, { ssh: 'mac_studio', m1ddc: M, standby: 5 }, 'an unsafe selector is dropped');
    } finally {
      config.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
