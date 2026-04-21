const express    = require('express');
const http       = require('http');
const supabase   = require('../config/supabase');
const nodemailer = require('nodemailer');
const router     = express.Router();

// IP geolocation (shared with analytics.js — free ip-api.com, no key needed)
const _geoCache = new Map();
function geoIP(ip) {
  if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.')) return Promise.resolve(null);
  if (_geoCache.has(ip)) return Promise.resolve(_geoCache.get(ip));
  return new Promise(resolve => {
    http.get(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,city`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const geo = j.status === 'success' ? { country: j.country, countryCode: j.countryCode, city: j.city } : null;
          _geoCache.set(ip, geo);
          resolve(geo);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// Shared slug helper — keeps product URLs consistent with frontend toSlug()
const toSlug = (name) => (name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// ── Simple in-memory cache (avoids Supabase round-trip on every page load) ──
const cache = {};
const CACHE_TTL = 3 * 60 * 1000; // 3 minutes

function getCached(key) {
  const entry = cache[key];
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}
function setCached(key, data) {
  cache[key] = { data, ts: Date.now() };
}
// Allow admin to bust cache (called after product/settings updates)
router.post('/cache-bust', (req, res) => {
  Object.keys(cache).forEach(k => delete cache[k]);
  res.json({ ok: true });
});

// GET /api/public/products — no auth, returns website-enabled products + tamil names
router.get('/products', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
  const cached = getCached('products');
  if (cached) return res.json(cached);
  try {
    const [{ data: products, error }, { data: settings }] = await Promise.all([
      supabase.from('products').select('id,name,sku,cat,unit,pack_size,pack_unit,gst,price,website_price,retail_price,featured,active,hsn_code,description,image_url,offer_label,offer_price,offer_ends_at').eq('active', true).order('name'),
      supabase.from('settings').select('value').eq('key', 'website_enabled_products').single(),
    ]);
    if (error) return res.status(500).json({ error: "Server error" });

    const rawEnabled = settings?.value;
    const enabledArr = Array.isArray(rawEnabled) ? rawEnabled : (Array.isArray(rawEnabled?.value) ? rawEnabled.value : []);
    const enabledSet = new Set(enabledArr);
    // If nothing is explicitly enabled, show all active non-raw products with a price
    const websiteProducts = enabledSet.size > 0
      ? (products || []).filter(p => enabledSet.has(p.id) && p.cat !== 'raw')
      : (products || []).filter(p => p.cat !== 'raw' && (p.website_price || p.price) > 0);

    // Fetch tamil names — unwrap {value:{...}} if stored that way
    const { data: tamilSettings } = await supabase.from('settings').select('value').eq('key', 'product_tamil_names').single();
    const rawTamil = tamilSettings?.value;
    const tamilNames = (rawTamil && typeof rawTamil === 'object' && rawTamil.value && typeof rawTamil.value === 'object')
      ? rawTamil.value : (rawTamil || {});

    const result = { products: websiteProducts, tamilNames };
    setCached('products', result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/public/stock — no auth, returns aggregated stock per product_id
// Oil products: estimated from batch output (bulk L available → estimated bottles)
// Other products: stock_ledger in - out
router.get('/stock', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
  const cached = getCached('stock');
  if (cached) return res.json(cached);
  try {
    const [
      { data: ledger },
      { data: batches },
      { data: products },
      { data: procurements },
    ] = await Promise.all([
      supabase.from('stock_ledger').select('product_id,type,qty,channel'),
      supabase.from('batches').select('oil_type,oil_output'),
      supabase.from('products').select('id,oil_type_key,pack_size,pack_unit').eq('active', true),
      supabase.from('procurements').select('commodity_name,cleaned_qty,received_qty,ordered_qty,notes,status'),
    ]);

    // Step 1: aggregate ledger by product (in - out)
    const stock = {};
    for (const row of (ledger || [])) {
      if (!row.product_id) continue;
      const id = row.product_id;
      if (!stock[id]) stock[id] = 0;
      stock[id] += row.type === 'in' ? (+row.qty || 0) : -(+row.qty || 0);
    }

    // Oil density (kg/L) — same as frontend constants
    const OIL_DENSITY = { groundnut: 0.910, sesame: 0.920, coconut: 0.924 };

    // Step 2: total bulk oil liters from batches per oil type (oil_output stored in kg)
    const bulkOilL = {};
    for (const b of (batches || [])) {
      if (!b.oil_type) continue;
      const key = b.oil_type.toLowerCase();
      const density = OIL_DENSITY[key] || 0.915;
      bulkOilL[key] = (bulkOilL[key] || 0) + (parseFloat(b.oil_output) || 0) / density;
    }

    // Step 2b: also count procurement-based opening stock for bulk oil
    // e.g., "Groundnut Oil" stocked procurement with [unit:L] in notes
    const OIL_KEYWORDS = { groundnut: ['groundnut oil','groundnut'], sesame: ['sesame oil','sesame'], coconut: ['coconut oil','coconut'] };
    for (const proc of (procurements || [])) {
      if (proc.status !== 'stocked') continue;
      const qty = parseFloat(proc.cleaned_qty || proc.received_qty || proc.ordered_qty) || 0;
      if (qty <= 0) continue;
      const name = (proc.commodity_name || '').toLowerCase();
      const notes = (proc.notes || '').toLowerCase();
      // Detect unit from notes [unit:L] or [unit:l]
      const unitMatch = (proc.notes || '').match(/\[unit:([^\]]+)\]/i);
      const unit = unitMatch ? unitMatch[1].toLowerCase() : 'kg';
      for (const [oilKey, keywords] of Object.entries(OIL_KEYWORDS)) {
        if (keywords.some(kw => name.includes(kw))) {
          // Convert to liters
          let liters = qty;
          if (unit === 'kg') liters = qty / (OIL_DENSITY[oilKey] || 0.915);
          else if (unit === 'ml') liters = qty / 1000;
          // Only count if it looks like bulk oil (has "oil" in name)
          if (name.includes('oil')) {
            bulkOilL[oilKey] = (bulkOilL[oilKey] || 0) + liters;
          }
          break;
        }
      }
    }

    // Step 3: liters already packed per oil type (production channel entries in ledger)
    const packedL = {};
    for (const row of (ledger || [])) {
      if (row.channel !== 'production' || row.type !== 'in' || !row.product_id) continue;
      const prod = (products || []).find(p => p.id === row.product_id);
      if (!prod?.oil_type_key) continue;
      const key = prod.oil_type_key.toLowerCase();
      const packUnit = (prod.pack_unit || 'ML').toUpperCase();
      const packL = (parseFloat(prod.pack_size) || 0) / (packUnit === 'L' ? 1 : 1000);
      packedL[key] = (packedL[key] || 0) + packL * (+row.qty || 0);
    }

    // Step 4: available bulk liters per oil type
    const availBulkL = {};
    for (const key of Object.keys(bulkOilL)) {
      availBulkL[key] = Math.max(0, bulkOilL[key] - (packedL[key] || 0));
    }

    // Step 5: for oil products with no packed stock recorded, estimate from bulk
    for (const prod of (products || [])) {
      if (!prod.oil_type_key) continue;
      const key = prod.oil_type_key.toLowerCase();
      const available = availBulkL[key] || 0;
      if (available > 0 && !(stock[prod.id] > 0)) {
        const packUnit = (prod.pack_unit || 'ML').toUpperCase();
        const packL = (parseFloat(prod.pack_size) || 0) / (packUnit === 'L' ? 1 : 1000);
        stock[prod.id] = packL > 0 ? Math.floor(available / packL) : (available > 0 ? 999 : 0);
      }
    }

    // Clamp negatives to 0
    for (const id of Object.keys(stock)) {
      if (stock[id] < 0) stock[id] = 0;
    }

    setCached('stock', { stock });
    res.json({ stock });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/public/orders — no auth required; places a webstore order + creates a factory sale
router.post('/orders', async (req, res) => {
  try {
    const o = req.body;
    if (!o.id || !o.orderNo || !o.total) return res.status(400).json({ error: 'Missing required fields' });

    // Insert webstore order
    const { error: wsErr } = await supabase.from('webstore_orders').insert({
      id:       o.id,
      order_no: o.orderNo,
      date:     o.date || new Date().toISOString().slice(0, 10),
      customer: o.customer || {},
      items:    o.items || [],
      subtotal: parseFloat(o.subtotal) || 0,
      gst:      parseFloat(o.gst) || 0,
      shipping: parseFloat(o.shipping) || 0,
      total:    parseFloat(o.total) || 0,
      status:   'confirmed',
      channel:  'website',
    });
    if (wsErr) return res.status(400).json({ error: wsErr.message });

    // Also create a factory sale record
    const customer = o.customer || {};
    const { data: sale, error: saleErr } = await supabase.from('sales').insert({
      order_no:       o.orderNo,
      date:           o.date || new Date().toISOString().slice(0, 10),
      channel:        'website',
      status:         'pending',
      customer_name:  customer.name || '',
      customer_phone: customer.phone || '',
      total_amount:   parseFloat(o.subtotal) || 0,
      discount:       0,
      final_amount:   parseFloat(o.total) || 0,
      amount_paid:    customer.payment === 'cod' ? 0 : parseFloat(o.total),
      payment_method: customer.payment || 'cod',
      notes:          `${customer.address || ''}, ${customer.city || ''}, ${customer.state || ''} - ${customer.pincode || ''}`,
    }).select().single();

    if (!saleErr && sale && Array.isArray(o.items) && o.items.length > 0) {
      await supabase.from('sale_items').insert(o.items.map(i => ({
        sale_id:      sale.id,
        product_id:   i.id || null,
        product_name: i.name || '',
        qty:          i.qty || 1,
        rate:         i.price || 0,
        total:        (i.qty || 1) * (i.price || 0),
        unit:         'pcs',
      })));
    }

    res.status(201).json({ success: true, orderId: o.id });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/public/product-stats — sold counts (last 10 days) + approved ratings per product
router.get('/product-stats', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const since = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [{ data: orders }, { data: reviews }] = await Promise.all([
      supabase.from('webstore_orders').select('items,status,created_at').gte('created_at', since).in('status', ['confirmed','paid','dispatched','delivered']),
      supabase.from('product_reviews').select('product_id,rating').eq('status', 'approved'),
    ]);
    const soldCounts = {};
    for (const order of (orders || [])) {
      for (const item of (order.items || [])) {
        const pid = item.id || item.productId;
        if (!pid) continue;
        soldCounts[pid] = (soldCounts[pid] || 0) + (Number(item.qty) || 1);
      }
    }
    const ratingsAcc = {};
    for (const r of (reviews || [])) {
      if (!r.product_id || !r.rating) continue;
      if (!ratingsAcc[r.product_id]) ratingsAcc[r.product_id] = { sum: 0, count: 0 };
      ratingsAcc[r.product_id].sum += r.rating;
      ratingsAcc[r.product_id].count += 1;
    }
    const ratings = {};
    for (const [pid, { sum, count }] of Object.entries(ratingsAcc)) {
      ratings[pid] = { avg: Math.round((sum / count) * 10) / 10, count };
    }
    res.json({ soldCounts, ratings });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// GET /api/public/content — website CMS content (hero, about, announcement, banners)
router.get('/content', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'website_content').single();
    const defaults = {
      heroTitle: "Nature's Finest, Pure & Simple",
      heroSubtitle: "Cold-pressed oils, organic millets, traditional dals & spices — delivered from our farm to your family.",
      heroStats: ["100+ Products", "0 Chemicals", "100% Natural"],
      benefits: ["🌿 100% Natural","🫙 Cold Pressed","🚫 No Chemicals","🌾 Farm Direct","📦 Safe Packaging"],
      aboutTitle: "Our Story",
      aboutText: "Sathvam was born from a simple belief — that what you eat should be as pure as nature intended. We work directly with farmers across Tamil Nadu to bring you cold-pressed oils, organic millets, and traditional foods free from chemicals and preservatives.",
      announcementBar: "",
      bannerUrl: "",
    };
    res.json({ content: { ...defaults, ...(data?.value || {}) } });
  } catch {
    res.json({ content: {} });
  }
});

// ── Store feature flags (public — used by customer store to show/hide sections) ──
router.get('/store-features', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const defaults = {
    giftHampers: true, recipeSection: true, transformationStories: true,
    healthQuiz: true, subscribeAndSave: true, labReportLink: true, loyaltyTiers: true,
    batchFreshness: true, farmTimeline: true, nutritionTable: true, whyColdPressed: true,
    spinWheel: true, oilCalculator: true, cookingChallenge: true, communityRecipes: true,
    festivalGuide: true, seasonalRec: true, oilPulling: true, backInStock: true,
    corpGifting: true, bundleBuilder: true, reorderReminder: true, reviewFeed: true,
    familiesCounter: true, expertQuotes: true,
    custIdleMin: 60, // customer idle session timeout in minutes
  };
  try {
    const [featRes, idleRes] = await Promise.all([
      supabase.from('settings').select('value').eq('key', 'store_features').single(),
      supabase.from('settings').select('value').eq('key', 'cust_idle_timeout_min').single(),
    ]);
    const features = { ...defaults, ...(featRes.data?.value || {}) };
    if (idleRes.data?.value != null) features.custIdleMin = idleRes.data.value;
    res.json(features);
  } catch {
    res.json(defaults);
  }
});

// ── Analytics tracking helpers ─────────────────────────────────────────────

async function getAKey(key, def = {}) {
  const { data } = await supabase.from('store_analytics').select('data').eq('key', key).single();
  return data?.data ?? def;
}
async function setAKey(key, data) {
  await supabase.from('store_analytics').upsert({ key, data, updated_at: new Date().toISOString() }, { onConflict: 'key' });
}
const TODAY = () => new Date().toISOString().slice(0, 10);

// POST /api/public/track/visit
router.post('/track/visit', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const today = TODAY();
    const visits = await getAKey('visits', {});
    visits[today] = (visits[today] || 0) + 1;
    await setAKey('visits', visits);
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// POST /api/public/track/pageview  { path, title? }
router.post('/track/pageview', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const { path, title = '' } = req.body || {};
    if (!path) return res.status(400).json({ error: 'path required' });
    const pages = await getAKey('page_views', {});
    if (!pages[path]) pages[path] = { title, count: 0 };
    pages[path].count += 1;
    if (title) pages[path].title = title;
    await setAKey('page_views', pages);
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// POST /api/public/track/product-view  { productId, productName? }
router.post('/track/product-view', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const { productId, productName = '' } = req.body || {};
    if (!productId) return res.status(400).json({ error: 'productId required' });
    const views = await getAKey('product_views', {});
    if (!views[productId]) views[productId] = { name: productName, count: 0 };
    views[productId].count += 1;
    if (productName) views[productId].name = productName;
    await setAKey('product_views', views);
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// POST /api/public/cart  { sessionId, items: [{id,name,price,qty}] }
router.post('/cart', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const { sessionId, items } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    if (!items || items.length === 0) {
      await supabase.from('abandoned_carts').delete().eq('session_id', sessionId);
      return res.json({ ok: true });
    }
    await supabase.from('abandoned_carts').upsert({
      session_id: sessionId, items, updated_at: new Date().toISOString(),
    }, { onConflict: 'session_id' });
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// DELETE /api/public/cart/:sessionId — mark cart as recovered when order is placed
router.delete('/cart/:sessionId', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    await supabase.from('abandoned_carts')
      .update({ recovered: true, recovered_at: new Date().toISOString() })
      .eq('session_id', req.params.sessionId);
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// Blocked domains for image search (low quality / not product images)
const IMG_BLOCK = ['wikipedia.org','wikimedia.org','wikidata.org','wiki','upload.wikimedia'];

// GET /api/public/image-search?q=... — search product images via DuckDuckGo
router.get('/image-search', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ images: [] });
  try {
    // Append "product buy" to bias toward e-commerce / product photos
    const query = `${q} product buy`;

    // Step 1: get vqd token from DuckDuckGo
    const initRes = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
    });
    const initHtml = await initRes.text();
    const vqdMatch = initHtml.match(/vqd=['"]([^'"]+)['"]/);
    if (!vqdMatch) return res.json({ images: [] });
    const vqd = vqdMatch[1];

    // Step 2: fetch image results (request more so we have enough after filtering)
    const imgRes = await fetch(
      `https://duckduckgo.com/i.js?q=${encodeURIComponent(query)}&vqd=${encodeURIComponent(vqd)}&o=json&p=1&f=,,,,,&l=us-en`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36', 'Referer': 'https://duckduckgo.com/' } }
    );
    const imgData = await imgRes.json();

    const images = (imgData.results || [])
      .filter(r => {
        const url = (r.image || '').toLowerCase();
        if (!url) return false;
        if (url.endsWith('.svg') || url.endsWith('.gif')) return false;
        if (IMG_BLOCK.some(b => url.includes(b))) return false;
        return true;
      })
      // Sort largest first for HD quality
      .sort((a, b) => (b.width * b.height) - (a.width * a.height))
      // Only keep images with reasonable size (at least 300px wide)
      .filter(r => !r.width || r.width >= 300)
      .map(r => r.image)
      .slice(0, 9);

    res.json({ images });
  } catch (e) {
    res.status(500).json({ error: e.message, images: [] });
  }
});

