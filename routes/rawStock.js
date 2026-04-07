const express = require('express');
const router  = express.Router();
const { auth, requireRole } = require('../middleware/auth');
const supabase = require('../config/supabase');

const DEFAULT_MATERIALS = [
  // Oil Seeds
  { name:'Groundnut Seeds',  category:'oil_seed', unit:'kg' },
  { name:'Sesame Seeds',     category:'oil_seed', unit:'kg' },
  { name:'Coconut (Copra)',  category:'oil_seed', unit:'kg' },
  { name:'Castor Seeds',     category:'oil_seed', unit:'kg' },
  { name:'Neem Seeds',       category:'oil_seed', unit:'kg' },
  { name:'Mustard Seeds',    category:'oil_seed', unit:'kg' },
  // Millets
  { name:'Pearl Millet',     category:'millet', unit:'kg' },
  { name:'Barnyard Millet',  category:'millet', unit:'kg' },
  { name:'Finger Millet',    category:'millet', unit:'kg' },
  { name:'Little Millet',    category:'millet', unit:'kg' },
  { name:'Foxtail Millet',   category:'millet', unit:'kg' },
  { name:'Kodo Millet',      category:'millet', unit:'kg' },
  { name:'Sorghum Millet',   category:'millet', unit:'kg' },
];

// ── Name-based fuzzy matching ─────────────────────────────────────────────────
// Checks whether a source string (commodity_name / oil_type / commodity) matches
// a raw_material name. Uses starts-with in either direction for partial names.
function nameMatches(source, materialName) {
  if (!source) return false;
  const s = source.toLowerCase().trim();
  const m = materialName.toLowerCase().trim();
  if (s === m) return true;
  // "Groundnut" matches "Groundnut Seeds"; "Sesame" matches "Sesame Seeds"
  if (m.startsWith(s) || s.startsWith(m)) return true;
  // "Groundnut Seeds" procurement matches "Groundnut Seeds" material
  return false;
}

