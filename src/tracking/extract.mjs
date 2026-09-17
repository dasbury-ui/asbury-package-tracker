/**
 * Extract tracking-number candidates from an email and decide which are
 * admitted for carrier lookup.
 *
 * ADMISSION POLICY (this is the accuracy contract, stated once, here):
 *
 *   A candidate is admitted for carrier lookup only if at least one of:
 *     A. its check digit verifies against a SELF-IDENTIFYING format
 *        (one with a real prefix: 1Z, 94, 96, TBA, S10 letters)   (CHECKSUM)
 *     B. it was lifted out of a carrier's own tracking URL        (CARRIER_LINK)
 *     C. it sits within 60 characters of an explicit tracking label AND
 *        matches a carrier-specific shape                         (LABELLED)
 *
 *   Formats that are bare runs of digits (DHL 10-11, FedEx 12 and 15) are
 *   marked requiresContext in formats.mjs. Their checksums are weak on their
 *   own - roughly one phone number in seven passes DHL's mod 7 - so they are
 *   admitted only under B or C. Without this, a phone number in a signature
 *   block becomes a tracked "DHL package".
 *
 *   Admission is NOT tracking. An admitted candidate is still just a guess
 *   until a carrier API returns an authoritative record for it. Nothing
 *   reaches the user as fact without that. See ../carriers/index.mjs.
 *
 *   Everything rejected is logged with a reason so a miss can be traced.
 */

import { normalise, evaluate, candidateCarriers } from './formats.mjs';