// GET /api/public/blog — list published posts
router.get('/blog', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const { data, error } = await supabase
      .from('blog_posts')
      .select('id,title,slug,excerpt,category,author,published_at,read_time,cover_image,keywords')
      .eq('published', true)
      .order('published_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json({ posts: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message, posts: [] });
  }
});

// GET /api/public/blog/:slug — single post
router.get('/blog/:slug', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const { data, error } = await supabase
      .from('blog_posts')
      .select('*')
      .eq('slug', req.params.slug)
      .eq('published', true)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Post not found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/public/recent-activity — anonymized recent orders for social proof
router.get('/recent-activity', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const since = new Date(); since.setDate(since.getDate() - 7);
    const { data } = await supabase
      .from('webstore_orders')
      .select('customer,items,created_at')
      .in('status', ['confirmed','shipped','delivered','paid'])
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: false })
      .limit(30);

    // Validate name looks like a real person (letters/spaces only, has a vowel, 2–20 chars)
    const isRealName = (n) => n && /^[A-Za-z\s.'-]{2,20}$/.test(n) && /[aeiouAEIOU]/.test(n);
    const activities = (data || []).flatMap(o => {
      const rawName = (o.customer?.name || '').split(' ')[0] || '';
      if (!isRealName(rawName)) return [];
      const city = o.customer?.city || 'India';
      return (o.items || []).slice(0, 2).map(item => ({
        name: rawName,
        city,
        product: item.name || item.productName || 'a product',
        time: o.created_at,
      }));
    }).slice(0, 20);

    res.json({ activities });
  } catch (e) {
    res.json({ activities: [] });
  }
});

