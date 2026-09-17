#!/usr/bin/env node
/**
 * Backfill packages from email bodies captured outside the runner.
 *
 *   STATE_KEY=... DATA_DIR=... node setup/seed-from-emails.mjs emails.json
 *
 * Why this exists: the headless runner reads Gmail through a service account.
 * Until that credential is in place, mail can still be captured by other
 * authorised means, and those messages should produce exactly the same
 * packages they would have produced through the normal path.
 *
 * It therefore runs the REAL pipeline - the same extractor, the same
 * admission policy, the same dedupe, the same state records. It does not
 * invent a package and it does not set a status: everything it writes is
 * UNCONFIRMED until a carrier API says otherwise, like any other package.
 *
 * emails.json is an array of:
 *   { messageId, mailbox, from, date, subject, text, html }
 */

import { readFile } from 'node:fs/promises';
import { Store, newPackage, addSighting } from '../src/state.mjs';
import { extractFromEmail } from '../src/tracking/extract.mjs';
import { log, maskNumber, DecisionLog } from '../src/log.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node setup/seed-from-emails.mjs <emails.json>');
  process.exit(1);
}

const emails = JSON.parse(await readFile(file, 'utf8'));
const store = new Store(process.env.DATA_DIR || 'publish/data', process.env.STATE_KEY);
await store.load();
const state = store.state;
const decisions = new DecisionLog(state.decisionLog, 2000);

let added = 0;
let merged = 0;
let rejected = 0;

for (const email of emails) {
  const seenKey = `${email.mailbox}:${email.messageId}`;
  if (!state.seenMessageIds.includes(seenKey)) state.seenMessageIds.push(seenKey);

  const result = extractFromEmail(email);

  for (const r of result.rejected) {
    rejected += 1;
    decisions.add({
      decision: 'REJECTED', number: maskNumber(r.number), reason: r.rejectReason,
      sources: r.sources, mailbox: r.mailbox, messageId: r.messageId, subject: r.subject,
    });
  }

  for (const a of result.admitted) {
    if (state.packages[a.number]) {
      addSighting(state.packages[a.number], a);
      merged += 1;
      decisions.add({
        decision: 'MERGED', number: maskNumber(a.number), basis: a.admissionBasis,
        mailbox: a.mailbox, messageId: a.messageId, subject: a.subject,
      });
    } else {
      const pkg = newPackage(a.number, a);
      addSighting(pkg, a);
      state.packages[a.number] = pkg;
      added += 1;
      decisions.add({
        decision: 'ADMITTED_NEW', number: maskNumber(a.number), basis: a.admissionBasis,
        candidateCarriers: a.candidateCarriers, mailbox: a.mailbox,
        messageId: a.messageId, subject: a.subject, note: 'backfilled from captured mail',
      });
    }
  }
}

state.decisionLog = decisions.finalise();
// health is left alone: this is not a tracker run and must not make a stale
// feed look fresh. The next real run republishes the view.
await store.save(null);

log.info('Backfill complete', {
  emails: emails.length, added, merged, rejected,
  totalPackages: Object.keys(state.packages).length,
});
console.log(`\n${added} new, ${merged} merged, ${rejected} rejected. `
  + `${Object.keys(state.packages).length} packages in state.`);
console.log('All are UNCONFIRMED until a carrier API confirms them.');
