import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { fileURLToPath, URL } from 'node:url';
import { MockHomeAssistant } from './mock-ha.mjs';

/**
 * End-to-end tests for the Home Assistant bridge.
 *
 * Black box on purpose: a real backend process, a mock Home Assistant
 * speaking the real protocol, and a WebSocket client standing in for the
 * panel. That exercises the actual wiring — env parsing, config validation,
 * the allow-list, the store, the hub fan-out — rather than the units in
 * isolation, and it is the only way to catch the failure this suite exists
 * for: silently mis-reading Home Assistant's compressed diff format.
 *
 *   node --test server/test/
 */

const HA_PORT = 18123;
const PANEL_PORT = 18099;
const TOKEN = 'test-token-do-not-use-in-production';

const SERVER = fileURLToPath(new URL('../dist/server.js', import.meta.url));
const CONFIG = fileURLToPath(new URL('./fixtures/dashboard.test.yaml', import.meta.url));

let ha;
let backend;

/* ── Harness ──────────────────────────────────────────────────────────────*/

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `check` returns truthy, or fail with a useful message. */
async function waitFor(check, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(25);
  }
  assert.fail(`Timed out waiting for: ${description}`);
}

/** A panel: connects, records every message, exposes the merged state. */
class TestPanel {
  constructor() {
    this.messages = [];
    this.states = new Map();
    this.config = null;
    this.health = null;
    this.errors = [];
  }

  /** In-flight browse requests, keyed by id — mirrors panel/src/net/socket.ts. */
  #browsers = new Map();
  #browseSeq = 900;

  /** Ask to browse and wait for the answer, exactly as the panel does. */
  browse(req) {
    const id = (this.#browseSeq += 1);
    return new Promise((resolve, reject) => {
      this.#browsers.set(id, { resolve, reject });
      this.send({ t: 'browse', id, req });
      setTimeout(() => {
        if (this.#browsers.delete(id)) reject(new Error('browse timed out'));
      }, 8000);
    });
  }

  async connect() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PANEL_PORT}/ws?t=${TOKEN}`);

    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      this.messages.push(msg);

      if (msg.t === 'hello') {
        this.config = msg.config;
        this.health = msg.health;
        for (const id in msg.states) this.states.set(id, msg.states[id]);
      } else if (msg.t === 'patch') {
        this.#applyPatch(msg.patch);
      } else if (msg.t === 'health') {
        this.health = msg.health;
      } else if (msg.t === 'config') {
        this.config = msg.config;
      } else if (msg.t === 'error') {
        this.errors.push(msg);
        const waiter = this.#browsers.get(msg.ref);
        if (waiter) {
          this.#browsers.delete(msg.ref);
          waiter.reject(new Error(msg.message));
        }
      } else if (msg.t === 'browse') {
        const waiter = this.#browsers.get(msg.ref);
        if (waiter) {
          this.#browsers.delete(msg.ref);
          waiter.resolve(msg.result);
        }
      }
    });

    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });

    await waitFor(() => this.config !== null, 'hello message');
  }

  /** Mirrors panel/src/state/entities.ts — if this diverges, so does the UI. */
  #applyPatch(patch) {
    if (patch.add) for (const id in patch.add) this.states.set(id, patch.add[id]);

    if (patch.chg) {
      for (const id in patch.chg) {
        const diff = patch.chg[id];
        const prev = this.states.get(id);
        if (!prev) continue;
        let a = prev.a;
        if (diff.a || diff.r) {
          a = { ...prev.a };
          if (diff.a) Object.assign(a, diff.a);
          if (diff.r) for (const key of diff.r) delete a[key];
        }
        this.states.set(id, {
          id,
          s: diff.s ?? prev.s,
          a,
          lc: diff.lc ?? prev.lc,
          lu: diff.lu ?? prev.lu,
        });
      }
    }

    if (patch.del) for (const id of patch.del) this.states.delete(id);
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  /** Messages received since a marker index. */
  since(index) {
    return this.messages.slice(index);
  }

  get messageCount() {
    return this.messages.length;
  }

  close() {
    this.ws?.close();
  }
}

async function startBackend(extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(PANEL_PORT),
      HOST: '127.0.0.1',
      PANEL_TOKEN: TOKEN,
      CONFIG_PATH: CONFIG,
      HA_URL: `http://127.0.0.1:${HA_PORT}`,
      HA_TOKEN: 'mock-ha-token',
      IMMICH_URL: '',
      IMMICH_API_KEY: '',
      LOG_LEVEL: 'warn',
      // Production default is 30s. Shortened here so the "sustained outage"
      // test does not take half a minute — the behaviour under test is the
      // grace period existing at all, not its exact length.
      HA_UNAVAILABLE_GRACE_MS: '1500',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`));

  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${PANEL_PORT}/api/health`);
      return res.ok;
    } catch {
      return false;
    }
  }, 'backend to listen');

  return child;
}

async function stopBackend(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    child.once('exit', resolve);
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3000);
  });
}

/* ── Setup ────────────────────────────────────────────────────────────────*/