// POST /api/public/coupons/validate — check coupon code at checkout
router.post('/coupons/validate', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const { code, cart_total } = req.body;
  if (!code) return res.status(400).json({ error: 'No code provided' });
  try {
    const { data, error } = await supabase
      .from('coupons')
      .select('code,type,value,min_order,max_uses,used_count,expires_at,description')
      .ilike('code', code.trim())
      .eq('active', true)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Invalid coupon code' });
    if (data.expires_at && new Date(data.expires_at) < new Date())
      return res.status(400).json({ error: 'This coupon has expired' });
    if (data.max_uses && data.used_count >= data.max_uses)
      return res.status(400).json({ error: 'This coupon has reached its usage limit' });
    if (data.min_order && cart_total < data.min_order)
      return res.status(400).json({ error: `Minimum order ₹${data.min_order} required for this coupon` });

    const discount = data.type === 'percent'
      ? Math.round((cart_total * data.value) / 100)
      : Math.min(data.value, cart_total);

    res.json({ valid: true, code: data.code, type: data.type, value: data.value, discount, description: data.description });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/public/reviews — submit customer review from website
router.post('/reviews', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const { name, city, rating, text, prod } = req.body;
  if (!name || !text || !prod) return res.status(400).json({ error: 'Missing required fields' });
  try {
    const { error } = await supabase.from('product_reviews').insert({
      product_name: prod,
      reviewer_name: name + (city ? ` (${city})` : ''),
      rating: Math.min(5, Math.max(1, parseInt(rating) || 5)),
      body: text,
      title: '',
      status: 'pending',
      source: 'website',
    });
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/public/notify-me — save out-of-stock notification request
router.post('/notify-me', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const { product_id, product_name, email, phone } = req.body;
  if (!product_id || (!email && !phone)) return res.status(400).json({ error: 'product_id and email or phone required' });
  try {
    const key = `notify_me_${product_id}`;
    const { data } = await supabase.from('store_analytics').select('data').eq('key', key).maybeSingle();
    const existing = data?.data || [];
    const entry = { email: email || null, phone: phone || null, product_name, created_at: new Date().toISOString() };
    const updated = [...existing, entry];
    await supabase.from('store_analytics').upsert({ key, data: updated, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/public/reviews?product_id=... — get approved reviews for a product
router.get('/reviews', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const { product_id, product_name } = req.query;
  try {
    let query = supabase.from('product_reviews')
      .select('id,reviewer_name,rating,body,title,created_at,product_name')
      .eq('status', 'approved')
      .order('created_at', { ascending: false })
      .limit(20);
    if (product_id) query = query.eq('product_id', product_id);
    else if (product_name) query = query.ilike('product_name', `%${product_name}%`);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ reviews: data || [] });
  } catch (e) { res.status(500).json({ error: e.message, reviews: [] }); }
});

// GET /api/public/live-viewers — count active sessions per product in last 3 minutes
router.get('/live-viewers', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const { data } = await supabase.from('store_analytics').select('key,data,updated_at')
      .like('key', '_cs_%')
      .gte('updated_at', new Date(Date.now() - 3 * 60 * 1000).toISOString());
    // Also get product view sessions from analytics tracking
    const { data: pvData } = await supabase.from('store_analytics').select('data').eq('key', 'live_product_views').maybeSingle();
    const liveViews = pvData?.data || {};
    const now = Date.now();
    // Clean old entries (> 3 min)
    const cleaned = {};
    for (const [prodId, sessions] of Object.entries(liveViews)) {
      const active = (sessions || []).filter(s => now - new Date(s.ts).getTime() < 3 * 60 * 1000);
      if (active.length > 0) cleaned[prodId] = active;
    }
    const counts = {};
    for (const [prodId, sessions] of Object.entries(cleaned)) {
      counts[prodId] = sessions.length;
    }
    res.json({ counts });
  } catch { res.json({ counts: {} }); }
});

// POST /api/public/live-viewers — record that a session is viewing a product
router.post('/live-viewers', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const { product_id, session_id } = req.body;
  if (!product_id || !session_id) return res.json({ ok: false });
  try {
    const { data } = await supabase.from('store_analytics').select('data').eq('key', 'live_product_views').maybeSingle();
    const liveViews = data?.data || {};
    const now = new Date().toISOString();
    const nowMs = Date.now();
    // Keep only sessions from last 3 min
    const existing = (liveViews[product_id] || []).filter(s => nowMs - new Date(s.ts).getTime() < 3 * 60 * 1000);
    // Upsert current session
    const updated = [...existing.filter(s => s.sid !== session_id), { sid: session_id, ts: now }];
    liveViews[product_id] = updated;
    // Limit total keys to avoid bloat
    const keys = Object.keys(liveViews);
    if (keys.length > 100) {
      const toDelete = keys.slice(0, keys.length - 100);
      for (const k of toDelete) delete liveViews[k];
    }
    await supabase.from('store_analytics').upsert({ key: 'live_product_views', data: liveViews, updated_at: now }, { onConflict: 'key' });
    const count = updated.length;
    res.json({ ok: true, count });
  } catch { res.json({ ok: false, count: 1 }); }
});

// POST /api/public/heartbeat — store frontend pings every 30s to signal active session
router.post('/heartbeat', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const { session_id, page, referrer, utm_source, cart_value, is_new } = req.body;
  if (!session_id) return res.json({ ok: false });
  try {
    const now = new Date().toISOString();
    const { data } = await supabase.from('store_analytics').select('data').eq('key', 'live_sessions').maybeSingle();
    const sessions = data?.data || {};
    // Prune sessions older than 2 minutes
    const nowMs = Date.now();
    for (const [sid, s] of Object.entries(sessions)) {
      if (nowMs - new Date(s.ts).getTime() > 2 * 60 * 1000) delete sessions[sid];
    }
    const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const existing = sessions[session_id] || {};
    const needsGeo = !existing.city || !existing.ip || (ip && existing.ip !== ip);
    // Detect device from User-Agent
    const ua = req.headers['user-agent'] || '';
    const device = /iPad|Android(?!.*Mobile)/i.test(ua) ? 'tablet'
      : /Mobile|Android|iPhone|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua) ? 'mobile' : 'desktop';
    sessions[session_id] = {
      ts: now, page: page || '/', ip, device,
      referrer:   referrer   || existing.referrer   || null,
      utm_source: utm_source || existing.utm_source || null,
      cart_value: cart_value != null ? cart_value : (existing.cart_value || null),
      is_new:     is_new     != null ? is_new     : (existing.is_new != null ? existing.is_new : true),
      city:        needsGeo ? null : existing.city,
      country:     needsGeo ? null : existing.country,
      countryCode: needsGeo ? null : existing.countryCode,
      first_seen:  existing.first_seen || now,
    };
    await supabase.from('store_analytics').upsert({ key: 'live_sessions', data: sessions, updated_at: now }, { onConflict: 'key' });
    res.json({ ok: true, count: Object.keys(sessions).length });

    // Geo lookup — fire after response
    if (needsGeo) {
      geoIP(ip).then(async geo => {
        if (!geo) return;
        const { data: fresh } = await supabase.from('store_analytics').select('data').eq('key', 'live_sessions').maybeSingle();
        const s2 = fresh?.data || {};
        if (s2[session_id]) {
          s2[session_id].city        = geo.city;
          s2[session_id].country     = geo.country;
          s2[session_id].countryCode = geo.countryCode;
          await supabase.from('store_analytics').upsert({ key: 'live_sessions', data: s2, updated_at: new Date().toISOString() }, { onConflict: 'key' });
        }
      }).catch(() => {});
    }
  } catch { res.json({ ok: false }); }
});

