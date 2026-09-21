const express = require('express');
const router  = express.Router();
const { auth, requireRole } = require('../middleware/auth');
const { zoho, zohoGet, findOrCreateContact } = require('../config/zoho');
const supabase = require('../config/supabase');
const { decryptCustomer, decrypt } = require('../config/crypto');

// ── GST Filing via Zoho Books API ─────────────────────────────────────────────
// Zoho Books GST API docs: https://www.zoho.com/books/api/v3/gst/
// Returns: /gstreturns for GSTR-1 / GSTR-3B filing status and submission
// GSTN communication goes through Zoho Books (which acts as GSP proxy)

const OWN_GSTIN = '33ABFCS9387K1ZN';
const ORG_ID    = () => process.env.ZOHO_ORG_ID;
const round2    = n => Math.round((n || 0) * 100) / 100;

// ── Helpers ──────────────────────────────────────────────────────────────────

// Get ISO date range for a month
function periodRange(year, month) {
  const y  = parseInt(year)  || new Date().getFullYear();
  const m  = parseInt(month) || (new Date().getMonth() + 1);
  const start   = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end     = `${y}-${String(m).padStart(2, '0')}-${lastDay}`;
  // Zoho uses MMYYYY format for return_period
  const period  = String(m).padStart(2, '0') + String(y);
  return { y, m, start, end, period };
}

// Save one entry at the front of the filing history (settings table, capped at 100)
async function saveFilingHistory(entry) {
  try {
    const { data } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'gst_filing_history')
      .maybeSingle();
    const history = Array.isArray(data?.value) ? data.value : [];
    history.unshift({ ...entry, timestamp: new Date().toISOString() });
    if (history.length > 100) history.length = 100;
    await supabase.from('settings').upsert({
      key:        'gst_filing_history',
      value:      history,
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[gst-filing] saveFilingHistory error:', e.message);
  }
}

// Load all challans from settings
async function loadChallans() {
  const { data } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'gst_challans')
    .maybeSingle();
  const v = data?.value;
  return Array.isArray(v) ? v : [];
}

// Persist challans array back to settings
async function saveChallans(challans) {
  await supabase.from('settings').upsert({
    key:        'gst_challans',
    value:      challans,
    updated_at: new Date().toISOString(),
  });
}

// Check Zoho is configured — returns 503 if not
function requireZoho(res) {
  if (!ORG_ID() || !process.env.ZOHO_CLIENT_ID) {
    res.status(503).json({ error: 'Zoho Books not configured. Set ZOHO_ORG_ID, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN in .env' });
    return false;
  }
  return true;
}

// Silent Zoho call — catches errors instead of retrying + alerting via WhatsApp.
// Use for GST endpoints that may not exist in all Zoho plans.
async function zohoSilent(method, path, data, params) {
  try {
    return await zoho(method, path, data, params);
  } catch (e) {
    // Suppress — the main zoho() already logged + alerted; we just return null
    return null;
  }
}

// Even quieter — bypasses zoho() entirely to avoid retries + WA alerts.
// Uses axios directly with a single attempt.
async function zohoQuiet(method, path, data, extraParams = {}) {
  try {
    const { getAccessToken: getToken } = require('../config/zoho');
    const axios = require('axios');
    const token = await getToken();
    const res = await axios({
      method,
      url: 'https://www.zohoapis.in/books/v3' + path,
      headers: { Authorization: 'Zoho-oauthtoken ' + token },
      params: { organization_id: ORG_ID(), ...extraParams },
      data,
      timeout: 15000,
    });
    return res.data;
  } catch (e) {
    // Single attempt, no retries, no WA alert
    return null;
  }
}

