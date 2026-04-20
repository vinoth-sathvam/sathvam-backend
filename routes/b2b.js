const express = require('express');
const supabase = require('../config/supabase');
const { auth, requireRole } = require('../middleware/auth');
const { createInvoice, recordPayment, zoho } = require('../config/zoho');

const b2bCustomers = express.Router();
const B2B_CUST_SELECT = 'id,company_name,contact_name,email,country,currency,address,delivery_address,phone,gstin,pan,gst_treatment,payment_terms,active,registered_date,credit_limit,credit_used';

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
  if (c.creditLimit       !== undefined) updates.credit_limit     = c.creditLimit;
  const { data, error } = await supabase.from('b2b_customers').update(updates).eq('id', req.params.id).select(B2B_CUST_SELECT + ',credit_limit,credit_used').single();
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
  const { stage, note, date, blNo, containerNo, carrierTrackingUrl } = req.body;
  const updates = { stage };
  if (blNo) updates.bl_no = blNo;
  if (containerNo) updates.container_no = containerNo;
  if (carrierTrackingUrl !== undefined) updates.carrier_tracking_url = carrierTrackingUrl;
  const { data, error } = await supabase.from('b2b_orders').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: 'Stage update failed' });
  await supabase.from('b2b_order_stages').insert({ order_id:req.params.id, stage, date:date||new Date().toISOString().slice(0,10), note:note||('Stage: '+stage), updated_by:req.user ? req.user.name : 'Admin' });
  res.json(data);

  // Non-blocking: Auto WhatsApp to buyer on stage change
  setImmediate(async () => {
    try {
      const { data: order } = await supabase.from('b2b_orders').select('order_no,customer_id,buyer_name').eq('id', req.params.id).single();
      if (!order) return;
      const { data: cust } = await supabase.from('b2b_customers').select('phone,contact_name,company_name').eq('id', order.customer_id).maybeSingle();
      const phone = cust?.phone;
      if (!phone || !process.env.BOTSAILOR_API_TOKEN) return;
      const stageLabels = {
        order_placed: 'Order Placed', confirmed: 'Order Confirmed', in_production: 'In Production',
        quality_check: 'Quality Check', ready_to_ship: 'Ready to Ship', shipped: 'Shipped',
        in_transit: 'In Transit', arrived_at_port: 'Arrived at Port', customs_clearance: 'Customs Clearance',
        out_for_delivery: 'Out for Delivery', delivered: 'Delivered', invoice_sent: 'Invoice Sent',
        invoice_paid: 'Invoice Paid', cancelled: 'Cancelled'
      };
      const stageLabel = stageLabels[stage] || stage;
      const trackingLine = carrierTrackingUrl ? `\nTracking: ${carrierTrackingUrl}` : '';
      const msg = `🌿 *Sathvam Organics – Order Update*\n\nDear ${cust?.contact_name || order.buyer_name || 'Customer'},\n\nYour order *${order.order_no}* has been updated to:\n*${stageLabel}*${trackingLine}\n\n${note ? `Note: ${note}\n\n` : ''}For queries, reply to this message.\n_sathvam.in_`;
      const cleanPhone = phone.replace(/\D/g,'');
      const waPhone = cleanPhone.startsWith('91') ? cleanPhone : '91' + cleanPhone;
      await fetch(`https://app.botsailor.com/api/whatsapp-business/send-message`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.BOTSAILOR_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number_id: process.env.BOTSAILOR_PHONE_NUMBER_ID, to: waPhone, type: 'text', text: { body: msg } })
      });
    } catch(e) { console.error('[B2B-WA-STAGE]', e.message); }
  });

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