before(async () => {
  ha = new MockHomeAssistant(HA_PORT);

  // Seeded BEFORE the backend starts, so the first thing it sees is a
  // realistic full snapshot.
  ha.seed('light.living_room', 'on', {
    friendly_name: 'Living Room',
    brightness: 128,
    supported_color_modes: ['color_temp'],
  });
  ha.seed('cover.blinds', 'open', { friendly_name: 'Blinds', current_position: 70 });
  ha.seed('climate.thermostat', 'heat', {
    friendly_name: 'Thermostat',
    current_temperature: 19.5,
    temperature: 21,
  });
  ha.seed('lock.front_door', 'locked', { friendly_name: 'Front Door' });
  ha.seed('sensor.temperature', '21.3', {
    friendly_name: 'Indoor Temp',
    unit_of_measurement: '°C',
    device_class: 'temperature',
  });
  ha.seed('scene.movie_night', '2026-08-15T12:00:00+00:00', { friendly_name: 'Movie Night' });
  ha.seed('media_player.speaker', 'playing', { friendly_name: 'Speaker' });

  // NOT in dashboard.test.yaml — every filtering assertion keys off this one.
  ha.seed('light.secret_basement', 'on', { friendly_name: 'Secret' });
  ha.seed('lock.back_door', 'unlocked', { friendly_name: 'Back Door' });

  /* Music Assistant. `media_player.kitchen` is NOT in the fixture — it is
     reached only through discovery, which is what the browse tests need it to
     prove. `media_player.hifi` is an MA player nobody may touch, because
     discovery is what makes "not on the dashboard" a meaningful boundary. */
  ha.seedMaPlayer('media_player.kitchen', 'Kitchen');
  ha.seedRegistry('media_player.kitchen');
  ha.seedLibrary('album', 140);
  ha.seedLibrary('artist', 8);
  ha.seedLibrary('track', 30);
  ha.seedLibrary('playlist', 3);
  ha.seedLibrary('radio', 4);
  ha.maQueues.set('media_player.kitchen', {
    queue_id: 'kitchen',
    active: true,
    name: 'Kitchen',
    items: 12,
    shuffle_enabled: false,
    repeat_mode: 'off',
    current_index: 3,
    elapsed_time: 45,
    current_item: {
      queue_item_id: 'q3',
      name: 'Playing now',
      duration: 210,
      media_item: {
        media_type: 'track',
        uri: 'library://track/3',
        name: 'Playing now',
        version: '',
        image: 'http://music-assistant.local:8095/img/now.jpg',
        artists: [{ media_type: 'artist', uri: 'library://artist/3', name: 'Artist 3' }],
      },
    },
    next_item: {
      queue_item_id: 'q4',
      name: 'Coming up',
      duration: 180,
      media_item: {
        media_type: 'track',
        uri: 'library://track/4',
        name: 'Coming up',
        version: '',
        image: 'http://music-assistant.local:8095/img/next.jpg',
        artists: [{ media_type: 'artist', uri: 'library://artist/4', name: 'Artist 4' }],
        album: { media_type: 'album', uri: 'library://album/4', name: 'Album 4' },
      },
    },
  });

  await ha.start();
  backend = await startBackend();
});

after(async () => {
  await stopBackend(backend);
  await ha?.stop();
});

/* ── Tests ────────────────────────────────────────────────────────────────*/

describe('snapshot on connect', () => {
  test('delivers config and entity states in the first frame', async () => {
    const panel = new TestPanel();
    await panel.connect();

    assert.equal(panel.messages[0].t, 'hello', 'hello must be the first message');
    assert.equal(panel.config.ui.title, 'Test Panel');
    assert.equal(panel.config.rooms.length, 1);

    await waitFor(() => panel.states.has('light.living_room'), 'entity states');

    const light = panel.states.get('light.living_room');
    assert.equal(light.s, 'on');
    assert.equal(light.a.brightness, 128);
    assert.equal(light.a.friendly_name, 'Living Room');

    panel.close();
  });

  test('converts HA float seconds to epoch milliseconds', async () => {
    const panel = new TestPanel();
    await panel.connect();
    await waitFor(() => panel.states.has('light.living_room'), 'entity states');

    const { lc, lu } = panel.states.get('light.living_room');

    // Seconds would be ~1.7e9; milliseconds ~1.7e12. Getting this wrong makes
    // every "last changed" read as 1970.
    assert.ok(lc > 1e12, `lc should be epoch ms, got ${lc}`);
    assert.ok(Number.isInteger(lc), 'lc should be an integer');

    // HA OMITS lu when it equals lc. Missing must not become 0 or undefined.
    assert.equal(lu, lc, 'lu should fall back to lc when HA omits it');

    panel.close();
  });

  test('sends only entities the dashboard config references', async () => {
    const panel = new TestPanel();
    await panel.connect();
    await waitFor(() => panel.states.size >= 7, 'entity states');

    assert.ok(panel.states.has('light.living_room'));
    assert.ok(
      !panel.states.has('light.secret_basement'),
      'unreferenced entities must never reach the panel',
    );
    assert.ok(!panel.states.has('lock.back_door'));

    panel.close();
  });
});

