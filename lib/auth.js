'use strict';

/**
 * GAM OAuth2 authentication helpers.
 * The refresh token is read from GAM_REFRESH_TOKEN in .env — it was obtained
 * once via the /auth flow and does not need to be re-fetched on every request.
 * The auth client is cached in module scope so the token is only refreshed
 * when the google-auth-library decides it has expired.
 */

const { OAuth2Client } = require('google-auth-library');
const { SCOPES } = require('../config');

let authClient = null;

// Constructs a bare OAuth2 client using credentials from .env.
// The redirect URI matches the /auth callback route on the local server.
function getOAuth2Client() {
  return new OAuth2Client(
    process.env.GAM_CLIENT_ID,
    process.env.GAM_CLIENT_SECRET,
    'http://localhost:3001'
  );
}

// Returns the singleton auth client, initialised with the stored refresh token.
// Throws if GAM_REFRESH_TOKEN is missing — the user must complete the /auth flow first.
async function getAuthClient() {
  if (!authClient) {
    const client = getOAuth2Client();
    if (!process.env.GAM_REFRESH_TOKEN) {
      throw new Error('GAM_REFRESH_TOKEN is not set — visit http://localhost:3001/auth to authorise');
    }
    client.setCredentials({ refresh_token: process.env.GAM_REFRESH_TOKEN });
    authClient = client;
  }
  return authClient;
}

// Returns a short-lived access token, transparently refreshing it if needed.
async function getToken() {
  const client = await getAuthClient();
  const { token } = await client.getAccessToken();
  return token;
}

module.exports = { getOAuth2Client, getAuthClient, getToken, SCOPES };
