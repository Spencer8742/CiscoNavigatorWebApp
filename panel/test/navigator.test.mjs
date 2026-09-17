import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export { App } from './app.tsx';
      export { Nav } from './components/Nav.tsx';
      export { deviceInfo } from './lib/device.ts';
      export { canRecordVoice, PcmRecorder } from './assist/audio.ts';
      export { ready, screensaverActive, route, openAssistAndListen, assistOpen, assistWakePaused } from './state/ui.ts';`,
    resolveDir: new URL('../src', import.meta.url).pathname,
  },
  tsconfig: new URL('../tsconfig.json', import.meta.url).pathname,
  bundle: true, write: false, format: 'esm', platform: 'browser',
  define: { __APP_VERSION__: '"test"' },
});
let moduleId = 0;
const navigatorUa = 'Mozilla/5.0 (Linux; RoomOS; Cisco Room Navigator) AppleWebKit/537.36 QtWebEngine/6.2 Chrome/102.0.0.0 Safari/537.36';
const echoUa = 'Mozilla/5.0 (Linux; Android 11; Echo Show 5; wv) AppleWebKit/537.36 Chrome/102.0.0.0 Mobile Safari/537.36';

async function setup(t, userAgent = navigatorUa, search = '') {
  const oldWindow = globalThis.window;
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  globalThis.window = { location: { search }, AudioContext: class {} };
  let captures = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    userAgent, mediaDevices: { getUserMedia: async () => { captures += 1; throw new Error('Unexpected capture'); } },
  } });
  t.after(() => {
    globalThis.window = oldWindow;
    if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator);
    else delete globalThis.navigator;
  });
  const app = await import('data:text/javascript;base64,'
    + Buffer.from(bundle.outputFiles[0].text).toString('base64') + `#${++moduleId}`);
  return { ...app, captures: () => captures };
}

function nodes(vnode) {
  if (!vnode || typeof vnode !== 'object') return [];
  if (Array.isArray(vnode)) return vnode.flatMap(nodes);
  return [vnode, ...nodes(vnode.props?.children)];
}
const contains = (tree, name) => nodes(tree).some((node) => node.type?.name === name);

test('Navigator has no Assist button, sheet, wake listener or microphone capture', async (t) => {
  const app = await setup(t);
  app.ready.value = true;
  assert.equal(app.deviceInfo().isRoomNavigator, true);
  assert.equal(app.canRecordVoice(), false);
  assert.equal(nodes(app.Nav()).some((node) => node.props?.ariaLabel === 'Assist'), false);
  assert.equal(contains(app.App(), 'AssistSheet'), false);
  assert.equal(contains(app.App(), 'AssistWakeListener'), false);
  await assert.rejects(app.PcmRecorder.start(), /disabled on Room Navigator/);
  assert.equal(app.captures(), 0);
  app.openAssistAndListen();
  assert.equal(app.assistOpen.value, false);
  assert.equal(app.assistWakePaused.value, false);
  assert.equal(contains(app.App(), 'TimerSheet'), true);
});

test('Navigator user agent variants are recognized without disabling other RoomOS devices', async (t) => {
  for (const [ua, expected] of [
    ['Mozilla/5.0 (Linux; RoomOS; Navigator)', true],
    ['Mozilla/5.0 (Linux; Cisco Webex Room Navigator)', true],
    ['Mozilla/5.0 (Linux; RoomOS; Cisco Desk Pro)', false],
    ['Mozilla/5.0 (Linux; RoomOS; Cisco Room Bar)', false],
    [echoUa + ' CiscoNavigatorAndroid/2.2', false],
  ]) {
    await t.test(ua, async (child) => {
      const app = await setup(child, ua);
      assert.equal(app.deviceInfo().isRoomNavigator, expected);
    });
  }
});

test('Echo keeps its microphone and Assist sheet on every page, including screensaver', async (t) => {
  const app = await setup(t, echoUa, '?panel=echo-show&nativeWake=1');
  app.ready.value = true;
  assert.equal(app.canRecordVoice(), true);
  assert.equal(nodes(app.Nav()).some((node) => node.props?.ariaLabel === 'Assist'), true);
  for (const route of ['home', 'media', 'controls']) {
    app.route.value = route;
    assert.equal(contains(app.App(), 'AssistSheet'), true);
    assert.equal(contains(app.App(), 'AssistWakeListener'), false, 'Native wake must not start browser capture');
  }
  app.screensaverActive.value = true;
  assert.equal(contains(app.App(), 'AssistSheet'), true);
  assert.equal(contains(app.App(), 'TimerSheet'), true);
});

test('browser voice remains available outside Navigator and native wake mode', async (t) => {
  const app = await setup(t, 'Mozilla/5.0 Chrome/125.0.0.0');
  app.ready.value = true;
  assert.equal(app.canRecordVoice(), true);
  assert.equal(contains(app.App(), 'AssistWakeListener'), true);
});

test('screensaver unmounts the covered page and waking restores the selected route', async (t) => {
  const app = await setup(t);
  app.ready.value = true;
  app.route.value = 'media';
  assert.equal(contains(app.App(), 'Screen'), true);
  app.screensaverActive.value = true;
  assert.equal(contains(app.App(), 'Screen'), false);
  assert.equal(contains(app.App(), 'Screensaver'), true);
  app.screensaverActive.value = false;
  assert.equal(app.route.value, 'media');
  assert.equal(contains(app.App(), 'Screen'), true);
  assert.equal(contains(app.App(), 'Screensaver'), false);
});
