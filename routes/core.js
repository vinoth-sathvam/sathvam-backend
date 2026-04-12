const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const supabase = require('../config/supabase');
const { auth, requireRole } = require('../middleware/auth');

const ENV_PATH = path.join(__dirname, '../.env');

function updateEnvVar(key, value) {
  let content = fs.readFileSync(ENV_PATH, 'utf8');
  const regex = new RegExp(`^${key}=.*`, 'm');
  const line = `${key}=${value}`;
  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    content += `\n${line}`;
  }
  fs.writeFileSync(ENV_PATH, content, 'utf8');
  process.env[key] = value;
}

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
    raw_mat_key:p.rawMatKey, cake_type_key:p.cakeTypeKey||null,
    reorder:p.reorder||0, gst:p.gst||0,
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
// Batch price/field update — must be before /:id so Express doesn't match "batch" as an id
products.put('/batch', auth, requireRole('admin', 'manager'), async (req, res) => {
  const prods = Array.isArray(req.body) ? req.body : [];
  if (prods.length === 0) return res.json({ updated: 0 });
  const updates = prods.filter(p => p.id).map(p => ({
    id: p.id,
    name: p.name, sku: p.sku, cat: p.cat, unit: p.unit,
    pack_size: p.packSize, pack_unit: p.packUnit,
    oil_type_key: p.oilTypeKey, raw_mat_key: p.rawMatKey, cake_type_key: p.cakeTypeKey ?? null,
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
    packing_links: p.packingLinks ?? null,
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
products.put('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  const p = req.body;
  const { data, error } = await supabase.from('products').update({
    name:p.name, sku:p.sku, cat:p.cat, unit:p.unit,
    pack_size:p.packSize, pack_unit:p.packUnit, oil_type_key:p.oilTypeKey,
    cake_type_key:p.cakeTypeKey!==undefined?p.cakeTypeKey:undefined,
    reorder:p.reorder, gst:p.gst, price:p.price,
    retail_price:p.retailPrice, website_price:p.websitePrice,
    intl_price:p.intlPrice, retail_profit_pct:p.retailProfitPct,
    web_profit_pct:p.webProfitPct, web_courier_charge:p.webCourierCharge,
    intl_profit_pct:p.intlProfitPct, intl_carton_key:p.intlCartonKey,
    label_cost:p.labelCost, pkg_type_key:p.pkgTypeKey,
    packing_links:p.packingLinks!==undefined?p.packingLinks:undefined,
    featured:p.featured,
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

// POST /api/products/seed-images — bulk-set image_url by product name (admin only)
products.post('/seed-images', auth, requireRole('admin'), async (req, res) => {
  const map = req.body; // { "Product Name": "https://..." }
  if (!map || typeof map !== 'object') return res.status(400).json({ error: 'Provide {name:url} map' });
  const { data: prods } = await supabase.from('products').select('id,name,image_url');
  let updated = 0, skipped = 0;
  for (const prod of (prods || [])) {
    const url = map[prod.name];
    if (!url) { skipped++; continue; }
    await supabase.from('products').update({ image_url: url }).eq('id', prod.id);
    updated++;
  }
  res.json({ ok: true, updated, skipped });
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

// GET /api/vendors/performance — stats per vendor from procurement history
vendors.get('/performance', auth, async (req, res) => {
  try {
    const { data: procs } = await supabase
      .from('procurements')
      .select('supplier, vendor_id, commodity_name, ordered_qty, ordered_price_per_kg, gst, date, received_date, status')
      .not('supplier', 'is', null)
      .order('date', { ascending: false })
      .limit(2000);

    const map = {}; // supplier → stats
    for (const p of (procs || [])) {
      const key = p.supplier || 'Unknown';
      if (!map[key]) map[key] = { supplier: key, vendor_id: p.vendor_id, order_count: 0, total_value: 0, on_time: 0, late: 0, avg_delay_days: [], commodities: {}, price_history: [] };
      const m = map[key];
      m.order_count++;
      const val = parseFloat(p.ordered_qty||0) * parseFloat(p.ordered_price_per_kg||0) * (1 + parseFloat(p.gst||0)/100);
      m.total_value += val;

      // Delivery delay
      if (p.date && p.received_date) {
        const delay = Math.round((new Date(p.received_date) - new Date(p.date)) / 86400000);
        m.avg_delay_days.push(delay);
        if (delay <= 3) m.on_time++; else m.late++;
      }

      // Commodity price history
      const comm = p.commodity_name || 'Unknown';
      if (!m.commodities[comm]) m.commodities[comm] = { total_qty: 0, total_value: 0, count: 0 };
      m.commodities[comm].total_qty   += parseFloat(p.ordered_qty||0);
      m.commodities[comm].total_value += val;
      m.commodities[comm].count++;

      if (p.ordered_price_per_kg > 0) {
        m.price_history.push({ date: p.date, commodity: comm, price: parseFloat(p.ordered_price_per_kg), qty: parseFloat(p.ordered_qty||0) });
      }
    }

    const result = Object.values(map).map(m => ({
      ...m,
      avg_delay_days: m.avg_delay_days.length > 0 ? (m.avg_delay_days.reduce((s,v)=>s+v,0) / m.avg_delay_days.length).toFixed(1) : null,
      on_time_pct: m.order_count > 0 ? Math.round(m.on_time / m.order_count * 100) : null,
      price_history: m.price_history.slice(-20), // last 20
    })).sort((a,b) => b.total_value - a.total_value);

    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

const sales = express.Router();

// GET /api/sales/next-invoice-no — returns next sequential invoice number for today
// Format: SA{MMM}{DD}-{N}  e.g. SAAPR08-3
sales.get('/next-invoice-no', auth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const d = new Date();
  const prefix = `SA${months[d.getMonth()]}${String(d.getDate()).padStart(2,'0')}`;
  const [s, w] = await Promise.all([
    supabase.from('sales').select('id', { count: 'exact', head: true }).eq('date', today),
    supabase.from('webstore_orders').select('id', { count: 'exact', head: true }).eq('date', today),
  ]);
  const seq = (s.count || 0) + (w.count || 0) + 1;
  res.json({ formatted: `${prefix}-${seq}`, prefix, seq });
});

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

// Safe keys that can be read/written via the admin UI
const EDITABLE_KEYS = [
  'SMTP_USER','SMTP_PASS','SMTP_FROM','SMTP_HOST','SMTP_PORT',
  'RAZORPAY_KEY_ID','RAZORPAY_KEY_SECRET','RAZORPAY_WEBHOOK_SECRET',
  'WA_ACCESS_TOKEN','WA_PHONE_NUMBER_ID','WA_WABA_ID','WA_NOTIFY_TO','WA_ORDER_TEMPLATE','WA_WEBHOOK_VERIFY_TOKEN',
  'ZOHO_CLIENT_ID','ZOHO_CLIENT_SECRET','ZOHO_ORG_ID','ZOHO_REFRESH_TOKEN',
  'VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','VAPID_SUBJECT',
  'ANTHROPIC_API_KEY',
  'GOOGLE_CLIENT_ID',
  'FRONTEND_URL','PORTAL_URL',
];
const SECRET_KEYS = new Set(['SMTP_PASS','RAZORPAY_KEY_SECRET','RAZORPAY_WEBHOOK_SECRET','WA_ACCESS_TOKEN','ZOHO_CLIENT_SECRET','ZOHO_REFRESH_TOKEN','VAPID_PRIVATE_KEY','ANTHROPIC_API_KEY']);

settings.get('/env-config', auth, requireRole('admin'), (req, res) => {
  const config = {};
  for (const key of EDITABLE_KEYS) {
    const val = process.env[key] || '';
    config[key] = SECRET_KEYS.has(key) ? (val ? '••••••••' : '') : val;
    config[`${key}__set`] = !!val;
  }
  res.json(config);
});

settings.post('/env-config', auth, requireRole('admin'), async (req, res) => {
  const updates = req.body;
  const saved = [];
  for (const [key, value] of Object.entries(updates)) {
    if (!EDITABLE_KEYS.includes(key)) continue;
    if (value === '' || value === '••••••••') continue; // skip blanks and masked placeholders
    updateEnvVar(key, value);
    saved.push(key);
  }
  res.json({ success: true, saved });
});

settings.post('/smtp-config/test', auth, requireRole('admin'), async (req, res) => {
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const { to } = req.body;
  if (!smtpUser || !smtpPass) return res.status(400).json({ error: 'SMTP not configured yet' });
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: smtpUser, pass: smtpPass },
  });
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || `Sathvam <${smtpUser}>`,
      to: to || smtpUser,
      subject: 'Sathvam SMTP Test ✅',
      html: '<h2>SMTP is working!</h2><p>Your email settings are correctly configured on sathvam.in.</p>',
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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
