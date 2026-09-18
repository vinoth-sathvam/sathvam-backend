const express = require('express');
const router  = express.Router();
const { auth } = require('../middleware/auth');
const { zohoGet } = require('../config/zoho');

// GET /api/zoho-customers/local — list all customers from Supabase DB
router.get('/local', auth, async (req, res) => {
  const supabase = require('../config/supabase');
  const { decryptCustomer } = require('../config/crypto');
  const { data, error } = await supabase.from('customers')
    .select('id,name,email,phone,city,state,created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json((data || []).map(c => decryptCustomer(c)));
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