// ── Statement of Account ───────────────────────────────────────────────────────
const b2bStatement = express.Router();
b2bStatement.get('/:customerId', auth, async (req, res) => {
  const cid = req.params.customerId;
  if (req.user.type === 'b2b_customer' && req.user.id !== cid)
    return res.status(403).json({ error: 'Forbidden' });
  const { data: cust } = await supabase.from('b2b_customers').select('company_name,contact_name,email,currency').eq('id', cid).single();
  const { data: orders } = await supabase.from('b2b_orders').select('id,order_no,date,total_value,stage,created_at').eq('customer_id', cid).order('date', { ascending: true });
  const totalInvoiced = (orders||[]).filter(o => ['invoice_sent','invoice_paid','delivered'].includes(o.stage)).reduce((s,o)=>s+parseFloat(o.total_value||0),0);
  const totalPaid     = (orders||[]).filter(o => o.stage === 'invoice_paid').reduce((s,o)=>s+parseFloat(o.total_value||0),0);
  res.json({ customer: cust, orders: orders||[], totalInvoiced, totalPaid, outstanding: totalInvoiced - totalPaid });
});

// ── Quick Reorder ─────────────────────────────────────────────────────────────
b2bOrders.post('/:id/reorder', auth, async (req, res) => {
  const { data: src } = await supabase.from('b2b_orders').select('*, b2b_order_items(*)').eq('id', req.params.id).single();
  if (!src) return res.status(404).json({ error: 'Order not found' });
  if (req.user.type === 'b2b_customer' && src.customer_id !== req.user.id)
    return res.status(403).json({ error: 'Forbidden' });
  const today = new Date().toISOString().slice(0,10);
  const yr = today.slice(2,4), mo = today.slice(5,7);
  const { count } = await supabase.from('b2b_orders').select('id', { count: 'exact', head: true });
  const newOrderNo = `B2B-${yr}${mo}-${String((count||0)+1).padStart(4,'0')}`;
  const { data: newOrder, error } = await supabase.from('b2b_orders').insert({
    order_no: newOrderNo, date: today, customer_id: src.customer_id,
    buyer_name: src.buyer_name, stage: 'order_placed', total_value: src.total_value, notes: `Reorder of ${src.order_no}`
  }).select().single();
  if (error) return res.status(400).json({ error: 'Reorder failed' });
  if (src.b2b_order_items?.length) {
    await supabase.from('b2b_order_items').insert(src.b2b_order_items.map(i => ({
      order_id: newOrder.id, product_id: i.product_id, product_name: i.product_name,
      qty: i.qty, unit: i.unit, unit_price: i.unit_price, currency: i.currency, notes: i.notes||''
    })));
  }
  await supabase.from('b2b_order_stages').insert({ order_id: newOrder.id, stage: 'order_placed', date: today, note: `Reordered from ${src.order_no}`, updated_by: req.user.name || req.user.companyName || 'Buyer' });
  res.status(201).json(newOrder);
});

// ── Carrier tracking update (standalone endpoint for buyers) ──────────────────
b2bOrders.put('/:id/tracking', auth, requireRole('admin','manager'), async (req, res) => {
  const { carrierTrackingUrl, courier, awbNumber } = req.body;
  const updates = {};
  if (carrierTrackingUrl !== undefined) updates.carrier_tracking_url = carrierTrackingUrl;
  if (courier !== undefined) updates.courier = courier;
  if (awbNumber !== undefined) updates.awb_number = awbNumber;
  const { error } = await supabase.from('b2b_orders').update(updates).eq('id', req.params.id);
  if (error) return res.status(400).json({ error: 'Update failed' });
  res.json({ message: 'Tracking updated' });
});

// ── Compliance checklist ──────────────────────────────────────────────────────
b2bOrders.put('/:id/compliance', auth, requireRole('admin','manager'), async (req, res) => {
  const { checklist } = req.body; // { fssai: bool, coo: bool, phyto: bool, ... }
  const { error } = await supabase.from('b2b_orders').update({ compliance_checklist: checklist }).eq('id', req.params.id);
  if (error) return res.status(400).json({ error: 'Update failed' });
  res.json({ message: 'Compliance updated' });
});

