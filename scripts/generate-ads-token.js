'use strict';
/**
 * One-time script to generate Google Ads OAuth2 refresh token.
 * Run: node scripts/generate-ads-token.js
 *
 * Step 1: Script prints an authorization URL — open it in browser
 * Step 2: Login with the Google account that owns the Ads account
 * Step 3: Copy the "code" from the redirect URL
 * Step 4: Paste the code when prompted — script prints your refresh token
 */

require('dotenv').config();
const https       = require('https');
const http        = require('http');
const url         = require('url');
const readline    = require('readline');

const CLIENT_ID     = process.env.GOOGLE_ADS_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:8765/oauth2callback';
const SCOPE         = 'https://www.googleapis.com/auth/adwords';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌  GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

// Build the authorization URL
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
  `client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPE)}` +
  `&access_type=offline` +
  `&prompt=consent`;

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Google Ads OAuth2 Refresh Token Generator');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log('Step 1: Open this URL in your browser (login with your Google Ads account):\n');
console.log(authUrl);
console.log('\nStep 2: After login, Google will redirect to localhost:8765');
console.log('        (The page may show "connection refused" — that is OK)');
console.log('        Copy the full redirect URL from the browser address bar\n');
console.log('Waiting for redirect on http://localhost:8765 ...\n');

// Start a local HTTP server to capture the OAuth callback
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (!parsed.pathname.startsWith('/oauth2callback')) {
    res.end('Waiting...');
    return;
  }

  const code = parsed.query.code;
  if (!code) {
    res.end('Error: No code received.');
    console.error('❌  No authorization code in redirect. Try again.');
    server.close();
    return;
  }

  res.end('<h2>Authorization code received! You can close this tab.</h2><p>Check your terminal for the refresh token.</p>');
  server.close();

  // Exchange code for tokens
  console.log('✅  Authorization code received. Exchanging for refresh token...\n');
  try {
    const params = new URLSearchParams({
      code,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri:  REDIRECT_URI,
      grant_type:    'authorization_code',
    });

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
    });
    const data = await tokenRes.json();

    if (data.error) {
      console.error('❌  Token exchange failed:', data.error_description || data.error);
      return;
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  SUCCESS — Copy this refresh token into your .env file:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(`GOOGLE_ADS_REFRESH_TOKEN=${data.refresh_token}\n`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  } catch (e) {
    console.error('❌  Error exchanging code:', e.message);
  }
});

server.listen(8765, () => {});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('❌  Port 8765 is in use. Kill the process using it and try again.');
    console.error('    Run: lsof -ti:8765 | xargs kill');
  } else {
    console.error('❌  Server error:', e.message);
  }
  process.exit(1);
});
