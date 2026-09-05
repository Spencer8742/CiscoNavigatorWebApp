import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { fileURLToPath, URL } from 'node:url';
import { MockHomeAssistant } from './mock-ha.mjs';
import { MockCompanion, MockKeyLight } from './mock-controls.mjs';

/**
 * End-to-end tests for the macro pages — the Controls screen.
 *
 * Black box, like the bridge tests: a real backend process, a mock Companion
 * and two mock Elgato Key Lights speaking their real wire formats, and a
 * WebSocket client standing in for the panel.
 *
 * What this suite exists to protect, in order:
 *
 *  1. **The panel cannot name a request.** It sends a button id and the
 *     backend resolves it against dashboard.yaml. If that ever inverts, a
 *     screen on a wall becomes a way to POST anywhere on the LAN, and no
 *     type checker would notice.
 *  2. **Mireds are not Kelvin.** A Key Light's temperature gets SMALLER as it
 *     gets warmer. Every conversion here is checked against a number written
 *     out by hand, because a helper used in both directions agrees with
 *     itself while being wrong.
 *  3. **`all` decides once.** A toggle across two lights that have drifted
 *     apart must converge them, not swap them.
 *
 *   node --test server/test/controls.test.mjs
 */

const HA_PORT = 19123;
const PANEL_PORT = 19099;
const COMPANION_PORT = 19800;
const LEFT_PORT = 19201;
const RIGHT_PORT = 19202;
const TOKEN = 'controls-test-token';

const SERVER = fileURLToPath(new URL('../dist/server.js', import.meta.url));
const CONFIG = fileURLToPath(new URL('./fixtures/controls.test.yaml', import.meta.url));

let ha;
let companion;
let left;
let right;
let backend;
/** Everything the backend has written, for the assertions that read it. */
const backendLog = [];
let panel;

/* ── Harness ──────────────────────────────────────────────────────────────*/

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(20);
  }
  assert.fail(`Timed out waiting for: ${description}`);
}

/** A panel: connects, records key light pushes and errors. */
class TestPanel {
  constructor() {
    this.config = null;
    this.errors = [];
    this.lights = [];
    this.lightPushes = 0;
    this.seq = 0;
    /** Entity snapshot from `hello`. Only what these tests assert on. */
    this.states = new Map();
  }

