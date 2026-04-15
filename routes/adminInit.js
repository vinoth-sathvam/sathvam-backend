/**
 * GET /api/admin/init
 * Single endpoint that returns all data needed for the admin panel initial load.
 * Replaces ~24 parallel API calls from the frontend with 1 round-trip.
 */
const express  = require('express');
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');
const { decryptCustomer } = require('../config/crypto');
const router   = express.Router();

router.get('/', auth, async (req, res) => {
  try {
    const SETTINGS_KEYS = [
      'op_costs','pkg_settings','intl_settings','web_settings',
      'retail_settings','prod_settings','prod_packed','price_history',
      'b2b_products','competitor_prices','competitors','user_custom_perms',
      'product_tamil_names','website_enabled_products','loyalty_data',
      'cake_sales','seed_wastage','oil_lots','flour_lots',
    ];

    // Fire all Supabase queries in parallel — all server-side, single round-trip for browser
    const [
      { data: products },
      { data: batches },
      { data: procurement },
      { data: sales },
      { data: vendors },
      { data: b2bCustomers },
      { data: b2bOrders },
      { data: projects },
      { data: projectMetas },
      { data: stockLedger },
      { data: purchases },
      { data: flourBatches },
      { data: wsOrders },
      { data: packingInv },
      { data: settingsRows },
      { data: users },
    ] = await Promise.all([
      supabase.from('products').select('*').eq('active', true).order('name'),
      supabase.from('batches').select('*').order('date', { ascending: false }),
      supabase.from('procurements').select('*').order('date', { ascending: false }).limit(1000),
      supabase.from('sales').select('*').order('date', { ascending: false }).limit(2000),
      supabase.from('vendors').select('*').order('display_name'),
      supabase.from('b2b_customers').select('id,company_name,contact_name,email,country,currency,address,phone,active,registered_date'),
      supabase.from('b2b_orders').select('*, b2b_order_items(*), b2b_order_stages(*)').order('created_at', { ascending: false }),
      supabase.from('projects').select('id,project_name,b2b_order_id,buyer_name,buyer_country,status,pi_no,pi_date,bl_no,container_no,etd,mfg_invoice_no,merch_invoice_no,created_at').order('created_at', { ascending: false }),
      supabase.from('settings').select('key,value').like('key', 'project_full_%'),
      supabase.from('stock_ledger').select('*').order('date', { ascending: false }).limit(1000),
      supabase.from('purchases').select('*').order('date', { ascending: false }).limit(1000),
      supabase.from('flour_batches').select('*').order('date', { ascending: false }),
      supabase.from('webstore_orders').select('*').order('created_at', { ascending: false }).limit(2000),
      supabase.from('packing_materials').select('*').order('name'),
      supabase.from('settings').select('key,value').in('key', SETTINGS_KEYS),
      supabase.from('users').select('id,username,name,email,phone,role,active,totp_enabled,created_at'),
    ]);

    // Merge project meta blobs into project rows
    const metaMap = {};
    (projectMetas || []).forEach(r => {
      const id = r.key.replace('project_full_', '');
      metaMap[id] = r.value;
    });
    const mergedProjects = (projects || []).map(p =>
      metaMap[p.id] ? { ...metaMap[p.id], id: p.id, _full: true } : p
    );

    // Convert settings array to keyed object
    const settings = {};
    (settingsRows || []).forEach(r => { settings[r.key] = r.value; });

    res.json({
      products:      products      || [],
      batches:       batches       || [],
      procurement:   procurement   || [],
      sales:         sales         || [],
      vendors:       vendors       || [],
      b2bCustomers:  b2bCustomers  || [],
      b2bOrders:     b2bOrders     || [],
      projects:      mergedProjects,
      stockLedger:   stockLedger   || [],
      purchases:     purchases     || [],
      flourBatches:  flourBatches  || [],
      wsOrders:      (wsOrders || []).map(o => o.customer ? { ...o, customer: decryptCustomer(o.customer) } : o),
      packingInv:    packingInv    || [],
      settings,
      users:         users         || [],
    });
  } catch (err) {
    console.error('Admin init error:', err.message);
    res.status(500).json({ error: 'Failed to load admin data' });
  }
});

module.exports = router;
