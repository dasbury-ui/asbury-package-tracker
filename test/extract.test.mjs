import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFromEmail } from '../src/tracking/extract.mjs';
import { compute } from '../src/tracking/checksums.mjs';

const email = (over = {}) => ({
  messageId: 'm1', mailbox: 'dasbury@asburycabinets.com',
  subject: '', from: 'A&M Supply <orders@amsupply.com>', date: '2026-09-15T12:00:00Z',
  text: '', html: '', ...over,
});

test('a valid UPS number with a tracking label is admitted on its checksum', () => {
  const { admitted } = extractFromEmail(email({
    subject: 'Your order has shipped',
    text: 'Tracking number: 1Z999AA10123456784. Thanks for your order.',
  }));
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].number, '1Z999AA10123456784');
  assert.equal(admitted[0].admissionBasis, 'CHECKSUM');
  assert.deepEqual(admitted[0].candidateCarriers, ['ups']);
});

test('a lookalike number that fails its checksum is rejected with a reason', () => {
  const { admitted, rejected } = extractFromEmail(email({
    text: 'Reference 1Z999AA10123456785 on your invoice.',
  }));
  assert.equal(admitted.length, 0);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].rejectReason, /^CHECKSUM_FAILED:/);
  assert.match(rejected[0].rejectReason, /ups=UPS_EXPECTED_4/);
});

test('an unlabelled number of no known shape is rejected, not tracked', () => {
  const { admitted, rejected } = extractFromEmail(email({
    text: 'Invoice 8891234 total $482.19, PO ABC-99127733',
  }));
  assert.equal(admitted.length, 0);
  assert.ok(rejected.every((r) => r.rejectReason));
});

test('a number lifted from a carrier tracking link is admitted even without a checksum', () => {
  const { admitted } = extractFromEmail(email({
    html: '<a href="https://www.ups.com/track?loc=en_US&tracknum=1Z999AA10123456785">Track</a>',
  }));
  const hit = admitted.find((a) => a.number === '1Z999AA10123456785');
  assert.ok(hit, 'the linked number must be admitted');
  assert.equal(hit.admissionBasis, 'CARRIER_LINK');
  assert.ok(hit.candidateCarriers.includes('ups'));
});

test('the same number in three emails produces one decision per email, one number', () => {
  const numbers = new Set();
  for (const [i, subject] of ['Order confirmed', 'Shipped', 'Delivered'].entries()) {
    const { admitted } = extractFromEmail(email({
      messageId: `m${i}`, subject,
      text: `Tracking number 1Z999AA10123456784`,
    }));
    for (const a of admitted) numbers.add(a.number);
  }
  assert.equal(numbers.size, 1);
});

test('the word "delivered" in an email body never produces a delivered status', () => {
  const { admitted } = extractFromEmail(email({
    subject: 'Your package was delivered',
    text: 'Your package 1Z999AA10123456784 was delivered at 2:14pm today.',
  }));
  assert.equal(admitted.length, 1);
  // The extractor has no status field at all. Status can only come from a
  // carrier API, which is the point.
  assert.equal(admitted[0].stage, undefined);
  assert.equal(admitted[0].status, undefined);
});

test('a USPS IMpb number is admitted and points at USPS', () => {
  // Build a valid IMpb: 21 body digits plus the mod-10 check digit.
  const body = '940011899223818747820';
  const full = body + compute.mod10Weighted31(body);
  const { admitted } = extractFromEmail(email({ text: `USPS tracking number ${full}` }));
  const hit = admitted.find((a) => a.number === full);
  assert.ok(hit, 'valid IMpb must be admitted');
  assert.ok(hit.candidateCarriers.includes('usps'));
});

test('Amazon Logistics numbers are recognised but flagged as untrackable', () => {
  const { admitted } = extractFromEmail(email({
    text: 'Your tracking ID is TBA303412345678',
  }));
  const hit = admitted.find((a) => a.number === 'TBA303412345678');
  assert.ok(hit);
  assert.equal(hit.admissionBasis, 'LABELLED');
  assert.ok(hit.formats.some((f) => f.trackable === false));
});

test('a number split across formatting is still recognised', () => {
  const { admitted } = extractFromEmail(email({
    text: 'Tracking: 1Z 999 AA1 01 2345 6784',
  }));
  assert.ok(admitted.some((a) => a.number === '1Z999AA10123456784'));
});

test('every candidate produces a traceable decision record', () => {
  const { admitted, rejected } = extractFromEmail(email({
    messageId: 'msg-abc',
    text: 'Tracking 1Z999AA10123456784 and reference 1Z999AA10123456785',
  }));
  for (const d of [...admitted, ...rejected]) {
    assert.equal(d.messageId, 'msg-abc');
    assert.equal(d.mailbox, 'dasbury@asburycabinets.com');
    assert.ok(Array.isArray(d.sources) && d.sources.length > 0);
    assert.ok(d.admitted ? d.admissionBasis : d.rejectReason);
  }
});
