const express = require('express');
const supabase = require('../config/supabase');
const { auth, requireRole } = require('../middleware/auth');
const { createInvoice, recordPayment, zoho } = require('../config/zoho');

const b2bCustomers = express.Router();
const B2B_CUST_SELECT = 'id,company_name,contact_name,email,country,currency,address,delivery_address,phone,gstin,pan,gst_treatment,payment_terms,active,registered_date';

b2bCustomers.get('/', auth, requireRole('admin','manager','ceo'), async (req, res) => {
  const { data, error } = await supabase
    .from('b2b_customers')
    .select(B2B_CUST_SELECT)
    .order('company_name')
    .limit(500);
  if (error) return res.status(500).json({ error: 'Failed to load customers' });
  res.json(data);
});
b2bCustomers.put('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  const c = req.body;
  const updates = {};
  if (c.companyName       !== undefined) updates.company_name     = c.companyName;
  if (c.contactName       !== undefined) updates.contact_name     = c.contactName;
  if (c.email             !== undefined) updates.email            = c.email;
  if (c.country           !== undefined) updates.country          = c.country;
  if (c.currency          !== undefined) updates.currency         = c.currency;
  if (c.address           !== undefined) updates.address          = c.address;
  if (c.deliveryAddress   !== undefined) updates.delivery_address = c.deliveryAddress;
  if (c.phone             !== undefined) updates.phone            = c.phone;
  if (c.gstin             !== undefined) updates.gstin            = c.gstin;
  if (c.pan               !== undefined) updates.pan              = c.pan;
  if (c.gstTreatment      !== undefined) updates.gst_treatment    = c.gstTreatment;
  if (c.paymentTerms      !== undefined) updates.payment_terms    = c.paymentTerms;
  if (c.active            !== undefined) updates.active           = c.active;
  const { data, error } = await supabase.from('b2b_customers').update(updates).eq('id', req.params.id).select(B2B_CUST_SELECT).single();
  if (error) return res.status(400).json({ error: 'Update failed' });
  res.json(data);
});
b2bCustomers.post('/', auth, requireRole('admin'), async (req, res) => {
  const c = req.body;
  const { data, error } = await supabase.from('b2b_customers').insert({
    company_name: c.companyName, contact_name: c.contactName, email: c.email,
    password: null, country: c.country, currency: c.currency||'INR',
    address: c.address, delivery_address: c.deliveryAddress||null,
    phone: c.phone, gstin: c.gstin||null, pan: c.pan||null,
    gst_treatment: c.gstTreatment||null, payment_terms: c.paymentTerms||null,
  }).select(B2B_CUST_SELECT).single();
  if (error) return res.status(400).json({ error: 'Failed to create customer' });
  res.status(201).json(data);
});

