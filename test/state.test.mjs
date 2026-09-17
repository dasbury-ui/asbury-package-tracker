import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyState, newPackage, addSighting, applyResolution, isDue,
  markGivenUp, applyRetention,
} from '../src/state.mjs';
import { Budget } from '../src/budget.mjs';
import { resolvePackage, STAGE } from '../src/carriers/index.mjs';
import { found, notFound, unavailable } from '../src/carriers/common.mjs';

const POLL = {
  unresolvedMinutes: 0, inTransitMinutes: 120, outForDeliveryMinutes: 15,
  exceptionMinutes: 60, giveUpUnresolvedHours: 96, keepDeliveredDays: 14,
};
const sighting = (over = {}) => ({
  messageId: 'm1', mailbox: 'a@asburycabinets.com', subject: 'Shipped',
  from: 'A&M <o@amsupply.com>', emailDate: '2026-09-15T12:00:00Z',
  admissionBasis: 'CHECKSUM', candidateCarriers: ['ups'], ...over,
});

test('a new package starts UNCONFIRMED with no status claimed', () => {
  const p = newPackage('1Z999AA10123456784', sighting());
  assert.equal(p.confidence, 'UNCONFIRMED');
  assert.equal(p.stage, STAGE.UNKNOWN);
  assert.equal(p.carrier, 'unknown');
  assert.equal(p.reason, 'NOT_YET_CHECKED');
});

test('the same message is never counted as two sightings', () => {
  const p = newPackage('1Z999AA10123456784', sighting());
  assert.equal(addSighting(p, sighting()), true);
  assert.equal(addSighting(p, sighting()), false);
  assert.equal(p.sightings.length, 1);
});

test('the same number from three different emails is one package, three sightings', () => {
  const p = newPackage('1Z999AA10123456784', sighting());
  addSighting(p, sighting({ messageId: 'order' }));
  addSighting(p, sighting({ messageId: 'shipped' }));
  addSighting(p, sighting({ messageId: 'delivered-notice' }));
  assert.equal(p.sightings.length, 3);
});

test('an authoritative hit pins the carrier and marks the package confirmed', () => {
  const p = newPackage('1Z999AA10123456784', sighting());
  applyResolution(p, found({
    carrier: 'ups', stage: STAGE.IN_TRANSIT,
    carrierStatusCode: 'I', carrierStatusText: 'In Transit',
  }));
  assert.equal(p.carrier, 'ups');
  assert.equal(p.confidence, 'API_CONFIRMED');
  assert.equal(p.stage, STAGE.IN_TRANSIT);
  assert.equal(p.reason, null);
});

test('DELIVERED is only ever set from a carrier status, and records when', () => {
  const p = newPackage('1Z999AA10123456784', sighting());
  applyResolution(p, found({
    carrier: 'ups', stage: STAGE.DELIVERED, carrierStatusCode: '011',
    carrierStatusText: 'Delivered', lastEventAt: '2026-09-16T14:02:00Z',
  }));
  assert.equal(p.stage, STAGE.DELIVERED);
  assert.equal(p.deliveredAt, '2026-09-16T14:02:00Z');
});

test('a failed lookup never revokes a previously confirmed status', () => {
  const p = newPackage('1Z999AA10123456784', sighting());
  applyResolution(p, found({ carrier: 'ups', stage: STAGE.IN_TRANSIT }));
  applyResolution(p, unavailable('ups', 'CARRIER_API_ERROR', 'HTTP 500'));
  assert.equal(p.confidence, 'API_CONFIRMED');
  assert.equal(p.stage, STAGE.IN_TRANSIT);
  assert.equal(p.staleReason, 'CARRIER_API_ERROR');
  assert.equal(p.consecutiveFailures, 1);
});

test('a never-confirmed package stays UNCONFIRMED and carries the reason', () => {
  const p = newPackage('9400111899223818747820', sighting({ candidateCarriers: ['usps'] }));
  applyResolution(p, unavailable('usps', 'CARRIER_ACCESS_DENIED'));
  assert.equal(p.confidence, 'UNCONFIRMED');
  assert.equal(p.reason, 'CARRIER_ACCESS_DENIED');
  assert.equal(p.carrier, 'unknown', 'an unconfirmed carrier must not be pinned');
  assert.equal(p.probableCarrier, 'usps');
});

test('a confirmed delivered package is not polled again', () => {
  const p = newPackage('1Z999AA10123456784', sighting());
  applyResolution(p, found({ carrier: 'ups', stage: STAGE.DELIVERED }));
  assert.equal(isDue(p, POLL), false);
});

test('out for delivery is polled far more often than in transit', () => {
  const now = Date.now();
  const mk = (stage) => {
    const p = newPackage('1Z999AA10123456784', sighting());
    applyResolution(p, found({ carrier: 'ups', stage }));
    p.lastCheckedAt = new Date(now - 30 * 60000).toISOString();
    return p;
  };
  assert.equal(isDue(mk(STAGE.OUT_FOR_DELIVERY), POLL, now), true);
  assert.equal(isDue(mk(STAGE.IN_TRANSIT), POLL, now), false);
});

