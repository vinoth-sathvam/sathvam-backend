const express = require('express');
const supabase = require('../config/supabase');
const { auth, requireRole } = require('../middleware/auth');
const router = express.Router();

const mapRow = (b) => ({
  ...b,
  inputKg:         b.input_kg          || 0,
  rawPackingKg:    b.raw_packing_kg    || 0,
  cleanedKg:       b.cleaned_kg        || 0,
  sproutedKg:      b.sprouted_kg       || 0,
  sentToMillKg:    b.sent_to_mill_kg   || 0,
  flourReceivedKg: b.flour_received_kg || 0,
  rawRatePerKg:    b.raw_rate_per_kg   || 0,
  grindingCharge:  b.grinding_charge   || 0,
  labelCost:       b.label_cost        || 2,
  localProfit:     b.local_profit      || 25,
  webProfit:       b.web_profit        || 20,
  intlProfit:      b.intl_profit       || 15,
  createdBy:       b.created_by        || '',
  commodityId:     b.commodity_id      || '',
});

router.get('/', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('flour_batches')
    .select('*')
    .order('date', { ascending: false })
    .limit(2000);
  if (error) return res.status(500).json({ error: error.message });
  res.json((data || []).map(mapRow));
});

router.post('/', auth, requireRole('admin', 'manager'), async (req, res) => {
  const b = req.body;
  const row = {
    id:               b.id || ('fb-' + Date.now()),
    date:             b.date,
    commodity:        b.commodity || '',
    commodity_id:     b.commodityId || b.commodity_id || '',
    input_kg:         parseFloat(b.inputKg) || 0,
    raw_packing_kg:   parseFloat(b.rawPackingKg) || 0,
    cleaned_kg:       parseFloat(b.cleanedKg) || 0,
    sprouted_kg:      parseFloat(b.sproutedKg) || 0,
    sent_to_mill_kg:  parseFloat(b.sentToMillKg) || 0,
    flour_received_kg:parseFloat(b.flourReceivedKg) || 0,
    raw_rate_per_kg:  parseFloat(b.rawRatePerKg) || 0,
    grinding_charge:  parseFloat(b.grindingCharge) || 0,
    logistics:        parseFloat(b.logistics) || 0,
    label_cost:       parseFloat(b._labelCost ?? b.labelCost) || 2,
    local_profit:     parseFloat(b._localProfit ?? b.localProfit) || 25,
    web_profit:       parseFloat(b._webProfit ?? b.webProfit) || 20,
    intl_profit:      parseFloat(b._intlProfit ?? b.intlProfit) || 15,
    courier:          parseFloat(b._courier ?? b.courier) || 80,
    notes:            b.notes || '',
    created_by:       b.createdBy || '',
  };
  const { data, error } = await supabase.from('flour_batches').insert(row).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(mapRow(data));
});

router.put('/:id', auth, requireRole('admin', 'manager'), async (req, res) => {
  const b = req.body;
  const { data, error } = await supabase.from('flour_batches').update({
    date:             b.date,
    commodity:        b.commodity || '',
    commodity_id:     b.commodityId || b.commodity_id || '',
    input_kg:         parseFloat(b.inputKg) || 0,
    raw_packing_kg:   parseFloat(b.rawPackingKg) || 0,
    cleaned_kg:       parseFloat(b.cleanedKg) || 0,
    sprouted_kg:      parseFloat(b.sproutedKg) || 0,
    sent_to_mill_kg:  parseFloat(b.sentToMillKg) || 0,
    flour_received_kg:parseFloat(b.flourReceivedKg) || 0,
    raw_rate_per_kg:  parseFloat(b.rawRatePerKg) || 0,
    grinding_charge:  parseFloat(b.grindingCharge) || 0,
    logistics:        parseFloat(b.logistics) || 0,
    label_cost:       parseFloat(b._labelCost ?? b.labelCost) || 2,
    local_profit:     parseFloat(b._localProfit ?? b.localProfit) || 25,
    web_profit:       parseFloat(b._webProfit ?? b.webProfit) || 20,
    intl_profit:      parseFloat(b._intlProfit ?? b.intlProfit) || 15,
    courier:          parseFloat(b._courier ?? b.courier) || 80,
    notes:            b.notes || '',
  }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(mapRow(data));
});

router.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  const { error } = await supabase.from('flour_batches').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Deleted' });
});

// Bulk insert — used once to migrate existing localStorage data
router.post('/bulk', auth, requireRole('admin', 'manager'), async (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : [];
  if (rows.length === 0) return res.json({ synced: 0 });
  const ins = rows.map(b => ({
    id:               b.id || ('fb-' + Date.now() + Math.random()),
    date:             b.date || new Date().toISOString().slice(0, 10),
    commodity:        b.commodity || '',
    commodity_id:     b.commodityId || '',
    input_kg:         parseFloat(b.inputKg) || 0,
    raw_packing_kg:   parseFloat(b.rawPackingKg) || 0,
    cleaned_kg:       parseFloat(b.cleanedKg) || 0,
    sprouted_kg:      parseFloat(b.sproutedKg) || 0,
    sent_to_mill_kg:  parseFloat(b.sentToMillKg) || 0,
    flour_received_kg:parseFloat(b.flourReceivedKg) || 0,
    raw_rate_per_kg:  parseFloat(b.rawRatePerKg) || 0,
    grinding_charge:  parseFloat(b.grindingCharge) || 0,
    logistics:        parseFloat(b.logistics) || 0,
    label_cost:       parseFloat(b._labelCost ?? b.labelCost) || 2,
    local_profit:     parseFloat(b._localProfit ?? b.localProfit) || 25,
    web_profit:       parseFloat(b._webProfit ?? b.webProfit) || 20,
    intl_profit:      parseFloat(b._intlProfit ?? b.intlProfit) || 15,
    courier:          parseFloat(b._courier ?? b.courier) || 80,
    notes:            b.notes || '',
    created_by:       b.createdBy || '',
  }));
  const { data, error } = await supabase.from('flour_batches').upsert(ins, { onConflict: 'id' }).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ synced: (data || []).length });
});

module.exports = router;
