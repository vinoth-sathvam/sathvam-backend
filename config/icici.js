const axios = require('axios');

// ICICI API Banking configuration
const ICICI_BASE = process.env.ICICI_API_BASE || 'https://apibankingopenplatform.icicibank.com/api/v1';
const ICICI_TOKEN_URL = process.env.ICICI_TOKEN_URL || 'https://apibankingopenplatform.icicibank.com/auth/oauth/v2/token';

let _accessToken = null;
let _tokenExpiry = 0;

// Check if ICICI API is configured
function isConfigured() {
  return !!(process.env.ICICI_CLIENT_ID && process.env.ICICI_CLIENT_SECRET);
}

// OAuth2 token management (auto-refresh, cached)
async function getAccessToken() {
  if (_accessToken && Date.now() < _tokenExpiry) return _accessToken;
  if (!isConfigured()) throw new Error('ICICI API not configured');

  const { data } = await axios.post(ICICI_TOKEN_URL, new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.ICICI_CLIENT_ID,
    client_secret: process.env.ICICI_CLIENT_SECRET,
  }).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });

  _accessToken = data.access_token;
  _tokenExpiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  return _accessToken;
}

// Generic API call
async function iciciAPI(method, path, body = null, params = {}) {
  const token = await getAccessToken();
  const config = {
    method,
    url: `${ICICI_BASE}${path}`,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-ICICI-APIKEY': process.env.ICICI_API_KEY || '',
    },
    params,
    timeout: 30000,
  };
  if (body) config.data = body;
  const res = await axios(config);
  return res.data;
}

// Clear cached token (useful for re-auth)
function clearToken() {
  _accessToken = null;
  _tokenExpiry = 0;
}

module.exports = { isConfigured, getAccessToken, iciciAPI, clearToken };
