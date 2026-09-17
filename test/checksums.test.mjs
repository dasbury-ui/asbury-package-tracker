import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ck from '../src/tracking/checksums.mjs';
import { evaluate, normalise } from '../src/tracking/formats.mjs';

// --- Known-good vectors, verified by hand against the published algorithms ---

test('UPS: canonical valid number passes', () => {
  const n = '1Z999AA10123456784';
  assert.equal(ck.upsMod10(n.slice(2, 17), n.slice(17)).ok, true);
});

test('UPS: every single-digit corruption of the check digit fails', () => {
  const n = '1Z999AA10123456784';
  for (let d = 0; d <= 9; d++) {
    if (d === 4) continue;
    assert.equal(ck.upsMod10(n.slice(2, 17), String(d)).ok, false, `check digit ${d} must fail`);
  }
});

test('S10: published valid vectors pass', () => {
  for (const n of ['RB123456785GB', 'RB123456785US']) {
    assert.equal(ck.s10(n.slice(2, 10), n[10]).ok, true, n);
  }
});

test('S10: published invalid vector fails', () => {
  const n = 'RB123456786US';
  assert.equal(ck.s10(n.slice(2, 10), n[10]).ok, false);
});

test('S10: remainder 0 maps to check digit 5, remainder 1 maps to 0', () => {
  // Construct serials that hit each special case and confirm round-trip.
  let sawZero = false;
  let sawOne = false;
  for (let i = 0; i < 100000 && !(sawZero && sawOne); i++) {
    const serial = String(i).padStart(8, '0');
    const weights = [8, 6, 4, 2, 3, 5, 9, 7];
    let sum = 0;
    for (let k = 0; k < 8; k++) sum += Number(serial[k]) * weights[k];
    const r = sum % 11;
    if (r === 0) { sawZero = true; assert.equal(ck.compute.s10(serial), '5'); }
    if (r === 1) { sawOne = true; assert.equal(ck.compute.s10(serial), '0'); }
  }
  assert.ok(sawZero && sawOne, 'both special cases must be exercised');
});

// --- Property tests: compute then verify must always agree, and any
// --- single-digit corruption of the check digit must be rejected.

function roundTrip(name, bodyGen, computeFn, verifyFn) {
  test(`${name}: computed check digits verify, corrupted ones do not`, () => {
    for (let i = 0; i < 400; i++) {
      const body = bodyGen(i);
      const check = computeFn(body);
      assert.equal(verifyFn(body, check).ok, true, `${body}|${check} should verify`);
      const bad = String((Number(check) + 1 + (i % 9)) % 10);
      if (bad !== check) {
        assert.equal(verifyFn(body, bad).ok, false, `${body}|${bad} should not verify`);
      }
    }
  });
}

const rnd = (seed, len, alphabet) => {
  let s = seed * 2654435761 % 4294967296;
  let out = '';
  for (let i = 0; i < len; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out += alphabet[s % alphabet.length];
  }
  return out;
};
const NUM = '0123456789';
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

roundTrip('mod10 (USPS IMpb / FedEx 96)', (i) => rnd(i + 1, 21, NUM),
  ck.compute.mod10Weighted31, ck.mod10Weighted31);

roundTrip('UPS mod10 alphanumeric', (i) => rnd(i + 7, 15, ALNUM),
  ck.compute.upsMod10, ck.upsMod10);

roundTrip('FedEx Express 12', (i) => rnd(i + 13, 11, NUM),
  ck.compute.fedex, ck.fedexExpress12);

roundTrip('FedEx Ground 15', (i) => rnd(i + 23, 14, NUM),
  ck.compute.fedex, ck.fedexGround15);

roundTrip('DHL mod 7', (i) => rnd(i + 31, 10, NUM).replace(/^0/, '1'),
  ck.compute.dhlMod7, ck.dhlMod7);

test('S10 round trip', () => {
  for (let i = 0; i < 400; i++) {
    const serial = rnd(i + 41, 8, NUM);
    const check = ck.compute.s10(serial);
    assert.equal(ck.s10(serial, check).ok, true);
    const bad = String((Number(check) + 3) % 10);
    if (bad !== check) assert.equal(ck.s10(serial, bad).ok, false);
  }
});

// --- Malformed input must be rejected, never throw ---

test('malformed input is rejected with a reason, not an exception', () => {
  const cases = [
    () => ck.mod10Weighted31('12A4', '5'),
    () => ck.mod10Weighted31('1234', 'X'),
    () => ck.s10('123', '5'),
    () => ck.upsMod10('SHORT', '1'),
    () => ck.upsMod10('123456789012345', 'Z'),
    () => ck.fedexExpress12('123', '4'),
    () => ck.fedexGround15('123', '4'),
    () => ck.dhlMod7('12A', '4'),
  ];
  for (const fn of cases) {
    const r = fn();
    assert.equal(r.ok, false);
    assert.equal(typeof r.reason, 'string');
    assert.ok(r.reason.length > 0);
  }
});

// --- Format layer ---

test('format evaluation: valid UPS number yields a checksum-passing candidate', () => {
  const e = evaluate(normalise('1Z 999 AA1 01 2345 6784'));
  assert.equal(e.passed.length >= 1, true);
  assert.equal(e.passed[0].carrier, 'ups');
});

test('format evaluation: UPS number with a bad check digit passes no format', () => {
  const e = evaluate(normalise('1Z999AA10123456785'));
  assert.equal(e.matched.length, 1);
  assert.equal(e.passed.length, 0);
  assert.equal(e.matched[0].checksum, 'FAIL');
});

test('normalise strips spaces, dashes and case', () => {
  assert.equal(normalise('1z-999 aa1.0123 456784'), '1Z999AA10123456784');
});

test('carriers without a free authoritative API are marked untrackable', () => {
  const amazon = evaluate('TBA123456789012');
  assert.equal(amazon.matched.length, 1);
  assert.equal(amazon.matched[0].trackable, false);
  assert.equal(amazon.matched[0].unavailableReason, 'NO_FREE_AUTHORITATIVE_API');
});