// ── Live Stock Visibility ─────────────────────────────────────────────────────
const b2bStock = express.Router();
b2bStock.get('/', auth, async (req, res) => {
  const { data: products } = await supabase.from('products').select('id,name,stock_qty,unit').order('name').limit(500);
  res.json(products || []);
});

// ── Custom Pricing ────────────────────────────────────────────────────────────
const b2bCustomPrices = express.Router();
b2bCustomPrices.get('/:customerId', auth, async (req, res) => {
  const { data } = await supabase.from('settings').select('value').eq('key', `b2b_custom_prices_${req.params.customerId}`).maybeSingle();
  res.json(data?.value || {});
});
b2bCustomPrices.put('/:customerId', auth, requireRole('admin','manager'), async (req, res) => {
  const { prices } = req.body; // { productId: price, ... }
  const { error } = await supabase.from('settings').upsert({ key: `b2b_custom_prices_${req.params.customerId}`, value: prices, updated_at: new Date() });
  if (error) return res.status(400).json({ error: 'Failed to save prices' });
  res.json({ message: 'Saved' });
});

// ── Quotation / RFQ ───────────────────────────────────────────────────────────
const b2bQuotes = express.Router();
b2bQuotes.get('/', auth, async (req, res) => {
  let query = supabase.from('b2b_quotations').select('*').order('created_at', { ascending: false }).limit(200);
  if (req.user.type === 'b2b_customer') query = query.eq('customer_id', req.user.id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: 'Failed to load quotations' });
  res.json(data||[]);
});
b2bQuotes.post('/', auth, async (req, res) => {
  const q = req.body;
  const customerId = req.user.type === 'b2b_customer' ? req.user.id : q.customerId;
  const { data, error } = await supabase.from('b2b_quotations').insert({
    customer_id: customerId, order_id: q.orderId||null, status: q.status||'requested',
    items: q.items||[], notes: q.notes||'', admin_notes: q.adminNotes||'',
    expires_at: q.expiresAt||null, total_value: q.totalValue||0,
    requested_by: req.user.name || req.user.companyName || 'Buyer'
  }).select().single();
  if (error) return res.status(400).json({ error: 'Failed to create quotation' });
  res.status(201).json(data);
});
b2bQuotes.put('/:id', auth, async (req, res) => {
  const q = req.body;
  const { data: existing } = await supabase.from('b2b_quotations').select('customer_id,status').eq('id', req.params.id).single();
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (req.user.type === 'b2b_customer' && existing.customer_id !== req.user.id)
    return res.status(403).json({ error: 'Forbidden' });
  const updates = {};
  if (q.status     !== undefined) updates.status      = q.status;
  if (q.items      !== undefined) updates.items       = q.items;
  if (q.notes      !== undefined) updates.notes       = q.notes;
  if (q.adminNotes !== undefined) updates.admin_notes = q.adminNotes;
  if (q.expiresAt  !== undefined) updates.expires_at  = q.expiresAt;
  if (q.totalValue !== undefined) updates.total_value = q.totalValue;
  const { data, error } = await supabase.from('b2b_quotations').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: 'Update failed' });
  res.json(data);

  // Auto-WhatsApp buyer when quote is responded to
  if (q.status === 'quoted' && process.env.BOTSAILOR_API_TOKEN) {
    setImmediate(async () => {
      try {
        const { data: cust } = await supabase.from('b2b_customers').select('phone,contact_name').eq('id', existing.customer_id).single();
        if (!cust?.phone) return;
        const cleanPhone = cust.phone.replace(/\D/g,'');
        const waPhone = cleanPhone.startsWith('91') ? cleanPhone : '91'+cleanPhone;
        const msg = `🌿 *Sathvam Organics – Quotation Ready*\n\nDear ${cust.contact_name},\n\nYour quotation request has been responded to. Please login to your portal to review and accept.\n\n_sathvam.in/b2b_`;
        await fetch('https://app.botsailor.com/api/whatsapp-business/send-message', {
          method:'POST', headers:{'Authorization':`Bearer ${process.env.BOTSAILOR_API_TOKEN}`,'Content-Type':'application/json'},
          body: JSON.stringify({ phone_number_id: process.env.BOTSAILOR_PHONE_NUMBER_ID, to: waPhone, type:'text', text:{ body: msg } })
        });
      } catch(e) { console.error('[B2B-WA-QUOTE]', e.message); }
    });
  }
});
b2bQuotes.post('/:id/convert', auth, requireRole('admin','manager'), async (req, res) => {
  const { data: quote } = await supabase.from('b2b_quotations').select('*').eq('id', req.params.id).single();
  if (!quote) return res.status(404).json({ error: 'Quote not found' });
  const today = new Date().toISOString().slice(0,10);
  const yr = today.slice(2,4), mo = today.slice(5,7);
  const { count } = await supabase.from('b2b_orders').select('id', { count: 'exact', head: true });
  const newOrderNo = `B2B-${yr}${mo}-${String((count||0)+1).padStart(4,'0')}`;
  const { data: order, error } = await supabase.from('b2b_orders').insert({
    order_no: newOrderNo, date: today, customer_id: quote.customer_id,
    stage: 'order_placed', total_value: quote.total_value, notes: `From quotation QT-${quote.id.slice(0,8)}`
  }).select().single();
  if (error) return res.status(400).json({ error: 'Failed to convert quotation' });
  if (Array.isArray(quote.items) && quote.items.length) {
    await supabase.from('b2b_order_items').insert(quote.items.map(i => ({
      order_id: order.id, product_name: i.productName||i.product_name||'', qty: i.qty||1, unit: i.unit||'pcs', unit_price: i.unitPrice||i.unit_price||0, currency: i.currency||'INR'
    })));
  }
  await supabase.from('b2b_order_stages').insert({ order_id: order.id, stage: 'order_placed', date: today, note: `Converted from quotation`, updated_by: req.user.name||'Admin' });
  await supabase.from('b2b_quotations').update({ status: 'converted', order_id: order.id }).eq('id', req.params.id);
  res.status(201).json(order);
});

