const express = require('express');
const router  = express.Router();
const { auth, requireRole } = require('../middleware/auth');
const supabase = require('../config/supabase');

// GET all movements
router.get('/', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('finished_goods')
    .select('*')
    .order('date', { ascending: false })
    .limit(500);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET summary — current running balance per product
router.get('/summary', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('finished_goods')
    .select('product_name, category, unit, qty, type');
  if (error) return res.status(500).json({ error: error.message });

  const map = {};
  for (const r of (data || [])) {
    const key = r.product_name;
    if (!map[key]) map[key] = { product_name: key, category: r.category, unit: r.unit, balance: 0 };
    map[key].balance += r.type === 'out' ? -parseFloat(r.qty) : parseFloat(r.qty);
  }
  const result = Object.values(map)
    .map(r => ({ ...r, balance: Math.max(0, r.balance) }))
    .sort((a, b) => a.product_name.localeCompare(b.product_name));
  res.json(result);
});

// POST add movement (in or out)
router.post('/', auth, requireRole('admin','manager'), async (req, res) => {
  const { product_name, category, unit, qty, type, date, notes, batch_ref } = req.body;
  if (!product_name || !qty || !type) return res.status(400).json({ error: 'product_name, qty, type required' });
  if (!['in','out'].includes(type)) return res.status(400).json({ error: 'type must be in or out' });
  const { data, error } = await supabase.from('finished_goods').insert({
    product_name: product_name.trim(),
    category: category || 'other',
    unit: unit || 'pcs',
    qty: parseFloat(qty),
    type,
    date: date || new Date().toISOString().slice(0,10),
    notes: notes || '',
    batch_ref: batch_ref || '',
    created_by: req.user?.name || req.user?.email || '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PUT update movement
router.put('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  const { product_name, qty, type, date, notes, category, unit, batch_ref } = req.body;
  const u = { updated_at: new Date().toISOString() };
  if (product_name != null) u.product_name = product_name.trim();
  if (qty        != null) u.qty        = parseFloat(qty);
  if (type       != null) u.type       = type;
  if (date       != null) u.date       = date;
  if (notes      != null) u.notes      = notes;
  if (category   != null) u.category   = category;
  if (unit       != null) u.unit       = unit;
  if (batch_ref  != null) u.batch_ref  = batch_ref;
  const { data, error } = await supabase.from('finished_goods').update(u).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE
router.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  await supabase.from('finished_goods').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
