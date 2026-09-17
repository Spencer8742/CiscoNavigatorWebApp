import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: [new URL('../src/media/photos.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{
    name: 'photo-transport-fixture',
    setup(builder) {
      builder.onResolve({ filter: /^~\/net\/(auth|socket)\.ts$/ }, ({ path }) => ({ path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
        contents: path.endsWith('auth.ts') ? 'export const getToken = () => null;'
          : 'export const requestPhotos = (count) => globalThis.photoFixture.request(count);',
        loader: 'js',
      }));
    },
  }],
});
let moduleId = 0;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const ref = (id, w = 1600, h = 900) => ({ id, w, h });

async function setup(t) {
  let sequence = 0;
  const images = [];
  const fixture = {
    deferred: false,
    request: async (count) => Array.from({ length: count }, () => ref(`photo-${++sequence}`)),
  };
  const oldImage = globalThis.Image;
  globalThis.photoFixture = fixture;
  globalThis.Image = class {
    src = '';
    naturalWidth = 1600;
    naturalHeight = 900;
    constructor() { images.push(this); }
    decode() {
      return fixture.deferred ? new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; })
        : Promise.resolve();
    }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
  };
  const photos = await import('data:text/javascript;base64,'
    + Buffer.from(bundle.outputFiles[0].text).toString('base64') + `#${++moduleId}`);
  t.after(() => {
    photos.releaseImages();
    globalThis.Image = oldImage;
    delete globalThis.photoFixture;
  });
  return { photos, fixture, images };
}

test('leaving the screensaver cancels a pending decode and ignores its late result', async (t) => {
  const { photos, fixture, images } = await setup(t);
  fixture.deferred = true;
  const advancing = photos.advance();
  await flush();
  assert.equal(images.length, 1);
  photos.releaseImages();
  assert.equal(images[0].src, '');
  images[0].resolve();
  await advancing;
  assert.equal(photos.photoStats().cached, 0);
  assert.equal(photos.photosReady.value, false);
  assert.equal(photos.currentPhoto.value, null);
  assert.deepEqual(photos.currentSlide.value, []);
  assert.equal(images.length, 1, 'A cancelled advance must not preload more images');
});

test('pending portrait partners cannot publish a slide after teardown', async (t) => {
  const { photos, fixture, images } = await setup(t);
  fixture.request = async () => [ref('portrait-a', 900, 1600), ref('portrait-b', 900, 1600)];
  fixture.deferred = true;
  const advancing = photos.advance();
  await flush();
  images[0].resolve();
  await flush();
  assert.equal(images.length, 2);
  photos.releaseImages();
  images[1].resolve();
  await advancing;
  assert.ok(images.every((image) => image.src === ''));
  assert.equal(photos.photoStats().cached, 0);
  assert.deepEqual(photos.currentSlide.value, []);
});

test('preload and advance share one decoder for the same image', async (t) => {
  const { photos, fixture, images } = await setup(t);
  fixture.deferred = true;
  const first = photos.advance();
  await flush();
  images[0].resolve();
  await first;
  await flush();
  assert.equal(images.length, 2, 'The next photo is being preloaded');
  const second = photos.advance();
  await flush();
  assert.equal(images.length, 2, 'Advancing must reuse the pending preload');
  images[1].resolve();
  await second;
  assert.equal(photos.currentPhoto.value.id, 'photo-2');
  await flush();
  photos.releaseImages();
  images[2].resolve();
  await flush();
  assert.equal(photos.photoStats().cached, 0, 'A late preload cannot refill a released cache');
});

test('old playlist responses neither repopulate the queue nor clear a new in-flight batch', async (t) => {
  const { photos, fixture } = await setup(t);
  const requests = [];
  fixture.request = () => new Promise((resolve) => requests.push(resolve));
  const oldAdvance = photos.advance();
  assert.equal(requests.length, 1);
  photos.resetPlaylist();
  const newAdvance = photos.advance();
  assert.equal(requests.length, 2);
  requests[0]([ref('old')]);
  await oldAdvance;
  assert.deepEqual(photos.photoStats(), { cached: 0, queued: 0 });
  const coalesced = photos.advance();
  assert.equal(requests.length, 2, 'Old completion must not clear the new request');
  requests[1]([ref('new')]);
  await newAdvance;
  await coalesced;
  assert.equal(photos.currentPhoto.value.id, 'new');
});

test('a new session survives an old decode finishing for the same photo id', async (t) => {
  const { photos, fixture, images } = await setup(t);
  fixture.request = async () => [ref('same'), ref('next')];
  fixture.deferred = true;
  const oldAdvance = photos.advance();
  await flush();
  photos.resetPlaylist();
  const newAdvance = photos.advance();
  await flush();
  images[0].resolve();
  await oldAdvance;
  assert.equal(photos.photosReady.value, false);
  images[1].resolve();
  await newAdvance;
  assert.equal(photos.currentPhoto.value.id, 'same');
  assert.equal(photos.photoStats().cached, 1);
  await flush();
  photos.releaseImages();
  images[2].resolve();
  await flush();
  assert.equal(photos.photoStats().cached, 0);
});

test('a failed decode is released and skipped without stopping the slideshow', async (t) => {
  const { photos, fixture, images } = await setup(t);
  fixture.deferred = true;
  const advancing = photos.advance();
  await flush();
  fixture.deferred = false;
  images[0].reject(new Error('broken image'));
  await advancing;
  assert.equal(images[0].src, '');
  assert.equal(photos.currentPhoto.value.id, 'photo-2');
});

test('10000 advances stay bounded and teardown releases every loaded image', async (t) => {
  const { photos, images } = await setup(t);
  for (let i = 0; i < 10_000; i += 1) {
    await photos.advance();
    assert.ok(photos.photoStats().cached <= 6);
    assert.ok(photos.photoStats().queued <= 31);
  }
  photos.releaseImages();
  await flush();
  assert.equal(photos.photoStats().cached, 0);
  assert.ok(images.every((image) => image.src === ''));
});
