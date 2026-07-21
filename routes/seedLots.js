const express = require('express');
const router  = express.Router();
const { auth, requireRole } = require('../middleware/auth');
const supabase = require('../config/supabase');

const toNum = v => parseFloat(v) || 0;

// ── GET / — List procurements with cleaning status ────────────────────────────
router.get('/', auth, async (req, res) => {
  const { data, error } = await supabase.from('procurements')
    .select('id,date,commodity_name,supplier,ordered_qty,received_qty,cleaned_qty,ordered_price_per_kg,gst,transport_cost,status,cleaning_status,total_cleaned_kg,total_waste_kg,final_loss_pct,cleaning_started_date,cleaning_completed_date')
    .order('date', { ascending: false }).limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── GET /:procId/entries — Cleaning entries for a lot ─────────────────────────
router.get('/:procId/entries', auth, async (req, res) => {
  const { data, error } = await supabase.from('seed_cleaning_entries')
    .select('*').eq('procurement_id', req.params.procId)
    .order('date', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── Recalc helper — update procurement running totals from entries ─────────────
async function recalcTotals(procId) {
  const { data: entries } = await supabase.from('seed_cleaning_entries')
    .select('input_kg,cleaned_kg').eq('procurement_id', procId);
  const totalInput = (entries || []).reduce((s, e) => s + toNum(e.input_kg), 0);
  const totalCleaned = (entries || []).reduce((s, e) => s + toNum(e.cleaned_kg), 0);
  const totalWaste = totalInput - totalCleaned;
  const status = (entries || []).length > 0 ? 'cleaning' : 'open';
  await supabase.from('procurements').update({
    total_cleaned_kg: Math.round(totalCleaned * 100) / 100,
    total_waste_kg: Math.round(totalWaste * 100) / 100,
    cleaned_qty: Math.round(totalCleaned * 100) / 100,
    cleaning_status: status,
    cleaning_started_date: (entries || []).length > 0 ? entries[0].date || null : null,
  }).eq('id', procId);
  return { totalInput, totalCleaned, totalWaste, entryCount: (entries || []).length };
}

// ── POST /:procId/entries — Add cleaning entry ────────────────────────────────
router.post('/:procId/entries', auth, requireRole('admin', 'manager'), async (req, res) => {
  const procId = req.params.procId;
  const { date, inputKg, cleanedKg, wasteReason, notes } = req.body;
  if (!date || !inputKg || cleanedKg == null) return res.status(400).json({ error: 'date, inputKg, cleanedKg required' });
  if (toNum(cleanedKg) > toNum(inputKg)) return res.status(400).json({ error: 'cleanedKg cannot exceed inputKg' });

  // Check procurement exists
  const { data: proc } = await supabase.from('procurements').select('id,received_qty,cleaning_status').eq('id', procId).single();
  if (!proc) return res.status(404).json({ error: 'Procurement not found' });
  if (proc.cleaning_status === 'fully_cleaned' || proc.cleaning_status === 'closed')
    return res.status(400).json({ error: 'Lot already finalized — reopen first' });

  // Check not exceeding received qty
  const { data: existing } = await supabase.from('seed_cleaning_entries')
    .select('input_kg').eq('procurement_id', procId);
  const totalSoFar = (existing || []).reduce((s, e) => s + toNum(e.input_kg), 0);
  if (totalSoFar + toNum(inputKg) > toNum(proc.received_qty) + 0.5)
    return res.status(400).json({ error: `Cannot exceed received qty (${proc.received_qty} kg). Already cleaned input: ${totalSoFar} kg` });

  const { data: entry, error } = await supabase.from('seed_cleaning_entries').insert({
    procurement_id: procId,
    date,
    input_kg: toNum(inputKg),
    cleaned_kg: toNum(cleanedKg),
    waste_reason: wasteReason || 'Cleaning loss',
    notes: notes || '',
    logged_by: req.user?.name || req.user?.username || '',
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });

  const totals = await recalcTotals(procId);
  res.status(201).json({ entry, totals });
});

// ── PUT /:procId/entries/:id — Update cleaning entry ──────────────────────────
router.put('/:procId/entries/:id', auth, requireRole('admin', 'manager'), async (req, res) => {
  const { date, inputKg, cleanedKg, wasteReason, notes } = req.body;
  const u = {};
  if (date) u.date = date;
  if (inputKg != null) u.input_kg = toNum(inputKg);
  if (cleanedKg != null) u.cleaned_kg = toNum(cleanedKg);
  if (wasteReason != null) u.waste_reason = wasteReason;
  if (notes != null) u.notes = notes;

  const { data, error } = await supabase.from('seed_cleaning_entries')
    .update(u).eq('id', req.params.id).eq('procurement_id', req.params.procId).select().single();
  if (error) return res.status(400).json({ error: error.message });

  const totals = await recalcTotals(req.params.procId);
  res.json({ entry: data, totals });
});

// ── DELETE /:procId/entries/:id — Delete cleaning entry ───────────────────────
router.delete('/:procId/entries/:id', auth, requireRole('admin', 'manager'), async (req, res) => {
  const { error } = await supabase.from('seed_cleaning_entries')
    .delete().eq('id', req.params.id).eq('procurement_id', req.params.procId);
  if (error) return res.status(400).json({ error: error.message });
  const totals = await recalcTotals(req.params.procId);
  res.json({ success: true, totals });
});

// ── POST /:procId/finalize — Mark lot as fully cleaned ────────────────────────
router.post('/:procId/finalize', auth, requireRole('admin', 'manager'), async (req, res) => {
  const procId = req.params.procId;
  const { data: proc } = await supabase.from('procurements')
    .select('received_qty,total_cleaned_kg,total_waste_kg').eq('id', procId).single();
  if (!proc) return res.status(404).json({ error: 'Not found' });

  const { data: entries } = await supabase.from('seed_cleaning_entries')
    .select('input_kg').eq('procurement_id', procId);
  const totalInput = (entries || []).reduce((s, e) => s + toNum(e.input_kg), 0);
  const received = toNum(proc.received_qty);
  const remaining = received - totalInput;

  if (remaining > 1) return res.status(400).json({
    error: `${remaining.toFixed(1)} kg still uncleaned. Clean or adjust before finalizing.`
  });

  const lossPct = received > 0 ? (toNum(proc.total_waste_kg) / received) * 100 : 0;
  const { data, error } = await supabase.from('procurements').update({
    cleaning_status: 'fully_cleaned',
    final_loss_pct: Math.round(lossPct * 100) / 100,
    cleaning_completed_date: new Date().toISOString().slice(0, 10),
  }).eq('id', procId).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ── POST /:procId/reopen — Reopen a finalized lot ─────────────────────────────
router.post('/:procId/reopen', auth, requireRole('admin'), async (req, res) => {
  const { data, error } = await supabase.from('procurements').update({
    cleaning_status: 'cleaning',
    final_loss_pct: null,
    cleaning_completed_date: null,
  }).eq('id', req.params.procId).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ── GET /:procId/predict — AI prediction for lot ──────────────────────────────
router.get('/:procId/predict', auth, async (req, res) => {
  const procId = req.params.procId;
  const { data: proc } = await supabase.from('procurements')
    .select('*').eq('id', procId).single();
  if (!proc) return res.status(404).json({ error: 'Not found' });

  const { data: entries } = await supabase.from('seed_cleaning_entries')
    .select('*').eq('procurement_id', procId).order('date');
  if (!entries || entries.length < 3)
    return res.status(400).json({ error: 'Need at least 3 cleaning entries for prediction' });

  const received = toNum(proc.received_qty);
  const totalInput = entries.reduce((s, e) => s + toNum(e.input_kg), 0);
  const totalCleaned = entries.reduce((s, e) => s + toNum(e.cleaned_kg), 0);
  const totalWaste = totalInput - totalCleaned;
  const remaining = received - totalInput;
  const runningLossPct = totalInput > 0 ? (totalWaste / totalInput) * 100 : 0;
  const dailyAvgInput = totalInput / entries.length;
  const daysRemaining = dailyAvgInput > 0 ? Math.ceil(remaining / dailyAvgInput) : 0;

  // Historical comparison — completed lots of same commodity
  const commodity = (proc.commodity_name || '').toLowerCase();
  const { data: completedProcs } = await supabase.from('procurements')
    .select('final_loss_pct,commodity_name')
    .eq('cleaning_status', 'fully_cleaned');
  const histLots = (completedProcs || []).filter(p =>
    (p.commodity_name || '').toLowerCase().includes(commodity.split(' ')[0]) && p.final_loss_pct != null
  );
  const histAvg = histLots.length > 0 ? histLots.reduce((s, p) => s + toNum(p.final_loss_pct), 0) / histLots.length : null;
  const histStd = histLots.length > 1 ? Math.sqrt(histLots.reduce((s, p) => s + Math.pow(toNum(p.final_loss_pct) - histAvg, 2), 0) / histLots.length) : 2;

  const anomalyFlag = histAvg !== null && runningLossPct > histAvg + 2 * histStd;
  const anomalyDetail = anomalyFlag
    ? `Current loss ${runningLossPct.toFixed(1)}% is significantly higher than historical avg ${histAvg.toFixed(1)}% (±${histStd.toFixed(1)}%)`
    : null;

  // Trend: loss rate per entry (detect if getting worse)
  const entryLosses = entries.map(e => {
    const inp = toNum(e.input_kg); const cl = toNum(e.cleaned_kg);
    return inp > 0 ? ((inp - cl) / inp) * 100 : 0;
  });
  const recentAvg = entryLosses.slice(-3).reduce((s, v) => s + v, 0) / Math.min(3, entryLosses.length);
  const earlyAvg = entryLosses.slice(0, 3).reduce((s, v) => s + v, 0) / Math.min(3, entryLosses.length);
  const trendWorsening = recentAvg > earlyAvg + 1;

  const prediction = {
    procurement_id: procId,
    predicted_total_loss_pct: Math.round(runningLossPct * 100) / 100,
    predicted_days_remaining: daysRemaining,
    anomaly_flag: anomalyFlag,
    anomaly_detail: anomalyDetail,
    confidence: Math.min(0.95, 0.5 + entries.length * 0.05),
    remaining_kg: Math.round(remaining * 100) / 100,
    daily_avg_input: Math.round(dailyAvgInput * 100) / 100,
    running_loss_pct: Math.round(runningLossPct * 100) / 100,
    historical_avg_loss: histAvg !== null ? Math.round(histAvg * 100) / 100 : null,
    historical_lots_count: histLots.length,
    trend_worsening: trendWorsening,
    trend_detail: trendWorsening ? `Recent loss rate (${recentAvg.toFixed(1)}%) is higher than early batches (${earlyAvg.toFixed(1)}%)` : null,
    entry_count: entries.length,
  };

  // Cache prediction
  await supabase.from('seed_lot_predictions').insert({
    procurement_id: procId,
    predicted_total_loss_pct: prediction.predicted_total_loss_pct,
    predicted_days_remaining: prediction.predicted_days_remaining,
    anomaly_flag: prediction.anomaly_flag,
    anomaly_detail: prediction.anomaly_detail,
    confidence: prediction.confidence,
    model_inputs: prediction,
  });

  res.json(prediction);
});

module.exports = router;