const b2bOrders = express.Router();
b2bOrders.get('/', auth, async (req, res) => {
  // B2B customers can only see their own orders
  let query = supabase.from('b2b_orders')
    .select('*, b2b_order_items(*), b2b_order_stages(*)')
    .order('created_at', { ascending: false })
    .limit(500);
  if (req.user.type === 'b2b_customer') {
    query = query.eq('customer_id', req.user.id);
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'Failed to load orders' });
  res.json(data);
});
b2bOrders.post('/', auth, async (req, res) => {
  const o = req.body;
  // B2B customers can only create orders for themselves
  if (req.user.type === 'b2b_customer' && o.customerId !== req.user.id) {
    return res.status(403).json({ error: 'Cannot create order for another customer' });
  }
  const { data: order, error } = await supabase.from('b2b_orders').insert({ order_no:o.orderNo, date:o.date, customer_id:o.customerId, buyer_name:o.buyerName, stage:o.stage||'order_placed', total_value:o.totalValue||0, notes:o.notes||'' }).select().single();
  if (error) return res.status(400).json({ error: 'Failed to create order' });
  if (o.items && o.items.length) {
    await supabase.from('b2b_order_items').insert(o.items.map(i => ({ order_id:order.id, product_id:i.productId, product_name:i.productName, qty:i.qty, unit:i.unit||'pcs', unit_price:i.unitPrice, currency:i.currency||'INR', notes:i.notes||'' })));
  }
  await supabase.from('b2b_order_stages').insert({ order_id:order.id, stage:o.stage||'order_placed', date:o.date, note:o.stageNote||'Order created', updated_by:req.user ? req.user.name || req.user.companyName : 'System' });
  res.status(201).json(order);
});
b2bOrders.put('/:id/items', auth, async (req, res) => {
  // B2B customers can only update their own orders' items (only when in editable stage)
  const { data: order } = await supabase.from('b2b_orders').select('customer_id,stage').eq('id', req.params.id).single();
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (req.user.type === 'b2b_customer' && order.customer_id !== req.user.id)
    return res.status(403).json({ error: 'Cannot edit another customer\'s order' });
  if (!['order_placed','draft','buyer_request'].includes(order.stage))
    return res.status(400).json({ error: 'Order cannot be edited at this stage' });
  const { items, updatedBy } = req.body;
  // Delete existing items and re-insert
  await supabase.from('b2b_order_items').delete().eq('order_id', req.params.id);
  if (items && items.length) {
    await supabase.from('b2b_order_items').insert(items.map(i => ({
      order_id: req.params.id, product_id: i.productId, product_name: i.productName,
      qty: i.qty, unit: i.unit||'pcs', unit_price: i.unitPrice, currency: i.currency||'INR', notes: i.notes||''
    })));
  }
  await supabase.from('b2b_order_stages').insert({ order_id: req.params.id, stage: order.stage, date: new Date().toISOString().slice(0,10), note: 'Order items updated by buyer', updated_by: updatedBy||'Buyer' });
  res.json({ message: 'Items updated' });
});
b2bOrders.put('/:id/stage', auth, requireRole('admin','manager','ceo'), async (req, res) => {
  const { stage, note, date, blNo, containerNo } = req.body;
  const updates = { stage };
  if (blNo) updates.bl_no = blNo;
  if (containerNo) updates.container_no = containerNo;
  const { data, error } = await supabase.from('b2b_orders').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: 'Stage update failed' });
  await supabase.from('b2b_order_stages').insert({ order_id:req.params.id, stage, date:date||new Date().toISOString().slice(0,10), note:note||('Stage: '+stage), updated_by:req.user ? req.user.name : 'Admin' });
  res.json(data);

  // Non-blocking: sync to Zoho Books
  if (!process.env.ZOHO_ORG_ID) return;
  const orderId = req.params.id;
  if (stage === 'invoice_sent') {
    setImmediate(async () => {
      try {
        const { data: order } = await supabase.from('b2b_orders').select('*, b2b_order_items(*)').eq('id', orderId).single();
        const { data: cust } = await supabase.from('b2b_customers').select('company_name,contact_name,email,phone').eq('id', order.customer_id).single();
        const zohoOrder = {
          orderNo:  order.order_no,
          date:     order.date || new Date().toISOString().slice(0, 10),
          customer: { name: cust?.company_name || order.buyer_name || 'B2B Customer', email: cust?.email || null, phone: cust?.phone || '' },
          items:    (order.b2b_order_items || []).map(i => ({ name: i.product_name, qty: i.qty, price: i.unit_price })),
          shipping: 0,
          total:    parseFloat(order.total_value) || 0,
        };
        await createInvoice(zohoOrder);
      } catch (ze) {
        console.error('Zoho B2B invoice error:', ze.message);
      }
    });
  } else if (stage === 'invoice_paid') {
    setImmediate(async () => {
      try {
        const { data: order } = await supabase.from('b2b_orders').select('order_no,total_value').eq('id', orderId).single();
        const result = await zoho('get', '/invoices', null, { reference_number: order.order_no, status: 'sent' });
        const invoice = result?.invoices?.[0];
        if (invoice) {
          await recordPayment(invoice, order.total_value, 'bank', order.order_no);
        }
      } catch (ze) {
        console.error('Zoho B2B payment error:', ze.message);
      }
    });
  }
});
b2bOrders.put('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  const o = req.body;
  const u = { stage:o.stage, notes:o.notes, bl_no:o.blNo, container_no:o.containerNo, etd:o.etd, eta:o.eta };
  if (o.courier       !== undefined) u.courier        = o.courier;
  if (o.awbNumber     !== undefined) u.awb_number     = o.awbNumber;
  if (o.dispatchDate  !== undefined) u.dispatch_date  = o.dispatchDate;
  if (o.deliveredDate !== undefined) u.delivered_date = o.deliveredDate;
  const { data, error } = await supabase.from('b2b_orders').update(u).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: 'Update failed' });
  res.json(data);
});
b2bOrders.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  await supabase.from('b2b_order_items').delete().eq('order_id', req.params.id);
  await supabase.from('b2b_order_stages').delete().eq('order_id', req.params.id);
  await supabase.from('b2b_orders').delete().eq('id', req.params.id);
  res.json({ message: 'Deleted' });
});