// GET /api/public/live-count — current active visitor count (last 2 min)
router.get('/live-count', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const { data } = await supabase.from('store_analytics').select('data').eq('key', 'live_sessions').maybeSingle();
    if (!data?.data) return res.json({ count: 0, pages: {}, locations: [], sessions: [] });
    const nowMs = Date.now();
    const active = Object.entries(data.data).filter(([, s]) => nowMs - new Date(s.ts).getTime() < 2 * 60 * 1000);
    const pages = {};
    active.forEach(([, s]) => { const p = s.page || '/'; pages[p] = (pages[p] || 0) + 1; });
    // Grouped locations
    const locMap = {};
    active.forEach(([, s]) => {
      if (!s.country) return;
      const key = `${s.city || ''}|${s.country}`;
      if (!locMap[key]) locMap[key] = { city: s.city || null, country: s.country, countryCode: s.countryCode || '', count: 0 };
      locMap[key].count++;
    });
    const locations = Object.values(locMap).sort((a, b) => b.count - a.count);
    // Individual sessions (enriched, no PII — just behaviour)
    const sessions = active
      .map(([, s]) => ({
        page:        s.page || '/',
        device:      s.device || 'desktop',
        city:        s.city || null,
        country:     s.country || null,
        countryCode: s.countryCode || null,
        referrer:    s.referrer || null,
        utm_source:  s.utm_source || null,
        cart_value:  s.cart_value || null,
        is_new:      s.is_new != null ? s.is_new : true,
        ts:          s.ts,
        first_seen:  s.first_seen || s.ts,
      }))
      .sort((a, b) => new Date(b.ts) - new Date(a.ts));
    res.json({ count: active.length, pages, locations, sessions });
  } catch { res.json({ count: 0, pages: {}, locations: [], sessions: [] }); }
});

