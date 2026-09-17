/**
 * Google authentication, with no third-party libraries.
 *
 * Two paths:
 *  1. Service account + Workspace domain-wide delegation. One key, authority
 *     over every @asburycabinets.com mailbox. Mailboxes are discovered via the
 *     Admin SDK so a new employee's mailbox is watched the moment it exists,
 *     with no action from Derek. This is why the system "manages itself".
 *  2. OAuth refresh token for the personal Gmail account, which is outside the
 *     Workspace domain and therefore cannot be delegated.
 *
 * Scopes requested are read-only. This system can never send, delete or modify
 * mail, by construction.
 */

import { createSign } from 'node:crypto';
import { request } from '../http.mjs';
import { registerSecret } from '../log.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const SCOPES = {
  gmailReadonly: 'https://www.googleapis.com/auth/gmail.readonly',
  directoryReadonly: 'https://www.googleapis.com/auth/admin.directory.user.readonly',
};

const b64url = (b) => Buffer.from(b).toString('base64url');

/**
 * Mint an access token for a service account, optionally impersonating a user.
 * @param {object} sa    parsed service-account JSON
 * @param {string} scope space-separated scopes
 * @param {string} [subject] user to impersonate (domain-wide delegation)
 */
export async function serviceAccountToken(sa, scope, subject) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id }));
  const claims = {
    iss: sa.client_email,
    scope,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  if (subject) claims.sub = subject;
  const payload = b64url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;

  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = signer.sign(sa.private_key);
  const assertion = `${signingInput}.${b64url(signature)}`;

  const res = await request(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });

  if (!res.ok || !res.json?.access_token) {
    const detail = res.json?.error_description || res.json?.error || `HTTP ${res.status}`;
    throw new Error(
      `Google token request failed for ${subject || sa.client_email}: ${detail}. `
      + 'If this says "unauthorized_client", domain-wide delegation has not been '
      + 'granted for this client ID and scope in the Workspace admin console.',
    );
  }
  registerSecret(res.json.access_token);
  return res.json.access_token;
}

/** Exchange a stored refresh token for an access token (personal Gmail). */
export async function refreshTokenToAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await request(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!res.ok || !res.json?.access_token) {
    const detail = res.json?.error_description || res.json?.error || `HTTP ${res.status}`;
    throw new Error(`Personal Gmail token refresh failed: ${detail}`);
  }
  registerSecret(res.json.access_token);
  return res.json.access_token;
}

export function parseServiceAccount(json) {
  let sa;
  try {
    sa = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error('Service account JSON is missing client_email or private_key');
  }
  registerSecret(sa.private_key);
  return sa;
}

/**
 * List every active, non-suspended user mailbox in the Workspace domain.
 * Requires the Admin SDK scope to be delegated. If it is not, the caller
 * falls back to the explicitly configured mailbox list.
 */
export async function listDomainMailboxes(sa, adminSubject, domain) {
  const token = await serviceAccountToken(sa, SCOPES.directoryReadonly, adminSubject);
  const mailboxes = [];
  let pageToken;
  do {
    const url = new URL('https://admin.googleapis.com/admin/directory/v1/users');
    url.searchParams.set('domain', domain);
    url.searchParams.set('maxResults', '200');
    url.searchParams.set('projection', 'basic');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await request(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Admin SDK user list failed: HTTP ${res.status}`);
    }
    for (const u of res.json?.users || []) {
      if (u.suspended || u.archived) continue;
      if (u.primaryEmail) mailboxes.push(u.primaryEmail);
    }
    pageToken = res.json?.nextPageToken;
  } while (pageToken);
  return mailboxes;
}
