import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptJson, decryptJson, keyFromBase64, generateVapidKeys,
  encryptPushPayload, vapidAuthorization,
} from '../src/crypto.mjs';
import { randomBytes, createVerify, createPublicKey } from 'node:crypto';

test('state round-trips through AES-256-GCM', () => {
  const key = keyFromBase64(randomBytes(32).toString('base64'));
  const value = { packages: [{ n: '1Z999AA10123456784', s: 'IN_TRANSIT' }], v: 3 };
  const env = encryptJson(key, value);
  assert.equal(env.alg, 'AES-256-GCM');
  assert.deepEqual(decryptJson(key, env), value);
});

test('state ciphertext does not leak plaintext', () => {
  const key = keyFromBase64(randomBytes(32).toString('base64'));
  const env = encryptJson(key, { vendor: 'A&M Supply', tracking: '1Z999AA10123456784' });
  const blob = JSON.stringify(env);
  assert.ok(!blob.includes('A&M Supply'));
  assert.ok(!blob.includes('1Z999AA10123456784'));
});

test('tampered ciphertext is rejected, not silently accepted', () => {
  const key = keyFromBase64(randomBytes(32).toString('base64'));
  const env = encryptJson(key, { a: 1 });
  const ct = Buffer.from(env.ct, 'base64');
  ct[0] ^= 0xff;
  env.ct = ct.toString('base64');
  assert.throws(() => decryptJson(key, env));
});

test('the wrong key cannot decrypt', () => {
  const env = encryptJson(keyFromBase64(randomBytes(32).toString('base64')), { a: 1 });
  assert.throws(() => decryptJson(keyFromBase64(randomBytes(32).toString('base64')), env));
});

test('a short key is rejected at load time', () => {
  assert.throws(() => keyFromBase64(Buffer.alloc(16).toString('base64')), /32 bytes/);
});

// RFC 8291 section 5 published test vector. This proves the HKDF derivation,
// the aes128gcm record framing and the padding delimiter are all correct.
test('Web Push payload matches the RFC 8291 test vector exactly', () => {
  const body = encryptPushPayload(
    'When I grow up, I want to be a watermelon',
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    'BTBZMqHH6r4Tts7J_aSIgg',
    {
      salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
      serverPrivate: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'),
    },
  );
  const expected = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg'
    + 'Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2K'
    + 's3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';
  assert.equal(body.toString('base64url'), expected);
});

test('VAPID keys generate at the correct sizes', () => {
  const { publicKey, privateKey } = generateVapidKeys();
  assert.equal(Buffer.from(publicKey, 'base64url').length, 65);
  assert.equal(Buffer.from(privateKey, 'base64url').length, 32);
});

test('VAPID Authorization header carries a JWT that verifies under its own key', () => {
  const { publicKey, privateKey } = generateVapidKeys();
  const header = vapidAuthorization(
    'https://web.push.apple.com/abc123',
    'mailto:dasbury@asburycabinets.com',
    publicKey,
    privateKey,
  );
  assert.match(header, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);

  const jwt = /t=([^,]+)/.exec(header)[1];
  const [h, p, s] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.sub, 'mailto:dasbury@asburycabinets.com');
  assert.ok(claims.exp > Math.floor(Date.now() / 1000));

  // Verify the ES256 signature using the advertised public key.
  const pubDer = Buffer.concat([
    Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'),
    Buffer.from(publicKey, 'base64url'),
  ]);
  const keyObj = createPublicKey({ key: pubDer, format: 'der', type: 'spki' });
  const verifier = createVerify('SHA256');
  verifier.update(`${h}.${p}`);
  assert.equal(
    verifier.verify({ key: keyObj, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')),
    true,
    'VAPID JWT signature must verify',
  );
});
