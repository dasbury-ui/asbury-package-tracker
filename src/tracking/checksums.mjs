/**
 * Tracking-number check-digit algorithms.
 *
 * Every function here is pure and deterministic. Each returns:
 *   { ok: true }                      - checksum verified
 *   { ok: false, reason: '...' }      - checksum rejected, with a traceable reason
 *
 * These algorithms are published barcode/checksum standards (UPU S10, GS1/USS
 * Code 128 mod-10, UPS mod-10 alphanumeric). They are implemented here from the
 * specifications rather than vendored from a third-party package so that the
 * licence position is unambiguous and every branch is unit-tested in this repo.
 *
 * DESIGN RULE: a checksum PASS is evidence. A checksum FAIL is grounds for
 * rejection of a pattern-derived candidate. Neither is ever treated as proof of
 * delivery status - only a carrier API response is. See ../carriers/index.mjs.
 */

const DIGITS = /^[0-9]+$/;

function fail(reason) {
  return { ok: false, reason };
}
const PASS = Object.freeze({ ok: true });

/**
 * USS Code 128 / GS1 mod-10, used by USPS IMpb, FedEx Ground (96), SSCC-18.
 * Weights alternate 3,1 starting with 3 on the digit immediately left of the
 * check digit and moving leftwards.
 *
 * @param {string} body   digits excluding the check digit
 * @param {string} check  the single check digit
 */
export function mod10Weighted31(body, check) {
  if (!DIGITS.test(body)) return fail('MOD10_BODY_NOT_NUMERIC');
  if (!/^[0-9]$/.test(check)) return fail('MOD10_CHECK_NOT_DIGIT');
  let sum = 0;
  // Walk right-to-left over the body; rightmost body digit gets weight 3.
  for (let i = body.length - 1, pos = 0; i >= 0; i--, pos++) {
    sum += Number(body[i]) * (pos % 2 === 0 ? 3 : 1);
  }
  const expected = (10 - (sum % 10)) % 10;
  return expected === Number(check) ? PASS : fail(`MOD10_EXPECTED_${expected}`);
}

/**
 * UPU S10 international mail (e.g. RB123456785GB).
 * Weights [8,6,4,2,3,5,9,7] over the 8 serial digits, modulo 11.
 * Remainder 0 -> check 5; remainder 1 -> check 0; else check = 11 - remainder.
 */
export function s10(serial8, check) {
  if (!DIGITS.test(serial8) || serial8.length !== 8) return fail('S10_SERIAL_NOT_8_DIGITS');
  if (!/^[0-9]$/.test(check)) return fail('S10_CHECK_NOT_DIGIT');
  const weights = [8, 6, 4, 2, 3, 5, 9, 7];
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(serial8[i]) * weights[i];
  const remainder = sum % 11;
  let expected;
  if (remainder === 0) expected = 5;
  else if (remainder === 1) expected = 0;
  else expected = 11 - remainder;
  return expected === Number(check) ? PASS : fail(`S10_EXPECTED_${expected}`);
}

/**
 * UPS 1Z mod-10 over the 15 characters between the "1Z" prefix and the check
 * digit. Letters map to digits via (charCode - 63) mod 10, so A=2, B=3 ... I=0.
 * Odd 1-indexed positions count as-is; even positions are doubled.
 * Verified against the canonical example 1Z999AA10123456784.
 */
export function upsMod10(body15, check) {
  if (body15.length !== 15) return fail('UPS_BODY_NOT_15_CHARS');
  if (!/^[0-9A-Z]{15}$/.test(body15)) return fail('UPS_BODY_NOT_ALNUM');
  if (!/^[0-9]$/.test(check)) return fail('UPS_CHECK_NOT_DIGIT');
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const ch = body15[i];
    const value = ch >= '0' && ch <= '9' ? Number(ch) : (ch.charCodeAt(0) - 63) % 10;
    // i is 0-indexed, so even i == odd 1-indexed position.
    sum += i % 2 === 0 ? value : value * 2;
  }
  const expected = (10 - (sum % 10)) % 10;
  return expected === Number(check) ? PASS : fail(`UPS_EXPECTED_${expected}`);
}

