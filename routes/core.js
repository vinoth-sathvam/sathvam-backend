const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const nodemailer = require('nodemailer');
const supabase = require('../config/supabase');
const { auth, requireRole } = require('../middleware/auth');
const { createInvoice, recordPayment } = require('../config/zoho');
const { sendText: gaSendText } = require('../lib/greenapi');
const { insertLedger } = require('../utils/ledger');
const { bustCache } = require('./public');

const procUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const INVOICE_MIME = { 'image/jpeg':'jpg','image/jpg':'jpg','image/png':'png','image/webp':'webp','application/pdf':'pdf' };
async function ensurePOBillsBucket() {
  const { data: buckets } = await supabase.storage.listBuckets();
  if (!buckets?.find(b => b.name === 'po-bills')) {
    await supabase.storage.createBucket('po-bills', { public: true, fileSizeLimit: 10485760 });
  }
}

const ENV_PATH = path.join(__dirname, '../.env');

function updateEnvVar(key, value) {
  let content = '';
  try {
    content = fs.readFileSync(ENV_PATH, 'utf8');
  } catch (e) {
    // .env doesn't exist yet in container — start with empty file
    content = '';
  }
  const regex = new RegExp(`^${key}=.*`, 'm');
  const line = `${key}=${value}`;
  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    content += (content && !content.endsWith('\n') ? '\n' : '') + line + '\n';
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
    pack_size:p.packSize, pack_unit:p.packUnit, pcs_per_box:p.pcsPerBox||null,
    oil_type_key:p.oilTypeKey,
    raw_mat_key:p.rawMatKey, cake_type_key:p.cakeTypeKey||null,
    reorder:p.reorder||0, gst:p.gst||0,
    price:p.price||0, retail_price:p.retailPrice, website_price:p.websitePrice,
    intl_price:p.intlPrice, retail_profit_pct:p.retailProfitPct,
    web_profit_pct:p.webProfitPct, web_courier_charge:p.webCourierCharge,
    intl_profit_pct:p.intlProfitPct, intl_carton_key:p.intlCartonKey,
    label_cost:p.labelCost||0, pkg_type_key:p.pkgTypeKey, featured:p.featured||false,
    image_url:p.imageUrl||null, description:p.description||null, hsn_code:p.hsnCode||null,
    commodity_id:p.commodityId||null
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });

  // Auto-link packing materials (label + container) in background
  autoLinkPacking(data).then(links => {
    if (links) supabase.from('products').update({ packing_links: links }).eq('id', data.id).then(()=>{});
  });

  res.status(201).json(data);
});
// Bulk packing auto-link — re-runs autoLinkPacking for all products missing packing
products.post('/run-packing-autolink', auth, requireRole('admin'), async (req, res) => {
  const { data: prods } = await supabase.from('products').select('id,name,cat,pack_size,pack_unit,packing_links').eq('active', true);
  if (!prods?.length) return res.json({ updated: 0 });
  const toProcess = prods.filter(p => {
    const links = p.packing_links || {};
    const matIds = Array.isArray(links.materialIds) ? links.materialIds : (links.coverId ? [links.coverId] : []);
    return matIds.length === 0 && !links.labelId; // only process products with no packing at all
  });
  let updated = 0;
  for (const prod of toProcess) {
    const links = await autoLinkPacking(prod);
    if (links) {
      await supabase.from('products').update({ packing_links: links }).eq('id', prod.id);
      updated++;
    }
  }
  res.json({ total: toProcess.length, updated });
});

