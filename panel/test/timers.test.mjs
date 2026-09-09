import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const result = await build({ entryPoints: [new URL('../src/timers/model.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node' });
const { TimerStore, remaining, formatCountdown } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));

test('five-minute timer stays accurate across a delayed tick and reload', () => {
  let now = 100000;
  const store = new TimerStore(() => now, () => 'test');
  store.start(300000, 'Pasta');
  const saved = store.serialize();
  now += 77000;
  const restored = new TimerStore(() => now);
  restored.restore(saved);
  assert.equal(formatCountdown(remaining(restored.items[0], now)), '3:43');
  now += 223000;
  assert.equal(restored.tick(), true);
  assert.equal(restored.items[0].state, 'ringing');
  assert.equal(restored.tick(), false, 'expiration is a single transition');
});

test('pause and resume preserve remaining time, including through reload', () => {
  let now = 100000;
  const store = new TimerStore(() => now, () => 'test');
  store.start(300000);
  now += 5000;
  store.update('test', 'pause');
  now += 500000;
  const restored = new TimerStore(() => now);
  restored.restore(store.serialize());
  assert.equal(remaining(restored.items[0], now), 295000);
  restored.update('test', 'resume');
  now += 1000;
  assert.equal(remaining(restored.items[0], now), 294000);
});

test('expiration while closed is restored, dismiss stops ringing, restart and removal work', () => {
  let now = 100000;
  const store = new TimerStore(() => now, () => 'test');
  store.start(1000);
  const saved = store.serialize();
  now += 5000;
  store.restore(saved);
  assert.equal(store.items[0].state, 'ringing');
  store.update('test', 'dismiss');
  assert.equal(store.items[0].state, 'finished');
  store.update('test', 'restart');
  assert.equal(remaining(store.items[0], now), 1000);
  store.update('test', 'cancel');
  assert.equal(store.items.length, 0);
});

test('multiple timers are independent and adding a minute preserves pause state', () => {
  let now = 1000, seq = 0;
  const store = new TimerStore(() => now, () => String(++seq));
  store.start(1000);
  store.start(10000);
  store.update('2', 'pause');
  store.update('2', 'add-minute');
  now += 5000;
  store.tick();
  assert.equal(store.items[0].state, 'ringing');
  assert.equal(store.items[1].state, 'paused');
  assert.equal(remaining(store.items[1], now), 70000);
});

test('invalid durations and corrupt storage cannot create unusable timers', () => {
  const store = new TimerStore();
  for (const ms of [0, -1, NaN, Infinity, 86400001]) assert.throws(() => store.start(ms));
  store.restore('{bad json');
  store.restore(JSON.stringify({ version: 1, timers: [null, {}, { id: 'bad', state: 'running', deadline: 'never' }] }));
  assert.deepEqual(store.items, []);
  assert.equal(formatCountdown(1), '0:01');
  assert.equal(formatCountdown(3600000), '1:00:00');
  assert.equal(formatCountdown(-1), '0:00');
});
