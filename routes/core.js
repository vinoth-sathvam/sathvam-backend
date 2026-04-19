const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const supabase = require('../config/supabase');
const { auth, requireRole } = require('../middleware/auth');
const { createInvoice, recordPayment } = require('../config/zoho');

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

// ── Packing auto-link helper ──────────────────────────────────────────────────
const LABEL_PRICE_MAP = {
  '5000ml':10, '1l':3.5, '500ml':2.5, '250ml':2, '200ml':1.5, '100ml':2,
  '1kg':8, '500g':4, '250g':3, '200g':2, '150g':1.5, '160g':1.5,
  '100g':1, '80g':1, '50g':0.5,
};
function normSz(s) {
  const t = (s||'').toLowerCase().replace(/\s+/g,'').replace(/gm$/,'g').replace(/kgs?$/,'kg');
  let m;
  if ((m=t.match(/^(\d+(?:\.\d+)?)ml$/))) return { v:+m[1], u:'ml', k:`${+m[1]}ml` };
  if ((m=t.match(/^(\d+(?:\.\d+)?)l$/)))  return { v:+m[1]*1000, u:'ml', k:`${+m[1]}l` };
  if ((m=t.match(/^(\d+(?:\.\d+)?)g$/)))  return { v:+m[1], u:'g', k:`${+m[1]}g` };
  if ((m=t.match(/^(\d+(?:\.\d+)?)kg$/))) return { v:+m[1]*1000, u:'g', k:`${+m[1]}kg` };
  return null;
}
function prodSzKey(packSize, packUnit) {
  const v = parseFloat(packSize)||0; if (!v) return null;
  const u = (packUnit||'').toUpperCase();
  if (u==='ML') return v===5000?'5000ml': v===1000?'1l': `${v}ml`;
  if (u==='L')  return v===5?'5000ml': v===1?'1l': `${v*1000}ml`;
  if (u==='GM'||u==='G') return v===1000?'1kg': `${v}g`;
  if (u==='KG'||u==='KGS') return v===1?'1kg': `${v*1000}g`;
  return null;
}
function prodSzNorm(packSize, packUnit) {
  const k = prodSzKey(packSize, packUnit); return k ? normSz(k) : null;
}
function stripSize(name) {
  return name.replace(/\s+\d+(?:\.\d+)?(?:ML|GM|G|KG|L|KGS?)$/i,'').trim();
}

async function autoLinkPacking(prod) {
  try {
    const { data: mats } = await supabase
      .from('packing_materials').select('id,name,category,product_name,size').eq('active',true);
    if (!mats?.length) return null;

    const sz  = prodSzNorm(prod.pack_size||prod.packSize, prod.pack_unit||prod.packUnit);
    const cat = prod.cat;
    if (!sz || cat==='raw') return null;

    const isOil = cat==='oil';
    const is5L  = sz.u==='ml' && sz.v===5000;

    // ── Find container ──────────────────────────────────────────────────────
    const CPREF = { can_5l:4, bottle_pet:3, bottle_glass:2, cover:1 };
    let bestContainer = null, bestPref = -1;
    for (const m of mats) {
      if (!['can_5l','bottle_pet','bottle_glass','cover'].includes(m.category)) continue;
      // For oil products: only bottles/cans; for dry: only covers
      if (isOil && m.category==='cover') continue;
      if (!isOil && (m.category==='bottle_pet'||m.category==='bottle_glass'||m.category==='can_5l')) continue;
      const msz = normSz(m.size) || normSz(m.name.replace(/[^0-9a-z.]/gi,' '));
      if (!msz) continue;
      if (msz.u!==sz.u || msz.v!==sz.v) continue;
      const pref = CPREF[m.category]||0;
      if (pref > bestPref) { bestContainer=m; bestPref=pref; }
    }

    // ── Find label ──────────────────────────────────────────────────────────
    const base     = stripSize(prod.name);
    const normBase = base.toLowerCase().replace(/\s+/g,'');
    const szKey    = prodSzKey(prod.pack_size||prod.packSize, prod.pack_unit||prod.packUnit);

    let labelId = null;
    for (const m of mats) {
      if (m.category!=='label') continue;
      const mnorm = (m.product_name||'').toLowerCase().replace(/\s+/g,'');
      if (mnorm !== normBase) continue;
      const lsz = normSz(m.size);
      if (lsz && sz && lsz.u===sz.u && lsz.v===sz.v) { labelId=m.id; break; }
      if (!m.size && !sz) { labelId=m.id; break; }
    }

    // ── Auto-create label if missing ────────────────────────────────────────
    if (!labelId && base) {
      const labelName = szKey ? `${base} Label ${szKey}` : `${base} Label`;
      const price = szKey ? (LABEL_PRICE_MAP[szKey]||0) : 0;
      const now = new Date().toISOString();
      const { data: newLabel } = await supabase.from('packing_materials').insert({
        name: labelName, category:'label', product_name:base,
        size: szKey||'', cover_size: szKey||'',
        unit:'pcs', current_stock:0, min_stock:50, reorder_qty:200,
        unit_price:price, supplier:'', notes:'Auto-created on product add',
        active:true, updated_at:now,
      }).select('id').single();
      if (newLabel) labelId = newLabel.id;
    }

    if (!bestContainer && !labelId) return null;
    return {
      materialIds: bestContainer ? [bestContainer.id] : [],
      labelId:     labelId || undefined,
    };
  } catch(e) {
    console.error('autoLinkPacking error:', e.message);
    return null;
  }
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

  // Auto-link packing materials (label + container) in background
  autoLinkPacking(data).then(links => {
    if (links) supabase.from('products').update({ packing_links: links }).eq('id', data.id).then(()=>{});
  });

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
    hsn_code:p.hsnCode!==undefined?p.hsnCode:undefined,
    offer_label:p.offer_label!==undefined?p.offer_label:undefined,
    offer_price:p.offer_price!==undefined?p.offer_price:undefined,
    offer_ends_at:p.offer_ends_at!==undefined?p.offer_ends_at:undefined,
  }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// POST /api/products/offer-notify — save offer fields + blast email & WhatsApp to all customers