describe('incremental updates', () => {
  test('applies a state change', async () => {
    const panel = new TestPanel();
    await panel.connect();
    await waitFor(() => panel.states.has('light.living_room'), 'entity states');

    ha.change('light.living_room', { state: 'off' });

    await waitFor(
      () => panel.states.get('light.living_room')?.s === 'off',
      'light to turn off',
    );
    panel.close();
  });

  test('applies an attribute-only change without touching other attributes', async () => {
    const panel = new TestPanel();
    await panel.connect();
    await waitFor(() => panel.states.has('light.living_room'), 'entity states');

    ha.change('light.living_room', { state: 'on', attributes: { brightness: 200 } });

    await waitFor(
      () => panel.states.get('light.living_room')?.a.brightness === 200,
      'brightness change',
    );

    // The change diff carries ONLY brightness; unrelated attributes must
    // survive. This is what breaks if the diff is treated as a replacement.
    const light = panel.states.get('light.living_room');
    assert.equal(light.a.friendly_name, 'Living Room');
    assert.deepEqual(light.a.supported_color_modes, ['color_temp']);

    panel.close();
  });

  test('removes attributes listed under the "-" key', async () => {
    const panel = new TestPanel();
    await panel.connect();
    await waitFor(
      () => panel.states.get('climate.thermostat')?.a.temperature === 21,
      'climate state',
    );

    ha.change('climate.thermostat', {
      attributes: { current_temperature: 20 },
      removeAttributes: ['temperature'],
    });

    await waitFor(
      () => panel.states.get('climate.thermostat')?.a.current_temperature === 20,
      'temperature update',
    );

    const climate = panel.states.get('climate.thermostat');
    assert.ok(
      !('temperature' in climate.a),
      'attributes named under "-" must be deleted, not left stale',
    );

    panel.close();
  });

  test('sends a diff, not the whole state', async () => {
    const panel = new TestPanel();
    await panel.connect();
    await waitFor(() => panel.states.has('cover.blinds'), 'entity states');

    const mark = panel.messageCount;
    ha.change('cover.blinds', { attributes: { current_position: 42 } });

    await waitFor(
      () => panel.states.get('cover.blinds')?.a.current_position === 42,
      'cover position',
    );

    const patches = panel.since(mark).filter((m) => m.t === 'patch');
    assert.ok(patches.length > 0, 'expected a patch');

    const diff = patches[0].patch.chg?.['cover.blinds'];
    assert.ok(diff, 'expected a change entry');
    assert.deepEqual(
      Object.keys(diff.a ?? {}),
      ['current_position'],
      'only the changed attribute should be on the wire',
    );
    assert.ok(!diff.a?.friendly_name, 'unchanged attributes must not be resent');

    panel.close();
  });

  test('handles coalesced multi-message frames', async () => {
    const panel = new TestPanel();
    await panel.connect();
    await waitFor(() => panel.states.has('light.living_room'), 'entity states');

    // With coalesce_messages on, HA batches these into ONE JSON array frame.
    // A client that assumes one message per frame drops all but the first —
    // and only under load, which is the worst time to find out.
    ha.burst([
      { id: 'light.living_room', state: 'off' },
      { id: 'cover.blinds', state: 'closed' },
      { id: 'climate.thermostat', attributes: { current_temperature: 18 } },
    ]);

    await waitFor(
      () =>
        panel.states.get('light.living_room')?.s === 'off' &&
        panel.states.get('cover.blinds')?.s === 'closed' &&
        panel.states.get('climate.thermostat')?.a.current_temperature === 18,
      'all three coalesced changes to apply',
    );

    panel.close();
  });

  test('does not wake panels for unreferenced entities', async () => {
    const panel = new TestPanel();
    await panel.connect();
    await waitFor(() => panel.states.size >= 7, 'entity states');

    const mark = panel.messageCount;
    ha.change('light.secret_basement', { state: 'off' });
    ha.change('lock.back_door', { state: 'locked' });

    // Give it long enough that a leak would have shown up.
    await sleep(400);

    assert.equal(
      panel.since(mark).filter((m) => m.t === 'patch').length,
      0,
      'changes to unreferenced entities must not reach the panel at all',
    );

    panel.close();
  });

  test('removes entities sent under the "r" key', async () => {
    const panel = new TestPanel();
    await panel.connect();
    await waitFor(() => panel.states.has('scene.movie_night'), 'entity states');

    ha.remove('scene.movie_night');

    // `r`, not `d` — reading the wrong key means deleted entities linger
    // forever showing their last known state.
    await waitFor(() => !panel.states.has('scene.movie_night'), 'entity removal');

    panel.close();
  });
});

