/**
 * UPS Track API client.
 *
 * OAuth:  POST https://onlinetools.ups.com/security/v1/oauth/token
 *         Basic client_id:client_secret, grant_type=client_credentials
 * Track:  GET  https://onlinetools.ups.com/api/track/v1/details/{number}
 *         Authorization: Bearer, transId, transactionSrc
 *
 * Free with a UPS developer account. Verified against developer.ups.com,
 * September 2026.
 */

import { request } from '../http.mjs';
import { log, maskNumber } from '../log.mjs';
import { STAGE, found, notFound, unavailable, trimEvents, joinLocation } from './common.mjs';

const OAUTH_URL = 'https://onlinetools.ups.com/security/v1/oauth/token';
const TRACK_URL = 'https://onlinetools.ups.com/api/track/v1/details/';

/**
 * UPS activity status `type` letters. Mapped conservatively: anything not in
 * this table yields UNKNOWN rather than a guess.
 */
const TYPE_TO_STAGE = {
  M: STAGE.PRE_TRANSIT,   // Manifest / billing information received
  MP: STAGE.PRE_TRANSIT,
  P: STAGE.IN_TRANSIT,    // Pickup
  I: STAGE.IN_TRANSIT,    // In transit
  O: STAGE.OUT_FOR_DELIVERY,
  OF: STAGE.OUT_FOR_DELIVERY,
  D: STAGE.DELIVERED,
  X: STAGE.EXCEPTION,
  RS: STAGE.RETURNED,
  NA: STAGE.UNKNOWN,
};

/** UPS also publishes numeric status codes; these are the unambiguous ones. */
const CODE_TO_STAGE = {
  '011': STAGE.DELIVERED,
  '012': STAGE.OUT_FOR_DELIVERY,
  '003': STAGE.PRE_TRANSIT,
};

export function createUpsClient({ clientId, clientSecret }) {
  let token = null;
  let tokenExpiresAt = 0;

  async function getToken() {
    if (token && Date.now() < tokenExpiresAt - 60000) return token;
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await request(OAUTH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok || !res.json?.access_token) {
      throw new Error(`UPS OAuth failed with HTTP ${res.status}`);
    }
    token = res.json.access_token;
    tokenExpiresAt = Date.now() + (Number(res.json.expires_in || 3600) * 1000);
    return token;
  }

  return {
    name: 'ups',

    async track(number) {
      let bearer;
      try {
        bearer = await getToken();
      } catch (err) {
        log.warn('UPS auth failed', { error: err.message });
        return unavailable('ups', 'CARRIER_AUTH_FAILED', err.message);
      }

      const url = `${TRACK_URL}${encodeURIComponent(number)}?locale=en_US&returnSignature=false`;
      const res = await request(url, {
        headers: {
          Authorization: `Bearer ${bearer}`,
          transId: `asbury-${Date.now()}`,
          transactionSrc: 'asbury-package-tracker',
          Accept: 'application/json',
        },
      });

      if (res.status === 404) return notFound('ups');
      if (res.status === 401 || res.status === 403) {
        return unavailable('ups', 'CARRIER_ACCESS_DENIED', `HTTP ${res.status}`);
      }
      if (res.status === 429) return unavailable('ups', 'RATE_LIMITED', 'HTTP 429');
      if (!res.ok) {
        // UPS returns a structured "no tracking information" error body.
        const errs = res.json?.response?.errors || res.json?.errors || [];
        const codes = errs.map((e) => e.code).join(',');
        if (/151018|150022|TRACK/i.test(codes)) return notFound('ups', 'CARRIER_NO_RECORD');
        return unavailable('ups', 'CARRIER_API_ERROR', `HTTP ${res.status} ${codes}`);
      }

      const shipment = res.json?.trackResponse?.shipment?.[0];
      const pkg = shipment?.package?.[0];
      if (!pkg) return notFound('ups');

      const current = pkg.currentStatus || {};
      const stage = TYPE_TO_STAGE[current.type]
        ?? CODE_TO_STAGE[current.code]
        ?? STAGE.UNKNOWN;

      if (stage === STAGE.UNKNOWN) {
        log.warn('UPS status code not mapped; showing carrier text verbatim', {
          number: maskNumber(number), code: current.code, type: current.type,
        });
      }

      const activities = Array.isArray(pkg.activity) ? pkg.activity : [];
      const events = trimEvents(activities.map((a) => ({
        at: toIso(a.date, a.time),
        text: a.status?.description || a.status?.simplifiedTextDescription || '',
        location: joinLocation([
          a.location?.address?.city,
          a.location?.address?.stateProvince,
          a.location?.address?.countryCode,
        ]),
      })));

      const delivery = pkg.deliveryDate?.find?.((d) => d.type === 'DEL') || pkg.deliveryDate?.[0];

      return found({
        carrier: 'ups',
        stage,
        carrierStatusCode: current.code || current.type || null,
        carrierStatusText: current.description || current.simplifiedTextDescription || null,
        lastEventAt: events[0]?.at || null,
        lastEventLocation: events[0]?.location || null,
        estimatedDelivery: delivery?.date ? toIso(delivery.date, delivery.time) : null,
        service: pkg.service?.description || null,
        events,
      });
    },
  };
}

/** UPS returns date as YYYYMMDD and time as HHMMSS, both local to the event. */
function toIso(date, time) {
  if (!date || !/^\d{8}$/.test(String(date))) return null;
  const d = String(date);
  const t = /^\d{6}$/.test(String(time || '')) ? String(time) : '000000';
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
}
