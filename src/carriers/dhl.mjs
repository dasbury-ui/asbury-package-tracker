/**
 * DHL Shipment Tracking - Unified API client.
 *
 * GET https://api-eu.dhl.com/track/shipments?trackingNumber=X
 * Header: DHL-API-Key
 *
 * Free tier: 250 calls/day, max 1 call every 5 seconds. The 5-second floor is
 * enforced here; the daily cap is enforced by ../budget.mjs with a margin.
 *   Source: https://developer.dhl.com/api-reference/shipment-tracking
 *
 * DHL's developer terms require tracking data to be deleted 30 days after
 * delivery. That is implemented in ../state.mjs (retention.purgeAfterDeliveryDays)
 * and applied to every carrier, not just DHL.
 */

import { request } from '../http.mjs';
import { log, maskNumber } from '../log.mjs';
import { STAGE, found, notFound, unavailable, trimEvents, joinLocation } from './common.mjs';

const TRACK_URL = 'https://api-eu.dhl.com/track/shipments';
const MIN_INTERVAL_MS = 5200; // DHL: max 1 call every 5 seconds.

const STATUS_TO_STAGE = {
  'pre-transit': STAGE.PRE_TRANSIT,
  transit: STAGE.IN_TRANSIT,
  delivered: STAGE.DELIVERED,
  failure: STAGE.EXCEPTION,
  unknown: STAGE.UNKNOWN,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createDhlClient({ apiKey }) {
  let lastCallAt = 0;

  return {
    name: 'dhl',

    async track(number) {
      const since = Date.now() - lastCallAt;
      if (since < MIN_INTERVAL_MS) await sleep(MIN_INTERVAL_MS - since);
      lastCallAt = Date.now();

      const url = `${TRACK_URL}?trackingNumber=${encodeURIComponent(number)}`;
      const res = await request(url, {
        headers: { 'DHL-API-Key': apiKey, Accept: 'application/json' },
        // DHL rate-limits hard; do not hammer it on 429.
        maxAttempts: 2,
        retryBaseMs: 6000,
      });

      if (res.status === 404) return notFound('dhl');
      if (res.status === 401 || res.status === 403) {
        return unavailable('dhl', 'CARRIER_ACCESS_DENIED', `HTTP ${res.status}`);
      }
      if (res.status === 429) return unavailable('dhl', 'RATE_LIMITED', 'HTTP 429 daily or burst cap');
      if (!res.ok) return unavailable('dhl', 'CARRIER_API_ERROR', `HTTP ${res.status}`);

      const shipment = res.json?.shipments?.[0];
      if (!shipment) return notFound('dhl');

      const statusCode = String(shipment.status?.statusCode || '').toLowerCase();
      const stage = STATUS_TO_STAGE[statusCode] ?? STAGE.UNKNOWN;
      if (stage === STAGE.UNKNOWN) {
        log.warn('DHL status code not mapped; showing carrier text verbatim', {
          number: maskNumber(number), statusCode,
        });
      }

      const evts = Array.isArray(shipment.events) ? shipment.events : [];
      const events = trimEvents(evts.map((e) => ({
        at: e.timestamp || null,
        text: e.description || e.status || '',
        location: joinLocation([
          e.location?.address?.addressLocality,
          e.location?.address?.countryCode,
        ]),
      })));

      return found({
        carrier: 'dhl',
        stage,
        carrierStatusCode: shipment.status?.statusCode || null,
        carrierStatusText: shipment.status?.description || shipment.status?.status || null,
        lastEventAt: shipment.status?.timestamp || events[0]?.at || null,
        lastEventLocation: events[0]?.location || null,
        estimatedDelivery: shipment.estimatedTimeOfDelivery || null,
        service: shipment.service || null,
        events,
        // DHL's terms require this attribution wherever tracking data is shown.
        raw: { attribution: 'Delivered by Deutsche Post DHL Group' },
      });
    },
  };
}
