const express = require('express');
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');
const { insertLedger } = require('../utils/ledger');
const router = express.Router();

router.get('/', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('purchases')
    .select('*')
    .order('date', { ascending: false })
    .limit(2000);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/', auth, async (req, res) => {
  const p = req.body;
  const totalCost = (parseFloat(p.qty) || 0) * (parseFloat(p.pricePerKg) || 0);
  const { data, error } = await supabase.from('purchases').insert({
    date: p.date,
    material: p.material || '',
    qty: parseFloat(p.qty) || 0,
    price_per_kg: parseFloat(p.pricePerKg) || 0,
    notes: p.notes || '',
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });

  // Auto-feed money_ledger — procurement expense
  if (totalCost > 0) {
    insertLedger({
      txn_date:     p.date || new Date().toISOString().slice(0, 10),
      direction:    'out',
      amount:       totalCost,
      category:     'procurement',
      subcategory:  p.material || 'raw_material',
      party:        p.notes || '',
      party_type:   'vendor',
      payment_mode: 'bank_transfer',
      narration:    `Purchase: ${p.material || 'material'} ${p.qty}kg @ ₹${p.pricePerKg}/kg`,
      source_table: 'purchases',
      source_id:    String(data.id),
      created_by:   req.user?.name || req.user?.email || '',
    }).catch(() => {});
  }

  res.status(201).json(data);
});

router.put('/:id', auth, async (req, res) => {
  const p = req.body;
  const { data, error } = await supabase.from('purchases').update({
    date: p.date,
    material: p.material || '',
    qty: parseFloat(p.qty) || 0,
    price_per_kg: parseFloat(p.pricePerKg) || 0,
    notes: p.notes || '',
  }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

router.delete('/:id', auth, async (req, res) => {
  const { error } = await supabase.from('purchases').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Deleted' });
});

// Bulk replace — used once to migrate existing localStorage data
router.post('/bulk', auth, async (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : [];
  await supabase.from('purchases').delete().neq('id', 0);
  if (rows.length === 0) return res.json({ synced: 0 });
  const ins = rows.map(p => ({
    date: p.date || new Date().toISOString().slice(0, 10),
    material: p.material || '',
    qty: parseFloat(p.qty) || 0,
    price_per_kg: parseFloat(p.pricePerKg) || 0,
    notes: p.notes || '',
  }));
  const { error } = await supabase.from('purchases').insert(ins);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ synced: ins.length });
});

module.exports = router;
