const axios = require('axios');

const TOKEN_URL = 'https://accounts.zoho.in/oauth/v2/token';
const API_BASE  = 'https://www.zohoapis.in/books/v3';
const ORG_ID    = process.env.ZOHO_ORG_ID;

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

async function zoho(method, path, data, extraParams = {}) {
  const token = await getAccessToken();
  try {
    const res = await axios({
      method,
      url: `${API_BASE}${path}`,
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: ORG_ID, ...extraParams },
      data,
    });
    return res.data;
  } catch (err) {
    const detail = err.response?.data;
    console.error(`Zoho API error [${method.toUpperCase()} ${path}]:`, JSON.stringify(detail || err.message));
    throw err;
  }
}

// Find or create a contact in Zoho Books by email
async function findOrCreateContact(name, email, phone) {
  if (!email) return null;
  try {
    // Try to create — if duplicate, Zoho returns existing contact_id in error message
    const created = await zoho('post', '/contacts', {
      contact_name: name || email,
      contact_type: 'customer',
      email_address: email,
      mobile: phone || '',
    });
    return created.contact?.contact_id || null;
  } catch (e) {
    // If duplicate contact exists, Zoho returns the existing contact_id in the error
    const existingId = e.response?.data?.contact_id;
    if (existingId) return existingId;
    console.warn('Zoho contact create failed:', e.response?.data?.message || e.message);
    return null;
  }
}

// Create an invoice in Zoho Books for a webstore order
async function createInvoice(order) {
  const { customer = {}, items = [], shipping, total, orderNo, date } = order;

  const contactId = await findOrCreateContact(customer.name, customer.email, customer.phone);

  // Line items — Zoho calculates item_total from rate × quantity, don't send item_total
  const lineItems = (items || []).map(i => ({
    name:     i.name || 'Product',
    quantity: parseFloat(i.qty) || 1,
    rate:     parseFloat(i.price) || 0,
  }));

  const payload = {
    invoice_number:   orderNo,
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
  const methodMap = { upi: 'Cash', card: 'CreditCard', online: 'Cash' };
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

module.exports = { createInvoice, recordPayment, findOrCreateContact };
