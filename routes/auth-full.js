'use strict';

/*
 * Auth routes for the full server (server.js) — identical to routes/auth.js except
 * the GET / handler serves index.html (the full desktop + mobile UI) instead of
 * index-desktop.html (the desktop-only UI served by server-desktop.js).
 *
 * Handles the Google OAuth2 flow needed to obtain a GAM refresh token.
 * Two endpoints: one to kick off the OAuth redirect, one to receive the callback and
 * display the resulting refresh token for the user to copy into .env.
 */

const express = require('express');
const path = require('path');
const { getOAuth2Client, SCOPES } = require('../lib/auth');

const router = express.Router();

/* Redirects the browser to Google's OAuth consent screen.
 * access_type=offline and prompt=consent ensure a refresh token is always returned,
 * even if the user has previously granted access. */
router.get('/auth', (req, res) => {
  const client = getOAuth2Client();
  const url = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  res.redirect(url);
});

/* Serves the main dashboard HTML, or handles the OAuth2 callback when Google
 * redirects back with ?code=... after the user approves access. */
router.get('/', async (req, res) => {
  if (!req.query.code) return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  try {
    const client = getOAuth2Client();
    const { tokens } = await client.getToken(req.query.code);
    const refreshToken = tokens.refresh_token;
    if (!refreshToken) {
      return res.status(400).send('Google did not return a refresh token. Revoke this app at https://myaccount.google.com/permissions, then visit /auth again.');
    }
    // Write the refresh token straight into .env so there is no manual copy/paste/save
    // step — editor saves on this machine were unreliable, but a server-side fs write
    // persists correctly. The token is minted by THIS server's OAuth client, so it is
    // guaranteed to match the local GAM_CLIENT_ID/SECRET. Best-effort: if the write
    // fails, fall back to showing the value for manual entry.
    let wrote = false;
    try {
      const fs = require('fs');
      const envPath = path.join(__dirname, '..', '.env');
      let env = fs.readFileSync(envPath, 'utf8');
      env = /^GAM_REFRESH_TOKEN=/m.test(env)
        ? env.replace(/^GAM_REFRESH_TOKEN=.*$/m, () => 'GAM_REFRESH_TOKEN=' + refreshToken)
        : env + (env.endsWith('\n') ? '' : '\n') + 'GAM_REFRESH_TOKEN=' + refreshToken + '\n';
      fs.writeFileSync(envPath, env);
      wrote = true;
    } catch (e) {}
    if (wrote) {
      res.send(`
      <div style="font:15px/1.55 system-ui;max-width:700px;margin:40px auto;color:#1a1a2e;padding:0 20px">
        <p>✅ <strong>Authorised — new refresh token saved to <code>.env</code> automatically.</strong></p>
        <p style="color:#444">Copy this token into the <strong>GitHub Actions secret</strong> <code>GAM_REFRESH_TOKEN</code> (and Netlify, if you use it) so the daily refresh keeps working under this OAuth client:</p>
        <div style="display:flex;gap:8px;align-items:stretch;margin:12px 0">
          <code id="tok" style="flex:1;display:block;background:#f4f6fa;border:1px solid #dfe4ee;border-radius:6px;padding:10px 12px;font-size:12px;word-break:break-all;user-select:all">${refreshToken}</code>
          <button onclick="navigator.clipboard.writeText(document.getElementById('tok').innerText).then(()=>{this.innerText='Copied ✓';this.style.background='#1aab6d'})" style="background:#2563b8;color:#fff;border:none;border-radius:6px;padding:0 16px;font-size:13px;cursor:pointer;white-space:nowrap">Copy</button>
        </div>
        <p style="color:#444">Then <strong>restart the server</strong> (<code>Ctrl+C</code>, then <code>node server.js</code>) and reload the dashboard — you should see live data with no cached-data banner.</p>
      </div>`);
    } else {
      res.send(`<p>Authorised, but couldn't write .env automatically. Add this line to .env then restart:</p><pre>GAM_REFRESH_TOKEN=${refreshToken}</pre>`);
    }
  } catch (err) {
    res.status(500).send(`Token exchange failed: ${err.message}`);
  }
});

module.exports = router;
