#!/usr/bin/env node
/**
 * Asbury Package Tracker - one run.
 *
 * Sequence:
 *   1. Load and decrypt state.
 *   2. Scan every mailbox for new mail; extract and admit tracking numbers.
 *   3. Look up the packages that are due against carrier APIs.
 *   4. Apply retention, write state and the public view, send notifications.
 *
 * The run is idempotent. Interrupting it at any point loses at most the work
 * of that run; nothing is double-counted and no package is duplicated,
 * because every identity is derived from data (tracking number, message id)
 * rather than from run order.
 */

import { config, assertRunnable, configuredCarriers, capabilityReport } from './config.mjs';
import { log, DecisionLog, maskNumber, maskEmail, registerSecret } from './log.mjs';
import { Store, newPackage, addSighting, applyResolution, isDue, markGivenUp, applyRetention, trimSeenMessages } from './state.mjs';
import { Budget } from './budget.mjs';
import { extractFromEmail } from './tracking/extract.mjs';
import { buildClients, resolveAll, deepLink, REASON_TEXT, STAGE } from './carriers/index.mjs';
import { parseServiceAccount, serviceAccountToken, refreshTokenToAccessToken, listDomainMailboxes, SCOPES } from './gmail/auth.mjs';
import { listCandidateMessageIds, fetchMessage } from './gmail/scan.mjs';
import { sendPush, buildNotifications } from './push.mjs';
import { writePublicView } from './publish.mjs';

const startedAt = new Date();