// ── Document Vault ────────────────────────────────────────────────────────────
const b2bDocs = express.Router();
b2bDocs.get('/:orderId', auth, async (req, res) => {
  if (req.user.type === 'b2b_customer') {
    const { data: order } = await supabase.from('b2b_orders').select('customer_id').eq('id', req.params.orderId).single();
    if (!order || order.customer_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  }
  const { data } = await supabase.from('settings').select('value').eq('key', `b2b_docs_${req.params.orderId}`).maybeSingle();
  res.json(Array.isArray(data?.value) ? data.value : []);
});
b2bDocs.post('/:orderId', auth, async (req, res) => {
  const { docType, fileName, fileUrl, uploadedBy } = req.body;
  const key = `b2b_docs_${req.params.orderId}`;
  const { data: existing } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
  const arr = Array.isArray(existing?.value) ? [...existing.value] : [];
  const doc = { id: Date.now().toString(36), docType, fileName, fileUrl, uploadedBy: uploadedBy || req.user.name || 'Admin', uploadedAt: new Date().toISOString() };
  arr.push(doc);
  await supabase.from('settings').upsert({ key, value: arr, updated_at: new Date() });
  res.status(201).json(doc);
});
b2bDocs.delete('/:orderId/:docId', auth, requireRole('admin','manager'), async (req, res) => {
  const key = `b2b_docs_${req.params.orderId}`;
  const { data: existing } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
  const arr = (Array.isArray(existing?.value) ? existing.value : []).filter(d => d.id !== req.params.docId);
  await supabase.from('settings').upsert({ key, value: arr, updated_at: new Date() });
  res.json({ message: 'Deleted' });
});

// ── Sample Requests ───────────────────────────────────────────────────────────
const b2bSamples = express.Router();
b2bSamples.get('/', auth, async (req, res) => {
  const key = 'b2b_sample_requests';
  const { data } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
  let all = Array.isArray(data?.value) ? data.value : [];
  if (req.user.type === 'b2b_customer') all = all.filter(s => s.customerId === req.user.id);
  res.json(all.sort((a,b) => b.createdAt > a.createdAt ? 1 : -1));
});
b2bSamples.post('/', auth, async (req, res) => {
  const { items, notes, shippingAddress } = req.body;
  const customerId = req.user.type === 'b2b_customer' ? req.user.id : req.body.customerId;
  const key = 'b2b_sample_requests';
  const { data: existing } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
  const arr = Array.isArray(existing?.value) ? [...existing.value] : [];
  const sample = { id: Date.now().toString(36), customerId, items: items||[], notes: notes||'', shippingAddress: shippingAddress||'', status: 'pending', adminNotes: '', createdAt: new Date().toISOString() };
  arr.push(sample);
  await supabase.from('settings').upsert({ key, value: arr, updated_at: new Date() });
  res.status(201).json(sample);
});
b2bSamples.put('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  const { status, adminNotes } = req.body;
  const key = 'b2b_sample_requests';
  const { data: existing } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
  const arr = Array.isArray(existing?.value) ? [...existing.value] : [];
  const idx = arr.findIndex(s => s.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  if (status !== undefined) arr[idx].status = status;
  if (adminNotes !== undefined) arr[idx].adminNotes = adminNotes;
  await supabase.from('settings').upsert({ key, value: arr, updated_at: new Date() });
  res.json(arr[idx]);
});

// ── In-portal Messaging ───────────────────────────────────────────────────────
const b2bMessages = express.Router();
b2bMessages.get('/:orderId', auth, async (req, res) => {
  if (req.user.type === 'b2b_customer') {
    const { data: order } = await supabase.from('b2b_orders').select('customer_id').eq('id', req.params.orderId).single();
    if (!order || order.customer_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  }
  const key = `b2b_msgs_${req.params.orderId}`;
  const { data } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
  res.json(Array.isArray(data?.value) ? data.value : []);
});
b2bMessages.post('/:orderId', auth, async (req, res) => {
  if (req.user.type === 'b2b_customer') {
    const { data: order } = await supabase.from('b2b_orders').select('customer_id').eq('id', req.params.orderId).single();
    if (!order || order.customer_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  }
  const { body } = req.body;
  const key = `b2b_msgs_${req.params.orderId}`;
  const { data: existing } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
  const arr = Array.isArray(existing?.value) ? [...existing.value] : [];
  const msg = {
    id: Date.now().toString(36),
    senderType: req.user.type === 'b2b_customer' ? 'buyer' : 'admin',
    senderName: req.user.name || req.user.companyName || 'Unknown',
    body: body || '',
    createdAt: new Date().toISOString()
  };
  arr.push(msg);
  await supabase.from('settings').upsert({ key, value: arr, updated_at: new Date() });
  res.status(201).json(msg);
});

// ── Admin B2B Analytics ───────────────────────────────────────────────────────
const b2bAnalytics = express.Router();
b2bAnalytics.get('/', auth, requireRole('admin','manager','ceo'), async (req, res) => {
  const { data: orders } = await supabase.from('b2b_orders').select('id,customer_id,total_value,stage,date,created_at').limit(5000);
  const { data: customers } = await supabase.from('b2b_customers').select('id,company_name,country,credit_limit,credit_used,active');
  const custMap = {};
  (customers||[]).forEach(c => { custMap[c.id] = c; });

  // Revenue by customer
  const byCustomer = {};
  (orders||[]).forEach(o => {
    const cid = o.customer_id;
    if (!byCustomer[cid]) byCustomer[cid] = { customer: custMap[cid], totalRevenue: 0, orderCount: 0, lastOrder: null };
    byCustomer[cid].totalRevenue += parseFloat(o.total_value||0);
    byCustomer[cid].orderCount++;
    if (!byCustomer[cid].lastOrder || o.date > byCustomer[cid].lastOrder) byCustomer[cid].lastOrder = o.date;
  });
  const topCustomers = Object.values(byCustomer).sort((a,b) => b.totalRevenue - a.totalRevenue).slice(0,10);

  // Pipeline by stage
  const pipeline = {};
  (orders||[]).forEach(o => {
    if (!['invoice_paid','delivered','cancelled'].includes(o.stage)) {
      if (!pipeline[o.stage]) pipeline[o.stage] = { count: 0, value: 0 };
      pipeline[o.stage].count++;
      pipeline[o.stage].value += parseFloat(o.total_value||0);
    }
  });

  // Monthly revenue (last 12 months)
  const monthlyMap = {};
  const now = new Date();
  (orders||[]).filter(o => o.stage !== 'cancelled').forEach(o => {
    const d = o.date || o.created_at;
    if (!d) return;
    const ym = d.slice(0,7);
    const oDate = new Date(d);
    if (now - oDate > 365 * 24 * 60 * 60 * 1000) return;
    if (!monthlyMap[ym]) monthlyMap[ym] = 0;
    monthlyMap[ym] += parseFloat(o.total_value||0);
  });
  const monthly = Object.entries(monthlyMap).sort().map(([m,v]) => ({ month: m, revenue: v }));

  // At-risk accounts (active customers with no orders in 90 days)
  const ninetyDaysAgo = new Date(Date.now() - 90*24*60*60*1000).toISOString().slice(0,10);
  const atRisk = (customers||[]).filter(c => {
    if (!c.active) return false;
    const custOrders = (orders||[]).filter(o => o.customer_id === c.id);
    if (!custOrders.length) return true;
    const lastDate = custOrders.map(o => o.date||o.created_at).sort().pop();
    return lastDate < ninetyDaysAgo;
  });

  res.json({ topCustomers, pipeline, monthly, atRisk, totals: {
    customers: (customers||[]).length,
    activeCustomers: (customers||[]).filter(c=>c.active).length,
    totalOrders: (orders||[]).length,
    totalRevenue: (orders||[]).filter(o=>o.stage!=='cancelled').reduce((s,o)=>s+parseFloat(o.total_value||0),0),
  }});
});

// POST /api/b2b/orders/:id/payment — admin records advance or remaining payment
b2bOrders.post('/:id/payment', auth, requireRole('admin','manager','ceo'), async (req, res) => {
  const { type, amount, date, ref, notes } = req.body;
  if (!['advance','remaining'].includes(type)) return res.status(400).json({ error: 'type must be advance or remaining' });
  const updates = {};
  if (type === 'advance') {
    updates.advance_paid = parseFloat(amount)||0;
    updates.advance_date = date || new Date().toISOString().slice(0,10);
    updates.advance_ref  = ref || '';
    updates.advance_notes= notes || '';
    updates.payment_status = 'advance_paid';
  } else {
    updates.remaining_paid = parseFloat(amount)||0;
    updates.remaining_date = date || new Date().toISOString().slice(0,10);
    updates.remaining_ref  = ref || '';
    updates.remaining_notes= notes || '';
    updates.payment_status = 'fully_paid';
  }
  const { data, error } = await supabase.from('b2b_orders').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: 'Payment update failed' });
  res.json(data);
  // Auto WhatsApp
  setImmediate(async () => {
    try {
      const { data: order } = await supabase.from('b2b_orders').select('order_no,customer_id,buyer_name').eq('id', req.params.id).single();
      if (!order) return;
      const { data: cust } = await supabase.from('b2b_customers').select('phone,contact_name').eq('id', order.customer_id).maybeSingle();
      const phone = cust?.phone;
      if (!phone || !process.env.BOTSAILOR_API_TOKEN) return;
      const typeLabel = type === 'advance' ? 'Advance Payment' : 'Final Payment';
      const msg = `🌿 *Sathvam Organics – Payment Received*\n\nDear ${cust?.contact_name || order.buyer_name || 'Customer'},\n\nWe have received your *${typeLabel}* of *₹${amount}* for order *${order.order_no}*.\n\nReference: ${ref || 'N/A'} · Date: ${date}\n\nThank you!\n_sathvam.in_`;
      const cleanPhone = phone.replace(/\D/g,'');
      const waPhone = cleanPhone.startsWith('91') ? cleanPhone : '91' + cleanPhone;
      await fetch(`https://app.botsailor.com/api/whatsapp-business/send-message`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.BOTSAILOR_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number_id: process.env.BOTSAILOR_PHONE_NUMBER_ID, to: waPhone, type: 'text', text: { body: msg } })
      });
    } catch(e) { console.error('[B2B-WA-PAYMENT]', e.message); }
  });
});

