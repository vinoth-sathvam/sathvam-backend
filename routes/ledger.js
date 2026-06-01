/**
 * routes/ledger.js
 * Universal Money Ledger + Petty Cash Box
 * Every rupee in/out — single source of truth.
 */
const express  = require('express');
const router   = express.Router();
const supabase = require('../config/supabase');
const { auth, requireRole } = require('../middleware/auth');
const { insertLedger }      = require('../utils/ledger');

const ALLOWED = requireRole('admin','ceo','manager','accountant');

// ─── LEDGER ──────────────────────────────────────────────────────────────────

/** GET /api/ledger  — paginated transaction feed */
router.get('/', auth, ALLOWED, async (req, res) => {
  const {
    from, to, direction, category, payment_mode, search,
    page = 1, limit = 100,
  } = req.query;

  let q = supabase.from('money_ledger').select('*', { count: 'exact' });

  if (from)         q = q.gte('txn_date', from);
  if (to)           q = q.lte('txn_date', to);
  if (direction)    q = q.eq('direction', direction);
  if (category)     q = q.eq('category', category);
  if (payment_mode) q = q.eq('payment_mode', payment_mode);
  if (search)       q = q.or(`party.ilike.%${search}%,narration.ilike.%${search}%,reference_no.ilike.%${search}%`);

  const offset = (parseInt(page) - 1) * parseInt(limit);
  q = q.order('txn_date', { ascending: false })
       .order('created_at', { ascending: false })
       .range(offset, offset + parseInt(limit) - 1);

  const { data, error, count } = await q;
  if (error) return res.status(400).json({ error: error.message });
  res.json({ data, count, page: parseInt(page), limit: parseInt(limit) });
});

/** GET /api/ledger/summary  — totals by direction + category for period */
router.get('/summary', auth, ALLOWED, async (req, res) => {
  const { from, to } = req.query;
  const today = new Date().toISOString().slice(0, 10);
  const start = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const end   = to   || today;

  const { data, error } = await supabase
    .from('money_ledger')
    .select('direction,category,amount')
    .gte('txn_date', start)
    .lte('txn_date', end);

  if (error) return res.status(400).json({ error: error.message });

  const summary = { totalIn: 0, totalOut: 0, byCategory: {} };
  for (const r of (data || [])) {
    if (r.direction === 'in')  summary.totalIn  += parseFloat(r.amount) || 0;
    if (r.direction === 'out') summary.totalOut += parseFloat(r.amount) || 0;
    if (!summary.byCategory[r.category]) summary.byCategory[r.category] = { in: 0, out: 0 };
    summary.byCategory[r.category][r.direction] += parseFloat(r.amount) || 0;
  }
  summary.net = summary.totalIn - summary.totalOut;
  res.json({ ...summary, from: start, to: end });
});

/** GET /api/ledger/cashflow  — daily in/out for chart (last 30 days) */
router.get('/cashflow', auth, ALLOWED, async (req, res) => {
  const days  = parseInt(req.query.days || '30');
  const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('money_ledger')
    .select('txn_date,direction,amount')
    .gte('txn_date', start)
    .order('txn_date', { ascending: true });

  if (error) return res.status(400).json({ error: error.message });

  const byDate = {};
  for (const r of (data || [])) {
    if (!byDate[r.txn_date]) byDate[r.txn_date] = { date: r.txn_date, in: 0, out: 0 };
    byDate[r.txn_date][r.direction] += parseFloat(r.amount) || 0;
  }

  const chart = Object.values(byDate).map(d => ({ ...d, net: d.in - d.out }));
  res.json(chart);
});

/** POST /api/ledger  — manual ledger entry */
router.post('/', auth, ALLOWED, async (req, res) => {
  const {
    txn_date, direction, amount, category, subcategory,
    party, party_type, payment_mode, narration, reference_no,
    gst_amount, tds_amount,
  } = req.body;

  if (!txn_date || !direction || amount == null || !category)
    return res.status(400).json({ error: 'txn_date, direction, amount, category required' });

  const parsed = parseFloat(amount);
  if (isNaN(parsed) || parsed < 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!['in','out'].includes(direction)) return res.status(400).json({ error: 'direction must be in or out' });

  const { data, error } = await supabase.from('money_ledger').insert({
    txn_date, direction, amount: parsed,
    category:     category    || 'other',
    subcategory:  subcategory || '',
    party:        party       || '',
    party_type:   party_type  || 'other',
    payment_mode: payment_mode || 'bank_transfer',
    narration:    narration   || '',
    reference_no: reference_no || '',
    source_table: 'manual',
    source_id:    '',
    gst_amount:   parseFloat(gst_amount)  || 0,
    tds_amount:   parseFloat(tds_amount)  || 0,
    created_by:   req.user?.name || '',
  }).select().single();

  if (error) return res.status(400).json({ error: error.message });

  // Trigger CCO check for large transactions
  if (parsed >= 10000) {
    try {
      const { runCCOCheck } = require('./ccoAgent');
      runCCOCheck(data).catch(() => {});
    } catch (_) {}
  }

  res.status(201).json(data);
});