describe('service calls', () => {
  test('forwards an allowed call to Home Assistant', async () => {
    const panel = new TestPanel();
    await panel.connect();
    await waitFor(() => panel.states.has('light.living_room'), 'entity states');

    const before = ha.serviceCalls.length;
    panel.send({
      t: 'call',
      id: 1,
      domain: 'light',
      service: 'turn_on',
      entity: 'light.living_room',
      data: { brightness_pct: 60 },
    });

    const call = await waitFor(
      () => ha.serviceCalls.slice(before).find((c) => c.domain === 'light'),
      'service call to reach HA',
    );

    assert.equal(call.service, 'turn_on');
    assert.deepEqual(call.target, { entity_id: 'light.living_room' });
    assert.equal(call.service_data.brightness_pct, 60);

    panel.close();
  });

  test('refuses a join that names a player the panel may not touch', async () => {
    /*
     * `group_members` is a list of ENTITY IDS, so it re-targets the call at
     * every speaker it names. Without checking each one, allowing the key
     * would hand a compromised panel any media player in the house — the
     * exact hole the service-data allow-list exists to close.
     */
    const panel = new TestPanel();
    await panel.connect();

    const before = ha.serviceCalls.length;
    panel.send({
      t: 'call',
      id: 77,
      domain: 'media_player',
      service: 'join',
      entity: 'media_player.speaker',
      data: { group_members: ['media_player.not_on_the_dashboard'] },
    });

    const error = await waitFor(
      () => panel.errors.find((e) => e.ref === 77),
      'a refusal for the unknown player',
    );
    assert.match(error.message, /not permitted/i);
    assert.equal(
      ha.serviceCalls.slice(before).filter((c) => c.service === 'join').length,
      0,
      'nothing reached Home Assistant',
    );

    panel.close();
  });

  test('refuses a join whose group_members is not a list of ids', async () => {
    const panel = new TestPanel();
    await panel.connect();
    const before = ha.serviceCalls.length;

    for (const [i, bad] of [
      'media_player.speaker',
      [{ entity_id: 'media_player.speaker' }],
      [42],
      ['light.kitchen'],
    ].entries()) {
      panel.send({
        t: 'call',
        id: 800 + i,
        domain: 'media_player',
        service: 'join',
        entity: 'media_player.speaker',
        data: { group_members: bad },
      });
      await waitFor(() => panel.errors.find((e) => e.ref === 800 + i), `refusal for ${i}`);
    }

    assert.equal(
      ha.serviceCalls.slice(before).filter((c) => c.service === 'join').length,
      0,
      'none of them reached Home Assistant',
    );
    panel.close();
  });

  test('refuses a call for an entity the dashboard does not reference', async () => {
    const panel = new TestPanel();
    await panel.connect();
    await waitFor(() => panel.states.has('light.living_room'), 'entity states');

    const before = ha.serviceCalls.length;
    const mark = panel.messageCount;

    // The whole point of the allow-list: a panel cannot unlock a door that
    // was never put on the dashboard.
    panel.send({
      t: 'call',
      id: 2,
      domain: 'lock',
      service: 'unlock',
      entity: 'lock.back_door',
    });

    await waitFor(
      () => panel.since(mark).find((m) => m.t === 'error'),
      'an error response',
    );

    await sleep(200);
    assert.equal(
      ha.serviceCalls.length,
      before,
      'the call must never reach Home Assistant',
    );

    panel.close();
  });

  test('refuses a service outside the allow-list', async () => {
    const panel = new TestPanel();
    await panel.connect();
    await waitFor(() => panel.states.has('light.living_room'), 'entity states');

    const before = ha.serviceCalls.length;
    const mark = panel.messageCount;

    panel.send({
      t: 'call',
      id: 3,
      domain: 'light',
      service: 'delete_everything',
      entity: 'light.living_room',
    });

    await waitFor(() => panel.since(mark).find((m) => m.t === 'error'), 'an error response');
    await sleep(200);
    assert.equal(ha.serviceCalls.length, before);

    panel.close();
  });

  test('strips service_data keys that are not allow-listed', async () => {
    const panel = new TestPanel();
    await panel.connect();
    await waitFor(() => panel.states.has('light.living_room'), 'entity states');

    const before = ha.serviceCalls.length;
    panel.send({
      t: 'call',
      id: 4,
      domain: 'light',
      service: 'turn_on',
      entity: 'light.living_room',
      // entity_id in service_data would let a caller re-target the call past
      // the allow-list check. It must be dropped.
      data: { brightness_pct: 50, entity_id: 'lock.back_door', evil: true },
    });

    const call = await waitFor(
      () => ha.serviceCalls.slice(before).find((c) => c.service === 'turn_on'),
      'service call to reach HA',
    );

    assert.deepEqual(call.target, { entity_id: 'light.living_room' });
    assert.equal(call.service_data.brightness_pct, 50);
    assert.ok(!('entity_id' in call.service_data), 'entity_id must be stripped');
    assert.ok(!('evil' in call.service_data), 'unknown keys must be stripped');

    panel.close();
  });

  test('refuses a service aimed at a mismatched entity domain', async () => {
    const panel = new TestPanel();
    await panel.connect();
    await waitFor(() => panel.states.has('light.living_room'), 'entity states');

    const before = ha.serviceCalls.length;
    const mark = panel.messageCount;

    // lock.unlock aimed at a light: on the dashboard, an allowed service, but
    // nonsense — and the kind of thing a confused or hostile client sends.
    panel.send({
      t: 'call',
      id: 5,
      domain: 'lock',
      service: 'unlock',
      entity: 'light.living_room',
    });

    await waitFor(() => panel.since(mark).find((m) => m.t === 'error'), 'an error response');
    await sleep(200);
    assert.equal(ha.serviceCalls.length, before);

    panel.close();
  });
});