/**
 * FedEx Express 12-digit: weights 1,3,7 repeating from the right over the
 * first 11 digits, modulo 11, with 10 collapsing to 0.
 */
export function fedexExpress12(body11, check) {
  if (!DIGITS.test(body11) || body11.length !== 11) return fail('FEDEX12_BODY_NOT_11_DIGITS');
  if (!/^[0-9]$/.test(check)) return fail('FEDEX12_CHECK_NOT_DIGIT');
  const weights = [1, 3, 7];
  let sum = 0;
  for (let i = body11.length - 1, pos = 0; i >= 0; i--, pos++) {
    sum += Number(body11[i]) * weights[pos % 3];
  }
  const expected = (sum % 11) % 10;
  return expected === Number(check) ? PASS : fail(`FEDEX12_EXPECTED_${expected}`);
}

/**
 * FedEx Ground 15-digit: weights 1,3,7 repeating from the right over the first
 * 14 digits, modulo 11, with 10 collapsing to 0.
 */
export function fedexGround15(body14, check) {
  if (!DIGITS.test(body14) || body14.length !== 14) return fail('FEDEX15_BODY_NOT_14_DIGITS');
  if (!/^[0-9]$/.test(check)) return fail('FEDEX15_CHECK_NOT_DIGIT');
  const weights = [1, 3, 7];
  let sum = 0;
  for (let i = body14.length - 1, pos = 0; i >= 0; i--, pos++) {
    sum += Number(body14[i]) * weights[pos % 3];
  }
  const expected = (sum % 11) % 10;
  return expected === Number(check) ? PASS : fail(`FEDEX15_EXPECTED_${expected}`);
}

/**
 * DHL Express air waybill, 10 or 11 digits: the leading digits modulo 7.
 */
export function dhlMod7(body, check) {
  if (!DIGITS.test(body)) return fail('DHL_BODY_NOT_NUMERIC');
  if (!/^[0-9]$/.test(check)) return fail('DHL_CHECK_NOT_DIGIT');
  // BigInt keeps precision for 10+ digit waybills.
  const expected = Number(BigInt(body) % 7n);
  return expected === Number(check) ? PASS : fail(`DHL_EXPECTED_${expected}`);
}

/** Compute, rather than verify, a check digit. Used by the property tests. */
export const compute = {
  mod10Weighted31(body) {
    let sum = 0;
    for (let i = body.length - 1, pos = 0; i >= 0; i--, pos++) {
      sum += Number(body[i]) * (pos % 2 === 0 ? 3 : 1);
    }
    return String((10 - (sum % 10)) % 10);
  },
  s10(serial8) {
    const weights = [8, 6, 4, 2, 3, 5, 9, 7];
    let sum = 0;
    for (let i = 0; i < 8; i++) sum += Number(serial8[i]) * weights[i];
    const r = sum % 11;
    return String(r === 0 ? 5 : r === 1 ? 0 : 11 - r);
  },
  upsMod10(body15) {
    let sum = 0;
    for (let i = 0; i < 15; i++) {
      const ch = body15[i];
      const v = ch >= '0' && ch <= '9' ? Number(ch) : (ch.charCodeAt(0) - 63) % 10;
      sum += i % 2 === 0 ? v : v * 2;
    }
    return String((10 - (sum % 10)) % 10);
  },
  fedex(body) {
    const weights = [1, 3, 7];
    let sum = 0;
    for (let i = body.length - 1, pos = 0; i >= 0; i--, pos++) {
      sum += Number(body[i]) * weights[pos % 3];
    }
    return String((sum % 11) % 10);
  },
  dhlMod7(body) {
    return String(Number(BigInt(body) % 7n));
  },
};