/** DELETE /api/ledger/:id  — soft delete (admin only) */
router.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  const { error } = await supabase
    .from('money_ledger')
    .delete()
    .eq('id', parseInt(req.params.id));
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// ─── SYNC FROM EXISTING TABLES ───────────────────────────────────────────────

/** POST /api/ledger/sync  — one-time backfill from all source tables */
router.post('/sync', auth, requireRole('admin'), async (req, res) => {
  let synced = 0;
  const errs = [];

  async function syncBatch(rows) {
    if (!rows.length) return;
    const { error } = await supabase.from('money_ledger').upsert(rows, {
      onConflict: 'source_table,source_id',
      ignoreDuplicates: true,
    }).throwOnError();
    if (error) errs.push(error.message);
    else synced += rows.length;
  }

  // Get already-synced IDs per table to skip duplicates
  async function existingIds(table) {
    const { data } = await supabase.from('money_ledger').select('source_id').eq('source_table', table);
    return new Set((data || []).map(r => r.source_id));
  }

  try {
    // 1. Expenses
    const exIds = await existingIds('company_expenses');
    const { data: exps } = await supabase.from('company_expenses').select('*').is('deleted_at', null);
    const expRows = (exps || []).filter(r => !exIds.has(String(r.id))).map(r => ({
      txn_date:     r.date,
      direction:    'out',
      amount:       parseFloat(r.amount) || 0,
      category:     'expense',
      subcategory:  r.category  || '',
      party:        r.vendor_name || '',
      party_type:   'vendor',
      payment_mode: r.payment_mode || 'cash',
      narration:    r.description || '',
      reference_no: r.reference_no || '',
      source_table: 'company_expenses',
      source_id:    String(r.id),
      created_by:   r.created_by || '',
    }));
    await syncBatch(expRows);

    // 2. Salary payments
    const salIds = await existingIds('salary_payments');
    const { data: sals } = await supabase.from('salary_payments').select('*');
    const salRows = (sals || []).filter(r => !salIds.has(String(r.id))).map(r => ({
      txn_date:     r.payment_date,
      direction:    'out',
      amount:       parseFloat(r.amount) || 0,
      category:     'payroll',
      subcategory:  'salary',
      party:        r.employee_name || '',
      party_type:   'employee',
      payment_mode: r.payment_mode || 'bank_transfer',
      narration:    `Salary ${r.month} — ${r.employee_name}`,
      reference_no: r.reference_no || '',
      source_table: 'salary_payments',
      source_id:    String(r.id),
      created_by:   r.paid_by || '',
    }));
    await syncBatch(salRows);

    // 3. Sales (POS — delivered/dispatched)
    const salesIds = await existingIds('sales');
    const { data: salesData } = await supabase.from('sales').select('*').in('status', ['delivered','dispatched']);
    const salesRows = (salesData || []).filter(r => !salesIds.has(String(r.id))).map(r => ({
      txn_date:     r.date,
      direction:    'in',
      amount:       parseFloat(r.final_amount) || 0,
      category:     'sales',
      subcategory:  'pos',
      party:        r.customer_name || '',
      party_type:   'customer',
      payment_mode: r.payment_mode || 'cash',
      narration:    `POS Sale — ${r.order_no || r.id}`,
      reference_no: r.order_no || String(r.id),
      source_table: 'sales',
      source_id:    String(r.id),
    }));
    await syncBatch(salesRows);

    // 4. Webstore orders (paid)
    const wsIds = await existingIds('webstore_orders');
    const { data: wsData } = await supabase.from('webstore_orders').select('id,date,total,payment_status,order_no,channel,created_at').eq('payment_status','paid');
    const wsRows = (wsData || []).filter(r => !wsIds.has(String(r.id))).map(r => ({
      txn_date:     r.date || r.created_at?.slice(0,10),
      direction:    'in',
      amount:       parseFloat(r.total) || 0,
      category:     'sales',
      subcategory:  r.channel || 'webstore',
      party:        'Online Customer',
      party_type:   'customer',
      payment_mode: 'upi',
      narration:    `Webstore Order — ${r.order_no}`,
      reference_no: r.order_no,
      source_table: 'webstore_orders',
      source_id:    String(r.id),
    }));
    await syncBatch(wsRows);

    // 5. Bank transactions
    const btIds = await existingIds('bank_transactions');
    const { data: btData } = await supabase.from('bank_transactions').select('*');
    const btRows = (btData || []).filter(r => !btIds.has(String(r.id))).map(r => ({
      txn_date:       r.date,
      direction:      r.type === 'credit' ? 'in' : 'out',
      amount:         parseFloat(r.amount) || 0,
      category:       r.category || 'bank_transfer',
      subcategory:    '',
      party:          r.description || '',
      party_type:     'bank',
      payment_mode:   'bank_transfer',
      narration:      r.description || '',
      reference_no:   r.reference || '',
      source_table:   'bank_transactions',
      source_id:      String(r.id),
    }));
    await syncBatch(btRows);

  } catch (e) {
    errs.push(e.message);
  }

  res.json({ ok: true, synced, errors: errs });
});