describe('resilience', () => {
  test('a brief Home Assistant restart is invisible to the panel', async () => {
    const panel = new TestPanel();
    await panel.connect();
    await waitFor(() => panel.states.get('light.living_room')?.s === 'off', 'stable state');

    await sleep(200);
    const mark = panel.messageCount;

    // A Home Assistant update restart: the socket drops and comes back well
    // inside the grace period.
    ha.dropConnections();
    await waitFor(() => ha.connectionCount > 0, 'backend to reconnect', 10_000);
    await sleep(400);

    const received = panel.since(mark);

    // This is the property that matters. Nothing about the house changed, so
    // the dashboard must not flicker: no entity may be greyed out, and the
    // resync must not repaint every card.
    assert.ok(
      !received.some(
        (m) =>
          m.t === 'patch' &&
          Object.values(m.patch.chg ?? {}).some((d) => d.s === 'unavailable'),
      ),
      'a brief restart must not mark anything unavailable',
    );

    const addCount = received
      .filter((m) => m.t === 'patch')
      .reduce((n, m) => n + Object.keys(m.patch.add ?? {}).length, 0);

    assert.equal(
      addCount,
      0,
      `resync must diff, not repaint — got ${addCount} re-added entities for an ` +
        'HA restart in which nothing actually changed',
    );

    // The connection indicator is what carries the truth during the blip.
    assert.ok(
      received.some((m) => m.t === 'health'),
      'the panel must still be told the link state changed',
    );

    panel.close();
  });

  test('a change made while disconnected is picked up by the resync', async () => {
    const panel = new TestPanel();
    await panel.connect();
    await waitFor(() => panel.states.has('cover.blinds'), 'entity states');

    ha.dropConnections();

    // Someone opens the blinds while the backend is not listening. The resync
    // diff has to notice — this is the risk of diffing instead of repainting.
    ha.states.get('cover.blinds').s = 'open';
    ha.states.get('cover.blinds').a.current_position = 88;

    await waitFor(
      () => panel.states.get('cover.blinds')?.a.current_position === 88,
      'the missed change to arrive on resync',
      10_000,
    );

    assert.equal(panel.states.get('cover.blinds').s, 'open');
    panel.close();
  });

  test('a sustained outage marks entities unavailable', async () => {
    const panel = new TestPanel();
    await panel.connect();
    await waitFor(() => panel.states.has('light.living_room'), 'entity states');

    // Stop the server entirely so reconnection attempts genuinely fail.
    await ha.stop();

    // HA_UNAVAILABLE_GRACE_MS is set to 1500 for this suite.
    await waitFor(
      () => panel.states.get('light.living_room')?.s === 'unavailable',
      'entities to go unavailable after the grace period',
      10_000,
    );

    // Cards stay on screen — the layout must not collapse, only the values
    // stop claiming to be current.
    assert.ok(panel.states.has('light.living_room'), 'entity must remain, just unavailable');
    assert.ok(panel.states.size >= 6, 'no entities should vanish from the panel');

    panel.close();
  });

  test('recovers real state when Home Assistant comes back', async () => {
    const panel = new TestPanel();
    await panel.connect();
    assert.equal(panel.states.get('light.living_room')?.s, 'unavailable');

    await ha.start();

    await waitFor(
      () => panel.states.get('light.living_room')?.s !== 'unavailable',
      'state to be restored after recovery',
      20_000,
    );

    assert.ok(ha.connectionCount > 0, 'backend should have reconnected');
    panel.close();
  });
});

describe('authentication', () => {
  test('rejects a WebSocket upgrade with no token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PANEL_PORT}/ws`);
    const error = await new Promise((resolve) => {
      ws.once('error', resolve);
      ws.once('open', () => resolve(null));
    });
    assert.ok(error, 'unauthenticated upgrade must be rejected');
    assert.match(error.message, /401/);
  });

  test('rejects a WebSocket upgrade with a wrong token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PANEL_PORT}/ws?t=wrong`);
    const error = await new Promise((resolve) => {
      ws.once('error', resolve);
      ws.once('open', () => resolve(null));
    });
    assert.ok(error, 'bad token must be rejected');
  });

  test('health endpoint stays open for the container healthcheck', async () => {
    const res = await fetch(`http://127.0.0.1:${PANEL_PORT}/api/health`);
    assert.ok(res.ok);
    const body = await res.json();
    assert.equal(body.ok, true);
    // It must not leak anything about the house.
    assert.ok(!('states' in body));
    assert.ok(!('config' in body));
  });
});

describe('entity naming', () => {
  test('accepts both bare ids and { entity, name } objects', async () => {
    const panel = new TestPanel();
    await panel.connect();

    const room = panel.config.rooms[0];

    // Both forms normalise to the same shape, so nothing downstream branches.
    assert.deepEqual(
      room.entities.map((e) => e.entity),
      ['light.living_room', 'cover.blinds', 'climate.thermostat'],
      'duplicate entries must be dropped',
    );

    assert.equal(room.entities[0].name, undefined, 'bare id carries no name override');
    assert.equal(room.entities[1].name, 'Window Blinds', 'object form carries its name');

    const favs = panel.config.home.favorites;
    assert.equal(favs[0].entity, 'light.living_room');
    assert.equal(favs[0].name, undefined);
    assert.equal(favs[1].entity, 'lock.front_door');
    assert.equal(favs[1].name, 'Front Door Lock');

    panel.close();
  });

  test('a named entity is still subject to the service allow-list', async () => {
    const panel = new TestPanel();
    await panel.connect();
    await waitFor(() => panel.states.has('cover.blinds'), 'entity states');

    // Naming an entity must not change what it is permitted to do — the
    // allow-list keys off entity ids, never display names.
    const before = ha.serviceCalls.length;
    panel.send({
      t: 'call',
      id: 90,
      domain: 'cover',
      service: 'open_cover',
      entity: 'cover.blinds',
    });

    const call = await waitFor(
      () => ha.serviceCalls.slice(before).find((c) => c.domain === 'cover'),
      'named entity to still be controllable',
    );
    assert.deepEqual(call.target, { entity_id: 'cover.blinds' });

    panel.close();
  });
});

