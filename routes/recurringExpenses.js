const express = require('express');
const router  = express.Router();
const { auth, requireRole } = require('../middleware/auth');
const supabase = require('../config/supabase');

const TABLE   = 'recurring_expenses';
const PAY_TBL = 'recurring_payments';

// ── Helpers ───────────────────────────────────────────────────────────────────
// Returns the period string for the current cycle of a recurring item.
// monthly → '2025-04', quarterly → '2025-Q2', annual → '2025'
function currentPeriod(frequency) {
  const now = new Date();
  const y   = now.getFullYear();
  const m   = String(now.getMonth() + 1).padStart(2, '0');
  if (frequency === 'monthly')   return `${y}-${m}`;
  if (frequency === 'quarterly') return `${y}-Q${Math.ceil((now.getMonth() + 1) / 3)}`;
  return String(y);
}

// Next due date for a recurring item
function nextDueDate(item) {
  const now  = new Date();
  const y    = now.getFullYear();
  const m    = now.getMonth(); // 0-indexed
  const day  = item.due_day || 1;
  const mon  = (item.due_month || 1) - 1; // 0-indexed

  if (item.frequency === 'monthly') {
    let d = new Date(y, m, day);
    if (d < now) d = new Date(y, m + 1, day);
    return d.toISOString().slice(0, 10);
  }
  if (item.frequency === 'quarterly') {
    const q = Math.ceil((m + 1) / 3);
    // Due on last month of current quarter + due_day
    const quarterEnd = q * 3; // month number 1-indexed
    let d = new Date(y, quarterEnd - 1, day); // 0-indexed month
    if (d < now) d = new Date(y, quarterEnd + 2, day);
    return d.toISOString().slice(0, 10);
  }
  if (item.frequency === 'annual') {
    let d = new Date(y, mon, day);
    if (d < now) d = new Date(y + 1, mon, day);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

// ── GET all recurring expenses ────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const { data: items, error } = await supabase
      .from(TABLE).select('*').eq('active', true)
      .order('category').order('name');
    if (error) return res.status(500).json({ error: error.message });

    // Attach current period payment status
    const periods = items.map(i => currentPeriod(i.frequency));
    const { data: pays } = await supabase
      .from(PAY_TBL)
      .select('recurring_expense_id, period, paid_date, amount')
      .in('recurring_expense_id', items.map(i => i.id));

    const payMap = {};
    for (const p of (pays || [])) {
      const key = `${p.recurring_expense_id}__${p.period}`;
      payMap[key] = p;
    }

    const result = items.map((item, idx) => {
      const period = periods[idx];
      const key    = `${item.id}__${period}`;
      const pay    = payMap[key];
      return {
        ...item,
        current_period: period,
        paid_this_period: !!pay,
        paid_date:        pay?.paid_date || null,
        next_due:         nextDueDate(item),
      };
    });

    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET overdue/upcoming summary (for dashboard) ──────────────────────────────
router.get('/alerts', auth, async (req, res) => {
  try {
    const { data: items } = await supabase
      .from(TABLE).select('*').eq('active', true);
    const { data: pays }  = await supabase
      .from(PAY_TBL).select('recurring_expense_id, period');

    const paidSet = new Set((pays || []).map(p => `${p.recurring_expense_id}__${p.period}`));
    const today   = new Date().toISOString().slice(0, 10);

    const unpaid = (items || [])
      .filter(item => {
        const period = currentPeriod(item.frequency);
        return !paidSet.has(`${item.id}__${period}`);
      })
      .map(item => ({
        id: item.id, name: item.name, category: item.category,
        amount: item.amount, frequency: item.frequency,
        next_due: nextDueDate(item),
        overdue: nextDueDate(item) < today,
      }))
      .sort((a, b) => (a.next_due || '').localeCompare(b.next_due || ''));

    res.json({ unpaid, total_monthly: (items || []).filter(i => i.frequency === 'monthly').reduce((s, i) => s + parseFloat(i.amount || 0), 0) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST create ───────────────────────────────────────────────────────────────
router.post('/', auth, requireRole('admin', 'manager'), async (req, res) => {
  const { name, category, amount, frequency, due_day, due_month, vendor, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const { data, error } = await supabase.from(TABLE).insert({
    name: name.trim(), category: category || 'other',
    amount: parseFloat(amount) || 0,
    frequency: frequency || 'monthly',
    due_day: parseInt(due_day) || 1,
    due_month: due_month ? parseInt(due_month) : null,
    vendor: vendor || '', notes: notes || '',
    active: true, updated_at: new Date().toISOString(),
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// ── PUT update ────────────────────────────────────────────────────────────────
router.put('/:id', auth, requireRole('admin', 'manager'), async (req, res) => {
  const fields = ['name','category','amount','frequency','due_day','due_month','vendor','notes','active'];
  const u = { updated_at: new Date().toISOString() };
  fields.forEach(f => { if (req.body[f] != null) u[f] = req.body[f]; });
  if (u.amount)    u.amount   = parseFloat(u.amount);
  if (u.due_day)   u.due_day  = parseInt(u.due_day);
  if (u.due_month) u.due_month= parseInt(u.due_month);
  const { data, error } = await supabase.from(TABLE).update(u).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ── DELETE (soft) ─────────────────────────────────────────────────────────────
router.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  await supabase.from(TABLE).update({ active: false }).eq('id', req.params.id);
  res.json({ ok: true });
});

// ── POST mark paid for current period ─────────────────────────────────────────
router.post('/:id/pay', auth, requireRole('admin', 'manager'), async (req, res) => {
  const { period, paid_date, amount, payment_mode, reference_no, notes } = req.body;
  const { data: item } = await supabase.from(TABLE).select('frequency,amount').eq('id', req.params.id).single();
  if (!item) return res.status(404).json({ error: 'Not found' });

  const usePeriod = period || currentPeriod(item.frequency);

  // Upsert payment record
  const { data, error } = await supabase.from(PAY_TBL).upsert({
    recurring_expense_id: req.params.id,
    period: usePeriod,
    paid_date: paid_date || new Date().toISOString().slice(0, 10),
    amount: parseFloat(amount) || parseFloat(item.amount) || 0,
    payment_mode: payment_mode || 'bank_transfer',
    reference_no: reference_no || '',
    notes: notes || '',
  }, { onConflict: 'recurring_expense_id,period' }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ── DELETE unmark payment ─────────────────────────────────────────────────────
router.delete('/:id/pay/:period', auth, requireRole('admin', 'manager'), async (req, res) => {
  await supabase.from(PAY_TBL)
    .delete()
    .eq('recurring_expense_id', req.params.id)
    .eq('period', req.params.period);
  res.json({ ok: true });
});

// ── GET payment history for one item ─────────────────────────────────────────
router.get('/:id/history', auth, async (req, res) => {
  const { data, error } = await supabase.from(PAY_TBL)
    .select('*').eq('recurring_expense_id', req.params.id)
    .order('period', { ascending: false }).limit(24);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

module.exports = router;