// GET all materials
router.get('/', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('raw_materials')
    .select('*')
    .eq('active', true)
    .order('category')
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET calculated stock — auto-computed from procurement, oil batches, flour batches
// For each material:
//   calculated = last_physical_count + procurement_since_audit - consumption_since_audit
router.get('/calculated', auth, async (req, res) => {
  try {
    // 1. All active raw materials
    const { data: materials } = await supabase
      .from('raw_materials').select('*').eq('active', true)
      .order('category').order('name');

    // 2. Last audit log per material (most recent entry = last physical count baseline)
    const { data: allLogs } = await supabase
      .from('raw_material_log').select('material_id, log_date, quantity_kg')
      .order('log_date', { ascending: false });

    const lastAudit = {};
    for (const log of (allLogs || [])) {
      if (!lastAudit[log.material_id]) lastAudit[log.material_id] = log;
    }

    // 3. All procurement records (received or stocked)
    const { data: procs } = await supabase
      .from('procurements')
      .select('date, commodity_name, cleaned_qty, received_qty, status')
      .in('status', ['received', 'stocked', 'cleaned']);

    // 4. All oil batches
    const { data: oilBatches } = await supabase
      .from('batches').select('date, oil_type, input_kg');

    // 5. All flour batches
    const { data: flourBatches } = await supabase
      .from('flour_batches').select('date, commodity, input_kg');

    const result = (materials || []).map(mat => {
      const audit = lastAudit[mat.id];
      const baselineQty  = audit ? parseFloat(audit.quantity_kg) : 0;
      const baselineDate = audit ? audit.log_date : '2000-01-01';

      // Sum procurement IN since last audit
      let procuredIn = 0;
      const procBreakdown = [];
      for (const p of (procs || [])) {
        if (p.date < baselineDate) continue;
        if (!nameMatches(p.commodity_name, mat.name)) continue;
        const qty = parseFloat(p.cleaned_qty || p.received_qty || 0);
        if (qty > 0) {
          procuredIn += qty;
          procBreakdown.push({ date: p.date, qty, source: p.commodity_name });
        }
      }

      // Sum oil batch consumption OUT since last audit (only for oil_seed category)
      let batchConsumed = 0;
      const batchBreakdown = [];
      if (mat.category === 'oil_seed') {
        for (const b of (oilBatches || [])) {
          if (b.date < baselineDate) continue;
          if (!nameMatches(b.oil_type, mat.name)) continue;
          const qty = parseFloat(b.input_kg || 0);
          if (qty > 0) {
            batchConsumed += qty;
            batchBreakdown.push({ date: b.date, qty, source: `${b.oil_type} oil batch` });
          }
        }
      }

      // Sum flour batch consumption OUT since last audit (only for millet category)
      if (mat.category === 'millet') {
        for (const f of (flourBatches || [])) {
          if (f.date < baselineDate) continue;
          if (!nameMatches(f.commodity, mat.name)) continue;
          const qty = parseFloat(f.input_kg || 0);
          if (qty > 0) {
            batchConsumed += qty;
            batchBreakdown.push({ date: f.date, qty, source: `${f.commodity} cleaning batch` });
          }
        }
      }

      const calculated = Math.max(0, baselineQty + procuredIn - batchConsumed);
      const physical   = parseFloat(mat.current_stock || 0);
      const discrepancy = calculated - physical;

      return {
        ...mat,
        baseline_qty:   baselineQty,
        baseline_date:  audit ? baselineDate : null,
        procured_since: procuredIn,
        consumed_since: batchConsumed,
        calculated_stock: calculated,
        physical_stock:   physical,
        discrepancy,              // positive = system says more than physical (possible loss)
        proc_breakdown:   procBreakdown,
        batch_breakdown:  batchBreakdown,
      };
    });

    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET stock log for one material
router.get('/:id/log', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('raw_material_log')
    .select('*')
    .eq('material_id', req.params.id)
    .order('log_date', { ascending: false })
    .limit(30);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST add material
router.post('/', auth, requireRole('admin','manager'), async (req, res) => {
  const { name, category, unit, current_stock, min_stock, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const { data, error } = await supabase.from('raw_materials').insert({
    name: name.trim(), category: category||'other', unit: unit||'kg',
    current_stock: parseFloat(current_stock)||0,
    min_stock: parseFloat(min_stock)||0,
    notes: notes||'', active: true, updated_at: new Date().toISOString(),
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PUT record physical count (audit)
// Sets current_stock = physical count; logs the entry
router.put('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  const { current_stock, min_stock, notes, name, category } = req.body;
  const today = new Date().toISOString().slice(0,10);

  const { data: cur } = await supabase.from('raw_materials').select('current_stock').eq('id', req.params.id).single();
  const prevQty = parseFloat(cur?.current_stock || 0);
  const newQty  = parseFloat(current_stock);

  const u = { updated_at: new Date().toISOString() };
  if (current_stock != null) { u.current_stock = newQty; u.last_updated = today; u.updated_by = req.user?.name||req.user?.email||''; }
  if (min_stock  != null) u.min_stock  = parseFloat(min_stock);
  if (notes      != null) u.notes      = notes;
  if (name       != null) u.name       = name.trim();
  if (category   != null) u.category   = category;

  const { data, error } = await supabase.from('raw_materials').update(u).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });

  if (current_stock != null) {
    await supabase.from('raw_material_log').insert({
      material_id: req.params.id, log_date: today,
      quantity_kg: newQty, previous_qty: prevQty,
      updated_by: req.user?.name||req.user?.email||'',
      notes: notes || 'Physical count',
    });
  }

  res.json(data);
});

// DELETE (soft)
router.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  await supabase.from('raw_materials').update({ active: false }).eq('id', req.params.id);
  res.json({ ok: true });
});

// POST seed defaults
router.post('/seed', auth, requireRole('admin'), async (req, res) => {
  const { data: existing } = await supabase.from('raw_materials').select('name');
  const existingNames = new Set((existing||[]).map(e => e.name));
  const toInsert = DEFAULT_MATERIALS
    .filter(m => !existingNames.has(m.name))
    .map(m => ({ ...m, current_stock:0, min_stock:0, notes:'', active:true, updated_at:new Date().toISOString() }));
  if (toInsert.length === 0) return res.json({ seeded: 0, message:'Already seeded' });
  const { data, error } = await supabase.from('raw_materials').insert(toInsert).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ seeded: (data||[]).length });
});

module.exports = router;
