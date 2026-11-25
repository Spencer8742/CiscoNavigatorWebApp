import { describe, mock, test } from 'node:test';
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
  // `asleep`: the P4326QEB with no signal — it still answers DDC, ignores a
  // switch to any input but USB-C, and wakes for that. What it reports for
  // standby while asleep was never seen on the real one, so it is a knob:
  // `asleepStandby` (4 by default; 1 is "asleep but says it is on").
  // `flags`: high-byte flags per value, like the 0xFF64 the real one gave.
  // `unreadable`: values that come back empty this time.
  // `fumble`: how many writes fail with a DDC error before one works.
  const mon = {
    present: true, installed: true, standby: 1, volume: 30, mute: 2, input: 17,
    asleep: false, asleepStandby: 4, flags: { input: 0x0f00 }, unreadable: [], fumble: 0,
    ...initial,
  };
  const commands = [];
  const run = async (host, command, how) => {
    commands.push({ host, command, how });
    if (command.includes('|| { echo missing')) {
      if (!mon.installed) return { problem: null, lines: ['missing'] };
      const lines = ['standby', 'volume', 'mute', 'input'].map((c) => {
        if (!mon.present || mon.unreadable.includes(c)) return `${c}=`;
        const value = c === 'standby' && mon.asleep ? mon.asleepStandby : mon[c];
        return `${c}=${value | (mon.flags[c] ?? 0)}`;
      });
      return { problem: null, lines };
    }
    if (command.includes('caffeinate -u')) {
      mon.present = true;
      // Lighting the Mac's output wakes a monitor asleep for want of a
      // picture on the input it is on — not one parked on an empty input.
      if (mon.asleep && mon.input !== 27) mon.asleep = false;
      // Anything after the wake (a `set input`) still applies.
      if (!/set (standby|input)/.test(command)) return { problem: null, lines: [] };
    }
    const sets = [...command.matchAll(/set (standby|volume|mute|input) (\w+)/g)];
    if (sets.length === 0) return { problem: 'unexpected command', lines: [] };
    if (!mon.present) return { problem: 'mac_studio: command exited 1', lines: ['Could not find a suitable display'] };
    if (mon.fumble > 0) {
      mon.fumble -= 1;
      return { problem: 'mac_studio: command exited 1', lines: ['DDC communication failure: (iokit/?) unknown subsystem error'] };
    }
    for (const [, what, value] of sets) apply(what, value);
    return { problem: null, lines: sets.map(([, , value]) => `Writing ${value}`) };
  };
  const apply = (what, value) => {
    if (what === 'input' && mon.asleep) {
      if (Number(value) !== 27) return;
      mon.asleep = false;
    }
    if (what === 'mute') mon.mute = value === 'on' ? 1 : 2;
    else mon[what] = Number(value);
    if (what === 'standby') {
      if (Number(value) === 1) mon.asleep = false;
      else mon.present = false;
    }
  };
  return { mon, commands, run };
}

function client(mac, extra = {}) {
  return new DdcClient({
    id: 'dell', ssh: 'mac_studio', m1ddc: M, standby: 4, run: mac.run, settleMs: 0, retryMs: 0, ...extra,
  });
}

