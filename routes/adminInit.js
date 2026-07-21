/**
 * GET /api/admin/init
 * Single endpoint that returns all data needed for the admin panel initial load.
 * Replaces ~24 parallel API calls from the frontend with 1 round-trip.
 */
const express  = require('express');
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');
const { decrypt, decryptCustomer } = require('../config/crypto');
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
      { data: b2bOrdersRaw },
      { data: projects },
      { data: projectMetas },
      { data: stockLedger },
      { data: purchases },
      { data: flourBatches },
      { data: spiceBatches },
      { data: wsOrders },
      { data: packingInv },
      { data: settingsRows },
      { data: users },
      { data: b2bPaymentsRow },
    ] = await Promise.all([
      supabase.from('products').select('*').eq('active', true).order('name'),
      supabase.from('batches').select('*').order('date', { ascending: false }).limit(1000),
      supabase.from('procurements').select('*').order('date', { ascending: false }).limit(1000),
      supabase.from('sales').select('*, sale_items(*)').order('date', { ascending: false }).limit(300),
      supabase.from('vendors').select('*').order('display_name'),
      supabase.from('b2b_customers').select('id,company_name,contact_name,email,country,currency,address,phone,active,registered_date'),
      supabase.from('b2b_orders').select('*, b2b_order_items(*), b2b_order_stages(*)').order('created_at', { ascending: false }).limit(300),
      supabase.from('projects').select('id,project_name,b2b_order_id,buyer_name,buyer_country,status,pi_no,pi_date,bl_no,container_no,etd,mfg_invoice_no,merch_invoice_no,created_at').order('created_at', { ascending: false }).limit(200),
      supabase.from('settings').select('key,value').like('key', 'project_full_%').limit(200),
      supabase.from('stock_ledger').select('*').order('date', { ascending: false }).limit(500),
      supabase.from('purchases').select('*').order('date', { ascending: false }).limit(300),
      supabase.from('flour_batches').select('*').order('date', { ascending: false }).limit(200),
      supabase.from('spice_batches').select('*').order('date', { ascending: false }).limit(200),
      supabase.from('webstore_orders').select('*').order('created_at', { ascending: false }).limit(300),
      supabase.from('packing_materials').select('id,name,category,product_name,size,unit,current_stock,min_stock,unit_price,avg_cost,supplier,active').order('name'),
      supabase.from('settings').select('key,value').in('key', SETTINGS_KEYS),
      supabase.from('users').select('id,username,name,email,phone,role,active,totp_enabled,created_at'),
      supabase.from('settings').select('value').eq('key', 'b2b_payments').single(),
    ]);

    // Merge b2b_payments into orders so payment fields are available in admin
    const b2bPayments = b2bPaymentsRow?.value || {};
    let b2bOrders = (b2bOrdersRaw || []).map(o => ({ ...o, ...(b2bPayments[o.id] || {}) }));

    // Attach _invoiceVal from project MFG+MERCH totals (total_value is often 0 for export orders)
    if (projects && projects.length > 0 && projectMetas && projectMetas.length > 0) {
      const toNum = v => parseFloat(v) || 0;
      const calcItem = it => toNum(it.qty) * toNum(it.rateINR || it.rate);
      const fullMap = {};
      projectMetas.forEach(r => { fullMap[r.key] = r.value; });
      const invoiceMap = {};
      projects.forEach(p => {
        const full = fullMap[`project_full_${p.id}`] || {};
        const mfgItems = full.mfg?.items || [];
        const mrchItems = full.merch?.items || [];
        const mfgTotal = mfgItems.reduce((s, it) => s + (toNum(it.totalINR) || calcItem(it)), 0);
        const mrchTotal = mrchItems.reduce((s, it) => s + (toNum(it.totalINR) || calcItem(it)), 0);
        if (p.b2b_order_id && (mfgTotal + mrchTotal) > 0) {
          invoiceMap[p.b2b_order_id] = {
            _invoiceVal: mfgTotal + mrchTotal,
            _logisticsCharge: toNum(full.financials?.logisticsCharge),
            _otherCharges: toNum(full.financials?.otherCharges),
          };
        }
      });
      b2bOrders = b2bOrders.map(o => invoiceMap[o.id] ? { ...o, ...invoiceMap[o.id] } : o);
    }

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
      sales:         (sales || []).map(s => ({ ...s, customer_name: decrypt(s.customer_name) || s.customer_name, customer_phone: decrypt(s.customer_phone) || s.customer_phone, customer_email: decrypt(s.customer_email) || s.customer_email })),
      vendors:       vendors       || [],
      b2bCustomers:  b2bCustomers  || [],
      b2bOrders:     b2bOrders     || [],
      projects:      mergedProjects,
      stockLedger:   stockLedger   || [],
      purchases:     purchases     || [],
      flourBatches:  flourBatches  || [],
      spiceBatches:  spiceBatches  || [],
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