// Batch price/field update — must be before /:id so Express doesn't match "batch" as an id
products.put('/batch', auth, requireRole('admin', 'manager'), async (req, res) => {
  const prods = Array.isArray(req.body) ? req.body : [];
  if (prods.length === 0) return res.json({ updated: 0 });
  const updates = prods.filter(p => p.id).map(p => ({
    id: p.id,
    name: p.name, sku: p.sku, cat: p.cat, unit: p.unit,
    pack_size: p.packSize, pack_unit: p.packUnit, pcs_per_box: p.pcsPerBox ?? null,
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
    image_url: p.imageUrl ?? p.image_url ?? undefined,
    description: p.description ?? undefined,
    hsn_code: p.hsnCode ?? undefined,
    commodity_id: p.commodityId ?? null,
    fssai_license: p.fssaiLicense ?? null,
  }));
  const { error } = await supabase.from('products').upsert(updates, { onConflict: 'id' });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ updated: updates.length });
});
products.put('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  const p = req.body;
  const raw = {
    name:p.name, sku:p.sku, cat:p.cat, unit:p.unit,
    pack_size:p.packSize, pack_unit:p.packUnit, pcs_per_box:p.pcsPerBox,
    oil_type_key:p.oilTypeKey,
    cake_type_key:p.cakeTypeKey, reorder:p.reorder, gst:p.gst, price:p.price,
    retail_price:p.retailPrice, website_price:p.websitePrice,
    intl_price:p.intlPrice, retail_profit_pct:p.retailProfitPct,
    web_profit_pct:p.webProfitPct, web_courier_charge:p.webCourierCharge,
    intl_profit_pct:p.intlProfitPct, intl_carton_key:p.intlCartonKey,
    label_cost:p.labelCost, pkg_type_key:p.pkgTypeKey,
    packing_links:p.packingLinks, featured:p.featured,
    image_url:p.imageUrl??p.image_url, description:p.description, hsn_code:p.hsnCode,
    offer_label:p.offer_label, offer_price:p.offer_price,
    offer_ends_at:p.offer_ends_at, commodity_id:p.commodityId,
    fssai_license:p.fssaiLicense,
  };
  // Remove undefined keys so Supabase only updates fields actually provided
  const fields = Object.fromEntries(Object.entries(raw).filter(([,v]) => v !== undefined));
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'No fields to update' });
  const { data, error } = await supabase.from('products').update(fields).eq('id', req.params.id).select().single();
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
// POST /api/products/bulk-offer — apply % discount to ALL products by category + blast email
products.post('/bulk-offer', auth, requireRole('admin','manager'), async (req, res) => {
  const { oils_pct = 5, others_pct = 2.5, end_date, label } = req.body;
  if (!end_date) return res.status(400).json({ error: 'end_date required (YYYY-MM-DD)' });

  const endDateTime = end_date + 'T23:59:59';
  const endFmt = new Date(endDateTime).toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long', year:'numeric' });

  // 1. Fetch all active, non-raw products
  const { data: prods, error: pe } = await supabase
    .from('products')
    .select('id, name, cat, website_price, price')
    .eq('active', true)
    .neq('cat', 'raw');
  if (pe) return res.status(500).json({ error: pe.message });

  // 2. Compute and apply offer_price per product
  let updated = 0;
  const oilLabel   = label || `${oils_pct}% OFF`;
  const otherLabel = label || `${others_pct}% OFF`;

  for (const p of prods) {
    const base = parseFloat(p.website_price || p.price) || 0;
    if (base <= 0) continue;
    const isOil  = p.cat === 'oil';
    const pct    = isOil ? oils_pct : others_pct;
    const offPrc = Math.round(base * (1 - pct / 100));
    const lbl    = isOil ? oilLabel : otherLabel;
    await supabase.from('products').update({
      offer_label:   lbl,
      offer_price:   offPrc,
      offer_ends_at: endDateTime,
    }).eq('id', p.id);
    updated++;
  }

  // 3. Fetch all customers + newsletter subscribers
  const { data: customers } = await supabase.from('customers').select('name, email, phone').not('email', 'is', null);
  const { data: nlRow }     = await supabase.from('store_analytics').select('data').eq('key', 'newsletter_subscribers').maybeSingle();
  const nlEmails            = (nlRow?.data || []).map(s => s.email).filter(Boolean);
  const recipMap = {};
  for (const c of (customers || [])) {
    if (c.email) recipMap[c.email.toLowerCase()] = { name: c.name || 'Valued Customer', phone: c.phone };
  }
  for (const e of nlEmails) {
    if (!recipMap[e]) recipMap[e] = { name: 'Valued Customer', phone: null };
  }
  const recipients = Object.entries(recipMap).map(([email, d]) => ({ email, ...d }));

  // 4. Send bulk email
  const emailHtml = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f7f3ef;font-family:Georgia,serif;">
  <div style="max-width:580px;margin:32px auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.10);">
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#7b4f28,#c8813a);padding:32px;text-align:center;">
      <div style="font-size:36px;margin-bottom:8px;">🎉</div>
      <h1 style="color:#fff;margin:0 0 6px;font-size:26px;letter-spacing:1px;">Flash Sale — Today Only!</h1>
      <p style="color:#fde8cc;margin:0;font-size:14px;">Offer ends ${endFmt}</p>
    </div>
    <!-- Offer boxes -->
    <div style="padding:32px 32px 16px;">
      <p style="font-size:15px;color:#444;margin-top:0;">Dear {{NAME}},</p>
      <p style="font-size:15px;color:#444;">We're excited to share an exclusive limited-time offer on our pure cold-pressed products!</p>
      <div style="display:flex;gap:16px;margin:24px 0;flex-wrap:wrap;">
        <div style="flex:1;min-width:200px;background:linear-gradient(135deg,#fff8f0,#fde8cc);border:2px solid #c8813a;border-radius:12px;padding:20px;text-align:center;">
          <div style="font-size:28px;font-weight:900;color:#c8813a;">${oils_pct}% OFF</div>
          <div style="font-size:15px;font-weight:700;color:#7b4f28;margin-top:4px;">🫙 All Cold-Pressed Oils</div>
          <div style="font-size:12px;color:#8a6a4a;margin-top:6px;">Sesame · Groundnut · Coconut & more</div>
        </div>
        <div style="flex:1;min-width:200px;background:linear-gradient(135deg,#f0fdf4,#dcfce7);border:2px solid #16a34a;border-radius:12px;padding:20px;text-align:center;">
          <div style="font-size:28px;font-weight:900;color:#16a34a;">${others_pct}% OFF</div>
          <div style="font-size:15px;font-weight:700;color:#14532d;margin-top:4px;">🌾 All Other Products</div>
          <div style="font-size:12px;color:#4a7a50;margin-top:6px;">Grains · Spices · Natural Foods</div>
        </div>
      </div>
      <div style="background:#fef9f0;border-radius:10px;padding:14px 18px;border-left:4px solid #c8813a;margin-bottom:24px;">
        <div style="font-size:13px;color:#7b4f28;font-weight:700;">⏰ Hurry — Offer ends ${endFmt}</div>
        <div style="font-size:12px;color:#9a8a78;margin-top:4px;">Discount automatically applied at checkout. No coupon code needed.</div>
      </div>
      <div style="text-align:center;margin:28px 0;">
        <a href="https://sathvam.in" style="background:linear-gradient(135deg,#c8813a,#7b4f28);color:#fff;padding:14px 36px;border-radius:10px;text-decoration:none;font-size:16px;font-weight:bold;display:inline-block;letter-spacing:.5px;">Shop Now & Save →</a>
      </div>
    </div>
    <!-- Footer -->
    <div style="background:#f7f3ef;padding:16px 32px;text-align:center;border-top:1px solid #e8dfc8;">
      <p style="font-size:12px;color:#9a8a78;margin:0;">Sathvam Natural Products · Pure · Cold-Pressed · Chemical-Free</p>
      <p style="font-size:11px;color:#b0a090;margin:6px 0 0;"><a href="https://sathvam.in" style="color:#c8813a;text-decoration:none;">sathvam.in</a> · <a href="https://sathvam.in" style="color:#9a8a78;text-decoration:none;">Unsubscribe</a></p>
    </div>
  </div>
</body>
</html>`;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  let emailSent = 0;
  const BATCH = 10;
  for (let i = 0; i < recipients.length; i += BATCH) {
    const batch = recipients.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(r =>
      transporter.sendMail({
        from: process.env.SMTP_FROM || `Sathvam <${process.env.SMTP_USER}>`,
        to: r.email,
        subject: `🎉 Flash Sale: ${oils_pct}% off Oils, ${others_pct}% off Everything — Ends ${endFmt}`,
        html: emailHtml.replace('{{NAME}}', r.name || 'Valued Customer'),
      }).then(() => emailSent++).catch(e => console.error(`Bulk offer email failed ${r.email}:`, e.message))
    ));
  }

  // Bust the public products cache so the store immediately shows updated offer prices
  bustCache();

  res.json({ ok: true, products_updated: updated, emails_sent: emailSent, total_recipients: recipients.length, offer_ends: endDateTime });
});

// POST /api/products/clear-offers — remove all active offers from all products
products.post('/clear-offers', auth, requireRole('admin'), async (req, res) => {
  const { error } = await supabase.from('products').update({ offer_label: null, offer_price: null, offer_ends_at: null }).eq('active', true);
  if (error) return res.status(400).json({ error: error.message });
  bustCache();
  res.json({ ok: true });
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

  // If stock came IN, notify any subscribers for this product (fire-and-forget)
  if (s.type === 'IN' && s.productId) {
    setImmediate(() => sendBackInStockNotifications(s.productId, s.productName).catch(() => {}));
  }
});

// Fire back-in-stock emails when a product gets restocked
async function sendBackInStockNotifications(productId, productName) {
  try {
    const { data: subs } = await supabase
      .from('stock_notify')
      .select('id,email,name')
      .eq('product_id', productId)
      .is('notified_at', null);
    if (!subs || subs.length === 0) return;

    const nodemailer = require('nodemailer');
    const mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    for (const sub of subs) {
      try {
        await mailer.sendMail({
          from: process.env.SMTP_FROM || `Sathvam <${process.env.SMTP_USER}>`,
          to: sub.email,
          subject: `✅ ${productName} is back in stock!`,
          html: `
<div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
  <div style="background:linear-gradient(135deg,#14532d,#166534);padding:20px 24px;">
    <h2 style="color:#fff;margin:0;font-size:17px;">Good news${sub.name ? ', ' + sub.name.split(' ')[0] : ''}! 🎉</h2>
  </div>
  <div style="padding:24px;">
    <p style="margin:0 0 16px;color:#6b7280;font-size:14px;line-height:1.6;">
      <strong style="color:#1f2937;">${productName}</strong> is back in stock!
      Order now before it sells out again.
    </p>
    <a href="https://sathvam.in" style="display:inline-block;background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:800;font-size:15px;">Shop Now →</a>
    <p style="margin:16px 0 0;font-size:11px;color:#9ca3af;">You signed up for this alert at sathvam.in</p>
  </div>
</div>`,
        });
        // Mark as notified
        await supabase.from('stock_notify').update({ notified_at: new Date().toISOString() }).eq('id', sub.id);
        console.log(`Back-in-stock email sent: ${sub.email} for ${productName}`);
      } catch (e) { console.error(`Back-in-stock email failed for ${sub.email}:`, e.message); }
    }
  } catch (e) { console.error('sendBackInStockNotifications error:', e.message); }
}

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
  // Map snake_case DB fields to camelCase for frontend
  const mapped = (data||[]).map(p => ({
    ...p,
    commodityId:       p.commodity_id,
    commodityName:     p.commodity_name,
    vendorId:          p.vendor_id,
    orderedQty:        p.ordered_qty,
    orderedPricePerKg: p.ordered_price_per_kg,
    receivedQty:       p.received_qty,
    cleanedQty:        p.cleaned_qty,
    receivedDate:      p.received_date,
    cleanedDate:       p.cleaned_date,
    paymentStatus:     p.payment_status || 'unpaid',
    paymentTiming:     p.payment_timing || 'after_receipt',
    paymentMethod:     p.payment_method,
    paymentRef:        p.payment_ref,
    invoiceNo:         p.invoice_no,
    invoiceAmount:     p.invoice_amount,
    advancePaid:       p.advance_paid,
    finalPaid:         p.final_paid,
    logisticsCostPerKg: p.logistics_cost_per_kg,
    landedCostPerKg:   p.landed_cost_per_kg,
    vendorBillNo:      p.vendor_bill_no,
    billScanUrl:       p.bill_scan_url,
  }));
  res.json(mapped);
});
// Returns latest landed cost per commodity_id from most recent stocked/received procurement
procurement.get('/commodity-costs', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('procurements')
      .select('commodity_id, commodity_name, ordered_price_per_kg, ordered_qty, logistics_cost_per_kg, gst, date, supplier, status')
      .in('status', ['stocked', 'cleaned', 'received'])
      .not('commodity_id', 'is', null)
      .order('date', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    // Weighted-average landed cost per commodity across all qualifying procurements
    const groups = {};
    (data || []).forEach(p => {
      const cid = p.commodity_id;
      if (!groups[cid]) groups[cid] = { commodityName: p.commodity_name, entries: [] };
      const baseAndLogistics   = parseFloat(p.ordered_price_per_kg) || 0;
      const gstPct             = parseFloat(p.gst) || 0;
      const logisticsCostPerKg = parseFloat(p.logistics_cost_per_kg) || 0;
      const qty                = parseFloat(p.ordered_qty) || 0;
      // Base (ex-logistics) — GST applies to vendor invoice only, NOT to freight
      const basePerKg  = baseAndLogistics - logisticsCostPerKg;
      const gstAmount  = basePerKg * gstPct / 100;
      const landedCost = basePerKg + gstAmount + logisticsCostPerKg;
      groups[cid].entries.push({ qty, landedCost, basePerKg, gstAmount, logisticsCostPerKg, gstPct, date: p.date, supplier: p.supplier });
    });

    const costMap = {};
    Object.entries(groups).forEach(([cid, g]) => {
      const totalQty    = g.entries.reduce((s, e) => s + e.qty, 0);
      const wavgLanded  = totalQty > 0
        ? g.entries.reduce((s, e) => s + e.landedCost * e.qty, 0) / totalQty
        : (g.entries[0]?.landedCost || 0);
      const wavgBase    = totalQty > 0
        ? g.entries.reduce((s, e) => s + e.basePerKg * e.qty, 0) / totalQty : 0;
      const wavgGst     = totalQty > 0
        ? g.entries.reduce((s, e) => s + e.gstAmount * e.qty, 0) / totalQty : 0;
      const wavgLogist  = totalQty > 0
        ? g.entries.reduce((s, e) => s + e.logisticsCostPerKg * e.qty, 0) / totalQty : 0;
      // For display: most recent date + unique suppliers
      const latestDate  = g.entries[0]?.date;
      const suppliers   = [...new Set(g.entries.map(e => e.supplier).filter(Boolean))].join(', ');
      const gstPct      = g.entries[0]?.gstPct || 0;
      const batchCount  = g.entries.length;
      costMap[cid] = {
        commodityId:        cid,
        commodityName:      g.commodityName,
        costPerKg:          Math.round(wavgLanded  * 100) / 100,
        basePerKg:          Math.round(wavgBase    * 100) / 100,
        gstAmount:          Math.round(wavgGst     * 100) / 100,
        logisticsCostPerKg: Math.round(wavgLogist  * 100) / 100,
        gstPct,
        totalQtyKg:         Math.round(totalQty    * 100) / 100,
        batchCount,
        date:               latestDate,
        supplier:           suppliers,
      };
    });
    res.json(costMap);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

procurement.post('/', auth, requireRole('admin','manager'), async (req, res) => {
  const p = req.body;
  const payStatus = p.paymentStatus || 'unpaid';
  const { data, error } = await supabase.from('procurements').insert({
    date:p.date, commodity_id:p.commodityId, commodity_name:p.commodityName,
    supplier:p.supplier, vendor_id:p.vendorId||null,
    ordered_qty:p.orderedQty, ordered_price_per_kg:p.orderedPricePerKg,
    gst:parseFloat(p.gst)||0,
    hsn_code: p.hsnCode||p.hsn_code||null,
    received_qty:p.receivedQty||null, cleaned_qty:p.cleanedQty||null,
    status:p.status||'ordered', notes:p.notes||'',
    purchase_order_id:p.purchase_order_id||null, invoice_no:p.invoice_no||null,
    payment_status: payStatus,
    payment_method: p.paymentMethod||null,
    payment_ref:    p.paymentRef||null,
    advance_paid:   parseFloat(p.advancePaid)||null,
    final_paid:     parseFloat(p.finalPaid)||null,
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });

  // If paid upfront (advance or fully), auto-create (or link to) vendor bill
  // One invoice may cover multiple POs — check by vendor+invoice_no before creating
  if (['advance','paid'].includes(payStatus) && data) {
    setImmediate(async () => {
      try {
        const invoiceNo  = p.invoice_no || null;
        const vendorName = p.supplier || 'Unknown Vendor';

        // Check if a vendor bill already exists for this vendor + invoice number
        if (invoiceNo) {
          const { data: existBill } = await supabase.from('vendor_bills')
            .select('id').ilike('vendor_name', vendorName).eq('bill_no', invoiceNo)
            .is('deleted_at', null).limit(1).single();
          if (existBill) {
            await supabase.from('procurements').update({ payable_id: existBill.id }).eq('id', data.id);
            console.log(`[AUTO] PO ${data.id} linked to existing vendor bill ${existBill.id} (invoice ${invoiceNo})`);
            return;
          }
        }

        const qty        = parseFloat(p.orderedQty) || 0;
        const rate       = parseFloat(p.orderedPricePerKg) || 0;
        const calcAmount = Math.round(qty * rate * 100) / 100;
        const invoiceAmt = parseFloat(p.invoiceAmount) || 0;
        const amount     = invoiceAmt > 0 ? invoiceAmt : calcAmount;
        const gstPct     = parseFloat(p.gst) || 0;
        const gstAmt     = invoiceAmt > 0 ? 0 : Math.round(calcAmount * gstPct / 100 * 100) / 100;
        if (amount <= 0) return;

        const advPaid    = parseFloat(p.advancePaid) || 0;
        const isFullPaid = payStatus === 'paid';
        const paidAmt    = isFullPaid ? amount : advPaid;

        const { data: payable } = await supabase.from('vendor_bills').insert({
          vendor_name:  vendorName,
          bill_no:      invoiceNo || `PROC-${data.id}`,
          bill_date:    p.date || new Date().toISOString().slice(0,10),
          due_date:     p.date || new Date().toISOString().slice(0,10),
          amount,
          gst_amount:   gstAmt,
          paid_amount:  paidAmt,
          status:       isFullPaid ? 'paid' : 'partial',
          category:     'Raw Materials',
          notes:        `${isFullPaid?'Paid immediately (upfront)':'Advance paid'}: ${p.commodityName}${p.paymentRef?' | Ref: '+p.paymentRef:''}`,
          created_by:   req.user?.email || 'system',
        }).select('id').single();

        if (payable) {
          await supabase.from('procurements').update({ payable_id: payable.id }).eq('id', data.id);
          console.log(`[AUTO] Vendor bill created (upfront) for ${invoiceNo||'no-inv'}: ₹${amount}, paid ₹${paidAmt}`);
        }
      } catch(e) { console.error('[AUTO] Procurement upfront bill error:', e.message); }
    });
  }

  res.status(201).json(data);
});
procurement.put('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  const p = req.body;

  // Fetch existing record to detect status change → received
  const { data: existing } = await supabase.from('procurements').select('status,payable_id').eq('id', req.params.id).maybeSingle();

  const { data, error } = await supabase.from('procurements').update({
    date:p.date, commodity_id:p.commodityId||null, commodity_name:p.commodityName, supplier:p.supplier, vendor_id:p.vendorId||null,
    ordered_qty:p.orderedQty, ordered_price_per_kg:p.orderedPricePerKg,
    gst:parseFloat(p.gst)||0,
    received_qty:p.receivedQty||null, received_date:p.receivedDate||null,
    cleaned_qty:p.cleanedQty||null, cleaned_date:p.cleanedDate||null,
    status:p.status, notes:p.notes||'',
    payment_status:p.paymentStatus||null, payment_method:p.paymentMethod||null,
    payment_ref:p.paymentRef||null, invoice_amount:p.invoiceAmount||null,
    advance_paid:p.advancePaid||null, final_paid:p.finalPaid||null
  }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });

  // Auto-create (or link) vendor bill when status first changes to 'received' (goods arrived at factory)
  // Payment model: one vendor invoice covers multiple POs from same delivery.
  // So: if a vendor bill already exists for this vendor+invoice_no, link to it (don't create duplicate).
  // Only if not already paid upfront (advance/paid) — those already have a vendor bill from POST.
  const alreadyPaidUpfront = ['advance','paid'].includes(p.paymentStatus||existing?.payment_status);
  if (p.status === 'received' && !['received','cleaned','stocked'].includes(existing?.status) && !existing?.payable_id && !alreadyPaidUpfront) {
    setImmediate(async () => {
      try {
        const invoiceNo  = p.invoice_no || null;
        const vendorName = p.supplier || 'Unknown Vendor';

        // Check if a vendor bill already exists for this vendor + invoice number
        let existingBillId = null;
        if (invoiceNo) {
          const { data: existBill } = await supabase.from('vendor_bills')
            .select('id')
            .ilike('vendor_name', vendorName)
            .eq('bill_no', invoiceNo)
            .is('deleted_at', null)
            .limit(1)
            .single();
          if (existBill) existingBillId = existBill.id;
        }

        if (existingBillId) {
          // Link this PO to the existing vendor bill — same invoice, no duplicate
          await supabase.from('procurements').update({ payable_id: existingBillId }).eq('id', req.params.id);
          console.log(`[AUTO] PO ${req.params.id} linked to existing vendor bill ${existingBillId} (invoice ${invoiceNo})`);
          return;
        }

        // No existing bill — create one using the actual invoice amount if available
        const qty         = parseFloat(p.receivedQty || p.orderedQty) || 0;
        const rate        = parseFloat(p.orderedPricePerKg) || 0;
        const calcAmount  = Math.round(qty * rate * 100) / 100;
        const invoiceAmt  = parseFloat(p.invoiceAmount) || 0;
        // Use invoice amount (total from vendor's bill) if provided, else fall back to PO calc
        const amount      = invoiceAmt > 0 ? invoiceAmt : calcAmount;
        const gstPct      = parseFloat(p.gst) || 0;
        const gstAmt      = invoiceAmt > 0 ? 0 : Math.round(calcAmount * gstPct / 100 * 100) / 100; // GST already included in invoice amount
        if (amount <= 0) return;

        const today   = new Date().toISOString().slice(0, 10);
        const dueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const { data: payable } = await supabase.from('vendor_bills').insert({
          vendor_name:  vendorName,
          bill_no:      invoiceNo || `PROC-${req.params.id}`,
          bill_date:    p.receivedDate || today,
          due_date:     dueDate,
          amount,
          gst_amount:   gstAmt,
          category:     'Raw Materials',
          notes:        invoiceAmt > 0
            ? `Invoice ${invoiceNo} — covers multiple commodities. First item: ${p.commodityName}`
            : `Auto: ${p.commodityName} ${qty}kg @ ₹${rate}/kg`,
          status:       'unpaid',
          paid_amount:  0,
          created_by:   req.user?.email || 'system',
        }).select('id').single();

        if (payable) {
          await supabase.from('procurements').update({ payable_id: payable.id }).eq('id', req.params.id);
          console.log(`[AUTO] Vendor bill created for invoice ${invoiceNo||'no-inv'}: ₹${amount} (${vendorName})`);
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

// ── POST /procurement/mark-paid — mark entire PO group as paid ──────────────────
procurement.post('/mark-paid', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    const { purchase_order_id, payment_method, payment_ref, bank_account_id, paid_date, total_amount } = req.body;
    if (!purchase_order_id) return res.status(400).json({ error: 'purchase_order_id required' });
    if (!payment_method)    return res.status(400).json({ error: 'payment_method required' });

    const { data: entries, error: fetchErr } = await supabase.from('procurements')
      .select('id,ordered_qty,ordered_price_per_kg,gst,supplier')
      .eq('purchase_order_id', purchase_order_id);
    if (fetchErr || !entries?.length) return res.status(404).json({ error: 'No entries found' });

    const totalAmt = parseFloat(total_amount) || entries.reduce((s,e) => {
      const base = (parseFloat(e.ordered_qty)||0) * (parseFloat(e.ordered_price_per_kg)||0);
      return s + base * (1 + (parseFloat(e.gst)||0)/100);
    }, 0);

    // Update all entries in group
    const txDate = paid_date || new Date().toISOString().slice(0,10);
    await supabase.from('procurements').update({
      payment_status: 'paid',
      payment_method,
      payment_ref: payment_ref || null,
      final_paid:  Math.round(totalAmt * 100) / 100,
      invoice_amount: Math.round(totalAmt * 100) / 100,
    }).eq('purchase_order_id', purchase_order_id);

    // Record bank debit
    if (bank_account_id) {
      const { data: bank } = await supabase.from('bank_accounts').select('current_balance').eq('id', bank_account_id).single();
      await supabase.from('bank_transactions').insert({
        bank_account_id, date: txDate, type: 'debit', amount: Math.round(totalAmt*100)/100,
        description: `Raw material purchase — ${entries[0]?.supplier} (${purchase_order_id})`,
        reference: payment_ref || purchase_order_id, category: 'Raw Material Purchase',
        created_by: req.user?.email || '', created_at: new Date().toISOString(),
      });
      if (bank) await supabase.from('bank_accounts').update({
        current_balance: Math.round(((parseFloat(bank.current_balance)||0) - totalAmt)*100)/100,
      }).eq('id', bank_account_id);
    }
    // Auto-feed money_ledger — procurement payment
    insertLedger({
      txn_date:     txDate,
      direction:    'out',
      amount:       Math.round(totalAmt * 100) / 100,
      category:     'procurement',
      subcategory:  'raw_material',
      party:        entries[0]?.supplier || '',
      party_type:   'vendor',
      payment_mode: payment_method || 'bank_transfer',
      narration:    `Procurement payment — PO ${purchase_order_id}`,
      reference_no: payment_ref || purchase_order_id,
      source_table: 'procurements',
      source_id:    purchase_order_id,
      created_by:   req.user?.name || '',
    }).catch(() => {});

    res.json({ ok: true, entries_updated: entries.length, total_amount: totalAmt });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /procurement/add-logistics — split transport cost across one or multiple PO groups by weight ──
procurement.post('/add-logistics', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    const { purchase_order_id, purchase_order_ids, logistics_cost, logistics_ref, bank_account_id, paid_date } = req.body;
    const amount = parseFloat(logistics_cost);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'logistics_cost required' });

    // Support single PO (purchase_order_id) or multiple POs (purchase_order_ids array)
    const poIds = purchase_order_ids?.length ? purchase_order_ids : (purchase_order_id ? [purchase_order_id] : []);
    if (!poIds.length) return res.status(400).json({ error: 'purchase_order_id or purchase_order_ids required' });

    // Load all entries across all specified PO groups
    const { data: entries, error: fetchErr } = await supabase.from('procurements')
      .select('id,commodity_name,supplier,ordered_qty,ordered_price_per_kg,logistics_cost_per_kg,logistics_cost')
      .in('purchase_order_id', poIds);
    if (fetchErr || !entries?.length) return res.status(404).json({ error: 'No procurements found for specified POs' });

    const totalQty = entries.reduce((s, e) => s + (parseFloat(e.ordered_qty) || 0), 0);
    if (!totalQty) return res.status(400).json({ error: 'Total qty is zero' });

    const costPerKg = amount / totalQty; // exact — round per-entry

    // Update each entry: add proportional logistics share
    for (const entry of entries) {
      const qty = parseFloat(entry.ordered_qty) || 0;
      const prevLogPerKg  = parseFloat(entry.logistics_cost_per_kg) || 0;
      const newLogPerKg   = Math.round((prevLogPerKg + costPerKg) * 100) / 100;
      const newPricePerKg = Math.round(((parseFloat(entry.ordered_price_per_kg) || 0) + costPerKg) * 100) / 100;

      await supabase.from('procurements').update({
        logistics_cost_per_kg: newLogPerKg,
        landed_cost_per_kg:    newPricePerKg,
        ordered_price_per_kg:  newPricePerKg,
        logistics_ref:         logistics_ref || null,
        logistics_cost:        Math.round(((parseFloat(entry.logistics_cost) || 0) + (costPerKg * qty)) * 100) / 100,
      }).eq('id', entry.id);
    }

    // Record single bank debit for the full freight amount
    if (bank_account_id) {
      const txDate = paid_date || new Date().toISOString().slice(0, 10);
      const poLabel = poIds.length > 1 ? `${poIds.length} POs (${poIds.join(', ')})` : poIds[0];
      const suppliers = [...new Set(entries.map(e => e.supplier).filter(Boolean))].join(', ');
      const { data: bank } = await supabase.from('bank_accounts').select('current_balance').eq('id', bank_account_id).single();
      await supabase.from('bank_transactions').insert({
        bank_account_id,
        date: txDate,
        type: 'debit',
        amount,
        description: `Logistics — ${poLabel} (${suppliers})`,
        reference: logistics_ref || poIds.join(', '),
        category: 'Logistics',
        created_by: req.user?.email || '',
        created_at: new Date().toISOString(),
      });
      if (bank) {
        await supabase.from('bank_accounts').update({
          current_balance: Math.round(((parseFloat(bank.current_balance) || 0) - amount) * 100) / 100,
        }).eq('id', bank_account_id);
      }
    }

    // Auto-feed money_ledger — logistics cost
    const txDate = paid_date || new Date().toISOString().slice(0, 10);
    const suppliers = [...new Set(entries.map(e => e.supplier).filter(Boolean))].join(', ');
    insertLedger({
      txn_date:     txDate,
      direction:    'out',
      amount:       amount,
      category:     'procurement',
      subcategory:  'logistics',
      party:        suppliers || '',
      party_type:   'vendor',
      payment_mode: 'bank_transfer',
      narration:    `Procurement logistics — ${poIds.join(', ')}`,
      reference_no: logistics_ref || '',
      source_table: 'procurements',
      source_id:    poIds.join(','),
      created_by:   req.user?.name || '',
    }).catch(() => {});

    res.json({ ok: true, purchase_order_ids: poIds, logistics_cost: amount, cost_per_kg: Math.round(costPerKg * 100) / 100, entries_updated: entries.length, total_qty: Math.round(totalQty * 100) / 100 });
  } catch(e) { res.status(500).json({ error: e.message }); }
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

// ── POST /procurement/:id/attach-bill — attach vendor invoice (bill no + optional scan) ──
procurement.post('/:id/attach-bill', auth, requireRole('admin','manager'), procUpload.single('bill_scan'), async (req, res) => {
  try {
    await ensurePOBillsBucket();
    const { vendor_bill_no } = req.body;
    const updates = {};

    if (vendor_bill_no !== undefined) updates.vendor_bill_no = vendor_bill_no.trim();

    if (req.file) {
      const ext = INVOICE_MIME[req.file.mimetype];
      if (!ext) return res.status(400).json({ error: 'Invalid file type. Allowed: jpg, png, webp, pdf' });
      const fileName = `proc-${req.params.id}-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from('po-bills').upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype, upsert: true,
      });
      if (upErr) return res.status(500).json({ error: 'Upload failed: ' + upErr.message });
      const { data: urlData } = supabase.storage.from('po-bills').getPublicUrl(fileName);
      updates.bill_scan_url = urlData.publicUrl;
    }

    const { data, error } = await supabase.from('procurements').update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true, vendor_bill_no: data.vendor_bill_no, bill_scan_url: data.bill_scan_url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /procurement/ai-raise — parse natural language PO prompt ─────────────