// ─── PETTY CASH ──────────────────────────────────────────────────────────────

/** GET /api/ledger/petty-cash  — log with running balance */
router.get('/petty-cash', auth, ALLOWED, async (req, res) => {
  const { from, to } = req.query;
  let q = supabase.from('petty_cash_log').select('*').order('txn_date', { ascending: false }).order('created_at', { ascending: false });
  if (from) q = q.gte('txn_date', from);
  if (to)   q = q.lte('txn_date', to);
  const { data, error } = await q;
  if (error) return res.status(400).json({ error: error.message });

  // Compute running balance (oldest first, then reverse)
  const sorted = [...(data || [])].sort((a,b) => a.created_at < b.created_at ? -1 : 1);
  let balance = 0;
  for (const r of sorted) {
    balance += r.direction === 'in' ? parseFloat(r.amount) : -parseFloat(r.amount);
    r.running_balance = parseFloat(balance.toFixed(2));
  }
  // Return in display order (newest first)
  res.json(sorted.reverse());
});

/** GET /api/ledger/petty-cash/balance  — current balance */
router.get('/petty-cash/balance', auth, ALLOWED, async (req, res) => {
  const { data, error } = await supabase.from('petty_cash_log').select('direction,amount');
  if (error) return res.status(400).json({ error: error.message });
  const balance = (data || []).reduce((s, r) =>
    s + (r.direction === 'in' ? parseFloat(r.amount) : -parseFloat(r.amount)), 0);
  res.json({ balance: parseFloat(balance.toFixed(2)) });
});

/** POST /api/ledger/petty-cash  — new petty cash entry */
router.post('/petty-cash', auth, ALLOWED, async (req, res) => {
  const { txn_date, direction, amount, category, narration, party, voucher_no } = req.body;
  if (!direction || amount == null || !narration)
    return res.status(400).json({ error: 'direction, amount, narration required' });
  const parsed = parseFloat(amount);
  if (isNaN(parsed) || parsed <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const { data, error } = await supabase.from('petty_cash_log').insert({
    txn_date:    txn_date   || new Date().toISOString().slice(0, 10),
    direction,
    amount:      parsed,
    category:    category   || 'expense',
    narration:   narration.trim(),
    party:       party      || '',
    voucher_no:  voucher_no || '',
    recorded_by: req.user?.name || '',
  }).select().single();

  if (error) return res.status(400).json({ error: error.message });

  // Also push to money_ledger
  await insertLedger({
    txn_date:     data.txn_date,
    direction,
    amount:       parsed,
    category:     'petty_cash',
    subcategory:  category || 'expense',
    party:        party || '',
    party_type:   'other',
    payment_mode: 'cash',
    narration:    narration.trim(),
    reference_no: voucher_no || '',
    source_table: 'petty_cash_log',
    source_id:    String(data.id),
    created_by:   req.user?.name || '',
  });

  res.status(201).json(data);
});

/** DELETE /api/ledger/petty-cash/:id  — admin only */
router.delete('/petty-cash/:id', auth, requireRole('admin'), async (req, res) => {
  const { error } = await supabase
    .from('petty_cash_log')
    .delete()
    .eq('id', parseInt(req.params.id));
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
