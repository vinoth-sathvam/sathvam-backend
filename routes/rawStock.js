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

// ── Category auto-detection from commodity name ─────────────────────────────
const CATEGORY_KEYWORDS = {
  oil_seed: ['groundnut','sesame','coconut','copra','castor','neem','mustard','sunflower','flax','safflower','oil seed','oilseed'],
  millet:   ['millet','ragi','kambu','thinai','varagu','kuthiraivali','samai','sorghum','bajra','jowar'],
  spice:    ['pepper','turmeric','chilli','chili','coriander','cumin','fenugreek','cardamom','cinnamon','clove','ginger','garlic','methi','kasthuri','masala','powder','spice','ajwain','fennel','star anise','nutmeg','saffron','asafoetida','hing'],
  grain:    ['rice','wheat','dal','dhal','lentil','gram','urad','moong','toor','chana','rajma','chickpea','barley','oats','maize','corn','flour','atta','besan','rawa','semolina','poha','jaggery','sugar'],
};

function guessCategory(name) {
  const n = (name || '').toLowerCase();
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    if (words.some(w => n.includes(w))) return cat;
  }
  return 'other';
}

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
  // Word overlap: "Kasthuri Methi Powder" matches "Kasthuri Methi"
  const sWords = s.split(/\s+/).filter(w => w.length > 2);
  const mWords = m.split(/\s+/).filter(w => w.length > 2);
  if (sWords.length >= 2 && mWords.length >= 2) {
    const overlap = sWords.filter(w => mWords.some(mw => mw.includes(w) || w.includes(mw)));
    if (overlap.length >= 2) return true;
  }
  return false;
}

// ── Auto-sync: discover new commodities from procurements ────────────────────
async function syncFromProcurements() {
  const { data: existing } = await supabase.from('raw_materials').select('name').eq('active', true);
  const existingNames = (existing || []).map(e => e.name.toLowerCase().trim());

  const { data: procs } = await supabase
    .from('procurements')
    .select('commodity_name')
    .in('status', ['received', 'stocked', 'cleaned']);

  // Get unique commodity names from procurements
  const seen = new Set();
  const newMaterials = [];
  for (const p of (procs || [])) {
    const name = (p.commodity_name || '').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());

    // Check if any existing material already matches this name
    const alreadyExists = existingNames.some(en => {
      if (en === name.toLowerCase()) return true;
      if (en.startsWith(name.toLowerCase()) || name.toLowerCase().startsWith(en)) return true;
      return false;
    });

    if (!alreadyExists) {
      newMaterials.push({
        name,
        category: guessCategory(name),
        unit: 'kg',
        current_stock: 0,
        min_stock: 0,
        notes: 'Auto-added from procurement records',
        active: true,
        updated_at: new Date().toISOString(),
      });
    }
  }

  if (newMaterials.length > 0) {
    await supabase.from('raw_materials').insert(newMaterials);
  }
  return newMaterials.length;
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

// GET calculated stock — auto-computed from procurement, oil batches, flour batches, spice batches
// For each material:
//   calculated = last_physical_count + procurement_since_audit - consumption_since_audit
router.get('/calculated', auth, async (req, res) => {
  try {
    // Auto-sync new commodities from procurements before calculating
    await syncFromProcurements();

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

    // 6. All spice powder batches (ingredients consumed)
    let spiceBatches = [];
    try {
      const { data: sb } = await supabase
        .from('spice_powder_batches').select('date, ingredients');
      spiceBatches = sb || [];
    } catch(e) { /* table may not exist */ }

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

      // Sum flour batch consumption OUT since last audit (for millet and grain categories)
      if (mat.category === 'millet' || mat.category === 'grain') {
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

      // Sum spice batch consumption OUT since last audit (for spice category)
      if (mat.category === 'spice' || mat.category === 'other') {
        for (const sb of spiceBatches) {
          if (sb.date < baselineDate) continue;
          const ingredients = Array.isArray(sb.ingredients) ? sb.ingredients : [];
          for (const ing of ingredients) {
            const ingName = ing.name || ing.commodity || '';
            if (!nameMatches(ingName, mat.name)) continue;
            const qty = parseFloat(ing.qty || ing.amount_kg || 0);
            if (qty > 0) {
              batchConsumed += qty;
              batchBreakdown.push({ date: sb.date, qty, source: `Spice batch: ${ingName}` });
            }
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

// POST seed defaults + auto-discover from procurements
router.post('/seed', auth, requireRole('admin'), async (req, res) => {
  const { data: existing } = await supabase.from('raw_materials').select('name');
  const existingNames = new Set((existing||[]).map(e => e.name));

  // 1. Seed hardcoded defaults
  const toInsert = DEFAULT_MATERIALS
    .filter(m => !existingNames.has(m.name))
    .map(m => ({ ...m, current_stock:0, min_stock:0, notes:'', active:true, updated_at:new Date().toISOString() }));

  let seeded = 0;
  if (toInsert.length > 0) {
    const { data } = await supabase.from('raw_materials').insert(toInsert).select();
    seeded += (data||[]).length;
  }

  // 2. Auto-discover from procurements
  const synced = await syncFromProcurements();
  seeded += synced;

  if (seeded === 0) return res.json({ seeded: 0, message: 'All materials already exist' });
  res.json({ seeded, message: `Added ${seeded} material${seeded>1?'s':''}` });
});

// POST sync from procurements (manual trigger)
router.post('/sync', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    const count = await syncFromProcurements();
    res.json({ synced: count, message: count > 0 ? `Added ${count} new material${count>1?'s':''}` : 'All procurement commodities already tracked' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
