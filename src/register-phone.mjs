#!/usr/bin/env node
/**
 * Consume an encrypted push subscription that the PWA handed over via a
 * GitHub issue, and add it to the encrypted state.
 *
 * The issue body is untrusted input: it is ciphertext until proven otherwise,
 * and it only becomes a subscription if it decrypts under our own state key
 * and then passes a strict shape check. Anything else is refused with a
 * reason, never partially applied.
 */

import { appendFileSync } from 'node:fs';
import { Store } from './state.mjs';
import { decryptJson } from './crypto.mjs';
import { log } from './log.mjs';

const output = (key, value) => {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${String(value).replace(/\n/g, ' ')}\n`);
  }
};

const ALLOWED_PUSH_HOSTS = [
  'web.push.apple.com',
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'notify.windows.com',
];

/** Exact host, or a subdomain of it. "notweb.push.apple.com" must not pass. */
function hostAllowed(host) {
  return ALLOWED_PUSH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

function validate(sub) {
  if (!sub || typeof sub !== 'object') return 'Payload was not an object';
  if (typeof sub.endpoint !== 'string') return 'Missing endpoint';
  let url;
  try { url = new URL(sub.endpoint); } catch { return 'Endpoint is not a URL'; }
  if (url.protocol !== 'https:') return 'Endpoint must be https';
  if (!hostAllowed(url.host)) return 'Endpoint host is not a recognised push service';
  if (!sub.keys?.p256dh || !sub.keys?.auth) return 'Missing subscription keys';
  if (Buffer.from(sub.keys.p256dh, 'base64url').length !== 65) return 'p256dh is the wrong length';
  if (Buffer.from(sub.keys.auth, 'base64url').length !== 16) return 'auth secret is the wrong length';
  return null;
}

async function main() {
  const store = new Store(process.env.DATA_DIR || 'publish/data', process.env.STATE_KEY);
  await store.load();
  const state = store.state;

  const raw = String(process.env.ISSUE_BODY || '').trim();
  const match = /```(?:json)?\s*([\s\S]+?)```/.exec(raw);
  const blob = (match ? match[1] : raw).trim();

  let envelope;
  try {
    envelope = JSON.parse(blob);
  } catch {
    output('changed', 'false');
    output('message', 'That did not look like a registration payload. Nothing was changed.');
    return;
  }

  let sub;
  try {
    sub = decryptJson(store.key, envelope);
  } catch {
    output('changed', 'false');
    output('message', 'Could not decrypt that payload with this repository key. Nothing was changed.');
    return;
  }

  const problem = validate(sub);
  if (problem) {
    output('changed', 'false');
    output('message', `Registration refused: ${problem}. Nothing was changed.`);
    return;
  }

  state.pushSubscriptions = state.pushSubscriptions || [];
  const existing = state.pushSubscriptions.findIndex((s) => s.endpoint === sub.endpoint);
  const record = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    label: String(sub.label || 'iPhone').slice(0, 40),
    registeredAt: new Date().toISOString(),
  };

  if (existing >= 0) {
    state.pushSubscriptions[existing] = record;
  } else {
    state.pushSubscriptions.push(record);
  }
  // One person, a handful of devices. Keep the newest few.
  if (state.pushSubscriptions.length > 5) {
    state.pushSubscriptions = state.pushSubscriptions.slice(-5);
  }

  // Deliberately pass null: this is not a tracker run, so it must not
  // overwrite health.json and make a stale feed look fresh.
  await store.save(null);

  log.info('Registered a phone for notifications', {
    total: state.pushSubscriptions.length,
  });
  output('changed', 'true');
  output('message',
    `Registered "${record.label}" for notifications. ${state.pushSubscriptions.length} device(s) active. You can delete this issue.`);
}

main().catch((err) => {
  log.error('Phone registration failed', { error: err.message });
  output('changed', 'false');
  output('message', `Registration failed: ${err.message}`);
  process.exitCode = 1;
});
