/**
 * USPS Tracking API (v3) client.
 *
 * IMPORTANT, AND VERIFIED, LIMITATION
 * -----------------------------------
 * On 1 April 2026 USPS tied tracking-API access to the Mailer ID embedded in
 * the package barcode. Free access is granted to the SHIPPER who owns that
 * MID, and to platforms the shipper has authorised. A recipient looking up a
 * parcel a supplier sent them falls into the "Service Providers and Others"
 * category, which is paid and requires an Enterprise Payment System account
 * and a signed IP agreement.
 *   Source: https://www.usps.com/business/api-access.htm
 *
 * Asbury receives far more parcels than it ships, so for most USPS packages
 * there is no zero-cost authoritative source. This client is still fully
 * implemented and is attempted on every USPS candidate, because:
 *   - Derek may own the MID on parcels he ships himself, and those will work;
 *   - the authoritative API response, not our assumption, decides the outcome.
 * When USPS declines, the package is surfaced as UNCONFIRMED with reason
 * CARRIER_ACCESS_DENIED and a deep link, never as a guessed status.
 *
 * OAuth: POST https://apis.usps.com/oauth2/v3/token (client_credentials)
 * Track: GET  https://apis.usps.com/tracking/v3/tracking/{number}?expand=DETAIL
 */

import { request } from '../http.mjs';
import { log, maskNumber } from '../log.mjs';
import { STAGE, found, notFound, unavailable, trimEvents } from './common.mjs';

const OAUTH_URL = 'https://apis.usps.com/oauth2/v3/token';
const TRACK_URL = 'https://apis.usps.com/tracking/v3/tracking/';

/** USPS statusCategory values are coarse and stable; summary text is not used. */
const CATEGORY_TO_STAGE = {
  'Pre-Shipment': STAGE.PRE_TRANSIT,
  'Accepted': STAGE.IN_TRANSIT,
  'In Transit': STAGE.IN_TRANSIT,
  'Out for Delivery': STAGE.OUT_FOR_DELIVERY,
  'Delivered': STAGE.DELIVERED,
  'Alert': STAGE.EXCEPTION,
  'Available for Pickup': STAGE.EXCEPTION,
  'Returned to Sender': STAGE.RETURNED,
};

export function createUspsClient({ clientId, clientSecret }) {
  let token = null;
  let tokenExpiresAt = 0;

  async function getToken() {
    if (token && Date.now() < tokenExpiresAt - 60000) return token;
    const res = await request(OAUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'tracking',
      }),
    });
    if (!res.ok || !res.json?.access_token) {
      throw new Error(`USPS OAuth failed with HTTP ${res.status}`);
    }
    token = res.json.access_token;
    tokenExpiresAt = Date.now() + (Number(res.json.expires_in || 28800) * 1000);
    return token;
  }

  return {
    name: 'usps',

    async track(number) {
      let bearer;
      try {
        bearer = await getToken();
      } catch (err) {
        return unavailable('usps', 'CARRIER_AUTH_FAILED', err.message);
      }

      const res = await request(`${TRACK_URL}${encodeURIComponent(number)}?expand=DETAIL`, {
        headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
      });

      if (res.status === 403) {
        // The documented outcome for a recipient without MID authorisation.
        log.warn('USPS denied tracking access for this number', {
          number: maskNumber(number),
          note: 'Recipient is not the Mailer ID owner; see USPS API access controls, 1 Apr 2026',
        });
        return unavailable('usps', 'CARRIER_ACCESS_DENIED',
          'USPS restricts free tracking to the shipper who owns the Mailer ID');
      }
      if (res.status === 401) return unavailable('usps', 'CARRIER_AUTH_FAILED', 'HTTP 401');
      if (res.status === 404) return notFound('usps');
      if (res.status === 429) return unavailable('usps', 'RATE_LIMITED', 'HTTP 429');
      if (!res.ok) return unavailable('usps', 'CARRIER_API_ERROR', `HTTP ${res.status}`);

      const data = res.json;
      if (!data || (!data.statusCategory && !data.status)) return notFound('usps');

      const stage = CATEGORY_TO_STAGE[data.statusCategory] ?? STAGE.UNKNOWN;
      if (stage === STAGE.UNKNOWN) {
        log.warn('USPS status category not mapped; showing carrier text verbatim', {
          number: maskNumber(number), category: data.statusCategory,
        });
      }

      const evts = Array.isArray(data.trackingEvents) ? data.trackingEvents : [];
      const events = trimEvents(evts.map((e) => ({
        at: e.eventTimestamp || null,
        text: e.eventType || e.eventDescription || '',
        location: [e.eventCity, e.eventState, e.eventZIP].filter(Boolean).join(', ') || null,
      })));

      return found({
        carrier: 'usps',
        stage,
        carrierStatusCode: data.statusCategory || null,
        carrierStatusText: data.statusSummary || data.status || null,
        lastEventAt: events[0]?.at || null,
        lastEventLocation: events[0]?.location || null,
        estimatedDelivery: data.expectedDeliveryTimeStamp || data.expectedDeliveryDate || null,
        service: data.mailClass || null,
        events,
      });
    },
  };
}
