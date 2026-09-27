import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

/**
 * Coming back to the page the panel was left on.
 *
 * The storage half of this is covered against a real backend in
 * server/test/photos.test.mjs. What is left is the timing, and the timing is
 * where this can go wrong in ways nobody notices until a panel on a wall
 * does something rude:
 *
 *  - restoring more than once, so a Wi-Fi roam drags whoever is standing at
 *    the panel back to a page they had already left;
 *  - never re-syncing, so navigating while the socket is down means the
 *    backend keeps handing back the page from before the drop;
 *  - restoring to a page the nav no longer shows.
 *
 * `~/net/socket.ts` is stubbed to record writes. Everything else — the route
 * signal, `visibleRoutes`, the preference defaults — is the real module,
 * because those are exactly the parts whose behaviour is being asserted.
 */

const bundle = await build({
  stdin: {
    contents: `export { startPageMemory, resetPageMemory } from './state/lastPage.ts';
      export { route, prefs, ready, socketState, navigate } from './state/ui.ts';
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

async function setup(t) {
  const saved = globalThis.window;
  // ui.ts only reaches for matchMedia when a window exists; leaving it off
  // keeps the rail/bar logic out of a test that is not about layout.
  globalThis.window = undefined;

  const mod = await import('data:text/javascript;base64,'
    + Buffer.from(bundle.outputFiles[0].text).toString('base64') + `#${++moduleId}`);

  t.after(() => {
    mod.resetPageMemory();
    globalThis.window = saved;
  });

  mod.startPageMemory();
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

test('a reconnect does not drag the user off the page they are on', async (t) => {
  const mod = await setup(t);
  hello(mod, { lastPage: 'controls' });
  await flush();

  mod.navigate('media');
  await flush();
  assert.equal(mod.route.value, 'media');

  // The socket drops and comes back. `hello` carries the whole world again,
  // including a lastPage that may be older than where the panel now is.
  drop(mod);
  hello(mod, { lastPage: 'controls' });
  await flush();

  assert.equal(mod.route.value, 'media', 'still on the page the user chose');
});

test('navigating while disconnected is pushed up on reconnect', async (t) => {
  const mod = await setup(t);
  hello(mod, { lastPage: 'home' });
  await flush();
  mod.writes.length = 0;

  /*
   * Writes are fire-and-forget, so one made with the socket down is simply
   * lost. Simulated by moving the route and rolling the stored value back to
   * what the backend would still be holding.
   */
  mod.navigate('photos');
  await flush();
  mod.prefs.value = { ...mod.prefs.peek(), lastPage: 'home' };
  mod.writes.length = 0;

  drop(mod);
  hello(mod, { lastPage: 'home' });
  await flush();

  assert.equal(mod.route.value, 'photos', 'the panel stays where it is');
  assert.deepEqual(
    mod.writes,
    [{ key: 'lastPage', value: 'photos' }],
    'and tells the backend, which was still holding the page from before the drop',
  );
});

test('every navigation is recorded, and nothing else is', async (t) => {
  const mod = await setup(t);
  hello(mod, { lastPage: null });
  await flush();
  mod.writes.length = 0;

  mod.navigate('rooms');
  mod.navigate('media');
  await flush();

  assert.deepEqual(mod.writes, [
    { key: 'lastPage', value: 'rooms' },
    { key: 'lastPage', value: 'media' },
  ]);

  // Navigating to where you already are is not a navigation.
  mod.navigate('media');
  await flush();
  assert.equal(mod.writes.length, 2, 'no write for a no-op navigation');
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
  hello(mod, { lastPage: 'controls', rememberPage: false });
  await flush();

  assert.equal(mod.route.value, 'home', 'a stored page is ignored');

  mod.navigate('media');
  await flush();
  assert.deepEqual(mod.writes, [], 'and nothing new is recorded');
});

test('a remembered page that is no longer in the nav is not restored', async (t) => {
  const mod = await setup(t);
  hello(mod, { lastPage: 'controls', visiblePages: ['home', 'media'] });
  await flush();

  assert.equal(mod.route.value, 'home', 'a hidden page is not somewhere to land');
});
