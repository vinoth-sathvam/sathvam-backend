/**
 * WhatsApp Business Catalog — Meta Commerce API
 *
 * Syncs Sathvam products to a Meta Commerce catalog connected to the
 * WhatsApp Business Account.  Messaging stays on Green API; only the
 * catalog is managed via Meta Graph API.
 *
 * Endpoints:
 *   GET    /api/wa-catalog/status              — Config + connection status
 *   POST   /api/wa-catalog/setup               — Create catalog & connect to WABA
 *   GET    /api/wa-catalog/products             — List products currently in Meta catalog
 *   POST   /api/wa-catalog/sync                — Full sync (all active products → Meta)
 *   POST   /api/wa-catalog/sync/:id            — Sync a single product by Supabase ID
 *   DELETE /api/wa-catalog/products/:retailerId — Remove one item from Meta catalog
 *
 * Env vars required:
 *   META_ACCESS_TOKEN   — Long-lived system-user token with catalog_management + whatsapp_business_management
 *   META_BUSINESS_ID    — Meta Business Manager ID
 *   META_CATALOG_ID     — (auto-created on first setup, or set manually)
 *   WA_WABA_ID          — WhatsApp Business Account ID (already exists)
 */

const express = require('express');
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');

const router = express.Router();

const META_API = 'https://graph.facebook.com/v19.0';

// ── Helper: Meta Graph API request ──────────────────────────────────────────
async function metaRequest(path, method = 'GET', body = null) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('META_ACCESS_TOKEN not configured');

  const url = path.startsWith('http') ? path : `${META_API}/${path}`;
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || JSON.stringify(data);
    throw new Error(`Meta API error (${res.status}): ${msg}`);
  }
  return data;
}

// ── Helper: build Meta product payload from Supabase product row ────────────
function buildMetaProduct(prod, stock = 0) {
  const price = prod.website_price || prod.price || 0;
  const packLabel = prod.pack_size
    ? `${prod.pack_size}${prod.pack_unit || prod.unit || ''}`
    : '';
  const title = packLabel ? `${prod.name} ${packLabel}` : prod.name;

  // Meta Commerce API expects price in smallest currency unit (paise for INR)
  // formatted as string with currency, e.g. "29900 INR" or just integer cents
  const priceCents = Math.round(price * 100);

  const description = prod.description
    || (prod.health_benefits?.length
      ? `${prod.name} — ${prod.health_benefits.slice(0, 3).join(', ')}`
      : `${prod.name} — Pure, natural product from Sathvam`);

  return {
    retailer_id:  prod.sku || prod.id,
    name:         title.slice(0, 150),            // Meta max 150 chars
    description:  description.slice(0, 9999),     // Meta max 9999 chars
    url:          `https://www.sathvam.in/product/${prod.id}`,
    image_url:    prod.image_url || 'https://www.sathvam.in/logo.jpg',
    price:        priceCents,
    currency:     'INR',
    availability: stock > 0 ? 'in stock' : 'out of stock',
  };
}

// ── Helper: get stock map ───────────────────────────────────────────────────
async function getStockMap() {
  const { data: ledger } = await supabase
    .from('stock_ledger')
    .select('product_id,type,qty');
  const stock = {};
  for (const row of (ledger || [])) {
    stock[row.product_id] = (stock[row.product_id] || 0)
      + (row.type === 'in' ? +row.qty : -+row.qty);
  }
  for (const id of Object.keys(stock)) {
    if (stock[id] < 0) stock[id] = 0;
  }
  return stock;
}

// ── Helper: get website-enabled product IDs ─────────────────────────────────
async function getEnabledProductIds() {
  const { data } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'website_enabled_products')
    .single();
  const arr = Array.isArray(data?.value) ? data.value
    : Array.isArray(data?.value?.value) ? data.value.value : [];
  return new Set(arr);
}

// ── Helper: save / read catalog ID from settings ────────────────────────────
async function saveCatalogId(catalogId) {
  await supabase.from('settings').upsert({
    key: 'meta_catalog_id',
    value: { id: catalogId, updated_at: new Date().toISOString() },
  });
  process.env.META_CATALOG_ID = catalogId;
}

async function getCatalogId() {
  if (process.env.META_CATALOG_ID) return process.env.META_CATALOG_ID;
  const { data } = await supabase
    .from('settings')
    .select('value')
    .eq('key', 'meta_catalog_id')
    .single();
  if (data?.value?.id) {
    process.env.META_CATALOG_ID = data.value.id;
    return data.value.id;
  }
  return null;
}

