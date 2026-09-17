#!/usr/bin/env node
/**
 * Is it running? Did it fail? Why? What do I do?
 *
 *   node setup/doctor.mjs
 *
 * Answers all four from the outside, using only the GitHub CLI and the
 * published health file. Reads nothing sensitive and changes nothing.
 */

import { c, say, heading, ok, warn, bad, step, run, gh, has, closePrompts } from './lib.mjs';

const REPO_NAME = 'asbury-package-tracker';
const STALE_MINUTES = 45;

const ago = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  const m = (Date.now() - t) / 60000;
  if (m < 60) return `${Math.round(m)} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
};

async function main() {
  say(c.b('\n  Asbury Package Tracker — health check\n'));

  if (!(await has('gh'))) { bad('GitHub CLI is not installed.'); return; }
  const auth = await gh.ready();
  if (!auth.ok) {
    bad(`Not signed in to GitHub${auth.detail ? `: ${auth.detail}` : ''}`);
    say('  Run: gh auth login');
    return;
  }
  const user = await gh.currentUser();
  if (!user) { bad('Signed in but could not read the account name. Try: gh api user'); return; }
  const slug = `${user}/${REPO_NAME}`;

  const missingScopes = await gh.missingScopes();
  if (missingScopes.length) {
    bad(`Token is missing ${missingScopes.map(([n]) => n).join(', ')}`);
    say(`  Fix: ${c.cyan(`gh auth refresh -h github.com -s ${missingScopes.map(([n]) => n).join(',')}`)}`);
  } else {
    ok('Token scopes are sufficient');
  }

  // ------------------------------------------------------ is it running --
  heading('Is it running?');
  const runs = await run('gh', ['run', 'list', '--repo', slug, '--workflow', 'track.yml',
    '--limit', '10', '--json', 'status,conclusion,createdAt,url,displayTitle']);
  let list = [];
  try { list = JSON.parse(runs.out || '[]'); } catch { /* handled below */ }

  if (!list.length) {
    bad('No tracker runs found at all.');
    say('     The workflow has never run. Start one:');
    say(`     ${c.cyan(`gh workflow run track.yml --repo ${slug}`)}`);
  } else {
    const latest = list[0];
    const lastGood = list.find((r) => r.conclusion === 'success');
    const mins = (Date.now() - Date.parse(latest.createdAt)) / 60000;

    if (latest.status !== 'completed') step(`A run is in progress (started ${ago(latest.createdAt)})`);
    else if (latest.conclusion === 'success') ok(`Last run succeeded ${ago(latest.createdAt)}`);
    else bad(`Last run FAILED ${ago(latest.createdAt)} — ${latest.url}`);

    if (mins > 90) {
      bad(`No run has even started for ${Math.round(mins / 60)} hours.`);
      say('     Most likely cause: GitHub disables scheduled workflows on a public');
      say('     repository after 60 days of no activity. Re-enable it with:');
      say(`     ${c.cyan(`gh workflow enable track.yml --repo ${slug}`)}`);
      say('     Scheduled runs are also delayed by GitHub under load; a gap of');
      say('     20-30 minutes is normal and not a fault.');
    }

    const failures = list.filter((r) => r.conclusion === 'failure').length;
    if (failures >= 3) warn(`${failures} of the last ${list.length} runs failed. See "Why did it fail" below.`);
    if (lastGood && lastGood !== latest) warn(`Last SUCCESSFUL run was ${ago(lastGood.createdAt)}`);
  }

  // ------------------------------------------------------ what it says --
  heading('What the app is showing');
  const pagesUrl = await gh.pagesUrl(slug);
  if (!pagesUrl) {
    warn('GitHub Pages is not enabled yet. Re-run: node setup/setup.mjs');
  } else {
    ok(`App URL: ${pagesUrl}`);
    try {
      const res = await fetch(new URL('data/health.json', pagesUrl).toString(), { cache: 'no-store' });
      if (!res.ok) {
        warn(`The app cannot load its status file (HTTP ${res.status}). The first run may not have published yet.`);
      } else {
        const h = await res.json();
        const mins = (Date.now() - Date.parse(h.finishedAt || h.startedAt)) / 60000;
        if (h.ok === false) bad(`Published status says the run FAILED: ${h.error || h.stage}`);
        else if (mins > STALE_MINUTES) warn(`Published data is STALE (${ago(h.finishedAt)})`);
        else ok(`Published data is current (${ago(h.finishedAt)})`);

        if (h.packages) {
          say(`     Packages: ${h.packages.total} total, ${h.packages.confirmed} carrier-confirmed, `
            + `${h.packages.unconfirmed} unconfirmed, ${h.packages.delivered} delivered`);
        }
        if (h.mailboxes) {
          say(`     Mailboxes: ${h.mailboxes.scanned} scanned, ${h.mailboxes.failed} failed`);
          for (const e of h.mailboxes.errors || []) warn(`  ${e}`);
        }
        if (h.push) say(`     Phones registered: ${h.push.subscriptions}`);
        for (const [carrier, b] of Object.entries(h.budget || {})) {
          if (b.denied > 0) warn(`  ${carrier}: daily free allowance exhausted (${b.used}/${b.limit}), ${b.denied} lookups deferred`);
        }
      }
    } catch (err) {
      warn(`Could not reach the app: ${err.message}`);
    }
  }

  // ----------------------------------------------------------- why/fix --
  heading('Configuration');
  const secrets = await gh.listSecrets(slug);
  const required = [['STATE_KEY', 'nothing works without it']];
  const sources = [['GOOGLE_SERVICE_ACCOUNT_JSON', 'company mailboxes'],
    ['PERSONAL_GMAIL_REFRESH_TOKEN', 'personal Gmail']];
  const carriers = [['UPS_CLIENT_ID', 'UPS'], ['FEDEX_CLIENT_ID', 'FedEx'],
    ['DHL_API_KEY', 'DHL'], ['USPS_CLIENT_ID', 'USPS']];

  for (const [name, why] of required) {
    if (secrets.includes(name)) ok(`${name} is set`);
    else bad(`${name} is MISSING — ${why}. Run: node setup/setup.mjs`);
  }
  if (!sources.some(([n]) => secrets.includes(n))) {
    bad('No mailbox source is configured. Run: node setup/setup.mjs');
  } else {
    for (const [name, label] of sources) {
      if (secrets.includes(name)) ok(`${label} connected`);
      else warn(`${label} not connected — that mail is not being watched`);
    }
  }
  for (const [name, label] of carriers) {
    if (secrets.includes(name)) ok(`${label} configured`);
    else warn(`${label} not configured — its packages will show as UNCONFIRMED`);
  }

  heading('Recovery');
  say(`  Run it now:        ${c.cyan(`gh workflow run track.yml --repo ${slug}`)}`);
  say(`  Watch a run:       ${c.cyan(`gh run watch --repo ${slug}`)}`);
  say(`  Read the failure:  ${c.cyan(`gh run view --log-failed --repo ${slug}`)}`);
  say(`  Re-enable schedule:${c.cyan(` gh workflow enable track.yml --repo ${slug}`)}`);
  say(`  Full rescan:       ${c.cyan(`gh workflow run track.yml --repo ${slug} -f full_rescan=true`)}`);
  say(`\n  Details: documentation/OPERATIONS.md\n`);
}

main().catch((e) => bad(e.message)).finally(closePrompts);
