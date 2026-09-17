/**
 * Encryption for state at rest and for Web Push payloads.
 *
 * WHY STATE IS ENCRYPTED: the repository is public, because GitHub Pages and
 * unmetered Actions minutes are only free on public repositories. Asbury
 * business data (vendors, shipment contents, tracking numbers) must not be
 * public. So every file containing business data is written as AES-256-GCM
 * ciphertext. The key lives only in GitHub Actions secrets and in the browser
 * on Derek's phone. Anyone can read the code; nobody can read the data.
 *
 * Uses node:crypto only. No third-party dependencies.
 */

import {
  createCipheriv, createDecipheriv, randomBytes, createECDH,
  createHmac, createSign, createPublicKey, createPrivateKey, constants,
} from 'node:crypto';

// ---------------------------------------------------------------- state ----

/** @param {string} keyB64 32 raw bytes, base64 or base64url */
export function keyFromBase64(keyB64) {
  const key = Buffer.from(String(keyB64).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (key.length !== 32) {
    throw new Error(`STATE_KEY must decode to 32 bytes, got ${key.length}`);
  }
  return key;
}

/** Envelope: {v, alg, iv, tag, ct} - all base64. Versioned for future rotation. */
export function encryptJson(key, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: 1,
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

export function decryptJson(key, envelope) {
  if (!envelope || envelope.v !== 1 || envelope.alg !== 'AES-256-GCM') {
    throw new Error('Unrecognised state envelope');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(envelope.ct, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(pt.toString('utf8'));
}

// ------------------------------------------------------------- web push ----

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function hkdf(salt, ikm, info, length) {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const out = createHmac('sha256', prk)
    .update(Buffer.concat([Buffer.from(info), Buffer.from([1])]))
    .digest();
  return out.subarray(0, length);
}

/**
 * Encrypt a Web Push payload per RFC 8291 (aes128gcm content coding, RFC 8188).
 * Returns the request body buffer.
 *
 * @param {string} payload      UTF-8 payload
 * @param {string} p256dhB64url subscriber public key from the browser
 * @param {string} authB64url   subscriber auth secret from the browser
 * @param {{salt?:Buffer, serverPrivate?:Buffer}} [opts] test-vector injection only
 */
export function encryptPushPayload(payload, p256dhB64url, authB64url, opts = {}) {
  const clientPublic = Buffer.from(p256dhB64url, 'base64url');
  const authSecret = Buffer.from(authB64url, 'base64url');

  const ecdh = createECDH('prime256v1');
  if (opts.serverPrivate) {
    ecdh.setPrivateKey(opts.serverPrivate);
  } else {
    ecdh.generateKeys();
  }
  const serverPublic = ecdh.getPublicKey(); // uncompressed, 65 bytes
  const sharedSecret = ecdh.computeSecret(clientPublic);

  const salt = opts.salt || randomBytes(16);

  // RFC 8291 §3.3: derive the input keying material from the ECDH secret.
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    clientPublic,
    serverPublic,
  ]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);

  const cek = hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12);

  // RFC 8188 requires a padding delimiter of 0x02 on the final record.
  const plaintext = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([0x02])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  // aes128gcm header: salt(16) || recordSize(4, BE) || keyIdLen(1) || keyId
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096, 0);
  const header = Buffer.concat([
    salt,
    recordSize,
    Buffer.from([serverPublic.length]),
    serverPublic,
  ]);

  return Buffer.concat([header, body]);
}

/** DER-encode a raw 64-byte P-256 signature as required by ES256 JWT verifiers. */
function rawFromDer(der) {
  // Node's sign() with dsaEncoding 'ieee-p1363' already gives raw; kept for clarity.
  return der;
}

/**
 * Build a VAPID Authorization header value for a push endpoint.
 *
 * @param {string} endpoint       full push endpoint URL
 * @param {string} subject        mailto: or https: contact
 * @param {string} publicKeyB64u  VAPID public key (65-byte uncompressed point)
 * @param {string} privateKeyB64u VAPID private key (32-byte scalar)
 */
export function vapidAuthorization(endpoint, subject, publicKeyB64u, privateKeyB64u) {
  const aud = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  }));
  const signingInput = `${header}.${claims}`;

  const privateKey = p256PrivateKeyFromRaw(privateKeyB64u, publicKeyB64u);
  const signer = createSign('SHA256');
  signer.update(signingInput);
  const signature = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });

  const jwt = `${signingInput}.${b64url(rawFromDer(signature))}`;
  return `vapid t=${jwt}, k=${publicKeyB64u}`;
}

/** Wrap a raw P-256 scalar + point into a KeyObject via a hand-built DER SEC1 key. */
function p256PrivateKeyFromRaw(privateB64u, publicB64u) {
  const d = Buffer.from(privateB64u, 'base64url');
  const q = Buffer.from(publicB64u, 'base64url');
  if (d.length !== 32) throw new Error('VAPID private key must be 32 bytes');
  if (q.length !== 65) throw new Error('VAPID public key must be 65 bytes');

  // RFC 5915 ECPrivateKey: SEQUENCE { INTEGER 1, OCTET STRING d,
  //   [0] OID prime256v1, [1] BIT STRING q }
  const oid = Buffer.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
  const version = Buffer.from([0x02, 0x01, 0x01]);
  const privOctet = Buffer.concat([Buffer.from([0x04, 0x20]), d]);
  const curve = Buffer.concat([Buffer.from([0xa0, oid.length]), oid]);
  const bitString = Buffer.concat([Buffer.from([0x03, q.length + 1, 0x00]), q]);
  const pub = Buffer.concat([Buffer.from([0xa1, bitString.length]), bitString]);
  const inner = Buffer.concat([version, privOctet, curve, pub]);
  const der = Buffer.concat([Buffer.from([0x30, ...derLength(inner.length)]), inner]);

  return createPrivateKey({ key: der, format: 'der', type: 'sec1' });
}

function derLength(n) {
  if (n < 0x80) return [n];
  if (n < 0x100) return [0x81, n];
  return [0x82, n >> 8, n & 0xff];
}

/** Generate a fresh VAPID key pair. Used by the setup wizard. */
export function generateVapidKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  // getPrivateKey() drops leading zero bytes; ES256 requires a fixed 32 bytes.
  const raw = ecdh.getPrivateKey();
  const priv = Buffer.alloc(32);
  raw.copy(priv, 32 - raw.length);
  return {
    publicKey: b64url(ecdh.getPublicKey()),
    privateKey: b64url(priv),
  };
}

export { b64url };
