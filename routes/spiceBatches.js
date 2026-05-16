const express = require('express');
const supabase = require('../config/supabase');
const { auth, requireRole } = require('../middleware/auth');
const router = express.Router();

const calcCosts = (b) => {
  const ingredients = Array.isArray(b.ingredients) ? b.ingredients : [];
  const totalIngredientCost = ingredients.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
  const sentToMillKg = parseFloat(b.sentToMillKg || b.sent_to_mill_kg) || 0;
  const grindingChargePerKg = parseFloat(b.grindingChargePerKg || b.grinding_charge_per_kg) || 0;
  const totalGrindingCharge = sentToMillKg * grindingChargePerKg;
  const totalCost = totalIngredientCost + totalGrindingCharge;
  const totalOutputKg = parseFloat(b.totalOutputKg || b.total_output_kg) || 0;
  const costPerKg = totalOutputKg > 0 ? totalCost / totalOutputKg : 0;
  return { totalIngredientCost, totalGrindingCharge, totalCost, costPerKg };
};

const mapRow = (b) => ({
  ...b,
  productName:          b.product_name           || '',
  totalRawInputKg:      b.total_raw_input_kg     || 0,
  afterDryingKg:        b.after_drying_kg        || 0,
  totalOutputKg:        b.total_output_kg        || 0,
  sentToMillKg:         b.sent_to_mill_kg        || 0,
  grindingChargePerKg:  b.grinding_charge_per_kg || 0,
  ingredients:          b.ingredients            || [],
  totalIngredientCost:  b.total_ingredient_cost  || 0,
  totalGrindingCharge:  b.total_grinding_charge  || 0,
  totalCost:            b.total_cost             || 0,
  costPerKg:            b.cost_per_kg            || 0,
  createdBy:            b.created_by             || '',
});

router.get('/', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('spice_batches')
    .select('*')
    .order('date', { ascending: false })
    .limit(500);
  if (error) return res.status(500).json({ error: error.message });
  res.json((data || []).map(mapRow));
});

router.post('/', auth, requireRole('admin', 'manager'), async (req, res) => {
  const b = req.body;
  const { totalIngredientCost, totalGrindingCharge, totalCost, costPerKg } = calcCosts(b);
  const row = {
    id:                     b.id || ('spb-' + Date.now()),
    date:                   b.date,
    product_name:           b.productName || '',
    total_raw_input_kg:     parseFloat(b.totalRawInputKg) || 0,
    after_drying_kg:        parseFloat(b.afterDryingKg) || 0,
    total_output_kg:        parseFloat(b.totalOutputKg) || 0,
    sent_to_mill_kg:        parseFloat(b.sentToMillKg) || 0,
    grinding_charge_per_kg: parseFloat(b.grindingChargePerKg) || 0,
    ingredients:            Array.isArray(b.ingredients) ? b.ingredients : [],
    total_ingredient_cost:  totalIngredientCost,
    total_grinding_charge:  totalGrindingCharge,
    total_cost:             totalCost,
    cost_per_kg:            costPerKg,
    notes:                  b.notes || '',
    created_by:             b.createdBy || '',
  };
  const { data, error } = await supabase.from('spice_batches').insert(row).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(mapRow(data));
});

router.put('/:id', auth, requireRole('admin', 'manager'), async (req, res) => {
  const b = req.body;
  const { totalIngredientCost, totalGrindingCharge, totalCost, costPerKg } = calcCosts(b);
  const { data, error } = await supabase.from('spice_batches').update({
    date:                   b.date,
    product_name:           b.productName || '',
    total_raw_input_kg:     parseFloat(b.totalRawInputKg) || 0,
    after_drying_kg:        parseFloat(b.afterDryingKg) || 0,
    total_output_kg:        parseFloat(b.totalOutputKg) || 0,
    sent_to_mill_kg:        parseFloat(b.sentToMillKg) || 0,
    grinding_charge_per_kg: parseFloat(b.grindingChargePerKg) || 0,
    ingredients:            Array.isArray(b.ingredients) ? b.ingredients : [],
    total_ingredient_cost:  totalIngredientCost,
    total_grinding_charge:  totalGrindingCharge,
    total_cost:             totalCost,
    cost_per_kg:            costPerKg,
    notes:                  b.notes || '',
  }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(mapRow(data));
});

router.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  const { error } = await supabase.from('spice_batches').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Deleted' });
});

module.exports = router;
