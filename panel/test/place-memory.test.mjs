import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

/**
 * Coming back to where the panel was left — the page, and the place in it.
 *
 * The storage half is covered against a real backend in
 * server/test/photos.test.mjs. What is left is the timing and the config
 * checks, which is where this can go wrong in ways nobody notices until a
 * panel on a wall does something rude:
 *
 *  - restoring more than once, so a Wi-Fi roam drags whoever is standing at
 *    the panel back to a page they had already left;
 *  - never re-syncing, so moving around while the socket is down means the
 *    backend keeps handing back where the panel was before the drop;
 *  - restoring into a room or a macro page that dashboard.yaml no longer
 *    has, which lands on an empty screen titled "Room".
 *
 * Only `~/net/socket.ts` is stubbed, to record writes. The route and config
 * signals, `visibleRoutes`, `roomsById` and the preference defaults are all
 * the real modules — those are the parts whose behaviour is being asserted.
 */

const bundle = await build({
  stdin: {
    contents: `export { startPlaceMemory, resetPlaceMemory } from './state/place.ts';
      export { route, prefs, ready, socketState, navigate, activeRoom, controlPage }
        from './state/ui.ts';
      export { config } from './config/index.ts';
      export { writes } from '~/net/socket.ts';`,
    resolveDir: new URL('../src', import.meta.url).pathname,
  },
  tsconfig: new URL('../tsconfig.json', import.meta.url).pathname,
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  define: { __APP_VERSION__: '"test"' },
  plugins: [{
    name: 'socket-fixture',
    setup(builder) {
      builder.onResolve({ filter: /^~\/net\/socket\.ts$/ }, ({ path }) => ({
        path,
        namespace: 'fixture',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
        contents: `export const writes = [];
          export function setPref(key, value) {
            writes.push({ key, value });
            return true;
          }`,
        loader: 'js',
      }));
    },
  }],
});

let moduleId = 0;

const ROOMS = [
  { id: 'kitchen', name: 'Kitchen', icon: 'home', entities: [] },
  { id: 'office', name: 'Office', icon: 'home', entities: [] },
];
const CONTROL_PAGES = [
  { id: 'lights', name: 'Lights', icon: 'light', items: [] },
  { id: 'scenes', name: 'Scenes', icon: 'star', items: [] },
];

async function setup(t) {
  const saved = globalThis.window;
  // ui.ts only reaches for matchMedia when a window exists; leaving it off
  // keeps the rail/bar logic out of a test that is not about layout.
  globalThis.window = undefined;

  const mod = await import('data:text/javascript;base64,'
    + Buffer.from(bundle.outputFiles[0].text).toString('base64') + `#${++moduleId}`);

  // A config with somewhere to go, so the restore checks have something real
  // to resolve against rather than always failing closed.
  mod.config.value = {
    ...mod.config.peek(),
    rooms: ROOMS,
    controls: { ...mod.config.peek().controls, pages: CONTROL_PAGES },
  };

  t.after(() => {
    mod.resetPlaceMemory();
    globalThis.window = saved;
  });

  mod.startPlaceMemory();
  return mod;
}

/** Signals settle synchronously; a microtask turn is enough to be sure. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * What `hello` does to this corner of the app, in the order socket.ts does
 * it — preferences, then `socketState`, then `ready`.
 *
 * The order is not decoration. `ready` is never set back to false, so after
 * the first `hello` writing it again notifies nobody; `socketState` is the
 * one that actually cycles when a connection drops and comes back. A test
 * that flipped `ready` by hand would pass against an implementation that
 * could never re-sync on a real panel.
 */
function hello(mod, overrides = {}) {
  mod.prefs.value = { ...mod.prefs.peek(), ...overrides };
  mod.socketState.value = 'connected';
  mod.ready.value = true;
}

/** And what a dropped socket does. */
function drop(mod) {
  mod.socketState.value = 'connecting';
}

test('a cold start lands on the page the panel was left on', async (t) => {
  const mod = await setup(t);
  assert.equal(mod.route.value, 'home', 'panels boot on Home');

  hello(mod, { lastPage: 'controls' });
  await flush();

  assert.equal(mod.route.value, 'controls');
});

test('a cold start lands back inside the room that was open', async (t) => {
  const mod = await setup(t);

  hello(mod, { lastPage: 'rooms', lastRoom: 'kitchen' });
  await flush();

  assert.equal(mod.route.value, 'rooms');
  assert.equal(mod.activeRoom.value, 'kitchen', 'the drill-down, not the room list');
});

test('a cold start restores the macro page Controls was showing', async (t) => {
  const mod = await setup(t);

  hello(mod, { lastPage: 'controls', lastControlPage: 'scenes' });
  await flush();

  assert.equal(mod.route.value, 'controls');
  assert.equal(mod.controlPage.value, 'scenes');
});

/*
 * The macro page is remembered whether or not the panel was left on
 * Controls, because `controlPage` already outlives leaving that screen
 * within a session. Walking back to a panel on Home and tapping Controls
 * should still find the page you were using.
 */
test('the macro page is restored even when the panel was left elsewhere', async (t) => {
  const mod = await setup(t);

  hello(mod, { lastPage: 'home', lastControlPage: 'scenes' });
  await flush();

  assert.equal(mod.route.value, 'home');
  assert.equal(mod.controlPage.value, 'scenes', 'waiting on the Controls screen');
});

test('a room the config no longer has is not restored', async (t) => {
  const mod = await setup(t);

  hello(mod, { lastPage: 'rooms', lastRoom: 'conservatory' });
  await flush();

  assert.equal(mod.route.value, 'rooms', 'the page still resolves');
  assert.equal(mod.activeRoom.value, null, 'but it lands on the room list, not an empty room');
});

