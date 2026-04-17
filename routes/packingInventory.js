const express = require('express');
const router  = express.Router();
const { auth, requireRole } = require('../middleware/auth');
const supabase = require('../config/supabase');

const OIL_PRODUCTS  = ['Groundnut Oil','Sesame Oil','Coconut Oil','Castor Oil','Deepam Oil','Neem Oil','Mustard Oil'];
const OIL_SIZES     = ['100ml','250ml','500ml','1L'];
const MILLET_PRODUCTS = ['Pearl Millet','Barnyard Millet','Finger Millet','Little Millet','Foxtail Millet','Kodo Millet','Sorghum Millet',
  'Barnyard Millet Flakes','Finger Millet Flakes','Foxtail Millet Flakes','Kodo Millet Flakes'];
const MILLET_SIZES  = ['100g','200g','250g','500g','1kg'];

// ── GET all materials ──────────────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const { data, error } = await supabase
    .from('packing_materials')
    .select('*')
    .eq('active', true)
    .order('category')
    .order('product_name')
    .order('size');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── POST create material ───────────────────────────────────────────────────────
router.post('/', auth, requireRole('admin','manager'), async (req, res) => {
  const { name, category, product_name, size, cover_size, spec, unit, current_stock, min_stock, reorder_qty, unit_price, supplier, notes } = req.body;
  if (!name || !category) return res.status(400).json({ error: 'name and category required' });
  // spec supersedes old size/cover_size fields
  const resolvedSize = spec || size || '';
  const insertObj = {
    name: name.trim(), category, product_name: product_name||'', size: resolvedSize,
    cover_size: cover_size||resolvedSize, unit: unit||'pcs',
    current_stock: parseInt(current_stock)||0,
    min_stock: parseInt(min_stock)||50, reorder_qty: parseInt(reorder_qty)||100,
    unit_price: parseFloat(unit_price)||0, supplier: supplier||'',
    notes: notes||'', active: true, updated_at: new Date().toISOString(),
  };
  // include spec column only if it exists (won't cause error if it doesn't)
  if (spec !== undefined) insertObj.spec = spec;
  const { data, error } = await supabase.from('packing_materials').insert(insertObj).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// ── PUT update material ────────────────────────────────────────────────────────
router.put('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  const u = { updated_at: new Date().toISOString() };
  const fields = ['name','category','product_name','size','cover_size','unit','current_stock','min_stock','reorder_qty','unit_price','avg_cost','supplier','notes','active','pkg_type_key'];
  fields.forEach(f => { if (req.body[f] != null) u[f] = req.body[f]; });
  // 'spec' is a frontend alias for 'size' — map it
  if (req.body.spec != null) u.size = req.body.spec;
  if (u.current_stock != null) u.current_stock = parseInt(u.current_stock);
  if (u.min_stock     != null) u.min_stock     = parseInt(u.min_stock);
  if (u.reorder_qty   != null) u.reorder_qty   = parseInt(u.reorder_qty);
  if (u.unit_price    != null) u.unit_price    = parseFloat(u.unit_price);
  const { data, error } = await supabase.from('packing_materials').update(u).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ── DELETE single material ─────────────────────────────────────────────────────
router.delete('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  const { error } = await supabase
    .from('packing_materials')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ── POST bulk-delete ───────────────────────────────────────────────────────────
router.post('/bulk-delete', auth, requireRole('admin','manager'), async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
  const { error } = await supabase
    .from('packing_materials')
    .update({ active: false, updated_at: new Date().toISOString() })
    .in('id', ids);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true, deleted: ids.length });
});

// ── POST audit — log stock count ──────────────────────────────────────────────
router.post('/:id/audit', auth, requireRole('admin','manager'), async (req, res) => {
  const { quantity, notes } = req.body;
  if (quantity == null) return res.status(400).json({ error: 'quantity required' });
  const qty = parseInt(quantity);
  const today = new Date().toISOString().slice(0,10);

  // Fetch current stock for log
  const { data: cur } = await supabase.from('packing_materials').select('current_stock').eq('id', req.params.id).single();
  const prevQty = cur?.current_stock || 0;

  // Log audit
  await supabase.from('packing_audit_log').insert({
    material_id: req.params.id, audit_date: today, quantity: qty,
    previous_qty: prevQty, audited_by: req.user?.name||req.user?.email||'',
    notes: notes||'',
  });

  // Update stock
  const { data, error } = await supabase.from('packing_materials').update({
    current_stock: qty, last_audited: today,
    audited_by: req.user?.name||req.user?.email||'',
    updated_at: new Date().toISOString(),
  }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ── GET audit log for a material ──────────────────────────────────────────────
router.get('/:id/audit-log', auth, async (req, res) => {
  const { data, error } = await supabase.from('packing_audit_log')
    .select('*').eq('material_id', req.params.id)
    .order('created_at', { ascending: false }).limit(30);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── GET B2B requirements — compare pending orders vs current stock ─────────────
router.get('/b2b-requirements', auth, async (req, res) => {
  // Get active B2B orders with items
  const { data: orders, error: oErr } = await supabase
    .from('b2b_orders')
    .select('id, order_no, buyer_name, stage, b2b_order_items(*)')
    .in('stage', ['order_placed','confirmed','processing','in_production']);
  if (oErr) return res.status(500).json({ error: oErr.message });

  // Get all packing materials
  const { data: materials } = await supabase.from('packing_materials').select('*').eq('active', true);
  const matList = materials || [];

  // Aggregate required materials from all order items
  const required = {}; // { materialId: { material, needed } }

  for (const order of (orders||[])) {
    for (const item of (order.b2b_order_items||[])) {
      const pname = (item.product_name||'').trim();
      const qty   = parseInt(item.qty) || 0;
      if (!pname || qty === 0) continue;

      // Extract size from product name (e.g. "Groundnut Oil 500ml" → size=500ml)
      const sizeMatch = pname.match(/(\d+(?:\.\d+)?(?:ml|ML|L|g|gm|GM|kg|KG))/i);
      const size = sizeMatch ? sizeMatch[1].toLowerCase()
        .replace('ml','ml').replace('kg','kg').replace(/(\d+)gm?$/i,'$1g') : '';
      const baseName = pname.replace(/\s*\d+(?:\.\d+)?(?:ml|ML|L|g|gm|GM|kg|KG)\s*/i,'').trim();

      // Match materials: label for this product+size, bottle/cover for product+size
      for (const m of matList) {
        const nameMatch = m.product_name && (
          m.product_name.toLowerCase() === baseName.toLowerCase() ||
          pname.toLowerCase().includes(m.product_name.toLowerCase())
        );
        const sizeMatch2 = !m.size || !size || m.size.toLowerCase() === size.toLowerCase();
        if (nameMatch && sizeMatch2) {
          if (!required[m.id]) required[m.id] = { material: m, needed: 0, orders: [] };
          required[m.id].needed += qty;
          required[m.id].orders.push({ order_no: order.order_no, buyer: order.buyer_name, qty });
        }
      }
    }
  }

  // Build result with shortfall
  const result = Object.values(required).map(r => ({
    ...r.material,
    needed:    r.needed,
    available: r.material.current_stock,
    shortfall: Math.max(0, r.needed - r.material.current_stock),
    status:    r.needed <= r.material.current_stock ? 'ok' : 'shortage',
    orders:    r.orders,
  })).sort((a,b) => b.shortfall - a.shortfall);

  res.json({ requirements: result, order_count: (orders||[]).length });
});

// ── POST seed defaults ────────────────────────────────────────────────────────
router.post('/seed', auth, requireRole('admin'), async (req, res) => {
  const items = [];

  // Labels: per oil product × per size
  OIL_PRODUCTS.forEach(p => {
    OIL_SIZES.forEach(s => items.push({ name:`${p} Label ${s}`, category:'label', product_name:p, size:s, unit:'pcs', min_stock:100, reorder_qty:500 }));
    items.push({ name:`${p} Label 5L`, category:'label', product_name:p, size:'5L', unit:'pcs', min_stock:50, reorder_qty:200 });
  });

  // Labels: per millet product × per size
  MILLET_PRODUCTS.forEach(p => {
    MILLET_SIZES.forEach(s => items.push({ name:`${p} Label ${s}`, category:'label', product_name:p, size:s, unit:'pcs', min_stock:100, reorder_qty:500 }));
  });

  // Covers/Pouches: millet sizes (generic, not per product — user can add per-product if needed)
  MILLET_SIZES.forEach(s => items.push({ name:`Millet Pouch / Cover ${s}`, category:'cover', product_name:'', size:s, unit:'pcs', min_stock:200, reorder_qty:1000 }));

  // PET Bottles
  OIL_SIZES.forEach(s => items.push({ name:`PET Bottle ${s}`, category:'bottle_pet', product_name:'', size:s, unit:'pcs', min_stock:100, reorder_qty:500 }));

  // Glass Bottles
  ['250ml','500ml','1L'].forEach(s => items.push({ name:`Glass Bottle ${s}`, category:'bottle_glass', product_name:'', size:s, unit:'pcs', min_stock:50, reorder_qty:200 }));

  // 5L Cans + Labels
  items.push({ name:'5L Can (Oil)',       category:'can_5l',  product_name:'', size:'5L', unit:'pcs', min_stock:50, reorder_qty:100 });
  items.push({ name:'5L Can Label',       category:'label',   product_name:'', size:'5L', unit:'pcs', min_stock:50, reorder_qty:200 });

  // Carton Boxes
  [
    { name:'Carton Box Small  (250ml×12)', size:'small'  },
    { name:'Carton Box Medium (500ml×12)', size:'medium' },
    { name:'Carton Box Large  (1L×12)',    size:'large'  },
    { name:'Carton Box 5L     (5L×6)',     size:'5L'     },
    { name:'Carton Box Millet (1kg×12)',   size:'millet' },
  ].forEach(c => items.push({ name:c.name, category:'carton', product_name:'', size:c.size, unit:'pcs', min_stock:20, reorder_qty:100 }));

  // Packing Tape
  items.push({ name:'Packing Tape',        category:'tape',  product_name:'', size:'',    unit:'rolls', min_stock:10, reorder_qty:50 });
  items.push({ name:'Bubble Wrap',         category:'other', product_name:'', size:'',    unit:'meters', min_stock:20, reorder_qty:100 });

  // Insert all (skip duplicates by name)
  const { data: existing } = await supabase.from('packing_materials').select('name');
  const existingNames = new Set((existing||[]).map(e => e.name));
  const toInsert = items
    .filter(i => !existingNames.has(i.name))
    .map(i => ({ ...i, current_stock:0, notes:'', active:true, updated_at:new Date().toISOString() }));

  if (toInsert.length === 0) return res.json({ seeded: 0, message: 'Already seeded' });
  const { data, error } = await supabase.from('packing_materials').insert(toInsert).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ seeded: (data||[]).length });
});

module.exports = router;