test('repeated failures back off so one bad number cannot drain the budget', () => {
  const now = Date.now();
  const p = newPackage('1Z999AA10123456784', sighting());
  p.consecutiveFailures = 6;
  p.lastCheckedAt = new Date(now - 60 * 60000).toISOString();
  assert.equal(isDue(p, POLL, now), false, '6 failures means a 120 minute wait');
  p.lastCheckedAt = new Date(now - 130 * 60000).toISOString();
  assert.equal(isDue(p, POLL, now), true);
});

test('an unconfirmable package is given up on, stays visible, stops costing calls', () => {
  const now = Date.now();
  const p = newPackage('TBA303412345678', sighting({ candidateCarriers: ['amazon'] }));
  p.firstSeenAt = new Date(now - 200 * 3600000).toISOString();
  p.lastCheckedAt = new Date(now - 10 * 3600000).toISOString();
  assert.equal(isDue(p, POLL, now), false);
  assert.equal(markGivenUp(p, POLL, now), true);
  assert.equal(p.givenUp, true);
  assert.equal(markGivenUp(p, POLL, now), false, 'give-up is recorded once');
});

test('delivered packages are archived, then purged on the 30 day retention rule', () => {
  const state = emptyState();
  const now = Date.now();
  const mk = (id, daysAgo) => {
    const p = newPackage(id, sighting());
    applyResolution(p, found({ carrier: 'ups', stage: STAGE.DELIVERED }));
    p.deliveredAt = new Date(now - daysAgo * 86400000).toISOString();
    state.packages[id] = p;
  };
  mk('A', 1); mk('B', 20); mk('C', 40);
  const r = applyRetention(state, POLL, { purgeAfterDeliveryDays: 30 }, now);
  assert.equal(state.packages.A.archived, false);
  assert.equal(state.packages.B.archived, true);
  assert.equal(state.packages.C, undefined, 'past 30 days it is deleted outright');
  assert.deepEqual(r, { archived: 1, purged: 1 });
});

// ---- resolution ----

const fakeClient = (name, impl) => ({ name, track: async (n) => impl(n) });

test('the first carrier to return an authoritative record wins', async () => {
  const p = newPackage('123456789012', { candidateCarriers: ['fedex', 'dhl'] });
  p.candidateCarriers = ['fedex', 'dhl'];
  const clients = {
    fedex: fakeClient('fedex', () => notFound('fedex')),
    dhl: fakeClient('dhl', () => found({ carrier: 'dhl', stage: STAGE.IN_TRANSIT })),
  };
  const { result, attempts } = await resolvePackage(p, clients, new Budget({}, {}));
  assert.equal(result.found, true);
  assert.equal(result.carrier, 'dhl');
  assert.equal(attempts.length, 2);
});

test('when no carrier confirms, a real obstacle is reported over "no record"', async () => {
  const p = newPackage('123456789012', {});
  p.candidateCarriers = ['fedex', 'dhl'];
  const clients = {
    fedex: fakeClient('fedex', () => notFound('fedex')),
    dhl: fakeClient('dhl', () => unavailable('dhl', 'RATE_LIMITED')),
  };
  const { result } = await resolvePackage(p, clients, new Budget({}, {}));
  assert.equal(result.found, false);
  assert.equal(result.reason, 'RATE_LIMITED');
});

test('a carrier with no credentials reports CARRIER_NOT_CONFIGURED, not an error', async () => {
  const p = newPackage('123456789012', {});
  p.candidateCarriers = ['fedex'];
  const { result } = await resolvePackage(p, {}, new Budget({}, {}));
  assert.equal(result.reason, 'CARRIER_NOT_CONFIGURED');
});

test('the USPS recipient case gets its own legible reason', async () => {
  const p = newPackage('9400111899223818747820', {});
  p.candidateCarriers = ['usps'];
  const clients = { usps: fakeClient('usps', () => unavailable('usps', 'CARRIER_ACCESS_DENIED')) };
  const { result } = await resolvePackage(p, clients, new Budget({}, {}));
  assert.equal(result.reason, 'USPS_RECIPIENT_NOT_AUTHORISED');
});

test('the daily budget is enforced and reported rather than silently exceeded', async () => {
  const budget = new Budget({}, { dhl: 2 });
  const clients = { dhl: fakeClient('dhl', () => found({ carrier: 'dhl', stage: STAGE.IN_TRANSIT })) };
  const mk = () => { const p = newPackage('1234567890', {}); p.candidateCarriers = ['dhl']; return p; };

  assert.equal((await resolvePackage(mk(), clients, budget)).result.found, true);
  assert.equal((await resolvePackage(mk(), clients, budget)).result.found, true);
  const third = await resolvePackage(mk(), clients, budget);
  assert.equal(third.result.found, false);
  assert.equal(third.result.reason, 'BUDGET_EXHAUSTED');
  assert.equal(budget.report().dhl.used, 2);
  assert.equal(budget.report().dhl.denied, 1);
});

test('a budget from a previous day resets', () => {
  const stale = new Budget({ day: '2020-01-01', used: { dhl: 999 } }, { dhl: 10 });
  assert.equal(stale.remaining('dhl'), 10);
});

test('carriers with no free API are reported as such without burning a call', async () => {
  const p = newPackage('TBA303412345678', {});
  p.candidateCarriers = ['amazon'];
  const budget = new Budget({}, { dhl: 5 });
  const { result } = await resolvePackage(p, {}, budget);
  assert.equal(result.reason, 'NO_FREE_AUTHORITATIVE_API');
});
