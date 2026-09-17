/**
 * Carrier registry and authoritative status resolution.
 *
 * THIS IS THE FILE THAT DECIDES WHAT DEREK IS TOLD.
 *
 * Resolution rules, in force for every package on every run:
 *
 *  1. A package's carrier is UNKNOWN until a carrier's own API returns a
 *     record for its number. Matching a number pattern proves nothing.
 *  2. Candidate carriers are probed in order. The first authoritative hit
 *     wins and the carrier is then pinned for that package.
 *  3. Only a pinned, API-confirmed package can carry confidence
 *     API_CONFIRMED. Everything else is UNCONFIRMED and is shown to Derek as
 *     UNCONFIRMED, with a machine-readable reason and a human sentence.
 *  4. DELIVERED is only ever set from a carrier's structured status code.
 *     Email text never sets it. A prior DELIVERED is never revoked by a
 *     transient API failure - the last authoritative answer stands, with its
 *     own timestamp shown.
 */

import { createUpsClient } from './ups.mjs';
import { createFedexClient } from './fedex.mjs';
import { createUspsClient } from './usps.mjs';
import { createDhlClient } from './dhl.mjs';
import { STAGE, unavailable } from './common.mjs';
import { log, maskNumber } from '../log.mjs';

export { STAGE, TERMINAL_STAGES } from './common.mjs';

/** Human-readable explanation for every reason code the UI can receive. */
export const REASON_TEXT = {
  CARRIER_NOT_CONFIGURED: 'No API credentials are set up for this carrier yet.',
  CARRIER_ACCESS_DENIED: 'The carrier refused the lookup for this account.',
  CARRIER_AUTH_FAILED: 'Could not authenticate with the carrier.',
  CARRIER_API_ERROR: 'The carrier API returned an error.',
  CARRIER_NO_RECORD: 'No carrier has a record of this number yet.',
  NO_FREE_AUTHORITATIVE_API: 'This carrier has no free tracking API, so status cannot be confirmed.',
  RATE_LIMITED: 'The carrier rate-limited the lookup; it will be retried.',
  BUDGET_EXHAUSTED: 'The free daily call allowance for this carrier is used up; it will resume tomorrow.',
  NOT_YET_CHECKED: 'Not looked up yet.',
  NO_CANDIDATE_CARRIER: 'This number does not match any carrier format we can look up.',
  USPS_RECIPIENT_NOT_AUTHORISED:
    'USPS only gives free tracking to the shipper who owns the Mailer ID. Asbury is the recipient here, so USPS will not confirm this one.',
};

export const DEEP_LINKS = {
  ups: (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`,
  fedex: (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`,
  usps: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}`,
  dhl: (n) => `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${encodeURIComponent(n)}`,
  amazon: () => 'https://www.amazon.com/gp/css/order-history',
  ontrac: (n) => `https://www.ontrac.com/tracking/?number=${encodeURIComponent(n)}`,
};

export function deepLink(carrier, number) {
  const fn = DEEP_LINKS[carrier];
  return fn ? fn(number) : null;
}

/** Build the set of carrier clients that actually have credentials. */
export function buildClients(config) {
  const clients = {};
  const c = config.carriers;
  if (c.ups.clientId && c.ups.clientSecret) clients.ups = createUpsClient(c.ups);
  if (c.fedex.clientId && c.fedex.clientSecret) clients.fedex = createFedexClient(c.fedex);
  if (c.usps.clientId && c.usps.clientSecret) clients.usps = createUspsClient(c.usps);
  if (c.dhl.apiKey) clients.dhl = createDhlClient(c.dhl);
  return clients;
}

/**
 * Resolve one package against the carriers.
 *
 * @param {object} pkg      package record (mutated only by the caller)
 * @param {object} clients  from buildClients()
 * @param {Budget} budget
 * @returns {Promise<{result:object, attempts:Array}>}
 */
