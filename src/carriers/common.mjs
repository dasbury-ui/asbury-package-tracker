/**
 * The shared shape every carrier client must return, and the canonical
 * status vocabulary.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE:
 * A carrier client may only return `found: true` when the carrier's own API
 * returned a structured record for that tracking number. `stage` may only be
 * DELIVERED when the carrier's own structured status code says delivered.
 * No client is permitted to infer a stage from free text, from an email, or
 * from the shape of the number. If a client cannot map the carrier's code, it
 * returns stage UNKNOWN and passes the carrier's own wording through verbatim.
 */

export const STAGE = Object.freeze({
  PRE_TRANSIT: 'PRE_TRANSIT',
  IN_TRANSIT: 'IN_TRANSIT',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  EXCEPTION: 'EXCEPTION',
  RETURNED: 'RETURNED',
  UNKNOWN: 'UNKNOWN',
});

export const TERMINAL_STAGES = new Set([STAGE.DELIVERED, STAGE.RETURNED]);

/** A confirmed authoritative record. */
export function found({
  carrier, stage, carrierStatusCode, carrierStatusText,
  lastEventAt = null, lastEventLocation = null, estimatedDelivery = null,
  service = null, events = [], raw = null,
}) {
  return {
    found: true,
    carrier,
    stage,
    carrierStatusCode: carrierStatusCode ?? null,
    carrierStatusText: carrierStatusText ?? null,
    lastEventAt,
    lastEventLocation,
    estimatedDelivery,
    service,
    events,
    checkedAt: new Date().toISOString(),
    raw,
  };
}

/**
 * The carrier answered, but has no record of this number. Distinct from an
 * error: it is a real, authoritative "not mine / not yet".
 */
export function notFound(carrier, reason = 'CARRIER_NO_RECORD') {
  return { found: false, carrier, reason, checkedAt: new Date().toISOString() };
}

/** We could not get an authoritative answer. Never displayed as a status. */
export function unavailable(carrier, reason, detail = null) {
  return {
    found: false, carrier, reason, detail, unavailable: true,
    checkedAt: new Date().toISOString(),
  };
}

/** Trim a carrier event list to something worth storing and showing. */
export function trimEvents(events, limit = 25) {
  return events
    .filter((e) => e && (e.at || e.text))
    .slice(0, limit)
    .map((e) => ({
      at: e.at || null,
      text: String(e.text || '').slice(0, 200),
      location: e.location ? String(e.location).slice(0, 120) : null,
    }));
}

export function joinLocation(parts) {
  const out = parts.filter((p) => p && String(p).trim()).map((p) => String(p).trim());
  return out.length ? out.join(', ') : null;
}
