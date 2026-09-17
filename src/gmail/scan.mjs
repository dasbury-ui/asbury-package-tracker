/**
 * Gmail scanning.
 *
 * Incremental by default: each mailbox keeps a historyId cursor, so a run
 * costs a couple of API calls when nothing has arrived. When the cursor is too
 * old for Gmail to serve (Gmail keeps roughly a week of history), it falls
 * back to a bounded date-windowed search and says so in the log - never
 * silently skipping mail.
 *
 * Read-only throughout.
 */

import { request } from '../http.mjs';
import { log } from '../log.mjs';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Only fetch messages plausibly about a shipment. Keeps quota use tiny. */
const SEARCH_QUERY = [
  'in:anywhere',
  '-in:spam',
  '(',
  'tracking OR "tracking number" OR "has shipped" OR "your order has shipped"',
  'OR "out for delivery" OR "shipment" OR "shipping confirmation"',
  'OR ups.com OR fedex.com OR usps.com OR dhl.com',
  'OR from:ups.com OR from:fedex.com OR from:usps.com OR from:dhl.com',
  ')',
].join(' ');

async function gapi(token, path, params) {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return request(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
}

/**
 * @returns {Promise<{messageIds:string[], newCursor:string|null, mode:string, error:string|null}>}
 */
export async function listCandidateMessageIds(token, cursor, { lookbackDays, maxMessages }) {
  // --- Incremental path ---
  if (cursor) {
    const res = await gapi(token, '/history', {
      startHistoryId: cursor,
      historyTypes: 'messageAdded',
      maxResults: 500,
    });
    if (res.ok) {
      const ids = new Set();
      for (const h of res.json?.history || []) {
        for (const added of h.messagesAdded || []) {
          if (added.message?.id) ids.add(added.message.id);
        }
      }
      return {
        messageIds: [...ids].slice(0, maxMessages),
        newCursor: res.json?.historyId || cursor,
        mode: 'history',
        error: null,
      };
    }
    if (res.status !== 404) {
      return { messageIds: [], newCursor: cursor, mode: 'history', error: `HTTP ${res.status}` };
    }
    log.warn('Gmail history cursor expired; falling back to a dated search', {});
  }

  // --- Full/fallback path: bounded search ---
  const q = `${SEARCH_QUERY} newer_than:${lookbackDays}d`;
  const ids = [];
  let pageToken;
  do {
    const res = await gapi(token, '/messages', {
      q, maxResults: 100, pageToken,
    });
    if (!res.ok) {
      return { messageIds: ids, newCursor: null, mode: 'search', error: `HTTP ${res.status}` };
    }
    for (const m of res.json?.messages || []) ids.push(m.id);
    pageToken = res.json?.nextPageToken;
  } while (pageToken && ids.length < maxMessages);

  // Establish a cursor for next time.
  const profile = await gapi(token, '/profile', {});
  return {
    messageIds: ids.slice(0, maxMessages),
    newCursor: profile.ok ? (profile.json?.historyId || null) : null,
    mode: 'search',
    error: null,
  };
}

/** Fetch one message and flatten it into plain fields for the extractor. */
export async function fetchMessage(token, messageId, mailbox) {
  const res = await gapi(token, `/messages/${messageId}`, { format: 'full' });
  if (!res.ok) return null;
  const msg = res.json;
  const headers = Object.fromEntries(
    (msg.payload?.headers || []).map((h) => [String(h.name).toLowerCase(), h.value]),
  );

  const parts = [];
  collectParts(msg.payload, parts);

  const text = parts.filter((p) => p.mime === 'text/plain').map((p) => p.body).join('\n');
  const htmlRaw = parts.filter((p) => p.mime === 'text/html').map((p) => p.body).join('\n');

  return {
    messageId,
    mailbox,
    threadId: msg.threadId,
    subject: headers.subject || '',
    from: headers.from || '',
    date: headers.date ? safeDate(headers.date) : isoFromMs(msg.internalDate),
    text,
    // Keep the raw HTML: hrefs are where carrier links live, and they are the
    // single highest-signal source of a real tracking number.
    html: htmlRaw,
    snippet: msg.snippet || '',
  };
}

function collectParts(part, out) {
  if (!part) return;
  const mime = part.mimeType || '';
  if (part.body?.data) {
    out.push({ mime, body: decodeB64Url(part.body.data) });
  }
  for (const child of part.parts || []) collectParts(child, out);
}

function decodeB64Url(data) {
  try {
    return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function safeDate(v) {
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function isoFromMs(ms) {
  const n = Number(ms);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}