describe('artwork proxy', () => {
  /**
   * This route turns a caller-supplied string into an outbound request, which
   * is the classic shape of a server-side request forgery hole. These assert
   * the guard rejects every way of naming a host other than Home Assistant.
   */
  const reject = [
    ['absolute http URL', 'http://evil.example/x.png'],
    ['absolute https URL', 'https://evil.example/x.png'],
    ['protocol-relative', '//evil.example/x.png'],
    ['file scheme', 'file:///etc/passwd'],
    ['non-/api path', '/local/secret.png'],
    ['root path', '/'],
    ['traversal', '/api/../../etc/passwd'],
    ['encoded traversal', '%2Fapi%2F..%2F..%2Fetc%2Fpasswd'],
    ['backslash host', '/\\evil.example/x.png'],
    ['encoded absolute URL', 'http%3A%2F%2Fevil.example%2Fx.png'],
    ['null byte', '/api/x%00.png'],
  ];

  for (const [label, path] of reject) {
    test(`refuses ${label}`, async () => {
      const res = await fetch(
        `http://127.0.0.1:${PANEL_PORT}/img/ha?p=${encodeURIComponent(path)}&t=${TOKEN}`,
      );
      assert.equal(res.status, 400, `${label} should be refused`);
    });
  }

  test('requires the panel token', async () => {
    const res = await fetch(
      `http://127.0.0.1:${PANEL_PORT}/img/ha?p=${encodeURIComponent('/api/image/x.png')}`,
    );
    assert.equal(res.status, 401);
  });

  test('accepts a well-formed HA path', async () => {
    // The mock HA is a WebSocket server with no HTTP image route, so this
    // gets past validation and fails upstream — 502, not 400. That is the
    // distinction being asserted: the guard let it through.
    const res = await fetch(
      `http://127.0.0.1:${PANEL_PORT}/img/ha?p=${encodeURIComponent(
        '/api/media_player_proxy/media_player.speaker?token=abc',
      )}&t=${TOKEN}`,
    );
    assert.notEqual(res.status, 400, 'a legitimate HA path must not be rejected by the guard');
    assert.ok(res.status === 502 || res.status === 404 || res.status === 415);
  });
});

