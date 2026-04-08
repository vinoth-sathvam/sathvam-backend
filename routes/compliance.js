const express = require('express');
const router  = express.Router();
const { auth, requireRole } = require('../middleware/auth');
const supabase = require('../config/supabase');

const TABLE   = 'compliance_items';
const HIST    = 'compliance_history';

function computeNextDue(item, fromDate) {
  const base = fromDate ? new Date(fromDate) : new Date();
  const y    = base.getFullYear();
  const m    = base.getMonth();
  const day  = item.due_day  || 20;
  const mon  = (item.due_month || 1) - 1;

  if (item.frequency === 'monthly') {
    let d = new Date(y, m, day);
    if (d <= base) d = new Date(y, m + 1, day);
    return d.toISOString().slice(0, 10);
  }
  if (item.frequency === 'quarterly') {
    const q = Math.ceil((m + 1) / 3);
    const endMon = q * 3 - 1;
    let d = new Date(y, endMon, day);
    if (d <= base) d = new Date(y, endMon + 3, day);
    return d.toISOString().slice(0, 10);
  }
  if (item.frequency === 'annual' || item.frequency === 'one_time') {
    let d = new Date(y, mon, day);
    if (d <= base) d = new Date(y + 1, mon, day);
    return d.toISOString().slice(0, 10);
  }
  return item.next_due_date || null;
}

router.get('/', auth, async (req, res) => {
  try {
    const { data: items, error } = await supabase
      .from(TABLE).select('*').eq('active', true)
      .order('next_due_date').order('name');
    if (error) return res.status(500).json({ error: error.message });
    const today = new Date().toISOString().slice(0, 10);
    const result = (items || []).map(item => {
      const due   = item.next_due_date || computeNextDue(item, null);
      const diffMs = due ? new Date(due) - new Date(today) : null;
      const daysUntil = diffMs != null ? Math.ceil(diffMs / 86400000) : null;
      return { ...item, next_due_date: due, days_until_due: daysUntil,
        status: daysUntil == null ? 'unknown' : daysUntil < 0 ? 'overdue' : daysUntil <= (item.alert_days_before||30) ? 'due_soon' : 'ok' };
    });
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/alerts', auth, async (req, res) => {
  try {
    const { data: items } = await supabase.from(TABLE).select('*').eq('active', true);
    const today = new Date().toISOString().slice(0, 10);
    const alerts = (items || []).map(item => {
      const due = item.next_due_date || computeNextDue(item, null);
      const diffMs = due ? new Date(due) - new Date(today) : null;
      const daysUntil = diffMs != null ? Math.ceil(diffMs / 86400000) : null;
      return { id: item.id, name: item.name, type: item.type, next_due_date: due, days_until_due: daysUntil,
        status: daysUntil == null ? 'unknown' : daysUntil < 0 ? 'overdue' : daysUntil <= (item.alert_days_before||30) ? 'due_soon' : 'ok' };
    }).filter(i => i.status === 'overdue' || i.status === 'due_soon')
      .sort((a, b) => (a.days_until_due ?? 9999) - (b.days_until_due ?? 9999));
    res.json(alerts);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', auth, requireRole('admin', 'manager'), async (req, res) => {
  const { name, type, frequency, due_day, due_month, next_due_date, cost, vendor, license_no, notes, alert_days_before } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const item = { name: name.trim(), type: type || 'other', frequency: frequency || 'annual',
    due_day: parseInt(due_day) || 20, due_month: due_month ? parseInt(due_month) : null,
    cost: parseFloat(cost) || 0, vendor: vendor || '', license_no: license_no || '',
    notes: notes || '', alert_days_before: parseInt(alert_days_before) || 30,
    active: true, updated_at: new Date().toISOString() };
  item.next_due_date = next_due_date || computeNextDue(item, null);
  const { data, error } = await supabase.from(TABLE).insert(item).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/:id', auth, requireRole('admin', 'manager'), async (req, res) => {
  const fields = ['name','type','frequency','due_day','due_month','next_due_date','last_completed_date','cost','vendor','license_no','notes','alert_days_before','active'];
  const u = { updated_at: new Date().toISOString() };
  fields.forEach(f => { if (req.body[f] != null) u[f] = req.body[f]; });
  if (u.cost)              u.cost              = parseFloat(u.cost);
  if (u.due_day)           u.due_day           = parseInt(u.due_day);
  if (u.due_month)         u.due_month         = parseInt(u.due_month);
  if (u.alert_days_before) u.alert_days_before = parseInt(u.alert_days_before);
  const { data, error } = await supabase.from(TABLE).update(u).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

router.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  await supabase.from(TABLE).update({ active: false }).eq('id', req.params.id);
  res.json({ ok: true });
});

router.post('/:id/done', auth, requireRole('admin', 'manager'), async (req, res) => {
  const { completed_date, period, notes } = req.body;
  const today = completed_date || new Date().toISOString().slice(0, 10);
  const { data: item } = await supabase.from(TABLE).select('*').eq('id', req.params.id).single();
  if (!item) return res.status(404).json({ error: 'Not found' });
  await supabase.from(HIST).insert({ compliance_item_id: req.params.id, completed_date: today, period: period || '', notes: notes || '' });
  const newNextDue = item.frequency === 'one_time' ? null : computeNextDue(item, today);
  const { data, error } = await supabase.from(TABLE).update({
    last_completed_date: today, next_due_date: newNextDue, updated_at: new Date().toISOString(),
  }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

router.get('/:id/history', auth, async (req, res) => {
  const { data, error } = await supabase.from(HIST)
    .select('*').eq('compliance_item_id', req.params.id)
    .order('completed_date', { ascending: false }).limit(24);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

module.exports = router;