// ── helper: save full project JSON into settings ───────────────────────────────
async function saveProjectFull(id, data) {
  return supabase.from('settings').upsert({ key: `project_full_${id}`, value: data, updated_at: new Date() });
}

const projects = express.Router();

// GET all projects — returns DB index fields + full JSON blob from settings
projects.get('/', auth, async (req, res) => {
  const { data, error } = await supabase.from('projects')
    .select('id,project_name,b2b_order_id,buyer_name,buyer_country,status,pi_no,pi_date,bl_no,container_no,etd,mfg_invoice_no,merch_invoice_no,created_at')
    .order('created_at', { ascending: false }).limit(500);
  if (error) return res.status(500).json({ error: 'Failed to load projects' });
  if (!data || !data.length) return res.json([]);

  // Fetch full project blobs for all projects in one query
  const { data: metas } = await supabase.from('settings')
    .select('key,value').in('key', data.map(p => `project_full_${p.id}`));
  const metaMap = {};
  (metas||[]).forEach(m => { metaMap[m.key] = m.value; });

  res.set('Cache-Control','no-store');
  res.json(data.map(p => ({
    ...p,
    _full: metaMap[`project_full_${p.id}`] || null,
  })));
});

// POST — create project; store full data in settings
projects.post('/', auth, requireRole('admin','manager'), async (req, res) => {
  const p = req.body;
  const { data: proj, error } = await supabase.from('projects').insert({
    project_name: p.projectName || 'New Project',
    b2b_order_id: p.b2bOrderId || null,
    buyer_name:   p.buyerName || '',
    buyer_country: p.buyerCountry || '',
    port_of_loading: p.portOfLoading || '',
    port_of_discharge: p.portOfDischarge || '',
    final_destination: p.finalDestination || '',
    pi_no: p.piNo || '',
    pi_date: p.piDate || new Date().toISOString().slice(0,10),
    status: p.status || 'draft',
    notes: p.notes || '',
    mfg_invoice_no:   p.mfg?.invoiceNo || '',
    mfg_invoice_date: p.mfg?.invoiceDate || null,
    merch_invoice_no:   p.merch?.invoiceNo || '',
    merch_invoice_date: p.merch?.invoiceDate || null,
    bl_no: p.blNo || '',
    container_no: p.containerNo || '',
    etd: p.etd || null,
  }).select('id,project_name,b2b_order_id,buyer_name,buyer_country,status,created_at').single();
  if (error) return res.status(400).json({ error: 'Failed to create project' });

  // Store full project blob
  await saveProjectFull(proj.id, { ...p, id: proj.id });
  res.status(201).json({ ...proj, _full: { ...p, id: proj.id } });
});

// PUT — update project; replace full blob in settings
projects.put('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  const p = req.body;
  const { error } = await supabase.from('projects').update({
    project_name: p.projectName,
    b2b_order_id: p.b2bOrderId || null,
    buyer_name:   p.buyerName || '',
    buyer_country: p.buyerCountry || '',
    port_of_loading: p.portOfLoading || '',
    port_of_discharge: p.portOfDischarge || '',
    final_destination: p.finalDestination || '',
    pi_no: p.piNo || '',
    pi_date: p.piDate || null,
    status: p.status || 'draft',
    notes: p.notes || '',
    mfg_invoice_no:   p.mfg?.invoiceNo || '',
    mfg_invoice_date: p.mfg?.invoiceDate || null,
    merch_invoice_no:   p.merch?.invoiceNo || '',
    merch_invoice_date: p.merch?.invoiceDate || null,
    bl_no: p.blNo || '',
    container_no: p.containerNo || '',
    etd: p.etd || null,
  }).eq('id', req.params.id);
  if (error) return res.status(400).json({ error: 'Update failed' });

  // Update full blob + sync project_expenses
  await saveProjectFull(req.params.id, p);
  await supabase.from('project_expenses').delete().eq('project_id', req.params.id);
  const exps = (p.expenses||[]).map(e => ({
    project_id: req.params.id, date: e.date, category: e.category||'',
    subcategory: e.subcategory||'', description: e.description||'', vendor: e.vendor||'',
    qty: parseFloat(e.qty)||1, unit: e.unit||'', unit_cost: parseFloat(e.unitCost)||0,
    total_cost: parseFloat(e.totalCost)||0, paid_by: e.paidBy||'Company', stage: e.stage||'production',
  }));
  if (exps.length) await supabase.from('project_expenses').insert(exps);

  res.json({ id: req.params.id, success: true });
});