// ── Helper: save sync log per product ───────────────────────────────────────
async function saveSyncLog(productId, status, metaProductId = null, error = null) {
  await supabase.from('settings').upsert({
    key: `wa_catalog_sync_${productId}`,
    value: {
      status,            // 'synced' | 'error' | 'deleted'
      meta_product_id: metaProductId,
      error,
      synced_at: new Date().toISOString(),
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /status — Check configuration
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status', auth, async (req, res) => {
  try {
    const catalogId = await getCatalogId();
    const configured = !!(process.env.META_ACCESS_TOKEN && process.env.META_BUSINESS_ID);

    let catalogConnected = false;
    let productCount = 0;

    if (configured && catalogId) {
      try {
        const info = await metaRequest(`${catalogId}?fields=name,product_count`);
        productCount = info.product_count || 0;
        catalogConnected = true;
      } catch (e) {
        // catalog may have been deleted
      }
    }

    res.json({
      configured,
      meta_access_token: process.env.META_ACCESS_TOKEN ? 'Set' : 'Missing',
      meta_business_id:  process.env.META_BUSINESS_ID  ? 'Set' : 'Missing',
      waba_id:           process.env.WA_WABA_ID        ? 'Set' : 'Missing',
      catalog_id:        catalogId || null,
      catalog_connected: catalogConnected,
      product_count:     productCount,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /setup — Create a catalog and connect it to WABA
// ─────────────────────────────────────────────────────────────────────────────
router.post('/setup', auth, async (req, res) => {
  try {
    const businessId = process.env.META_BUSINESS_ID;
    const wabaId     = process.env.WA_WABA_ID;
    if (!businessId) return res.status(400).json({ error: 'META_BUSINESS_ID not set' });
    if (!wabaId)     return res.status(400).json({ error: 'WA_WABA_ID not set' });

    let catalogId = await getCatalogId();

    // Step 1: Create catalog if none exists
    if (!catalogId) {
      const catalog = await metaRequest(`${businessId}/owned_product_catalogs`, 'POST', {
        name: 'Sathvam WhatsApp Catalog',
        vertical: 'commerce',
      });
      catalogId = catalog.id;
      await saveCatalogId(catalogId);
      console.log(`[WA-Catalog] Created catalog ${catalogId}`);
    }

    // Step 2: Connect catalog to WhatsApp Business Account
    try {
      await metaRequest(`${wabaId}/product_catalogs`, 'POST', {
        catalog_id: catalogId,
      });
      console.log(`[WA-Catalog] Connected catalog ${catalogId} to WABA ${wabaId}`);
    } catch (e) {
      // If already connected, Meta returns an error — that's fine
      if (!e.message.includes('already')) {
        throw e;
      }
      console.log(`[WA-Catalog] Catalog already connected to WABA`);
    }

    res.json({
      ok: true,
      catalog_id: catalogId,
      message: 'Catalog created and connected to WhatsApp Business Account',
    });
  } catch (e) {
    console.error('[WA-Catalog] Setup error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /products — List products in Meta catalog
// ─────────────────────────────────────────────────────────────────────────────
router.get('/products', auth, async (req, res) => {
  try {
    const catalogId = await getCatalogId();
    if (!catalogId) return res.json({ products: [], message: 'No catalog configured. Run setup first.' });

    const products = [];
    let url = `${catalogId}/products?fields=retailer_id,name,price,currency,availability,image_url,url&limit=250`;

    // Paginate through all products
    while (url) {
      const data = await metaRequest(url);
      products.push(...(data.data || []));
      url = data.paging?.next || null;
      // safety: prevent infinite loop on more than 2000 products
      if (products.length > 2000) break;
    }

    res.json({ products, total: products.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /sync — Full sync: push all active products to Meta catalog
// ─────────────────────────────────────────────────────────────────────────────
router.post('/sync', auth, async (req, res) => {
  try {
    const catalogId = await getCatalogId();
    if (!catalogId) return res.status(400).json({ error: 'No catalog configured. Run POST /setup first.' });

    // Get active products
    const { data: products, error: prodErr } = await supabase
      .from('products')
      .select('id,name,sku,cat,unit,pack_size,pack_unit,price,website_price,image_url,description,health_benefits,active')
      .eq('active', true)
      .order('name');
    if (prodErr) throw prodErr;

    // Filter: only website-sellable products (has price, not raw material)
    const enabledSet = await getEnabledProductIds();
    const sellable = (products || []).filter(p =>
      p.cat !== 'raw' && p.cat !== 'packing'
      && (p.website_price || p.price) > 0
      && (enabledSet.size === 0 || enabledSet.has(p.id))
    );

    const stock = await getStockMap();

    // Meta Commerce API supports batch operations via items_batch
    // Send in batches of 20
    const BATCH_SIZE = 20;
    let synced = 0;
    let errors = 0;
    const errorDetails = [];

    for (let i = 0; i < sellable.length; i += BATCH_SIZE) {
      const batch = sellable.slice(i, i + BATCH_SIZE);
      const requests = batch.map(prod => ({
        method: 'CREATE',
        retailer_id: prod.sku || prod.id,
        data: buildMetaProduct(prod, stock[prod.id] || 0),
      }));

      try {
        const result = await metaRequest(`${catalogId}/items_batch`, 'POST', {
          allow_upsert: true,
          item_type: 'PRODUCT_ITEM',
          requests,
        });

        // Process results
        const handles = result.handles || [];
        for (let j = 0; j < batch.length; j++) {
          const prod = batch[j];
          const handle = handles[j];
          if (handle?.status === 'error') {
            errors++;
            const errMsg = handle.errors?.[0]?.message || 'Unknown error';
            errorDetails.push({ product: prod.name, sku: prod.sku, error: errMsg });
            await saveSyncLog(prod.id, 'error', null, errMsg);
          } else {
            synced++;
            await saveSyncLog(prod.id, 'synced', handle?.id || null);
          }
        }
      } catch (batchErr) {
        // Fallback: try individual product creation
        for (const prod of batch) {
          try {
            const metaProd = buildMetaProduct(prod, stock[prod.id] || 0);
            const result = await metaRequest(`${catalogId}/products`, 'POST', metaProd);
            synced++;
            await saveSyncLog(prod.id, 'synced', result.id);
          } catch (singleErr) {
            errors++;
            errorDetails.push({ product: prod.name, sku: prod.sku, error: singleErr.message });
            await saveSyncLog(prod.id, 'error', null, singleErr.message);
          }
        }
      }
    }

    // Save last full sync timestamp
    await supabase.from('settings').upsert({
      key: 'wa_catalog_last_sync',
      value: {
        synced_at: new Date().toISOString(),
        total: sellable.length,
        synced,
        errors,
      },
    });

    console.log(`[WA-Catalog] Full sync done: ${synced} synced, ${errors} errors out of ${sellable.length} products`);

    res.json({
      ok: true,
      total: sellable.length,
      synced,
      errors,
      error_details: errorDetails.slice(0, 20), // limit response size
    });
  } catch (e) {
    console.error('[WA-Catalog] Sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /sync/:id — Sync a single product
// ─────────────────────────────────────────────────────────────────────────────
router.post('/sync/:id', auth, async (req, res) => {
  try {
    const catalogId = await getCatalogId();
    if (!catalogId) return res.status(400).json({ error: 'No catalog configured' });

    const { data: prod, error: prodErr } = await supabase
      .from('products')
      .select('id,name,sku,cat,unit,pack_size,pack_unit,price,website_price,image_url,description,health_benefits,active')
      .eq('id', req.params.id)
      .single();
    if (prodErr || !prod) return res.status(404).json({ error: 'Product not found' });

    const stock = await getStockMap();
    const metaProd = buildMetaProduct(prod, stock[prod.id] || 0);

    // Use items_batch with allow_upsert for create-or-update
    const result = await metaRequest(`${catalogId}/items_batch`, 'POST', {
      allow_upsert: true,
      item_type: 'PRODUCT_ITEM',
      requests: [{ method: 'CREATE', retailer_id: metaProd.retailer_id, data: metaProd }],
    });

    const handle = result.handles?.[0];
    if (handle?.status === 'error') {
      const errMsg = handle.errors?.[0]?.message || 'Unknown error';
      await saveSyncLog(prod.id, 'error', null, errMsg);
      return res.status(400).json({ error: errMsg });
    }

    await saveSyncLog(prod.id, 'synced', handle?.id || null);
    res.json({ ok: true, product: prod.name, meta_id: handle?.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /products/:retailerId — Remove a product from Meta catalog
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/products/:retailerId', auth, async (req, res) => {
  try {
    const catalogId = await getCatalogId();
    if (!catalogId) return res.status(400).json({ error: 'No catalog configured' });

    const retailerId = req.params.retailerId;

    await metaRequest(`${catalogId}/items_batch`, 'POST', {
      item_type: 'PRODUCT_ITEM',
      requests: [{ method: 'DELETE', retailer_id: retailerId }],
    });

    // Find product by SKU or ID and update sync log
    const { data: prod } = await supabase
      .from('products')
      .select('id')
      .or(`sku.eq.${retailerId},id.eq.${retailerId}`)
      .maybeSingle();
    if (prod) await saveSyncLog(prod.id, 'deleted');

    res.json({ ok: true, removed: retailerId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /sync-status — Get sync status for all products
// ─────────────────────────────────────────────────────────────────────────────
router.get('/sync-status', auth, async (req, res) => {
  try {
    // Get last full sync info
    const { data: lastSync } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'wa_catalog_last_sync')
      .single();

    // Get per-product sync status
    const { data: syncLogs } = await supabase
      .from('settings')
      .select('key,value')
      .like('key', 'wa_catalog_sync_%');

    const productStatus = {};
    for (const log of (syncLogs || [])) {
      const productId = log.key.replace('wa_catalog_sync_', '');
      productStatus[productId] = log.value;
    }

    res.json({
      last_sync: lastSync?.value || null,
      products: productStatus,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