/** Carrier tracking URLs, mapped to the query parameter holding the number. */
const CARRIER_LINK_PATTERNS = [
  { carrier: 'ups', re: /ups\.com\/[^\s"'<>]*?(?:tracknum|InquiryNumber1|trackingNumber)=([0-9A-Za-z]{8,40})/gi },
  { carrier: 'ups', re: /ups\.com\/track\?[^\s"'<>]*?loc=[^\s"'<>]*?tracknum=([0-9A-Za-z]{8,40})/gi },
  { carrier: 'fedex', re: /fedex\.com\/[^\s"'<>]*?(?:tracknumbers|trknbr|trackingnumber)=([0-9A-Za-z]{8,40})/gi },
  { carrier: 'fedex', re: /fedex\.com\/fedextrack\/\?trknbr=([0-9A-Za-z]{8,40})/gi },
  { carrier: 'usps', re: /usps\.com\/[^\s"'<>]*?(?:tLabels|qtc_tLabels1|labels)=([0-9A-Za-z]{8,40})/gi },
  { carrier: 'dhl', re: /dhl\.com\/[^\s"'<>]*?(?:tracking-id|AWB|trackingNumber)=([0-9A-Za-z]{8,40})/gi },
  { carrier: 'amazon', re: /amazon\.[a-z.]{2,6}\/[^\s"'<>]*?trackingId=([0-9A-Za-z]{8,40})/gi },
  { carrier: 'ontrac', re: /(?:ontrac|lasership)\.com\/[^\s"'<>]*?(?:trackingNumber|tracking_number)=([0-9A-Za-z]{8,40})/gi },
];

/** Words that indicate the nearby number really is a tracking number. */
const LABEL_RE = /\b(tracking\s*(?:number|no\.?|#|id)?|track\s*your\s*(?:package|shipment|order)|shipment\s*(?:number|id)|waybill|airbill|air\s*waybill|pro\s*number|consignment)\b/i;

/**
 * Bare-token scan, in two forms:
 *  - RUN_RE   catches a number written as one unbroken token.
 *  - GROUP_RE catches a number a human or mail client has split into groups,
 *             e.g. "1Z 999 AA1 01 2345 6784". Because a group scan can run on
 *             into ordinary words, every contiguous sub-sequence of a grouped
 *             match is tried and only those that match a known format shape
 *             are kept. That is what stops "package 1Z999... was delivered"
 *             from being read as one giant token.
 */
const RUN_RE = /[0-9A-Za-z]+(?:-[0-9A-Za-z]+)*/g;
const GROUP_RE = /\b[0-9A-Za-z]{1,6}(?:[  -][0-9A-Za-z]{1,6}){1,7}\b/g;
const MAX_GROUPS = 8;

/** USPS routing prefix: 420 + 5 or 9 digit ZIP wrapped around the real IMpb. */
function stripUspsRoutingPrefix(s) {
  const m = /^420[0-9]{5}(?:[0-9]{4})?((?:92|93|94|95|96|82|91)[0-9]{18,32})$/.exec(s);
  return m ? m[1] : s;
}

/**
 * @param {{messageId:string, mailbox:string, subject:string, from:string, date:string, text:string, html:string}} email
 * @returns {{admitted:Array, rejected:Array}}
 */
export function extractFromEmail(email) {
  const decisions = new Map(); // normalised -> decision record
  const haystack = `${email.subject || ''}\n${email.text || ''}\n${email.html || ''}`;

  const record = (normalised, patch) => {
    const existing = decisions.get(normalised);
    if (!existing) {
      decisions.set(normalised, {
        number: normalised,
        messageId: email.messageId,
        mailbox: email.mailbox,
        subject: (email.subject || '').slice(0, 200),
        from: email.from || '',
        emailDate: email.date || null,
        sources: [],
        admitted: false,
        admissionBasis: null,
        rejectReason: null,
        formats: [],
        candidateCarriers: [],
        linkCarrier: null,
        ...patch,
      });
      return decisions.get(normalised);
    }
    Object.assign(existing, patch, { sources: existing.sources });
    return existing;
  };

  // --- Pass 1: carrier tracking links. Highest-signal source available. ---
  for (const { carrier, re } of CARRIER_LINK_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(haystack)) !== null) {
      const n = stripUspsRoutingPrefix(normalise(m[1]));
      if (n.length < 8) continue;
      const d = record(n, {});
      if (!d.sources.includes('CARRIER_LINK')) d.sources.push('CARRIER_LINK');
      d.linkCarrier = d.linkCarrier || carrier;
    }
  }

  // --- Pass 2: bare tokens in the body, with surrounding context. ---
  const noteToken = (normalised, index, rawLength) => {
    if (normalised.length < 10 || normalised.length > 34) return;
    const context = haystack.slice(Math.max(0, index - 60), index + rawLength + 20);
    const d = record(normalised, {});
    if (!d.sources.includes('BODY_TOKEN')) d.sources.push('BODY_TOKEN');
    if (LABEL_RE.test(context) && !d.sources.includes('LABELLED')) d.sources.push('LABELLED');
  };

  RUN_RE.lastIndex = 0;
  let t;
  while ((t = RUN_RE.exec(haystack)) !== null) {
    noteToken(stripUspsRoutingPrefix(normalise(t[0])), t.index, t[0].length);
  }

  GROUP_RE.lastIndex = 0;
  let g;
  while ((g = GROUP_RE.exec(haystack)) !== null) {
    const groups = g[0].split(/[  -]/).filter(Boolean).slice(0, MAX_GROUPS);
    if (groups.length < 2) continue;
    // Try every contiguous run of 2+ groups; keep only shapes we recognise.
    for (let start = 0; start < groups.length - 1; start++) {
      for (let end = start + 2; end <= groups.length; end++) {
        const joined = stripUspsRoutingPrefix(normalise(groups.slice(start, end).join('')));
        if (joined.length < 10 || joined.length > 34) continue;
        if (evaluate(joined).matched.length === 0) continue;
        noteToken(joined, g.index, g[0].length);
      }
    }
  }

  // --- Pass 3: evaluate formats and apply the admission policy. ---
  const admitted = [];
  const rejected = [];
  for (const d of decisions.values()) {
    const evaluation = evaluate(d.number);
    d.formats = evaluation.matched;
    d.candidateCarriers = candidateCarriers(evaluation).map((c) => c.carrier);

    const fromLink = d.sources.includes('CARRIER_LINK');
    const isLabelled = d.sources.includes('LABELLED');
    const shapeKnown = evaluation.matched.length > 0;
    // A checksum pass only stands alone for self-identifying formats.
    const strongPasses = evaluation.passed.filter((p) => !p.requiresContext);
    const weakPasses = evaluation.passed.filter((p) => p.requiresContext);
    const hasChecksumPass = strongPasses.length > 0;

    if (hasChecksumPass) {
      d.admitted = true;
      d.admissionBasis = 'CHECKSUM';
    } else if (fromLink) {
      d.admitted = true;
      d.admissionBasis = 'CARRIER_LINK';
      if (d.linkCarrier && !d.candidateCarriers.includes(d.linkCarrier)) {
        d.candidateCarriers.unshift(d.linkCarrier);
      }
    } else if (isLabelled && shapeKnown) {
      d.admitted = true;
      d.admissionBasis = 'LABELLED';
    } else if (weakPasses.length > 0) {
      // Checksum passed, but only for a bare-digit format, and nothing in the
      // email says this is a tracking number. Almost always a phone number,
      // invoice number or account number.
      d.admitted = false;
      d.rejectReason = `WEAK_CHECKSUM_NO_CONTEXT:${weakPasses.map((m) => m.formatId).join(',')}`;
    } else if (shapeKnown) {
      d.admitted = false;
      d.rejectReason = `CHECKSUM_FAILED:${evaluation.matched.map((m) => `${m.formatId}=${m.checksumReason}`).join(',')}`;
    } else {
      d.admitted = false;
      d.rejectReason = 'NO_KNOWN_FORMAT';
    }

    if (d.admitted && d.candidateCarriers.length === 0) {
      d.admitted = false;
      d.rejectReason = 'NO_CANDIDATE_CARRIER';
    }

    (d.admitted ? admitted : rejected).push(d);
  }

  return { admitted, rejected };
}
