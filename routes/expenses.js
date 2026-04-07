const express = require('express');
const router  = express.Router();
const { auth, requireRole } = require('../middleware/auth');
const supabase = require('../config/supabase');

const DEFAULT_CATEGORIES = [
  { name:'Raw Materials',  icon:'🌾', color:'#d97706' },
  { name:'Utilities',      icon:'⚡', color:'#0891b2' },
  { name:'Labour',         icon:'👷', color:'#7c3aed' },
  { name:'Transport',      icon:'🚛', color:'#16a34a' },
  { name:'Maintenance',    icon:'🔧', color:'#dc2626' },
  { name:'Office & Admin', icon:'📋', color:'#6b7280' },
  { name:'Marketing',      icon:'📣', color:'#ec4899' },
  { name:'Rent',           icon:'🏢', color:'#64748b' },
  { name:'Packaging',      icon:'📦', color:'#f59e0b' },
  { name:'Miscellaneous',  icon:'💸', color:'#9ca3af' },
];

// ── Categories ────────────────────────────────────────────────────────────────

router.get('/categories', auth, async (req, res) => {
  let { data, error } = await supabase.from('expense_categories').select('*').eq('active', true).order('name');
  if (error) return res.status(500).json({ error: error.message });
  if (!data || data.length === 0) {
    await supabase.from('expense_categories').insert(DEFAULT_CATEGORIES);
    ({ data } = await supabase.from('expense_categories').select('*').eq('active', true).order('name'));
  }
  res.json(data || []);
});

router.post('/categories', auth, requireRole('admin', 'manager'), async (req, res) => {
  const { name, icon, color } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const { data, error } = await supabase.from('expense_categories')
    .insert({ name: name.trim(), icon: icon || '', color: color || '#6b7280', active: true })
    .select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/categories/:id', auth, requireRole('admin', 'manager'), async (req, res) => {
  const { name, icon, color, active } = req.body;
  const u = {};
  if (name   != null) u.name   = name.trim();
  if (icon   != null) u.icon   = icon;
  if (color  != null) u.color  = color;
  if (active != null) u.active = active;
  const { data, error } = await supabase.from('expense_categories').update(u).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ── Opening Balance ───────────────────────────────────────────────────────────

// GET /api/expenses/opening-balance?date=YYYY-MM-DD
router.get('/opening-balance', auth, async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase.from('expense_opening_balance')
    .select('*').eq('date', date).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || { date, opening_balance: 0, notes: '' });
});

// POST /api/expenses/opening-balance  (upsert by date)
router.post('/opening-balance', auth, requireRole('admin', 'manager'), async (req, res) => {
  const { date, opening_balance, notes } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });
  const { data, error } = await supabase.from('expense_opening_balance').upsert({
    date,
    opening_balance: parseFloat(opening_balance) || 0,
    notes:           notes || '',
    created_by:      req.user?.name || req.user?.email || '',
    updated_at:      new Date().toISOString(),
  }, { onConflict: 'date' }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ── Expenses ──────────────────────────────────────────────────────────────────

// GET /api/expenses?start=&end=&category=&payment_mode=&limit=&offset=
router.get('/', auth, async (req, res) => {
  const { start, end, category, payment_mode, limit = 500, offset = 0 } = req.query;
  let q = supabase.from('company_expenses').select('*', { count: 'exact' })
    .is('deleted_at', null)
    .order('date', { ascending: false })
    .order('created_at', { ascending: false });
  if (start) q = q.gte('date', start);
  if (end)   q = q.lte('date', end);
  if (category && category !== 'all')         q = q.eq('category', category);
  if (payment_mode && payment_mode !== 'all') q = q.eq('payment_mode', payment_mode);
  q = q.range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);
  const { data, error, count } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ expenses: data || [], total: count || 0 });
});