describe('music browsing', () => {
  /**
   * Browsing is the only request/reply path besides photos, and it is built on
   * `return_response` — the half of Home Assistant's service protocol the rest
   * of this backend never touches. These tests exist because the failure modes
   * are silent: a service called without `return_response` is REFUSED rather
   * than answered emptily, and a wrong config entry id is a "not found" that
   * looks exactly like an empty library.
   */

  test('lists a library page, normalized and paged', async () => {
    const panel = new TestPanel();
    await panel.connect();

    const first = await panel.browse({ kind: 'library', media: 'album' });

    assert.equal(first.kind, 'list');
    assert.equal(first.offset, 0);
    assert.equal(first.items.length, 60, 'a page is BROWSE_PAGE items');
    assert.equal(first.more, true, '140 albums means there is another page');

    const item = first.items[0];
    assert.equal(item.u, 'library://album/0');
    assert.equal(item.n, 'album 000');
    assert.equal(item.k, 'album');
    assert.equal(item.s, 'Artist 0', 'an album is subtitled by its artist');

    // Page two must be DIFFERENT items, not the same page echoed back — the
    // offset has to survive the whole path to Music Assistant. It counts
    // ITEMS, as Music Assistant does, not pages.
    const second = await panel.browse({ kind: 'library', media: 'album', offset: 60 });
    assert.equal(second.offset, 60);
    assert.equal(second.items[0].u, 'library://album/60');

    // The last page must not claim there is another.
    const last = await panel.browse({ kind: 'library', media: 'album', offset: 120 });
    assert.equal(last.items.length, 20);
    assert.equal(last.more, false);

    panel.close();
  });

  test('asks for the response, so Home Assistant does not refuse the call', async () => {
    /*
     * `search`, `get_library` and `get_queue` are all SupportsResponse.ONLY.
     * Calling one WITHOUT return_response is a hard error from HA, not an
     * empty answer — the mock reproduces that, so a regression here fails
     * loudly rather than showing an empty library.
     */
    const panel = new TestPanel();
    await panel.connect();

    const before = ha.serviceCalls.length;
    await panel.browse({ kind: 'library', media: 'artist' });

    const call = ha.serviceCalls.slice(before).find((c) => c.service === 'get_library');
    assert.ok(call, 'get_library must have been called');
    assert.equal(call.return_response, true);
    assert.equal(call.domain, 'music_assistant');

    panel.close();
  });

  test('discovers the config entry id from the entity registry', async () => {
    /*
     * `search` and `get_library` target a CONFIG ENTRY, not an entity. Nothing
     * in dashboard.yaml names it, so it is discovered by asking the registry
     * about a Music Assistant entity. If that lookup broke, every library call
     * would be rejected as "config entry not found" — which the mock enforces.
     */
    const panel = new TestPanel();
    await panel.connect();

    await panel.browse({ kind: 'library', media: 'artist' });

    const call = ha.serviceCalls.find((c) => c.service === 'get_library');
    assert.equal(call.service_data.config_entry_id, ha.maConfigEntry);

    panel.close();
  });

  test('recently played sorts by last played rather than by name', async () => {
    const panel = new TestPanel();
    await panel.connect();

    const before = ha.serviceCalls.length;
    const result = await panel.browse({ kind: 'library', media: 'track', recent: true });

    const call = ha.serviceCalls.slice(before).find((c) => c.service === 'get_library');
    assert.equal(call.service_data.order_by, 'last_played_desc');
    // And the order actually differs from the default, so this is not a flag
    // that gets sent and ignored.
    assert.equal(result.items[0].u, 'library://track/29');

    panel.close();
  });

  test('favorites asks Music Assistant to filter, rather than filtering here', async () => {
    const panel = new TestPanel();
    await panel.connect();

    const before = ha.serviceCalls.length;
    const result = await panel.browse({ kind: 'library', media: 'album', favorite: true });

    const call = ha.serviceCalls.slice(before).find((c) => c.service === 'get_library');
    assert.equal(call.service_data.favorite, true);
    // 140 albums, every fourth one a favorite.
    assert.equal(result.items.length, 35);

    panel.close();
  });

  test('search returns non-empty groups in a sensible order', async () => {
    const panel = new TestPanel();
    await panel.connect();

    const result = await panel.browse({ kind: 'search', text: 'album 01' });

    assert.equal(result.kind, 'groups');
    const names = result.groups.map((g) => g.name);
    assert.deepEqual(names, ['Albums'], 'only groups with matches are sent');
    assert.ok(result.groups[0].items.length > 0);
    assert.equal(result.groups[0].items[0].k, 'album');

    panel.close();
  });

  test('an empty search is answered without troubling Music Assistant', async () => {
    const panel = new TestPanel();
    await panel.connect();

    const before = ha.serviceCalls.length;
    const result = await panel.browse({ kind: 'search', text: '   ' });

    assert.deepEqual(result, { kind: 'groups', groups: [] });
    await sleep(150);
    assert.equal(
      ha.serviceCalls.slice(before).filter((c) => c.service === 'search').length,
      0,
      'whitespace is not a query',
    );

    panel.close();
  });

  test('reports the queue for a player the panel may see', async () => {
    const panel = new TestPanel();
    await panel.connect();
    await waitFor(() => panel.states.has('media_player.kitchen'), 'the discovered MA player');

    const result = await panel.browse({ kind: 'queue', entity: 'media_player.kitchen' });

    assert.equal(result.kind, 'queue');
    assert.equal(result.items, 12);
    assert.equal(result.index, 3);
    assert.equal(result.current.n, 'Playing now');
    assert.equal(result.next.n, 'Coming up');
    assert.equal(result.next.s, 'Artist 4 · Album 4');

    panel.close();
  });

  test('refuses a queue lookup for a player that is not on the dashboard', async () => {
    /*
     * Browsing must not become a side channel around the allow-list. This
     * targets a media_player the config never names and discovery never
     * surfaced, so the only thing standing between the panel and it is the
     * check in the browser itself.
     */
    const panel = new TestPanel();
    await panel.connect();

    const before = ha.serviceCalls.length;
    await assert.rejects(
      () => panel.browse({ kind: 'queue', entity: 'media_player.not_a_thing' }),
      /Not permitted/,
    );

    await sleep(150);
    assert.equal(
      ha.serviceCalls.slice(before).filter((c) => c.service === 'get_queue').length,
      0,
      'the call must not reach Home Assistant at all',
    );

    panel.close();
  });

  test('never hands the panel a Music Assistant URL', async () => {
    /*
     * Cover art comes back from Music Assistant as an absolute URL on its own
     * host. Forwarding that would both leak where Music Assistant lives and
     * break for every panel that cannot resolve a container hostname — so the
     * backend swaps it for a key on our own origin. This asserts the raw URL
     * appears nowhere in what the panel receives.
     */
    const panel = new TestPanel();
    await panel.connect();

    const result = await panel.browse({ kind: 'library', media: 'album' });
    const wire = JSON.stringify(result);

    assert.ok(!wire.includes('music-assistant.local'), 'the upstream host must not be sent');
    assert.ok(!wire.includes('8095'), 'the upstream port must not be sent');
    for (const item of result.items) {
      assert.match(item.a, /^\/img\/art\?k=[0-9a-f]{16}$/);
    }

    panel.close();
  });

  test('the artwork route takes keys, not URLs', async () => {
    /*
     * The obvious version of this proxy — /img/art?url=… — would let a panel
     * choose which host this process connects to, on a trusted LAN. There is
     * no key a panel can compose: it is a digest of a URL Music Assistant
     * itself produced.
     */
    const panel = new TestPanel();
    await panel.connect();
    await panel.browse({ kind: 'library', media: 'album' });

    const bad = [
      ['a URL', 'http://evil.example/x.png'],
      ['a made-up key', 'deadbeefdeadbeef'],
      ['a path', '../../etc/passwd'],
      ['nothing', ''],
    ];

    for (const [label, key] of bad) {
      const res = await fetch(
        `http://127.0.0.1:${PANEL_PORT}/img/art?k=${encodeURIComponent(key)}&t=${TOKEN}`,
      );
      assert.ok(res.status === 400 || res.status === 404, `${label} must not be fetched`);
    }

    const noAuth = await fetch(`http://127.0.0.1:${PANEL_PORT}/img/art?k=0123456789abcdef`);
    assert.equal(noAuth.status, 401, 'the route requires the panel token');

    panel.close();
  });

  test('explains itself when Music Assistant cannot answer', async () => {
    const panel = new TestPanel();
    await panel.connect();

    // Music Assistant removed and re-added: the id we discovered is stale.
    const real = ha.maConfigEntry;
    ha.maConfigEntry = 'a-different-entry';
    try {
      await assert.rejects(
        () => panel.browse({ kind: 'library', media: 'album' }),
        /Music Assistant/,
        'the panel must be told, not left on a spinner',
      );
    } finally {
      ha.maConfigEntry = real;
    }

    // And it must recover on its own once the entry is valid again, rather
    // than needing the backend restarted.
    const after = await panel.browse({ kind: 'library', media: 'artist' });
    assert.equal(after.kind, 'list');
    assert.equal(after.items.length, 8);

    panel.close();
  });
});

