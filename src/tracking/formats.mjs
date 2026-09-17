/**
 * Tracking-number format definitions.
 *
 * Each format knows how to recognise a candidate string and how to verify its
 * check digit. A format NEVER decides what carrier a package actually is - it
 * only produces a *candidate* carrier that must then be confirmed by that
 * carrier's authoritative API before anything is shown to the user.
 *
 * `carrier` values map to the client keys in ../carriers/index.mjs.
 * `trackable` false means: we can recognise it, but no free authoritative API
 * exists for it, so it will be surfaced as UNCONFIRMED with a reason.
 *
 * `requiresContext` true means: this format is a bare run of digits with no
 * distinguishing prefix, so its checksum alone is weak evidence. A 10-digit
 * DHL waybill is "any 10 digits that happen to be divisible by 7", which one
 * phone number in seven satisfies; a 12-digit FedEx number catches one
 * account number in eleven. For these, a passing checksum is NOT sufficient
 * on its own - the number must also have come from a carrier link or sit
 * next to a tracking label. Formats with a real prefix (1Z, 94, 96, TBA, S10
 * letters) are self-identifying and need no such help.
 */

import * as ck from './checksums.mjs';

/** Strip formatting humans and mail clients insert into tracking numbers. */
export function normalise(raw) {
  return String(raw).toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export const FORMATS = [
  {
    id: 'ups',
    name: 'UPS',
    carrier: 'ups',
    trackable: true,
    // 1Z + 6 shipper + 2 service + 7 package + 1 check = 18 characters.
    match: (s) => /^1Z[0-9A-Z]{16}$/.test(s),
    verify: (s) => ck.upsMod10(s.slice(2, 17), s.slice(17)),
  },
  {
    id: 'usps_impb',
    name: 'USPS IMpb',
    carrier: 'usps',
    trackable: true,
    // Intelligent Mail package barcode: 20, 22, 26, 30 or 34 digits.
    // 420+ZIP routing prefixes are stripped before this point by extract.mjs.
    match: (s) => /^[0-9]{20}$|^[0-9]{22}$|^[0-9]{26}$|^[0-9]{30}$|^[0-9]{34}$/.test(s)
      && /^(92|93|94|95|96|82|91|02|03|04|70|71|73|77|81|23|13)/.test(s),
    verify: (s) => ck.mod10Weighted31(s.slice(0, -1), s.slice(-1)),
  },
  {
    id: 's10',
    name: 'USPS / international S10',
    carrier: 'usps',
    trackable: true,
    // Two service letters, 8 serial digits, check digit, ISO country code.
    match: (s) => /^[A-Z]{2}[0-9]{9}[A-Z]{2}$/.test(s),
    verify: (s) => ck.s10(s.slice(2, 10), s[10]),
  },
  {
    id: 'fedex_express_12',
    name: 'FedEx Express',
    carrier: 'fedex',
    trackable: true,
    requiresContext: true, // bare 12 digits; ~1 in 11 random numbers pass
    match: (s) => /^[0-9]{12}$/.test(s),
    verify: (s) => ck.fedexExpress12(s.slice(0, 11), s[11]),
  },
  {
    id: 'fedex_ground_15',
    name: 'FedEx Ground',
    carrier: 'fedex',
    trackable: true,
    requiresContext: true, // bare 15 digits
    match: (s) => /^[0-9]{15}$/.test(s),
    verify: (s) => ck.fedexGround15(s.slice(0, 14), s[14]),
  },
  {
    id: 'fedex_ground_96',
    name: 'FedEx Ground (96)',
    carrier: 'fedex',
    trackable: true,
    // 22-digit form beginning 96, mod-10 over the first 21 digits.
    match: (s) => /^96[0-9]{20}$/.test(s),
    verify: (s) => ck.mod10Weighted31(s.slice(0, 21), s[21]),
  },
  {
    id: 'dhl_express_awb',
    name: 'DHL Express',
    carrier: 'dhl',
    trackable: true,
    requiresContext: true, // bare 10-11 digits; ~1 in 7 random numbers pass
    // Air waybill: 10 or 11 digits, last digit is body mod 7.
    match: (s) => /^[0-9]{10}$|^[0-9]{11}$/.test(s),
    verify: (s) => ck.dhlMod7(s.slice(0, -1), s.slice(-1)),
  },
  {
    id: 'dhl_ecommerce',
    name: 'DHL eCommerce',
    carrier: 'dhl',
    trackable: true,
    // GM/LX/RX prefixed eCommerce numbers have no published check digit, so
    // they are only ever admitted from a carrier link or labelled context.
    match: (s) => /^(GM|LX|RX)[0-9A-Z]{10,30}$/.test(s),
    verify: () => ({ ok: false, reason: 'NO_PUBLISHED_CHECKSUM' }),
  },
  {
    id: 'amazon_logistics',
    name: 'Amazon Logistics',
    carrier: 'amazon',
    trackable: false,
    unavailableReason: 'NO_FREE_AUTHORITATIVE_API',
    match: (s) => /^TBA[0-9A-Z]{9,12}$/.test(s),
    verify: () => ({ ok: false, reason: 'NO_PUBLISHED_CHECKSUM' }),
  },
  {
    id: 'ontrac',
    name: 'OnTrac / LaserShip',
    carrier: 'ontrac',
    trackable: false,
    unavailableReason: 'NO_FREE_AUTHORITATIVE_API',
    match: (s) => /^(C[0-9]{14}|D[0-9]{14}|LX[0-9]{8}|1LS[0-9A-Z]{12,15})$/.test(s),
    verify: () => ({ ok: false, reason: 'NO_PUBLISHED_CHECKSUM' }),
  },
];

export const FORMATS_BY_ID = Object.fromEntries(FORMATS.map((f) => [f.id, f]));

/**
 * Evaluate a normalised string against every known format.
 *
 * Returns { matched: [...], passed: [...] } where `matched` is every format
 * whose shape fits and `passed` is the subset whose check digit verified.
 * Callers decide admission policy; this function only reports facts.
 */
export function evaluate(normalised) {
  const matched = [];
  const passed = [];
  for (const format of FORMATS) {
    if (!format.match(normalised)) continue;
    const result = format.verify(normalised);
    const entry = {
      formatId: format.id,
      formatName: format.name,
      carrier: format.carrier,
      trackable: format.trackable,
      requiresContext: Boolean(format.requiresContext),
      unavailableReason: format.unavailableReason || null,
      checksum: result.ok ? 'PASS' : 'FAIL',
      checksumReason: result.ok ? null : result.reason,
    };
    matched.push(entry);
    if (result.ok) passed.push(entry);
  }
  return { matched, passed };
}

/** Distinct candidate carriers, checksum-passing formats first. */
export function candidateCarriers(evaluation) {
  const ordered = [...evaluation.passed, ...evaluation.matched.filter((m) => m.checksum === 'FAIL')];
  const seen = new Set();
  const out = [];
  for (const entry of ordered) {
    if (seen.has(entry.carrier)) continue;
    seen.add(entry.carrier);
    out.push(entry);
  }
  return out;
}