products.post('/offer-notify', auth, requireRole('admin','manager'), async (req, res) => {
  const { product_id, product_name, offer_label, offer_price, original_price, offer_ends_at } = req.body;
  if (!product_id || !offer_label) return res.status(400).json({ error: 'product_id and offer_label required' });

  // 1. Fetch all registered customers (email + phone)
  const { data: customers, error: custErr } = await supabase
    .from('customers')
    .select('name, email, phone')
    .not('email', 'is', null);
  if (custErr) return res.status(500).json({ error: custErr.message });

  // 2. Also fetch newsletter subscribers (store_analytics key)
  const { data: nlRow } = await supabase
    .from('store_analytics')
    .select('data')
    .eq('key', 'newsletter_subscribers')
    .maybeSingle();
  const newsletterEmails = (nlRow?.data || []).map(s => s.email).filter(Boolean);

  // Merge all unique emails
  const customerMap = {};
  for (const c of customers) {
    if (c.email) customerMap[c.email.toLowerCase()] = { name: c.name || 'Valued Customer', phone: c.phone };
  }
  for (const email of newsletterEmails) {
    if (!customerMap[email]) customerMap[email] = { name: 'Valued Customer', phone: null };
  }
  const allRecipients = Object.entries(customerMap).map(([email, d]) => ({ email, ...d }));

  // 3. Build email HTML
  const savingsLine = offer_price && original_price
    ? `<p style="font-size:14px;color:#666;">Regular price: <s>₹${original_price}</s> &nbsp; <strong style="color:#e53e3e;">Now: ₹${offer_price}</strong></p>`
    : '';
  const expiryLine = offer_ends_at
    ? `<p style="font-size:13px;color:#888;">⏰ Offer valid until: ${new Date(offer_ends_at).toLocaleDateString('en-IN', {day:'numeric',month:'long',year:'numeric'})}</p>`
    : '';
  const emailHtml = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f7f3ef;font-family:Georgia,serif;">
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
    <div style="background:linear-gradient(135deg,#7b4f28,#c8813a);padding:28px 32px;text-align:center;">
      <h1 style="color:#fff;margin:0;font-size:22px;letter-spacing:1px;">🏷️ Special Offer from Sathvam</h1>
    </div>
    <div style="padding:32px;">
      <p style="font-size:15px;color:#444;margin-top:0;">Dear {{NAME}},</p>
      <p style="font-size:15px;color:#444;">We have an exclusive offer just for you!</p>
      <div style="background:#fff8f0;border-left:4px solid #c8813a;padding:16px 20px;border-radius:0 8px 8px 0;margin:20px 0;">
        <p style="margin:0 0 6px;font-size:18px;font-weight:bold;color:#7b4f28;">🛍️ ${product_name}</p>
        <p style="margin:0 0 6px;font-size:20px;font-weight:bold;color:#c8813a;">🏷️ ${offer_label}</p>
        ${savingsLine}
        ${expiryLine}
      </div>
      <div style="text-align:center;margin:28px 0;">
        <a href="https://sathvam.in" style="background:#c8813a;color:#fff;padding:13px 32px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:bold;display:inline-block;">Shop Now →</a>
      </div>
      <p style="font-size:13px;color:#999;text-align:center;border-top:1px solid #f0e8df;padding-top:16px;margin-bottom:0;">
        Sathvam Natural Products · sathvam.in<br>
        <a href="https://sathvam.in" style="color:#c8813a;text-decoration:none;">Unsubscribe</a>
      </p>
    </div>
  </div>
</body>
</html>`;

  // 4. Send emails in parallel batches of 10
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  let emailSent = 0;
  const BATCH = 10;
  for (let i = 0; i < allRecipients.length; i += BATCH) {
    const batch = allRecipients.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(r =>
      transporter.sendMail({
        from: process.env.SMTP_FROM || `Sathvam <${process.env.SMTP_USER}>`,
        to: r.email,
        subject: `🏷️ ${offer_label} — ${product_name} | Sathvam Natural Products`,
        html: emailHtml.replace('{{NAME}}', r.name),
      }).then(() => emailSent++)
        .catch(e => console.error(`Offer email failed for ${r.email}:`, e.message))
    ));
  }

  // 5. Send WhatsApp to customers with phone numbers using template (if configured)
  const WA_PHONE_ID = process.env.WA_PHONE_NUMBER_ID;
  const WA_TOKEN    = process.env.WA_ACCESS_TOKEN;
  const WA_TEMPLATE = process.env.WA_OFFER_TEMPLATE;
  let waSent = 0;

  if (WA_PHONE_ID && WA_TOKEN && WA_TEMPLATE) {
    const withPhone = allRecipients.filter(r => r.phone && r.phone.replace(/\D/g,'').length >= 10);
    for (const r of withPhone) {
      const to = r.phone.replace(/\D/g,'');
      try {
        await fetch(`https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            type: 'template',
            template: { name: WA_TEMPLATE, language: { code: 'en' } },
          }),
        });
        waSent++;
      } catch (e) {
        console.error(`WA offer notify failed for ${to}:`, e.message);
      }
    }
  }

  res.json({ sent: emailSent, wa_sent: waSent, total_recipients: allRecipients.length });
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

