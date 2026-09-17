/**
 * Regression tests for defects found in the independent QA review.
 * Each test names the defect it locks down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { extractFromEmail } from '../src/tracking/extract.mjs';
import { maskEmail, redact, registerSecret } from '../src/log.mjs';
import { Budget } from '../src/budget.mjs';
import { REASON_TEXT } from '../src/carriers/index.mjs';
import { newPackage, applyResolution, Store } from '../src/state.mjs';
import { unavailable } from '../src/carriers/common.mjs';
import { writePublicView } from '../src/publish.mjs';
import { deepLink } from '../src/carriers/index.mjs';
import { decryptJson, keyFromBase64 } from '../src/crypto.mjs';

const email = (over = {}) => ({
  messageId: 'm1', mailbox: 'shop@asburycabinets.com', subject: '',
  from: 'Someone <a@b.com>', date: '2026-09-15T12:00:00Z', text: '', html: '', ...over,
});

// --- QA #6: bare-digit checksums are not sufficient on their own ---

test('a phone number that happens to pass the DHL mod-7 check is not tracked', () => {
  // 8045551231 % 7 ... whatever it is, the point is no label and no link.
  const candidates = ['8045551231', '7575550147', '2125550199', '8005551212'];
  for (const n of candidates) {
    const { admitted } = extractFromEmail(email({
      text: `Give me a call on ${n} if you have questions. Thanks, Mike`,
    }));
    assert.equal(admitted.find((a) => a.number === n), undefined,
      `${n} in a signature block must never become a tracked package`);
  }
});

test('a 12-digit account number that passes the FedEx check is not tracked', () => {
  const { admitted, rejected } = extractFromEmail(email({
    text: 'Our account number is 100000000003 for your records.',
  }));
  assert.equal(admitted.find((a) => a.number === '100000000003'), undefined);
  const r = rejected.find((x) => x.number === '100000000003');
  assert.ok(r, 'it must still be logged so a miss is traceable');
  assert.match(r.rejectReason, /WEAK_CHECKSUM_NO_CONTEXT/);
});

test('the same bare-digit number IS tracked when labelled as a tracking number', () => {
  const { admitted } = extractFromEmail(email({
    text: 'DHL tracking number: 8045551231',
  }));
  const hit = admitted.find((a) => a.number === '8045551231');
  assert.ok(hit, 'with an explicit label it is a real candidate');
  assert.equal(hit.admissionBasis, 'LABELLED');
});

test('a self-identifying format still stands on its checksum alone', () => {
  const { admitted } = extractFromEmail(email({
    text: 'Reference 1Z999AA10123456784 attached.',
  }));
  assert.equal(admitted[0].admissionBasis, 'CHECKSUM');
});

// --- QA #2: no mailbox addresses in plaintext output or logs ---

test('mailbox addresses are masked', () => {
  assert.equal(maskEmail('shop@asburycabinets.com'), 's***@asburycabinets.com');
  assert.equal(maskEmail('dasbury@asburycabinets.com'), 'd******@asburycabinets.com');
  assert.equal(maskEmail(''), '');
});

test('any email address reaching a log line is redacted', () => {
  const line = redact('scan failed for accounting@asburycabinets.com and bob@vendor.co.uk');
  assert.ok(!line.includes('accounting@'));
  assert.ok(!line.includes('bob@'));
  assert.ok(line.includes('@asburycabinets.com'), 'the domain stays, for diagnosis');
});

test('registered secrets never survive redaction', () => {
  registerSecret('super-secret-carrier-key-123456');
  assert.ok(!redact('key=super-secret-carrier-key-123456').includes('super-secret'));
});

// --- QA #1: an unconfirmed carrier is never published as confirmed ---

test('a carrier guessed from a pattern is published flagged as unconfirmed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asbury-qa-'));
  const key = randomBytes(32).toString('base64');
  try {
    const store = new Store(dir, key);
    await store.load();
    const p = newPackage('9400111899223818747820', {});
    p.candidateCarriers = ['usps'];
    applyResolution(p, unavailable('usps', 'CARRIER_ACCESS_DENIED'));
    store.state.packages[p.number] = p;

    await writePublicView(dir, store.state, { stateKey: key }, { deepLink, REASON_TEXT });
    const view = decryptJson(keyFromBase64(key),
      JSON.parse(await readFile(join(dir, 'view.enc.json'), 'utf8')));

    const item = view.packages[0];
    assert.equal(item.confidence, 'UNCONFIRMED');
    assert.equal(item.carrierIsConfirmed, false,
      'the UI relies on this flag to avoid stating a guessed carrier as fact');
    assert.equal(item.carrier, 'usps', 'the guess is still carried, but flagged');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- QA #10: every reason code the UI can receive has wording ---

test('every reason code emitted by the system has human wording', async () => {
  const emitted = [
    'CARRIER_NOT_CONFIGURED', 'CARRIER_ACCESS_DENIED', 'CARRIER_AUTH_FAILED',
    'CARRIER_API_ERROR', 'CARRIER_NO_RECORD', 'NO_FREE_AUTHORITATIVE_API',
    'RATE_LIMITED', 'BUDGET_EXHAUSTED', 'NOT_YET_CHECKED',
    'USPS_RECIPIENT_NOT_AUTHORISED', 'NO_CANDIDATE_CARRIER',
  ];
  for (const code of emitted) {
    assert.ok(REASON_TEXT[code], `${code} must have plain-English wording`);
    assert.notEqual(REASON_TEXT[code], code);
  }
});

// --- QA #11: a failed batch does not charge the budget twice ---

test('a refunded batch reservation does not double-charge the daily budget', () => {
  const b = new Budget({}, { fedex: 10 });
  assert.equal(b.take('fedex', 4), true);
  assert.equal(b.remaining('fedex'), 6);
  b.refund('fedex', 4);
  assert.equal(b.remaining('fedex'), 10);
  b.refund('fedex', 99);
  assert.equal(b.remaining('fedex'), 10, 'a refund can never push usage below zero');
});
