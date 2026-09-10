import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function load(source) {
  const result = await build({ entryPoints: [new URL(source, import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node' });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}
const { SpeechEndpoint } = await load('../src/assist/endpoint.ts');
const { NativeRecorder, readWakeSensitivity, saveWakeSensitivity, DEFAULT_WAKE_SENSITIVITY } = await load('../src/assist/native.ts');
const quiet = new Int16Array(1280);
const speech = new Int16Array(1280).fill(1000);

test('wake settings preserve the default and are capability gated on old APKs and browsers', () => {
  globalThis.window = {};
  assert.equal(readWakeSensitivity(), null);
  window.CiscoNavigatorAndroid = { audioVersion: () => 1 };
  assert.equal(readWakeSensitivity(), null);
  assert.throws(() => saveWakeSensitivity(85), /could not be saved/);
  let value = DEFAULT_WAKE_SENSITIVITY;
  const writes = [];
  window.CiscoNavigatorAndroid = {
    wakeSensitivity: () => value,
    setWakeSensitivity: (next) => { writes.push(next); value = next; return value; },
  };
  assert.equal(readWakeSensitivity(), 85);
  assert.equal(saveWakeSensitivity(92), 92);
  assert.equal(readWakeSensitivity(), 92);
  for (const bad of [0, 100, NaN, Infinity, 50.5]) assert.throws(() => saveWakeSensitivity(bad), /Invalid/);
  assert.deepEqual(writes, [92]);
  window.CiscoNavigatorAndroid.setWakeSensitivity = () => -1;
  assert.throws(() => saveWakeSensitivity(85), /could not be saved/);
  window.CiscoNavigatorAndroid.wakeSensitivity = () => NaN;
  assert.equal(readWakeSensitivity(), null);
  window.CiscoNavigatorAndroid.wakeSensitivity = () => { throw new Error('unavailable'); };
  assert.equal(readWakeSensitivity(), null);
});

test('speech waits for two seconds of trailing silence', () => {
  const endpoint = new SpeechEndpoint();
  for (let i = 0; i < 5; i++) assert.equal(endpoint.push(quiet), null);
  for (let i = 0; i < 15; i++) assert.equal(endpoint.push(speech), null);
  for (let i = 0; i < 24; i++) assert.equal(endpoint.push(quiet), null);
  assert.equal(endpoint.push(quiet), 'speech-end');
});

test('quiet and a short click never become an Assist command', () => {
  const endpoint = new SpeechEndpoint();
  for (let i = 0; i < 5; i++) endpoint.push(quiet);
  endpoint.push(speech);
  let result;
  for (let i = 0; i < 94; i++) result = endpoint.push(quiet);
  assert.equal(result, 'no-speech');
  assert.equal(endpoint.hasSpeech, false);
});

test('recognizes quiet Echo speech above its measured microphone noise floor', () => {
  const endpoint = new SpeechEndpoint();
  const noise = new Int16Array(1280).fill(36);
  const softSpeech = new Int16Array(1280).fill(80);
  for (let i = 0; i < 10; i++) assert.equal(endpoint.push(noise), null);
  for (let i = 0; i < 10; i++) assert.equal(endpoint.push(softSpeech), null);
  for (let i = 0; i < 24; i++) assert.equal(endpoint.push(noise), null);
  assert.equal(endpoint.push(noise), 'speech-end');
});

test('chime at startup is ignored and a continuous command is bounded', () => {
  const endpoint = new SpeechEndpoint();
  for (let i = 0; i < 3; i++) endpoint.push(speech);
  for (let i = 0; i < 10; i++) endpoint.push(quiet);
  assert.equal(endpoint.hasSpeech, false);
  let result;
  for (let i = 0; i < 175; i++) result = endpoint.push(speech);
  assert.equal(result, 'speech-end');
});

test('a wake tail and a pause before the command do not cause an early send', () => {
  const endpoint = new SpeechEndpoint();
  for (let i = 0; i < 8; i++) assert.equal(endpoint.push(speech), null);
  for (let i = 0; i < 20; i++) assert.equal(endpoint.push(quiet), null);
  for (let i = 0; i < 10; i++) assert.equal(endpoint.push(speech), null);
  for (let i = 0; i < 24; i++) assert.equal(endpoint.push(quiet), null);
  assert.equal(endpoint.push(quiet), 'speech-end');
});

test('silence at wake waits eight seconds for a command', () => {
  const endpoint = new SpeechEndpoint();
  for (let i = 0; i < 99; i++) assert.equal(endpoint.push(quiet), null);
  assert.equal(endpoint.push(quiet), 'no-speech');
});

test('native capture cancels during startup and ignores a late ready event', async () => {
  const stops = [];
  let id;
  globalThis.window = { CiscoNavigatorAndroid: {
    startCapture(value) { id = value; }, stopCapture(value) { stops.push(value); },
  } };
  const abort = new AbortController();
  const pending = NativeRecorder.start(() => assert.fail('late audio delivered'), abort.signal);
  const callback = window.CiscoNavigatorNativeAudio;
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  callback({ id, type: 'ready' });
  assert.deepEqual(stops, [id]);
  assert.equal(window.CiscoNavigatorNativeAudio, undefined);
});

test('one native capture at a time, PCM16 preserved, stop is idempotent', async () => {
  let id;
  const stops = [];
  globalThis.window = { CiscoNavigatorAndroid: {
    startCapture(value) { id = value; }, stopCapture(value) { stops.push(value); },
  } };
  const chunks = [];
  const pending = NativeRecorder.start((chunk) => chunks.push(chunk));
  await assert.rejects(NativeRecorder.start(() => {}), /already recording/);
  window.CiscoNavigatorNativeAudio({ id, type: 'ready' });
  const recorder = await pending;
  window.CiscoNavigatorNativeAudio({ id, type: 'audio', pcm: Buffer.from([0, 128, 255, 127]).toString('base64') });
  assert.deepEqual([...chunks[0]], [-32768, 32767]);
  assert.deepEqual([...new Int16Array(await recorder.stop())], [-32768, 32767]);
  assert.equal((await recorder.stop()).byteLength, 0);
  assert.deepEqual(stops, [id]);
});
