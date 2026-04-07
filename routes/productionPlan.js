const express = require('express');
const router  = express.Router();
const { auth } = require('../middleware/auth');
const supabase = require('../config/supabase');

// Fuzzy name match (same as rawStock.js)
function nameMatches(source, materialName) {
  if (!source) return false;
  const s = source.toLowerCase().trim();
  const m = materialName.toLowerCase().trim();
  if (s === m) return true;
  if (m.startsWith(s) || s.startsWith(m)) return true;
  return false;
}

// Extract oil type from product name: "Groundnut Oil 1L" → "Groundnut"
function extractOilType(productName) {
  const oil_types = ['Groundnut', 'Sesame', 'Coconut', 'Castor', 'Neem', 'Mustard'];
  for (const t of oil_types) {
    if (productName.toLowerCase().includes(t.toLowerCase())) return t;
  }
  return null;
}

// Extract millet type from product name
function extractMilletType(productName) {
  const millets = ['Pearl Millet', 'Barnyard Millet', 'Finger Millet', 'Little Millet', 'Foxtail Millet', 'Kodo Millet', 'Sorghum Millet'];
  for (const m of millets) {
    if (productName.toLowerCase().includes(m.toLowerCase())) return m;
  }
  return null;
}

// GET /api/production-plan
// Returns:
//   pending_demand: [ { product_name, total_qty_needed, available_finished, shortfall, raw_material, raw_kg_needed } ]
//   raw_shortfalls: [ { material_name, kg_needed, kg_available, shortfall } ]
//   suggestions:    [ { action, priority, reason } ]
router.get('/', auth, async (req, res) => {
  try {
    // 1. Pending B2B orders (not shipped/delivered/cancelled)
    const { data: b2bOrders } = await supabase
      .from('b2b_orders')
      .select('id, order_no, buyer_name, stage, b2b_order_items(*)')
      .not('stage', 'in', '("shipped","delivered","cancelled","invoice_sent")');

    // 2. Finished goods summary
    const { data: fgMoves } = await supabase.from('finished_goods').select('product_name, qty, type');
    const fgBalance = {};
    for (const r of (fgMoves || [])) {
      if (!fgBalance[r.product_name]) fgBalance[r.product_name] = 0;
      fgBalance[r.product_name] += r.type === 'out' ? -parseFloat(r.qty) : parseFloat(r.qty);
    }

    // 3. Raw material calculated stock
    const { data: rawMats } = await supabase.from('raw_materials').select('*').eq('active', true);

    // 4. Recent oil batch yield per oil_type (avg from last 10 batches)
    const { data: oilBatches } = await supabase.from('batches')
      .select('oil_type, input_kg, oil_output')
      .order('date', { ascending: false }).limit(50);

    const yieldByType = {};
    for (const b of (oilBatches || [])) {
      if (!b.oil_type || !b.input_kg || !b.oil_output) continue;
      if (!yieldByType[b.oil_type]) yieldByType[b.oil_type] = { inputs: [], outputs: [] };
      yieldByType[b.oil_type].inputs.push(parseFloat(b.input_kg));
      yieldByType[b.oil_type].outputs.push(parseFloat(b.oil_output));
    }
    // avg kg seed per kg oil
    const seedPerOilKg = {};
    for (const [type, { inputs, outputs }] of Object.entries(yieldByType)) {
      const totalIn  = inputs.reduce((s,v)=>s+v,0);
      const totalOut = outputs.reduce((s,v)=>s+v,0);
      seedPerOilKg[type] = totalOut > 0 ? totalIn / totalOut : 3.5; // default 3.5kg seeds → 1kg oil
    }

    // 5. Flour batch yield (avg)
    const { data: flourBatches } = await supabase.from('flour_batches')
      .select('commodity, input_kg, cleaned_kg')
      .order('date', { ascending: false }).limit(50);

    const cleanYield = {};
    for (const f of (flourBatches || [])) {
      if (!f.commodity || !f.input_kg || !f.cleaned_kg) continue;
      if (!cleanYield[f.commodity]) cleanYield[f.commodity] = { ins: [], outs: [] };
      cleanYield[f.commodity].ins.push(parseFloat(f.input_kg));
      cleanYield[f.commodity].outs.push(parseFloat(f.cleaned_kg));
    }
    const rawPerCleanKg = {};
    for (const [comm, { ins, outs }] of Object.entries(cleanYield)) {
      const totalIn  = ins.reduce((s,v)=>s+v,0);
      const totalOut = outs.reduce((s,v)=>s+v,0);
      rawPerCleanKg[comm] = totalOut > 0 ? totalIn / totalOut : 1.1;
    }

    // 6. Aggregate demand from pending B2B orders
    const demandMap = {}; // product_name → { qty, orders: [] }
    for (const order of (b2bOrders || [])) {
      for (const item of (order.b2b_order_items || [])) {
        const pn = item.product_name || '';
        const qty = parseInt(item.qty) || 0;
        if (!pn || qty === 0) continue;
        if (!demandMap[pn]) demandMap[pn] = { product_name: pn, qty: 0, orders: [] };
        demandMap[pn].qty += qty;
        demandMap[pn].orders.push({ order_no: order.order_no, buyer: order.buyer_name, qty });
      }
    }

    // 7. Build pending demand with finished goods shortfall and raw material need
    const rawNeed = {}; // raw_material_name → kg_needed
    const pendingDemand = Object.values(demandMap).map(d => {
      const available = Math.max(0, fgBalance[d.product_name] || 0);
      const shortfall = Math.max(0, d.qty - available);

      let rawMaterial = null;
      let rawKgNeeded = 0;

      // Determine raw material need from shortfall
      const oilType = extractOilType(d.product_name);
      const milletType = extractMilletType(d.product_name);

      // Extract size in ml/L/g/kg from product name
      const sizeMatch = d.product_name.match(/(\d+(?:\.\d+)?)\s*(ml|ML|L|g|gm|GM|kg|KG)/i);
      let volumeL = 0;
      if (sizeMatch) {
        const num = parseFloat(sizeMatch[1]);
        const unit = sizeMatch[2].toLowerCase();
        if (unit === 'ml') volumeL = num / 1000;
        else if (unit === 'l') volumeL = num;
        else if (unit === 'g' || unit === 'gm') volumeL = num / 1000; // kg for millet
        else if (unit === 'kg') volumeL = num;
      }

      if (oilType && shortfall > 0 && volumeL > 0) {
        // shortfall units × volumeL(L) × ~0.92(kg/L) = oil kg needed
        const oilKgNeeded = shortfall * volumeL * 0.92;
        const ratio = seedPerOilKg[oilType] || 3.5;
        rawKgNeeded = Math.ceil(oilKgNeeded * ratio * 1.05); // 5% buffer
        rawMaterial = `${oilType} Seeds`;
        if (rawNeed[rawMaterial]) rawNeed[rawMaterial] += rawKgNeeded;
        else rawNeed[rawMaterial] = rawKgNeeded;
      } else if (milletType && shortfall > 0 && volumeL > 0) {
        const cleanedKgNeeded = shortfall * volumeL;
        const ratio = rawPerCleanKg[milletType] || 1.1;
        rawKgNeeded = Math.ceil(cleanedKgNeeded * ratio * 1.05);
        rawMaterial = milletType;
        if (rawNeed[rawMaterial]) rawNeed[rawMaterial] += rawKgNeeded;
        else rawNeed[rawMaterial] = rawKgNeeded;
      }

      return { product_name: d.product_name, total_qty: d.qty, available_finished: available, shortfall, raw_material: rawMaterial, raw_kg_needed: rawKgNeeded, orders: d.orders };
    }).sort((a, b) => b.shortfall - a.shortfall);

    // 8. Check raw material availability
    const rawShortfalls = Object.entries(rawNeed).map(([name, kgNeeded]) => {
      const mat = (rawMats || []).find(m => nameMatches(name, m.name));
      const available = parseFloat(mat?.current_stock || 0);
      return { material_name: name, kg_needed: kgNeeded, kg_available: available, shortfall: Math.max(0, kgNeeded - available) };
    }).sort((a, b) => b.shortfall - a.shortfall);

    // 9. Generate action suggestions
    const suggestions = [];
    for (const d of pendingDemand.filter(d => d.shortfall > 0)) {
      const priority = d.shortfall >= 50 ? 'high' : d.shortfall >= 10 ? 'medium' : 'low';
      suggestions.push({
        priority,
        action: d.raw_material
          ? `Produce ${d.shortfall} units of ${d.product_name} — need ~${d.raw_kg_needed}kg ${d.raw_material}`
          : `Pack ${d.shortfall} units of ${d.product_name}`,
        reason: `${d.orders.length} B2B order${d.orders.length>1?'s':''} pending (${d.orders.map(o=>o.order_no).join(', ')})`,
      });
    }
    for (const r of rawShortfalls.filter(r => r.shortfall > 0)) {
      suggestions.push({
        priority: 'high',
        action: `Procure ${r.shortfall}kg more ${r.material_name}`,
        reason: `Only ${r.kg_available}kg available, ${r.kg_needed}kg needed for pending orders`,
      });
    }

    res.json({ pending_demand: pendingDemand, raw_shortfalls: rawShortfalls, suggestions, b2b_order_count: (b2bOrders||[]).length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