// DELETE project + all related data
projects.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  await supabase.from('project_items').delete().eq('project_id', req.params.id);
  await supabase.from('project_expenses').delete().eq('project_id', req.params.id);
  await supabase.from('projects').delete().eq('id', req.params.id);
  await supabase.from('settings').delete().eq('key', `project_full_${req.params.id}`);
  res.json({ message: 'Deleted' });
});

// ── Item-level production progress (stored in settings table as key-value) ──
// Key pattern: b2b_item_progress_<orderId>
// Value: array of { item_key, product_name, product_type, stage, stage_history, notes, updated_at, updated_by }
const b2bItemProgress = express.Router();

b2bItemProgress.get('/:orderId', auth, async (req, res) => {
  // Customers can only see progress for their own orders
  if (req.user.type === 'b2b_customer') {
    const { data: order } = await supabase.from('b2b_orders').select('customer_id').eq('id', req.params.orderId).single();
    if (!order || order.customer_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  }
  const settingsKey = `b2b_item_progress_${req.params.orderId}`;
  const { data } = await supabase.from('settings').select('value').eq('key', settingsKey).maybeSingle();
  res.set('Cache-Control', 'no-store');
  res.json(Array.isArray(data?.value) ? data.value : []);
});

// Bulk update all items in one atomic DB write (avoids race condition from parallel PUTs)
b2bItemProgress.put('/:orderId', auth, (req, res, next) => {
  if (req.user?.type === 'b2b_customer') return res.status(403).json({ error: 'Insufficient permissions' });
  next();
}, async (req, res) => {
  const { items } = req.body; // [{ itemKey, stage, notes, productName, productType }]
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items array required' });
  const now = new Date().toISOString();
  const updatedBy = req.user.name || 'Admin';
  const settingsKey = `b2b_item_progress_${req.params.orderId}`;
  const { data: existing } = await supabase.from('settings').select('value').eq('key', settingsKey).maybeSingle();
  const arr = Array.isArray(existing?.value) ? [...existing.value] : [];
  for (const item of items) {
    const itemKey = item.itemKey;
    const idx = arr.findIndex(r => r.item_key === itemKey);
    const prev = idx >= 0 ? arr[idx] : null;
    const history = Array.isArray(prev?.stage_history) ? [...prev.stage_history] : [];
    history.push({ stage: item.stage, date: now.slice(0, 10), time: now, note: item.notes || '', updated_by: updatedBy });
    const record = { item_key: itemKey, product_name: item.productName || prev?.product_name || '', product_type: item.productType || prev?.product_type || 'other', stage: item.stage, stage_history: history, notes: item.notes || '', updated_at: now, updated_by: updatedBy };
    if (idx >= 0) arr[idx] = record; else arr.push(record);
  }
  const { error: saveError } = await supabase.from('settings').upsert({ key: settingsKey, value: arr, updated_at: new Date() });
  if (saveError) return res.status(400).json({ error: 'Bulk update failed', detail: saveError.message });
  res.json({ updated: items.length });
});

b2bItemProgress.put('/:orderId/:itemKey', auth, (req, res, next) => {
  if (req.user?.type === 'b2b_customer') return res.status(403).json({ error: 'Insufficient permissions' });
  next();
}, async (req, res) => {
  const { stage, notes, productName, productType } = req.body;
  const now = new Date().toISOString();
  const updatedBy = req.user.name || 'Admin';
  const settingsKey = `b2b_item_progress_${req.params.orderId}`;
  const itemKey = decodeURIComponent(req.params.itemKey);

  const { data: existing } = await supabase.from('settings').select('value').eq('key', settingsKey).maybeSingle();
  const arr = Array.isArray(existing?.value) ? [...existing.value] : [];

  const idx = arr.findIndex(r => r.item_key === itemKey);
  const prev = idx >= 0 ? arr[idx] : null;
  const history = Array.isArray(prev?.stage_history) ? [...prev.stage_history] : [];
  history.push({ stage, date: now.slice(0, 10), time: now, note: notes || '', updated_by: updatedBy });

  const record = {
    item_key:      itemKey,
    product_name:  productName || prev?.product_name || '',
    product_type:  productType || prev?.product_type || 'other',
    stage,
    stage_history: history,
    notes:         notes || '',
    updated_at:    now,
    updated_by:    updatedBy,
  };

  if (idx >= 0) arr[idx] = record; else arr.push(record);

  const { error } = await supabase.from('settings').upsert({ key: settingsKey, value: arr, updated_at: new Date() });
  if (error) return res.status(400).json({ error: 'Update failed', detail: error.message });
  res.json(record);
});

module.exports = { b2bCustomers, b2bOrders, projects, b2bItemProgress };