export async function resolvePackage(pkg, clients, budget) {
  const attempts = [];

  // A pinned carrier is re-checked directly; no need to re-probe the others.
  const order = pkg.carrier && pkg.carrier !== 'unknown'
    ? [pkg.carrier]
    : (pkg.candidateCarriers || []);

  if (order.length === 0) {
    return {
      result: unavailable('unknown', 'NO_CANDIDATE_CARRIER'),
      attempts,
    };
  }

  let lastUnavailable = null;

  for (const carrier of order) {
    // Carriers with no free authoritative API are never "attempted" - saying
    // so plainly is more accurate than a failed call.
    if (carrier === 'amazon' || carrier === 'ontrac') {
      const r = unavailable(carrier, 'NO_FREE_AUTHORITATIVE_API');
      attempts.push({ carrier, outcome: 'NO_FREE_AUTHORITATIVE_API' });
      lastUnavailable = lastUnavailable || r;
      continue;
    }

    const client = clients[carrier];
    if (!client) {
      const r = unavailable(carrier, 'CARRIER_NOT_CONFIGURED');
      attempts.push({ carrier, outcome: 'CARRIER_NOT_CONFIGURED' });
      lastUnavailable = lastUnavailable || r;
      continue;
    }

    if (!budget.take(carrier)) {
      const r = unavailable(carrier, 'BUDGET_EXHAUSTED');
      attempts.push({ carrier, outcome: 'BUDGET_EXHAUSTED' });
      lastUnavailable = lastUnavailable || r;
      continue;
    }

    let result;
    try {
      result = await client.track(pkg.number);
    } catch (err) {
      result = unavailable(carrier, 'CARRIER_API_ERROR', err.message);
    }

    attempts.push({
      carrier,
      outcome: result.found ? `FOUND:${result.stage}` : (result.reason || 'NOT_FOUND'),
    });

    if (result.found) {
      // Authoritative hit. If our checksum layer had rejected this number for
      // this carrier, the carrier is right and our algorithm needs attention.
      if (pkg.admissionBasis && pkg.admissionBasis !== 'CHECKSUM') {
        log.info('Carrier confirmed a number admitted without a checksum pass', {
          number: maskNumber(pkg.number), carrier, basis: pkg.admissionBasis,
        });
      }
      return { result, attempts };
    }

    if (result.unavailable) lastUnavailable = lastUnavailable || result;
  }

  // Nothing authoritative. Prefer reporting a real obstacle over "no record".
  const fallback = lastUnavailable || unavailable(order[0], 'CARRIER_NO_RECORD');

  // Make the USPS recipient case legible rather than cryptic.
  if (fallback.carrier === 'usps' && fallback.reason === 'CARRIER_ACCESS_DENIED') {
    fallback.reason = 'USPS_RECIPIENT_NOT_AUTHORISED';
  }
  return { result: fallback, attempts };
}

/** Resolve many packages, using FedEx's batch endpoint where it applies. */
export async function resolveAll(packages, clients, budget) {
  const out = new Map();

  // FedEx batch path: only for packages already pinned to FedEx.
  const fedexPinned = packages.filter((p) => p.carrier === 'fedex');
  if (fedexPinned.length > 1 && clients.fedex) {
    const calls = Math.ceil(fedexPinned.length / 30);
    if (budget.take('fedex', calls)) {
      try {
        const results = await clients.fedex.trackMany(fedexPinned.map((p) => p.number));
        for (const p of fedexPinned) {
          const r = results.get(p.number);
          if (r) out.set(p.number, { result: r, attempts: [{ carrier: 'fedex', outcome: r.found ? `FOUND:${r.stage}` : (r.reason || 'NOT_FOUND') }] });
        }
      } catch (err) {
        // The batch threw, so those calls did not land. Hand the budget back
        // rather than charging twice when the per-package path retries.
        budget.refund('fedex', calls);
        log.warn('FedEx batch lookup failed; falling back to per-package', { error: err.message });
      }
    }
  }

  for (const pkg of packages) {
    if (out.has(pkg.number)) continue;
    out.set(pkg.number, await resolvePackage(pkg, clients, budget));
  }
  return out;
}
