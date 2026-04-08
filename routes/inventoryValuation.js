const express = require('express');
const router  = express.Router();
const { auth } = require('../middleware/auth');
const supabase  = require('../config/supabase');

// ── GET /api/inventory-valuation ─────────────────────────────────────────────
// Returns a breakdown of funds locked in:
//   1. Raw Materials  (calculated_stock × latest procurement price per kg)
//   2. Packing Materials (current_stock × unit_price, grouped by category)
//   3. Finished Goods (balance × unit_price from products table)
router.get('/', auth, async (req, res) => {
  try {
    // ── 1. Raw Materials ──────────────────────────────────────────────────────
    const [
      { data: rawMats },
      { data: allLogs },
      { data: procs },
      { data: oilBatches },
      { data: flourBatches },
    ] = await Promise.all([
      supabase.from('raw_materials').select('id,name,category,unit,current_stock,min_stock').eq('active', true),
      supabase.from('raw_material_log').select('material_id,log_date,quantity_kg').order('log_date', { ascending: false }),
      supabase.from('procurements').select('date,commodity_name,cleaned_qty,received_qty,ordered_price_per_kg,status').in('status', ['received','stocked','cleaned']),
      supabase.from('batches').select('date,oil_type,input_kg'),
      supabase.from('flour_batches').select('date,commodity,input_kg'),
    ]);

    // Latest audit per material
    const lastAudit = {};
    for (const log of (allLogs || [])) {
      if (!lastAudit[log.material_id]) lastAudit[log.material_id] = log;
    }

    // Latest price per commodity name (most recent procurement)
    const latestPrice = {};
    const sortedProcs = [...(procs || [])].sort((a, b) => b.date.localeCompare(a.date));
    for (const p of sortedProcs) {
      const key = (p.commodity_name || '').toLowerCase().trim();
      if (key && !latestPrice[key]) {
        const price = parseFloat(p.ordered_price_per_kg || 0);
        if (price > 0) latestPrice[key] = price;
      }
    }

    function nameMatches(source, materialName) {
      if (!source) return false;
      const s = source.toLowerCase().trim();
      const m = materialName.toLowerCase().trim();
      if (s === m) return true;
      if (m.startsWith(s) || s.startsWith(m)) return true;
      return false;
    }

    const rawItems = (rawMats || []).map(mat => {
      const audit = lastAudit[mat.id];
      const baselineQty  = audit ? parseFloat(audit.quantity_kg) : 0;
      const baselineDate = audit ? audit.log_date : '2000-01-01';

      // Procurement since audit
      let procuredIn = 0;
      for (const p of (procs || [])) {
        if (p.date < baselineDate) continue;
        if (!nameMatches(p.commodity_name, mat.name)) continue;
        procuredIn += parseFloat(p.cleaned_qty || p.received_qty || 0);
      }

      // Consumption since audit
      let consumed = 0;
      if (mat.category === 'oil_seed') {
        for (const b of (oilBatches || [])) {
          if (b.date < baselineDate) continue;
          if (nameMatches(b.oil_type, mat.name)) consumed += parseFloat(b.input_kg || 0);
        }
      }
      if (mat.category === 'millet') {
        for (const f of (flourBatches || [])) {
          if (f.date < baselineDate) continue;
          if (nameMatches(f.commodity, mat.name)) consumed += parseFloat(f.input_kg || 0);
        }
      }

      const calculated_stock = Math.max(0, baselineQty + procuredIn - consumed);

      // Find latest price — try exact match then partial
      let price_per_kg = 0;
      const matNameLower = mat.name.toLowerCase();
      for (const [key, price] of Object.entries(latestPrice)) {
        if (matNameLower.startsWith(key) || key.startsWith(matNameLower) || matNameLower === key) {
          price_per_kg = price;
          break;
        }
      }

      return {
        id: mat.id,
        name: mat.name,
        category: mat.category,
        unit: mat.unit || 'kg',
        stock: calculated_stock,
        price_per_unit: price_per_kg,
        value: parseFloat((calculated_stock * price_per_kg).toFixed(2)),
        low_stock: mat.min_stock > 0 && calculated_stock < mat.min_stock,
      };
    });

    const rawTotal = rawItems.reduce((s, x) => s + x.value, 0);

    // ── 2. Packing Materials ──────────────────────────────────────────────────
    const { data: packMats } = await supabase
      .from('packing_materials')
      .select('id,name,category,unit,current_stock,unit_price,min_stock')
      .eq('active', true);

    const CAT_LABEL = {
      label:        'Labels',
      cover:        'Covers / Pouches',
      bottle_pet:   'PET Bottles',
      bottle_glass: 'Glass Bottles',
      can_5l:       '5L Cans',
      carton:       'Carton Boxes',
      tape:         'Packing Tape',
      other:        'Others',
    };

    const packByCategory = {};
    for (const m of (packMats || [])) {
      const cat = m.category || 'other';
      if (!packByCategory[cat]) packByCategory[cat] = { label: CAT_LABEL[cat] || cat, items: [], total: 0 };
      const value = parseFloat(((m.current_stock || 0) * (m.unit_price || 0)).toFixed(2));
      packByCategory[cat].items.push({
        id: m.id,
        name: m.name,
        stock: m.current_stock || 0,
        unit: m.unit || 'pcs',
        unit_price: parseFloat(m.unit_price || 0),
        value,
        low_stock: m.min_stock > 0 && (m.current_stock || 0) < m.min_stock,
      });
      packByCategory[cat].total += value;
    }

    const packTotal = Object.values(packByCategory).reduce((s, c) => s + c.total, 0);

    // ── 3. Finished Goods ─────────────────────────────────────────────────────
    const [{ data: fgSummary }, { data: dbProds }] = await Promise.all([
      supabase.from('finished_goods').select('product_name,qty,type').eq('active', true),
      supabase.from('products').select('name,price,website_price,retail_price').eq('active', true),
    ]);

    // Calculate balance per product
    const fgBalance = {};
    for (const row of (fgSummary || [])) {
      if (!fgBalance[row.product_name]) fgBalance[row.product_name] = 0;
      fgBalance[row.product_name] += row.type === 'in' ? parseFloat(row.qty || 0) : -parseFloat(row.qty || 0);
    }

    // Match product price by name
    const prodPriceMap = {};
    for (const p of (dbProds || [])) {
      prodPriceMap[p.name?.toLowerCase()] = parseFloat(p.price || p.retail_price || p.website_price || 0);
    }

    const fgItems = Object.entries(fgBalance)
      .filter(([, bal]) => bal > 0)
      .map(([name, balance]) => {
        const unitPrice = prodPriceMap[name.toLowerCase()] || 0;
        return {
          product_name: name,
          balance: Math.round(balance * 100) / 100,
          unit_price: unitPrice,
          value: parseFloat((balance * unitPrice).toFixed(2)),
        };
      })
      .sort((a, b) => b.value - a.value);

    const fgTotal = fgItems.reduce((s, x) => s + x.value, 0);

    // ── Summary ───────────────────────────────────────────────────────────────
    res.json({
      grand_total: parseFloat((rawTotal + packTotal + fgTotal).toFixed(2)),
      raw_materials: {
        total: parseFloat(rawTotal.toFixed(2)),
        items: rawItems.sort((a, b) => b.value - a.value),
      },
      packing_materials: {
        total: parseFloat(packTotal.toFixed(2)),
        by_category: packByCategory,
      },
      finished_goods: {
        total: parseFloat(fgTotal.toFixed(2)),
        items: fgItems,
      },
    });
  } catch(e) {
    console.error('inventory-valuation:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
