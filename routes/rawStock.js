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

// ── GET usage-report — raw material consumption & procurement over time periods ──
router.get('/usage-report', auth, async (req, res) => {
  try {
    const now = new Date();
    const istOffset = 5.5 * 3600000;
    const istNow = new Date(now.getTime() + istOffset);
    const todayIST = istNow.toISOString().slice(0, 10);

    const todayStart = todayIST;
    const weekStart  = new Date(istNow.getTime() - 7 * 86400000).toISOString().slice(0, 10);
    const monthStart = new Date(istNow.getFullYear(), istNow.getMonth(), 1).toISOString().slice(0, 10);
    const qStart     = new Date(istNow.getFullYear(), Math.floor(istNow.getMonth() / 3) * 3, 1).toISOString().slice(0, 10);
    const yearStart  = istNow.getFullYear() + '-01-01';

    // Fetch materials + products (for sale-to-raw-material mapping)
    const { data: materials } = await supabase.from('raw_materials').select('*').eq('active', true);
    const { data: products } = await supabase.from('products').select('id, name, pack_size, pack_unit, oil_type_key, raw_mat_key, cat');

    // Build product lookup: product_id → { pack_size_kg, raw_mat_key/oil_type_key }
    const prodMap = {};
    (products || []).forEach(p => {
      const ps = parseFloat(p.pack_size || 0);
      const pu = (p.pack_unit || '').toLowerCase();
      // Convert pack_size to kg
      let packKg = 0;
      if (pu === 'kg') packKg = ps;
      else if (pu === 'g' || pu === 'gm' || pu === 'gms') packKg = ps / 1000;
      else if (pu === 'l' || pu === 'ltr' || pu === 'litre' || pu === 'litres') packKg = ps; // 1L ≈ 1kg for oils
      else if (pu === 'ml') packKg = ps / 1000;
      prodMap[p.id] = { name: p.name, packKg, oilKey: p.oil_type_key || '', rawKey: p.raw_mat_key || '', cat: p.cat || '' };
    });

    // Helper: find which raw material a product maps to
    // For oil products: match to the OIL raw material (tank), not the SEED
    // e.g., "Groundnut Oil 1L" → "Groundnut Oil", NOT "Groundnut Seeds"
    function findRawMat(prod, matList) {
      const pName = (prod.name || '').toLowerCase();
      const isOilProduct = pName.includes('oil');

      // Try raw_mat_key first (explicit mapping — most reliable)
      if (prod.rawKey) {
        for (const m of matList) {
          if (nameMatches(prod.rawKey, m.name)) return m;
        }
      }

      // Try oil_type_key for oil products — match to OIL material, not SEED
      if (prod.oilKey) {
        const oilKey = prod.oilKey.toLowerCase();
        // First try: find "[oilKey] Oil" raw material (e.g., "Groundnut Oil")
        for (const m of matList) {
          const mn = m.name.toLowerCase();
          if (mn.includes(oilKey) && mn.includes('oil')) return m;
        }
        // If no oil material found, fall back to seed (for seed products like "Sesame Seeds 500g")
        if (!isOilProduct) {
          for (const m of matList) {
            if (nameMatches(prod.oilKey, m.name)) return m;
          }
        }
      }

      // Fuzzy name match — but for oil products, prefer oil materials
      if (isOilProduct) {
        // First pass: match only oil raw materials
        for (const m of matList) {
          if (m.name.toLowerCase().includes('oil') && nameMatches(prod.name, m.name)) return m;
        }
      }

      // General fuzzy match
      for (const m of matList) {
        if (nameMatches(prod.name, m.name)) return m;
      }
      return null;
    }

    // Fetch all data sources
    const [procRes, oilRes, flourRes, spiceRes, wsRes, saleItemsRes, b2bItemsRes] = await Promise.all([
      supabase.from('procurements').select('date, commodity_name, cleaned_qty, received_qty, status')
        .in('status', ['received', 'stocked', 'cleaned']).gte('date', yearStart),
      supabase.from('batches').select('date, oil_type, input_kg').gte('date', yearStart),
      supabase.from('flour_batches').select('date, commodity, input_kg').gte('date', yearStart),
      supabase.from('spice_powder_batches').select('date, ingredients').gte('date', yearStart).then(r => r).catch(() => ({ data: [] })),
      // Sales channels
      supabase.from('webstore_orders').select('date, items, status')
        .not('status', 'in', '("cancelled","rejected")').gte('date', yearStart),
      supabase.from('sale_items').select('product_id, product_name, qty, sales!inner(date, status)')
        .not('sales.status', 'in', '("cancelled","rejected")').gte('sales.date', yearStart),
      supabase.from('b2b_order_items').select('product_id, product_name, qty, b2b_orders!inner(date, stage)')
        .not('b2b_orders.stage', 'in', '("cancelled","rejected")').gte('b2b_orders.date', yearStart)
        .then(r => r).catch(() => ({ data: [] })),
    ]);

    const procs = procRes.data || [];
    const oilBatches = oilRes.data || [];
    const flourBatches = flourRes.data || [];
    const spiceBatches = spiceRes.data || [];

    // Build flat list of sold items: { date, product_id, product_name, qty }
    const soldItems = [];

    // Webstore orders
    (wsRes.data || []).forEach(o => {
      const orderItems = Array.isArray(o.items) ? o.items : [];
      orderItems.forEach(it => {
        soldItems.push({ date: o.date, productId: it.id || it.product_id, productName: it.name || it.productName || '', qty: parseFloat(it.qty || 0), channel: 'web' });
      });
    });

    // POS sales (via sale_items join)
    (saleItemsRes.data || []).forEach(si => {
      const d = si.sales?.date;
      if (!d) return;
      soldItems.push({ date: d, productId: si.product_id, productName: si.product_name || '', qty: parseFloat(si.qty || 0), channel: 'pos' });
    });

    // B2B orders (via b2b_order_items join)
    (b2bItemsRes.data || []).forEach(bi => {
      const d = bi.b2b_orders?.date;
      if (!d) return;
      soldItems.push({ date: d, productId: bi.product_id, productName: bi.product_name || '', qty: parseFloat(bi.qty || 0), channel: 'b2b' });
    });

    const periods = ['today', 'week', 'month', 'quarter', 'year'];
    const cutoffs = { today: todayStart, week: weekStart, month: monthStart, quarter: qStart, year: yearStart };

    const matList = materials || [];

    const items = matList.map(mat => {
      const row = {
        id: mat.id, name: mat.name, category: mat.category || 'other',
        current_stock: parseFloat(mat.current_stock || 0),
        min_stock: parseFloat(mat.min_stock || 0),
        unit: mat.unit || 'kg',
        // Consumption (OUT) per period — split by source
        out_today: 0, out_week: 0, out_month: 0, out_quarter: 0, out_year: 0,
        // Sales OUT per period (subset of out_*)
        sales_today: 0, sales_week: 0, sales_month: 0, sales_quarter: 0, sales_year: 0,
        // Batch OUT per period (subset of out_*)
        batch_today: 0, batch_week: 0, batch_month: 0, batch_quarter: 0, batch_year: 0,
        // Procurement (IN) per period
        in_today: 0, in_week: 0, in_month: 0, in_quarter: 0, in_year: 0,
      };

      const addOut = (d, qty, source) => {
        if (d >= todayStart) { row.out_today += qty; row[source+'_today'] += qty; }
        if (d >= weekStart)  { row.out_week += qty;  row[source+'_week'] += qty; }
        if (d >= monthStart) { row.out_month += qty; row[source+'_month'] += qty; }
        if (d >= qStart)     { row.out_quarter += qty; row[source+'_quarter'] += qty; }
        if (d >= yearStart)  { row.out_year += qty; row[source+'_year'] += qty; }
      };

      // Procurement IN
      for (const p of procs) {
        if (!nameMatches(p.commodity_name, mat.name)) continue;
        const qty = parseFloat(p.cleaned_qty || p.received_qty || 0);
        if (qty <= 0) continue;
        const d = p.date;
        if (d >= todayStart) row.in_today += qty;
        if (d >= weekStart)  row.in_week += qty;
        if (d >= monthStart) row.in_month += qty;
        if (d >= qStart)     row.in_quarter += qty;
        if (d >= yearStart)  row.in_year += qty;
      }

      // Oil batch consumption (seeds pressed into oil)
      if (mat.category === 'oil_seed') {
        for (const b of oilBatches) {
          if (!nameMatches(b.oil_type, mat.name)) continue;
          const qty = parseFloat(b.input_kg || 0);
          if (qty > 0) addOut(b.date, qty, 'batch');
        }
      }

      // Flour batch consumption
      if (mat.category === 'millet' || mat.category === 'grain') {
        for (const f of flourBatches) {
          if (!nameMatches(f.commodity, mat.name)) continue;
          const qty = parseFloat(f.input_kg || 0);
          if (qty > 0) addOut(f.date, qty, 'batch');
        }
      }

      // Spice batch consumption
      if (mat.category === 'spice' || mat.category === 'other') {
        for (const sb of spiceBatches) {
          const ingredients = Array.isArray(sb.ingredients) ? sb.ingredients : [];
          for (const ing of ingredients) {
            const ingName = ing.name || ing.commodity || '';
            if (!nameMatches(ingName, mat.name)) continue;
            const qty = parseFloat(ing.qty || ing.amount_kg || 0);
            if (qty > 0) addOut(sb.date, qty, 'batch');
          }
        }
      }

      return row;
    });

    // Sales consumption: map each sold product to its raw material
    for (const si of soldItems) {
      const prod = prodMap[si.productId];
      if (!prod) continue;
      const mat = findRawMat(prod, matList);
      if (!mat) continue;
      const kgUsed = si.qty * (prod.packKg || 0);
      if (kgUsed <= 0) continue;

      // Find the row for this material
      const row = items.find(it => it.id === mat.id);
      if (!row) continue;

      const d = si.date;
      if (d >= todayStart) { row.out_today += kgUsed; row.sales_today += kgUsed; }
      if (d >= weekStart)  { row.out_week += kgUsed;  row.sales_week += kgUsed; }
      if (d >= monthStart) { row.out_month += kgUsed; row.sales_month += kgUsed; }
      if (d >= qStart)     { row.out_quarter += kgUsed; row.sales_quarter += kgUsed; }
      if (d >= yearStart)  { row.out_year += kgUsed; row.sales_year += kgUsed; }
    }

    // Totals
    const totals = { out: {}, in: {}, sales: {}, batch: {} };
    for (const p of periods) { totals.out[p] = 0; totals.in[p] = 0; totals.sales[p] = 0; totals.batch[p] = 0; }
    items.forEach(it => {
      for (const p of periods) {
        totals.out[p] += it['out_' + p];
        totals.in[p]  += it['in_' + p];
        totals.sales[p] += it['sales_' + p];
        totals.batch[p] += it['batch_' + p];
      }
    });

    res.json({ items: items.sort((a, b) => b.out_year - a.out_year), totals, periods: cutoffs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
