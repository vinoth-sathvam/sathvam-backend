const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const nodemailer = require('nodemailer');
const supabase = require('../config/supabase');
const { auth, requireRole } = require('../middleware/auth');
const { createInvoice, recordPayment, zoho } = require('../config/zoho');

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// ── Reusable email helper ─────────────────────────────────────────────────────
async function sendOrderEmail(orderId, { subject, heading, rows, note, trackingUrl }) {
  try {
    const { data: order } = await supabase
      .from('b2b_orders')
      .select('order_no, customer_id, customer_name, b2b_customers(email, contact_name, company_name)')
      .eq('id', orderId).single();
    const email = order?.b2b_customers?.email;
    if (!email) return;
    const customerName = order.b2b_customers.contact_name || order.customer_name || 'Customer';
    const company = order.b2b_customers.company_name || '';
    const rowsHtml = rows.filter(r => r[1]).map(([label, value]) =>
      `<tr><td style="padding:7px 12px;color:#6b7280;font-size:13px;white-space:nowrap">${label}</td><td style="padding:7px 12px;font-weight:600;font-size:13px;color:#1f2937">${value}</td></tr>`
    ).join('');
    const trackingBtn = trackingUrl
      ? `<div style="text-align:center;margin:16px 0"><a href="${trackingUrl}" style="background:#0A4840;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">Track Shipment →</a></div>`
      : '';
    await mailer.sendMail({
      from: `"Sathvam Natural Products" <${process.env.SMTP_USER}>`,
      to: email,
      subject,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1f2937">
        <div style="background:#0A4840;padding:22px 24px;border-radius:12px 12px 0 0;text-align:center">
          <h2 style="color:#fff;margin:0;font-size:18px">${heading}</h2>
          <p style="color:#a7f3d0;margin:4px 0 0;font-size:13px">Order ${order.order_no}</p>
        </div>
        <div style="background:#f9fafb;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e5e7eb">
          <p style="margin:0 0 16px">Dear ${customerName}${company ? ` (${company})` : ''},</p>
          <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:16px">${rowsHtml}</table>
          ${note ? `<p style="margin:0 0 16px;font-size:13px;color:#374151;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px">${note}</p>` : ''}
          ${trackingBtn}
          <div style="text-align:center;margin-top:16px">
            <a href="https://admin.sathvam.in" style="background:#1d4ed8;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">View in Portal →</a>
          </div>
          <p style="margin:16px 0 0;font-size:11px;color:#9ca3af;text-align:center">Sathvam Natural Products · sathvam.in</p>
        </div>
      </div>`,
    });
  } catch (e) {
    console.error('[b2b-email]', e.message);
  }
}

const b2bCustomers = express.Router();
const B2B_CUST_SELECT = 'id,company_name,contact_name,email,country,currency,address,delivery_address,phone,gstin,pan,gst_treatment,payment_terms,active,registered_date,credit_limit,credit_used,branch';

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
  if (c.branch            !== undefined) updates.branch           = c.branch;
  const { data, error } = await supabase.from('b2b_customers').update(updates).eq('id', req.params.id).select(B2B_CUST_SELECT + ',credit_limit,credit_used').single();
  if (error) return res.status(400).json({ error: 'Update failed' });
  res.json(data);
});
b2bCustomers.post('/:id/reset-password', auth, requireRole('admin','manager'), async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const hash = await bcrypt.hash(password, 10);
  const { error } = await supabase.from('b2b_customers').update({ password: hash }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'Failed to reset password' });
  res.json({ success: true });
});

b2bCustomers.post('/', auth, requireRole('admin'), async (req, res) => {
  const c = req.body;
  const { data, error } = await supabase.from('b2b_customers').insert({
    company_name: c.companyName, contact_name: c.contactName, email: c.email,
    password: null, country: c.country, currency: c.currency||'INR',
    address: c.address, delivery_address: c.deliveryAddress||null,
    phone: c.phone, gstin: c.gstin||null, pan: c.pan||null,
    gst_treatment: c.gstTreatment||null, payment_terms: c.paymentTerms||null,
    branch: c.branch||null,
  }).select(B2B_CUST_SELECT).single();
  if (error) return res.status(400).json({ error: 'Failed to create customer', detail: error.message, code: error.code });
  res.status(201).json(data);
});

const b2bOrders = express.Router();
b2bOrders.get('/', auth, async (req, res) => {
  // B2B customers can only see their own orders
  let query = supabase.from('b2b_orders')
    .select('*, b2b_order_items(*), b2b_order_stages(*)')
    .order('created_at', { ascending: false })
    .limit(300);
  if (req.user.type === 'b2b_customer') {
    query = query.eq('customer_id', req.user.id);
  }
  const [{ data, error }, { data: pmtSettings }] = await Promise.all([
    query,
    supabase.from('settings').select('value').eq('key', 'b2b_payments').single()
  ]);
  if (error) return res.status(500).json({ error: 'Failed to load orders' });
  const payments = pmtSettings?.value || {};
  let merged = (data || []).map(o => ({ ...o, ...(payments[o.id] || {}) }));

  // Attach _invoiceVal from linked project MFG+MERCH totals for all users
  // so the portal shows accurate invoice values even when total_value is 0
  if (merged.length > 0) {
    const orderIds = merged.map(o => o.id);
    const { data: projects } = await supabase.from('projects')
      .select('id,b2b_order_id').in('b2b_order_id', orderIds);
    if (projects && projects.length > 0) {
      const projIds = projects.map(p => p.id);
      const { data: fullRows } = await supabase.from('settings')
        .select('key,value').in('key', projIds.map(id => `project_full_${id}`));
      const fullMap = {};
      (fullRows || []).forEach(r => { fullMap[r.key] = r.value; });
      const toNum = v => parseFloat(v) || 0;
      const calcItem = it => { const q = toNum(it.qty), r = toNum(it.rateINR || it.rate); return q * r; };
      // Build orderId → _invoiceVal map
      const invoiceMap = {};
      projects.forEach(proj => {
        const full = fullMap[`project_full_${proj.id}`] || {};
        const mfgItems = full.mfg?.items || [];
        const mrchItems = full.merch?.items || [];
        const mfgTotal = mfgItems.reduce((s, it) => s + (toNum(it.totalINR) || calcItem(it)), 0);
        const mrchTotal = mrchItems.reduce((s, it) => s + (toNum(it.totalINR) || calcItem(it)), 0);
        const logCharge = toNum(full.financials?.logisticsCharge);
        const otherChr = toNum(full.financials?.otherCharges);
        if ((mfgTotal + mrchTotal) > 0) {
          invoiceMap[proj.b2b_order_id] = {
            _invoiceVal: mfgTotal + mrchTotal,
            _logisticsCharge: logCharge,
            _otherCharges: otherChr,
          };
        }
      });
      merged = merged.map(o => invoiceMap[o.id] ? { ...o, ...invoiceMap[o.id] } : o);
    }
  }

  res.json(merged);
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
    await supabase.from('b2b_order_items').insert(o.items.map(i => ({ order_id:order.id, product_id:i.productId, product_name:i.productName, qty:i.qty, unit:i.unit||'pcs', unit_price:i.unitPrice, currency:i.currency||'INR', notes:i.notes||'', shipped_qty:i.shippedQty!=null?i.shippedQty:null })));
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
      qty: i.qty, unit: i.unit||'pcs', unit_price: i.unitPrice, currency: i.currency||'INR', notes: i.notes||'',
      shipped_qty: i.shippedQty!=null ? i.shippedQty : null,
    })));
  }
  await supabase.from('b2b_order_stages').insert({ order_id: req.params.id, stage: order.stage, date: new Date().toISOString().slice(0,10), note: 'Order items updated by buyer', updated_by: updatedBy||'Buyer' });
  res.json({ message: 'Items updated' });
});
// Update shipped qty per item (admin/manager only — works at any stage)
b2bOrders.patch('/:id/shipped-qtys', auth, requireRole('admin','manager'), async (req, res) => {
  const { items } = req.body; // [{ id: <item_id>, shippedQty: <number> }, ...]
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: 'items array required' });
  const errors = [];
  for (const it of items) {
    if (it.id == null) continue;
    const sq = it.shippedQty != null ? parseFloat(it.shippedQty) : null;
    const { error } = await supabase.from('b2b_order_items')
      .update({ shipped_qty: sq })
      .eq('id', it.id)
      .eq('order_id', req.params.id);
    if (error) errors.push(it.id);
  }
  if (errors.length) return res.status(500).json({ error: 'Some items failed to update', failed: errors });
  res.json({ message: 'Shipped quantities updated' });
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

  // Non-blocking: Email customer on stage change
  const stageLabels = {
    order_placed:'Order Placed', confirmed:'Order Confirmed', in_production:'In Production',
    quality_check:'Quality Check', ready_to_ship:'Ready to Ship', shipped:'Shipped',
    in_transit:'In Transit', arrived_at_port:'Arrived at Port', customs_clearance:'Customs Clearance',
    out_for_delivery:'Out for Delivery', delivered:'Delivered', invoice_sent:'Invoice Sent',
    invoice_paid:'Invoice Paid', cancelled:'Cancelled',
  };
  setImmediate(() => sendOrderEmail(req.params.id, {
    subject: `Order Update — ${stageLabels[stage] || stage}`,
    heading: `🔄 Order Status Updated`,
    rows: [
      ['New Status', stageLabels[stage] || stage],
      ['BL No', blNo],
      ['Container No', containerNo],
      ['Note', note],
    ],
    trackingUrl: carrierTrackingUrl,
  }));

  // Non-blocking: Deduct finished goods + stock_ledger when shipped
  if (stage === 'shipped') {
    setImmediate(async () => {
      try {
        const { data: orderItems } = await supabase.from('b2b_order_items').select('*').eq('order_id', req.params.id);
        const { data: orderMeta }  = await supabase.from('b2b_orders').select('order_no').eq('id', req.params.id).single();
        if (!orderItems?.length) return;
        const orderNo = orderMeta?.order_no || req.params.id;
        const today   = new Date().toISOString().slice(0, 10);

        // finished_goods OUT entries
        const fgRows = orderItems.map(i => ({
          product_name: i.product_name || 'Unknown',
          category:     'oil',
          unit:         'pcs',
          qty:          parseFloat(i.shipped_qty != null ? i.shipped_qty : i.qty) || 1,
          type:         'out',
          date:         today,
          notes:        `Auto-deducted on B2B ship — ${orderNo}`,
          batch_ref:    orderNo,
          created_by:   'system',
          created_at:   new Date().toISOString(),
          updated_at:   new Date().toISOString(),
        }));
        await supabase.from('finished_goods').insert(fgRows);

        // stock_ledger OUT entries
        const ledgerRows = orderItems
          .filter(i => i.product_id)
          .map(i => ({
            product_id:   i.product_id,
            product_name: i.product_name || 'Unknown',
            date:         today,
            type:         'out',
            qty:          parseFloat(i.shipped_qty != null ? i.shipped_qty : i.qty) || 1,
            unit:         i.unit || 'pcs',
            rate:         parseFloat(i.unit_price) || 0,
            total_value:  (parseFloat(i.shipped_qty != null ? i.shipped_qty : i.qty) || 1) * (parseFloat(i.unit_price) || 0),
            channel:      'b2b',
            reference:    orderNo,
            notes:        `Shipped — B2B ${orderNo}`,
          }));
        if (ledgerRows.length) await supabase.from('stock_ledger').insert(ledgerRows);
        console.log(`[B2B-STOCK] Deducted finished goods + stock_ledger for ${orderNo}`);
      } catch (e) { console.error('[B2B-STOCK] Deduct error:', e.message); }
    });
  }

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

  // Non-blocking: Email customer on order details update
  const changed = [];
  if (o.blNo)          changed.push(['BL No', o.blNo]);
  if (o.containerNo)   changed.push(['Container No', o.containerNo]);
  if (o.etd)           changed.push(['ETD', o.etd]);
  if (o.eta)           changed.push(['ETA', o.eta]);
  if (o.courier)       changed.push(['Courier', o.courier]);
  if (o.awbNumber)     changed.push(['AWB / Tracking No', o.awbNumber]);
  if (o.dispatchDate)  changed.push(['Dispatch Date', o.dispatchDate]);
  if (o.deliveredDate) changed.push(['Delivered Date', o.deliveredDate]);
  if (o.notes)         changed.push(['Notes', o.notes]);
  if (changed.length) {
    setImmediate(() => sendOrderEmail(req.params.id, {
      subject: `Order Details Updated`,
      heading: `📋 Order Details Updated`,
      rows: changed,
      note: null,
    }));
  }
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

  // Fetch previous state to detect meaningful changes for email
  const { data: prev } = await supabase.from('settings').select('value').eq('key', `project_full_${req.params.id}`).maybeSingle();

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

  // Non-blocking: Email customer if meaningful fields changed
  if (p.b2bOrderId) {
    const old = prev?.value || {};
    const rows = [];
    const statusLabels = { draft:'Draft', confirmed:'Confirmed', in_production:'In Production', shipped:'Shipped', delivered:'Delivered', cancelled:'Cancelled' };
    if (p.status && p.status !== old.status)                         rows.push(['Status', statusLabels[p.status] || p.status]);
    if (p.etd && p.etd !== old.etd)                                  rows.push(['ETD', p.etd]);
    if (p.blNo && p.blNo !== old.blNo)                               rows.push(['BL No', p.blNo]);
    if (p.containerNo && p.containerNo !== old.containerNo)          rows.push(['Container No', p.containerNo]);
    if (p.mfg?.invoiceNo && p.mfg.invoiceNo !== old.mfg?.invoiceNo)  rows.push(['Manufacturer Invoice', p.mfg.invoiceNo + (p.mfg.invoiceDate ? ` (${p.mfg.invoiceDate})` : '')]);
    if (p.merch?.invoiceNo && p.merch.invoiceNo !== old.merch?.invoiceNo) rows.push(['Merchandiser Invoice', p.merch.invoiceNo + (p.merch.invoiceDate ? ` (${p.merch.invoiceDate})` : '')]);
    if (p.piNo && p.piNo !== old.piNo)                               rows.push(['Proforma Invoice No', p.piNo]);
    if (rows.length) {
      setImmediate(() => sendOrderEmail(p.b2bOrderId, {
        subject: `Project Update — ${p.projectName || 'Your Order'}`,
        heading: `📦 Project Update`,
        rows,
        note: p.notes && p.notes !== old.notes ? p.notes : null,
        trackingUrl: null,
      }));
    }
  }
});

// POST — email financial summary to B2B customer
projects.post('/:id/email-summary', auth, requireRole('admin','manager','ceo'), async (req, res) => {
  try {
    // Load project index row
    const { data: proj, error: pe } = await supabase.from('projects')
      .select('id,project_name,b2b_order_id,buyer_name,status,pi_no,mfg_invoice_no,merch_invoice_no')
      .eq('id', req.params.id).single();
    if (pe || !proj) return res.status(404).json({ error: 'Project not found' });

    if (!proj.b2b_order_id) return res.status(400).json({ error: 'No linked B2B order — cannot find customer email' });

    // Load linked B2B order
    const { data: order } = await supabase.from('b2b_orders')
      .select('id,order_no,total_value,customer_id,buyer_name')
      .eq('id', proj.b2b_order_id).single();
    if (!order) return res.status(404).json({ error: 'Linked order not found' });

    // Load customer email separately
    const { data: cust } = await supabase.from('b2b_customers')
      .select('email,contact_name,company_name,currency,address,phone,country')
      .eq('id', order.customer_id).single();
    const email = cust?.email;
    if (!email) return res.status(400).json({ error: 'Customer email not found' });
    // Load b2b_payments for this order
    const { data: paymentsRow } = await supabase.from('settings').select('value').eq('key','b2b_payments').single();
    const payments = (paymentsRow?.value || {})[proj.b2b_order_id] || {};

    // Load full project blob for invoice items
    const { data: fullRow } = await supabase.from('settings').select('value').eq('key',`project_full_${proj.id}`).maybeSingle();
    const full = fullRow?.value || {};

    // Financials from request body (most current — just saved by frontend)
    const fin = req.body.financials || full.financials || {};
    // Which attachments to include (default: both)
    const sendInvoicePdf   = req.body.sendInvoicePdf   !== false;
    const sendLogisticsPdf = req.body.sendLogisticsPdf !== false;

    // Compute MFG + MERCH totals
    const toNum = v => parseFloat(v)||0;
    const mfgItems = full.mfg?.items || [];
    const mrchItems = full.merch?.items || [];
    const calcItem = it => {
      const qty = toNum(it.qty); const rate = toNum(it.rateINR||it.rate); return qty*rate;
    };
    const mfgTotal  = mfgItems.reduce((s,it)=>s+(toNum(it.totalINR)||calcItem(it)),0);
    const mrchTotal = mrchItems.reduce((s,it)=>s+(toNum(it.totalINR)||calcItem(it)),0);
    const invoiceVal = (mfgTotal+mrchTotal) > 0 ? (mfgTotal+mrchTotal) : toNum(order.total_value);
    const logCharge  = toNum(fin.logisticsCharge);
    const otherChr   = toNum(fin.otherCharges);
    const totalBill  = invoiceVal + logCharge + otherChr;

    // Advance entries
    const advEntries = (fin.advanceEntries||[]).filter(e=>toNum(e.amount)>0);
    const totalAdv   = advEntries.reduce((s,e)=>s+toNum(e.amount),0);
    const balance    = totalBill - totalAdv;

    const cur = cust?.currency || 'INR';
    const fmtINR = v => `${cur} ${v.toLocaleString('en-IN',{minimumFractionDigits:2})}`;

    function numToWords(n) {
      const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine',
        'Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
      const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
      function conv(x) {
        if(x===0) return '';
        if(x<20) return ones[x];
        if(x<100) return tens[Math.floor(x/10)]+(x%10?' '+ones[x%10]:'');
        if(x<1000) return ones[Math.floor(x/100)]+' Hundred'+(x%100?' '+conv(x%100):'');
        if(x<100000) return conv(Math.floor(x/1000))+' Thousand'+(x%1000?' '+conv(x%1000):'');
        if(x<10000000) return conv(Math.floor(x/100000))+' Lakh'+(x%100000?' '+conv(x%100000):'');
        return conv(Math.floor(x/10000000))+' Crore'+(x%10000000?' '+conv(x%10000000):'');
      }
      const r=Math.floor(n), p=Math.round((n-r)*100);
      return (conv(r)||'Zero')+' Rupees'+(p>0?' and '+conv(p)+' Paise':'')+' Only';
    }

    const advRows = advEntries.map((e,i) =>
      `<tr><td style="padding:5px 12px;color:#6b7280;font-size:12px">#${i+1} · ${e.date||''}</td><td style="padding:5px 12px;text-align:right;font-weight:700;font-size:12px;color:#d97706">${fmtINR(toNum(e.amount))}</td></tr>`
    ).join('');

    const customerName = cust.contact_name || order.buyer_name || 'Customer';
    const company = cust.company_name || '';
    const today = new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });

    // ── PDF 1: Invoice (MFG + MERCH items) ──────────────────────────────────
    const allItems = [
      ...(mfgItems.length ? [{ _header: true, label: `MFG Invoice — ${proj.mfg_invoice_no||''}` }] : []),
      ...mfgItems,
      ...(mrchItems.length ? [{ _header: true, label: `Merchandiser Invoice — ${proj.merch_invoice_no||''}` }] : []),
      ...mrchItems,
    ];
    const itemRows = allItems.map(it => {
      if (it._header) return `<tr style="background:#e8f5e9"><td colspan="6" style="padding:8px 12px;font-weight:800;font-size:12px;color:#0A4840;border-top:2px solid #0A4840">${it.label}</td></tr>`;
      const qty = toNum(it.qty); const rate = toNum(it.rateINR||it.rate); const total = toNum(it.totalINR)||qty*rate;
      return `<tr style="border-bottom:1px solid #f3f4f6">
        <td style="padding:7px 10px;font-size:11px;color:#1f2937">${it.productName||it.description||''}</td>
        <td style="padding:7px 10px;font-size:11px;color:#6b7280;text-align:center">${it.hsnCode||''}</td>
        <td style="padding:7px 10px;font-size:11px;text-align:right">${qty}</td>
        <td style="padding:7px 10px;font-size:11px;text-align:center">${it.unit||'KG'}</td>
        <td style="padding:7px 10px;font-size:11px;text-align:right">${fmtINR(rate)}</td>
        <td style="padding:7px 10px;font-size:11px;font-weight:700;text-align:right">${fmtINR(total)}</td>
      </tr>`;
    }).join('');

    const invoicePdfHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>body{font-family:Arial,sans-serif;margin:0;padding:24px;color:#1f2937}table{border-collapse:collapse}th{text-align:left}</style>
    </head><body>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;border-bottom:3px solid #0A4840;padding-bottom:16px">
      <div>
        <div style="font-size:22px;font-weight:900;color:#0A4840;letter-spacing:1px">SATHVAM NATURAL PRODUCTS</div>
        <div style="font-size:11px;color:#6b7280;margin-top:2px">Cold Pressed Oils &amp; Spices · sathvam.in</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:18px;font-weight:800;color:#1f2937">INVOICE SUMMARY</div>
        <div style="font-size:11px;color:#6b7280;margin-top:2px">Date: ${today}</div>
        <div style="font-size:11px;color:#6b7280">Order: ${order.order_no}</div>
        <div style="font-size:11px;color:#6b7280">PI: ${proj.pi_no||'—'}</div>
      </div>
    </div>
    <div style="margin-bottom:16px;padding:12px 16px;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb">
      <div style="font-weight:700;font-size:13px;color:#1f2937">${company}</div>
      <div style="font-size:12px;color:#6b7280">${customerName}</div>
    </div>
    <table style="width:100%;margin-bottom:16px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
      <thead><tr style="background:#0A4840">
        <th style="padding:9px 10px;color:#fff;font-size:11px">Product</th>
        <th style="padding:9px 10px;color:#fff;font-size:11px;text-align:center">HSN</th>
        <th style="padding:9px 10px;color:#fff;font-size:11px;text-align:right">Qty</th>
        <th style="padding:9px 10px;color:#fff;font-size:11px;text-align:center">Unit</th>
        <th style="padding:9px 10px;color:#fff;font-size:11px;text-align:right">Rate</th>
        <th style="padding:9px 10px;color:#fff;font-size:11px;text-align:right">Amount</th>
      </tr></thead>
      <tbody>${itemRows}</tbody>
      <tfoot>
        ${mfgTotal>0?`<tr style="background:#f9fafb"><td colspan="5" style="padding:8px 10px;font-size:12px;color:#374151">MFG Invoice (${proj.mfg_invoice_no||'—'})</td><td style="padding:8px 10px;text-align:right;font-weight:700;font-size:12px">${fmtINR(mfgTotal)}</td></tr>`:''}
        ${mrchTotal>0?`<tr style="background:#f9fafb"><td colspan="5" style="padding:8px 10px;font-size:12px;color:#374151">Merchandiser Invoice (${proj.merch_invoice_no||'—'})</td><td style="padding:8px 10px;text-align:right;font-weight:700;font-size:12px">${fmtINR(mrchTotal)}</td></tr>`:''}
        <tr style="background:#0A4840"><td colspan="5" style="padding:10px;font-weight:800;font-size:13px;color:#fff">TOTAL INVOICE VALUE</td><td style="padding:10px;text-align:right;font-weight:900;font-size:14px;color:#fbbf24">${fmtINR(invoiceVal)}</td></tr>
      </tfoot>
    </table>
    <div style="font-size:10px;color:#9ca3af;text-align:center;margin-top:20px">Sathvam Natural Products · sathvam.in · This is a computer-generated document.</div>
    </body></html>`;

    // ── PDF 2: Logistics Invoice (uses logisticsInvoice line items if present, else fallback) ──
    const li      = fin.logisticsInvoice || {};
    const liItems = (li.items||[]).filter(it=>it.description||(parseFloat(it.amount)||0)>0);
    const liTotal = liItems.length > 0
      ? liItems.reduce((s,it)=>s+(parseFloat(it.amount)||0),0)
      : logCharge + otherChr;
    const liInvoiceNo   = li.invoiceNo  || '';
    const liInvoiceDate = li.invoiceDate ? new Date(li.invoiceDate).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : today;

    // Build rows: use line items if available, else fallback to single logisticsCharge row
    const liRowsHtml = liItems.length > 0
      ? liItems.map((it,i)=>`<tr style="border-bottom:1px solid #f3f4f6;background:${i%2===0?'#fff':'#fafafa'}"><td style="padding:12px 14px;font-size:13px;color:#1f2937">${it.description||''}</td><td style="padding:12px 14px;text-align:right;font-weight:700;font-size:13px">₹${(parseFloat(it.amount)||0).toLocaleString('en-IN',{minimumFractionDigits:2})}</td></tr>`).join('')
      : `${logCharge>0?`<tr style="border-bottom:1px solid #f3f4f6"><td style="padding:12px 14px;font-size:13px;color:#1f2937">Logistics Charges${fin.logisticsNote?`<br><span style='font-size:11px;color:#6b7280'>${fin.logisticsNote}</span>`:''}</td><td style="padding:12px 14px;text-align:right;font-weight:700;font-size:13px">${fmtINR(logCharge)}</td></tr>`:''}
         ${otherChr>0?`<tr style="border-bottom:1px solid #f3f4f6"><td style="padding:12px 14px;font-size:13px;color:#1f2937">Other Charges</td><td style="padding:12px 14px;text-align:right;font-weight:700;font-size:13px">${fmtINR(otherChr)}</td></tr>`:''}`;

    const custAddress = cust?.address || '';
    const custPhone   = cust?.phone   || '';
    const custCountry = cust?.country || '';

    const logisticsPdfHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>
      body{font-family:Arial,sans-serif;margin:0;padding:28px 32px;color:#111827;font-size:13px}
      table{border-collapse:collapse;width:100%}
      th,td{padding:0}
    </style>
    </head><body>
    <!-- Header -->
    <table style="width:100%;margin-bottom:18px;border-bottom:3px solid #0A4840;padding-bottom:14px">
      <tr>
        <td style="vertical-align:top;width:60%">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">
            <img src="https://www.sathvam.in/logo.jpg" alt="Sathvam" style="width:56px;height:56px;border-radius:10px;object-fit:cover;border:2px solid #e5e7eb"/>
            <div style="font-size:26px;font-weight:900;color:#0A4840;letter-spacing:1px;line-height:1">Sathvam</div>
          </div>
          <div style="font-size:13px;font-weight:700;color:#1f2937;margin-top:2px">Sathvam Oils and Spices Pvt Ltd</div>
          <div style="font-size:10px;color:#6b7280;margin-top:4px;line-height:1.7">
            Plot No. 6, Anand Jothi Nagar, Near ABS Hospital, Thanthoni, Tamil Nadu 639005<br>
            GSTIN: 33ABFCS9387K1ZN | PAN: ABFCS9387K | CIN: U15400TN2021PTC142893 | TAN: CHES61531B<br>
            Ph: +91 70921 77092 | Email: sales@sathvam.in | www.sathvam.in
          </div>
        </td>
        <td style="vertical-align:top;text-align:right">
          <div style="font-size:20px;font-weight:900;color:#0A4840;letter-spacing:.5px">TAX INVOICE</div>
          <div style="margin-top:8px;font-size:11px;color:#374151;line-height:1.8">
            <strong>Invoice No:</strong> ${liInvoiceNo||'—'}<br>
            <strong>Date:</strong> ${liInvoiceDate}<br>
            <strong>Supply:</strong> ${custCountry&&custCountry.toLowerCase()!=='india'?'Export (Zero-rated)':'Inter-State'}<br>
            <strong>Order:</strong> ${order.order_no}<br>
            <strong>PI No:</strong> ${proj.pi_no||'—'}
          </div>
        </td>
      </tr>
    </table>

    <!-- Bill To -->
    <table style="width:100%;margin-bottom:18px">
      <tr>
        <td style="width:50%;vertical-align:top;padding-right:12px">
          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px">
            <div style="font-size:9px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Bill To &amp; Ship To</div>
            <div style="font-weight:700;font-size:14px;color:#111827">${company}</div>
            ${customerName?`<div style="font-size:12px;color:#374151;margin-top:2px">${customerName}</div>`:''}
            ${custAddress?`<div style="font-size:11px;color:#6b7280;margin-top:3px">${custAddress}</div>`:''}
            ${custCountry?`<div style="font-size:11px;color:#6b7280">${custCountry}</div>`:''}
            ${custPhone?`<div style="font-size:11px;color:#6b7280;margin-top:2px">Ph: ${custPhone}</div>`:''}
            ${email?`<div style="font-size:11px;color:#6b7280">Email: ${email}</div>`:''}
          </div>
        </td>
        <td style="width:50%;vertical-align:top;padding-left:12px">
          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px">
            <div style="font-size:9px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Order &amp; Payment Info</div>
            <div style="font-size:11px;color:#374151;line-height:1.8">
              <strong>Order No:</strong> ${order.order_no}<br>
              <strong>PI No:</strong> ${proj.pi_no||'—'}<br>
              <strong>MFG Invoice:</strong> ${proj.mfg_invoice_no||'—'}<br>
              <strong>Merch Invoice:</strong> ${proj.merch_invoice_no||'—'}<br>
              <strong>ETD:</strong> ${proj.etd||'—'}
            </div>
          </div>
        </td>
      </tr>
    </table>

    <!-- Line items -->
    <table style="width:100%;border:1px solid #e5e7eb;margin-bottom:0">
      <thead>
        <tr style="background:#0A4840">
          <th style="padding:9px 12px;color:#fff;font-size:11px;text-align:left;width:5%">#</th>
          <th style="padding:9px 12px;color:#fff;font-size:11px;text-align:left">Description</th>
          <th style="padding:9px 12px;color:#fff;font-size:11px;text-align:right">Amount (${cur})</th>
        </tr>
      </thead>
      <tbody>
        ${liItems.length>0
          ? liItems.map((it,i)=>`<tr style="border-bottom:1px solid #f3f4f6;background:${i%2===0?'#fff':'#fafafa'}">
              <td style="padding:10px 12px;font-size:12px;color:#6b7280">${i+1}</td>
              <td style="padding:10px 12px;font-size:13px;color:#111827">${it.description||''}</td>
              <td style="padding:10px 12px;text-align:right;font-weight:700;font-size:13px">${(parseFloat(it.amount)||0).toLocaleString('en-IN',{minimumFractionDigits:2})}</td>
            </tr>`).join('')
          : `<tr><td colspan="3" style="padding:16px 12px;text-align:center;color:#9ca3af;font-size:12px">No items</td></tr>`
        }
      </tbody>
      <tfoot>
        <tr style="background:#f9fafb;border-top:1px solid #e5e7eb">
          <td colspan="2" style="padding:10px 12px;font-size:12px;color:#374151">Taxable Amount</td>
          <td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:700">${liTotal.toLocaleString('en-IN',{minimumFractionDigits:2})}</td>
        </tr>
        <tr style="background:#f9fafb">
          <td colspan="2" style="padding:10px 12px;font-size:12px;color:#374151">GST (Export — Zero Rated)</td>
          <td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:700">0.00</td>
        </tr>
        <tr style="background:#0A4840">
          <td colspan="2" style="padding:12px;font-weight:800;font-size:13px;color:#fff">TOTAL AMOUNT</td>
          <td style="padding:12px;text-align:right;font-weight:900;font-size:15px;color:#fbbf24">${cur} ${liTotal.toLocaleString('en-IN',{minimumFractionDigits:2})}</td>
        </tr>
        <tr style="background:#f0fdf4">
          <td colspan="3" style="padding:10px 12px;font-size:12px;color:#374151;font-style:italic">
            <strong>Amount in Words:</strong> ${numToWords(liTotal)}
          </td>
        </tr>
      </tfoot>
    </table>

    <!-- Notes -->
    <div style="margin-top:18px;font-size:11px;color:#374151">
      <div><strong>Payment Terms:</strong> As per agreed terms. Goods once sold will not be taken back unless defective.</div>
      <div style="margin-top:4px"><strong>Note:</strong> This is a logistics debit note for sea freight, insurance and related charges.</div>
      <div style="margin-top:4px">Subject to: Karur Jurisdiction</div>
    </div>

    <!-- Amounts table -->
    <table style="width:60%;margin-left:40%;margin-top:18px;border:1px solid #e5e7eb">
      <tr style="background:#f9fafb"><td style="padding:7px 12px;font-size:12px;color:#6b7280">Invoice Value (MFG + MERCH)</td><td style="padding:7px 12px;text-align:right;font-weight:700;font-size:12px">${fmtINR(invoiceVal)}</td></tr>
      <tr><td style="padding:7px 12px;font-size:12px;color:#6b7280">Logistics &amp; Charges</td><td style="padding:7px 12px;text-align:right;font-weight:700;font-size:12px;color:#d97706">${fmtINR(liTotal)}</td></tr>
      <tr style="background:#0A4840"><td style="padding:8px 12px;font-weight:800;font-size:13px;color:#fff">Total Bill</td><td style="padding:8px 12px;text-align:right;font-weight:900;font-size:14px;color:#fbbf24">${fmtINR(totalBill)}</td></tr>
    </table>

    <!-- Signature -->
    <table style="width:100%;margin-top:28px">
      <tr>
        <td style="width:60%;font-size:11px;color:#374151">
          <div><strong>Payment Options:</strong></div>
          <div>UPI: sales@sathvam.in | Phone Pay / GPay: +91 70921 77092</div>
          <div>Bank Transfer: Contact us at sales@sathvam.in for bank details</div>
        </td>
        <td style="width:40%;text-align:right;vertical-align:bottom">
          <div style="font-size:11px;color:#374151">For Sathvam Oils and Spices Pvt Ltd</div>
          <div style="margin-top:30px;border-top:1px solid #9ca3af;padding-top:4px;font-size:11px;color:#374151">Authorised Signatory</div>
        </td>
      </tr>
    </table>

    <div style="font-size:9px;color:#9ca3af;text-align:center;margin-top:20px;border-top:1px solid #f3f4f6;padding-top:8px">
      Sathvam Oils and Spices Pvt Ltd · GSTIN: 33ABFCS9387K1ZN · sathvam.in · This is a computer-generated document.
    </div>
    </body></html>`;

    // Generate selected PDFs
    const htmlPdf = require('html-pdf-node');
    const pdfOpts = { format: 'A4', printBackground: true };
    const [invoicePdf, logisticsPdf] = await Promise.all([
      sendInvoicePdf   ? htmlPdf.generatePdf({ content: invoicePdfHtml },   pdfOpts) : Promise.resolve(null),
      sendLogisticsPdf ? htmlPdf.generatePdf({ content: logisticsPdfHtml }, pdfOpts) : Promise.resolve(null),
    ]);

    // ── Email body ───────────────────────────────────────────────────────────
    const emailHtml = `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;color:#1f2937">
      <div style="background:linear-gradient(135deg,#0A4840,#1A6B5E);padding:24px;border-radius:12px 12px 0 0;text-align:center">
        <h2 style="color:#fff;margin:0 0 4px;font-size:20px">💳 Financial Summary</h2>
        <p style="color:#a7f3d0;margin:0;font-size:13px">${proj.project_name||order.order_no}</p>
      </div>
      <div style="background:#f9fafb;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e5e7eb">
        <p style="margin:0 0 16px">Dear ${customerName}${company?` (${company})`:''},</p>
        <p style="margin:0 0 20px;font-size:13px;color:#374151">Please find attached two documents for your reference:</p>
        <ol style="font-size:13px;color:#374151;line-height:1.8;margin:0 0 20px">
          <li><strong>Invoice Summary</strong> — MFG (${proj.mfg_invoice_no||'—'}) + Merchandiser (${proj.merch_invoice_no||'—'}) · <strong>${fmtINR(invoiceVal)}</strong></li>
          <li><strong>Logistics Debit Note</strong> — Sea Freight &amp; related charges · <strong>${fmtINR(logCharge+otherChr)}</strong></li>
        </ol>
        <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:16px">
          <tbody>
            <tr style="background:#f9fafb"><td style="padding:9px 14px;font-size:13px;color:#6b7280">MFG + MERCH Invoice</td><td style="padding:9px 14px;text-align:right;font-weight:700;font-size:13px">${fmtINR(invoiceVal)}</td></tr>
            <tr><td style="padding:9px 14px;font-size:13px;color:#6b7280">Logistics &amp; Charges</td><td style="padding:9px 14px;text-align:right;font-weight:700;font-size:13px;color:#d97706">${fmtINR(logCharge+otherChr)}</td></tr>
            <tr style="background:#0A4840"><td style="padding:11px 14px;font-weight:800;font-size:14px;color:#fff">Total Bill Value</td><td style="padding:11px 14px;text-align:right;font-weight:900;font-size:15px;color:#fbbf24">${fmtINR(totalBill)}</td></tr>
          </tbody>
        </table>
        ${advRows?`<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:16px">
          <thead><tr style="background:#92400e"><th colspan="2" style="padding:9px 14px;color:#fff;font-size:11px;text-align:left;letter-spacing:.5px">ADVANCE PAYMENTS RECEIVED</th></tr></thead>
          <tbody>${advRows}<tr style="border-top:1px solid #e5e7eb"><td style="padding:9px 14px;font-weight:700;font-size:13px;color:#92400e">Total Advance</td><td style="padding:9px 14px;text-align:right;font-weight:800;font-size:13px;color:#d97706">${fmtINR(totalAdv)}</td></tr></tbody>
        </table>`:''}
        <div style="background:${balance>0?'#fef2f2':'#f0fdf4'};border:2px solid ${balance>0?'#fca5a5':'#86efac'};border-radius:10px;padding:14px 18px;text-align:center">
          <div style="font-size:12px;color:${balance>0?'#dc2626':'#16a34a'};font-weight:700;margin-bottom:4px">${balance>0?'AMOUNT TO RECEIVE FROM YOU':'EXCESS / CREDIT'}</div>
          <div style="font-size:22px;font-weight:900;color:${balance>0?'#dc2626':'#16a34a'}">${fmtINR(Math.abs(balance))}</div>
        </div>
        <div style="text-align:center;margin-top:20px">
          <a href="https://admin.sathvam.in/portal" style="background:#0A4840;color:#fff;padding:11px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">View in Portal →</a>
        </div>
        <p style="margin:16px 0 0;font-size:11px;color:#9ca3af;text-align:center">Sathvam Natural Products · sathvam.in</p>
      </div>
    </div>`;

    const orderRef = (order.order_no||proj.pi_no||'ORDER').replace(/[^a-zA-Z0-9-_]/g,'-');
    await mailer.sendMail({
      from: `"Sathvam Natural Products" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `Financial Summary — ${proj.project_name || order.order_no}`,
      html: emailHtml,
      attachments: [
        ...(invoicePdf   ? [{ filename: `Invoice_${orderRef}.pdf`,   content: invoicePdf,   contentType: 'application/pdf' }] : []),
        ...(logisticsPdf ? [{ filename: `Logistics_${orderRef}.pdf`, content: logisticsPdf, contentType: 'application/pdf' }] : []),
      ],
    });

    res.json({ success: true, sentTo: email });
  } catch (err) {
    console.error('[project-email-summary]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE project + all related data
projects.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  await supabase.from('project_items').delete().eq('project_id', req.params.id);
  await supabase.from('project_expenses').delete().eq('project_id', req.params.id);
  await supabase.from('projects').delete().eq('id', req.params.id);
  await supabase.from('settings').delete().eq('key', `project_full_${req.params.id}`);
  await supabase.from('settings').delete().eq('key', `project_shipping_docs_${req.params.id}`);
  res.json({ message: 'Deleted' });
});

// ── Shipping Documents (BL copy, Seaway Bill, Fumigation, Insurance, Customs) ─
const projUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const SHIP_DOC_TYPES = {
  seaway_bill:      'Seaway Bill',
  fumigation_cert:  'Fumigation Certificate',
  insurance:        'Insurance Certificate',
  customs_copy:     'Indian Customs Copy',
};

// GET — list uploaded shipping docs for a project
projects.get('/:id/shipping-docs', auth, async (req, res) => {
  const { data } = await supabase.from('settings').select('value').eq('key', `project_shipping_docs_${req.params.id}`).maybeSingle();
  res.json(data?.value || {});
});

// POST — upload a shipping document (multiple per type supported)
projects.post('/:id/shipping-docs', auth, requireRole('admin','manager'), projUpload.single('file'), async (req, res) => {
  try {
    const { type } = req.body;
    if (!SHIP_DOC_TYPES[type]) return res.status(400).json({ error: 'Invalid document type' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const fileId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const ext = req.file.originalname.split('.').pop().toLowerCase();
    const path = `shipping-docs/${req.params.id}/${type}_${fileId}.${ext}`;

    // Ensure bucket exists
    const { data: buckets } = await supabase.storage.listBuckets();
    if (!buckets?.find(b => b.name === 'documents')) {
      await supabase.storage.createBucket('documents', { public: true, fileSizeLimit: 20 * 1024 * 1024 });
    }

    const { error: upErr } = await supabase.storage.from('documents')
      .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (upErr) return res.status(500).json({ error: upErr.message });

    const { data: { publicUrl } } = supabase.storage.from('documents').getPublicUrl(path);

    const { data: existing } = await supabase.from('settings').select('value').eq('key', `project_shipping_docs_${req.params.id}`).maybeSingle();
    const docs = existing?.value || {};

    // Normalise: if old single-object format exists, convert to array
    const existing_arr = Array.isArray(docs[type]) ? docs[type]
      : docs[type] ? [docs[type]] : [];

    const newDoc = { id: fileId, label: SHIP_DOC_TYPES[type], url: publicUrl, path, fileName: req.file.originalname, uploadedAt: new Date().toISOString(), uploadedBy: req.user.name || req.user.username || 'Admin' };
    docs[type] = [...existing_arr, newDoc];

    await supabase.from('settings').upsert({ key: `project_shipping_docs_${req.params.id}`, value: docs, updated_at: new Date() });
    res.json({ success: true, doc: newDoc, files: docs[type] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE — remove a specific file by type + fileId
projects.delete('/:id/shipping-docs/:type/:fileId', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    const { type, fileId } = req.params;
    const { data: existing } = await supabase.from('settings').select('value').eq('key', `project_shipping_docs_${req.params.id}`).maybeSingle();
    const docs = existing?.value || {};
    const arr = Array.isArray(docs[type]) ? docs[type] : docs[type] ? [docs[type]] : [];
    const target = arr.find(f => f.id === fileId);
    if (target?.path) {
      await supabase.storage.from('documents').remove([target.path]);
    }
    const remaining = arr.filter(f => f.id !== fileId);
    if (remaining.length === 0) delete docs[type];
    else docs[type] = remaining;
    await supabase.from('settings').upsert({ key: `project_shipping_docs_${req.params.id}`, value: docs, updated_at: new Date() });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE — legacy: remove all files for a type (keep for backward compat)
projects.delete('/:id/shipping-docs/:type', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    const { type } = req.params;
    const { data: existing } = await supabase.from('settings').select('value').eq('key', `project_shipping_docs_${req.params.id}`).maybeSingle();
    const docs = existing?.value || {};
    const arr = Array.isArray(docs[type]) ? docs[type] : docs[type] ? [docs[type]] : [];
    for (const f of arr) {
      if (f.path) await supabase.storage.from('documents').remove([f.path]);
    }
    delete docs[type];
    await supabase.from('settings').upsert({ key: `project_shipping_docs_${req.params.id}`, value: docs, updated_at: new Date() });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

  setImmediate(() => sendOrderEmail(req.params.id, {
    subject: `Shipment Tracking Updated`,
    heading: `🚢 Shipment Tracking Updated`,
    rows: [
      ['Courier', courier],
      ['AWB / Tracking No', awbNumber],
      ['Tracking Link', carrierTrackingUrl],
    ],
    trackingUrl: carrierTrackingUrl,
  }));
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

// ── Project Docs for customer portal ─────────────────────────────────────────
// Returns the full project blob for the project linked to this B2B order,
// so the customer portal can generate Manufacturer/Merchant Invoices & Packing Lists.
b2bOrders.get('/:id/project-docs', auth, async (req, res) => {
  try {
    // Customers may only see docs for their own orders
    if (req.user.type === 'b2b_customer') {
      const { data: order } = await supabase.from('b2b_orders').select('customer_id').eq('id', req.params.id).single();
      if (!order || order.customer_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    }
    // Find the project linked to this order
    const { data: project } = await supabase.from('projects').select('id,project_name,status,mfg_invoice_no,merch_invoice_no').eq('b2b_order_id', req.params.id).maybeSingle();
    if (!project) return res.json({ project: null });
    // Return full project blob + shipping docs
    const [{ data: setting }, { data: shipDocRow }] = await Promise.all([
      supabase.from('settings').select('value').eq('key', `project_full_${project.id}`).maybeSingle(),
      supabase.from('settings').select('value').eq('key', `project_shipping_docs_${project.id}`).maybeSingle(),
    ]);
    const full = setting?.value ? { ...setting.value, id: project.id } : { id: project.id, projectName: project.project_name, status: project.status };
    full._shippingDocs = shipDocRow?.value || {};
    res.json({ project: full });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load project documents' });
  }
});

// POST /api/b2b/orders/:id/email-logistics — B2B customer requests logistics invoice PDF emailed to them
b2bOrders.post('/:id/email-logistics', auth, async (req, res) => {
  try {
    // Security: B2B customers can only email their own order
    const { data: order } = await supabase.from('b2b_orders').select('id,order_no,customer_id,buyer_name').eq('id', req.params.id).single();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (req.user.type === 'b2b_customer' && order.customer_id !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });

    const { data: cust } = await supabase.from('b2b_customers')
      .select('email,contact_name,company_name,currency,address,phone,country')
      .eq('id', order.customer_id).single();
    if (!cust?.email) return res.status(400).json({ error: 'Customer email not found' });

    const { data: proj } = await supabase.from('projects')
      .select('id,project_name,pi_no,mfg_invoice_no,merch_invoice_no,etd')
      .eq('b2b_order_id', req.params.id).maybeSingle();
    if (!proj) return res.status(404).json({ error: 'No project linked to this order' });

    const { data: fullRow } = await supabase.from('settings').select('value').eq('key', `project_full_${proj.id}`).maybeSingle();
    const full = fullRow?.value || {};
    const fin = full.financials || {};

    const toNum = v => parseFloat(v) || 0;
    const cur = cust.currency || 'INR';
    const li = fin.logisticsInvoice || {};
    const liItems = (li.items || []).filter(it => it.description || (parseFloat(it.amount) || 0) > 0);
    const liTotal = liItems.length > 0 ? liItems.reduce((s, it) => s + (parseFloat(it.amount) || 0), 0) : toNum(fin.logisticsCharge) + toNum(fin.otherCharges);
    const liInvoiceNo = li.invoiceNo || '';
    const liInvoiceDate = li.invoiceDate ? new Date(li.invoiceDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const company = cust.company_name || '';
    const customerName = cust.contact_name || order.buyer_name || '';
    const custAddress = cust.address || '';
    const custPhone = cust.phone || '';
    const custCountry = cust.country || '';
    const email = cust.email;
    const fmtINR = v => `${cur} ${v.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

    const mfgItems = full.mfg?.items || [];
    const mrchItems = full.merch?.items || [];
    const calcItem = it => { const q = toNum(it.qty), r = toNum(it.rateINR || it.rate); return q * r; };
    const mfgTotal = mfgItems.reduce((s, it) => s + (toNum(it.totalINR) || calcItem(it)), 0);
    const mrchTotal = mrchItems.reduce((s, it) => s + (toNum(it.totalINR) || calcItem(it)), 0);
    const invoiceVal = (mfgTotal + mrchTotal) > 0 ? (mfgTotal + mrchTotal) : toNum(order.total_value);

    function numToWordsLocal(n) {
      const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
      const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
      function conv(x) {
        if (x === 0) return '';
        if (x < 20) return ones[x];
        if (x < 100) return tens[Math.floor(x/10)] + (x%10 ? ' '+ones[x%10] : '');
        if (x < 1000) return ones[Math.floor(x/100)] + ' Hundred' + (x%100 ? ' '+conv(x%100) : '');
        if (x < 100000) return conv(Math.floor(x/1000)) + ' Thousand' + (x%1000 ? ' '+conv(x%1000) : '');
        if (x < 10000000) return conv(Math.floor(x/100000)) + ' Lakh' + (x%100000 ? ' '+conv(x%100000) : '');
        return conv(Math.floor(x/10000000)) + ' Crore' + (x%10000000 ? ' '+conv(x%10000000) : '');
      }
      const r = Math.floor(n), p = Math.round((n-r)*100);
      return (conv(r) || 'Zero') + ' Rupees' + (p > 0 ? ' and '+conv(p)+' Paise' : '') + ' Only';
    }

    const liRowsHtml = liItems.map((it, i) => `<tr style="border-bottom:1px solid #f3f4f6;background:${i%2===0?'#fff':'#fafafa'}">
      <td style="padding:10px 12px;font-size:12px;color:#6b7280">${i+1}</td>
      <td style="padding:10px 12px;font-size:13px;color:#111827">${it.description||''}</td>
      <td style="padding:10px 12px;text-align:right;font-weight:700;font-size:13px">${(parseFloat(it.amount)||0).toLocaleString('en-IN',{minimumFractionDigits:2})}</td>
    </tr>`).join('');

    const pdfHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>body{font-family:Arial,sans-serif;margin:0;padding:28px 32px;color:#111827;font-size:13px}table{border-collapse:collapse;width:100%}th,td{padding:0}</style>
    </head><body>
    <table style="width:100%;margin-bottom:18px;border-bottom:3px solid #0A4840;padding-bottom:14px"><tr>
      <td style="vertical-align:top;width:60%">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">
          <img src="https://www.sathvam.in/logo.jpg" alt="Sathvam" style="width:56px;height:56px;border-radius:10px;object-fit:cover;border:2px solid #e5e7eb"/>
          <div style="font-size:26px;font-weight:900;color:#0A4840;letter-spacing:1px;line-height:1">Sathvam</div>
        </div>
        <div style="font-size:13px;font-weight:700;color:#1f2937;margin-top:2px">Sathvam Oils and Spices Pvt Ltd</div>
        <div style="font-size:10px;color:#6b7280;margin-top:4px;line-height:1.7">Plot No. 6, Anand Jothi Nagar, Near ABS Hospital, Thanthoni, Tamil Nadu 639005<br>GSTIN: 33ABFCS9387K1ZN | PAN: ABFCS9387K | CIN: U15400TN2021PTC142893 | TAN: CHES61531B<br>Ph: +91 70921 77092 | Email: sales@sathvam.in | www.sathvam.in</div>
      </td>
      <td style="vertical-align:top;text-align:right">
        <div style="font-size:20px;font-weight:900;color:#0A4840;letter-spacing:.5px">TAX INVOICE</div>
        <div style="margin-top:8px;font-size:11px;color:#374151;line-height:1.8">
          <strong>Invoice No:</strong> ${liInvoiceNo||'—'}<br><strong>Date:</strong> ${liInvoiceDate}<br>
          <strong>Supply:</strong> ${custCountry&&custCountry.toLowerCase()!=='india'?'Export (Zero-rated)':'Inter-State'}<br>
          <strong>Order:</strong> ${order.order_no}<br><strong>PI No:</strong> ${proj.pi_no||'—'}
        </div>
      </td>
    </tr></table>
    <table style="width:100%;margin-bottom:18px"><tr>
      <td style="width:50%;vertical-align:top;padding-right:12px">
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px">
          <div style="font-size:9px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Bill To &amp; Ship To</div>
          <div style="font-weight:700;font-size:14px;color:#111827">${company}</div>
          ${customerName?`<div style="font-size:12px;color:#374151;margin-top:2px">${customerName}</div>`:''}
          ${custAddress?`<div style="font-size:11px;color:#6b7280;margin-top:3px">${custAddress}</div>`:''}
          ${custCountry?`<div style="font-size:11px;color:#6b7280">${custCountry}</div>`:''}
          ${custPhone?`<div style="font-size:11px;color:#6b7280;margin-top:2px">Ph: ${custPhone}</div>`:''}
          ${email?`<div style="font-size:11px;color:#6b7280">Email: ${email}</div>`:''}
        </div>
      </td>
      <td style="width:50%;vertical-align:top;padding-left:12px">
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px">
          <div style="font-size:9px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Order &amp; Payment Info</div>
          <div style="font-size:11px;color:#374151;line-height:1.8">
            <strong>Order No:</strong> ${order.order_no}<br><strong>PI No:</strong> ${proj.pi_no||'—'}<br>
            <strong>MFG Invoice:</strong> ${proj.mfg_invoice_no||'—'}<br><strong>Merch Invoice:</strong> ${proj.merch_invoice_no||'—'}<br>
            <strong>ETD:</strong> ${proj.etd||'—'}
          </div>
        </div>
      </td>
    </tr></table>
    <table style="width:100%;border:1px solid #e5e7eb;margin-bottom:0">
      <thead><tr style="background:#0A4840">
        <th style="padding:9px 12px;color:#fff;font-size:11px;text-align:left;width:5%">#</th>
        <th style="padding:9px 12px;color:#fff;font-size:11px;text-align:left">Description</th>
        <th style="padding:9px 12px;color:#fff;font-size:11px;text-align:right">Amount (${cur})</th>
      </tr></thead>
      <tbody>${liRowsHtml||'<tr><td colspan="3" style="padding:16px;text-align:center;color:#9ca3af">No items</td></tr>'}</tbody>
      <tfoot>
        <tr style="background:#f9fafb;border-top:1px solid #e5e7eb">
          <td colspan="2" style="padding:10px 12px;font-size:12px;color:#374151">Taxable Amount</td>
          <td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:700">${liTotal.toLocaleString('en-IN',{minimumFractionDigits:2})}</td>
        </tr>
        <tr style="background:#f9fafb">
          <td colspan="2" style="padding:10px 12px;font-size:12px;color:#374151">GST (Export — Zero Rated)</td>
          <td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:700">0.00</td>
        </tr>
        <tr style="background:#0A4840">
          <td colspan="2" style="padding:12px;font-weight:800;font-size:13px;color:#fff">TOTAL AMOUNT</td>
          <td style="padding:12px;text-align:right;font-weight:900;font-size:15px;color:#fbbf24">${cur} ${liTotal.toLocaleString('en-IN',{minimumFractionDigits:2})}</td>
        </tr>
        <tr style="background:#f0fdf4">
          <td colspan="3" style="padding:10px 12px;font-size:12px;color:#374151;font-style:italic"><strong>Amount in Words:</strong> ${numToWordsLocal(liTotal)}</td>
        </tr>
      </tfoot>
    </table>
    <div style="margin-top:18px;font-size:11px;color:#374151">
      <div><strong>Payment Terms:</strong> As per agreed terms.</div>
      <div style="margin-top:4px">Subject to: Karur Jurisdiction</div>
    </div>
    <table style="width:60%;margin-left:40%;margin-top:18px;border:1px solid #e5e7eb">
      <tr style="background:#f9fafb"><td style="padding:7px 12px;font-size:12px;color:#6b7280">Invoice Value (MFG + MERCH)</td><td style="padding:7px 12px;text-align:right;font-weight:700;font-size:12px">${fmtINR(invoiceVal)}</td></tr>
      <tr><td style="padding:7px 12px;font-size:12px;color:#6b7280">Logistics &amp; Charges</td><td style="padding:7px 12px;text-align:right;font-weight:700;font-size:12px;color:#d97706">${fmtINR(liTotal)}</td></tr>
    </table>
    <table style="width:100%;margin-top:28px"><tr>
      <td style="width:60%;font-size:11px;color:#374151">
        <div><strong>Payment Options:</strong></div>
        <div>UPI: sales@sathvam.in | Phone Pay / GPay: +91 70921 77092</div>
        <div>Bank Transfer: Contact us at sales@sathvam.in for bank details</div>
      </td>
      <td style="width:40%;text-align:right;vertical-align:bottom">
        <div style="font-size:11px;color:#374151">For Sathvam Oils and Spices Pvt Ltd</div>
        <div style="margin-top:30px;border-top:1px solid #9ca3af;padding-top:4px;font-size:11px;color:#374151">Authorised Signatory</div>
      </td>
    </tr></table>
    <div style="font-size:9px;color:#9ca3af;text-align:center;margin-top:20px;border-top:1px solid #f3f4f6;padding-top:8px">
      Sathvam Oils and Spices Pvt Ltd · GSTIN: 33ABFCS9387K1ZN · sathvam.in · This is a computer-generated document.
    </div></body></html>`;

    const htmlPdf = require('html-pdf-node');
    const pdfBuf = await htmlPdf.generatePdf({ content: pdfHtml }, { format: 'A4', printBackground: true });

    await mailer.sendMail({
      from: process.env.SMTP_FROM || `"Sathvam Oils and Spices" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `Logistics Invoice ${liInvoiceNo ? '#'+liInvoiceNo : ''} — Order ${order.order_no}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1f2937">
        <div style="background:linear-gradient(135deg,#0A4840,#1A6B5E);padding:24px;border-radius:12px 12px 0 0;text-align:center">
          <h2 style="color:#fff;margin:0;font-size:18px">🚢 Logistics Invoice</h2>
        </div>
        <div style="background:#f9fafb;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e5e7eb">
          <p style="margin:0 0 12px">Dear ${customerName}${company?' ('+company+')':''},</p>
          <p style="margin:0 0 16px;font-size:13px;color:#374151">Please find your logistics invoice PDF attached for order <strong>${order.order_no}</strong>.</p>
          <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:16px">
            <tr style="background:#f9fafb"><td style="padding:9px 14px;font-size:13px;color:#6b7280">Invoice No</td><td style="padding:9px 14px;text-align:right;font-weight:700;font-size:13px">${liInvoiceNo||'—'}</td></tr>
            <tr><td style="padding:9px 14px;font-size:13px;color:#6b7280">Logistics Amount</td><td style="padding:9px 14px;text-align:right;font-weight:700;font-size:13px;color:#d97706">${fmtINR(liTotal)}</td></tr>
          </table>
          <p style="margin:0;font-size:11px;color:#9ca3af">For queries, contact: sales@sathvam.in | +91 70921 77092</p>
        </div>
      </div>`,
      attachments: [{ filename: `Sathvam_Logistics_${order.order_no}_${liInvoiceNo||'INV'}.pdf`, content: pdfBuf, contentType: 'application/pdf' }],
    });

    res.json({ success: true, sentTo: email });
  } catch (err) {
    console.error('[b2b-email-logistics]', err.message);
    res.status(500).json({ error: err.message });
  }
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

  // Send email notification to customer (non-blocking)
  try {
    const { data: order } = await supabase
      .from('b2b_orders')
      .select('order_no, customer_id, customer_name, b2b_customers(email, contact_name, company_name)')
      .eq('id', req.params.orderId)
      .single();
    const email = order?.b2b_customers?.email;
    if (email) {
      const customerName = order.b2b_customers.contact_name || order.customer_name || 'Customer';
      const company = order.b2b_customers.company_name || '';
      await mailer.sendMail({
        from: `"Sathvam Natural Products" <${process.env.SMTP_USER}>`,
        to: email,
        subject: `Document Available — ${docType} for Order ${order.order_no}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1f2937">
            <div style="background:#0A4840;padding:24px;border-radius:12px 12px 0 0;text-align:center">
              <h2 style="color:#fff;margin:0;font-size:20px">📁 New Document Available</h2>
            </div>
            <div style="background:#f9fafb;padding:28px;border-radius:0 0 12px 12px;border:1px solid #e5e7eb">
              <p style="margin:0 0 16px">Dear ${customerName}${company ? ` (${company})` : ''},</p>
              <p style="margin:0 0 16px">A new document has been uploaded to your order <strong>${order.order_no}</strong>:</p>
              <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:20px">
                <p style="margin:0 0 6px"><strong>Document:</strong> ${docType}</p>
                <p style="margin:0 0 6px"><strong>File:</strong> ${fileName}</p>
                <p style="margin:0"><strong>Uploaded by:</strong> ${doc.uploadedBy}</p>
              </div>
              <div style="text-align:center;margin-bottom:20px">
                <a href="https://admin.sathvam.in" style="background:#0A4840;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">View in Portal →</a>
              </div>
              <p style="margin:0;font-size:12px;color:#9ca3af">You can download this document from the Document Vault section in your B2B portal.</p>
            </div>
          </div>`,
      });
    }
  } catch (e) {
    console.error('[b2b-docs] Email notification failed:', e.message);
  }
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

// POST /api/b2b/orders/:id/advance-claim — customer submits advance payment details (notification to admin)
b2bOrders.post('/:id/advance-claim', auth, async (req, res) => {
  if (req.user.type === 'b2b_customer' && !(await ownsOrder(req.user.id, req.params.id)))
    return res.status(403).json({ error: 'Forbidden' });
  const { amount, txnRef, date, notes } = req.body;
  if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Amount is required' });
  const SETTINGS_KEY = 'b2b_payments';
  const all = await getSettingsBlob(SETTINGS_KEY);
  const claim = { amount: parseFloat(amount), txnRef: txnRef||'', date: date||new Date().toISOString().slice(0,10), notes: notes||'', submittedAt: new Date().toISOString(), status: 'pending_verification' };
  all[req.params.id] = { ...(all[req.params.id]||{}), customer_advance_claim: claim };
  await saveSettingsBlob(SETTINGS_KEY, all);
  // WhatsApp notification to admin
  try {
    const { data: order } = await supabase.from('b2b_orders').select('order_no,b2b_customers(company_name,contact_name)').eq('id', req.params.id).single();
    const company = order?.b2b_customers?.company_name || 'Customer';
    const wa = process.env.WA_ADMIN_PHONE1||process.env.ADMIN_WHATSAPP_PHONE;
    if (wa) {
      await fetch(`${process.env.BOTSAILOR_API_URL||'https://app.botsailor.com'}/api/whatsapp/quick-message`, {
        method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${process.env.BOTSAILOR_API_TOKEN}`},
        body: JSON.stringify({ phone: wa, message: `💰 Advance Payment Claim\n${order?.order_no||req.params.id} · ${company}\nAmount: ₹${parseFloat(amount).toLocaleString('en-IN')}\nRef: ${txnRef||'—'}\nDate: ${date||'Today'}\n\nPlease verify and record the payment in the admin panel.` })
      }).catch(()=>{});
    }
  } catch(_) {}
  res.json({ ok: true, claim });
});

// POST /api/b2b/orders/:id/payment — admin records advance, remaining, or logistics payment
b2bOrders.post('/:id/payment', auth, requireRole('admin','manager','ceo'), async (req, res) => {
  const { type, amount, date, ref, notes } = req.body;
  if (!['advance','remaining','logistics'].includes(type)) return res.status(400).json({ error: 'type must be advance, remaining, or logistics' });

  // Payment data stored in settings table (key: b2b_payments) as {[orderId]: {...}}
  const SETTINGS_KEY = 'b2b_payments';
  const { data: existing } = await supabase.from('settings').select('value').eq('key', SETTINGS_KEY).single();
  const allPayments = existing?.value || {};
  const orderPayment = allPayments[req.params.id] || {};

  if (type === 'advance') {
    // Migrate legacy single-entry format to array
    if (!Array.isArray(orderPayment.advance_entries)) {
      orderPayment.advance_entries = orderPayment.advance_paid > 0
        ? [{ amount: orderPayment.advance_paid, date: orderPayment.advance_date||'', ref: orderPayment.advance_ref||'', notes: orderPayment.advance_notes||'' }]
        : [];
    }
    orderPayment.advance_entries.push({
      amount: parseFloat(amount)||0,
      date:   date || new Date().toISOString().slice(0,10),
      ref:    ref   || '',
      notes:  notes || '',
    });
    orderPayment.advance_paid  = orderPayment.advance_entries.reduce((s,e)=>s+(parseFloat(e.amount)||0), 0);
    orderPayment.advance_date  = orderPayment.advance_entries[orderPayment.advance_entries.length-1].date;
    orderPayment.advance_ref   = orderPayment.advance_entries[orderPayment.advance_entries.length-1].ref;
    orderPayment.advance_notes = orderPayment.advance_entries[orderPayment.advance_entries.length-1].notes;
    // only upgrade to advance_paid if not already fully_paid
    if (orderPayment.payment_status !== 'fully_paid') orderPayment.payment_status = 'advance_paid';
  } else if (type === 'remaining') {
    orderPayment.remaining_paid   = parseFloat(amount)||0;
    orderPayment.remaining_date   = date || new Date().toISOString().slice(0,10);
    orderPayment.remaining_ref    = ref || '';
    orderPayment.remaining_notes  = notes || '';
    orderPayment.payment_status   = 'fully_paid';
  } else {
    // logistics payment
    orderPayment.logistics_paid   = parseFloat(amount)||0;
    orderPayment.logistics_date   = date || new Date().toISOString().slice(0,10);
    orderPayment.logistics_ref    = ref || '';
    orderPayment.logistics_notes  = notes || '';
  }
  allPayments[req.params.id] = orderPayment;

  const { error } = await supabase.from('settings').upsert({ key: SETTINGS_KEY, value: allPayments });
  if (error) return res.status(400).json({ error: 'Payment update failed: ' + error.message });

  res.json({ id: req.params.id, ...orderPayment });
  // Auto WhatsApp
  setImmediate(async () => {
    try {
      const { data: order } = await supabase.from('b2b_orders').select('order_no,customer_id,buyer_name').eq('id', req.params.id).single();
      if (!order) return;
      const { data: cust } = await supabase.from('b2b_customers').select('phone,contact_name').eq('id', order.customer_id).maybeSingle();
      const phone = cust?.phone;
      if (!phone || !process.env.BOTSAILOR_API_TOKEN) return;
      const typeLabel = type === 'advance' ? 'Advance Payment' : type === 'remaining' ? 'Final Payment' : 'Logistics Payment';
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

// POST /api/b2b/orders/:id/charges — admin sets logistics_charge and other_charges on an order
b2bOrders.post('/:id/charges', auth, requireRole('admin','manager','ceo'), async (req, res) => {
  const { logistics_charge, logistics_charge_note, other_charges, other_charges_note } = req.body;
  const SETTINGS_KEY = 'b2b_payments';
  const { data: existing } = await supabase.from('settings').select('value').eq('key', SETTINGS_KEY).single();
  const allPayments = existing?.value || {};
  const orderPayment = allPayments[req.params.id] || {};

  if (logistics_charge !== undefined) orderPayment.logistics_charge      = parseFloat(logistics_charge)||0;
  if (logistics_charge_note !== undefined) orderPayment.logistics_charge_note = logistics_charge_note || '';
  if (other_charges !== undefined)     orderPayment.other_charges         = parseFloat(other_charges)||0;
  if (other_charges_note !== undefined) orderPayment.other_charges_note   = other_charges_note || '';

  allPayments[req.params.id] = orderPayment;
  const { error } = await supabase.from('settings').upsert({ key: SETTINGS_KEY, value: allPayments });
  if (error) return res.status(400).json({ error: 'Charges update failed: ' + error.message });
  res.json({ id: req.params.id, ...orderPayment });
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

// ── Helpers ──────────────────────────────────────────────────────────────
const b2bUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const B2B_DOC_BUCKET = 'b2b-docs';
async function ensureB2bBucket() {
  const { data: buckets } = await supabase.storage.listBuckets();
  if (!buckets?.find(b => b.name === B2B_DOC_BUCKET)) {
    await supabase.storage.createBucket(B2B_DOC_BUCKET, { public: true, fileSizeLimit: 10 * 1024 * 1024 });
  }
}
async function getSettingsBlob(key) {
  const { data } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
  return data?.value || {};
}
async function saveSettingsBlob(key, value) {
  await supabase.from('settings').upsert({ key, value });
}
async function ownsOrder(userId, orderId) {
  const { data } = await supabase.from('b2b_orders').select('customer_id').eq('id', orderId).single();
  return data?.customer_id === userId;
}

// ── Modification Requests ─────────────────────────────────────────────────
const b2bModRequests = express.Router();
b2bModRequests.get('/:orderId', auth, async (req, res) => {
  if (req.user.type === 'b2b_customer' && !(await ownsOrder(req.user.id, req.params.orderId)))
    return res.status(403).json({ error: 'Forbidden' });
  const all = await getSettingsBlob('b2b_mod_requests');
  res.json(all[req.params.orderId] || []);
});
b2bModRequests.post('/:orderId', auth, async (req, res) => {
  if (req.user.type === 'b2b_customer' && !(await ownsOrder(req.user.id, req.params.orderId)))
    return res.status(403).json({ error: 'Forbidden' });
  const { data: order } = await supabase.from('b2b_orders').select('stage').eq('id', req.params.orderId).single();
  if (['in_production','quality_check','ready_to_ship','shipped','sailing','delivered'].includes(order?.stage))
    return res.status(400).json({ error: 'Order is too far in production to modify' });
  const all = await getSettingsBlob('b2b_mod_requests');
  const list = all[req.params.orderId] || [];
  const newReq = { id: Date.now().toString(), date: new Date().toISOString().slice(0,10), note: req.body.note||'', status: 'pending', submittedBy: req.user.companyName || req.user.name || '' };
  list.push(newReq);
  all[req.params.orderId] = list;
  await saveSettingsBlob('b2b_mod_requests', all);
  res.json(newReq);
});
b2bModRequests.put('/:orderId/:reqId', auth, requireRole('admin','manager','ceo'), async (req, res) => {
  const all = await getSettingsBlob('b2b_mod_requests');
  const list = all[req.params.orderId] || [];
  const idx = list.findIndex(r => r.id === req.params.reqId);
  if (idx === -1) return res.status(404).json({ error: 'Request not found' });
  list[idx] = { ...list[idx], status: req.body.status || list[idx].status, adminNote: req.body.adminNote || '' };
  all[req.params.orderId] = list;
  await saveSettingsBlob('b2b_mod_requests', all);
  res.json(list[idx]);
});

// ── Cancellation Requests ─────────────────────────────────────────────────
const b2bCancelRequests = express.Router();
b2bCancelRequests.post('/:orderId', auth, async (req, res) => {
  if (req.user.type === 'b2b_customer' && !(await ownsOrder(req.user.id, req.params.orderId)))
    return res.status(403).json({ error: 'Forbidden' });
  const { data: order } = await supabase.from('b2b_orders').select('stage').eq('id', req.params.orderId).single();
  if (['delivered','cancelled'].includes(order?.stage))
    return res.status(400).json({ error: 'Cannot cancel a delivered or already-cancelled order' });
  const all = await getSettingsBlob('b2b_cancel_requests');
  all[req.params.orderId] = { date: new Date().toISOString().slice(0,10), reason: req.body.reason||'', status: 'pending', submittedBy: req.user.companyName || req.user.name || '' };
  await saveSettingsBlob('b2b_cancel_requests', all);
  res.json(all[req.params.orderId]);
});
b2bCancelRequests.put('/:orderId', auth, requireRole('admin','manager','ceo'), async (req, res) => {
  const all = await getSettingsBlob('b2b_cancel_requests');
  if (!all[req.params.orderId]) return res.status(404).json({ error: 'No cancellation request found' });
  all[req.params.orderId] = { ...all[req.params.orderId], status: req.body.status || 'pending', adminNote: req.body.adminNote || '' };
  await saveSettingsBlob('b2b_cancel_requests', all);
  if (req.body.status === 'approved') {
    await supabase.from('b2b_orders').update({ stage: 'cancelled' }).eq('id', req.params.orderId);
    await supabase.from('b2b_order_stages').insert({ order_id: req.params.orderId, stage: 'cancelled', date: new Date().toISOString().slice(0,10), note: 'Order cancelled — customer request approved', updated_by: req.user.name || 'Admin' });
  }
  res.json(all[req.params.orderId]);
});

// ── Disputes ──────────────────────────────────────────────────────────────
const b2bDisputes = express.Router();
b2bDisputes.get('/:orderId', auth, async (req, res) => {
  if (req.user.type === 'b2b_customer' && !(await ownsOrder(req.user.id, req.params.orderId)))
    return res.status(403).json({ error: 'Forbidden' });
  const all = await getSettingsBlob('b2b_disputes');
  res.json(all[req.params.orderId] || []);
});
b2bDisputes.post('/:orderId', auth, async (req, res) => {
  if (req.user.type === 'b2b_customer' && !(await ownsOrder(req.user.id, req.params.orderId)))
    return res.status(403).json({ error: 'Forbidden' });
  const all = await getSettingsBlob('b2b_disputes');
  const list = all[req.params.orderId] || [];
  const newD = { id: Date.now().toString(), date: new Date().toISOString().slice(0,10), subject: req.body.subject||'', description: req.body.description||'', status: 'open', submittedBy: req.user.companyName || req.user.name || '' };
  list.push(newD);
  all[req.params.orderId] = list;
  await saveSettingsBlob('b2b_disputes', all);
  res.json(newD);
});
b2bDisputes.put('/:orderId/:disputeId', auth, requireRole('admin','manager','ceo'), async (req, res) => {
  const all = await getSettingsBlob('b2b_disputes');
  const list = all[req.params.orderId] || [];
  const idx = list.findIndex(d => d.id === req.params.disputeId);
  if (idx === -1) return res.status(404).json({ error: 'Dispute not found' });
  list[idx] = { ...list[idx], status: req.body.status || list[idx].status, adminResponse: req.body.adminResponse || '' };
  all[req.params.orderId] = list;
  await saveSettingsBlob('b2b_disputes', all);
  res.json(list[idx]);
});

// ── Payment Proof Upload ───────────────────────────────────────────────────
const b2bPaymentProof = express.Router();
b2bPaymentProof.post('/:orderId', auth, b2bUpload.single('proof'), async (req, res) => {
  if (req.user.type === 'b2b_customer' && !(await ownsOrder(req.user.id, req.params.orderId)))
    return res.status(403).json({ error: 'Forbidden' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  const ALLOWED = { 'image/jpeg':'jpg','image/jpg':'jpg','image/png':'png','image/webp':'webp','application/pdf':'pdf' };
  const ext = ALLOWED[req.file.mimetype];
  if (!ext) return res.status(400).json({ error: 'Allowed types: jpg, png, webp, pdf' });
  await ensureB2bBucket();
  const fname = `proof-${req.params.orderId}-${Date.now()}.${ext}`;
  const { error: upErr } = await supabase.storage.from(B2B_DOC_BUCKET).upload(fname, req.file.buffer, { contentType: req.file.mimetype });
  if (upErr) return res.status(500).json({ error: 'Upload failed: ' + upErr.message });
  const { data: { publicUrl } } = supabase.storage.from(B2B_DOC_BUCKET).getPublicUrl(fname);
  const SETTINGS_KEY = 'b2b_payments';
  const all = await getSettingsBlob(SETTINGS_KEY);
  all[req.params.orderId] = { ...(all[req.params.orderId]||{}), proof_url: publicUrl, proof_filename: req.file.originalname, proof_uploaded_at: new Date().toISOString() };
  await saveSettingsBlob(SETTINGS_KEY, all);
  res.json({ proof_url: publicUrl, proof_filename: req.file.originalname });
});

// ── Customer Document Upload ───────────────────────────────────────────────
const b2bCustomerDocs = express.Router();
b2bCustomerDocs.post('/:orderId', auth, b2bUpload.single('doc'), async (req, res) => {
  if (req.user.type === 'b2b_customer' && !(await ownsOrder(req.user.id, req.params.orderId)))
    return res.status(403).json({ error: 'Forbidden' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  const ALLOWED = { 'image/jpeg':'jpg','image/jpg':'jpg','image/png':'png','image/webp':'webp','application/pdf':'pdf' };
  const ext = ALLOWED[req.file.mimetype];
  if (!ext) return res.status(400).json({ error: 'Allowed types: jpg, png, webp, pdf' });
  await ensureB2bBucket();
  const fname = `cust-doc-${req.params.orderId}-${Date.now()}.${ext}`;
  const { error: upErr } = await supabase.storage.from(B2B_DOC_BUCKET).upload(fname, req.file.buffer, { contentType: req.file.mimetype });
  if (upErr) return res.status(500).json({ error: 'Upload failed: ' + upErr.message });
  const { data: { publicUrl } } = supabase.storage.from(B2B_DOC_BUCKET).getPublicUrl(fname);
  const KEY = `b2b_cust_docs_${req.params.orderId}`;
  const all = await getSettingsBlob(KEY);
  const docs = Array.isArray(all.docs) ? all.docs : [];
  const newDoc = { id: Date.now().toString(), url: publicUrl, filename: req.file.originalname, uploadedBy: 'customer', uploadedAt: new Date().toISOString(), label: req.body.label || '' };
  docs.push(newDoc);
  await saveSettingsBlob(KEY, { docs });
  res.json(newDoc);
});
b2bCustomerDocs.get('/:orderId', auth, async (req, res) => {
  if (req.user.type === 'b2b_customer' && !(await ownsOrder(req.user.id, req.params.orderId)))
    return res.status(403).json({ error: 'Forbidden' });
  const all = await getSettingsBlob(`b2b_cust_docs_${req.params.orderId}`);
  res.json(Array.isArray(all.docs) ? all.docs : []);
});

// ── Account / Volume Tier ─────────────────────────────────────────────────
const b2bAccount = express.Router();
b2bAccount.get('/:customerId', auth, async (req, res) => {
  if (req.user.type === 'b2b_customer' && req.user.id !== req.params.customerId)
    return res.status(403).json({ error: 'Forbidden' });
  const { data: cust } = await supabase.from('b2b_customers').select('credit_limit,credit_used').eq('id', req.params.customerId).single();
  const { data: orders } = await supabase.from('b2b_orders')
    .select('id,total_value,stage,created_at,b2b_order_items(qty,unit)')
    .eq('customer_id', req.params.customerId)
    .not('stage','in','("cancelled","draft")')
    .limit(200);
  const now = new Date();
  const ms30 = 30*24*60*60*1000, ms60 = 60*24*60*60*1000, ms90 = 90*24*60*60*1000;
  let kg30=0, kg60=0, kg90=0;
  (orders||[]).forEach(o => {
    const age = now - new Date(o.created_at);
    const kgs = (o.b2b_order_items||[]).reduce((s,i)=>s+(parseFloat(i.qty)||0),0);
    if (age<=ms30) kg30+=kgs;
    if (age<=ms60) kg60+=kgs;
    if (age<=ms90) kg90+=kgs;
  });
  res.json({ creditLimit: cust?.credit_limit||0, creditUsed: cust?.credit_used||0, kg30, kg60, kg90 });
});

const b2bNotifications = express.Router();
b2bNotifications.get('/:customerId', auth, async (req, res) => {
  const customerId = req.params.customerId;
  if (req.user.type === 'b2b_customer' && req.user.id !== customerId) return res.status(403).json({ error: 'Access denied' });
  const [{ data: orders }, { data: pmtSettings }] = await Promise.all([
    supabase.from('b2b_orders')
      .select('id,order_no,stage,b2b_order_stages(id,stage,date,note,created_at)')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .limit(20),
    supabase.from('settings').select('value').eq('key', 'b2b_payments').single()
  ]);
  const payments = pmtSettings?.value || {};
  const notifications = [];
  (orders || []).forEach(order => {
    const pmt = payments[order.id] || {};
    const stages = (order.b2b_order_stages || []).sort((a,b) => new Date(b.created_at||b.date) - new Date(a.created_at||a.date));
    stages.slice(0, 3).forEach(s => {
      notifications.push({ id: `stage-${s.id}`, type:'stage_change', orderId:order.id, orderNo:order.order_no, title:`Order ${order.order_no} — Updated`, body: s.note || `Stage: ${s.stage}`, stage: s.stage, date: s.created_at || s.date });
    });
    if (pmt.advance_date) notifications.push({ id:`adv-${order.id}`, type:'payment', orderId:order.id, orderNo:order.order_no, title:`Advance Payment Received – ${order.order_no}`, body:`₹${pmt.advance_paid} on ${pmt.advance_date}`, date: pmt.advance_date });
    if (pmt.remaining_date) notifications.push({ id:`rem-${order.id}`, type:'payment', orderId:order.id, orderNo:order.order_no, title:`Final Payment Received – ${order.order_no}`, body:`₹${pmt.remaining_paid} on ${pmt.remaining_date}`, date: pmt.remaining_date });
  });
  notifications.sort((a,b) => new Date(b.date) - new Date(a.date));
  res.json(notifications.slice(0, 40));
});

// ── AI Account Summary ────────────────────────────────────────────────────────
const Anthropic = require('@anthropic-ai/sdk');
const _aiClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const b2bAiSummary = express.Router();
b2bAiSummary.post('/', auth, async (req, res) => {
  // B2B customers use sathvam_b2b cookie; admins previewing portal use sathvam_admin.
  // Accept both: b2b_customer uses their own ID; admin must pass customerId in body.
  const customerId = req.user.type === 'b2b_customer'
    ? req.user.id
    : (req.body?.customerId || null);
  if (!customerId) return res.status(400).json({ error: 'customerId required' });
  try {
    // Fetch orders + payments
    const [{ data: orders }, { data: pmtRow }, { data: cust }] = await Promise.all([
      supabase.from('b2b_orders')
        .select('id,order_no,stage,total_value,currency,created_at,b2b_order_items(product_name,qty,unit)')
        .eq('customer_id', customerId)
        .order('created_at', { ascending: false })
        .limit(20),
      supabase.from('settings').select('value').eq('key', 'b2b_payments').single(),
      supabase.from('b2b_customers').select('company_name,contact_name,country,currency').eq('id', customerId).single(),
    ]);
    const payments = pmtRow?.value || {};
    const today = new Date().toISOString().slice(0, 10);

    const orderSummaries = (orders || []).map(o => {
      const pmt = payments[o.id] || {};
      const items = (o.b2b_order_items || []).length;
      const advPaid = parseFloat(pmt.advance_paid || 0);
      const finPaid = parseFloat(pmt.remaining_paid || 0);
      const logiPaid = parseFloat(pmt.logistics_paid || 0);
      const totalPaid = advPaid + finPaid + logiPaid;
      const orderVal = parseFloat(o.total_value || 0);
      const outstanding = Math.max(0, orderVal - totalPaid);
      return {
        order_no: o.order_no,
        stage: o.stage,
        date: (o.created_at || '').slice(0, 10),
        items,
        order_value: orderVal > 0 ? `₹${orderVal.toLocaleString('en-IN')}` : 'TBD',
        advance_paid: advPaid > 0 ? `₹${advPaid.toLocaleString('en-IN')}` : 'None',
        outstanding: outstanding > 0 ? `₹${outstanding.toLocaleString('en-IN')}` : 'Nil',
        payment_status: pmt.payment_status || 'unpaid',
      };
    });

    const prompt = `You are a friendly and professional export account manager for Sathvam Natural Products Pvt Ltd, a premium cold-pressed oil and spice exporter from India.

Today is ${today}. The customer is ${cust?.company_name || 'Valued Buyer'} (${cust?.contact_name || ''}) from ${cust?.country || 'International'}.

Here are their recent B2B export orders:
${JSON.stringify(orderSummaries, null, 2)}

Write a concise, warm, and professional account summary for this customer. Include:
1. A brief greeting and overall account health (1 sentence)
2. Status of active/in-progress orders with any action items (payments due, approvals needed)
3. Any completed/delivered orders (brief mention)
4. One encouraging closing line about the business relationship

Keep it under 120 words. Use natural, friendly language — not bullet points. No markdown headers. Direct and actionable.`;

    const msg = await _aiClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });

    const summary = msg.content[0]?.text?.trim() || 'Unable to generate summary.';
    res.json({ summary, generated_at: new Date().toISOString() });
  } catch (err) {
    console.error('B2B AI summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = { b2bCustomers, b2bOrders, projects, b2bItemProgress, b2bStatement, b2bStock, b2bCustomPrices, b2bQuotes, b2bDocs, b2bSamples, b2bMessages, b2bAnalytics, b2bProfile, b2bNotifications, b2bModRequests, b2bCancelRequests, b2bDisputes, b2bPaymentProof, b2bCustomerDocs, b2bAccount, b2bAiSummary };
