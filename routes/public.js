const express = require('express');
const supabase = require('../config/supabase');
const router = express.Router();

// GET /api/public/products — no auth, returns website-enabled products + tamil names
router.get('/products', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  try {
    const [{ data: products, error }, { data: settings }] = await Promise.all([
      supabase.from('products').select('id,name,sku,cat,unit,pack_size,pack_unit,gst,price,website_price,retail_price,featured,active,hsn_code,description,image_url').eq('active', true).order('name'),
      supabase.from('settings').select('value').eq('key', 'website_enabled_products').single(),
    ]);
    if (error) return res.status(500).json({ error: error.message });

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

    res.json({ products: websiteProducts, tamilNames });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/public/stock — no auth, returns aggregated stock per product_id
// Oil products: estimated from batch output (bulk L available → estimated bottles)
// Other products: stock_ledger in - out
router.get('/stock', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
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

    res.json({ stock });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
  } catch (err) { res.status(500).json({ error: err.message }); }
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

// GET /api/public/image-search?q=... — search product images via Wikipedia + Wikimedia Commons
router.get('/image-search', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ images: [] });
  try {
    const images = [];

    // Wikipedia page images
    const wpSearch = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q+' food')}&format=json&srlimit=5`);
    const wpData = await wpSearch.json();
    const titles = (wpData.query?.search || []).map(r => r.title).slice(0, 5);
    if (titles.length) {
      const wpImg = await fetch(`https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(titles.join('|'))}&prop=pageimages&format=json&pithumbsize=600`);
      const wpImgData = await wpImg.json();
      for (const page of Object.values(wpImgData.query?.pages || {})) {
        if (page.thumbnail?.source) images.push(page.thumbnail.source);
      }
    }

    // Wikimedia Commons images
    const cmSearch = await fetch(`https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srnamespace=6&format=json&srlimit=8`);
    const cmData = await cmSearch.json();
    const fileNames = (cmData.query?.search || []).map(r => r.title).slice(0, 6);
    if (fileNames.length) {
      const cmImg = await fetch(`https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(fileNames.join('|'))}&prop=imageinfo&iiprop=url&iiurlwidth=600&format=json`);
      const cmImgData = await cmImg.json();
      for (const page of Object.values(cmImgData.query?.pages || {})) {
        const url = page.imageinfo?.[0]?.thumburl;
        if (url) images.push(url);
      }
    }

    res.json({ images: [...new Set(images)].slice(0, 9) });
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

    const activities = (data || []).flatMap(o => {
      const name = (o.customer?.name || '').split(' ')[0] || 'Someone';
      const city = o.customer?.city || 'India';
      return (o.items || []).slice(0, 2).map(item => ({
        name,
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

module.exports = router;
