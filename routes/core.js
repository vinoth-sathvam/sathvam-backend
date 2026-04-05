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
    label_cost:p.labelCost||0, pkg_type_key:p.pkgTypeKey, featured:p.featured||false
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
    label_cost:p.labelCost, pkg_type_key:p.pkgTypeKey, featured:p.featured
  }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});
products.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  await supabase.from('products').update({ active: false }).eq('id', req.params.id);
  res.json({ message: 'Deactivated' });
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

const procurement = express.Router();
procurement.get('/', auth, async (req, res) => {
  const { data, error } = await supabase.from('procurements').select('*').order('date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
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

const vendors = express.Router();
vendors.get('/', auth, async (req, res) => {
  const { data, error } = await supabase.from('vendors').select('*').eq('active', true).order('display_name');
  if (error) return res.status(500).json({ error: error.message });
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
  const { data, error } = await supabase.from('sales').select('*, sale_items(*)').order('date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
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
  if (!u.password || u.password.length < 6) return res.status(400).json({ error: 'Password too short' });
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