procurement.post('/ai-raise', auth, requireRole('admin','manager'), async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'prompt required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'AI not configured' });

  const today = new Date().toISOString().slice(0, 10);

  // Fetch vendor list for context
  const { data: vendorList } = await supabase
    .from('vendors').select('id, display_name, company_name').eq('active', true).limit(300);
  const vendorNames = (vendorList || []).map(v => v.display_name || v.company_name).filter(Boolean).join(', ');

  const systemPrompt = `You are a procurement assistant for Sathvam Natural Products, a cold-pressed oil factory in Karur, Tamil Nadu.
Extract purchase order details from the user prompt and return ONLY a valid JSON object — no explanation, no markdown.

Known vendors: ${vendorNames || 'none on file'}
Today: ${today}

Return this exact JSON structure:
{
  "vendor": "vendor name string",
  "date": "YYYY-MM-DD",
  "invoiceNo": "PO reference or empty string",
  "notes": "any extra notes or empty string",
  "items": [
    {
      "commodityName": "item name",
      "orderedQty": <number>,
      "orderedPricePerKg": <number or 0 if not mentioned>,
      "gst": <number or 0>,
      "unit": "kg"
    }
  ]
}

Rules:
- Match vendor to known vendors (fuzzy match by name).
- If price not mentioned, use 0.
- If date not mentioned, use today (${today}).
- Quantities in kg unless clearly stated otherwise.
- invoiceNo: if user mentions an invoice/PO number use it, else empty string.`;

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const aiJson = await aiRes.json();
    if (!aiRes.ok) return res.status(502).json({ error: aiJson?.error?.message || 'AI error' });

    const raw = aiJson.content?.[0]?.text || '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return res.status(422).json({ error: 'Could not parse AI response', raw });

    const parsed = JSON.parse(match[0]);

    // Try to match vendor name to vendor master
    if (parsed.vendor && vendorList?.length) {
      const lower = parsed.vendor.toLowerCase();
      const matched = vendorList.find(v => {
        const dn = (v.display_name || '').toLowerCase();
        const cn = (v.company_name || '').toLowerCase();
        return dn.includes(lower) || lower.includes(dn) || cn.includes(lower) || lower.includes(cn);
      });
      if (matched) {
        parsed.vendorId = matched.id;
        parsed.vendor = matched.display_name || matched.company_name;
      }
    }

    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /procurement/parse-invoice — extract PO fields from uploaded PDF/image ──
procurement.post('/parse-invoice', auth, requireRole('admin','manager'), procUpload.single('invoice_pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const mime = req.file.mimetype;
    const allowed = ['application/pdf','image/jpeg','image/jpg','image/png','image/webp'];
    if (!allowed.includes(mime)) return res.status(400).json({ error: 'Only PDF or image files allowed' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'AI not configured' });

    const today = new Date().toISOString().slice(0, 10);
    const { data: vendorList } = await supabase
      .from('vendors').select('id, display_name, company_name').eq('active', true).limit(300);
    const vendorNames = (vendorList || []).map(v => v.display_name || v.company_name).filter(Boolean).join(', ');

    const base64 = req.file.buffer.toString('base64');
    const fileContent = mime === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
      : { type: 'image',    source: { type: 'base64', media_type: mime, data: base64 } };

    const systemPrompt = `You are a procurement assistant for Sathvam Natural Products, a cold-pressed oil factory in Tamil Nadu.
Extract purchase order / supplier invoice details from the document and return ONLY a valid JSON object — no explanation, no markdown, no code fences.

Known vendors: ${vendorNames || 'none on file'}
Today: ${today}

Return this exact JSON structure:
{
  "vendor": "supplier/vendor name",
  "date": "YYYY-MM-DD (invoice date or today if not found)",
  "invoiceNo": "invoice or PO number from document, or empty string",
  "paymentTerms": "payment terms if mentioned, else empty string",
  "notes": "any relevant notes or empty string",
  "items": [
    {
      "commodityName": "item/commodity name",
      "orderedQty": <number in kg>,
      "orderedPricePerKg": <price per kg as number, 0 if not found>,
      "gst": <GST% as number: 0/5/12/18, 0 if not stated>,
      "hsnCode": "HSN/SAC code string if found on invoice, else empty string"
    }
  ]
}

Rules:
- Extract ALL line items from the invoice.
- Match vendor name to known vendors (fuzzy).
- Convert quantities to kg (1 quintal = 100 kg, 1 tonne = 1000 kg).
- Price per unit: if invoice shows total ÷ qty to get rate/kg.
- GST: if invoice shows CGST+SGST combine them (e.g. 2.5+2.5 = 5%).
- invoiceNo: use invoice number / bill number / challan number from document.
- If date not found use today (${today}).`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json',
        'anthropic-beta': 'pdfs-2024-09-25' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: [
          fileContent,
          { type: 'text', text: 'Extract all purchase order details from this invoice document.' }
        ]}],
      }),
    });
    const aiJson = await aiRes.json();
    if (!aiRes.ok) return res.status(502).json({ error: aiJson?.error?.message || 'AI error' });

    const raw = aiJson.content?.[0]?.text || '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return res.status(422).json({ error: 'Could not parse AI response', raw });

    const parsed = JSON.parse(match[0]);

    // Fuzzy match vendor to vendor master
    if (parsed.vendor && vendorList?.length) {
      const lower = parsed.vendor.toLowerCase();
      const matched = vendorList.find(v => {
        const dn = (v.display_name || '').toLowerCase();
        const cn = (v.company_name || '').toLowerCase();
        return dn.includes(lower) || lower.includes(dn) || cn.includes(lower) || lower.includes(cn);
      });
      if (matched) { parsed.vendorId = matched.id; parsed.vendor = matched.display_name || matched.company_name; }
    }

    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

      for (const phone of adminNumbers) {
        try { await gaSendText(phone, alertText); } catch {}
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

    // Auto-deduct from finished goods + stock_ledger
    try {
      const fgItems = (s.items || []).filter(i => parseFloat(i.qty) > 0);
      const saleDate = s.date || new Date().toISOString().slice(0, 10);
      if (fgItems.length) {
        await supabase.from('finished_goods').insert(
          fgItems.map(i => ({
            product_name: i.productName || '',
            category:     'other',
            unit:         i.unit || 'pcs',
            qty:          parseFloat(i.qty),
            type:         'out',
            date:         saleDate,
            notes:        `Auto: POS sale ${s.orderNo}`,
            batch_ref:    s.orderNo || '',
            created_by:   'system',
            created_at:   new Date().toISOString(),
            updated_at:   new Date().toISOString(),
          }))
        );

        // Also decrement stock_ledger so StockProfitForecast stays accurate
        const ledgerRows = fgItems
          .filter(i => i.productId)
          .map(i => ({
            product_id:   i.productId,
            product_name: i.productName || '',
            date:         saleDate,
            type:         'out',
            qty:          parseFloat(i.qty),
            unit:         i.unit || 'pcs',
            rate:         parseFloat(i.rate) || 0,
            total_value:  parseFloat(i.total) || 0,
            channel:      'sale',
            reference:    s.orderNo || '',
            notes:        `POS sale — ${s.orderNo}`,
          }));
        if (ledgerRows.length) {
          await supabase.from('stock_ledger').insert(ledgerRows);
        }
      }
    } catch (fgErr) {
      console.error('Finished goods POS deduction error:', fgErr.message);
    }

    // Auto-feed money_ledger — POS sale income
    insertLedger({
      txn_date:     s.date || new Date().toISOString().slice(0, 10),
      direction:    'in',
      amount:       parseFloat(s.finalAmount || s.totalAmount) || 0,
      category:     'sales',
      subcategory:  'pos',
      party:        s.customerName || 'Walk-in',
      party_type:   'customer',
      payment_mode: s.paymentMethod || 'cash',
      narration:    `POS sale ${s.orderNo}`,
      reference_no: s.orderNo || '',
      source_table: 'sales',
      source_id:    String(sale.id),
      created_by:   req.user?.name || '',
    }).catch(() => {});
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
  'GREENAPI_INSTANCE_ID','GREENAPI_API_TOKEN','WA_ADMIN_PHONE1','WA_ADMIN_PHONE2','WA_NOTIFY_TO','WA_DISABLED',
  'ZOHO_CLIENT_ID','ZOHO_CLIENT_SECRET','ZOHO_ORG_ID','ZOHO_REFRESH_TOKEN',
  'VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','VAPID_SUBJECT',
  'ANTHROPIC_API_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_ADS_DEVELOPER_TOKEN','GOOGLE_ADS_CUSTOMER_ID','GOOGLE_ADS_LOGIN_CUSTOMER_ID',
  'GOOGLE_ADS_CLIENT_ID','GOOGLE_ADS_CLIENT_SECRET','GOOGLE_ADS_REFRESH_TOKEN',
  'FRONTEND_URL','PORTAL_URL',
];
const SECRET_KEYS = new Set(['SMTP_PASS','RAZORPAY_KEY_SECRET','RAZORPAY_WEBHOOK_SECRET','GREENAPI_API_TOKEN','ZOHO_CLIENT_SECRET','ZOHO_REFRESH_TOKEN','VAPID_PRIVATE_KEY','ANTHROPIC_API_KEY','GOOGLE_ADS_DEVELOPER_TOKEN','GOOGLE_ADS_CLIENT_SECRET','GOOGLE_ADS_REFRESH_TOKEN']);

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
  try {
    for (const [key, value] of Object.entries(updates)) {
      if (!EDITABLE_KEYS.includes(key)) continue;
      if (value === '' || value === '••••••••') continue; // skip blanks and masked placeholders
      updateEnvVar(key, value);
      saved.push(key);
    }
    res.json({ success: true, saved });
  } catch (e) {
    console.error('[env-config] save error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── WhatsApp global on/off toggle ────────────────────────────────────────────
settings.post('/wa-toggle', auth, requireRole('admin'), (req, res) => {
  const disable = req.body.disabled === true || req.body.disabled === 'true';
  const value   = disable ? 'true' : 'false';
  updateEnvVar('WA_DISABLED', value);
  console.log(`[WA-TOGGLE] WhatsApp ${disable ? 'DISABLED' : 'ENABLED'} by ${req.user?.name || 'admin'}`);
  res.json({ success: true, wa_disabled: disable });
});

settings.get('/wa-status', auth, requireRole('admin','manager'), (req, res) => {
  res.json({ wa_disabled: process.env.WA_DISABLED === 'true' });
});

// ── Per-automation WhatsApp toggles ─────────────────────────────────────────
settings.get('/wa-automations', auth, requireRole('admin'), async (req, res) => {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'wa_automations').maybeSingle();
    res.json(data?.value || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

settings.post('/wa-automations', auth, requireRole('admin'), async (req, res) => {
  try {
    const toggles = req.body; // { order_confirmed: false, flash_offer: false, ... }
    const { error } = await supabase.from('settings').upsert({ key: 'wa_automations', value: toggles, updated_at: new Date() });
    if (error) return res.status(500).json({ error: error.message });
    // Cache in process memory for fast checks
    global.__waAutomations = toggles;
    res.json({ success: true, automations: toggles });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
