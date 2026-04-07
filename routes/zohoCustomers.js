const express = require('express');
const router  = express.Router();
const { auth } = require('../middleware/auth');
const axios   = require('axios');

const TOKEN_URL = 'https://accounts.zoho.in/oauth/v2/token';
const API_BASE  = 'https://www.zohoapis.in/books/v3';
const ORG_ID    = () => process.env.ZOHO_ORG_ID;

let _accessToken = null;
let _tokenExpiry = 0;

async function getToken() {
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

async function zohoGet(path, params = {}) {
  const token = await getToken();
  const res = await axios.get(`${API_BASE}${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { organization_id: ORG_ID(), ...params },
  });
  return res.data;
}

// GET /api/zoho-customers/local — list all customers from Supabase DB
router.get('/local', auth, async (req, res) => {
  const supabase = require('../config/supabase');
  const { data, error } = await supabase.from('customers')
    .select('id,name,email,phone,city,state,created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /api/zoho-customers — fetch all customers from Zoho Books (paginated)
router.get('/', auth, async (req, res) => {
  try {
    const page    = parseInt(req.query.page) || 1;
    const search  = req.query.search || '';
    const params  = { page, per_page: 200, contact_type: 'customer' };
    if (search) params.search_text = search;

    const data = await zohoGet('/contacts', params);
    const contacts = (data.contacts || []).map(c => ({
      id:           c.contact_id,
      name:         c.contact_name,
      email:        c.email,
      phone:        c.mobile || c.phone,
      company:      c.company_name || '',
      status:       c.status,
      balance:      c.balance || 0,
      currency:     c.currency_code || 'INR',
      outstanding:  c.outstanding_receivable_amount || 0,
      created:      c.created_time,
      gst:          c.gst_no || '',
    }));

    res.json({
      customers: contacts,
      page_context: data.page_context || {},
      total: data.page_context?.total || contacts.length,
    });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    res.status(500).json({ error: 'Zoho API error: ' + msg });
  }
});

// POST /api/zoho-customers/sync — import customers from Zoho Books invoices
router.post('/sync', auth, async (req, res) => {
  const supabase = require('../config/supabase');
  let page = 1, total = 0, inserted = 0, updated = 0, errors = [];
  const seen = new Set();
  try {
    while (true) {
      // Pull from invoices — these have customer_name + email embedded
      const data = await zohoGet('/invoices', { page, per_page: 200, sort_column: 'created_time', sort_order: 'D' });
      const invoices = data.invoices || [];
      if (invoices.length === 0) break;

      for (const inv of invoices) {
        const email = (inv.email || '').toLowerCase().trim();
        const name  = inv.customer_name || inv.company_name || '';
        const phone = inv.phone || '';
        if (!email || seen.has(email)) continue;
        seen.add(email);

        const record = { name: name || email, email, phone: phone || null };
        try {
          const { data: existing } = await supabase.from('customers').select('id').eq('email', email).maybeSingle();
          if (existing) {
            await supabase.from('customers').update({ name: record.name, ...(phone ? { phone } : {}) }).eq('id', existing.id);
            updated++;
          } else {
            await supabase.from('customers').insert(record);
            inserted++;
          }
          total++;
        } catch (e) { errors.push(email + ': ' + e.message); }
      }

      if (!data.page_context?.has_more_page) break;
      page++;
    }
    res.json({ ok: true, total, inserted, updated, errors: errors.slice(0, 20) });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    res.status(500).json({ error: 'Zoho sync error: ' + msg });
  }
});

// GET /api/zoho-customers/:id — single customer detail with recent invoices
router.get('/:id', auth, async (req, res) => {
  try {
    const [contactData, invoicesData] = await Promise.all([
      zohoGet(`/contacts/${req.params.id}`),
      zohoGet('/invoices', { customer_id: req.params.id, per_page: 20, sort_column: 'date', sort_order: 'D' }),
    ]);
    res.json({
      customer: contactData.contact,
      invoices: invoicesData.invoices || [],
    });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    res.status(500).json({ error: 'Zoho API error: ' + msg });
  }
});

module.exports = router;
