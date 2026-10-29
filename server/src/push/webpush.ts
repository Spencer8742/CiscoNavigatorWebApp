import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';

/**
 * Web Push, the two RFCs and nothing else.
 *
 *  - RFC 8291 encrypts the payload so the push service (Apple, Google,
 *    Mozilla) carries it without being able to read it.
 *  - RFC 8292 (VAPID) signs each request so the push service knows it came
 *    from the server the device subscribed to, and nobody else can send to
 *    that subscription.
 *
 * Written against node:crypto rather than pulled in as a package: it is about
 * a hundred lines, the `web-push` package would bring a dependency tree for
 * them, and the arithmetic is fixed by the RFCs rather than something that
 * needs keeping up with.
 */

/** A device's subscription, as `PushSubscription.toJSON()` produced it. */
export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** The application server's identity: one P-256 key pair, base64url. */
export interface VapidKeys {
  /** Uncompressed point, 65 bytes — what `applicationServerKey` is given. */
  publicKey: string;
  /** The private scalar, 32 bytes. */
  privateKey: string;
}

/** RFC 8188 record size. One record carries the whole payload. */
const RECORD_SIZE = 4096;

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x ?? '', 'base64url');
  const y = Buffer.from(jwk.y ?? '', 'base64url');
  return {
    publicKey: Buffer.concat([Buffer.from([4]), x, y]).toString('base64url'),
    privateKey: jwk.d ?? '',
  };
}

/**
 * The key pair, checked: the public half must be the one the private half
 * produces. A pasted pair that does not match would sign every request with a
 * key the devices never saw, and every push would fail with a 403 nobody could
 * explain.
 */
export function vapidKeyObject(keys: VapidKeys): KeyObject {
  const d = Buffer.from(keys.privateKey, 'base64url');
  if (d.length !== 32) throw new Error('VAPID private key must be 32 bytes, base64url');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey();
  if (pub.toString('base64url') !== keys.publicKey) {
    throw new Error('VAPID public key does not match the private key');
  }
  return createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33, 65).toString('base64url'),
    },
  });
}

/**
 * `Authorization: vapid t=…, k=…` for one push service.
 *
 * The JWT's audience is the push service's origin, so one token is valid for
 * every device on the same service. An hour is well inside the 24-hour limit
 * RFC 8292 sets and the one Apple enforces.
 */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  key: KeyObject,
  subject: string,
  now = Date.now(),
): string {
  const header = b64json({ typ: 'JWT', alg: 'ES256' });
  const claims = b64json({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 3600,
    sub: subject,
  });
  const unsigned = `${header}.${claims}`;
  // JWS wants r||s, not the DER that node:crypto signs with by default.
  const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${signature.toString('base64url')}, k=${keys.publicKey}`;
}

/**
 * RFC 8291 `aes128gcm` encryption of one payload for one device.
 *
 * A fresh ephemeral key pair and salt every time, as the RFC requires: the
 * content key is derived from both, so reusing either would reuse a GCM
 * nonce under the same key.
 */
export function encryptPayload(target: PushTarget, plaintext: Buffer): Buffer {
  const uaPublic = Buffer.from(target.keys.p256dh, 'base64url');
  const authSecret = Buffer.from(target.keys.auth, 'base64url');
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('Subscription p256dh is not a P-256 public key');
  if (authSecret.length !== 16) throw new Error('Subscription auth secret must be 16 bytes');
  // One record, so the plaintext plus its delimiter and the GCM tag must fit.
  if (plaintext.length + 1 + 16 > RECORD_SIZE) throw new Error('Push payload is too large');

  const ecdh = createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);

  // §3.4: combine the ECDH secret with the device's auth secret.
  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));

  // RFC 8188 §2.2: derive the content key and nonce from the salt.
  const salt = randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last (here, only) record.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function b64json(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
