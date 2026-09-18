const axios = require('axios');

const TOKEN_URL = 'https://accounts.zoho.in/oauth/v2/token';
const API_BASE  = 'https://www.zohoapis.in/books/v3';
const ORG_ID    = process.env.ZOHO_ORG_ID;

// ── Retry config ────────────────────────────────────────────────────────────
const MAX_RETRIES    = 3;
const BASE_DELAY_MS  = 2000;  // 2s, 4s, 8s exponential backoff

let _accessToken = null;
let _tokenExpiry = 0;

async function getAccessToken() {
  if (_accessToken && Date.now() < _tokenExpiry) return _accessToken;
  const res = await axios.post(TOKEN_URL, null, {
    params: {
      grant_type:    'refresh_token',
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    },
  });
  _accessToken = res.data.access_token;
  _tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return _accessToken;
}

// ── WhatsApp alert for Zoho failures ────────────────────────────────────────
// Set ZOHO_SUPPRESS_ALERTS=true to silence alerts (used during backfill runs)
async function alertAdminZohoFailure(operation, detail) {
  if (process.env.ZOHO_SUPPRESS_ALERTS === 'true') return;
  try {
    const { sendText } = require('../lib/greenapi');
    const phones = [process.env.WA_ADMIN_PHONE1, process.env.WA_ADMIN_PHONE2].filter(Boolean);
    if (!phones.length) return;
    const msg = `⚠️ *Zoho Books Failure*\n\n` +
      `Operation: ${operation}\n` +
      `Error: ${detail}\n` +
      `Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n` +
      `All ${MAX_RETRIES} retries exhausted. Please check manually in Zoho Books.`;
    for (const phone of phones) {
      await sendText(phone, msg, { priority: true });
    }
  } catch (e) {
    console.error('[Zoho] Failed to send WhatsApp alert:', e.message);
  }
}

// ── Retry helper with exponential backoff ───────────────────────────────────
function isRetryable(err) {
  const status = err.response?.status;
  const msg = err.response?.data?.error_description || '';
  // Retry on: network errors, 429 rate limit, 500+ server errors, Zoho "too many requests" (returns 400)
  if (!status) return true; // network/timeout error
  if (status === 429) return true;
  if (status >= 500) return true;
  if (status === 400 && msg.includes('too many requests')) return true;
  return false;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Core API call with retry + alert ────────────────────────────────────────
async function zoho(method, path, data, extraParams = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const token = await getAccessToken();
      const res = await axios({
        method,
        url: `${API_BASE}${path}`,
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { organization_id: ORG_ID, ...extraParams },
        data,
        timeout: 30000, // 30s timeout
      });
      return res.data;
    } catch (err) {
      lastErr = err;
      const detail = err.response?.data;
      const status = err.response?.status;
      console.error(`Zoho API error [${method.toUpperCase()} ${path}] attempt ${attempt}/${MAX_RETRIES}:`, JSON.stringify(detail || err.message));

      // If token expired (401), force refresh and retry
      if (status === 401) {
        _accessToken = null;
        _tokenExpiry = 0;
      }

      // Don't retry non-retryable errors (400 bad request, 404, etc.)
      if (!isRetryable(err)) break;

      // Wait before retry (exponential backoff)
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`[Zoho] Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  // All retries exhausted — send WhatsApp alert
  const errMsg = lastErr.response?.data?.message || lastErr.message;
  alertAdminZohoFailure(`${method.toUpperCase()} ${path}`, errMsg);
  throw lastErr;
}

// ── Read-only GET helper (exported for zohoCustomers.js) ────────────────────
async function zohoGet(path, params = {}) {
  return zoho('get', path, null, params);
}

// Find or create a contact in Zoho Books by email
// contactType: 'customer' (default) or 'vendor'
async function findOrCreateContact(name, email, phone, contactType) {
  const type = contactType || 'customer';
  if (!name && !email) return null;
  try {
    // Create new contact — if duplicate exists, Zoho returns existing ID in error
    const payload = {
      contact_name: name || email,
      contact_type: type,
      ...(email ? { email_address: email } : {}),
      ...(phone ? { mobile: phone } : {}),
    };
    const created = await zoho('post', '/contacts', payload);
    return created.contact?.contact_id || null;
  } catch (e) {
    // If duplicate contact exists, Zoho returns the existing contact_id in the error
    const existingId = e.response?.data?.contact_id;
    if (existingId) return existingId;
    console.warn(`Zoho ${type} contact create failed:`, e.response?.data?.message || e.message);
    return null;
  }
}

// Create an invoice in Zoho Books for a webstore order
async function createInvoice(order) {
  const { customer = {}, items = [], shipping, total, orderNo, date } = order;

  const contactId = await findOrCreateContact(customer.name, customer.email, customer.phone);

  // Line items — Zoho calculates item_total from rate x quantity, don't send item_total
  const lineItems = (items || []).map(i => ({
    name:     i.name || 'Product',
    quantity: parseFloat(i.qty) || 1,
    rate:     parseFloat(i.price) || 0,
  }));

  const payload = {
    invoice_number:   (orderNo || '').slice(0, 16),
    reference_number: orderNo,
    date:             date || new Date().toISOString().slice(0, 10),
    line_items:       lineItems,
    shipping_charge:  parseFloat(shipping) > 0 ? parseFloat(shipping) : 0,
    notes:            `Order ${orderNo} via sathvam.in`,
    ...(contactId
      ? { customer_id: contactId }
      : { customer_name: customer.name || 'Guest Customer' }),
  };

  console.log('Creating Zoho invoice:', JSON.stringify(payload));
  const result = await zoho('post', '/invoices', payload);
  console.log('Zoho invoice created:', result?.invoice?.invoice_id);
  return result.invoice;
}

// Record payment against an invoice in Zoho Books
async function recordPayment(invoice, amount, paymentMethod, referenceNo) {
  const methodMap = { upi: 'Cash', card: 'CreditCard', online: 'Cash', cash: 'Cash', bank: 'BankTransfer', neft: 'BankTransfer', rtgs: 'BankTransfer', cheque: 'Cheque' };
  const payload = {
    customer_id:      invoice.customer_id,
    payment_mode:     methodMap[paymentMethod] || 'Cash',
    amount:           parseFloat(amount),
    date:             new Date().toISOString().slice(0, 10),
    reference_number: referenceNo || '',
    invoices: [{ invoice_id: invoice.invoice_id, amount_applied: parseFloat(amount) }],
  };
  console.log('Recording Zoho payment:', JSON.stringify(payload));
  const result = await zoho('post', '/customerpayments', payload);
  console.log('Zoho payment recorded:', result?.payment?.payment_id);
  return result.payment;
}

module.exports = { getAccessToken, createInvoice, recordPayment, findOrCreateContact, zoho, zohoGet };