// POST /api/expenses
router.post('/', auth, requireRole('admin', 'manager'), async (req, res) => {
  const { date, category, description, amount, payment_mode, vendor_name, reference_no, notes } = req.body;
  if (!date || !category || !description || amount == null)
    return res.status(400).json({ error: 'date, category, description, amount are required' });
  const parsed = parseFloat(amount);
  if (isNaN(parsed) || parsed < 0) return res.status(400).json({ error: 'Invalid amount' });
  const { data, error } = await supabase.from('company_expenses').insert({
    date, category,
    description:  description.trim(),
    amount:       parsed,
    payment_mode: payment_mode || 'cash',
    vendor_name:  vendor_name  || '',
    reference_no: reference_no || '',
    notes:        notes        || '',
    created_by:   req.user?.name || req.user?.email || '',
    updated_at:   new Date().toISOString(),
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/expenses/:id
router.put('/:id', auth, requireRole('admin', 'manager'), async (req, res) => {
  const { date, category, description, amount, payment_mode, vendor_name, reference_no, notes } = req.body;
  const u = { updated_at: new Date().toISOString() };
  if (date        != null) u.date         = date;
  if (category    != null) u.category     = category;
  if (description != null) u.description  = description.trim();
  if (amount      != null) u.amount       = parseFloat(amount);
  if (payment_mode!= null) u.payment_mode = payment_mode;
  if (vendor_name != null) u.vendor_name  = vendor_name;
  if (reference_no!= null) u.reference_no = reference_no;
  if (notes       != null) u.notes        = notes;
  const { data, error } = await supabase.from('company_expenses')
    .update(u).eq('id', req.params.id).is('deleted_at', null).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE /api/expenses/:id  — soft delete with mandatory reason
router.delete('/:id', auth, requireRole('admin', 'manager'), async (req, res) => {
  const { reason } = req.body;
  if (!reason?.trim()) return res.status(400).json({ error: 'Delete reason is required' });
  const now = new Date().toISOString();
  const { error } = await supabase.from('company_expenses').update({
    deleted_at:     now,
    deleted_by:     req.user?.name || req.user?.email || '',
    delete_reason:  reason.trim(),
    updated_at:     now,
  }).eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// ── Report ─────────────────────────────────────────────────────────────────────

// GET /api/expenses/report?start=&end=
router.get('/report', auth, async (req, res) => {
  const today      = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01';
  const start = req.query.start || monthStart;
  const end   = req.query.end   || today;

  const { data: rows, error } = await supabase.from('company_expenses')
    .select('*').gte('date', start).lte('date', end)
    .is('deleted_at', null).order('date');
  if (error) return res.status(500).json({ error: error.message });

  const expenses = rows || [];
  const total    = expenses.reduce((s, r) => s + parseFloat(r.amount || 0), 0);

  const byCat = {}, byDate = {}, byPM = {}, byVendor = {};
  for (const r of expenses) {
    if (!byCat[r.category])   byCat[r.category]   = { amount:0, count:0 };
    byCat[r.category].amount  += parseFloat(r.amount||0);
    byCat[r.category].count++;

    if (!byDate[r.date])      byDate[r.date]       = { amount:0, count:0 };
    byDate[r.date].amount     += parseFloat(r.amount||0);
    byDate[r.date].count++;

    const pm = r.payment_mode||'cash';
    if (!byPM[pm])            byPM[pm]             = { amount:0, count:0 };
    byPM[pm].amount           += parseFloat(r.amount||0);
    byPM[pm].count++;

    const v = r.vendor_name?.trim();
    if (v) {
      if (!byVendor[v])       byVendor[v]          = { amount:0, count:0 };
      byVendor[v].amount      += parseFloat(r.amount||0);
      byVendor[v].count++;
    }
  }

  const daysWithData = Object.keys(byDate).length;
  const totalDays    = Math.round((new Date(end) - new Date(start)) / (1000*60*60*24)) + 1;
  const highestDay   = Object.entries(byDate).sort((a,b) => b[1].amount - a[1].amount)[0];
  const topCat       = Object.entries(byCat).sort((a,b) => b[1].amount - a[1].amount)[0];

  res.json({
    start, end,
    total:          Math.round(total*100)/100,
    count:          expenses.length,
    days_with_data: daysWithData,
    total_days:     totalDays,
    avg_per_day:    daysWithData > 0 ? Math.round((total/daysWithData)*100)/100 : 0,
    highest_day:    highestDay ? { date:highestDay[0], amount:Math.round(highestDay[1].amount*100)/100 } : null,
    top_category:   topCat     ? { name:topCat[0],    amount:Math.round(topCat[1].amount*100)/100 }    : null,
    by_category: Object.entries(byCat).map(([name,v]) => ({
      name, amount:Math.round(v.amount*100)/100, count:v.count,
      pct: total>0 ? Math.round((v.amount/total)*1000)/10 : 0,
    })).sort((a,b) => b.amount-a.amount),
    by_date: Object.entries(byDate).map(([date,v]) => ({
      date, amount:Math.round(v.amount*100)/100, count:v.count,
    })).sort((a,b) => a.date.localeCompare(b.date)),
    by_payment_mode: Object.entries(byPM).map(([mode,v]) => ({
      mode, amount:Math.round(v.amount*100)/100, count:v.count,
    })).sort((a,b) => b.amount-a.amount),
    by_vendor: Object.entries(byVendor).map(([name,v]) => ({
      name, amount:Math.round(v.amount*100)/100, count:v.count,
    })).sort((a,b) => b.amount-a.amount).slice(0,10),
  });
});

module.exports = router;
