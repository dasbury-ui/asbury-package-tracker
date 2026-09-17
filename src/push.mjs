/**
 * Web Push delivery to Derek's iPhone.
 *
 * iOS supports Web Push only for a PWA that has been added to the Home Screen
 * (iOS 16.4+, still true on iOS 26). Verified September 2026.
 *
 * Subscriptions expire and phones get replaced, so a 404 or 410 from the push
 * service prunes the subscription automatically rather than failing forever.
 */

import { encryptPushPayload, vapidAuthorization } from './crypto.mjs';
import { request } from './http.mjs';
import { log } from './log.mjs';

const TTL_SECONDS = 6 * 3600;

/**
 * @param {Array} subscriptions  [{endpoint, keys:{p256dh, auth}, label}]
 * @param {object} notification  {title, body, tag, url}
 * @param {object} vapid         {publicKey, privateKey, subject}
 * @returns {Promise<{sent:number, pruned:string[], failed:number}>}
 */
export async function sendPush(subscriptions, notification, vapid) {
  if (!vapid?.publicKey || !vapid?.privateKey) {
    log.debug('Push not configured; skipping notification');
    return { sent: 0, pruned: [], failed: 0 };
  }

  const payload = JSON.stringify(notification);
  const pruned = [];
  let sent = 0;
  let failed = 0;

  for (const sub of subscriptions) {
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      pruned.push(sub?.endpoint || 'malformed');
      continue;
    }
    try {
      const body = encryptPushPayload(payload, sub.keys.p256dh, sub.keys.auth);
      const res = await request(sub.endpoint, {
        method: 'POST',
        headers: {
          Authorization: vapidAuthorization(
            sub.endpoint, vapid.subject, vapid.publicKey, vapid.privateKey,
          ),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(TTL_SECONDS),
          Urgency: notification.urgency || 'normal',
        },
        body,
        expectJson: false,
        maxAttempts: 2,
      });

      if (res.status === 404 || res.status === 410) {
        pruned.push(sub.endpoint);
        log.info('Pruned an expired push subscription', {});
      } else if (res.ok || res.status === 201) {
        sent += 1;
      } else {
        failed += 1;
        log.warn('Push delivery rejected', { status: res.status });
      }
    } catch (err) {
      failed += 1;
      log.warn('Push delivery threw', { error: err.message });
    }
  }
  return { sent, pruned, failed };
}

/**
 * Build the notifications for this run. Deliberately quiet: Derek is told
 * about a new package and about a real change of state, nothing else.
 */
export function buildNotifications(events) {
  const out = [];
  const newOnes = events.filter((e) => e.kind === 'NEW');
  const delivered = events.filter((e) => e.kind === 'STATUS' && e.to === 'DELIVERED');
  const ofd = events.filter((e) => e.kind === 'STATUS' && e.to === 'OUT_FOR_DELIVERY');
  const problems = events.filter((e) => e.kind === 'STATUS' && (e.to === 'EXCEPTION' || e.to === 'RETURNED'));

  if (newOnes.length === 1) {
    out.push({
      title: 'New package tracked',
      body: `${newOnes[0].label} — ${newOnes[0].number}`,
      tag: `new-${newOnes[0].number}`,
      url: '/',
    });
  } else if (newOnes.length > 1) {
    out.push({
      title: `${newOnes.length} new packages tracked`,
      body: newOnes.slice(0, 3).map((e) => e.label).join(', ') + (newOnes.length > 3 ? '…' : ''),
      tag: 'new-batch',
      url: '/',
    });
  }

  for (const e of ofd) {
    out.push({
      title: 'Out for delivery today',
      body: `${e.label} — ${e.number}`,
      tag: `ofd-${e.number}`,
      url: '/',
      urgency: 'high',
    });
  }

  if (delivered.length === 1) {
    out.push({
      title: 'Delivered',
      body: `${delivered[0].label} — ${delivered[0].number}`,
      tag: `del-${delivered[0].number}`,
      url: '/',
    });
  } else if (delivered.length > 1) {
    out.push({
      title: `${delivered.length} packages delivered`,
      body: delivered.slice(0, 3).map((e) => e.label).join(', '),
      tag: 'del-batch',
      url: '/',
    });
  }

  for (const e of problems) {
    out.push({
      title: e.to === 'RETURNED' ? 'Package returned to sender' : 'Delivery problem',
      body: `${e.label} — ${e.number}`,
      tag: `prob-${e.number}`,
      url: '/',
      urgency: 'high',
    });
  }

  return out;
}
