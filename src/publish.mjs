/**
 * Build the encrypted view the phone reads.
 *
 * The PWA never sees raw state. It gets a projection: exactly the fields the
 * screen needs, already sorted and already carrying the human sentence that
 * explains any UNCONFIRMED package. Putting that wording here rather than in
 * the front end means the reason a package is unconfirmed is decided once, by
 * the code that knows, and cannot drift.
 */

import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { encryptJson, keyFromBase64 } from './crypto.mjs';
import { STAGE } from './carriers/common.mjs';

const STAGE_ORDER = {
  [STAGE.OUT_FOR_DELIVERY]: 0,
  [STAGE.EXCEPTION]: 1,
  [STAGE.IN_TRANSIT]: 2,
  [STAGE.PRE_TRANSIT]: 3,
  [STAGE.UNKNOWN]: 4,
  [STAGE.RETURNED]: 5,
  [STAGE.DELIVERED]: 6,
};

export async function writePublicView(dataDir, state, config, { deepLink, REASON_TEXT }) {
  const items = Object.values(state.packages)
    .filter((p) => !p.archived)
    .map((p) => {
      const latest = p.sightings.at(-1) || {};
      const carrier = p.carrier !== 'unknown' ? p.carrier : (p.probableCarrier || null);
      return {
        number: p.number,
        carrier,
        // Made explicit so the UI never has to infer it.
        carrierIsConfirmed: p.carrier !== 'unknown',
        stage: p.stage,
        confidence: p.confidence,
        reason: p.reason,
        reasonText: p.reason ? (REASON_TEXT[p.reason] || p.reason) : null,
        staleReason: p.staleReason || null,
        givenUp: Boolean(p.givenUp),
        carrierStatusText: p.carrierStatusText,
        carrierStatusCode: p.carrierStatusCode,
        lastEventAt: p.lastEventAt,
        lastEventLocation: p.lastEventLocation,
        estimatedDelivery: p.estimatedDelivery,
        service: p.service,
        attribution: p.attribution,
        vendor: vendorLabel(latest.from),
        subject: latest.subject || null,
        mailbox: latest.mailbox || null,
        firstSeenAt: p.firstSeenAt,
        lastCheckedAt: p.lastCheckedAt,
        lastConfirmedAt: p.lastConfirmedAt,
        sightingCount: p.sightings.length,
        events: (p.events || []).slice(0, 12),
        link: carrier ? deepLink(carrier, p.number) : null,
      };
    });

  items.sort((a, b) => {
    const sa = STAGE_ORDER[a.stage] ?? 9;
    const sb = STAGE_ORDER[b.stage] ?? 9;
    if (sa !== sb) return sa - sb;
    return String(b.lastEventAt || b.firstSeenAt || '').localeCompare(
      String(a.lastEventAt || a.firstSeenAt || ''),
    );
  });

  const view = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    counts: {
      total: items.length,
      outForDelivery: items.filter((i) => i.stage === STAGE.OUT_FOR_DELIVERY).length,
      inTransit: items.filter((i) => i.stage === STAGE.IN_TRANSIT || i.stage === STAGE.PRE_TRANSIT).length,
      problems: items.filter((i) => i.stage === STAGE.EXCEPTION || i.stage === STAGE.RETURNED).length,
      delivered: items.filter((i) => i.stage === STAGE.DELIVERED).length,
      unconfirmed: items.filter((i) => i.confidence !== 'API_CONFIRMED').length,
    },
    packages: items,
    // A trimmed decision log so a wrong result can be traced from the phone.
    decisions: (state.decisionLog || []).slice(0, 200),
  };

  await mkdir(dataDir, { recursive: true });
  const key = keyFromBase64(config.stateKey);
  const path = join(dataDir, 'view.enc.json');
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(encryptJson(key, view)), 'utf8');
  await rename(tmp, path);
  return view;
}

function vendorLabel(from) {
  if (!from) return null;
  const named = /^\s*"?([^"<]+?)"?\s*</.exec(from);
  if (named) return named[1].trim().slice(0, 40);
  const domain = /@([\w.-]+)/.exec(from);
  return domain ? domain[1].replace(/^(www|mail|email|e)\./, '').slice(0, 40) : null;
}