async function main() {
  const health = {
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    ok: false,
    stage: 'starting',
    runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null,
    mailboxes: { scanned: 0, failed: 0, errors: [] },
    messages: { examined: 0 },
    candidates: { admitted: 0, rejected: 0 },
    packages: { total: 0, active: 0, confirmed: 0, unconfirmed: 0, delivered: 0 },
    lookups: { attempted: 0, confirmed: 0 },
    carriers: {},
    budget: {},
    push: { sent: 0, failed: 0, subscriptions: 0 },
    errors: [],
  };

  const { hasWorkspace, hasPersonal } = assertRunnable();
  // Register every credential so it can never surface in a public run log,
  // whatever path an error message takes.
  for (const secret of [
    config.stateKey,
    config.carriers.ups.clientSecret, config.carriers.fedex.clientSecret,
    config.carriers.usps.clientSecret, config.carriers.dhl.apiKey,
    config.personalGmail.clientSecret, config.personalGmail.refreshToken,
    config.push.privateKey,
  ]) registerSecret(secret);

  const store = new Store(config.dataDir, config.stateKey);
  await store.load();
  const state = store.state;

  const decisions = new DecisionLog(state.decisionLog, config.retention.decisionLogEntries);
  const budget = new Budget(state.budget, {
    ups: config.carriers.ups.dailyBudget,
    fedex: config.carriers.fedex.dailyBudget,
    usps: config.carriers.usps.dailyBudget,
    dhl: config.carriers.dhl.dailyBudget,
  });

  if (process.env.FULL_RESCAN === 'true') {
    log.warn('FULL_RESCAN requested: clearing mailbox cursors and the seen-message cache', {});
    state.mailboxCursors = {};
    state.seenMessageIds = [];
  }

  const seen = new Set(state.seenMessageIds);
  const runEvents = [];

  // ------------------------------------------------------------ mailboxes --
  health.stage = 'scanning-mail';
  const mailboxJobs = [];

  if (hasWorkspace) {
    try {
      const sa = parseServiceAccount(config.google.serviceAccountJson);
      let addresses = config.google.mailboxes;
      if (addresses.length === 0) {
        try {
          addresses = await listDomainMailboxes(sa, config.google.adminSubject, config.google.domain);
          log.info('Discovered Workspace mailboxes', { count: addresses.length });
        } catch (err) {
          // Directory scope not delegated: fall back to the admin's own mailbox
          // rather than scanning nothing.
          addresses = [config.google.adminSubject];
          health.mailboxes.errors.push(`Directory listing unavailable (${err.message}); scanning the admin mailbox only`);
          log.warn('Directory listing unavailable; scanning admin mailbox only', { error: err.message });
        }
      }
      for (const address of addresses) {
        mailboxJobs.push({
          address,
          getToken: () => serviceAccountToken(sa, SCOPES.gmailReadonly, address),
        });
      }
    } catch (err) {
      health.mailboxes.errors.push(`Workspace setup failed: ${err.message}`);
      log.error('Workspace setup failed', { error: err.message });
    }
  }

  if (hasPersonal) {
    mailboxJobs.push({
      address: config.personalGmail.address,
      getToken: () => refreshTokenToAccessToken(config.personalGmail),
    });
  }

  if (mailboxJobs.length === 0) {
    // Not an error. The engine is alive and will start reading mail the moment
    // a mailbox credential appears, with no re-run of anything.
    log.warn('No mailbox source is configured yet; running in standby', {
      note: 'Add GOOGLE_SERVICE_ACCOUNT_JSON or the PERSONAL_GMAIL_* secrets to wake it',
    });
  }

  for (const job of mailboxJobs) {
    try {
      const token = await job.getToken();
      const cursor = state.mailboxCursors[job.address] || null;
      const listing = await listCandidateMessageIds(token, cursor, {
        lookbackDays: config.scan.lookbackDays,
        maxMessages: config.scan.maxMessagesPerMailbox,
      });
      if (listing.error) {
        health.mailboxes.failed += 1;
        // health.json is plaintext and published; mailbox names are masked.
        health.mailboxes.errors.push(`${maskEmail(job.address)}: ${listing.error}`);
        log.warn('Mailbox listing failed', { mailbox: maskEmail(job.address), error: listing.error });
        continue;
      }
      if (listing.newCursor) state.mailboxCursors[job.address] = listing.newCursor;
      health.mailboxes.scanned += 1;

      for (const messageId of listing.messageIds) {
        const seenKey = `${job.address}:${messageId}`;
        if (seen.has(seenKey)) continue;
        seen.add(seenKey);
        state.seenMessageIds.push(seenKey);

        const email = await fetchMessage(token, messageId, job.address);
        if (!email) continue;
        health.messages.examined += 1;

        const { admitted, rejected } = extractFromEmail(email);

        for (const r of rejected) {
          health.candidates.rejected += 1;
          decisions.add({
            decision: 'REJECTED',
            number: maskNumber(r.number),
            reason: r.rejectReason,
            sources: r.sources,
            mailbox: r.mailbox,
            messageId: r.messageId,
            subject: r.subject,
          });
        }

        for (const a of admitted) {
          health.candidates.admitted += 1;
          const existing = state.packages[a.number];
          if (existing) {
            const added = addSighting(existing, a);
            decisions.add({
              decision: 'MERGED',
              number: maskNumber(a.number),
              basis: a.admissionBasis,
              newSighting: added,
              mailbox: a.mailbox,
              messageId: a.messageId,
              subject: a.subject,
            });
          } else {
            const pkg = newPackage(a.number, a);
            addSighting(pkg, a);
            state.packages[a.number] = pkg;
            decisions.add({
              decision: 'ADMITTED_NEW',
              number: maskNumber(a.number),
              basis: a.admissionBasis,
              candidateCarriers: a.candidateCarriers,
              mailbox: a.mailbox,
              messageId: a.messageId,
              subject: a.subject,
            });
            runEvents.push({
              kind: 'NEW',
              number: a.number,
              // Sender name only. Never the email subject: a subject line
              // reading "your package was delivered" must not reach the
              // phone inside a notification this system authored.
              label: vendorLabel(a.from) || 'New shipment',
            });
          }
        }
      }
    } catch (err) {
      health.mailboxes.failed += 1;
      health.mailboxes.errors.push(`${maskEmail(job.address)}: ${err.message}`);
      log.error('Mailbox scan failed', { mailbox: maskEmail(job.address), error: err.message });
    }
  }

  // -------------------------------------------------------------- lookups --
  health.stage = 'carrier-lookups';
  const clients = buildClients(config);
  health.carriers = configuredCarriers();

  const due = Object.values(state.packages).filter((p) => isDue(p, config.poll));
  log.info('Packages due for an authoritative lookup', { due: due.length, total: Object.keys(state.packages).length });

  if (due.length) {
    const results = await resolveAll(due, clients, budget);
    for (const pkg of due) {
      const entry = results.get(pkg.number);
      if (!entry) continue;
      health.lookups.attempted += 1;
      const change = applyResolution(pkg, entry.result);
      if (entry.result.found) health.lookups.confirmed += 1;

      decisions.add({
        decision: 'LOOKUP',
        number: maskNumber(pkg.number),
        attempts: entry.attempts,
        outcome: entry.result.found
          ? `CONFIRMED:${entry.result.carrier}:${entry.result.stage}`
          : `UNCONFIRMED:${entry.result.reason}`,
      });

      if (change && change.to.confidence === 'API_CONFIRMED') {
        runEvents.push({
          kind: 'STATUS',
          number: pkg.number,
          from: change.from.stage,
          to: change.to.stage,
          label: vendorLabel(pkg.sightings.at(-1)?.from) || pkg.carrier.toUpperCase(),
        });
      }
    }
  }

  for (const pkg of Object.values(state.packages)) {
    if (markGivenUp(pkg, config.poll)) {
      decisions.add({
        decision: 'GAVE_UP',
        number: maskNumber(pkg.number),
        reason: pkg.reason,
        note: `No carrier confirmed this within ${config.poll.giveUpUnresolvedHours}h; it stays visible as UNCONFIRMED`,
      });
    }
  }

  // ------------------------------------------------------------ retention --
  health.stage = 'retention';
  const retention = applyRetention(state, config.poll, config.retention);
  trimSeenMessages(state);

  // ----------------------------------------------------------- publishing --
  health.stage = 'publishing';
  const all = Object.values(state.packages);
  health.packages.total = all.length;
  health.packages.active = all.filter((p) => !p.archived && p.stage !== STAGE.DELIVERED).length;
  health.packages.confirmed = all.filter((p) => p.confidence === 'API_CONFIRMED').length;
  health.packages.unconfirmed = all.filter((p) => p.confidence !== 'API_CONFIRMED').length;
  health.packages.delivered = all.filter((p) => p.stage === STAGE.DELIVERED).length;
  health.budget = budget.report();
  health.retention = retention;

  state.budget = budget.snapshot();
  state.decisionLog = decisions.finalise();

  // --------------------------------------------------------------- push ----
  health.stage = 'notifications';
  health.push.subscriptions = (state.pushSubscriptions || []).length;
  if (runEvents.length && health.push.subscriptions) {
    const notifications = buildNotifications(runEvents);
    for (const n of notifications) {
      const { sent, pruned, failed } = await sendPush(state.pushSubscriptions, n, config.push);
      health.push.sent += sent;
      health.push.failed += failed;
      if (pruned.length) {
        state.pushSubscriptions = state.pushSubscriptions.filter((s) => !pruned.includes(s.endpoint));
      }
    }
  }

  // --------------------------------------------------------------- save ----
  health.stage = 'saving';
  await writePublicView(config.dataDir, state, config, { deepLink, REASON_TEXT });
  health.capabilities = capabilityReport();
  health.dormant = Object.entries(health.capabilities)
    .filter(([, v]) => !v.live)
    .map(([k, v]) => ({ capability: k, reason: v.reason, unlock: v.unlock }));
  health.ok = health.mailboxes.scanned > 0 || mailboxJobs.length === 0;
  health.finishedAt = new Date().toISOString();
  health.durationMs = Date.now() - startedAt.getTime();
  health.stage = 'done';
  await store.save(health);

  log.info('Run complete', {
    packages: health.packages,
    lookups: health.lookups,
    mailboxes: health.mailboxes.scanned,
    push: health.push,
    durationMs: health.durationMs,
  });

  // A mailbox that is CONFIGURED but unreadable is a real failure and the exit
  // code must say so. A mailbox that simply has no credentials yet is not a
  // failure - it is a dormant capability, already reported in health.
  if (mailboxJobs.length > 0 && health.mailboxes.scanned === 0) {
    throw new Error(
      `All ${mailboxJobs.length} configured mailbox(es) failed to scan: `
      + health.mailboxes.errors.join('; '),
    );
  }
}

/** A readable sender name for notifications: "A&M Supply" rather than an address. */
function vendorLabel(from) {
  if (!from) return null;
  const named = /^\s*"?([^"<]+?)"?\s*</.exec(from);
  if (named) return named[1].trim().slice(0, 40);
  const domain = /@([\w.-]+)/.exec(from);
  return domain ? domain[1].replace(/^(www|mail|email|e)\./, '').slice(0, 40) : null;
}

main().catch(async (err) => {
  log.error('Run failed', { error: err.message, stack: err.stack?.split('\n').slice(0, 4).join(' | ') });
  // Always leave a health file behind so the phone can show the failure.
  try {
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(`${config.dataDir}/health.json`, JSON.stringify({
      schemaVersion: 1,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      ok: false,
      stage: 'failed',
      error: String(err.message).slice(0, 500),
      runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null,
    }, null, 2), 'utf8');
  } catch { /* health write is best effort */ }
  process.exitCode = 1;
});
