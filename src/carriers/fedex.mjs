/**
 * FedEx Track API client.
 *
 * OAuth: POST https://apis.fedex.com/oauth/token (client_credentials)
 *        Token valid ~1 hour; the token endpoint itself is limited to
 *        1,000 requests/day, so it is cached for the whole run.
 * Track: POST https://apis.fedex.com/track/v1/trackingnumbers
 *        Up to 30 numbers per call - used to stay well inside the free quota.
 *
 * Verified against developer.fedex.com, September 2026.
 */

import { request } from '../http.mjs';
import { log, maskNumber } from '../log.mjs';
import { STAGE, found, notFound, unavailable, trimEvents, joinLocation } from './common.mjs';

const OAUTH_URL = 'https://apis.fedex.com/oauth/token';
const TRACK_URL = 'https://apis.fedex.com/track/v1/trackingnumbers';
const BATCH_SIZE = 30;

/** FedEx derivedCode / code values. Unmapped codes yield UNKNOWN, not a guess. */
const CODE_TO_STAGE = {
  OC: STAGE.PRE_TRANSIT,   // Shipment information sent to FedEx
  PU: STAGE.IN_TRANSIT,    // Picked up
  PX: STAGE.IN_TRANSIT,
  IT: STAGE.IN_TRANSIT,    // In transit
  IX: STAGE.IN_TRANSIT,
  AR: STAGE.IN_TRANSIT,    // Arrived at facility
  DP: STAGE.IN_TRANSIT,    // Departed facility
  AF: STAGE.IN_TRANSIT,
  OD: STAGE.OUT_FOR_DELIVERY,
  DL: STAGE.DELIVERED,
  DE: STAGE.EXCEPTION,     // Delivery exception
  SE: STAGE.EXCEPTION,     // Shipment exception
  CA: STAGE.EXCEPTION,     // Cancelled
  RS: STAGE.RETURNED,      // Return to shipper
  HL: STAGE.IN_TRANSIT,    // Hold at location
};

const NOT_FOUND_CODES = /NOTFOUND|NOT\.FOUND|TRACKING\.TRACKINGNUMBER\.EMPTY/i;

export function createFedexClient({ clientId, clientSecret }) {
  let token = null;
  let tokenExpiresAt = 0;

  async function getToken() {
    if (token && Date.now() < tokenExpiresAt - 60000) return token;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }).toString();
    const res = await request(OAUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok || !res.json?.access_token) {
      throw new Error(`FedEx OAuth failed with HTTP ${res.status}`);
    }
    token = res.json.access_token;
    tokenExpiresAt = Date.now() + (Number(res.json.expires_in || 3600) * 1000);
    return token;
  }

  async function trackBatch(numbers) {
    let bearer;
    try {
      bearer = await getToken();
    } catch (err) {
      log.warn('FedEx auth failed', { error: err.message });
      return new Map(numbers.map((n) => [n, unavailable('fedex', 'CARRIER_AUTH_FAILED', err.message)]));
    }

    const res = await request(TRACK_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        'X-locale': 'en_US',
      },
      body: JSON.stringify({
        includeDetailedScans: true,
        trackingInfo: numbers.map((n) => ({ trackingNumberInfo: { trackingNumber: n } })),
      }),
    });

    if (res.status === 401 || res.status === 403) {
      return new Map(numbers.map((n) => [n, unavailable('fedex', 'CARRIER_ACCESS_DENIED', `HTTP ${res.status}`)]));
    }
    if (res.status === 429) {
      return new Map(numbers.map((n) => [n, unavailable('fedex', 'RATE_LIMITED', 'HTTP 429')]));
    }
    if (!res.ok) {
      return new Map(numbers.map((n) => [n, unavailable('fedex', 'CARRIER_API_ERROR', `HTTP ${res.status}`)]));
    }

    const out = new Map();
    const results = res.json?.output?.completeTrackResults || [];
    for (const complete of results) {
      const number = complete.trackingNumber;
      const result = complete.trackResults?.[0];
      if (!result) { out.set(number, notFound('fedex')); continue; }

      const errors = result.error ? [result.error] : (result.errors || []);
      if (errors.length) {
        const code = errors.map((e) => e.code).join(',');
        out.set(number, NOT_FOUND_CODES.test(code)
          ? notFound('fedex', 'CARRIER_NO_RECORD')
          : unavailable('fedex', 'CARRIER_API_ERROR', code));
        continue;
      }

      const latest = result.latestStatusDetail || {};
      const code = latest.derivedCode || latest.code;
      const stage = CODE_TO_STAGE[code] ?? STAGE.UNKNOWN;
      if (stage === STAGE.UNKNOWN) {
        log.warn('FedEx status code not mapped; showing carrier text verbatim', {
          number: maskNumber(number), code,
        });
      }

      const scans = Array.isArray(result.scanEvents) ? result.scanEvents : [];
      const events = trimEvents(scans.map((s) => ({
        at: s.date || null,
        text: s.eventDescription || s.derivedStatus || '',
        location: joinLocation([
          s.scanLocation?.city, s.scanLocation?.stateOrProvinceCode, s.scanLocation?.countryCode,
        ]),
      })));

      const eta = result.estimatedDeliveryTimeWindow?.window?.ends
        || result.standardTransitTimeWindow?.window?.ends
        || result.dateAndTimes?.find?.((d) => d.type === 'ESTIMATED_DELIVERY')?.dateTime
        || null;

      out.set(number, found({
        carrier: 'fedex',
        stage,
        carrierStatusCode: code || null,
        carrierStatusText: latest.description || latest.statusByLocale || null,
        lastEventAt: events[0]?.at || null,
        lastEventLocation: events[0]?.location || null,
        estimatedDelivery: eta,
        service: result.serviceDetail?.description || null,
        events,
      }));
    }

    for (const n of numbers) {
      if (!out.has(n)) out.set(n, notFound('fedex'));
    }
    return out;
  }

  return {
    name: 'fedex',
    /** Batch interface: preferred, one API call per 30 numbers. */
    async trackMany(numbers) {
      const merged = new Map();
      for (let i = 0; i < numbers.length; i += BATCH_SIZE) {
        const slice = numbers.slice(i, i + BATCH_SIZE);
        const part = await trackBatch(slice);
        for (const [k, v] of part) merged.set(k, v);
      }
      return merged;
    },
    async track(number) {
      const m = await trackBatch([number]);
      return m.get(number) || notFound('fedex');
    },
  };
}
