const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');

// GET /api/returns — list return requests
router.get('/', auth, async (req, res) => {
  try {
    const { status, limit = 100 } = req.query;
    let q = supabase.from('return_requests')
      .select('*').order('created_at', { ascending: false }).limit(parseInt(limit));
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/returns — create return request
router.post('/', auth, async (req, res) => {
  try {
    const { order_id, order_number, customer_name, customer_phone, items, reason, refund_amount, refund_method } = req.body;
    if (!order_id || !reason) return res.status(400).json({ error: 'Missing fields' });
    const { data, error } = await supabase.from('return_requests')
      .insert({ order_id, order_number: order_number || '', customer_name: customer_name || '', customer_phone: customer_phone || '', items: items || [], reason, refund_amount: refund_amount || 0, refund_method: refund_method || 'original', status: 'pending' })
      .select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/returns/:id — update status
router.patch('/:id', auth, async (req, res) => {
  try {
    const { status, notes, refund_amount, refund_method, resolved_at } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (status !== undefined) updates.status = status;
    if (notes !== undefined) updates.notes = notes;
    if (refund_amount !== undefined) updates.refund_amount = refund_amount;
    if (refund_method !== undefined) updates.refund_method = refund_method;
    if (status === 'refunded' || status === 'rejected') updates.resolved_at = new Date().toISOString();
    const { data, error } = await supabase.from('return_requests')
      .update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/returns/stats — summary stats
router.get('/stats', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('return_requests').select('status,refund_amount');
    if (error) return res.status(500).json({ error: error.message });
    const stats = { pending: 0, approved: 0, refunded: 0, rejected: 0, total_refunded: 0 };
    for (const r of data || []) {
      stats[r.status] = (stats[r.status] || 0) + 1;
      if (r.status === 'refunded') stats.total_refunded += (r.refund_amount || 0);
    }
    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