// GET /api/public/sitemap.xml — dynamic sitemap with all products + blog posts
router.get('/sitemap.xml', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [{ data: products }, { data: posts }] = await Promise.all([
      supabase.from('products').select('id,name,active,cat').eq('active', true).neq('cat', 'raw'),
      supabase.from('blog_posts').select('slug,published_at').eq('published', true),
    ]);

    const staticUrls = [
      { loc: 'https://www.sathvam.in/', priority: '1.0', changefreq: 'weekly' },
      { loc: 'https://www.sathvam.in/shop', priority: '0.9', changefreq: 'daily' },
      { loc: 'https://www.sathvam.in/about', priority: '0.7', changefreq: 'monthly' },
      { loc: 'https://www.sathvam.in/contact', priority: '0.7', changefreq: 'monthly' },
      { loc: 'https://www.sathvam.in/blog', priority: '0.8', changefreq: 'daily' },
    ].map(u => `  <url><loc>${u.loc}</loc><lastmod>${today}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join('\n');

    const productUrls = (products || []).map(p =>
      `  <url><loc>https://www.sathvam.in/product/${toSlug(p.name)}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.85</priority></url>`
    ).join('\n');

    const blogUrls = (posts || []).map(p => {
      const lastmod = p.published_at ? p.published_at.slice(0, 10) : today;
      return `  <url><loc>https://www.sathvam.in/blog/${p.slug}</loc><lastmod>${lastmod}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>`;
    }).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticUrls}