const b2bProfile = express.Router();
b2bProfile.put('/', auth, async (req, res) => {
  if (req.user.type !== 'b2b_customer') return res.status(403).json({ error: 'B2B customers only' });
  const c = req.body;
  const updates = {};
  if (c.contactName      !== undefined) updates.contact_name     = c.contactName;
  if (c.phone            !== undefined) updates.phone            = c.phone;
  if (c.address          !== undefined) updates.address          = c.address;
  if (c.deliveryAddress  !== undefined) updates.delivery_address = c.deliveryAddress;
  if (c.currency         !== undefined) updates.currency         = c.currency;
  const { data, error } = await supabase.from('b2b_customers').update(updates).eq('id', req.user.id).select(B2B_CUST_SELECT).single();
  if (error) return res.status(400).json({ error: 'Profile update failed' });
  res.json(data);
});

const b2bNotifications = express.Router();
b2bNotifications.get('/:customerId', auth, async (req, res) => {
  const customerId = req.params.customerId;
  if (req.user.type === 'b2b_customer' && req.user.id !== customerId) return res.status(403).json({ error: 'Access denied' });
  const { data: orders } = await supabase.from('b2b_orders')
    .select('id,order_no,stage,advance_paid,advance_date,remaining_paid,remaining_date,payment_status,b2b_order_stages(id,stage,date,note,created_at)')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(20);
  const notifications = [];
  (orders || []).forEach(order => {
    const stages = (order.b2b_order_stages || []).sort((a,b) => new Date(b.created_at||b.date) - new Date(a.created_at||a.date));
    stages.slice(0, 3).forEach(s => {
      notifications.push({ id: `stage-${s.id}`, type:'stage_change', orderId:order.id, orderNo:order.order_no, title:`Order ${order.order_no} — Updated`, body: s.note || `Stage: ${s.stage}`, stage: s.stage, date: s.created_at || s.date });
    });
    if (order.advance_date) notifications.push({ id:`adv-${order.id}`, type:'payment', orderId:order.id, orderNo:order.order_no, title:`Advance Payment Received – ${order.order_no}`, body:`₹${order.advance_paid} on ${order.advance_date}`, date: order.advance_date });
    if (order.remaining_date) notifications.push({ id:`rem-${order.id}`, type:'payment', orderId:order.id, orderNo:order.order_no, title:`Final Payment Received – ${order.order_no}`, body:`₹${order.remaining_paid} on ${order.remaining_date}`, date: order.remaining_date });
  });
  notifications.sort((a,b) => new Date(b.date) - new Date(a.date));
  res.json(notifications.slice(0, 40));
});

module.exports = { b2bCustomers, b2bOrders, projects, b2bItemProgress, b2bStatement, b2bStock, b2bCustomPrices, b2bQuotes, b2bDocs, b2bSamples, b2bMessages, b2bAnalytics, b2bProfile, b2bNotifications };
