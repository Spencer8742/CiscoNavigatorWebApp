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