/** The Dell as configured: off is the empty USB-C input, on is the Mac's HDMI. */
const dell = (mac, extra = {}) => client(mac, { offInput: 'USB_C', onInput: 'HDMI1', wakeSeconds: 0, ...extra });

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

  test('with offInput, off parks it on the empty input and on brings back what was showing', async () => {
    // The P4326QEB drops off DDC entirely in standby, so it is turned off by
    // switching to USB-C with nothing on it, where it sleeps but answers.
    const mac = fakeMac({ input: 18 });
    const c = client(mac, { offInput: 'USB_C', onInput: 'HDMI1' });
    await c.refresh();
    assert.equal(c.state.input, 'HDMI2');

    assert.equal(await c.turnOff(), null);
    assert.match(mac.commands.at(-1).command, /set input 27/);
    assert.doesNotMatch(mac.commands.at(-1).command, /standby/);
    await c.refresh();
    assert.equal(c.state.power, false, 'parked on USB-C reads as off');
    assert.equal(c.state.reachable, true);

    assert.equal(await c.turnOn(), null);
    assert.match(mac.commands.at(-1).command, /caffeinate -u -t 1; .* set input 18/, 'back to HDMI2, where it was');
    await c.refresh();
    assert.equal(c.state.power, true);
    assert.equal(c.state.input, 'HDMI2');
    c.stop();
  });

  test('with offInput, choosing the laptop on that same input is on, not off', async () => {
    const mac = fakeMac({ input: 17 });
    const c = client(mac, { offInput: 'USB_C', onInput: 'HDMI1' });
    await c.turnOff();
    assert.equal(c.state.power, false);
    assert.equal(await c.setInput('USB-C'), null);
    assert.equal(c.state.power, true);
    await c.refresh();
    assert.equal(c.state.power, true);
    assert.equal(c.state.input, 'USB_C');

    // From cold, nothing known: On goes to the configured onInput.
    const cold = client(fakeMac({ input: 27 }), { offInput: 'USB_C', onInput: 'HDMI1' });
    await cold.turnOn();
    assert.equal(cold.state.input, 'HDMI1');
    c.stop();
    cold.stop();
  });

  test('asleep, an input key wakes it on USB-C first, then switches', async () => {
    const mac = fakeMac({ input: 17, asleep: true });
    const c = client(mac, { offInput: 'USB_C', onInput: 'HDMI1', wakeSeconds: 0 });
    assert.equal(await c.setInput('HDMI1'), null);
    assert.equal(mac.mon.asleep, false, 'woken');
    assert.equal(mac.mon.input, 17);
    assert.match(mac.commands.at(-1).command, /set input 27; sleep 0; .* set input 17/);
    c.stop();
  });

  test('awake on another input, an input key goes straight there, with no USB-C detour', async () => {
    // The detour would flash the laptop on USB-C for no reason.
    const mac = fakeMac({ input: 18 });
    const c = dell(mac);
    assert.equal(await c.setInput('HDMI1'), null);
    assert.equal(mac.commands.at(-1).command, `${M} set input 17 2>&1`);
    assert.equal(mac.mon.input, 17);
    c.stop();
  });

  test('already on the input asked for, it lights the Mac and stays put', async () => {
    const mac = fakeMac({ input: 17 });
    const c = dell(mac);
    assert.equal(await c.setInput('HDMI1'), null);
    assert.equal(mac.commands.at(-1).command, `/usr/bin/caffeinate -u -t 1; ${M} set input 17 2>&1`);
    c.stop();
  });

  test('on the wake input, an input key always goes by way of it — even reading as awake', async () => {
    // Showing the laptop or asleep on USB-C look the same from here, and
    // from USB-C the detour costs nothing.
    const mac = fakeMac({ input: 27 });
    const c = dell(mac);
    assert.equal(await c.setInput('HDMI1'), null);
    assert.match(mac.commands.at(-1).command, /caffeinate -u -t 1; .* set input 27; sleep 0; .* set input 17/);
    assert.equal(mac.mon.input, 17);
    c.stop();
  });

  test('after a restart, a Dell asleep on USB-C that says it is on is still woken', async () => {
    // The bug: "parked" lives in memory, so after the container restarts a
    // Dell left asleep on USB-C read as on (it reports standby 1 asleep), and
    // the Mac Studio key sent HDMI straight to a monitor that ignores it.
    const mac = fakeMac({ input: 27, asleep: true, asleepStandby: 1 });
    const c = dell(mac);
    assert.equal(await c.setInput('HDMI1'), null);
    assert.equal(mac.mon.asleep, false, 'woken');
    assert.equal(mac.mon.input, 17, 'and on HDMI');
    c.stop();
  });

  test('when the Mac is still waking, the key waits for it, then wakes the Dell', async () => {
    // Office Power presses the Mac's Wake-on-LAN and this in the same
    // instant. The fresh read cannot reach the Mac, so nothing about the
    // Dell can be trusted — and it is woken the long way once the Mac answers.
    const mac = fakeMac({ input: 17, asleep: true });
    let macAwake = false;
    const run = async (host, command, how) => {
      if (!macAwake) {
        mac.commands.push({ host, command, how });
        if (how.wait) {
          macAwake = true; // the runner waited for it
          return mac.run(host, command, how);
        }
        return { problem: 'mac_studio: connect EHOSTUNREACH', lines: [] };
      }
      return mac.run(host, command, how);
    };
    const c = dell({ run });
    assert.equal(await c.setInput('HDMI1'), null);
    const [read, write] = mac.commands;
    assert.equal(read.how.wait, false, 'the read does not wait for the Mac');
    assert.equal(write.how.wait, true, 'the write does');
    assert.match(write.command, /set input 27; sleep 0; .* set input 17/);
    assert.equal(mac.mon.input, 17);
    assert.equal(mac.mon.asleep, false);
    c.stop();
  });

  test('a write the monitor fumbles is tried once more', async () => {
    const mac = fakeMac({ input: 18, fumble: 1 });
    const c = dell(mac);
    assert.equal(await c.setInput('HDMI1'), null);
    assert.equal(mac.mon.input, 17);
    const writes = mac.commands.filter((x) => !x.command.includes('echo missing'));
    assert.equal(writes.length, 2);
    c.stop();
  });

  test('a wake sequence gets the time its pause needs', async () => {
    const mac = fakeMac({ input: 27 });
    const c = dell(mac, { wakeSeconds: 20 });
    await c.setInput('HDMI1');
    assert.ok(mac.commands.at(-1).how.timeoutMs >= 35_000, `timeout ${mac.commands.at(-1).how.timeoutMs}`);
    c.stop();
  });

  test('flags in the high byte are ignored, for every value', async () => {
    // 0xFF64 is what the real Dell answered for its maximum volume.
    const mac = fakeMac({ input: 17, flags: { standby: 0xff00, volume: 0xff00, mute: 0xff00, input: 0x0f00 } });
    const c = client(mac);
    await c.refresh();
    assert.deepEqual(c.state, { id: 'dell', reachable: true, power: true, volume: 30, muted: false, input: 'HDMI1' });
    c.stop();
  });

  test('a value that does not come back keeps the last one read', async () => {
    const mac = fakeMac({ input: 18 });
    const c = client(mac);
    await c.refresh();
    mac.mon.unreadable = ['input', 'volume'];
    await c.refresh();
    assert.equal(c.state.input, 'HDMI2');
    assert.equal(c.state.volume, 30);
    c.stop();
  });

  test('background reads do not wait for the Mac; the poll paces itself', async () => {
    mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    try {
      const mac = fakeMac({ input: 17 });
      const c = client(mac);
      await c.refresh();
      assert.equal(mac.commands[0].how.wait, false);
      const reads = () => mac.commands.length;

      await c.poll();
      assert.equal(reads(), 1, 'not due straight after a read');
      mock.timers.tick(61_000);
      await c.poll();
      assert.equal(reads(), 2, 'on: read about once a minute');

      // Off (or the Mac not answering): rarely, so a sleeping Mac is not
      // woken over and over by a Bonjour Sleep Proxy.
      mac.mon.present = false;
      mock.timers.tick(61_000);
      await c.poll();
      assert.equal(c.state.power, false);
      mock.timers.tick(5 * 60_000);
      await c.poll();
      assert.equal(reads(), 3, 'off: not yet');
      mock.timers.tick(6 * 60_000);
      await c.poll();
      assert.equal(reads(), 4, 'off: every ten minutes');
      c.stop();
    } finally {
      mock.timers.reset();
    }
  });

  test('On wakes a parked monitor through USB-C and lands on HDMI', async () => {
    const mac = fakeMac({ input: 17 });
    const c = client(mac, { offInput: 'USB_C', onInput: 'HDMI1', wakeSeconds: 0 });
    await c.refresh();
    await c.turnOff();
    mac.mon.asleep = true; // no signal on USB-C: it goes to sleep
    await c.refresh();
    assert.equal(c.state.power, false);
    assert.equal(await c.turnOn(), null);
    assert.equal(mac.mon.asleep, false);
    assert.equal(mac.mon.input, 17);
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
  test('a valid offInput is taken without a warning; wakeSeconds stands on its own', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ddc-config-'));
    const path = join(dir, 'dashboard.yaml');
    await writeFile(path, `
version: 1
controls:
  displays:
    - { id: dell, ddc: mac_studio, offInput: USB-C }
    - { id: slow, ddc: mac_studio, offInput: USB-C, wakeSeconds: 5 }
    - { id: odd, ddc: mac_studio, offInput: Composite }
`);
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    const config = new ConfigStore(path);
    try {
      assert.equal(await config.load(), true);
    } finally {
      console.warn = original;
      config.close();
      await rm(dir, { recursive: true, force: true });
    }
    const [dell, slow, odd] = config.current.controls.displays;
    assert.equal(dell.ddc.offInput, 'USB_C');
    assert.equal(dell.ddc.wakeSeconds, undefined);
    assert.equal(slow.ddc.wakeSeconds, 5);
    assert.equal(odd.ddc.offInput, undefined);
    // Only the bad one is warned about — a missing wakeSeconds is not a bad offInput.
    const offInputWarnings = warnings.filter((w) => w.includes('offInput'));
    assert.equal(offInputWarnings.length, 1, offInputWarnings.join('\n'));
    assert.match(offInputWarnings[0], /displays\[2\]/);
  });

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
    - { id: parked, ddc: mac_studio, offInput: USB-C, volume: false, mute: false }
    - { id: by_uuid, ddc: mac_studio, screen: 1A2B3C4D-0000-0000-0000-000000000000 }
`);
    const config = new ConfigStore(path);
    try {
      assert.equal(await config.load(), true);
      const displays = config.current.controls.displays;
      assert.deepEqual(displays.map((d) => d.id), ['dell', 'odd_screen', 'parked', 'by_uuid']);
      // The UUID m1ddc prints does not move when the Mac renumbers its screens.
      assert.equal(displays[3].ddc.display, '1A2B3C4D-0000-0000-0000-000000000000');
      assert.equal(displays[2].ddc.offInput, 'USB_C');
      assert.equal(displays[2].volume, false);
      assert.equal(displays[2].mute, false);
      assert.equal(displays[0].volume, true, 'volume and mute default on');
      assert.deepEqual(displays[0].ddc, { ssh: 'mac_studio', m1ddc: M, standby: 4, display: '1' });
      assert.equal(displays[0].host, '');
      assert.deepEqual(displays[1].ddc, { ssh: 'mac_studio', m1ddc: M, standby: 5 }, 'an unsafe selector is dropped');
    } finally {
      config.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
