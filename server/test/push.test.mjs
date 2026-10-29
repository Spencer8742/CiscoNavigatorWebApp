import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import {
  PushNotifier,
  encryptPayload,
  generateVapidKeys,
  isKnownPushService,
  vapidAuthorization,
  vapidKeyObject,
} from '../dist/testkit.js';

/**
 * Web Push.
 *
 * The encryption is checked by DECRYPTING it, with an implementation written
 * here from RFC 8291 rather than shared with the code under test — a payload
 * the push service carries but the device cannot open fails silently on the
 * phone, so this is the only place that failure can be seen. The signature is
 * verified with the public key the device would have subscribed with.
 */

const SERVER = fileURLToPath(new URL('../dist/server.js', import.meta.url));

/** A browser: a P-256 key pair and an auth secret, as PushSubscription has. */
function fakeDevice(endpoint) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    subscription: {
      endpoint,
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    },
  };
}

const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** RFC 8291 §3 + RFC 8188, from the device's side. */
function decrypt(device, body) {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);

  const shared = device.ecdh.computeSecret(asPublic);
  const uaPublic = device.ecdh.getPublicKey();
  const prkKey = hmac(device.auth, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  assert.equal(padded.at(-1), 2, 'last-record delimiter');
  return JSON.parse(padded.subarray(0, -1).toString('utf8'));
}

function verifyVapid(header, endpoint, publicKey) {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(match, `vapid authorization header: ${header}`);
  const [, jwt, k] = match;
  assert.equal(k, publicKey);
  const [head, claims, signature] = jwt.split('.');
  const pub = Buffer.from(k, 'base64url');
  const key = createPublicKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
  });
  assert.ok(
    verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')),
    'JWT signature verifies with the advertised key',
  );
  const body = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
  assert.equal(body.aud, new URL(endpoint).origin);
  assert.ok(body.exp > Date.now() / 1000 && body.exp <= Date.now() / 1000 + 86400);
  return body;
}

