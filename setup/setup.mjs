#!/usr/bin/env node
/**
 * One-command setup.
 *
 * Everything that can be automated is automated. What remains is only the
 * set of actions that are legally or technically impossible for anyone but
 * the account holder: signing in to your own accounts, and clicking "allow"
 * on your own consent screens.
 *
 *   node setup/setup.mjs
 *
 * Safe to re-run. It reports what is already done and only fills the gaps.
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateVapidKeys } from '../src/crypto.mjs';
import {
  c, heading, say, ok, warn, bad, step, run, has, ask, askSecret,
  confirm, openUrl, gh, closePrompts, describeFailure,
} from './lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_NAME = 'asbury-package-tracker';
const todo = [];

async function main() {
  say(c.b('\n  Asbury Package Tracker — setup\n'));
  say('  This configures a free, always-on tracker for every package');
  say('  arriving at Asbury, and an app for your iPhone.\n');
  say(c.dim('  Nothing you type is saved to disk. Secrets go straight into'));
  say(c.dim('  GitHub\'s encrypted secret store and are then forgotten.\n'));

  // ---------------------------------------------------------- 1. tools --
  heading('1. Checking the tools on this computer');
  for (const [cmd, label] of [['node', 'Node.js'], ['git', 'Git'], ['gh', 'GitHub CLI']]) {
    if (await has(cmd)) ok(`${label} is installed`);
    else {
      bad(`${label} is missing.`);
      if (cmd === 'gh') {
        say('        Install it with: winget install GitHub.cli');
        say('        Then run this setup again.');
      }
      process.exit(1);
    }
  }

  // --------------------------------------------------------- 2. GitHub --
  heading('2. GitHub');
  let auth = await gh.ready();
  if (!auth.ok) {
    warn('You are not signed in to GitHub on this computer.');
    say('  Signing in happens in your browser. This script never sees your password.');
    if (!(await confirm('Open the GitHub sign-in now?'))) {
      bad('Cannot continue without GitHub access.');
      process.exit(1);
    }
    if (!(await gh.login())) { bad('Sign-in did not complete.'); process.exit(1); }
    auth = await gh.ready();
    if (!auth.ok) { bad('Still not signed in.'); process.exit(1); }
  }
  const user = await gh.currentUser();
  if (!user) {
    bad('Signed in, but could not read the GitHub account name.');
    say('  Check with: gh api user');
    process.exit(1);
  }
  ok(`Signed in as ${c.b(user)}`);

  // Check token scopes NOW. A missing scope otherwise surfaces several steps
  // later as an opaque failure, which is exactly what wasted time before.
  const missing = await gh.missingScopes();
  if (missing.length) {
    bad(`The GitHub token is missing ${missing.length === 1 ? 'a scope' : 'scopes'} this setup needs:`);
    for (const [name, why] of missing) say(`      ${c.b(name)} — needed to ${why}`);
    say('\n  Grant them with this one command, then run this setup again:');
    say(`  ${c.cyan(`gh auth refresh -h github.com -s ${missing.map(([n]) => n).join(',')}`)}`);
    say(`\n  ${c.dim('It opens the browser; nothing is stored by this script.')}`);
    process.exit(1);
  }
  ok('Token has the required scopes (repo, workflow)');

  const slug = `${user}/${REPO_NAME}`;
  step(`Checking ${slug} …`);
  const repo = await gh.createRepo(
    slug, REPO_NAME,
    'Tracks every Asbury package to delivery. Data is encrypted.',
  );
  if (!repo.ok) {
    bad(`Could not create the repository: ${repo.reason}`);
    say('  Nothing was changed. Fix the cause and run this setup again —');
    say('  it resumes from wherever it stopped and never creates anything twice.');
    process.exit(1);
  }
  ok(repo.created ? `Created ${slug}` : `Repository ${slug} already exists — reusing it`);

  say('');
  say(c.dim('  Note: the repository is public because GitHub Pages and unlimited'));
  say(c.dim('  Actions minutes are only free that way. Every file containing'));
  say(c.dim('  Asbury data is AES-256 encrypted before it is committed, and the'));
  say(c.dim('  key lives only in GitHub secrets and on your phone.'));

  // ------------------------------------------------------ 3. push code --
  heading('3. Pushing the code');
  if (!existsSync(join(ROOT, '.git'))) {
    await run('git', ['init', '-b', 'main'], { cwd: ROOT });
  }
  await run('git', ['add', '-A'], { cwd: ROOT });
  await run('git', ['-c', 'user.name=setup', '-c', 'user.email=setup@asburycabinets.com',
    'commit', '-m', 'Asbury package tracker'], { cwd: ROOT });
  const remote = await run('git', ['remote', 'get-url', 'origin'], { cwd: ROOT });
  if (remote.code !== 0) {
    await run('git', ['remote', 'add', 'origin', `https://github.com/${slug}.git`], { cwd: ROOT });
  }
  const push = await run('git', ['push', '-u', 'origin', 'main'], { cwd: ROOT });
  if (push.code === 0) {
    ok('Code pushed to GitHub');
  } else if (/everything up-to-date/i.test(`${push.err}${push.out}`)) {
    ok('Code already up to date on GitHub');
  } else {
    bad(`Could not push the code: ${describeFailure(push)}`);
    say('  The workflows live in that push, so nothing will run until it succeeds.');
    say(`  Try by hand:  cd "${ROOT}" && git push -u origin main`);
    say('  Then run this setup again.');
    process.exit(1);
  }

  // ----------------------------------------------------------- 4. keys --
  heading('4. Generating encryption keys');
  const existingSecrets = await gh.listSecrets(slug);
  let stateKey = null;

  /** Store a secret and fail loudly, with gh's own words, if it will not. */
  const storeSecret = async (name, value, fatal = true) => {
    const r = await gh.setSecret(slug, name, value);
    if (r.ok) return true;
    bad(`Could not store ${name}: ${r.detail}`);
    if (fatal) {
      say('\n  Nothing else was changed. Common causes:');
      say('    - the token lost the "repo" scope: gh auth refresh -h github.com -s repo');
      say(`    - no admin rights on ${slug}`);
      say('  Fix the cause and re-run; setup resumes where it stopped.');
      process.exit(1);
    }
    return false;
  };

  if (existingSecrets.includes('STATE_KEY')) {
    ok('STATE_KEY already exists');
    warn('The existing key is kept. Your phone must use the same one.');
    say(`      ${c.dim('If you lost it, re-run with: node setup/setup.mjs --new-key')}`);
    if (process.argv.includes('--new-key')) {
      stateKey = randomBytes(32).toString('base64');
      await storeSecret('STATE_KEY', stateKey);
      warn('Replaced STATE_KEY. Existing stored data can no longer be read and will rebuild.');
    }
  } else {
    stateKey = randomBytes(32).toString('base64');
    await storeSecret('STATE_KEY', stateKey);
    ok('Created and stored STATE_KEY');
  }

  if (!existingSecrets.includes('VAPID_PRIVATE_KEY')) {
    const vapid = generateVapidKeys();
    await storeSecret('VAPID_PUBLIC_KEY', vapid.publicKey);
    await storeSecret('VAPID_PRIVATE_KEY', vapid.privateKey);
    ok('Created notification signing keys');
  } else {
    ok('Notification signing keys already exist');
  }

  for (const [name, value] of [
    ['VAPID_SUBJECT', 'mailto:dasbury@asburycabinets.com'],
    ['GOOGLE_DOMAIN', 'asburycabinets.com'],
    ['GOOGLE_ADMIN_SUBJECT', 'dasbury@asburycabinets.com'],
    ['PERSONAL_GMAIL_ADDRESS', 'asburyderek@gmail.com'],
  ]) {
    const r = await gh.setVariable(slug, name, value);
    // Not fatal: variables all have working defaults in src/config.mjs.
    if (!r.ok) warn(`Could not set variable ${name}: ${r.detail}`);
  }
  ok('Configuration variables set');

  // --------------------------------------------------------- 5. Google --
  heading('5. Google Workspace mailboxes');
  if (existingSecrets.includes('GOOGLE_SERVICE_ACCOUNT_JSON')) {
    ok('Workspace access is already configured');
  } else {
    say('  To read the @asburycabinets.com mailboxes, Google requires a service');
    say('  account that you, as the Workspace admin, authorise. Only you can do');
    say('  that part — Google will not accept it from anyone else.\n');

    const keyPath = await ask('Path to the service-account JSON key (blank to get instructions)');
    if (keyPath && existsSync(keyPath)) {
      const json = await readFile(keyPath, 'utf8');
      let clientId = null;
      try { clientId = JSON.parse(json).client_id; } catch { /* reported below */ }
      const stored = clientId
        ? await gh.setSecret(slug, 'GOOGLE_SERVICE_ACCOUNT_JSON', json)
        : { ok: false, detail: 'file is not a service-account key' };
      if (!clientId) {
        bad('That file does not look like a service-account key (no client_id).');
        todo.push('Supply the Google service-account JSON key (step 5).');
      } else if (!stored.ok) {
        bad(`Could not store the service-account key: ${stored.detail}`);
        todo.push('Store the Google service-account key (step 5).');
      } else {
        ok('Service-account key stored as a GitHub secret');
        say('');
        say(`  ${c.b('One thing only you can do')} — authorise this service account:`);
        say(`    1. A browser tab will open on the Workspace API controls page.`);
        say(`    2. Choose "Add new", paste this Client ID: ${c.cyan(clientId)}`);
        say(`    3. Paste these two scopes, comma separated:`);
        say(`       ${c.cyan('https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/admin.directory.user.readonly')}`);
        say(`    4. Click Authorise.`);
        todo.push('Authorise the service-account Client ID in the Workspace admin console (step 5).');
        if (await confirm('\n  Open that page now?')) {
          await openUrl('https://admin.google.com/ac/owl/domainwidedelegation');
        }
        say(`  ${c.dim('Read-only Gmail. This system cannot send or delete mail.')}`);
      }
    } else {
      warn('Skipped for now.');
      say('  When you are ready, the shortest path is:');
      say(`    ${c.cyan('https://console.cloud.google.com/projectcreate')}  → name it "asbury-tracker"`);
      say(`    Enable the Gmail API and the Admin SDK API, create a service account,`);
      say(`    add a JSON key, then re-run this setup and give it the file path.`);
      todo.push('Create the Google service account and re-run setup (step 5).');
    }
  }

  // -------------------------------------------------- 6. personal Gmail --
  heading('6. Personal Gmail (asburyderek@gmail.com)');
  if (existingSecrets.includes('PERSONAL_GMAIL_REFRESH_TOKEN')) {
    ok('Personal Gmail is already connected');
  } else if (await confirm('Connect the personal Gmail account now?', false)) {
    say('  This needs an OAuth client ID from the same Google project.');
    const clientId = await ask('OAuth client ID (blank to skip)');
    if (clientId) {
      const clientSecret = await askSecret('OAuth client secret (hidden)');
      const { getRefreshToken } = await import('./oauth-personal.mjs');
      try {
        const refresh = await getRefreshToken(clientId, clientSecret);
        // Store the refresh token LAST. config.mjs treats personal Gmail as
        // configured only when all three are present, so a failure part-way
        // leaves it cleanly unconfigured rather than half-wired.
        const a = await gh.setSecret(slug, 'PERSONAL_GMAIL_CLIENT_ID', clientId);
        const b = await gh.setSecret(slug, 'PERSONAL_GMAIL_CLIENT_SECRET', clientSecret);
        const cc = await gh.setSecret(slug, 'PERSONAL_GMAIL_REFRESH_TOKEN', refresh);
        const failed = [['client ID', a], ['client secret', b], ['refresh token', cc]]
          .filter(([, r]) => !r.ok);
        if (failed.length) {
          bad(`Could not store the personal Gmail ${failed[0][0]}: ${failed[0][1].detail}`);
          todo.push('Connect the personal Gmail account (step 6).');
        } else {
          ok('Personal Gmail connected');
        }
      } catch (err) {
        bad(`Could not connect: ${err.message}`);
        todo.push('Connect the personal Gmail account (step 6).');
      }
    } else {
      todo.push('Connect the personal Gmail account (step 6).');
    }
  } else {
    todo.push('Connect the personal Gmail account (step 6).');
  }

  // ------------------------------------------------------- 7. carriers --
  heading('7. Carrier accounts');
  say('  Each carrier issues its own free developer credentials, and each');
  say('  requires you to accept their terms as Asbury. That signup cannot be');
  say('  done on your behalf. Everything after it is automatic.\n');

  const carriers = [
    { key: 'ups', label: 'UPS', url: 'https://developer.ups.com/get-started',
      secrets: ['UPS_CLIENT_ID', 'UPS_CLIENT_SECRET'], prompts: ['Client ID', 'Client secret'] },
    { key: 'fedex', label: 'FedEx', url: 'https://developer.fedex.com/api/en-us/get-started.html',
      secrets: ['FEDEX_CLIENT_ID', 'FEDEX_CLIENT_SECRET'], prompts: ['API key', 'Secret key'] },
    { key: 'dhl', label: 'DHL', url: 'https://developer.dhl.com/api-reference/shipment-tracking',
      secrets: ['DHL_API_KEY'], prompts: ['API key'] },
    { key: 'usps', label: 'USPS', url: 'https://developers.usps.com/',
      secrets: ['USPS_CLIENT_ID', 'USPS_CLIENT_SECRET'], prompts: ['Consumer key', 'Consumer secret'],
      note: 'USPS only gives free tracking to the shipper who owns the Mailer ID. '
        + 'For parcels suppliers send you, USPS will refuse. Worth adding only for parcels you ship.' },
  ];

  for (const carrier of carriers) {
    const done = carrier.secrets.every((s) => existingSecrets.includes(s));
    if (done) { ok(`${carrier.label} already configured`); continue; }
    say('');
    say(`  ${c.b(carrier.label)}`);
    if (carrier.note) say(`  ${c.yellow(carrier.note)}`);
    if (!(await confirm(`Set up ${carrier.label} now?`, carrier.key !== 'usps'))) {
      todo.push(`Add ${carrier.label} credentials (re-run setup).`);
      continue;
    }
    if (await confirm(`Open the ${carrier.label} developer signup page?`)) await openUrl(carrier.url);
    const values = [];
    for (const prompt of carrier.prompts) {
      values.push(await askSecret(`${carrier.label} ${prompt} (hidden, blank to skip)`));
    }
    if (values.some((v) => !v)) {
      warn(`Skipped ${carrier.label}.`);
      todo.push(`Add ${carrier.label} credentials (re-run setup).`);
      continue;
    }
    let failure = null;
    for (const [i, name] of carrier.secrets.entries()) {
      const r = await gh.setSecret(slug, name, values[i]);
      if (!r.ok) { failure = `${name}: ${r.detail}`; break; }
    }
    if (failure) {
      bad(`Could not store ${carrier.label} credentials — ${failure}`);
      todo.push(`Add ${carrier.label} credentials (re-run setup).`);
    } else {
      ok(`${carrier.label} credentials stored`);
    }
  }

  // ---------------------------------------------------------- 8. Pages --
  heading('8. Turning on the app');
  step('Starting the first tracker run …');
  const dispatched = await gh.dispatch(slug, 'track.yml');
  if (dispatched.ok) {
    say('  The first run publishes the app. This takes a minute or two.');
  } else {
    warn(`Could not start the run: ${dispatched.detail}`);
    say(`  Start it by hand: ${c.cyan(`gh workflow run track.yml --repo ${slug}`)}`);
    todo.push('Start the first tracker run (see the command above).');
  }

  step('Enabling GitHub Pages …');
  const pages = await gh.enablePages(slug);
  if (pages.ok) {
    ok(`GitHub Pages enabled (${pages.detail})`);
  } else {
    warn(`Pages could not be enabled yet: ${pages.detail}`);
    say('  This is normal on a first run — Pages needs the gh-pages branch to');
    say('  exist, and the tracker creates it. Re-run this setup once the first');
    say('  run has finished and it will complete.');
    todo.push('Re-run setup once the first tracker run has completed, to enable Pages.');
  }

  const url = (await gh.pagesUrl(slug)) || `https://${user}.github.io/${REPO_NAME}/`;

  // ---------------------------------------------------------- 9. phone --
  heading('9. Your iPhone');
  const installUrl = stateKey ? `${url}#k=${encodeURIComponent(stateKey)}` : url;
  say('  On your iPhone, open this link, then Share → Add to Home Screen:\n');
  say(`  ${c.cyan(installUrl)}\n`);
  if (stateKey) {
    say(c.dim('  The key is in the part after the #. That never leaves your phone and'));
    say(c.dim('  is never sent to any server. Once the app opens, it is saved locally'));
    say(c.dim('  and removed from the address bar.'));
  } else {
    say(c.dim('  Your existing STATE_KEY is needed to unlock the app. It is in the'));
    say(c.dim('  output from when you first ran this setup.'));
  }
  say('');
  say('  Then open Packages from the Home Screen, expand "Notifications and');
  say('  diagnostics", and tap Turn on notifications, then Finish registering.');
  say(c.dim('  iOS only allows notifications for apps added to the Home Screen.'));

  // ------------------------------------------------------------ summary --
  heading('What is left for you');
  if (todo.length === 0) {
    ok('Nothing. It is running.');
  } else {
    say('  Only these, and only because your accounts require you personally:\n');
    todo.forEach((t, i) => say(`    ${i + 1}. ${t}`));
    say(`\n  ${c.dim('Re-run')} node setup/setup.mjs ${c.dim('any time to finish the rest.')}`);
  }
  say(`\n  Health check any time:  ${c.b('node setup/doctor.mjs')}`);
  say(`  Run log:                ${c.cyan(`https://github.com/${slug}/actions`)}`);
  say('');
}

main()
  .catch((err) => { bad(`Setup failed: ${err.message}`); process.exitCode = 1; })
  .finally(closePrompts);