${productUrls}
${blogUrls}
</urlset>`;
    res.send(xml);
  } catch (e) {
    res.status(500).send(`<?xml version="1.0"?><error>${e.message}</error>`);
  }
});

// GET /api/public/shopping-feed — Google Merchant Center product feed (RSS/XML)
router.get('/shopping-feed', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  try {
    const { data: products } = await supabase
      .from('products')
      .select('id,name,sku,cat,pack_size,pack_unit,gst,price,website_price,description,image_url,active')
      .eq('active', true)
      .neq('cat', 'raw');

    const items = (products || []).filter(p => (p.website_price || p.price) > 0).map(p => {
      const price = (p.website_price || p.price || 0);
      const gstAmt = price * ((p.gst || 0) / 100);
      const mrp = (price + gstAmt).toFixed(2);
      const name = p.name || '';
      const packInfo = p.pack_size ? ` ${p.pack_size}${p.pack_unit || ''}` : '';
      const desc = (p.description || `${name} — Pure natural product from Sathvam Natural Products, Karur, Tamil Nadu. No chemicals, no preservatives.`).slice(0, 5000);
      const imgUrl = p.image_url || 'https://www.sathvam.in/logo.jpg';
      const catMap = { oil: 'Food, Beverages &amp; Tobacco > Food Items > Cooking Oils', grain: 'Food, Beverages &amp; Tobacco > Food Items > Grains &amp; Rice', spice: 'Food, Beverages &amp; Tobacco > Food Items > Seasonings', sweetener: 'Food, Beverages &amp; Tobacco > Food Items > Sweeteners', other: 'Food, Beverages &amp; Tobacco > Food Items' };
      const gCategory = catMap[p.cat] || catMap.other;
      return `
    <item>
      <g:id>${p.id}</g:id>
      <g:title>${name}${packInfo}</g:title>
      <g:description>${desc.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</g:description>
      <g:link>https://www.sathvam.in/product/${toSlug(p.name)}</g:link>
      <g:image_link>${imgUrl}</g:image_link>
      <g:condition>new</g:condition>
      <g:availability>in stock</g:availability>
      <g:price>${mrp} INR</g:price>
      <g:brand>Sathvam Natural Products</g:brand>
      <g:mpn>${p.sku || p.id}</g:mpn>
      <g:google_product_category>${gCategory}</g:google_product_category>
      <g:product_type>Natural Products &gt; ${p.cat === 'oil' ? 'Cold Pressed Oils' : p.cat === 'grain' ? 'Millets &amp; Grains' : p.cat === 'spice' ? 'Spices' : 'Natural Foods'}</g:product_type>
      <g:custom_label_0>${p.cat}</g:custom_label_0>
      <g:shipping>
        <g:country>IN</g:country>
        <g:service>Standard</g:service>
        <g:price>80.00 INR</g:price>
      </g:shipping>
    </item>`;
    }).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Sathvam Natural Products</title>
    <link>https://www.sathvam.in</link>
    <description>Cold-pressed oils, organic millets, spices — factory direct from Karur, Tamil Nadu</description>
    ${items}
  </channel>
</rss>`;
    res.send(xml);
  } catch (e) {
    res.status(500).send(`<?xml version="1.0"?><error>${e.message}</error>`);
  }
});