/** A push service on localhost: records each request, answers with `status(path)`. */
async function mockPushService(status = () => 201) {
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(status(req.url));
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, received, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('a payload decrypts on the device, and the request is signed with the advertised key', () => {
  const device = fakeDevice('https://web.push.apple.com/QGx');
  const keys = generateVapidKeys();
  const message = { title: 'Front door', body: 'x'.repeat(2500) };

  const body = encryptPayload(device.subscription, Buffer.from(JSON.stringify(message)));
  assert.deepEqual(decrypt(device, body), message);
  assert.equal(body.readUInt32BE(16), 4096, 'record size');

  // Fresh salt and ephemeral key every time — the same plaintext twice must
  // never produce the same ciphertext.
  const again = encryptPayload(device.subscription, Buffer.from(JSON.stringify(message)));
  assert.notDeepEqual(again.subarray(0, 16), body.subarray(0, 16));

  const claims = verifyVapid(
    vapidAuthorization(device.subscription.endpoint, keys, vapidKeyObject(keys), 'mailto:ops@example.org'),
    device.subscription.endpoint,
    keys.publicKey,
  );
  assert.equal(claims.sub, 'mailto:ops@example.org');
});

test('a VAPID pair whose halves do not match is refused', () => {
  const a = generateVapidKeys();
  const b = generateVapidKeys();
  assert.throws(() => vapidKeyObject({ publicKey: a.publicKey, privateKey: b.privateKey }), /does not match/);
});

test('only the real push services may be subscribed to', () => {
  for (const ok of [
    'https://web.push.apple.com/abc',
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ]) assert.equal(isKnownPushService(new URL(ok)), true, ok);

  for (const bad of [
    'http://web.push.apple.com/abc',
    'https://192.168.1.10/abc',
    'https://homeassistant.local:8123/api/services/lock/unlock',
    'https://push.apple.com.evil.example/abc',
    'https://evilpush.apple.com.example/abc',
  ]) assert.equal(isKnownPushService(new URL(bad)), false, bad);
});

test('the notifier delivers by category and panel, and forgets expired devices', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navigator-push-'));
  const service = await mockPushService((path) => (path === '/gone' ? 410 : 201));
  try {
    const notifier = new PushNotifier({ dir, subject: 'mailto:ops@example.org', allowEndpoint: () => true });
    await notifier.start();
    const { publicKey } = notifier.info();
    assert.match(publicKey, /^[A-Za-z0-9_-]{87}$/);

    // The key is made once and kept, readable only by the server's user.
    const stored = JSON.parse(await readFile(join(dir, 'push-vapid.json'), 'utf8'));
    assert.equal(stored.publicKey, publicKey);
    assert.equal((await stat(join(dir, 'push-vapid.json'))).mode & 0o077, 0);

    const kitchen = fakeDevice(`${service.base}/kitchen`);
    const muted = fakeDevice(`${service.base}/muted`);
    const gone = fakeDevice(`${service.base}/gone`);
    await notifier.subscribe({ subscription: kitchen.subscription, categories: ['general'], panel: 'Kitchen' });
    await notifier.subscribe({ subscription: muted.subscription, categories: [] });
    await notifier.subscribe({ subscription: gone.subscription, categories: ['general', 'not-a-category'] });

    assert.deepEqual(notifier.info(kitchen.subscription.endpoint).categories, ['general']);
    assert.deepEqual(notifier.info(muted.subscription.endpoint).categories, []);
    assert.equal(notifier.info(`${service.base}/unknown`).categories, null);

    const report = await notifier.notify({ title: 'Washer finished', body: 'Load is done', url: '/?panel=kitchen' });
    assert.deepEqual(report, { sent: 1, failed: 0, removed: 1 });
    assert.equal(notifier.count, 2, 'the 410 device was forgotten');

    const toKitchen = service.received.find((r) => r.path === '/kitchen');
    assert.equal(toKitchen.headers['content-encoding'], 'aes128gcm');
    assert.equal(toKitchen.headers.ttl, '86400');
    verifyVapid(toKitchen.headers.authorization, kitchen.subscription.endpoint, publicKey);
    assert.deepEqual(decrypt(kitchen, toKitchen.body), {
      title: 'Washer finished', body: 'Load is done', tag: null, url: '/?panel=kitchen', category: 'general',
    });
    assert.equal(service.received.some((r) => r.path === '/muted'), false, 'opted out of general');

    // Aimed at one panel, it reaches only that panel's devices.
    service.received.length = 0;
    assert.deepEqual(await notifier.notify({ title: 'Hi', panel: 'office' }), { sent: 0, failed: 0, removed: 0 });
    assert.deepEqual(await notifier.notify({ title: 'Hi', panel: 'kitchen' }), { sent: 1, failed: 0, removed: 0 });
    // With no url of its own, a tap opens the panel the device subscribed as.
    assert.equal(decrypt(kitchen, service.received.at(-1).body).url, '/?panel=kitchen');

    // A test reaches the device whatever its categories.
    assert.deepEqual(await notifier.test({ endpoint: muted.subscription.endpoint }), { sent: 1, failed: 0, removed: 0 });

    // Persisted: a restart keeps both remaining devices and the same key.
    const reborn = new PushNotifier({ dir, subject: 'mailto:ops@example.org', allowEndpoint: () => true });
    await reborn.start();
    assert.equal(reborn.count, 2);
    assert.equal(reborn.info().publicKey, publicKey);

    await reborn.unsubscribe({ endpoint: kitchen.subscription.endpoint });
    assert.equal(reborn.count, 1);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a notification that could not be shown safely is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navigator-push-'));
  try {
    const notifier = new PushNotifier({ dir, subject: 'mailto:ops@example.org' });
    await notifier.start();
    await assert.rejects(notifier.notify({ body: 'no title' }), /needs a title/);
    await assert.rejects(notifier.notify({ title: 'x', url: 'https://evil.example/' }), /path on this server/);
    await assert.rejects(notifier.notify({ title: 'x', url: '//evil.example/' }), /path on this server/);
    await assert.rejects(notifier.notify({ title: 'x', category: 'everything' }), /Unknown category/);
    await assert.rejects(notifier.notify({ title: 'x', panel: '../etc' }), /not a panel id/);
    await assert.rejects(
      notifier.subscribe({ subscription: fakeDevice('https://10.0.0.1/hook').subscription, categories: ['general'] }),
      /not supported/,
    );
    await assert.rejects(notifier.subscribe({ subscription: { endpoint: 'https://web.push.apple.com/x' } }), /Not a push subscription/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the backend serves the push routes behind the panel token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navigator-push-'));
  const config = join(dir, 'dashboard.yaml');
  await writeFile(config, 'version: 1\n', 'utf8');
  const port = 18190;
  const token = 'push-test-token';
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PANEL_TOKEN: token, CONFIG_PATH: config, HA_URL: '', HA_TOKEN: '', IMMICH_URL: '', IMMICH_API_KEY: '', SONOS_HOST: '', LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`));

  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) assert.fail('backend did not start');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal((await fetch(`${base}/api/push`)).status, 401);
    assert.equal((await fetch(`${base}/api/notify`, { method: 'POST', body: '{"title":"x"}' })).status, 401);

    const info = await (await fetch(`${base}/api/push`, { headers: auth })).json();
    assert.equal(info.enabled, true);
    assert.match(info.publicKey, /^[A-Za-z0-9_-]{87}$/);
    assert.equal(info.categories, null);

    const refused = await fetch(`${base}/api/push/subscribe`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ subscription: fakeDevice('https://192.168.1.1/x').subscription, categories: ['general'] }),
    });
    assert.equal(refused.status, 400);

    const bad = await fetch(`${base}/api/notify`, { method: 'POST', headers: auth, body: 'not json' });
    assert.equal(bad.status, 400);

    const sent = await fetch(`${base}/api/notify`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'Nobody listening' }) });
    assert.deepEqual(await sent.json(), { sent: 0, failed: 0, removed: 0 });

    // The service worker is served fresh on every check, never cached for a
    // year like the hashed assets: a stale worker would outlive a deploy.
    const sw = await fetch(`${base}/sw.js`);
    if (sw.ok && sw.headers.get('content-type')?.startsWith('text/javascript')) {
      assert.equal(sw.headers.get('cache-control'), 'no-cache');
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