// ── 1. GET /status — GSTR-1 + GSTR-3B status for a period ───────────────────
router.get('/status', auth, async (req, res) => {
  try {
    if (!requireZoho(res)) return;
    const { year, month } = req.query;
    const { start, end, period } = periodRange(year, month);

    // Parallel: fetch GSTR-1 and GSTR-3B status from Zoho
    const params = { organization_id: ORG_ID(), from_date: start, to_date: end };

    const [gstr1Res, gstr3bRes, historyRow] = await Promise.allSettled([
      zoho('get', '/gstreturn', null, { ...params, return_type: 'gstr1' }),
      zoho('get', '/gstreturn', null, { ...params, return_type: 'gstr3b' }),
      supabase.from('settings').select('value').eq('key', 'gst_filing_history').maybeSingle(),
    ]);

    const gstr1Data  = gstr1Res.status  === 'fulfilled' ? gstr1Res.value  : null;
    const gstr3bData = gstr3bRes.status === 'fulfilled' ? gstr3bRes.value : null;
    const history    = historyRow.status === 'fulfilled'
      ? (Array.isArray(historyRow.value?.data?.value) ? historyRow.value.data.value : [])
      : [];

    // Normalize status — Zoho returns arrays; pick the matching period's record
    const pickReturn = (data, rtype) => {
      const list = data?.gst_returns || (data?.gstreturn ? [data.gstreturn] : []);
      return list.find(r => r.return_period === period || r.filing_period === period) || list[0] || null;
    };

    const gstr1  = pickReturn(gstr1Data, 'gstr1');
    const gstr3b = pickReturn(gstr3bData, 'gstr3b');

    // Also filter history by this period
    const periodHistory = history.filter(h => h.period === period);

    res.json({
      period,
      from_date: start,
      to_date:   end,
      gstr1: {
        status:       gstr1?.status || 'not_created',
        return_id:    gstr1?.return_id || null,
        submitted_at: gstr1?.submitted_at || null,
        filed_at:     gstr1?.filed_at || null,
        zoho_raw:     gstr1 || null,
      },
      gstr3b: {
        status:       gstr3b?.status || 'not_created',
        return_id:    gstr3b?.return_id || null,
        submitted_at: gstr3b?.submitted_at || null,
        filed_at:     gstr3b?.filed_at || null,
        zoho_raw:     gstr3b || null,
      },
      filing_history: periodHistory,
    });
  } catch (e) {
    console.error('[gst-filing] /status error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── 2. POST /sync-invoices — Sync missing invoices to Zoho Books ─────────────
router.post('/sync-invoices', auth, requireRole('admin', 'ceo'), async (req, res) => {
  try {
    if (!requireZoho(res)) return;
    const { year, month } = req.body;
    const { start, end } = periodRange(year, month);

    // Fetch local orders for the period
    const [wsRes, salesRes, b2bRes] = await Promise.all([
      supabase.from('webstore_orders')
        .select('id, order_no, date, customer, items, total, shipping, payment_id, payment_status')
        .gte('date', start).lte('date', end)
        .neq('payment_status', 'failed'),
      supabase.from('sales')
        .select('id, order_no, date, customer_name, items, final_amount')
        .gte('date', start).lte('date', end),
      supabase.from('b2b_orders')
        .select('id, order_no, created_at, customer_name, items, total_value')
        .gte('created_at', start + 'T00:00:00').lte('created_at', end + 'T23:59:59'),
    ]);

    const wsOrders   = wsRes.data   || [];
    const salesOrders = salesRes.data || [];
    const b2bOrders  = b2bRes.data  || [];

    // Fetch existing Zoho invoices for the period to avoid duplication
    let zohoInvoices = [];
    try {
      const ziRes = await zoho('get', '/invoices', null, {
        organization_id: ORG_ID(),
        date_start: start,
        date_end:   end,
        per_page:   200,
      });
      zohoInvoices = ziRes?.invoices || [];
    } catch (e) {
      console.warn('[gst-filing] Could not fetch Zoho invoices:', e.message);
    }
    const zohoRefs = new Set(zohoInvoices.map(i => i.reference_number).filter(Boolean));

    let synced = 0, skipped = 0, failed = 0;
    const errors = [];

    // Sync webstore orders
    for (const order of wsOrders) {
      if (zohoRefs.has(order.order_no)) { skipped++; continue; }
      try {
        let customer = {};
        try { customer = typeof order.customer === 'string' ? JSON.parse(order.customer) : (order.customer || {}); } catch (_) {}
        // Decrypt PII fields (name, email, phone etc may be AES-256-GCM encrypted)
        customer = decryptCustomer(customer);
        const custName = (customer.name && !customer.name.startsWith('ENC:')) ? customer.name : 'Guest Customer';
        const custEmail = (customer.email && !customer.email.startsWith('ENC:')) ? customer.email : null;
        const custPhone = (customer.phone && !customer.phone.startsWith('ENC:')) ? customer.phone : null;
        // Create/find contact in Zoho first
        const contactId = await findOrCreateContact(custName, custEmail, custPhone);
        const lineItems = (order.items || []).map(it => ({
          name:     it.name || 'Product',
          quantity: parseFloat(it.qty) || 1,
          rate:     parseFloat(it.price) || 0,
        }));
        await zoho('post', '/invoices', {
          reference_number: order.order_no,
          invoice_number:   (order.order_no || '').slice(0, 16),
          date:             order.date || start,
          ...(contactId ? { customer_id: contactId } : { customer_name: custName }),
          line_items:       lineItems,
          shipping_charge:  parseFloat(order.shipping) || 0,
          notes:            `Synced from sathvam.in — ${order.order_no}`,
        });
        synced++;
      } catch (e) {
        failed++;
        errors.push({ order_no: order.order_no, error: e.response?.data?.message || e.message });
      }
    }

    // Sync POS sales
    for (const sale of salesOrders) {
      if (zohoRefs.has(sale.order_no)) { skipped++; continue; }
      try {
        // Decrypt customer_name (may be AES-256-GCM encrypted)
        let custName = decrypt(sale.customer_name) || sale.customer_name || '';
        if (!custName || custName.startsWith('ENC:')) custName = 'Walk-in Customer';
        // Create/find contact in Zoho
        const contactId = await findOrCreateContact(custName, null, null);
        const lineItems = (sale.items || []).map(it => ({
          name:     it.name || it.productName || it.product_name || 'Product',
          quantity: parseFloat(it.qty) || 1,
          rate:     parseFloat(it.price || it.rate) || 0,
        }));
        await zoho('post', '/invoices', {
          reference_number: sale.order_no,
          invoice_number:   (sale.order_no || '').slice(0, 16),
          date:             sale.date || start,
          ...(contactId ? { customer_id: contactId } : { customer_name: custName }),
          line_items:       lineItems.length ? lineItems : [{ name: 'Sale', quantity: 1, rate: parseFloat(sale.final_amount) || 0 }],
          notes:            `POS Sale — ${sale.order_no}`,
        });
        synced++;
      } catch (e) {
        failed++;
        errors.push({ order_no: sale.order_no, error: e.response?.data?.message || e.message });
      }
    }

    // Sync B2B orders
    for (const order of b2bOrders) {
      if (zohoRefs.has(order.order_no)) { skipped++; continue; }
      try {
        const b2bCustName = order.customer_name || 'B2B Customer';
        const b2bContactId = await findOrCreateContact(b2bCustName, null, null);
        const lineItems = (order.items || []).map(it => ({
          name:     it.name || 'Product',
          quantity: parseFloat(it.qty) || 1,
          rate:     parseFloat(it.rate || it.price) || 0,
        }));
        await zoho('post', '/invoices', {
          reference_number: order.order_no,
          invoice_number:   (order.order_no || '').slice(0, 16),
          date:             (order.created_at || start).slice(0, 10),
          ...(b2bContactId ? { customer_id: b2bContactId } : { customer_name: b2bCustName }),
          line_items:       lineItems.length ? lineItems : [{ name: 'B2B Order', quantity: 1, rate: parseFloat(order.total_value) || 0 }],
          notes:            `B2B Order — ${order.order_no}`,
        });
        synced++;
      } catch (e) {
        failed++;
        errors.push({ order_no: order.order_no, error: e.response?.data?.message || e.message });
      }
    }

    res.json({
      ok: true,
      period: { start, end },
      total_local:  wsOrders.length + salesOrders.length + b2bOrders.length,
      synced,
      skipped,
      failed,
      errors: errors.slice(0, 20), // cap to avoid huge responses
    });
  } catch (e) {
    console.error('[gst-filing] /sync-invoices error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── 3. POST /prepare-gstr1 — Prepare GSTR-1 return in Zoho ─────────────────
router.post('/prepare-gstr1', auth, requireRole('admin', 'ceo'), async (req, res) => {
  try {
    if (!requireZoho(res)) return;
    const { year, month } = req.body;
    const { start, end, period } = periodRange(year, month);

    // Check if a GSTR-1 return already exists
    let existingReturn = null;
    try {
      const listRes = await zohoQuiet('get', '/gstreturn', null, {
        organization_id: ORG_ID(),
        return_type:     'gstr1',
        from_date:       start,
        to_date:         end,
      });
      const list = listRes?.gst_returns || (listRes?.gstreturn ? [listRes.gstreturn] : []);
      existingReturn = list.find(r => r.return_period === period || r.filing_period === period) || null;
    } catch (e) {
      console.warn('[gst-filing] GSTR-1 fetch error:', e.message);
    }

    let returnData = existingReturn;

    // If not created yet, ask Zoho to create/prepare it
    if (!existingReturn) {
      try {
        const createRes = await zohoQuiet('post', '/gstreturn', {
          return_type:   'gstr1',
          return_period: period,
        });
        returnData = createRes?.gstreturn || createRes?.gst_returns?.[0] || null;
      } catch (e) {
        // Zoho may not support creating returns via API — that's OK
        const errMsg = e.response?.data?.message || e.message || '';
        console.warn('[gst-filing] GSTR-1 create not supported via API:', errMsg);
        returnData = e.response?.data?.gstreturn || null;
      }
    }

    await saveFilingHistory({ action: 'prepare', return_type: 'gstr1', period, status: returnData?.status || 'prepared', user: req.user?.username });

    res.json({
      ok:          true,
      period,
      return_type: 'gstr1',
      status:      returnData?.status || 'prepared',
      return_id:   returnData?.return_id || null,
      zoho_data:   returnData,
      message:     returnData
        ? 'GSTR-1 is ready in Zoho Books. Review and file from Zoho Books → Accountant → GST Returns → GSTR-1.'
        : 'GSTR-1 data is computed from your invoices. Open Zoho Books → Accountant → GST Returns to review and file. Ensure all invoices are synced first.',
      zoho_url:    'https://books.zoho.in/',
    });
  } catch (e) {
    console.error('[gst-filing] /prepare-gstr1 error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── 4. POST /prepare-gstr3b — Prepare GSTR-3B in Zoho + local computation ───
router.post('/prepare-gstr3b', auth, requireRole('admin', 'ceo'), async (req, res) => {
  try {
    if (!requireZoho(res)) return;
    const { year, month } = req.body;
    const { start, end, period } = periodRange(year, month);

    // Try to fetch/create GSTR-3B in Zoho
    let returnData = null;
    try {
      const listRes = await zohoQuiet('get', '/gstreturn', null, {
        organization_id: ORG_ID(),
        return_type:     'gstr3b',
        from_date:       start,
        to_date:         end,
      });
      const list = listRes?.gst_returns || (listRes?.gstreturn ? [listRes.gstreturn] : []);
      returnData = list.find(r => r.return_period === period || r.filing_period === period) || null;
    } catch (e) {
      console.warn('[gst-filing] GSTR-3B Zoho fetch error:', e.message);
    }

    if (!returnData) {
      try {
        const createRes = await zohoQuiet('post', '/gstreturn', {
          return_type:   'gstr3b',
          return_period: period,
        });
        returnData = createRes?.gstreturn || createRes?.gst_returns?.[0] || null;
      } catch (e) {
        console.warn('[gst-filing] GSTR-3B create not supported via API:', e.response?.data?.message || e.message);
        returnData = e.response?.data?.gstreturn || null;
      }
    }

    // Local computation: outward tax from webstore_orders + sales
    const [wsRes, salesRes, billsRes] = await Promise.all([
      supabase.from('webstore_orders')
        .select('gst_amount, subtotal, total, shipping')
        .gte('date', start).lte('date', end)
        .eq('payment_status', 'paid'),
      supabase.from('sales')
        .select('gst_amount, final_amount')
        .gte('date', start).lte('date', end),
      supabase.from('vendor_bills')
        .select('gst_amount, amount, status')
        .gte('bill_date', start).lte('bill_date', end),
    ]);

    const wsOrders  = wsRes.data   || [];
    const salesRows = salesRes.data || [];
    const bills     = billsRes.data || [];

    // Table 3.1 — Outward taxable supplies
    const outwardTax = round2(
      wsOrders.reduce((s, o) => s + (parseFloat(o.gst_amount) || 0), 0) +
      salesRows.reduce((s, o) => s + (parseFloat(o.gst_amount) || 0), 0)
    );
    const outwardTaxable = round2(
      wsOrders.reduce((s, o) => s + (parseFloat(o.subtotal) || 0), 0) +
      salesRows.reduce((s, o) => s + (parseFloat(o.final_amount) || 0) - (parseFloat(o.gst_amount) || 0), 0)
    );

    // Table 4 — ITC available (from vendor bills with GST)
    const itcEligible = round2(bills.reduce((s, b) => s + (parseFloat(b.gst_amount) || 0), 0));

    // Net payable (simplified — CGST + SGST split evenly for TN intra-state)
    const cgst = round2(outwardTax / 2);
    const sgst = round2(outwardTax / 2);
    const netPayable = round2(Math.max(0, outwardTax - itcEligible));

    res.json({
      ok:          true,
      period,
      return_type: 'gstr3b',
      status:      returnData?.status || 'prepared',
      return_id:   returnData?.return_id || null,
      zoho_data:   returnData,
      local_summary: {
        table_3_1: {
          label:            'Outward taxable supplies (other than zero rated, nil rated and exempted)',
          total_taxable:    outwardTaxable,
          integrated_tax:   0,
          central_tax:      cgst,
          state_ut_tax:     sgst,
          cess:             0,
        },
        table_4: {
          label:     'Eligible ITC',
          itc_cgst:  round2(itcEligible / 2),
          itc_sgst:  round2(itcEligible / 2),
          itc_igst:  0,
          itc_total: itcEligible,
        },
        table_6: {
          label:            'Payment of tax',
          net_payable_cgst: round2(netPayable / 2),
          net_payable_sgst: round2(netPayable / 2),
          net_payable_igst: 0,
          net_total:        netPayable,
        },
      },
      message: 'Review in Zoho Books before filing. Navigate to Accountant → GST Returns → GSTR-3B.',
      zoho_url: 'https://books.zoho.in/',
    });
  } catch (e) {
    console.error('[gst-filing] /prepare-gstr3b error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── 5. POST /file-gstr1 — Submit GSTR-1 to GSTN via Zoho ───────────────────
router.post('/file-gstr1', auth, requireRole('admin'), async (req, res) => {
  try {
    if (!requireZoho(res)) return;
    const { year, month } = req.body;
    const { start, end, period } = periodRange(year, month);

    // Find GSTR-1 return_id in Zoho
    const listRes = await zohoQuiet('get', '/gstreturn', null, {
      organization_id: ORG_ID(),
      return_type:     'gstr1',
      from_date:       start,
      to_date:         end,
    });
    const list = listRes?.gst_returns || (listRes?.gstreturn ? [listRes.gstreturn] : []);
    const ret  = list.find(r => r.return_period === period || r.filing_period === period);

    if (!ret?.return_id) {
      return res.status(400).json({ error: 'GSTR-1 return not found in Zoho. Run /prepare-gstr1 first.' });
    }

    if (['submitted', 'filed'].includes(ret.status)) {
      return res.status(400).json({ error: `GSTR-1 already ${ret.status} for period ${period}.` });
    }

    // Submit to GSTN via Zoho
    const submitRes = await zohoQuiet('post', `/gstreturn/${ret.return_id}/submit`, {});
    const result    = submitRes?.gstreturn || submitRes;

    // Zoho may return a redirect_url for OTP on GSTN portal
    const otp_url = result?.redirect_url || result?.otp_url || null;

    await saveFilingHistory({
      type:      'gstr1',
      period,
      return_id: ret.return_id,
      status:    result?.status || 'submitted',
      filed_by:  req.user?.name || req.user?.username,
      otp_url,
    });

    res.json({
      ok:        true,
      period,
      return_id: ret.return_id,
      status:    result?.status || 'submitted',
      otp_url,
      message:   otp_url
        ? 'OTP verification required on GSTN portal. Open the URL to complete filing.'
        : 'GSTR-1 submitted successfully.',
      zoho_data: result,
    });
  } catch (e) {
    console.error('[gst-filing] /file-gstr1 error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── 6. POST /file-gstr3b — Submit GSTR-3B to GSTN via Zoho ─────────────────
router.post('/file-gstr3b', auth, requireRole('admin'), async (req, res) => {
  try {
    if (!requireZoho(res)) return;
    const { year, month } = req.body;
    const { start, end, period } = periodRange(year, month);

    const listRes = await zohoQuiet('get', '/gstreturn', null, {
      organization_id: ORG_ID(),
      return_type:     'gstr3b',
      from_date:       start,
      to_date:         end,
    });
    const list = listRes?.gst_returns || (listRes?.gstreturn ? [listRes.gstreturn] : []);
    const ret  = list.find(r => r.return_period === period || r.filing_period === period);

    if (!ret?.return_id) {
      return res.status(400).json({ error: 'GSTR-3B return not found in Zoho. Run /prepare-gstr3b first.' });
    }
    if (['submitted', 'filed'].includes(ret.status)) {
      return res.status(400).json({ error: `GSTR-3B already ${ret.status} for period ${period}.` });
    }

    const submitRes = await zohoQuiet('post', `/gstreturn/${ret.return_id}/submit`, {});
    const result    = submitRes?.gstreturn || submitRes;
    const otp_url   = result?.redirect_url || result?.otp_url || null;

    await saveFilingHistory({
      type:      'gstr3b',
      period,
      return_id: ret.return_id,
      status:    result?.status || 'submitted',
      filed_by:  req.user?.name || req.user?.username,
      otp_url,
    });

    res.json({
      ok:        true,
      period,
      return_id: ret.return_id,
      status:    result?.status || 'submitted',
      otp_url,
      message:   otp_url
        ? 'OTP verification required on GSTN portal. Open the URL to complete filing.'
        : 'GSTR-3B submitted successfully.',
      zoho_data: result,
    });
  } catch (e) {
    console.error('[gst-filing] /file-gstr3b error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── 7. GET /gstr2a/:period — GSTR-2A from supplier filings ──────────────────
router.get('/gstr2a/:period', auth, async (req, res) => {
  try {
    if (!requireZoho(res)) return;
    const { period } = req.params; // MMYYYY format e.g. "092026"

    // Zoho Books GST APIs — try multiple known endpoint patterns
    let data = null;
    const endpoints = [
      { path: '/gstreturn', params: { return_type: 'gstr2a', return_period: period } },
      { path: '/gstreturn', params: { return_type: 'purchase', return_period: period } },
    ];

    for (const ep of endpoints) {
      try {
        data = await zohoQuiet('get', ep.path, null, { organization_id: ORG_ID(), ...ep.params });
        if (data) break;
      } catch (e) {
        // Try next endpoint
      }
    }

    // If Zoho doesn't support direct 2A fetch, build from vendor bills
    if (!data || data?.code === 5) {
      // Fallback: build ITC summary from local vendor bills for the period
      const m = parseInt(period.slice(0, 2));
      const y = parseInt(period.slice(2));
      const { start, end } = periodRange(y, m);

      const { data: bills } = await supabase
        .from('vendor_bills')
        .select('vendor_name, bill_no, bill_date, amount, gst_amount, vendor_gstin')
        .gte('bill_date', start).lte('bill_date', end)
        .is('deleted_at', null);

      const { data: procs } = await supabase
        .from('procurements')
        .select('supplier, invoice_no, order_date, ordered_qty, ordered_price_per_kg, gst, vendor_gstin')
        .gte('order_date', start).lte('order_date', end);

      // Group by vendor GSTIN
      const byGstin = {};
      for (const b of (bills || [])) {
        const gstin = b.vendor_gstin || 'UNREGISTERED';
        if (!byGstin[gstin]) byGstin[gstin] = { ctin: gstin, supplier_name: b.vendor_name, invoices: [], taxable: 0, cgst: 0, sgst: 0, igst: 0 };
        const gst = parseFloat(b.gst_amount) || 0;
        const taxable = parseFloat(b.amount) || 0;
        byGstin[gstin].invoices.push({ bill_no: b.bill_no, date: b.bill_date, taxable, gst });
        byGstin[gstin].taxable += taxable;
        byGstin[gstin].cgst += gst / 2;
        byGstin[gstin].sgst += gst / 2;
      }
      for (const p of (procs || [])) {
        const gstin = p.vendor_gstin || 'UNREGISTERED';
        if (!byGstin[gstin]) byGstin[gstin] = { ctin: gstin, supplier_name: p.supplier, invoices: [], taxable: 0, cgst: 0, sgst: 0, igst: 0 };
        const base = (parseFloat(p.ordered_qty) || 0) * (parseFloat(p.ordered_price_per_kg) || 0);
        const gst = base * (parseFloat(p.gst) || 0) / 100;
        byGstin[gstin].invoices.push({ bill_no: p.invoice_no, date: p.order_date, taxable: base, gst });
        byGstin[gstin].taxable += base;
        byGstin[gstin].cgst += gst / 2;
        byGstin[gstin].sgst += gst / 2;
      }

      const b2b = Object.values(byGstin).map(v => ({ ...v, inv_count: v.invoices.length }));
      const totalTaxable = b2b.reduce((s, v) => s + v.taxable, 0);
      const totalCgst = b2b.reduce((s, v) => s + v.cgst, 0);
      const totalSgst = b2b.reduce((s, v) => s + v.sgst, 0);

      return res.json({
        period,
        source: 'Local books (GSTR-2A not available from Zoho — showing local purchase register)',
        b2b,
        summary: {
          total_suppliers: b2b.length,
          total_invoices: b2b.reduce((s, v) => s + v.inv_count, 0),
          total_taxable: round2(totalTaxable),
          total_cgst: round2(totalCgst),
          total_sgst: round2(totalSgst),
          total_igst: 0,
        },
      });
    }

    // Parse Zoho response
    const returns = data?.gst_returns || (data?.gstreturn ? [data.gstreturn] : []);
    const b2b = returns.flatMap(r => r.b2b || []);

    res.json({
      period,
      source: 'GSTR-2A (from Zoho Books / GSTN)',
      b2b,
      summary: {
        total_suppliers: b2b.length,
        total_invoices: b2b.reduce((s, v) => s + (v.inv_count || v.invoices?.length || 0), 0),
        total_taxable: round2(b2b.reduce((s, v) => s + (v.taxable || 0), 0)),
        total_cgst: round2(b2b.reduce((s, v) => s + (v.cgst || 0), 0)),
        total_sgst: round2(b2b.reduce((s, v) => s + (v.sgst || 0), 0)),
        total_igst: round2(b2b.reduce((s, v) => s + (v.igst || 0), 0)),
      },
    });
  } catch (e) {
    console.error('[gst-filing] /gstr2a error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── 8. GET /gstr2b/:period — GSTR-2B (locked ITC statement) ─────────────────
router.get('/gstr2b/:period', auth, async (req, res) => {
  try {
    if (!requireZoho(res)) return;
    const { period } = req.params;

    // Try Zoho endpoint — may not be available for all plans
    let data = null;
    try {
      data = await zohoQuiet('get', '/gstreturn', null, {
        organization_id: ORG_ID(),
        return_type:     'gstr2b',
        return_period:   period,
      });
    } catch (e) {
      // Zoho may not support GSTR-2B fetch — return summary from local data
    }

    if (!data || data?.code === 5) {
      // Fallback: compute from local purchase data
      const m = parseInt(period.slice(0, 2));
      const y = parseInt(period.slice(2));
      const { start, end } = periodRange(y, m);

      const { data: bills } = await supabase
        .from('vendor_bills')
        .select('amount, gst_amount')
        .gte('bill_date', start).lte('bill_date', end)
        .is('deleted_at', null);

      const { data: procs } = await supabase
        .from('procurements')
        .select('ordered_qty, ordered_price_per_kg, gst')
        .gte('order_date', start).lte('order_date', end);

      let totalGst = (bills || []).reduce((s, b) => s + (parseFloat(b.gst_amount) || 0), 0);
      totalGst += (procs || []).reduce((s, p) => {
        const base = (parseFloat(p.ordered_qty) || 0) * (parseFloat(p.ordered_price_per_kg) || 0);
        return s + base * (parseFloat(p.gst) || 0) / 100;
      }, 0);

      return res.json({
        period,
        source: 'Local books (GSTR-2B not available from Zoho)',
        summary: {
          available_itc: round2(totalGst),
          ineligible_itc: 0,
        },
        message: 'GSTR-2B is auto-generated by GSTN. Check the GST portal for the official 2B statement. Local ITC shown from your purchase register.',
      });
    }

    const returns = data?.gst_returns || (data?.gstreturn ? [data.gstreturn] : []);
    const totalITC = returns.reduce((s, r) => s + (r.itc_available?.total || 0), 0);

    res.json({
      period,
      source: 'GSTR-2B (from Zoho Books / GSTN)',
      summary: {
        available_itc: round2(totalITC),
        ineligible_itc: 0,
      },
      raw: data,
    });
  } catch (e) {
    console.error('[gst-filing] /gstr2b error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── 9. GET /itc-reconciliation — Compare local books vs GSTR-2A ─────────────
router.get('/itc-reconciliation', auth, async (req, res) => {
  try {
    if (!requireZoho(res)) return;
    const { year, month } = req.query;
    const { start, end, period } = periodRange(year, month);

    // Parallel: GSTR-2A from Zoho + local purchases from DB
    const [gstr2aRes, billsRes, expRes] = await Promise.allSettled([
      zoho('get', '/gstreturn', null, { organization_id: ORG_ID(), return_type: 'gstr2a', return_period: period }).catch(() => null),
      supabase.from('vendor_bills')
        .select('id, vendor_name, bill_no, bill_date, amount, gst_amount, status')
        .gte('bill_date', start).lte('bill_date', end),
      supabase.from('company_expenses')
        .select('id, category, description, date, amount, gst_amount, vendor')
        .gte('date', start).lte('date', end)
        .gt('gst_amount', 0),
    ]);

    const gstr2aData = gstr2aRes.status === 'fulfilled' ? gstr2aRes.value : null;
    const bills      = billsRes.status  === 'fulfilled' ? (billsRes.value?.data || []) : [];
    const expenses   = expRes.status    === 'fulfilled' ? (expRes.value?.data   || []) : [];

    // Build GSTIN-keyed map from GSTR-2A
    const gstr2aMap = {}; // gstin → { taxable, igst, cgst, sgst }
    if (gstr2aData) {
      const suppliers = gstr2aData?.b2b || gstr2aData?.gstr2a?.b2b || [];
      for (const sup of suppliers) {
        const gstin = sup.ctin || sup.gstin;
        if (!gstin) continue;
        const invs = sup.inv || sup.invoices || [];
        const totals = invs.reduce((acc, inv) => {
          const items = inv.itms || inv.items || [];
          items.forEach(it => {
            const d = it.itm_det || it;
            acc.taxable += d.txval  || 0;
            acc.igst    += d.igst   || 0;
            acc.cgst    += d.camt   || d.cgst || 0;
            acc.sgst    += d.samt   || d.sgst || 0;
          });
          return acc;
        }, { taxable: 0, igst: 0, cgst: 0, sgst: 0 });
        gstr2aMap[gstin] = { ...totals, invoice_count: invs.length };
      }
    }

    // Local purchases total
    const localTotal = round2(bills.reduce((s, b) => s + (parseFloat(b.gst_amount) || 0), 0) +
                               expenses.reduce((s, e) => s + (parseFloat(e.gst_amount) || 0), 0));
    const gstr2aTotal = round2(Object.values(gstr2aMap).reduce((s, v) => s + v.igst + v.cgst + v.sgst, 0));

    // Mismatch: in 2A but no matching local bill
    const inGstr2aNotLocal = Object.entries(gstr2aMap)
      .filter(([gstin]) => !bills.some(b => b.vendor_gstin === gstin))
      .map(([gstin, v]) => ({ gstin, source: 'gstr2a_only', ...v }));

    // Local bills with a GSTIN that didn't appear in 2A
    const billsWithGstin = bills.filter(b => b.vendor_gstin);
    const inLocalNotGstr2a = billsWithGstin
      .filter(b => !gstr2aMap[b.vendor_gstin])
      .map(b => ({
        bill_no:   b.bill_no,
        vendor:    b.vendor_name,
        gstin:     b.vendor_gstin,
        gst_amount: parseFloat(b.gst_amount) || 0,
        source:    'local_only',
      }));

    res.json({
      period,
      summary: {
        local_itc_total:  localTotal,
        gstr2a_itc_total: gstr2aTotal,
        difference:       round2(gstr2aTotal - localTotal),
      },
      mismatches: {
        in_gstr2a_not_local: inGstr2aNotLocal,
        in_local_not_gstr2a: inLocalNotGstr2a,
      },
      local_books: {
        bill_count:    bills.length,
        expense_count: expenses.length,
        total_gst:     localTotal,
      },
      gstr2a_available: !!gstr2aData,
    });
  } catch (e) {
    console.error('[gst-filing] /itc-reconciliation error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── 10. GET /filing-history — All filing history records ────────────────────
router.get('/filing-history', auth, async (req, res) => {
  try {
    const { data } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'gst_filing_history')
      .maybeSingle();
    const history = Array.isArray(data?.value) ? data.value : [];
    res.json({ history });
  } catch (e) {
    console.error('[gst-filing] /filing-history error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 11. GET /gstr9/:fy — Annual return summary (GSTR-9) ─────────────────────
router.get('/gstr9/:fy', auth, async (req, res) => {
  try {
    const startYear = parseInt(req.params.fy) || new Date().getFullYear();
    // FY: April startYear to March startYear+1
    const months = [];
    for (let m = 4; m <= 12; m++) months.push({ year: startYear,     month: m });
    for (let m = 1; m <= 3;  m++) months.push({ year: startYear + 1, month: m });

    const fy = `${startYear}-${String(startYear + 1).slice(-2)}`; // e.g. "2026-27"

    // Aggregate monthly DB data
    const fyStart = `${startYear}-04-01`;
    const fyEnd   = `${startYear + 1}-03-31`;

    const MONTH_NAMES = ['','January','February','March','April','May','June','July','August','September','October','November','December'];

    const [wsRes, salesRes, billsRes, procRes] = await Promise.all([
      supabase.from('webstore_orders')
        .select('date, subtotal, gst_amount, total, items')
        .gte('date', fyStart).lte('date', fyEnd)
        .eq('payment_status', 'paid'),
      supabase.from('sales')
        .select('date, final_amount, gst_amount')
        .gte('date', fyStart).lte('date', fyEnd),
      supabase.from('vendor_bills')
        .select('bill_date, amount, gst_amount')
        .gte('bill_date', fyStart).lte('bill_date', fyEnd)
        .is('deleted_at', null),
      supabase.from('procurements')
        .select('order_date, ordered_qty, ordered_price_per_kg, gst')
        .gte('order_date', fyStart).lte('order_date', fyEnd),
    ]);

    const wsOrders  = wsRes.data   || [];
    const salesRows = salesRes.data || [];
    const bills     = billsRes.data || [];
    const procs     = procRes.data  || [];

    // Monthly breakdown
    const monthlyData = months.map(({ year: y, month: m }) => {
      const mStr = String(m).padStart(2, '0');
      const prefix = `${y}-${mStr}`;

      const ws     = wsOrders.filter(o => (o.date || '').startsWith(prefix));
      const sal    = salesRows.filter(o => (o.date || '').startsWith(prefix));
      const bl     = bills.filter(b => (b.bill_date || '').startsWith(prefix));
      const pr     = procs.filter(p => (p.order_date || '').startsWith(prefix));

      const wsTaxable = ws.reduce((s, o) => s + (parseFloat(o.subtotal) || 0), 0);
      const salTaxable = sal.reduce((s, o) => s + (parseFloat(o.final_amount) || 0), 0);
      const outGst = round2(ws.reduce((s, o) => s + (parseFloat(o.gst_amount) || 0), 0) +
                             sal.reduce((s, o) => s + (parseFloat(o.gst_amount) || 0), 0));
      const itcBills = round2(bl.reduce((s, b) => s + (parseFloat(b.gst_amount) || 0), 0));
      const itcProcs = round2(pr.reduce((s, p) => {
        const base = (parseFloat(p.ordered_qty) || 0) * (parseFloat(p.ordered_price_per_kg) || 0);
        return s + base * (parseFloat(p.gst) || 0) / 100;
      }, 0));
      const itc = round2(itcBills + itcProcs);
      const taxable = round2(wsTaxable + salTaxable);

      return {
        year: y, month: m, month_name: MONTH_NAMES[m],
        taxable,
        cgst: round2(outGst / 2), sgst: round2(outGst / 2), igst: 0,
        output_gst: outGst,
        itc,
        net_payable: round2(Math.max(0, outGst - itc)),
      };
    });

    const grandTotal = monthlyData.reduce((acc, m) => ({
      taxable:     round2(acc.taxable + m.taxable),
      cgst:        round2(acc.cgst + m.cgst),
      sgst:        round2(acc.sgst + m.sgst),
      igst:        round2(acc.igst + m.igst),
      output_gst:  round2(acc.output_gst + m.output_gst),
      itc:         round2(acc.itc + m.itc),
      net_payable: round2(acc.net_payable + m.net_payable),
    }), { taxable: 0, cgst: 0, sgst: 0, igst: 0, output_gst: 0, itc: 0, net_payable: 0 });

    // HSN summary for the full year (from webstore orders items)
    const hsnMap = {};
    wsOrders.forEach(order => {
      const items = order.items || [];
      items.forEach(it => {
        const hsn = it.hsn || it.hsn_code || 'UNKNOWN';
        if (!hsnMap[hsn]) hsnMap[hsn] = { hsn, desc: it.name || '', qty: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, total: 0 };
        const qty = parseFloat(it.qty) || 1;
        const val = round2((parseFloat(it.price) || 0) * qty);
        const gst = round2(val * (parseFloat(it.gst || 5) / (100 + (parseFloat(it.gst) || 5))));
        const taxable = round2(val - gst);
        hsnMap[hsn].qty      += qty;
        hsnMap[hsn].taxable   = round2(hsnMap[hsn].taxable + taxable);
        hsnMap[hsn].cgst      = round2(hsnMap[hsn].cgst + gst / 2);
        hsnMap[hsn].sgst      = round2(hsnMap[hsn].sgst + gst / 2);
        hsnMap[hsn].total     = round2(hsnMap[hsn].total + val);
      });
    });

    res.json({
      fy,
      gstin:        OWN_GSTIN,
      months:       monthlyData,
      grand_total:  grandTotal,
      hsn_summary:  Object.values(hsnMap).sort((a, b) => b.taxable - a.taxable),
      note:         'This is a local computation for GSTR-9 preparation. File the actual annual return via Zoho Books or GSTN portal.',
    });
  } catch (e) {
    console.error('[gst-filing] /gstr9 error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 12. POST /challans — Create GST payment challan ─────────────────────────
router.post('/challans', auth, requireRole('admin', 'ceo'), async (req, res) => {
  try {
    const { year, month, cgst, sgst, igst, cess, interest, late_fee, payment_mode, bank, reference_no } = req.body;
    if (!year || !month) return res.status(400).json({ error: 'year and month are required' });

    const challans = await loadChallans();
    const { period } = periodRange(year, month);
    const id = `CHL-${period}-${Date.now()}`;

    const challan = {
      id,
      period,
      year:         parseInt(year),
      month:        parseInt(month),
      cgst:         round2(cgst  || 0),
      sgst:         round2(sgst  || 0),
      igst:         round2(igst  || 0),
      cess:         round2(cess  || 0),
      interest:     round2(interest || 0),
      late_fee:     round2(late_fee || 0),
      total:        round2((cgst || 0) + (sgst || 0) + (igst || 0) + (cess || 0) + (interest || 0) + (late_fee || 0)),
      payment_mode: payment_mode || '',
      bank:         bank || '',
      reference_no: reference_no || '',
      status:       'created',
      created_at:   new Date().toISOString(),
      payment_date: null,
      created_by:   req.user?.name || req.user?.username,
    };

    challans.unshift(challan);
    await saveChallans(challans);
    res.json({ ok: true, challan });
  } catch (e) {
    console.error('[gst-filing] POST /challans error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 13. GET /challans — List challans ────────────────────────────────────────
router.get('/challans', auth, async (req, res) => {
  try {
    const { year } = req.query;
    let challans = await loadChallans();
    if (year) challans = challans.filter(c => String(c.year) === String(year));
    res.json({ challans });
  } catch (e) {
    console.error('[gst-filing] GET /challans error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 14. PUT /challans/:id — Update challan status ────────────────────────────
router.put('/challans/:id', auth, requireRole('admin', 'ceo'), async (req, res) => {
  try {
    const { id }   = req.params;
    const { status, payment_date, reference_no } = req.body;

    const challans = await loadChallans();
    const idx      = challans.findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Challan not found' });

    if (status)       challans[idx].status       = status;
    if (payment_date) challans[idx].payment_date = payment_date;
    if (reference_no) challans[idx].reference_no = reference_no;
    challans[idx].updated_at = new Date().toISOString();

    await saveChallans(challans);
    res.json({ ok: true, challan: challans[idx] });
  } catch (e) {
    console.error('[gst-filing] PUT /challans/:id error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 15. POST /validate-data — Pre-filing data quality checks ────────────────
router.post('/validate-data', auth, async (req, res) => {
  try {
    const { year, month, return_type } = req.body;
    const { start, end } = periodRange(year, month);

    const errors   = [];
    const warnings = [];

    // Fetch orders for the period
    const [wsRes, b2bRes, salesRes] = await Promise.all([
      supabase.from('webstore_orders')
        .select('id, order_no, customer, items, total, gst_amount, payment_status')
        .gte('date', start).lte('date', end),
      supabase.from('b2b_orders')
        .select('id, order_no, customer_name, items, total_value')
        .gte('created_at', start + 'T00:00:00').lte('created_at', end + 'T23:59:59'),
      supabase.from('sales')
        .select('id, order_no, items, final_amount, gst_amount')
        .gte('date', start).lte('date', end),
    ]);

    const wsOrders  = wsRes.data  || [];
    const b2bOrders = b2bRes.data || [];
    const salesRows = salesRes.data || [];

    const orderNos = new Set();

    // Validate webstore orders
    for (const order of wsOrders) {
      // Duplicate order numbers
      if (orderNos.has(order.order_no)) {
        errors.push({ type: 'duplicate_invoice', order_no: order.order_no, message: 'Duplicate order number' });
      }
      orderNos.add(order.order_no);

      // Zero-value orders
      if (!order.total || parseFloat(order.total) === 0) {
        warnings.push({ type: 'zero_value', order_no: order.order_no, message: 'Order has zero total value' });
      }

      // Missing GST amount on paid orders
      if (order.payment_status === 'paid' && !order.gst_amount) {
        warnings.push({ type: 'missing_gst', order_no: order.order_no, message: 'Paid order has no GST amount recorded' });
      }

      // Check item HSN codes
      const items = Array.isArray(order.items) ? order.items : [];
      const missingHsn = items.filter(it => !it.hsn && !it.hsn_code);
      if (missingHsn.length > 0) {
        warnings.push({
          type:      'missing_hsn',
          order_no:  order.order_no,
          message:   `${missingHsn.length} item(s) missing HSN code: ${missingHsn.map(i => i.name).join(', ')}`,
        });
      }
    }

    // Validate B2B orders — should have GSTIN for registered buyers
    for (const order of b2bOrders) {
      const items = Array.isArray(order.items) ? order.items : [];
      if (!order.total_value || parseFloat(order.total_value) === 0) {
        warnings.push({ type: 'zero_value', order_no: order.order_no, message: 'B2B order has zero value' });
      }
      const missingHsn = items.filter(it => !it.hsn && !it.hsn_code);
      if (missingHsn.length > 0) {
        warnings.push({
          type:     'missing_hsn',
          order_no: order.order_no,
          message:  `B2B order: ${missingHsn.length} item(s) missing HSN`,
        });
      }
    }

    // Check for vendor bills without GST (might be missing ITC)
    const { data: bills } = await supabase.from('vendor_bills')
      .select('id, bill_no, vendor_name, amount, gst_amount')
      .gte('bill_date', start).lte('bill_date', end);

    for (const bill of (bills || [])) {
      if (parseFloat(bill.amount) > 0 && !bill.gst_amount) {
        warnings.push({
          type:    'missing_itc',
          bill_no: bill.bill_no,
          vendor:  bill.vendor_name,
          message: 'Vendor bill has no GST amount — possible ITC being missed',
        });
      }
    }

    const totalOrders = wsOrders.length + b2bOrders.length + salesRows.length;

    res.json({
      ok:            errors.length === 0,
      period:        { start, end },
      return_type:   return_type || 'all',
      total_orders:  totalOrders,
      total_bills:   bills?.length || 0,
      error_count:   errors.length,
      warning_count: warnings.length,
      errors,
      warnings,
      summary: errors.length === 0
        ? `Data validation passed with ${warnings.length} warning(s). Safe to proceed with filing.`
        : `Found ${errors.length} error(s) that must be fixed before filing.`,
    });
  } catch (e) {
    console.error('[gst-filing] /validate-data error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
