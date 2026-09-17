/**
 * OAuth loopback flow for the personal Gmail account.
 *
 * Google's "installed app" flow: a one-off local web server receives the
 * redirect. Derek clicks "Allow" in his own browser; no password is ever
 * typed into this script and no token is written to disk - the refresh token
 * is returned to the caller, which pipes it straight into a GitHub secret.
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { openUrl, say, c } from './lib.mjs';

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export function getRefreshToken(clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const csrfState = randomBytes(16).toString('hex');
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn(value);
    };

    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }

      const respond = (message) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8">
          <body style="font:16px system-ui;padding:40px;max-width:32rem">
          <h2>${message}</h2><p>You can close this tab and go back to the terminal.</p>`);
      };

      if (url.searchParams.get('state') !== csrfState) {
        respond('That did not match the request. Nothing was changed.');
        finish(reject, new Error('OAuth state mismatch - the response did not match the request'));
        return;
      }
      const error = url.searchParams.get('error');
      if (error) {
        respond('Access was not granted.');
        finish(reject, new Error(`Google returned: ${error}`));
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        respond('No authorisation code came back.');
        finish(reject, new Error('No authorisation code in the redirect'));
        return;
      }

      try {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: `http://127.0.0.1:${server.address().port}/callback`,
            grant_type: 'authorization_code',
          }),
        });
        const data = await tokenRes.json();
        if (!data.refresh_token) {
          respond('Google did not return a refresh token.');
          finish(reject, new Error(
            data.error_description || data.error
            || 'No refresh token returned. Remove the app at myaccount.google.com/permissions and try again.',
          ));
          return;
        }
        respond('Connected. Gmail read-only access granted.');
        finish(resolve, data.refresh_token);
      } catch (err) {
        respond('Something went wrong exchanging the code.');
        finish(reject, err);
      }
    });

    const timer = setTimeout(
      () => finish(reject, new Error('Timed out waiting for the browser (5 minutes)')),
      5 * 60 * 1000,
    );

    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.searchParams.set('client_id', clientId);
      auth.searchParams.set('redirect_uri', `http://127.0.0.1:${port}/callback`);
      auth.searchParams.set('response_type', 'code');
      auth.searchParams.set('scope', SCOPE);
      auth.searchParams.set('access_type', 'offline');
      auth.searchParams.set('prompt', 'consent');
      auth.searchParams.set('state', csrfState);

      say(`\n  Opening Google in your browser. Sign in as the personal Gmail account`);
      say(`  and click Allow. ${c.dim('Read-only access to mail; nothing else.')}\n`);
      say(`  ${c.dim('If the browser does not open, paste this:')}`);
      say(`  ${c.cyan(auth.toString())}\n`);
      await openUrl(auth.toString());
    });

    server.on('error', (err) => finish(reject, err));
  });
}