  async connect() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PANEL_PORT}/ws?t=${TOKEN}`);

    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.t === 'hello') {
        this.config = msg.config;
        this.lights = msg.keylights;
        for (const id in msg.states) this.states.set(id, msg.states[id]);
      } else if (msg.t === 'patch') {
        /*
         * `hello` carries whatever the store held the instant this panel
         * connected, which is NOT necessarily everything: the backend accepts
         * panels before Home Assistant has finished sending its first
         * snapshot. Anything that lands after arrives as a patch, so a test
         * that reads only `hello` is a test that passes on a fast machine.
         */
        const { add, chg, del } = msg.patch;
        if (add) for (const id in add) this.states.set(id, add[id]);
        if (chg) {
          for (const id in chg) {
            const prev = this.states.get(id);
            if (prev) this.states.set(id, { ...prev, ...chg[id], a: { ...prev.a, ...chg[id].a } });
          }
        }
        if (del) for (const id of del) this.states.delete(id);
      } else if (msg.t === 'keylights') {
        this.lights = msg.lights;
        this.lightPushes += 1;
      } else if (msg.t === 'error') {
        this.errors.push(msg);
      }
    });

    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });

    await waitFor(() => this.config !== null, 'hello message');
  }

  #next() {
    this.seq += 1;
    return this.seq;
  }

  press(button) {
    const id = this.#next();
    this.ws.send(JSON.stringify({ t: 'control', id, button }));
    return id;
  }

  /** Mirrors selectControlSource() in panel/src/net/socket.ts. */
  source(item, value) {
    const id = this.#next();
    this.ws.send(JSON.stringify({ t: 'source', id, item, value }));
    return id;
  }

  keylight(light, op, value) {
    const id = this.#next();
    this.ws.send(JSON.stringify({ t: 'keylight', id, light, op, value }));
    return id;
  }

  /** The error carrying this ref, once it arrives. */
  errorFor(ref) {
    return waitFor(
      () => this.errors.find((e) => e.ref === ref),
      `an error for message ${ref}`,
    );
  }

  light(id) {
    return this.lights.find((l) => l.id === id);
  }

  close() {
    this.ws?.close();
  }
}

/* ── Setup ────────────────────────────────────────────────────────────────*/

before(async () => {
  ha = new MockHomeAssistant(HA_PORT);
  ha.seed('scene.movie_night', 'scening', { friendly_name: 'Movie Night' });
  ha.seed('script.goodnight', 'off', { friendly_name: 'Goodnight' });
  ha.seed('switch.dp_microphone_mute', 'on', { friendly_name: 'Mic mute' });
  ha.seed('number.dp_speaker_volume', '62', { min: 0, max: 100, step: 1 });
  ha.seed('select.dp_share_source', 'HDMI 1', { options: ['HDMI 1', 'HDMI 2'] });
  ha.seed('media_player.tv', 'on', {
    friendly_name: 'Test TV',
    source: 'HDMI 2',
    source_list: ['HDMI 1', 'HDMI 2', 'Live TV'],
  });
  await ha.start();

  companion = new MockCompanion(COMPANION_PORT);
  await companion.start();

  left = new MockKeyLight(LEFT_PORT);
  // 213 mireds is 4700 K; 20% brightness. Written as the light would send it.
  left.light = { on: 0, brightness: 20, temperature: 213 };
  await left.start();

  right = new MockKeyLight(RIGHT_PORT);
  right.light = { on: 1, brightness: 60, temperature: 344 };
  await right.start();

  backend = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(PANEL_PORT),
      HOST: '127.0.0.1',
      PANEL_TOKEN: TOKEN,
      CONFIG_PATH: CONFIG,
      HA_URL: `http://127.0.0.1:${HA_PORT}`,
      HA_TOKEN: 'mock-ha-token',
      COMPANION_URL: `http://127.0.0.1:${COMPANION_PORT}`,
      IMMICH_URL: '',
      IMMICH_API_KEY: '',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Kept as well as echoed: some of what this backend does is only observable
  // as a log line, and a warning nobody can assert on is a warning that can
  // quietly stop being emitted.
  backend.stdout.on('data', (d) => {
    backendLog.push(String(d));
    process.stderr.write(`[backend] ${d}`);
  });
  backend.stderr.on('data', (d) => {
    backendLog.push(String(d));
    process.stderr.write(`[backend] ${d}`);
  });

  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${PANEL_PORT}/api/health`);
      return res.ok;
    } catch {
      return false;
    }
  }, 'backend to listen');

  panel = new TestPanel();
  await panel.connect();
});

after(async () => {
  panel?.close();
  if (backend && backend.exitCode === null) {
    backend.kill('SIGTERM');
    await new Promise((resolve) => {
      backend.once('exit', resolve);
      setTimeout(() => {
        backend.kill('SIGKILL');
        resolve();
      }, 3000);
    });
  }
  await Promise.all([ha?.stop(), companion?.stop(), left?.stop(), right?.stop()]);
});

/** A page by id, so a fixture edit does not renumber every assertion. */
function page(id) {
  const found = panel.config.controls.pages.find((p) => p.id === id);
  assert.ok(found, `no page "${id}" in the config`);
  return found;
}

/* ── Config ───────────────────────────────────────────────────────────────*/

describe('control pages', () => {
  test('reach the panel, normalised', () => {
    const pages = panel.config.controls.pages;
    // Order is preserved from the file; membership is checked loosely so
    // adding a page to the fixture does not fail a test about button shape.
    assert.deepEqual(pages.map((p) => p.id), [
      'deskpro',
      'scenes',
      'av',
      'desk',
      'combo',
      'lights',
    ]);

    const join = page('deskpro').items[0];
    assert.equal(join.type, 'button');
    assert.equal(join.wide, true);
    assert.equal(join.tone, 'accent');
    assert.deepEqual(join.actions, [{ kind: 'companion', page: 1, row: 0, column: 0 }]);
  });

  test('accept all three Companion coordinate spellings', () => {
    const [slashes, object, array] = page('deskpro').items;
    assert.deepEqual(slashes.actions, [{ kind: 'companion', page: 1, row: 0, column: 0 }]);
    assert.deepEqual(object.actions, [{ kind: 'companion', page: 1, row: 0, column: 1 }]);
    assert.deepEqual(array.actions, [{ kind: 'companion', page: 9, row: 9, column: 9 }]);
  });

  test('a bare `light:` item is a control, not a button', () => {
    const items = page('lights').items;
    const control = items.find((i) => i.type === 'light');
    assert.ok(control, 'expected a light item');
    assert.equal(control.light, 'all');
    // Generated from its position, because the fixture gives it no id.
    assert.equal(control.id, 'lights.2');
  });

  test('a scene button defaults to turn_on without a `service:`', () => {
    const movie = page('scenes').items[0];
    assert.deepEqual(movie.actions, [
      { kind: 'entity', entity: 'scene.movie_night', service: 'turn_on' },
    ]);
  });
});

/* ── Companion ────────────────────────────────────────────────────────────*/

describe('Companion buttons', () => {
  test('press the configured location', async () => {
    companion.presses.length = 0;
    panel.press('deskpro.join');

    const press = await waitFor(() => companion.presses[0], 'a Companion press');
    assert.deepEqual(press, { page: 1, row: 0, column: 0 });
  });

  test('report a location Companion has no button at', async () => {
    const ref = panel.press('deskpro.missing');
    const error = await panel.errorFor(ref);

    assert.equal(error.code, 'control_failed');
    // The message names the coordinates, because the fix is in Companion.
    assert.match(error.message, /9\/9\/9/);
  });

  test('refuse a button id that is not in the config', async () => {
    companion.presses.length = 0;
    const ref = panel.press('deskpro.nonexistent');
    const error = await panel.errorFor(ref);

    assert.equal(error.message, 'Unknown button');
    assert.equal(companion.presses.length, 0, 'nothing may be sent for an unknown id');
  });

  test('the panel cannot name a location directly', async () => {
    companion.presses.length = 0;

    // The shape a compromised panel would reach for: coordinates, not an id.
    // There is no message that carries them, so this is simply ignored.
    panel.ws.send(
      JSON.stringify({ t: 'control', id: 900, button: '2/1/3', page: 2, row: 1, column: 3 }),
    );

    await waitFor(
      () => panel.errors.find((e) => e.ref === 900),
      'the press to be refused',
    );
    assert.equal(companion.presses.length, 0, '2/1/3 exists in Companion but was never pressed');
  });
});

/* ── Home Assistant ───────────────────────────────────────────────────────*/

describe('a key with more than one action', () => {
  /*
   * One key is often one INTENTION carried out in several places: "power the
   * office on" is a Companion macro AND a television Companion cannot reach.
   * Splitting that across two keys makes the person pressing them responsible
   * for remembering the pair.
   */

  test('runs every action, in order', async () => {
    companion.presses.length = 0;
    ha.webhooks.length = 0;
    panel.press('combo.both');

    await waitFor(
      () => ha.webhooks.some((w) => w.id === 'combo_second'),
      'the second action to run',
    );
    assert.equal(companion.presses.length, 1, 'and the first to have run too');
  });

  test('reads `action: on` as ON, not as the YAML boolean it is', () => {
    /*
     * YAML 1.1 reads bare `on` and `off` as booleans, and the failure is
     * silent: the value matches no option, quietly takes the fallback, and a
     * key written to turn a television ON becomes a toggle. Which half works,
     * so nobody notices until it turns the set off at the wrong moment.
     */
    const items = page('combo').items;
    const on = items.find((i) => i.id === 'combo.tvon');
    const off = items.find((i) => i.id === 'combo.tvoff');

    assert.deepEqual(on.actions, [{ kind: 'tv', tv: 'room_tv', op: 'on' }]);
    assert.deepEqual(off.actions, [{ kind: 'tv', tv: 'room_tv', op: 'off' }]);
  });

  test('stops at the first failure', async () => {
    // Carrying on would leave the room half-started while the panel reported
    // only whatever the last action did.
    ha.webhooks.length = 0;
    const ref = panel.press('combo.stops');
    const error = await panel.errorFor(ref);

    assert.ok(error, 'the failure must reach the panel');
    assert.equal(
      ha.webhooks.some((w) => w.id === 'combo_never'),
      false,
      'the action after a failed one must not run',
    );
  });
});

describe('Home Assistant buttons', () => {
  test('fire a webhook', async () => {
    ha.webhooks.length = 0;
    panel.press('scenes.listen');

    const hook = await waitFor(() => ha.webhooks[0], 'a webhook POST');
    assert.equal(hook.id, 'office_voice_listen');
  });

  test('call a service through the same guard as a tile', async () => {
    ha.serviceCalls.length = 0;
    panel.press('scenes.movie');

    const call = await waitFor(() => ha.serviceCalls[0], 'a call_service');
    assert.equal(call.domain, 'scene');
    assert.equal(call.service, 'turn_on');
    assert.equal(call.target.entity_id, 'scene.movie_night');
  });

  test('a control-only entity is on the allow-list because it is configured', async () => {
    // script.goodnight appears nowhere but a controls page. If controls were
    // left out of allReferencedEntities() the guard would refuse this.
    ha.serviceCalls.length = 0;
    panel.press('scenes.goodnight');

    const call = await waitFor(() => ha.serviceCalls[0], 'a call_service');
    assert.equal(call.target.entity_id, 'script.goodnight');
  });
});

/* ── Source pickers ───────────────────────────────────────────────────────*/

describe('media player keys', () => {
  test('a `sources:` item is a picker, not a button', () => {
    const input = page('av').items.find((i) => i.id === 'av.input');
    assert.equal(input.type, 'sources');
    assert.equal(input.entity, 'media_player.tv');
    // No action: the panel opens a sheet, it does not send anything on tap.
    assert.equal(input.actions, undefined);
  });

  test('a `sources:` item aimed at a non-media_player is dropped', () => {
    assert.equal(
      page('av').items.find((i) => i.id === 'av.bad'),
      undefined,
      'light.living_room has no source_list and must not become a picker',
    );
  });

  test('the picker entity reaches the panel with its source_list', async () => {
    // Referenced ONLY by the picker — so this also proves a `sources:` item
    // puts its entity in allReferencedEntities, without which the panel
    // would have nothing to populate the sheet from.
    //
    // Waited for rather than read straight out of `hello`: whether it is in
    // that first frame depends on whether Home Assistant's snapshot beat the
    // panel's connection, which is a race this test has no business caring
    // about. It failed roughly one run in three on a loaded machine.
    const tv = await waitFor(
      () => panel.states.get('media_player.tv'),
      'media_player.tv to reach the panel',
    );
    assert.deepEqual(tv.a.source_list, ['HDMI 1', 'HDMI 2', 'Live TV']);
    assert.equal(tv.a.source, 'HDMI 2');
  });

  /*
   * These go through the SAME message the panel sends, not a hand-written
   * call_service. The first version of this test hand-wrote the service call
   * and passed while the panel was sending `input_select.select_option` — it
   * proved the backend would accept the right request without checking that
   * anything sends it. Choosing an input answered "Not permitted" on a real
   * device with a green test suite.
   */
  test('choosing an input issues select_source for the configured entity', async () => {
    ha.serviceCalls.length = 0;
    panel.source('av.input', 'HDMI 1');

    const call = await waitFor(() => ha.serviceCalls[0], 'a select_source');
    assert.equal(call.domain, 'media_player');
    assert.equal(call.service, 'select_source');
    assert.equal(call.target.entity_id, 'media_player.tv');
    assert.equal(call.service_data.source, 'HDMI 1');
  });

  test('a value the device never published is refused', async () => {
    ha.serviceCalls.length = 0;
    const ref = panel.source('av.input', 'HDMI 99');
    const error = await panel.errorFor(ref);
    assert.equal(error.code, 'source_failed');
    assert.equal(error.message, 'Unknown input');
    assert.equal(ha.serviceCalls.length, 0, 'nothing may reach Home Assistant');
  });

  test('a control id that is not a sources key is refused', async () => {
    ha.serviceCalls.length = 0;
    // A real key, but a Companion one — it has no entity to select on.
    const ref = panel.source('deskpro.join', 'HDMI 1');
    const error = await panel.errorFor(ref);
    assert.equal(error.message, 'Unknown control');
    assert.equal(ha.serviceCalls.length, 0);
  });

  test('a curated `inputs:` list is parsed, in order, with renames', () => {
    const curated = page('av').items.find((i) => i.id === 'av.curated');
    assert.deepEqual(curated.inputs, [
      { source: 'HDMI 1' },
      { source: 'HDMI 2', name: 'Laptop' },
    ]);
  });

  test('a curated list is the allow-list, not the device source_list', async () => {
    ha.serviceCalls.length = 0;
    // In the device's source_list, deliberately absent from `inputs:`.
    const ref = panel.source('av.curated', 'Live TV');
    const error = await panel.errorFor(ref);
    assert.equal(error.message, 'Unknown input');
    assert.equal(ha.serviceCalls.length, 0);

    // And one that IS curated still goes through.
    panel.source('av.curated', 'HDMI 2');
    const call = await waitFor(() => ha.serviceCalls[0], 'a select_source');
    assert.equal(call.service_data.source, 'HDMI 2');
  });

  test('an unknown control id is refused', async () => {
    const ref = panel.source('av.nonexistent', 'HDMI 1');
    const error = await panel.errorFor(ref);
    assert.equal(error.message, 'Unknown control');
  });

  test('media_player.toggle is permitted', async () => {
    ha.serviceCalls.length = 0;
    panel.press('av.power');
    const call = await waitFor(() => ha.serviceCalls[0], 'a call_service');
    assert.equal(call.domain, 'media_player');
    assert.equal(call.service, 'toggle');
    assert.equal(call.target.entity_id, 'media_player.tv');
  });

  test('a service still outside the allow-list is refused', async () => {
    ha.serviceCalls.length = 0;
    panel.ws.send(JSON.stringify({
      t: 'call', id: 701, domain: 'media_player', service: 'shell_command',
      entity: 'media_player.tv',
    }));
    const error = await panel.errorFor(701);
    assert.equal(error.message, 'Not permitted');
    assert.equal(ha.serviceCalls.length, 0);
  });
});

/* ── Device tiles ─────────────────────────────────────────────────────────*/

describe('device tiles', () => {
  test('`prefix:` derives the whole entity set', () => {
    const tile = page('desk').items.find((i) => i.type === 'device');
    assert.ok(tile, 'expected a device item');
    assert.equal(tile.name, 'Test Desk Pro');

    // A sample across every platform the integration uses, including the two
    // whose entity NAME differs from the integration's internal key — those
    // are the ones a naive derivation gets wrong.
    assert.equal(tile.entities.noise, 'sensor.dp_ambient_noise');
    assert.equal(tile.entities.meetings, 'sensor.dp_next_meeting');
    assert.equal(tile.entities.inCall, 'binary_sensor.dp_in_call');
    assert.equal(tile.entities.mic, 'switch.dp_microphone_mute');
    // The camera mute is a real switch, not the selfview beside it — one is
    // what the far end sees, the other is the local preview.
    assert.equal(tile.entities.camera, 'switch.dp_camera_mute');
    assert.equal(tile.entities.join, 'button.dp_join_next_meeting');
    assert.equal(tile.entities.shareLocal, 'button.dp_share_locally');
    assert.equal(tile.entities.shareSource, 'select.dp_share_source');
  });

  test('a written slot overrides the derived one, and null drops it', () => {
    const tile = page('desk').items.find((i) => i.type === 'device');
    assert.equal(tile.entities.volume, 'number.dp_speaker_volume');
    assert.equal(tile.entities.selfview, undefined);
  });

  test('a device naming no entities is skipped', () => {
    assert.equal(
      page('desk').items.find((i) => i.id === 'dp.empty'),
      undefined,
      'a device block with neither prefix nor slots is not a device',
    );
  });

  test('every device entity is allow-listed, so the tile has state to show', async () => {
    // Referenced ONLY by the tile. Without the device branch in
    // allReferencedEntities() the store would filter these out and the tile
    // would render empty against a perfectly healthy Home Assistant.
    for (const id of ['switch.dp_microphone_mute', 'number.dp_speaker_volume', 'select.dp_share_source']) {
      await waitFor(() => panel.states.get(id), `${id} to reach the panel`);
    }
  });

  test('number.set_value is permitted — the volume slider', async () => {
    // The message the tile actually sends: setEntityNumber() takes its domain
    // from the entity, so a `number.` entity produces `number.set_value`.
    ha.serviceCalls.length = 0;
    panel.ws.send(JSON.stringify({
      t: 'call', id: 800, domain: 'number', service: 'set_value',
      entity: 'number.dp_speaker_volume', data: { value: 40 },
    }));
    const call = await waitFor(
      () => ha.serviceCalls.find((c) => c.service === 'set_value'),
      'a number.set_value',
    );
    assert.equal(call.domain, 'number');
    assert.equal(call.service_data.value, 40);
  });

  test('select.select_option is permitted — the share source', async () => {
    ha.serviceCalls.length = 0;
    panel.ws.send(JSON.stringify({
      t: 'call', id: 801, domain: 'select', service: 'select_option',
      entity: 'select.dp_share_source', data: { option: 'HDMI 2' },
    }));
    const call = await waitFor(
      () => ha.serviceCalls.find((c) => c.service === 'select_option'),
      'a select.select_option',
    );
    assert.equal(call.domain, 'select');
    assert.equal(call.service_data.option, 'HDMI 2');
  });

  test('widening to number/select did not widen anything else', async () => {
    // `set_value` on a switch is still a domain mismatch, and the new domains
    // brought no new verbs with them.
    const ref = panel.seq + 1;
    panel.ws.send(JSON.stringify({
      t: 'call', id: ref, domain: 'number', service: 'set_value',
      entity: 'switch.dp_microphone_mute', data: { value: 1 },
    }));
    const error = await panel.errorFor(ref);
    assert.equal(error.message, 'Not permitted');
  });
});

describe('a device tile\'s own keys', () => {
  /*
   * `keys:` inside a `device:` block — for the things the integration does
   * not expose, like camera on/off, which have to go through Companion
   * instead. Parsed by the same controlItems() as any other key, so it needs
   * to be resolvable by press() the same way. Without the lookup added to
   * ControlRunner#find, a nested key would parse fine, render fine, and every
   * tap would be refused as "not in dashboard.yaml" — which is exactly the
   * shape of bug that only shows up by actually pressing one.
   */

  test('is a real button the panel can press', async () => {
    companion.presses.length = 0;
    panel.press('desk.lights');

    const press = await waitFor(() => companion.presses[0], 'a Companion press');
    assert.deepEqual(press, { page: 1, row: 0, column: 1 });
  });

  test('is on the tile, not on the page grid', () => {
    const tile = page('desk').items.find((i) => i.type === 'device');
    assert.equal(tile.keys.length, 2);
    assert.equal(tile.keys[0].name, 'Lights');
    assert.equal(tile.keys[1].name, 'Blinds');

    // Not ALSO a top-level page item — it belongs in exactly one place.
    assert.equal(
      page('desk').items.find((i) => i.id === 'desk.lights'),
      undefined,
    );
  });
});

/* ── Key lights ───────────────────────────────────────────────────────────*/

describe('key lights', () => {
  test('arrive in `hello` with mireds converted to Kelvin', () => {
    const left = panel.light('key_left');
    assert.ok(left, 'key_left should be in hello');
    assert.equal(left.name, 'Key Left');
    assert.equal(left.reachable, true);
    assert.equal(left.on, false);
    assert.equal(left.brightness, 20);
    // 213 mireds -> 4694 K, rounded to the nearest 50.
    assert.equal(left.temperature, 4700);

    const right = panel.light('key_right');
    assert.equal(right.on, true);
    // 344 mireds is the warm end of the range.
    assert.equal(right.temperature, 2900);
  });

  test('a brightness change is sent to the light and pushed back', async () => {
    left.writes.length = 0;
    panel.keylight('key_left', 'brightness', 65);

    const write = await waitFor(() => left.writes[0], 'a PUT to the left light');
    assert.equal(write.lights[0].brightness, 65);
    // Setting brightness on a light that is off turns it on — otherwise the
    // slider moves and the room stays dark.
    assert.equal(write.lights[0].on, 1);

    await waitFor(() => panel.light('key_left')?.brightness === 65, 'the push back');
    assert.equal(panel.light('key_left').on, true);
  });

  test('a colour temperature is converted back to mireds', async () => {
    left.writes.length = 0;
    panel.keylight('key_left', 'temperature', 2900);

    const write = await waitFor(() => left.writes[0], 'a PUT to the left light');
    // The WARM end of the scale is the LARGEST mired value. Getting this
    // backwards makes every "warmer" tap go colder.
    assert.equal(write.lights[0].temperature, 344);
    // Temperature must not disturb brightness.
    assert.equal(write.lights[0].brightness, undefined);

    await waitFor(() => panel.light('key_left')?.temperature === 2900, 'the push back');
  });

  test('`all` fans out and decides its direction once', async () => {
    // Left on (from the brightness test), right on: a toggle turns BOTH off.
    await waitFor(
      () => panel.light('key_left')?.on && panel.light('key_right')?.on,
      'both lights on before the toggle',
    );

    left.writes.length = 0;
    right.writes.length = 0;
    panel.keylight('all', 'toggle');

    await waitFor(() => left.writes[0] && right.writes[0], 'a PUT to both lights');
    assert.equal(left.writes[0].lights[0].on, 0);
    assert.equal(right.writes[0].lights[0].on, 0);

    // Now both off: the next toggle turns both on, rather than swapping them.
    left.writes.length = 0;
    right.writes.length = 0;
    panel.keylight('all', 'toggle');

    await waitFor(() => left.writes[0] && right.writes[0], 'a second PUT to both');
    assert.equal(left.writes[0].lights[0].on, 1);
    assert.equal(right.writes[0].lights[0].on, 1);
  });

  test('a toggle converges a pair that has drifted apart', async () => {
    // One on, one off — which is exactly what a failed command leaves behind.
    panel.keylight('key_left', 'off');
    await waitFor(() => panel.light('key_left')?.on === false, 'left off');
    await waitFor(() => panel.light('key_right')?.on === true, 'right still on');

    left.writes.length = 0;
    right.writes.length = 0;
    panel.keylight('all', 'toggle');

    await waitFor(() => left.writes[0] && right.writes[0], 'a PUT to both lights');
    // "Any on" means off, so they end up agreeing rather than swapping.
    assert.equal(left.writes[0].lights[0].on, 0);
    assert.equal(right.writes[0].lights[0].on, 0);
  });

  test('a keylight button drives the light it names', async () => {
    left.writes.length = 0;
    right.writes.length = 0;
    panel.press('lights.dim');

    const write = await waitFor(() => left.writes[0], 'a PUT to the left light');
    assert.equal(write.lights[0].brightness, 20);
    assert.equal(right.writes.length, 0, 'the right light was not addressed');
  });

  test('refuse a light that is not in the config', async () => {
    const ref = panel.keylight('key_middle', 'toggle');
    const error = await panel.errorFor(ref);
    assert.equal(error.code, 'keylight_failed');
    assert.equal(error.message, 'Unknown light');
  });

  test('report an unreachable light without losing its last known state', async () => {
    await right.stop();

    const before = panel.light('key_right');
    const ref = panel.keylight('key_right', 'toggle');
    const error = await panel.errorFor(ref);
    assert.equal(error.message, 'Light unreachable');

    const after = await waitFor(
      () => (panel.light('key_right')?.reachable === false ? panel.light('key_right') : null),
      'the light to be marked unreachable',
    );
    // Greyed out, not zeroed: the control keeps its position.
    assert.equal(after.brightness, before.brightness);
    assert.equal(after.temperature, before.temperature);
  });
});

describe('entities the config names but Home Assistant does not have', () => {
  /*
   * The bug: a device tile written as `prefix: desk_pro` against a device
   * whose entities were registered under a different name produced twenty-five
   * wrong ids, a tile with no state in it, and not one word anywhere saying
   * so. On screen it was indistinguishable from a tile still loading.
   *
   * The `desk` fixture page reproduces it — `prefix: dp` derives a full set,
   * and the mock only publishes three of them.
   */

  test('are named individually in the log, not swallowed', async () => {
    await waitFor(
      () => backendLog.join('').includes('do not exist in Home Assistant'),
      'the missing-entity report',
    );

    const text = backendLog.join('');
    // The count alone would not be actionable: the whole point is being able
    // to compare an id against Developer Tools -> States.
    assert.match(
      text,
      /button\.dp_wake_up/,
      'the report names the specific derived id that does not exist',
    );
  });

  test('do not drag down the ones that do exist', async () => {
    // The failure mode worth guarding: treating a partly-wrong entity set as
    // wholly unusable. Three of the `dp` ids are real and must still arrive.
    await waitFor(
      () => panel.states.get('switch.dp_microphone_mute') !== undefined,
      'a real entity from a partly-missing set',
    );
    assert.equal(
      panel.states.get('button.dp_wake_up'),
      undefined,
      'and the absent one stays absent',
    );
  });
});
