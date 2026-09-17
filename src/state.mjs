/**
 * The state store.
 *
 * One package == one record, keyed by the normalised tracking number. The
 * same number arriving in an order confirmation, a shipping notice and a
 * delivery notice produces one record with three sightings, never three
 * packages.
 *
 * Files written into config.dataDir (published by GitHub Pages):
 *   packages.enc.json  - AES-256-GCM ciphertext. Everything sensitive.
 *   health.json        - plaintext, deliberately. Contains no business data:
 *                        run timestamps and counts only, so the phone can show
 *                        "this feed is stale" even before it has the key.
 *
 * Writes are atomic: temp file then rename, so an interrupted run can never
 * leave a half-written state file behind.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { encryptJson, decryptJson, keyFromBase64 } from './crypto.mjs';
import { STAGE, TERMINAL_STAGES } from './carriers/common.mjs';
import { log } from './log.mjs';

export const STATE_VERSION = 1;

export function emptyState() {
  return {
    version: STATE_VERSION,
    packages: {},
    mailboxCursors: {},
    budget: {},
    pushSubscriptions: [],
    decisionLog: [],
    seenMessageIds: [],
  };
}

export class Store {
  constructor(dataDir, stateKeyB64) {
    this.dataDir = dataDir;
    this.key = keyFromBase64(stateKeyB64);
    this.encPath = join(dataDir, 'packages.enc.json');
    this.healthPath = join(dataDir, 'health.json');
    this.state = emptyState();
  }

  async load() {
    if (!existsSync(this.encPath)) {
      log.info('No existing state file; starting fresh');
      return this.state;
    }
    const raw = await readFile(this.encPath, 'utf8');
    try {
      const envelope = JSON.parse(raw);
      const decoded = decryptJson(this.key, envelope);
      this.state = { ...emptyState(), ...decoded };
      log.info('State loaded', {
        packages: Object.keys(this.state.packages).length,
        version: this.state.version,
      });
    } catch (err) {
      // Refuse to silently discard state. A bad key or corrupt file is an
      // operator problem, not something to paper over by starting fresh.
      throw new Error(
        `Could not read existing state (${err.message}). `
        + 'Refusing to overwrite it. Check STATE_KEY, or restore from a backup artifact.',
      );
    }
    return this.state;
  }

  /**
   * @param {object|null} health pass null to leave the existing health file
   *   untouched - used by side workflows that must not overwrite the
   *   tracker's own report of the last real run.
   */
  async save(health) {
    await mkdir(this.dataDir, { recursive: true });
    const envelope = encryptJson(this.key, this.state);
    await atomicWrite(this.encPath, JSON.stringify(envelope));
    if (health) await atomicWrite(this.healthPath, JSON.stringify(health, null, 2));
  }
}

async function atomicWrite(path, contents) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, contents, 'utf8');
  await rename(tmp, path);
}

// ------------------------------------------------------------ packages ----

export function newPackage(number, sighting) {
  return {
    number,
    carrier: 'unknown',
    candidateCarriers: sighting.candidateCarriers || [],
    admissionBasis: sighting.admissionBasis || null,
    firstSeenAt: new Date().toISOString(),
    sightings: [],
    // Status
    stage: STAGE.UNKNOWN,
    confidence: 'UNCONFIRMED',
    reason: 'NOT_YET_CHECKED',
    carrierStatusCode: null,
    carrierStatusText: null,
    lastEventAt: null,
    lastEventLocation: null,
    estimatedDelivery: null,
    service: null,
    events: [],
    attribution: null,
    // Bookkeeping
    lastCheckedAt: null,
    lastConfirmedAt: null,
    consecutiveFailures: 0,
    archived: false,
    notified: {},
  };
}

/** Record that a tracking number was seen in an email. Idempotent per message. */
export function addSighting(pkg, sighting) {
  const already = pkg.sightings.some(
    (s) => s.messageId === sighting.messageId && s.mailbox === sighting.mailbox,
  );
  if (already) return false;
  pkg.sightings.push({
    messageId: sighting.messageId,
    mailbox: sighting.mailbox,
    subject: sighting.subject,
    from: sighting.from,
    emailDate: sighting.emailDate,
    basis: sighting.admissionBasis,
    at: new Date().toISOString(),
  });
  pkg.sightings.sort((a, b) => String(a.emailDate || '').localeCompare(String(b.emailDate || '')));
  if (pkg.sightings.length > 20) pkg.sightings = pkg.sightings.slice(-20);

  // Merge any newly suggested candidate carriers without losing the pin.
  for (const c of sighting.candidateCarriers || []) {
    if (!pkg.candidateCarriers.includes(c)) pkg.candidateCarriers.push(c);
  }
  return true;
}

/**
 * Apply a carrier resolution to a package.
 * Returns a change descriptor for notification purposes, or null.
 */
