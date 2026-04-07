const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');

// GET /api/leave — list requests
router.get('/', auth, async (req, res) => {
  try {
    const { status, employee_id, limit = 100 } = req.query;
    let q = supabase.from('leave_requests')
      .select('*').order('created_at', { ascending: false }).limit(parseInt(limit));
    if (status) q = q.eq('status', status);
    if (employee_id) q = q.eq('employee_id', employee_id);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/leave — create request
router.post('/', auth, async (req, res) => {
  try {
    const { employee_id, employee_name, leave_type, from_date, to_date, reason } = req.body;
    if (!employee_id || !from_date || !to_date) return res.status(400).json({ error: 'Missing fields' });
    const days = Math.ceil((new Date(to_date) - new Date(from_date)) / 86400000) + 1;
    const { data, error } = await supabase.from('leave_requests')
      .insert({ employee_id, employee_name, leave_type: leave_type || 'casual', from_date, to_date, days, reason: reason || '', status: 'pending' })
      .select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/leave/:id — approve/reject
router.patch('/:id', auth, async (req, res) => {
  try {
    const { status, notes } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (status) updates.status = status;
    if (notes !== undefined) updates.notes = notes;
    const { data, error } = await supabase.from('leave_requests')
      .update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/leave/:id
router.delete('/:id', auth, async (req, res) => {
  const { error } = await supabase.from('leave_requests').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// GET /api/leave/summary — leave counts per employee
router.get('/summary', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('leave_requests')
      .select('employee_id,employee_name,leave_type,days,status')
      .eq('status', 'approved');
    if (error) return res.status(500).json({ error: error.message });
    const summary = {};
    for (const r of data || []) {
      if (!summary[r.employee_id]) summary[r.employee_id] = { employee_name: r.employee_name, casual: 0, sick: 0, earned: 0, other: 0, total: 0 };
      const t = r.leave_type || 'other';
      summary[r.employee_id][t] = (summary[r.employee_id][t] || 0) + r.days;
      summary[r.employee_id].total += r.days;
    }
    res.json(Object.values(summary));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
