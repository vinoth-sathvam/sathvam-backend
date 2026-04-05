const express = require('express');
const supabase = require('../config/supabase');
const { auth, requireRole } = require('../middleware/auth');
const router = express.Router();

router.get('/', auth, async (req, res) => {
  const { data, error } = await supabase.from('batches').select('*').order('date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/', auth, requireRole('admin','manager'), async (req, res) => {
  const b = req.body;
  const { data, error } = await supabase.from('batches').insert({
    date: b.date, oil_type: b.oilType || b.oil_type,
    input_kg: b.inputKg || b.input_kg,
    raw_price_per_kg: b.rawPricePerKg || b.raw_price_per_kg,
    oil_output: b.oilOutput || b.oil_output,
    cake_output: b.cakeOutput || b.cake_output,
    sugarcane_kg: b.sugarcaneKg || null,
    notes: b.notes || '', logged_by: req.user.name
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

router.put('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  const b = req.body;
  const { data, error } = await supabase.from('batches').update({
    date: b.date, oil_type: b.oilType || b.oil_type,
    input_kg: b.inputKg || b.input_kg,
    raw_price_per_kg: b.rawPricePerKg || b.raw_price_per_kg,
    oil_output: b.oilOutput || b.oil_output,
    cake_output: b.cakeOutput || b.cake_output,
    notes: b.notes
  }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

router.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  const { error } = await supabase.from('batches').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Deleted' });
});

module.exports = router;