describe('playing something', () => {
  test('forwards a library URI to music_assistant.play_media', async () => {
    const panel = new TestPanel();
    await panel.connect();

    const before = ha.serviceCalls.length;
    panel.send({
      t: 'call',
      id: 200,
      domain: 'music_assistant',
      service: 'play_media',
      entity: 'media_player.speaker',
      data: { media_id: 'library://album/7', enqueue: 'replace' },
    });

    const call = await waitFor(
      () => ha.serviceCalls.slice(before).find((c) => c.domain === 'music_assistant'),
      'play_media to reach HA',
    );

    assert.equal(call.service, 'play_media');
    // An integration service targets an entity from ANOTHER domain. The guard
    // has to permit exactly that pairing without loosening the general rule.
    assert.deepEqual(call.target, { entity_id: 'media_player.speaker' });
    assert.equal(call.service_data.media_id, 'library://album/7');
    assert.equal(call.service_data.enqueue, 'replace');

    panel.close();
  });

  test('refuses a media_id that is not a library URI', async () => {
    /*
     * Music Assistant will play a local file path or fetch an arbitrary URL if
     * handed one. Left unchecked, "play this album" becomes a way to read the
     * Music Assistant host's disk, or to make it fetch a URL of the caller's
     * choosing from inside the LAN.
     */
    const refuse = [
      ['a local file', 'file:///etc/passwd'],
      ['a bare path', '/etc/shadow'],
      ['an http URL', 'http://evil.example/payload.mp3'],
      ['an https URL', 'https://evil.example/payload.mp3'],
      ['a data URL', 'data:audio/mp3;base64,AAAA'],
      ['an empty string', ''],
      ['a number', 42],
      ['an empty list', []],
    ];

    const panel = new TestPanel();
    await panel.connect();

    for (const [label, mediaId] of refuse) {
      const before = ha.serviceCalls.length;
      const mark = panel.messageCount;

      panel.send({
        t: 'call',
        id: 201,
        domain: 'music_assistant',
        service: 'play_media',
        entity: 'media_player.speaker',
        data: { media_id: mediaId },
      });

      await waitFor(() => panel.since(mark).find((m) => m.t === 'error'), `refusal of ${label}`);
      await sleep(100);
      assert.equal(
        ha.serviceCalls.slice(before).filter((c) => c.domain === 'music_assistant').length,
        0,
        `${label} must not reach Home Assistant`,
      );
    }

    panel.close();
  });

  test('refuses the Music Assistant services that are not play_media', async () => {
    /*
     * `play_announcement` makes a speaker fetch and play an arbitrary URL, and
     * `transfer_queue` re-targets a second player. Neither is on the allow-list
     * and neither should become reachable by adding the domain.
     */
    const panel = new TestPanel();
    await panel.connect();

    for (const service of ['play_announcement', 'transfer_queue', 'get_library']) {
      const before = ha.serviceCalls.length;
      const mark = panel.messageCount;

      panel.send({
        t: 'call',
        id: 202,
        domain: 'music_assistant',
        service,
        entity: 'media_player.speaker',
        data: { url: 'http://evil.example/x.mp3' },
      });

      await waitFor(() => panel.since(mark).find((m) => m.t === 'error'), `refusal of ${service}`);
      await sleep(100);
      assert.equal(
        ha.serviceCalls.slice(before).filter((c) => c.domain === 'music_assistant').length,
        0,
        `${service} must not reach Home Assistant`,
      );
    }

    panel.close();
  });

  test('still refuses a player that is not on the dashboard', async () => {
    const panel = new TestPanel();
    await panel.connect();

    const before = ha.serviceCalls.length;
    const mark = panel.messageCount;

    panel.send({
      t: 'call',
      id: 203,
      domain: 'music_assistant',
      service: 'play_media',
      entity: 'media_player.nowhere',
      data: { media_id: 'library://album/1' },
    });

    await waitFor(() => panel.since(mark).find((m) => m.t === 'error'), 'an error response');
    await sleep(100);
    assert.equal(
      ha.serviceCalls.slice(before).filter((c) => c.domain === 'music_assistant').length,
      0,
    );

    panel.close();
  });
});
