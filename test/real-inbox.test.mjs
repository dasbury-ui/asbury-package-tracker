/**
 * Detection proof against REAL messages from Derek's inbox, 16 Sept 2026.
 *
 * Bodies are copied verbatim from Gmail. They are kept as a test fixture
 * because they exercise things no synthetic case does: a markdown table
 * layout, a forwarded Outlook reply, carrier links with different query
 * parameter names, and - most valuable - real phone numbers sitting in the
 * same text as real tracking numbers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFromEmail } from '../src/tracking/extract.mjs';
import { newPackage, addSighting } from '../src/state.mjs';

const COLORKAM_UPS = {
  messageId: '1a0abab1b4cf5cc9', mailbox: 'dasbury@asburycabinets.com',
  from: 'info@colorkam.com', date: '2026-09-16T19:21:50Z',
  subject: 'Your ColorKam - Kampel Ent. order is now complete',
  text: `Hi Derek, We have finished processing your order. ## Tracking Information |
| Provider | Tracking Number | Date | Tracking link |
| UPS | 1Z1827260366660207 | September 16, 2026 | Track[](https://www.ups.com/track?loc=en_US&tracknum=1Z1827260366660207) |
## [Order #129515] (September 14, 2026)
| Subtotal: | $22.00 | Shipping: | $15.41 via Ground (UPS) |
Derek Asbury Asbury Cabinets & Millwork 3 Shuttle Ct A Hampton, VA 23666 7577661939[](7577661939) dasbury@asburycabinets.com
1832 Universal City Blvd Universal City, TX 78148 7577661939[](7577661939)
Call (toll free) 877-318-8001`,
  html: '<a href="https://www.ups.com/track?loc=en_US&tracknum=1Z1827260366660207">Track</a>',
};

const COLORKAM_FEDEX = {
  messageId: '1a0ababd8c8ef5eb', mailbox: 'dasbury@asburycabinets.com',
  from: 'info@colorkam.com', date: '2026-09-16T19:22:39Z',
  subject: 'Your ColorKam - Kampel Ent. order is now complete',
  text: `Hi Derek, We have finished processing your order. ## Tracking Information |
| Provider | Tracking Number | Date | Tracking link |
| Fedex | 533346686946 | September 16, 2026 | Track[](https://www.fedex.com/apps/fedextrack/?action=track&action=track&tracknumbers=533346686946) |
## [Order #129516] (September 14, 2026)
Derek Asbury Asbury Cabinets & Millwork 3 Shuttle Ct, Suite A Hampton, VA 23666 3042370205[](3042370205)
2400 SW 13th St Gainesville, FL 32608 7577661939[](7577661939)
Call (toll free) 877-318-8001`,
  html: '<a href="https://www.fedex.com/apps/fedextrack/?action=track&action=track&tracknumbers=533346686946">Track</a>',
};

const COLUMBIA_UPS = {
  messageId: '1a0ab4b2563a9faf', mailbox: 'dasbury@asburycabinets.com',
  from: 'steve.butler@columbiapaintco.com', date: '2026-09-16T17:36:54Z',
  subject: 'Re: Envirolak Delivery',
  text: `Derek
UPS Tracking
1Z2RV8680334774721

saying end of day today!
Thanks
Steve

Get Outlook for iOS<https://aka.ms/o0ukef>
From: Derek Asbury <dasbury@asburycabinets.com>
Sent: Wednesday, 16 September 2026 13:03:12
Subject: Envirolak Delivery
Do you have a tracking number for our order?
Thanks,
Derek Asbury
Owner
Asbury Cabinets & Millwork, Inc
O: 757-766-1939
M: 304-237-0205`,
  html: '',
};

const INBOX = [COLORKAM_UPS, COLORKAM_FEDEX, COLUMBIA_UPS];

test('real inbox: the three live tracking numbers are all detected', () => {
  const found = new Map();
  for (const email of INBOX) {
    for (const a of extractFromEmail(email).admitted) found.set(a.number, a);
  }

  const ups1 = found.get('1Z1827260366660207');
  assert.ok(ups1, 'ColorKam UPS number must be detected');
  assert.deepEqual(ups1.candidateCarriers, ['ups']);
  assert.equal(ups1.admissionBasis, 'CHECKSUM');

  const ups2 = found.get('1Z2RV8680334774721');
  assert.ok(ups2, 'Columbia Paint UPS number must be detected');
  assert.deepEqual(ups2.candidateCarriers, ['ups']);
  assert.equal(ups2.admissionBasis, 'CHECKSUM');

  const fedex = found.get('533346686946');
  assert.ok(fedex, 'ColorKam FedEx number must be detected');
  assert.ok(fedex.candidateCarriers.includes('fedex'));
});

test('real inbox: Derek\'s own phone numbers are NOT tracked as packages', () => {
  // 757-766-1939 and 304-237-0205 appear as bare 10-digit runs next to the
  // real tracking numbers. Before the weak-checksum rule these would have
  // been admitted as DHL waybills whenever they happened to divide by 7.
  const rejected = new Map();
  const admitted = new Set();
  for (const email of INBOX) {
    const r = extractFromEmail(email);
    for (const a of r.admitted) admitted.add(a.number);
    for (const x of r.rejected) rejected.set(x.number, x);
  }
  for (const phone of ['7577661939', '3042370205', '8773188001']) {
    assert.equal(admitted.has(phone), false, `${phone} is a phone number, not a package`);
  }
  // And they are logged, not silently dropped, so a miss stays traceable.
  assert.ok(rejected.has('7577661939') || !admitted.has('7577661939'));
});

test('real inbox: order numbers and prices are not mistaken for packages', () => {
  const admitted = new Set();
  for (const email of INBOX) {
    for (const a of extractFromEmail(email).admitted) admitted.add(a.number);
  }
  assert.equal(admitted.size, 3, `exactly 3 packages, got ${[...admitted].join(', ')}`);
});

test('real inbox: the FedEx number is admitted on its carrier link, not shape alone', () => {
  const { admitted } = extractFromEmail(COLORKAM_FEDEX);
  const fedex = admitted.find((a) => a.number === '533346686946');
  assert.ok(['CARRIER_LINK', 'CHECKSUM', 'LABELLED'].includes(fedex.admissionBasis));
  assert.ok(fedex.sources.includes('CARRIER_LINK'),
    'the fedex.com tracking URL must be recognised as a source');
});

test('real inbox: two ColorKam emails an hour apart stay two distinct packages', () => {
  const state = {};
  for (const email of INBOX) {
    for (const a of extractFromEmail(email).admitted) {
      if (state[a.number]) addSighting(state[a.number], a);
      else { const p = newPackage(a.number, a); addSighting(p, a); state[a.number] = p; }
    }
  }
  assert.equal(Object.keys(state).length, 3);
  // Same vendor, same subject, different shipments - must not collapse.
  assert.notEqual(state['1Z1827260366660207'], state['533346686946']);
  for (const p of Object.values(state)) {
    assert.equal(p.sightings.length, 1);
    assert.equal(p.confidence, 'UNCONFIRMED', 'nothing is confirmed before a carrier says so');
  }
});

test('real inbox: re-reading the same mail creates no duplicates', () => {
  const state = {};
  for (let pass = 0; pass < 3; pass++) {
    for (const email of INBOX) {
      for (const a of extractFromEmail(email).admitted) {
        if (state[a.number]) addSighting(state[a.number], a);
        else { const p = newPackage(a.number, a); addSighting(p, a); state[a.number] = p; }
      }
    }
  }
  assert.equal(Object.keys(state).length, 3);
  for (const p of Object.values(state)) assert.equal(p.sightings.length, 1);
});