// DELETE /api/products/stock/by-proc/:procId — delete stock ledger entries linked to a procurement
products.delete('/stock/by-proc/:procId', auth, requireRole('admin'), async (req, res) => {
  const suffix = req.params.procId.slice(-6);
  const { error } = await supabase.from('stock_ledger').delete().ilike('reference', `%Procurement ${suffix}%`);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Stock entries deleted' });
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

  // Fetch existing record to detect status change → received
  const { data: existing } = await supabase.from('procurements').select('status,payable_id').eq('id', req.params.id).single();

  const { data, error } = await supabase.from('procurements').update({
    date:p.date, commodity_id:p.commodityId||null, commodity_name:p.commodityName, supplier:p.supplier, vendor_id:p.vendorId||null,
    ordered_qty:p.orderedQty, ordered_price_per_kg:p.orderedPricePerKg,
    gst:parseFloat(p.gst)||0,
    received_qty:p.receivedQty||null, received_date:p.receivedDate||null,
    cleaned_qty:p.cleanedQty||null, cleaned_date:p.cleanedDate||null,
    status:p.status, notes:p.notes||''
  }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });

  // Auto-create vendor payable when status first changes to 'received'
  if (p.status === 'received' && existing?.status !== 'received' && !existing?.payable_id) {
    setImmediate(async () => {
      try {
        const qty    = parseFloat(p.receivedQty || p.orderedQty) || 0;
        const rate   = parseFloat(p.orderedPricePerKg) || 0;
        const amount = Math.round(qty * rate * 100) / 100;
        const gstPct = parseFloat(p.gst) || 0;
        const gstAmt = Math.round(amount * gstPct / 100 * 100) / 100;
        if (amount <= 0) return;

        const today    = new Date().toISOString().slice(0, 10);
        const dueDate  = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const { data: payable } = await supabase.from('vendor_bills').insert({
          vendor_name:  p.supplier || 'Unknown Vendor',
          bill_no:      p.invoice_no || `PROC-${req.params.id}`,
          bill_date:    today,
          due_date:     dueDate,
          amount,
          gst_amount:   gstAmt,
          category:     'Raw Materials',
          notes:        `Auto: ${p.commodityName} ${qty}kg @ ₹${rate}/kg`,
          status:       'unpaid',
          paid_amount:  0,
          created_by:   req.user?.email || 'system',
        }).select('id').single();

        if (payable) {
          await supabase.from('procurements').update({ payable_id: payable.id }).eq('id', req.params.id);
          console.log(`[AUTO] Vendor payable created for procurement ${req.params.id}: ₹${amount}`);
        }
      } catch (e) { console.error('[AUTO] Procurement payable error:', e.message); }
    });
  }

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
// Format: SA{YYYY}{MMM}{DD}-{NN}  e.g. SA2026APR17-01
sales.get('/next-invoice-no', auth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const d = new Date();
  const prefix = `SA${d.getFullYear()}${months[d.getMonth()]}${String(d.getDate()).padStart(2,'0')}`;
  const [s, w] = await Promise.all([
    supabase.from('sales').select('id', { count: 'exact', head: true }).eq('date', today),
    supabase.from('webstore_orders').select('id', { count: 'exact', head: true }).eq('date', today),
  ]);
  const seq = (s.count || 0) + (w.count || 0) + 1;
  res.json({ formatted: `${prefix}-${String(seq).padStart(2,'0')}`, prefix, seq });
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
  // Non-blocking: Zoho Books + finished goods deduction + admin WA alert
  setImmediate(async () => {
    // ── Admin WhatsApp alert for new POS/local sale ───────────────────────────
    try {
      const adminNumbers = [
        process.env.WA_NOTIFY_TO,
        process.env.WA_ADMIN_PHONE1,
        process.env.WA_ADMIN_PHONE2,
      ].filter(Boolean).map(n => n.replace(/\D/g,'')).filter((v,i,a) => v && a.indexOf(v) === i);

      const itemLines = (s.items || []).map(i => `  • ${i.productName} × ${i.qty}  ₹${i.total}`).join('\n');
      const alertText =
        `🏪 *New POS Sale — ${s.orderNo}*\n\n` +
        `👤 *${s.customerName || 'Walk-in'}*\n` +
        `📞 ${s.customerPhone || '—'}\n` +
        `💳 ${s.paymentMethod?.toUpperCase() || 'CASH'}\n\n` +
        `📋 *Items:*\n${itemLines}\n\n` +
        `💰 *Total: ₹${parseFloat(s.finalAmount || s.totalAmount || 0).toLocaleString('en-IN')}*` +
        `${s.discount ? `  |  🎁 Discount: ₹${s.discount}` : ''}\n\n` +
        `📊 admin.sathvam.in → Sales`;

      const sendViaBS = async (phone, message) => {
        const token   = process.env.BOTSAILOR_API_TOKEN;
        const phoneId = process.env.BOTSAILOR_PHONE_NUMBER_ID || process.env.WA_PHONE_NUMBER_ID;
        if (!token || !phoneId) return;
        const params = new URLSearchParams({ apiToken: token, phone_number_id: phoneId, phone_number: phone, message });
        await fetch('https://botsailor.com/api/v1/whatsapp/send', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
      };

      for (const phone of adminNumbers) {
        try { await sendViaBS(phone, alertText); } catch {}
      }
    } catch (waErr) {
      console.error('POS sale WA alert error:', waErr.message);
    }

    if (process.env.ZOHO_ORG_ID) {
      try {
        const zohoOrder = {
          orderNo:  s.orderNo,
          date:     s.date || new Date().toISOString().slice(0, 10),
          customer: { name: s.customerName || 'Walk-in Customer', email: null, phone: s.customerPhone || '' },
          items:    (s.items || []).map(i => ({ name: i.productName, qty: i.qty, price: i.rate })),
          shipping: 0,
          total:    parseFloat(s.finalAmount) || 0,
        };
        const invoice = await createInvoice(zohoOrder);
        if (invoice?.invoice_id && parseFloat(s.amountPaid) > 0) {
          await recordPayment(invoice, s.amountPaid, s.paymentMethod || 'cash', s.orderNo);
        }
      } catch (ze) {
        console.error('Zoho POS invoice error:', ze.message);
      }
    }

    // Auto-deduct from finished goods
    try {
      const fgItems = (s.items || []).filter(i => parseFloat(i.qty) > 0);
      if (fgItems.length) {
        await supabase.from('finished_goods').insert(
          fgItems.map(i => ({
            product_name: i.productName || '',
            category:     'other',
            unit:         i.unit || 'pcs',
            qty:          parseFloat(i.qty),
            type:         'out',
            date:         s.date || new Date().toISOString().slice(0, 10),
            notes:        `Auto: POS sale ${s.orderNo}`,
            batch_ref:    s.orderNo || '',
            created_by:   'system',
            created_at:   new Date().toISOString(),
            updated_at:   new Date().toISOString(),
          }))
        );
      }
    } catch (fgErr) {
      console.error('Finished goods POS deduction error:', fgErr.message);
    }
  });
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

// Safe keys that can be read/written via the admin UI
// NOTE: these specific routes must come BEFORE the /:key wildcard below
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
    config[key] = val; // return actual value — admin-only authenticated endpoint
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

// Wildcard key-value routes — must come AFTER specific named routes above
settings.get('/:key', auth, async (req, res) => {
  const { data } = await supabase.from('settings').select('value').eq('key', req.params.key).maybeSingle();
  res.json(data?.value ?? null);
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
