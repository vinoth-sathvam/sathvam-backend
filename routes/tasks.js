const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');

// GET /api/tasks — list tasks
router.get('/', auth, async (req, res) => {
  try {
    const { status, assigned_to, priority, limit = 200 } = req.query;
    let q = supabase.from('staff_tasks')
      .select('*').order('due_date', { ascending: true }).limit(parseInt(limit));
    if (status) q = q.eq('status', status);
    if (assigned_to) q = q.eq('assigned_to', assigned_to);
    if (priority) q = q.eq('priority', priority);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/tasks — create task
router.post('/', auth, async (req, res) => {
  try {
    const { title, description, assigned_to, assigned_name, due_date, priority, category } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const { data, error } = await supabase.from('staff_tasks')
      .insert({ title, description: description || '', assigned_to: assigned_to || null, assigned_name: assigned_name || '', due_date: due_date || null, priority: priority || 'medium', category: category || 'general', status: 'todo' })
      .select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/tasks/:id — update task
router.patch('/:id', auth, async (req, res) => {
  try {
    const allowed = ['title','description','assigned_to','assigned_name','due_date','priority','category','status','notes'];
    const updates = { updated_at: new Date().toISOString() };
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    if (updates.status === 'done') updates.completed_at = new Date().toISOString();
    const { data, error } = await supabase.from('staff_tasks')
      .update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/tasks/:id
router.delete('/:id', auth, async (req, res) => {
  const { error } = await supabase.from('staff_tasks').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// GET /api/tasks/stats — overview
router.get('/stats', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('staff_tasks').select('status,priority,due_date');
    if (error) return res.status(500).json({ error: error.message });
    const today = new Date().toISOString().slice(0, 10);
    const stats = { todo: 0, in_progress: 0, done: 0, overdue: 0, high_priority: 0 };
    for (const t of data || []) {
      stats[t.status] = (stats[t.status] || 0) + 1;
      if (t.status !== 'done' && t.due_date && t.due_date < today) stats.overdue++;
      if (t.priority === 'high' && t.status !== 'done') stats.high_priority++;
    }
    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