export function applyResolution(pkg, result) {
  const before = { stage: pkg.stage, confidence: pkg.confidence };
  pkg.lastCheckedAt = new Date().toISOString();

  if (result.found) {
    pkg.carrier = result.carrier;          // pin the carrier: now proven
    pkg.stage = result.stage;
    pkg.confidence = 'API_CONFIRMED';
    pkg.reason = null;
    pkg.carrierStatusCode = result.carrierStatusCode;
    pkg.carrierStatusText = result.carrierStatusText;
    pkg.lastEventAt = result.lastEventAt;
    pkg.lastEventLocation = result.lastEventLocation;
    pkg.estimatedDelivery = result.estimatedDelivery;
    pkg.service = result.service;
    pkg.events = result.events || [];
    pkg.attribution = result.raw?.attribution || null;
    pkg.lastConfirmedAt = pkg.lastCheckedAt;
    pkg.consecutiveFailures = 0;
    if (pkg.stage === STAGE.DELIVERED) pkg.deliveredAt = pkg.lastEventAt || pkg.lastCheckedAt;
  } else {
    pkg.consecutiveFailures += 1;
    // A previously confirmed status is NOT thrown away because one lookup
    // failed. It is kept, with its own timestamp, and the UI shows how old it
    // is. Only a never-confirmed package shows as UNCONFIRMED.
    if (pkg.confidence !== 'API_CONFIRMED') {
      pkg.confidence = 'UNCONFIRMED';
      pkg.reason = result.reason || 'CARRIER_NO_RECORD';
      if (result.carrier && result.carrier !== 'unknown' && pkg.carrier === 'unknown') {
        pkg.probableCarrier = result.carrier;
      }
    } else {
      pkg.staleReason = result.reason || 'CARRIER_API_ERROR';
    }
  }

  const changed = before.stage !== pkg.stage || before.confidence !== pkg.confidence;
  return changed ? { from: before, to: { stage: pkg.stage, confidence: pkg.confidence } } : null;
}

// ------------------------------------------------------------ schedule ----

/** Should this package be looked up on this run? */
export function isDue(pkg, poll, now = Date.now()) {
  if (pkg.archived) return false;
  if (TERMINAL_STAGES.has(pkg.stage) && pkg.confidence === 'API_CONFIRMED') return false;

  const last = pkg.lastCheckedAt ? Date.parse(pkg.lastCheckedAt) : 0;
  if (!last) return true;
  const ageMin = (now - last) / 60000;

  if (pkg.confidence !== 'API_CONFIRMED') {
    const firstSeen = pkg.firstSeenAt ? Date.parse(pkg.firstSeenAt) : now;
    const hoursUnresolved = (now - firstSeen) / 3600000;
    if (hoursUnresolved > poll.giveUpUnresolvedHours) {
      // Stop burning free-tier calls on something no carrier will confirm.
      // The package stays visible, permanently marked UNCONFIRMED.
      return false;
    }
    // Back off on repeated failure so one bad number cannot drain the budget.
    const backoffMin = Math.min(240, poll.unresolvedMinutes + pkg.consecutiveFailures * 20);
    return ageMin >= backoffMin;
  }

  switch (pkg.stage) {
    case STAGE.OUT_FOR_DELIVERY: return ageMin >= poll.outForDeliveryMinutes;
    case STAGE.EXCEPTION: return ageMin >= poll.exceptionMinutes;
    case STAGE.PRE_TRANSIT:
    case STAGE.IN_TRANSIT:
    case STAGE.UNKNOWN:
    default: return ageMin >= poll.inTransitMinutes;
  }
}

/** Mark a package as permanently unconfirmed once we have stopped retrying. */
export function markGivenUp(pkg, poll, now = Date.now()) {
  if (pkg.confidence === 'API_CONFIRMED' || pkg.archived) return false;
  const firstSeen = pkg.firstSeenAt ? Date.parse(pkg.firstSeenAt) : now;
  if ((now - firstSeen) / 3600000 <= poll.giveUpUnresolvedHours) return false;
  if (pkg.givenUp) return false;
  pkg.givenUp = true;
  return true;
}

// ----------------------------------------------------------- retention ----

/**
 * Archive delivered packages off the board, then purge them entirely.
 * The 30-day purge exists because DHL's developer terms require tracking data
 * to be deleted 30 days after delivery; it is applied to all carriers.
 */
export function applyRetention(state, poll, retention, now = Date.now()) {
  let archived = 0;
  let purged = 0;
  for (const [number, pkg] of Object.entries(state.packages)) {
    const deliveredAt = pkg.deliveredAt ? Date.parse(pkg.deliveredAt) : null;
    if (!deliveredAt) continue;
    const days = (now - deliveredAt) / 86400000;
    if (days > retention.purgeAfterDeliveryDays) {
      delete state.packages[number];
      purged += 1;
    } else if (days > poll.keepDeliveredDays && !pkg.archived) {
      pkg.archived = true;
      pkg.events = [];
      archived += 1;
    }
  }
  return { archived, purged };
}

/** Keep the seen-message cache bounded. */
export function trimSeenMessages(state, limit = 5000) {
  if (state.seenMessageIds.length > limit) {
    state.seenMessageIds = state.seenMessageIds.slice(-limit);
  }
}
