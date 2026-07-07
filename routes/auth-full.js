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

/* Serves the main dashboard HTML when no OAuth code is present.
 * When Google redirects back with ?code=..., exchanges it for tokens and renders
 * the refresh token so the user can add it to .env. */
router.get('/', async (req, res, next) => {
  if (!req.query.code) return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(req.query.code);
  res.send(`
    <p>Authorised. Add this to your .env file then restart the server:</p>
    <pre>GAM_REFRESH_TOKEN=${tokens.refresh_token}</pre>
  `);
});

module.exports = router;
