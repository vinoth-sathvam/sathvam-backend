const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');

// GET /api/quality — list quality tests
router.get('/', auth, async (req, res) => {
  try {
    const { product_id, batch_id, result, limit = 100 } = req.query;
    let q = supabase.from('quality_tests')
      .select('*').order('tested_at', { ascending: false }).limit(parseInt(limit));
    if (product_id) q = q.eq('product_id', product_id);
    if (batch_id) q = q.eq('batch_id', batch_id);
    if (result) q = q.eq('result', result);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/quality — log quality test
router.post('/', auth, async (req, res) => {
  try {
    const { product_id, product_name, batch_id, batch_number, test_type, tested_by, parameters, result, notes } = req.body;
    if (!product_id || !test_type || !result) return res.status(400).json({ error: 'product_id, test_type, result required' });
    const { data, error } = await supabase.from('quality_tests')
      .insert({ product_id, product_name: product_name || '', batch_id: batch_id || null, batch_number: batch_number || '', test_type, tested_by: tested_by || '', parameters: parameters || {}, result, notes: notes || '', tested_at: new Date().toISOString() })
      .select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/quality/:id — update test record
router.patch('/:id', auth, async (req, res) => {
  try {
    const allowed = ['result','notes','parameters','remediation'];
    const updates = { updated_at: new Date().toISOString() };
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    const { data, error } = await supabase.from('quality_tests')
      .update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/quality/:id
router.delete('/:id', auth, async (req, res) => {
  const { error } = await supabase.from('quality_tests').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// GET /api/quality/stats — pass/fail summary by product
router.get('/stats', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('quality_tests')
      .select('product_id,product_name,result,test_type');
    if (error) return res.status(500).json({ error: error.message });
    const stats = {};
    for (const r of data || []) {
      if (!stats[r.product_id]) stats[r.product_id] = { product_name: r.product_name, pass: 0, fail: 0, hold: 0, total: 0 };
      stats[r.product_id][r.result] = (stats[r.product_id][r.result] || 0) + 1;
      stats[r.product_id].total++;
    }
    res.json(Object.entries(stats).map(([id, s]) => ({ product_id: id, ...s, pass_rate: s.total ? Math.round(s.pass / s.total * 100) : 0 })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
