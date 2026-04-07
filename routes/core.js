const express = require('express');
const bcrypt = require('bcryptjs');
const supabase = require('../config/supabase');
const { auth, requireRole } = require('../middleware/auth');

const products = express.Router();
products.get('/', auth, async (req, res) => {
  const { data, error } = await supabase.from('products').select('*').eq('active', true).order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
products.post('/', auth, requireRole('admin'), async (req, res) => {
  const p = req.body;
  const { data, error } = await supabase.from('products').insert({
    name:p.name, sku:p.sku, cat:p.cat, unit:p.unit||'pcs',
    pack_size:p.packSize, pack_unit:p.packUnit, oil_type_key:p.oilTypeKey,
    raw_mat_key:p.rawMatKey, reorder:p.reorder||0, gst:p.gst||0,
    price:p.price||0, retail_price:p.retailPrice, website_price:p.websitePrice,
    intl_price:p.intlPrice, retail_profit_pct:p.retailProfitPct,
    web_profit_pct:p.webProfitPct, web_courier_charge:p.webCourierCharge,
    intl_profit_pct:p.intlProfitPct, intl_carton_key:p.intlCartonKey,
    label_cost:p.labelCost||0, pkg_type_key:p.pkgTypeKey, featured:p.featured||false,
    image_url:p.imageUrl||null, description:p.description||null, hsn_code:p.hsnCode||null
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});
products.put('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  const p = req.body;
  const { data, error } = await supabase.from('products').update({
    name:p.name, sku:p.sku, cat:p.cat, unit:p.unit,
    pack_size:p.packSize, pack_unit:p.packUnit, oil_type_key:p.oilTypeKey,
    reorder:p.reorder, gst:p.gst, price:p.price,
    retail_price:p.retailPrice, website_price:p.websitePrice,
    intl_price:p.intlPrice, retail_profit_pct:p.retailProfitPct,
    web_profit_pct:p.webProfitPct, web_courier_charge:p.webCourierCharge,
    intl_profit_pct:p.intlProfitPct, intl_carton_key:p.intlCartonKey,
    label_cost:p.labelCost, pkg_type_key:p.pkgTypeKey, featured:p.featured,
    image_url:p.imageUrl!==undefined?p.imageUrl:undefined,
    description:p.description!==undefined?p.description:undefined,
    hsn_code:p.hsnCode!==undefined?p.hsnCode:undefined
  }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});
products.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  await supabase.from('products').update({ active: false }).eq('id', req.params.id);
  res.json({ message: 'Deactivated' });
});
// Batch price/field update — updates multiple products at once
products.put('/batch', auth, requireRole('admin', 'manager'), async (req, res) => {
  const prods = Array.isArray(req.body) ? req.body : [];
  if (prods.length === 0) return res.json({ updated: 0 });
  const updates = prods.filter(p => p.id).map(p => ({
    id: p.id,
    name: p.name, sku: p.sku, cat: p.cat, unit: p.unit,
    pack_size: p.packSize, pack_unit: p.packUnit,
    oil_type_key: p.oilTypeKey, raw_mat_key: p.rawMatKey,
    reorder: p.reorder || 0, gst: p.gst || 0,
    price: p.price || 0,
    retail_price: p.retailPrice ?? null,
    website_price: p.websitePrice ?? null,
    intl_price: p.intlPrice ?? null,
    retail_profit_pct: p.retailProfitPct ?? null,
    web_profit_pct: p.webProfitPct ?? null,
    web_courier_charge: p.webCourierCharge ?? null,
    intl_profit_pct: p.intlProfitPct ?? null,
    intl_carton_key: p.intlCartonKey ?? null,
    label_cost: p.labelCost || 0,
    pkg_type_key: p.pkgTypeKey ?? null,
    featured: p.featured || false,
    active: p.active !== false,
    image_url: p.imageUrl ?? undefined,
    description: p.description ?? undefined,
    hsn_code: p.hsnCode ?? undefined,
  }));
  const { error } = await supabase.from('products').upsert(updates, { onConflict: 'id' });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ updated: updates.length });
});
products.get('/stock', auth, async (req, res) => {
  const { data, error } = await supabase.from('stock_ledger').select('*').order('date', { ascending: false }).limit(1000);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
products.post('/stock', auth, async (req, res) => {
  const s = req.body;
  const { data, error } = await supabase.from('stock_ledger').insert({
    date:s.date, product_id:s.productId||null, product_name:s.productName,
    type:s.type, qty:s.qty, unit:s.unit||'pcs',
    rate:s.rate||0, total_value:s.totalValue||0,
    channel:s.channel, reference:s.reference, notes:s.notes
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// Bulk sync — replaces entire stock_ledger with the array from localStorage
products.post('/stock/bulk', auth, async (req, res) => {
  const entries = Array.isArray(req.body) ? req.body : [];
  // Delete all existing entries then reinsert
  const { error: delErr } = await supabase.from('stock_ledger').delete().neq('id', 0);
  if (delErr) return res.status(500).json({ error: delErr.message });
  if (entries.length === 0) return res.json({ synced: 0 });
  const rows = entries.map(s => ({
    date: s.date, product_id: s.productId || null, product_name: s.productName || null,
    type: s.type, qty: s.qty, unit: s.unit || 'pcs',
    rate: s.rate || 0, total_value: s.totalValue || 0,
    channel: s.channel || null, reference: s.reference || null, notes: s.notes || null
  }));
  const { error } = await supabase.from('stock_ledger').insert(rows);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ synced: rows.length });
});

const procurement = express.Router();
procurement.get('/', auth, async (req, res) => {
  const { data, error } = await supabase.from('procurements').select('*').order('date', { ascending: false }).limit(1000);
  if (error) return res.status(500).json({ error: 'Failed to load procurements' });
  res.json(data);
});
procurement.post('/', auth, requireRole('admin','manager'), async (req, res) => {
  const p = req.body;
  const { data, error } = await supabase.from('procurements').insert({
    date:p.date, commodity_id:p.commodityId, commodity_name:p.commodityName,
    supplier:p.supplier, vendor_id:p.vendorId||null,
    ordered_qty:p.orderedQty, ordered_price_per_kg:p.orderedPricePerKg,
    gst:parseFloat(p.gst)||0,
    received_qty:p.receivedQty||null, cleaned_qty:p.cleanedQty||null,
    status:p.status||'ordered', notes:p.notes||'',
    purchase_order_id:p.purchase_order_id||null, invoice_no:p.invoice_no||null
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});
procurement.put('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  const p = req.body;
  const { data, error } = await supabase.from('procurements').update({
    date:p.date, commodity_id:p.commodityId||null, commodity_name:p.commodityName, supplier:p.supplier, vendor_id:p.vendorId||null,
    ordered_qty:p.orderedQty, ordered_price_per_kg:p.orderedPricePerKg,
    gst:parseFloat(p.gst)||0,
    received_qty:p.receivedQty||null, received_date:p.receivedDate||null,
    cleaned_qty:p.cleanedQty||null, cleaned_date:p.cleanedDate||null,
    status:p.status, notes:p.notes||''
  }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});
procurement.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  await supabase.from('procurements').delete().eq('id', req.params.id);
  res.json({ message: 'Deleted' });
});

procurement.post('/bulk', auth, requireRole('admin','manager'), async (req, res) => {
  const { items, date, supplier, notes } = req.body;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array required' });
  const rows = items.map(it => ({
    date: date || new Date().toISOString().slice(0,10),
    commodity_name: it.commodityName,
    supplier: supplier || 'Opening Balance',
    ordered_qty: parseFloat(it.qty) || 0,
    ordered_price_per_kg: parseFloat(it.orderedPricePerKg||it.pricePerKg) || 0,
    received_qty: parseFloat(it.qty) || 0,
    cleaned_qty: parseFloat(it.qty) || 0,
    gst: 0,
    status: 'stocked',
    notes: (notes || 'Opening stock entry') + (it.unit && it.unit !== 'kg' ? ` [unit:${it.unit}]` : ''),
  }));
  const { data, error } = await supabase.from('procurements').insert(rows).select();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ inserted: data.length });
});

const vendors = express.Router();
vendors.get('/', auth, async (req, res) => {
  const { data, error } = await supabase.from('vendors').select('*').eq('active', true).order('display_name').limit(500);
  if (error) return res.status(500).json({ error: 'Failed to load vendors' });
  res.json(data);
});
vendors.post('/', auth, requireRole('admin','manager'), async (req, res) => {
  const v = req.body;
  const { data, error } = await supabase.from('vendors').insert({
    display_name:v.displayName, company_name:v.companyName,
    email:v.email, work_phone:v.workPhone, mobile:v.mobile,
    gstin:v.gstin, pan:v.pan, gst_treatment:v.gstTreatment,
    source_of_supply:v.sourceOfSupply, payment_terms:v.paymentTerms,
    category:v.category, billing_city:v.billingCity,
    billing_state:v.billingState, billing_pincode:v.billingPincode,
    bank_name:v.bankName, bank_account:v.bankAccount, bank_ifsc:v.bankIfsc,
    notes:v.notes
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});
vendors.put('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  const v = req.body;
  const { data, error } = await supabase.from('vendors').update({
    display_name:v.displayName, company_name:v.companyName,
    email:v.email, mobile:v.mobile, gstin:v.gstin,
    payment_terms:v.paymentTerms, category:v.category, notes:v.notes
  }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});
vendors.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  await supabase.from('vendors').update({ active: false }).eq('id', req.params.id);
  res.json({ message: 'Deactivated' });
});

const sales = express.Router();
sales.get('/', auth, async (req, res) => {
  const { data, error } = await supabase.from('sales').select('*, sale_items(*)').order('date', { ascending: false }).limit(1000);
  if (error) return res.status(500).json({ error: 'Failed to load sales' });
  res.json(data);
});
sales.post('/', auth, async (req, res) => {
  const s = req.body;
  const { data: sale, error } = await supabase.from('sales').insert({
    order_no:s.orderNo, date:s.date, channel:s.channel,
    status:s.status||'pending', customer_name:s.customerName,
    customer_phone:s.customerPhone, total_amount:s.totalAmount,
    discount:s.discount||0, final_amount:s.finalAmount,
    amount_paid:s.amountPaid||0, payment_method:s.paymentMethod||'cash', notes:s.notes||''
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  if (s.items?.length) {
    await supabase.from('sale_items').insert(s.items.map(i=>({
      sale_id:sale.id, product_id:i.productId||null, product_name:i.productName,
      qty:i.qty, rate:i.rate, total:i.total, unit:i.unit||'pcs'
    })));
  }
  res.status(201).json(sale);
});
sales.put('/:id', auth, async (req, res) => {
  const s = req.body;
  const { data, error } = await supabase.from('sales').update({
    status:s.status, amount_paid:s.amountPaid, payment_method:s.paymentMethod, notes:s.notes
  }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});
sales.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  await supabase.from('sale_items').delete().eq('sale_id', req.params.id);
  await supabase.from('sales').delete().eq('id', req.params.id);
  res.json({ message: 'Deleted' });
});

const settings = express.Router();
settings.get('/:key', auth, async (req, res) => {
  const { data, error } = await supabase.from('settings').select('value').eq('key', req.params.key).single();
  if (error) return res.status(404).json({ error: 'Not found' });
  res.json(data.value);
});
settings.put('/:key', auth, requireRole('admin','manager'), async (req, res) => {
  const { data, error } = await supabase.from('settings').upsert({ key:req.params.key, value:req.body, updated_at:new Date() }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data.value);
});

const users = express.Router();
users.get('/', auth, requireRole('admin'), async (req, res) => {
  const { data, error } = await supabase.from('users').select('id,name,username,email,role,active,created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
users.post('/', auth, requireRole('admin'), async (req, res) => {
  const u = req.body;
  if (!u.password || u.password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const hash = await bcrypt.hash(u.password, 12);
  const { data, error } = await supabase.from('users').insert({
    username:u.username, name:u.name, email:u.email,
    password:hash, role:u.role||'manager', active:true
  }).select('id,name,username,email,role,active').single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});
users.put('/:id', auth, requireRole('admin'), async (req, res) => {
  const u = req.body;
  const updates = { name:u.name, email:u.email, role:u.role, active:u.active };
  if (u.password) updates.password = await bcrypt.hash(u.password, 12);
  const { data, error } = await supabase.from('users').update(updates).eq('id', req.params.id).select('id,name,username,role,active').single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});
users.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  const { error } = await supabase.from('users').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

module.exports = { products, procurement, vendors, sales, settings, users };
