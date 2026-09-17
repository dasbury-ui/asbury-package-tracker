/**
 * End-to-end: emails in, encrypted published view out, with no network.
 *
 * This exercises the real extractor, the real state store, the real
 * encryption and the real publisher, with only the carrier HTTP clients
 * replaced by stubs. It is the test that would catch a wiring mistake
 * between modules that the unit tests each pass in isolation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { extractFromEmail } from '../src/tracking/extract.mjs';
import { Store, newPackage, addSighting, applyResolution, isDue } from '../src/state.mjs';
import { writePublicView } from '../src/publish.mjs';
import { Budget } from '../src/budget.mjs';
import { resolveAll, deepLink, REASON_TEXT, STAGE } from '../src/carriers/index.mjs';
import { found, notFound, unavailable } from '../src/carriers/common.mjs';
import { decryptJson, keyFromBase64 } from '../src/crypto.mjs';

const STATE_KEY = randomBytes(32).toString('base64');

const POLL = {
  unresolvedMinutes: 0, inTransitMinutes: 120, outForDeliveryMinutes: 15,
  exceptionMinutes: 60, giveUpUnresolvedHours: 96, keepDeliveredDays: 14,
};

const INBOX = [
  {
    messageId: 'e1', mailbox: 'dasbury@asburycabinets.com',
    from: 'A&M Supply <orders@amsupply.com>', date: '2026-09-14T09:00:00Z',
    subject: 'Your A&M Supply order has shipped',
    text: 'Your order shipped. Tracking number: 1Z999AA10123456784. Thanks.',
    html: '',
  },
  {
    // Same package, later email. Must merge, not duplicate.
    messageId: 'e2', mailbox: 'dasbury@asburycabinets.com',
    from: 'A&M Supply <orders@amsupply.com>', date: '2026-09-15T09:00:00Z',
    subject: 'Out for delivery',
    text: 'Package 1Z999AA10123456784 is out for delivery and was delivered at 2pm.',
    html: '',
  },
  {
    // Second package, different mailbox, found via a carrier link.
    messageId: 'e3', mailbox: 'shop@asburycabinets.com',
    from: 'Richelieu <ship@richelieu.com>', date: '2026-09-15T11:00:00Z',
    subject: 'Shipment notice',
    text: 'Your hardware is on the way.',
    html: '<a href="https://www.fedex.com/fedextrack/?trknbr=770123456789">Track it</a>',
  },
  {
    // USPS package the carrier will refuse to confirm.
    messageId: 'e4', mailbox: 'dasbury@asburycabinets.com',
    from: 'Small Vendor <sales@vendor.example>', date: '2026-09-15T12:00:00Z',
    subject: 'Shipped via USPS',
    text: 'USPS tracking number 9400111899223818747820',
    html: '',
  },
  {
    // Pure noise: an invoice number that must never become a package.
    messageId: 'e5', mailbox: 'accounting@asburycabinets.com',
    from: 'Billing <ar@supplier.example>', date: '2026-09-15T13:00:00Z',
    subject: 'Invoice 887711',
    text: 'Invoice 887711 for $4,812.19, PO 1Z999AA10123456785, net 30.',
    html: '',
  },
];

const stubClients = {
  ups: {
    name: 'ups',
    track: async () => found({
      carrier: 'ups', stage: STAGE.OUT_FOR_DELIVERY,
      carrierStatusCode: '012', carrierStatusText: 'Out For Delivery Today',
      lastEventAt: '2026-09-16T08:12:00Z', lastEventLocation: 'Williamsburg, VA, US',
      service: 'UPS Ground',
      events: [{ at: '2026-09-16T08:12:00Z', text: 'Out For Delivery', location: 'Williamsburg, VA' }],
    }),
  },
  fedex: {
    name: 'fedex',
    track: async () => found({
      carrier: 'fedex', stage: STAGE.IN_TRANSIT,
      carrierStatusCode: 'IT', carrierStatusText: 'In transit',
      lastEventAt: '2026-09-16T04:00:00Z', lastEventLocation: 'Richmond, VA, US',
    }),
    trackMany: async (numbers) => new Map(numbers.map((n) => [n, found({
      carrier: 'fedex', stage: STAGE.IN_TRANSIT, carrierStatusCode: 'IT',
      carrierStatusText: 'In transit',
    })])),
  },
  usps: {
    name: 'usps',
    track: async () => unavailable('usps', 'CARRIER_ACCESS_DENIED',
      'USPS restricts free tracking to the shipper who owns the Mailer ID'),
  },
};

test('end to end: five emails become three correct packages and an encrypted view', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asbury-e2e-'));
  try {
    const store = new Store(dir, STATE_KEY);
    await store.load();
    const state = store.state;

    // --- ingest ---
    let rejectedCount = 0;
    for (const email of INBOX) {
      const { admitted, rejected } = extractFromEmail(email);
      rejectedCount += rejected.length;
      for (const a of admitted) {
        if (state.packages[a.number]) addSighting(state.packages[a.number], a);
        else {
          const p = newPackage(a.number, a);
          addSighting(p, a);
          state.packages[a.number] = p;
        }
      }
    }

    const numbers = Object.keys(state.packages).sort();
    assert.deepEqual(numbers, [
      '1Z999AA10123456784',
      '770123456789',
      '9400111899223818747820',
    ], 'exactly three real packages, and the bad PO is not one of them');
    assert.ok(rejectedCount > 0, 'the invoice noise must be recorded as rejected');

    assert.equal(state.packages['1Z999AA10123456784'].sightings.length, 2,
      'the same number in two emails is one package with two sightings');

    // Before any carrier call, nothing may claim a status.
    for (const p of Object.values(state.packages)) {
      assert.equal(p.confidence, 'UNCONFIRMED');
      assert.equal(p.stage, STAGE.UNKNOWN);
    }

    // --- resolve ---
    const budget = new Budget({}, { ups: 100, fedex: 100, usps: 100, dhl: 200 });
    const due = Object.values(state.packages).filter((p) => isDue(p, POLL));
    assert.equal(due.length, 3);
    const results = await resolveAll(due, stubClients, budget);
    for (const p of due) applyResolution(p, results.get(p.number).result);

    const ups = state.packages['1Z999AA10123456784'];
    assert.equal(ups.confidence, 'API_CONFIRMED');
    assert.equal(ups.stage, STAGE.OUT_FOR_DELIVERY);
    assert.equal(ups.carrier, 'ups');
    assert.notEqual(ups.stage, STAGE.DELIVERED,
      'the email said "was delivered" - only the carrier may say that, and it did not');

    const fedex = state.packages['770123456789'];
    assert.equal(fedex.confidence, 'API_CONFIRMED');
    assert.equal(fedex.carrier, 'fedex');

    const usps = state.packages['9400111899223818747820'];
    assert.equal(usps.confidence, 'UNCONFIRMED');
    assert.equal(usps.reason, 'USPS_RECIPIENT_NOT_AUTHORISED');
    assert.equal(usps.carrier, 'unknown');

    // --- publish ---
    await writePublicView(dir, state, { stateKey: STATE_KEY }, { deepLink, REASON_TEXT });
    await store.save({ ok: true, finishedAt: new Date().toISOString() });

    // --- what actually landed on disk ---
    const rawView = await readFile(join(dir, 'view.enc.json'), 'utf8');
    assert.ok(!rawView.includes('1Z999AA10123456784'), 'no tracking number in the published bytes');
    assert.ok(!rawView.includes('A&M Supply'), 'no vendor name in the published bytes');
    assert.ok(!rawView.includes('asburycabinets'), 'no mailbox in the published bytes');

    const rawState = await readFile(join(dir, 'packages.enc.json'), 'utf8');
    assert.ok(!rawState.includes('1Z999AA10123456784'));
    assert.ok(!rawState.includes('amsupply.com'));

    const health = JSON.parse(await readFile(join(dir, 'health.json'), 'utf8'));
    assert.equal(health.ok, true, 'health must be readable without the key');

    // --- what the phone sees ---
    const view = decryptJson(keyFromBase64(STATE_KEY), JSON.parse(rawView));
    assert.equal(view.packages.length, 3);
    assert.equal(view.counts.outForDelivery, 1);
    assert.equal(view.counts.unconfirmed, 1);

    // Out for delivery sorts to the top; that is what Derek needs to see first.
    assert.equal(view.packages[0].stage, STAGE.OUT_FOR_DELIVERY);

    const uspsView = view.packages.find((p) => p.confidence !== 'API_CONFIRMED');
    assert.match(uspsView.reasonText, /Mailer ID/,
      'an unconfirmed package must carry a plain-English reason');
    assert.ok(uspsView.link, 'and a link so it can still be checked by hand');

    // Every confirmed package carries the carrier wording verbatim.
    for (const p of view.packages.filter((x) => x.confidence === 'API_CONFIRMED')) {
      assert.ok(p.carrierStatusText, 'carrier wording must be passed through');
      assert.equal(p.carrierIsConfirmed, true);
    }

    // --- second run must be idempotent ---
    const store2 = new Store(dir, STATE_KEY);
    await store2.load();
    assert.equal(Object.keys(store2.state.packages).length, 3);
    for (const email of INBOX) {
      const { admitted } = extractFromEmail(email);
      for (const a of admitted) {
        if (store2.state.packages[a.number]) addSighting(store2.state.packages[a.number], a);
      }
    }
    assert.equal(Object.keys(store2.state.packages).length, 3,
      're-processing the same mail must not create new packages');
    assert.equal(store2.state.packages['1Z999AA10123456784'].sightings.length, 2,
      'nor duplicate sightings');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt state file stops the run instead of silently starting over', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asbury-corrupt-'));
  try {
    const store = new Store(dir, STATE_KEY);
    await store.load();
    store.state.packages.X = newPackage('1Z999AA10123456784', {});
    await store.save({ ok: true });

    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'packages.enc.json'), '{"v":1,"alg":"AES-256-GCM","iv":"AAAA","tag":"AAAA","ct":"AAAA"}');

    const store2 = new Store(dir, STATE_KEY);
    await assert.rejects(() => store2.load(), /Refusing to overwrite/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