test('a macro page the config no longer has is not restored', async (t) => {
  const mod = await setup(t);

  hello(mod, { lastPage: 'controls', lastControlPage: 'garage' });
  await flush();

  assert.equal(mod.controlPage.value, null, 'Controls falls back to its first page');
});

test('a reconnect does not drag the user off the page they are on', async (t) => {
  const mod = await setup(t);
  hello(mod, { lastPage: 'controls' });
  await flush();

  mod.navigate('media');
  await flush();
  assert.equal(mod.route.value, 'media');

  // The socket drops and comes back. `hello` carries the whole world again,
  // including a place that may be older than where the panel now is.
  drop(mod);
  hello(mod, { lastPage: 'controls' });
  await flush();

  assert.equal(mod.route.value, 'media', 'still on the page the user chose');
});

test('a reconnect does not reopen a room the user backed out of', async (t) => {
  const mod = await setup(t);
  hello(mod, { lastPage: 'rooms', lastRoom: 'kitchen' });
  await flush();
  assert.equal(mod.activeRoom.value, 'kitchen');

  // Backing out to the room list, the way Rooms.tsx does it.
  mod.activeRoom.value = null;
  await flush();

  drop(mod);
  hello(mod, { lastPage: 'rooms', lastRoom: 'kitchen' });
  await flush();

  assert.equal(mod.activeRoom.value, null, 'the room list stays');
});

test('moving while disconnected is pushed up on reconnect', async (t) => {
  const mod = await setup(t);
  hello(mod, { lastPage: 'home' });
  await flush();
  mod.writes.length = 0;

  /*
   * Writes are fire-and-forget, so any made with the socket down are simply
   * lost. Simulated by moving the panel and rolling the stored values back
   * to what the backend would still be holding.
   */
  mod.navigate('rooms');
  mod.activeRoom.value = 'office';
  mod.controlPage.value = 'lights';
  await flush();
  mod.prefs.value = {
    ...mod.prefs.peek(),
    lastPage: 'home',
    lastRoom: null,
    lastControlPage: null,
  };
  mod.writes.length = 0;

  drop(mod);
  hello(mod, { lastPage: 'home', lastRoom: null, lastControlPage: null });
  await flush();

  assert.equal(mod.route.value, 'rooms', 'the panel stays where it is');
  assert.equal(mod.activeRoom.value, 'office');
  assert.deepEqual(
    mod.writes.sort((a, b) => a.key.localeCompare(b.key)),
    [
      { key: 'lastControlPage', value: 'lights' },
      { key: 'lastPage', value: 'rooms' },
      { key: 'lastRoom', value: 'office' },
    ],
    'all three are re-sent, not just the page',
  );
});

test('every move is recorded, and nothing else is', async (t) => {
  const mod = await setup(t);
  hello(mod, { lastPage: null });
  await flush();
  mod.writes.length = 0;

  mod.navigate('rooms');
  mod.activeRoom.value = 'kitchen';
  mod.controlPage.value = 'scenes';
  await flush();

  assert.deepEqual(mod.writes, [
    { key: 'lastPage', value: 'rooms' },
    { key: 'lastRoom', value: 'kitchen' },
    { key: 'lastControlPage', value: 'scenes' },
  ]);

  // Setting a signal to what it already holds is not a move.
  mod.navigate('rooms');
  mod.activeRoom.value = 'kitchen';
  await flush();
  assert.equal(mod.writes.length, 3, 'no write for a no-op');
});

/*
 * `navigate()` clears the drill-down on the way out of Rooms, deliberately.
 * That null has to reach the backend: a room left in the preferences would
 * be reopened the next time `lastPage` brought the panel back to Rooms —
 * the drill-down somebody had already dismissed by walking away from it.
 */
test('leaving Rooms clears the remembered room', async (t) => {
  const mod = await setup(t);
  hello(mod, { lastPage: 'rooms', lastRoom: 'kitchen' });
  await flush();
  mod.writes.length = 0;

  mod.navigate('home');
  await flush();

  assert.equal(mod.activeRoom.value, null);
  // Sorted: `navigate()` clears the room before it sets the route, so the
  // clear lands first — an ordering this test has no reason to depend on.
  assert.deepEqual(mod.writes.sort((a, b) => a.key.localeCompare(b.key)), [
    { key: 'lastPage', value: 'home' },
    { key: 'lastRoom', value: null },
  ]);
});

test('Settings is never recorded and never restored', async (t) => {
  const mod = await setup(t);
  hello(mod, { lastPage: null });
  await flush();
  mod.writes.length = 0;

  mod.navigate('settings');
  await flush();

  assert.equal(mod.route.value, 'settings', 'you can still go there');
  assert.deepEqual(mod.writes, [], 'it is just not written down');
});

test('rememberPage off means the panel boots on Home and writes nothing', async (t) => {
  const mod = await setup(t);
  hello(mod, {
    lastPage: 'rooms',
    lastRoom: 'kitchen',
    lastControlPage: 'scenes',
    rememberPage: false,
  });
  await flush();

  assert.equal(mod.route.value, 'home', 'a stored page is ignored');
  assert.equal(mod.activeRoom.value, null, 'and so is the room');
  assert.equal(mod.controlPage.value, null, 'and the macro page');

  mod.navigate('media');
  mod.controlPage.value = 'lights';
  await flush();
  assert.deepEqual(mod.writes, [], 'and nothing new is recorded');
});

test('a remembered page that is no longer in the nav is not restored', async (t) => {
  const mod = await setup(t);
  hello(mod, { lastPage: 'controls', visiblePages: ['home', 'media'] });
  await flush();

  assert.equal(mod.route.value, 'home', 'a hidden page is not somewhere to land');
});