// POST /api/public/contact — Save contact form submission
router.post('/contact', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const { name, phone, email, message } = req.body;
  if (!name || !message) return res.status(400).json({ error: 'name and message required' });
  try {
    const key = `contact_submissions`;
    const { data } = await supabase.from('store_analytics').select('data').eq('key', key).maybeSingle();
    const existing = data?.data || [];
    const entry = { name, phone: phone||null, email: email||null, message, created_at: new Date().toISOString() };
    await supabase.from('store_analytics').upsert({ key, data: [...existing, entry].slice(-500), updated_at: new Date().toISOString() }, { onConflict: 'key' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/public/newsletter — Save newsletter signup
router.post('/newsletter', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'valid email required' });
  try {
    const key = 'newsletter_subscribers';
    const { data } = await supabase.from('store_analytics').select('data').eq('key', key).maybeSingle();
    const existing = data?.data || [];
    if (!existing.find(e => e.email === email.toLowerCase())) {
      await supabase.from('store_analytics').upsert({ key, data: [...existing, { email: email.toLowerCase(), subscribed_at: new Date().toISOString() }], updated_at: new Date().toISOString() }, { onConflict: 'key' });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/public/whatsapp-optin — Save WhatsApp opt-in
router.post('/whatsapp-optin', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const { phone, name, order_no } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const key = 'whatsapp_optins';
    const { data } = await supabase.from('store_analytics').select('data').eq('key', key).maybeSingle();
    const existing = data?.data || [];
    await supabase.from('store_analytics').upsert({ key, data: [...existing, { phone, name: name||null, order_no: order_no||null, opted_at: new Date().toISOString() }].slice(-2000), updated_at: new Date().toISOString() }, { onConflict: 'key' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/public/b2b-inquiry — Save B2B wholesale inquiry
router.post('/b2b-inquiry', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const { businessName, contact, phone, email, requirement } = req.body;
  if (!businessName || !phone) return res.status(400).json({ error: 'businessName and phone required' });
  try {
    const key = 'b2b_inquiries';
    const { data } = await supabase.from('store_analytics').select('data').eq('key', key).maybeSingle();
    const existing = data?.data || [];
    const entry = { businessName, contact: contact||null, phone, email: email||null, requirement: requirement||null, created_at: new Date().toISOString() };
    await supabase.from('store_analytics').upsert({ key, data: [...existing, entry].slice(-500), updated_at: new Date().toISOString() }, { onConflict: 'key' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/public/bought-together?product_id=X — Products frequently bought together
router.get('/bought-together', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const { product_id } = req.query;
  if (!product_id) return res.status(400).json({ error: 'product_id required' });
  try {
    // Get recent orders containing this product
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data: orders } = await supabase.from('webstore_orders')
      .select('items').gte('created_at', since).in('status', ['confirmed','paid','dispatched','delivered']);

    // Count co-occurrences
    const coCount = {};
    for (const order of (orders || [])) {
      const items = order.items || [];
      const hasTarget = items.some(i => (i.id || i.productId) === product_id);
      if (!hasTarget) continue;
      for (const item of items) {
        const pid = item.id || item.productId;
        if (!pid || pid === product_id) continue;
        coCount[pid] = (coCount[pid] || 0) + 1;
      }
    }

    // Get top 3 co-purchased product IDs
    const topIds = Object.entries(coCount).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([id])=>id);
    if (!topIds.length) return res.json({ products: [] });

    const { data: products } = await supabase.from('products')
      .select('id,name,sku,cat,pack_size,pack_unit,price,website_price,image_url,active')
      .in('id', topIds).eq('active', true);

    res.json({ products: (products || []).map(p => ({ ...p, websitePrice: p.website_price, packSize: p.pack_size, packUnit: p.pack_unit })) });
  } catch (e) { res.status(500).json({ error: e.message, products: [] }); }
});

// POST /api/public/cart-reminder — guest cart abandonment email (no auth required)
router.post('/cart-reminder', async (req, res) => {
  res.json({ ok: true }); // always respond immediately
  try {
    const { email, name, items } = req.body;
    if (!email || !items?.length) return;
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;

    const firstName = (name || email.split('@')[0]) || 'there';
    const rows = items.map(i =>
      `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6">${i.name || 'Product'}</td>
        <td style="padding:8px 12px;text-align:center;border-bottom:1px solid #f3f4f6">${i.qty || 1}</td>
        <td style="padding:8px 12px;text-align:right;border-bottom:1px solid #f3f4f6;font-weight:700">₹${((i.qty||1)*(i.price||0)).toLocaleString('en-IN')}</td>
      </tr>`
    ).join('');
    const total = items.reduce((s, i) => s + (i.qty||1)*(i.price||0), 0);

    const html = `
<div style="font-family:sans-serif;max-width:540px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
  <div style="background:linear-gradient(135deg,#2d1a0e,#5c3317);color:#fff;padding:24px 28px">
    <div style="font-size:22px;font-weight:800;margin-bottom:4px">🛒 You left something behind!</div>
    <div style="font-size:14px;opacity:0.85">Hi ${firstName}, your cart is waiting at Sathvam Natural Products</div>
  </div>
  <div style="padding:24px 28px">
    <p style="color:#374151;font-size:15px;margin-top:0">Your fresh, cold-pressed goodness is just one click away! 🌿 We saved your cart so you can pick up right where you left off.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f9fafb;border-radius:8px;overflow:hidden">
      <thead>
        <tr style="background:#f3f4f6">
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280">ITEM</th>
          <th style="padding:8px 12px;text-align:center;font-size:12px;color:#6b7280">QTY</th>
          <th style="padding:8px 12px;text-align:right;font-size:12px;color:#6b7280">AMOUNT</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="text-align:right;font-size:16px;font-weight:800;color:#1f2937">Total: ₹${total.toLocaleString('en-IN')}</p>
    <div style="text-align:center;margin:24px 0">
      <a href="https://sathvam.in" style="background:linear-gradient(135deg,#2d1a0e,#5c3317);color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-size:16px;font-weight:700;display:inline-block">Complete My Order →</a>
    </div>
    <p style="color:#9ca3af;font-size:12px;text-align:center">Questions? Call us at +91 70921 77092.<br>Sathvam Natural Products — Pure. Natural. Cold-pressed.</p>
  </div>
</div>`;

    await mailer.sendMail({
      from: process.env.SMTP_FROM || 'Sathvam Natural Products <noreply@sathvam.in>',
      replyTo: process.env.SMTP_REPLY_TO || 'sales@sathvam.in',
      to: email,
      subject: `Your cart is waiting 🛒 — Sathvam Natural Products`,
      html,
    });
  } catch (e) { console.error('guest cart-reminder email:', e.message); }
});

// GET /api/public/batch-freshness — latest batch per oil type
router.get('/batch-freshness', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const { data } = await supabase.from('batches').select('id,date,oil_type').order('date', { ascending: false }).limit(40);
    const latest = {};
    for (const b of (data || [])) {
      if (!latest[b.oil_type]) latest[b.oil_type] = b;
    }
    res.json({ batches: latest });
  } catch { res.json({ batches: {} }); }
});

// GET /api/public/order-count — total paid orders (for families counter)
router.get('/order-count', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const { count } = await supabase.from('webstore_orders').select('id', { count: 'exact', head: true }).eq('payment_status', 'paid');
    res.json({ count: count || 0 });
  } catch { res.json({ count: 0 }); }
});

// GET /api/public/community-recipes — community submitted recipes
router.get('/community-recipes', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'community_recipes').maybeSingle();
    res.json({ recipes: data?.value || [] });
  } catch { res.json({ recipes: [] }); }
});

// POST /api/public/community-recipes — submit a recipe
router.post('/community-recipes', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const { name, dish, oil, steps } = req.body;
    if (!name || !dish || !steps) return res.status(400).json({ error: 'Missing fields' });
    const { data: existing } = await supabase.from('settings').select('value').eq('key', 'community_recipes').maybeSingle();
    const recipes = existing?.value || [];
    recipes.unshift({ id: Date.now(), name: String(name).slice(0,60), dish: String(dish).slice(0,80), oil: String(oil||'Sesame Oil').slice(0,40), steps: String(steps).slice(0,600), votes: 0, date: new Date().toISOString().slice(0,10) });
    await supabase.from('settings').upsert({ key: 'community_recipes', value: recipes.slice(0,50), updated_at: new Date().toISOString() }, { onConflict: 'key' });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Failed to save' }); }
});

// POST /api/public/community-recipes/vote
router.post('/community-recipes/vote', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const { id } = req.body;
    const { data: existing } = await supabase.from('settings').select('value').eq('key', 'community_recipes').maybeSingle();
    const recipes = (existing?.value || []).map(r => r.id === id ? { ...r, votes: (r.votes || 0) + 1 } : r);
    await supabase.from('settings').upsert({ key: 'community_recipes', value: recipes, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// POST /api/public/corporate-inquiry — corporate gifting inquiry
router.post('/corporate-inquiry', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const { company, contact, email, phone, qty, occasion, notes } = req.body;
    await mailer.sendMail({
      from: process.env.SMTP_FROM, to: process.env.SMTP_USER,
      subject: `🏢 Corporate Gifting Inquiry — ${company || 'Unknown'}`,
      html: `<h3>Corporate Gifting Inquiry</h3><table border="1" cellpadding="8"><tr><td>Company</td><td>${company}</td></tr><tr><td>Contact</td><td>${contact}</td></tr><tr><td>Email</td><td>${email}</td></tr><tr><td>Phone</td><td>${phone}</td></tr><tr><td>Quantity</td><td>${qty}</td></tr><tr><td>Occasion</td><td>${occasion}</td></tr><tr><td>Notes</td><td>${notes}</td></tr></table>`,
    });
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

// POST /api/public/notify-me — subscribe to back-in-stock email for a product
router.post('/notify-me', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const { email, name, product_id, productName } = req.body;
    if (!email || !product_id) return res.status(400).json({ error: 'Email and product_id required' });
    const normEmail = email.toLowerCase().trim();

    // Validate product exists
    const { data: product } = await supabase.from('products').select('id,name').eq('id', product_id).maybeSingle();
    if (!product) return res.status(404).json({ error: 'Product not found' });

    // Save to stock_notify table (upsert — silent if already subscribed)
    const { error: dbErr } = await supabase.from('stock_notify').upsert(
      { product_id, email: normEmail, name: name || null },
      { onConflict: 'product_id,email', ignoreDuplicates: true }
    );
    if (dbErr && !dbErr.message.includes('does not exist')) {
      console.error('stock_notify upsert error:', dbErr.message);
    }

    // Send confirmation email to subscriber
    setImmediate(async () => {
      try {
        await mailer.sendMail({
          from: process.env.SMTP_FROM || `Sathvam <${process.env.SMTP_USER}>`,
          to: normEmail,
          subject: `We'll notify you when ${product.name} is back in stock`,
          html: `
<div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
  <div style="background:linear-gradient(135deg,#14532d,#166534);padding:20px 24px;">
    <h2 style="color:#fff;margin:0;font-size:17px;">Sathvam Cold Pressed Oils</h2>
  </div>
  <div style="padding:24px;">
    <h3 style="margin:0 0 12px;color:#1f2937;">You're on the list! ✅</h3>
    <p style="margin:0 0 16px;color:#6b7280;font-size:14px;line-height:1.6;">
      Hi${name ? ' ' + name.split(' ')[0] : ''}! We've noted your interest in <strong style="color:#1f2937;">${product.name}</strong>.
      We'll send you an email the moment it's back in stock.
    </p>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px 18px;font-size:13px;color:#166534;">
      <strong>Product:</strong> ${product.name}<br>
      <strong>Your email:</strong> ${normEmail}
    </div>
    <p style="margin:16px 0 0;font-size:12px;color:#9ca3af;">
      In the meantime, explore our other products at <a href="https://sathvam.in" style="color:#16a34a;">sathvam.in</a>
    </p>
  </div>
</div>`,
        });
      } catch (e) { console.error('notify-me confirmation email failed:', e.message); }
    });

    res.json({ ok: true, message: `We'll email you at ${normEmail} when ${product.name} is back in stock.` });
  } catch (e) {
    console.error('notify-me error:', e.message);
    res.json({ ok: true }); // Always succeed silently to UX
  }
});

// Keep backward-compat alias
router.post('/back-in-stock', (req, res) => {
  req.url = '/notify-me';
  router.handle(req, res, () => {});
});

// GET /api/public/store-config — lightweight config for the webstore (no auth needed)
router.get('/store-config', async (req, res) => {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'web_settings').maybeSingle();
    const cfg = data?.value || {};
    res.json({
      couponsEnabled:    cfg.couponsEnabled    !== false,
      giftPackingEnabled: cfg.giftPackingEnabled !== false,
    });
  } catch (e) { res.json({ couponsEnabled: true, giftPackingEnabled: true }); }
});

const bustCache = () => { Object.keys(cache).forEach(k => delete cache[k]); };
module.exports = router;
module.exports.bustCache = bustCache;
