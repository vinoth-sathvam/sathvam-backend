const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const nodemailer = require('nodemailer');
const supabase = require('../config/supabase');
const { uploadFile, deleteFile } = require('../config/storage');
const { auth, requireRole } = require('../middleware/auth');
const { createInvoice, recordPayment, zoho } = require('../config/zoho');
const { sendText: gaSendText } = require('../lib/greenapi');
const { insertLedger } = require('../utils/ledger');

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

  // Non-blocking: Deduct finished goods + stock_ledger when shipped (or any post-ship stage)
  // Triggers on shipped, sailing, in_transit, delivered, etc. — checks for existing deductions to avoid duplicates
  const POST_SHIP_STAGES = ['shipped','sailing','in_transit','arrived_at_port','customs_clearance','delivered'];
  if (POST_SHIP_STAGES.includes(stage)) {
    setImmediate(async () => {
      try {
        const { data: orderItems } = await supabase.from('b2b_order_items').select('*').eq('order_id', req.params.id);
        const { data: orderMeta }  = await supabase.from('b2b_orders').select('order_no').eq('id', req.params.id).single();
        if (!orderItems?.length) return;
        const orderNo = orderMeta?.order_no || req.params.id;
        const today   = new Date().toISOString().slice(0, 10);

        // Check if already deducted for this order (avoid duplicates)
        const { data: existingFG } = await supabase.from('finished_goods').select('product_name,qty').eq('type','out').eq('batch_ref', orderNo);
        const existingMap = {};
        for (const r of (existingFG || [])) existingMap[r.product_name] = (existingMap[r.product_name]||0) + parseFloat(r.qty||0);

        // Only insert items that haven't been fully deducted yet
        const fgRows = [];
        const ledgerRows = [];
        for (const i of orderItems) {
          const pname = i.product_name || 'Unknown';
          const needed = parseFloat(i.shipped_qty != null ? i.shipped_qty : i.qty) || 1;
          const already = existingMap[pname] || 0;
          const gap = needed - already;
          if (gap <= 0) continue;

          fgRows.push({
            product_name: pname, category: 'other', unit: 'pcs',
            qty: gap, type: 'out', date: today,
            notes: `Auto-deducted on B2B ${stage} — ${orderNo}`,
            batch_ref: orderNo, created_by: 'system',
            created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          });

          if (i.product_id) {
            ledgerRows.push({
              product_id: i.product_id, product_name: pname,
              date: today, type: 'out', qty: gap,
              unit: i.unit || 'pcs', rate: parseFloat(i.unit_price) || 0,
              total_value: gap * (parseFloat(i.unit_price) || 0),
              channel: 'b2b', reference: orderNo,
              notes: `${stage} — B2B ${orderNo}`,
            });
          }
        }

        if (fgRows.length) await supabase.from('finished_goods').insert(fgRows);
        if (ledgerRows.length) await supabase.from('stock_ledger').insert(ledgerRows);
        if (fgRows.length) console.log(`[B2B-STOCK] Deducted ${fgRows.length} items for ${orderNo} on ${stage}`);
      } catch (e) { console.error('[B2B-STOCK] Deduct error:', e.message); }
    });
  }

  // Non-blocking: Deduct packing materials (covers, bottles, labels, cartons) when stuffing
  if (stage === 'stuffing') {
    setImmediate(async () => {
      try {
        const { data: orderItems } = await supabase.from('b2b_order_items').select('*').eq('order_id', req.params.id);
        const { data: orderMeta }  = await supabase.from('b2b_orders').select('order_no').eq('id', req.params.id).single();
        if (!orderItems?.length) return;
        const orderNo = orderMeta?.order_no || req.params.id;
        const productIds = orderItems.map(i => i.product_id).filter(Boolean);
        if (!productIds.length) return;

        const { data: prods } = await supabase.from('products').select('id,name,packing_links,pack_size,pack_unit').in('id', productIds);
        const prodMap = {};
        for (const p of (prods || [])) prodMap[p.id] = p;

        for (const item of orderItems) {
          const prod = prodMap[item.product_id];
          const qty = parseInt(item.shipped_qty != null ? item.shipped_qty : item.qty) || 1;
          const links = prod?.packing_links || {};
          const matIds = [
            ...(Array.isArray(links.materialIds) ? links.materialIds : [links.coverId, links.bottleId].filter(Boolean)),
            links.labelId,
          ].filter(Boolean);

          // Deduct covers, bottles, labels (1:1 per unit)
          for (const matId of matIds) {
            const { data: mat } = await supabase.from('packing_materials').select('id,current_stock').eq('id', matId).single();
            if (!mat) continue;
            const newStock = Math.max(0, (parseFloat(mat.current_stock) || 0) - qty);
            await supabase.from('packing_materials').update({ current_stock: newStock, updated_at: new Date().toISOString() }).eq('id', matId);
            await supabase.from('packing_audit_log').insert({ material_id: matId, audit_date: new Date().toISOString().slice(0,10), quantity: newStock, previous_qty: mat.current_stock, audited_by: 'auto-deduct', notes: `B2B stuffing — ${orderNo} — ${item.product_name} × ${qty}` });
          }

          // Deduct carton boxes (qty / perCarton)
          if (links.cartonId) {
            const perCarton = parseInt(links.perCarton) || 12;
            const cartonQty = Math.ceil(qty / perCarton);
            const { data: mat } = await supabase.from('packing_materials').select('id,current_stock').eq('id', links.cartonId).single();
            if (mat) {
              const newStock = Math.max(0, (parseFloat(mat.current_stock) || 0) - cartonQty);
              await supabase.from('packing_materials').update({ current_stock: newStock, updated_at: new Date().toISOString() }).eq('id', links.cartonId);
              await supabase.from('packing_audit_log').insert({ material_id: links.cartonId, audit_date: new Date().toISOString().slice(0,10), quantity: newStock, previous_qty: mat.current_stock, audited_by: 'auto-deduct', notes: `B2B carton — ${orderNo} — ${item.product_name} × ${qty} (${cartonQty} cartons @ ${perCarton}/ctn)` });
            }
          }
        }
        console.log(`[B2B-PACK] Packing materials + cartons deducted for ${orderNo}`);
      } catch (e) { console.error('[B2B-PACK] Deduct error:', e.message); }
    });
  }

  // Non-blocking: Auto WhatsApp to buyer on stage change
  setImmediate(async () => {
    try {
      const { data: order } = await supabase.from('b2b_orders').select('order_no,customer_id,buyer_name').eq('id', req.params.id).single();
      if (!order) return;
      const { data: cust } = await supabase.from('b2b_customers').select('phone,contact_name,company_name').eq('id', order.customer_id).maybeSingle();
      const phone = cust?.phone;
      if (!phone) return;
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
      await gaSendText(phone, msg);
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
            Ph: +91 70923 77092 | Email: sales@sathvam.in | www.sathvam.in
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
          <div>UPI: sales@sathvam.in | Phone Pay / GPay: +91 70923 77092</div>
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

// ── Email docs to logistics vendor ────────────────────────────────────────────
projects.post('/:id/email-logistics-vendor', auth, requireRole('admin','manager','ceo'), async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const { data: proj } = await supabase.from('projects')
      .select('id,project_name,b2b_order_id,buyer_name,pi_no,mfg_invoice_no,merch_invoice_no')
      .eq('id', req.params.id).single();
    if (!proj) return res.status(404).json({ error: 'Project not found' });

    // Load full project data
    const { data: fullRow } = await supabase.from('settings').select('value').eq('key', `project_full_${req.params.id}`).single();
    const full = fullRow?.value || {};
    const logistics = full.logistics || {};
    const financials = full.financials || {};

    // Determine recipients
    const extraEmails = (req.body.emails || '').split(',').map(e=>e.trim()).filter(Boolean);
    const vendorEmail = logistics.vendorEmail || '';
    const allEmails = [...new Set([vendorEmail, ...extraEmails].filter(Boolean))];
    if (!allEmails.length) return res.status(400).json({ error: 'No logistics vendor email configured. Set it in Logistics Vendor section.' });

    // Load B2B order for buyer info
    let buyerName = proj.buyer_name || full.buyerName || '';
    let orderNo = '';
    if (proj.b2b_order_id) {
      const { data: ord } = await supabase.from('b2b_orders').select('order_no,buyer_name').eq('id', proj.b2b_order_id).single();
      if (ord) { orderNo = ord.order_no; buyerName = buyerName || ord.buyer_name; }
    }

    // Collect items & packing data
    const mfgItems = (full.mfg?.items || []).filter(i => i.product);
    const merchItems = (full.merch?.items || []).filter(i => i.product);
    const boxes = full.packingBoxes || [];
    const totalPcs = boxes.reduce((s,b) => s + (b.products||[]).reduce((s2,pr) => s2 + (Number(pr.qty)||1), 0), 0);
    const totalGross = boxes.reduce((s,b) => s + (parseFloat(b.grossWt)||0), 0);
    const totalNet = boxes.reduce((s,b) => s + (parseFloat(b.netWt)||0), 0);

    // ── Shipper address lookup ──
    const SHIPPER_ADDR = {
      A: { name: 'SATHVAM OILS AND SPICES PVT LTD', addr: 'PLOT NO:6, ANAND JOTHI NAGAR, near ABS HOSPITAL, Thanthoni, Tamil Nadu 639005' },
      B: { name: 'SATHVAM OILS AND SPICES PVT LTD', addr: '366 B AMARJOTHI GARDEN 2ND CROSS, GANDHIGRAMAM, KARUR, Tamil Nadu 639004' },
    };
    const getShipper = (inv) => {
      if (inv?.shipperOption === 'custom' && inv?.shipperName) return { name: inv.shipperName, addr: (inv.shipperAddress || '').replace(/\n/g, ', ') };
      return SHIPPER_ADDR[inv?.shipperOption] || SHIPPER_ADDR.B;
    };
    const COMPANY_INFO = { gst: '33ABFCS9387K1ZN', iec: 'ABFCS9387K', cin: 'U15400TN2021PTC142893', pan: 'ABFCS9387K', tan: 'CHES61531B', mob: '+917092177092', email: 'SALES@SATHVAM.IN' };

    // ── Helper: style constants ──
    const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A4840' } };
    const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    const SUBHEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    const BORDER_THIN = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
    const NUM_FMT_INR = '#,##0.00';

    // ── Generate Invoice Excel (MFG or MERCH) ──
    async function buildInvoiceExcel(inv, type) {
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Sathvam Export';
      wb.created = new Date();
      const ws = wb.addWorksheet(`${type} Invoice`);
      ws.columns = [
        { width: 5 }, { width: 30 }, { width: 12 }, { width: 8 }, { width: 10 }, { width: 14 }, { width: 12 }, { width: 14 },
      ];

      const shipper = getShipper(inv);
      const items = (inv?.items || []).filter(i => i.product);

      // Title row
      const titleRow = ws.addRow([`EXPORT INVOICE — ${type}`]);
      ws.mergeCells(titleRow.number, 1, titleRow.number, 8);
      titleRow.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF0A4840' } };
      titleRow.getCell(1).alignment = { horizontal: 'center' };
      titleRow.height = 28;

      // Exporter info
      ws.addRow([]);
      const expRow = ws.addRow(['', 'Exporter / Shipper:', shipper.name]);
      expRow.getCell(2).font = { bold: true, size: 10, color: { argb: 'FF6B7280' } };
      expRow.getCell(3).font = { bold: true, size: 11 };
      ws.addRow(['', '', shipper.addr]);
      ws.addRow(['', '', `GST: ${COMPANY_INFO.gst}  |  IEC: ${COMPANY_INFO.iec}`]);
      ws.addRow(['', '', `PAN: ${COMPANY_INFO.pan}  |  CIN: ${COMPANY_INFO.cin}`]);

      // Invoice details
      ws.addRow([]);
      ws.addRow(['', 'Invoice No:', inv?.invoiceNo || '—', '', 'Invoice Date:', inv?.invoiceDate || '—']);
      ws.addRow(['', 'PI / Ref No:', inv?.piNo || full.piNo || '—', '', 'PI Date:', inv?.piDate || '—']);
      ws.addRow(['', 'Buyer:', buyerName, '', 'Destination:', full.portOfDischarge || full.buyerCountry || '—']);
      ws.addRow(['', 'Buyer Address:', full.buyerAddress || '—']);
      ws.addRow(['', 'Country of Origin:', 'INDIA', '', 'Country of Dest:', full.buyerCountry || '—']);
      ws.addRow(['', 'Port of Loading:', full.portOfLoading || '—', '', 'Port of Discharge:', full.portOfDischarge || '—']);
      ws.addRow(['', 'Terms:', full.terms || full.paymentTerms || 'CIF', '', 'LUT ARN:', full.lutArn || '—']);
      for (let r = 8; r <= 14; r++) { ws.getRow(r).getCell(2).font = { bold: true, size: 10, color: { argb: 'FF6B7280' } }; }

      // Items table header
      ws.addRow([]);
      const hdr = ws.addRow(['S.No', 'Product Description', 'HSN Code', 'Qty', 'Pack Size', 'Unit Price (₹)', 'Weight (kg)', 'Total (₹)']);
      hdr.eachCell(c => { c.fill = HEADER_FILL; c.font = HEADER_FONT; c.border = BORDER_THIN; c.alignment = { horizontal: 'center', vertical: 'middle' }; });
      hdr.height = 22;

      // Items
      let totalQty = 0, totalWt = 0, totalVal = 0;
      items.forEach((it, idx) => {
        const qty = Number(it.qty) || 0;
        const unitPrice = Number(it.unitPriceINR) || 0;
        const wt = Number(it.weightKg) || 0;
        const total = Number(it.totalINR) || (qty * unitPrice);
        totalQty += qty; totalWt += wt; totalVal += total;
        const row = ws.addRow([idx + 1, it.exportName || it.product, it.hsnCode || '', qty, `${it.packSize || ''} ${it.packUnit || ''}`, unitPrice, wt, total]);
        row.eachCell(c => { c.border = BORDER_THIN; });
        row.getCell(1).alignment = { horizontal: 'center' };
        row.getCell(4).alignment = { horizontal: 'center' };
        row.getCell(5).alignment = { horizontal: 'center' };
        row.getCell(6).numFmt = NUM_FMT_INR;
        row.getCell(8).numFmt = NUM_FMT_INR;
      });

      // Totals
      const totRow = ws.addRow(['', 'TOTAL', '', totalQty, '', '', totalWt.toFixed(2), totalVal]);
      totRow.eachCell(c => { c.fill = SUBHEADER_FILL; c.font = { bold: true }; c.border = BORDER_THIN; });
      totRow.getCell(7).numFmt = '#,##0.000';
      totRow.getCell(8).numFmt = NUM_FMT_INR;

      // Footer
      ws.addRow([]);
      ws.addRow(['', 'For SATHVAM OILS AND SPICES PVT LTD']);
      ws.addRow(['', 'Authorised Signatory']);

      return wb.xlsx.writeBuffer();
    }

    // ── Generate Packing List Excel ──
    async function buildPackingListExcel() {
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Sathvam Export';
      wb.created = new Date();
      const ws = wb.addWorksheet('Packing List');
      ws.columns = [
        { width: 10 }, { width: 30 }, { width: 12 }, { width: 8 }, { width: 10 }, { width: 12 }, { width: 12 }, { width: 20 },
      ];

      // Title
      const titleRow = ws.addRow(['COMBINED PACKING LIST']);
      ws.mergeCells(titleRow.number, 1, titleRow.number, 8);
      titleRow.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF0A4840' } };
      titleRow.getCell(1).alignment = { horizontal: 'center' };
      titleRow.height = 28;

      // Shipment info
      ws.addRow([]);
      ws.addRow(['', 'Exporter:', 'SATHVAM OILS AND SPICES PVT LTD']);
      ws.addRow(['', 'Buyer:', buyerName]);
      ws.addRow(['', 'MFG Invoice:', full.mfg?.invoiceNo || '—', '', 'MERCH Invoice:', full.merch?.invoiceNo || '—']);
      ws.addRow(['', 'Port of Loading:', full.portOfLoading || '—', '', 'Port of Discharge:', full.portOfDischarge || '—']);
      ws.addRow(['', `Total: ${boxes.length} boxes/sacks  |  ${totalPcs} pcs  |  Gross: ${totalGross.toFixed(2)} kg  |  Net: ${totalNet.toFixed(2)} kg`]);
      for (let r = 3; r <= 7; r++) { ws.getRow(r).getCell(2).font = { bold: true, size: 10, color: { argb: 'FF6B7280' } }; }

      ws.addRow([]);

      // Table header
      const hdr = ws.addRow(['Box / Sack', 'Product Description', 'Pack Size', 'Qty (pcs)', 'HSN Code', 'Gross Wt (kg)', 'Net Wt (kg)', 'Notes']);
      hdr.eachCell(c => { c.fill = HEADER_FILL; c.font = HEADER_FONT; c.border = BORDER_THIN; c.alignment = { horizontal: 'center', vertical: 'middle' }; });
      hdr.height = 22;

      // Rows from packingBoxes
      let runningGross = 0, runningNet = 0, runningPcs = 0;
      if (boxes.length > 0) {
        boxes.forEach((box, bi) => {
          const label = box.num || (box.type === 'sack' ? `S${bi+1}` : `B${bi+1}`);
          const prods = box.products || [];
          const grossWt = parseFloat(box.grossWt) || 0;
          const netWt = parseFloat(box.netWt) || 0;
          runningGross += grossWt; runningNet += netWt;
          if (prods.length === 0) {
            const row = ws.addRow([label, '—', '', '', '', grossWt || '', netWt || '', box.note || '']);
            row.eachCell(c => { c.border = BORDER_THIN; });
          } else {
            prods.forEach((pr, pi) => {
              const pQty = Number(pr.qty) || 1;
              runningPcs += pQty;
              // Find HSN from invoice items
              const allItems = [...mfgItems, ...merchItems];
              const matchItem = allItems.find(it => (it.exportName||it.product||'').toLowerCase() === (pr.name||'').toLowerCase());
              const row = ws.addRow([
                pi === 0 ? label : '',
                pr.name || '',
                pr.packSize ? `${pr.packSize} ${pr.packUnit || ''}` : '',
                pQty,
                matchItem?.hsnCode || '',
                pi === 0 ? (grossWt || '') : '',
                pi === 0 ? (netWt || '') : '',
                pi === 0 ? (box.note || '') : '',
              ]);
              row.eachCell(c => { c.border = BORDER_THIN; });
              row.getCell(1).alignment = { horizontal: 'center' };
              row.getCell(4).alignment = { horizontal: 'center' };
              if (prods.length > 1 && pi === 0) {
                row.getCell(1).font = { bold: true, color: { argb: 'FFD97706' } }; // mixed box highlight
              }
            });
          }
        });
      } else {
        // Fallback: auto-generate from invoice items (same as frontend buildPackingList)
        const allItems = [...mfgItems, ...merchItems];
        let boxNo = 1, sackNo = 1;
        allItems.forEach(it => {
          const qty = Number(it.qty) || 0;
          const perBox = Number(it.qtyPerBox) || 12;
          const type = it.cartonType || 'box';
          let remaining = qty;
          while (remaining > 0) {
            const count = Math.min(remaining, perBox);
            const label = type === 'sack' ? `S${sackNo++}` : `B${boxNo++}`;
            let netWt = Number(it.netWtPerBox) || 0;
            if (!netWt && it.packSize) {
              const ps = Number(it.packSize) || 0;
              if (it.packUnit === 'GM' || it.packUnit === 'ML') netWt = parseFloat((count * ps / 1000).toFixed(3));
              else netWt = parseFloat((count * ps).toFixed(3));
            }
            const grossWt = Number(it.grossWtPerBox) || (netWt ? parseFloat((netWt * 1.05).toFixed(3)) : 0);
            runningGross += grossWt; runningNet += netWt; runningPcs += count;
            const row = ws.addRow([label, it.exportName || it.product, `${it.packSize||''} ${it.packUnit||''}`, count, it.hsnCode || '', grossWt || '', netWt || '', '']);
            row.eachCell(c => { c.border = BORDER_THIN; });
            remaining -= count;
          }
        });
      }

      // Totals
      const totRow = ws.addRow(['TOTAL', '', '', runningPcs, '', runningGross.toFixed(2), runningNet.toFixed(2), '']);
      totRow.eachCell(c => { c.fill = SUBHEADER_FILL; c.font = { bold: true }; c.border = BORDER_THIN; });

      ws.addRow([]);
      ws.addRow(['', 'For SATHVAM OILS AND SPICES PVT LTD']);
      ws.addRow(['', 'Authorised Signatory']);

      return wb.xlsx.writeBuffer();
    }

    // ── Generate all 3 Excel files ──
    const [mfgBuffer, merchBuffer, packingBuffer] = await Promise.all([
      mfgItems.length > 0 ? buildInvoiceExcel(full.mfg, 'MFG') : null,
      merchItems.length > 0 ? buildInvoiceExcel(full.merch, 'MERCH') : null,
      buildPackingListExcel(),
    ]);

    const safeName = (s) => (s || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const prefix = safeName(proj.project_name || orderNo || 'Export');
    const attachments = [];
    if (mfgBuffer) attachments.push({ filename: `${prefix}_MFG_Invoice.xlsx`, content: Buffer.from(mfgBuffer), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    if (merchBuffer) attachments.push({ filename: `${prefix}_MERCH_Invoice.xlsx`, content: Buffer.from(merchBuffer), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    attachments.push({ filename: `${prefix}_Packing_List.xlsx`, content: Buffer.from(packingBuffer), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

    // ── Build email body ──
    const itemList = [...mfgItems, ...merchItems].map(it =>
      `<tr><td style="border:1px solid #e5e7eb;padding:6px 10px;font-size:13px">${it.exportName||it.product||''}</td>` +
      `<td style="border:1px solid #e5e7eb;padding:6px 10px;text-align:center;font-size:13px">${it.packSize||''} ${it.packUnit||''}</td>` +
      `<td style="border:1px solid #e5e7eb;padding:6px 10px;text-align:center;font-size:13px">${it.qty||''}</td>` +
      `<td style="border:1px solid #e5e7eb;padding:6px 10px;font-size:13px">${it.hsnCode||''}</td></tr>`
    ).join('');

    const emailHtml = `
      <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto">
        <div style="background:#0A4840;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0">
          <h2 style="margin:0;font-size:18px">📦 Export Documents — ${proj.project_name || orderNo}</h2>
          <p style="margin:4px 0 0;font-size:13px;color:#a7f3d0">From SATHVAM OILS AND SPICES PVT LTD</p>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;padding:20px 24px;border-radius:0 0 8px 8px">
          <p style="color:#374151;font-size:14px">Dear ${logistics.vendorName || 'Logistics Team'},</p>
          <p style="color:#374151;font-size:14px">Please find attached the invoice and packing list for the upcoming shipment.</p>

          <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
            <tr><td style="padding:6px 0;color:#6b7280;width:160px"><strong>Project / Order</strong></td><td style="color:#111827;font-weight:600">${proj.project_name||''} ${orderNo?'('+orderNo+')':''}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280"><strong>Buyer / Consignee</strong></td><td style="color:#111827">${buyerName}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280"><strong>Destination</strong></td><td style="color:#111827">${full.portOfDischarge||full.buyerCountry||''}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280"><strong>MFG Invoice</strong></td><td style="color:#111827">${full.mfg?.invoiceNo||'—'} (${mfgItems.length} items)</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280"><strong>MERCH Invoice</strong></td><td style="color:#111827">${full.merch?.invoiceNo||'—'} (${merchItems.length} items)</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280"><strong>Total Boxes/Sacks</strong></td><td style="color:#111827">${boxes.length} (${totalPcs} pcs)</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280"><strong>Gross / Net Weight</strong></td><td style="color:#111827">${totalGross.toFixed(2)} kg / ${totalNet.toFixed(2)} kg</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280"><strong>Port of Loading</strong></td><td style="color:#111827">${full.portOfLoading||'—'}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280"><strong>Terms</strong></td><td style="color:#111827">${full.terms||full.paymentTerms||'CIF'}</td></tr>
          </table>

          <h3 style="color:#1f2937;font-size:14px;margin:20px 0 8px;border-bottom:2px solid #0A4840;padding-bottom:6px">Product Summary</h3>
          <table style="width:100%;border-collapse:collapse">
            <tr style="background:#f1f5f9"><th style="border:1px solid #d1d5db;padding:8px 10px;text-align:left;font-size:12px">Product</th><th style="border:1px solid #d1d5db;padding:8px 10px;text-align:center;font-size:12px">Pack Size</th><th style="border:1px solid #d1d5db;padding:8px 10px;text-align:center;font-size:12px">Qty</th><th style="border:1px solid #d1d5db;padding:8px 10px;font-size:12px">HSN</th></tr>
            ${itemList}
          </table>

          <p style="margin-top:20px;color:#374151;font-size:14px"><strong>Attached documents (Excel):</strong></p>
          <ul style="color:#374151;font-size:13px">
            ${mfgItems.length > 0 ? '<li>📊 MFG Export Invoice (.xlsx)</li>' : ''}
            ${merchItems.length > 0 ? '<li>📊 MERCH Export Invoice (.xlsx)</li>' : ''}
            <li>📊 Combined Packing List (.xlsx)</li>
          </ul>

          <p style="color:#374151;font-size:14px">Please review and confirm receipt. If any corrections are needed, reply to this email with the details and we will send the revised documents.</p>

          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb">
            <p style="margin:0;font-weight:700;color:#0A4840;font-size:13px">SATHVAM OILS AND SPICES PVT LTD</p>
            <p style="margin:2px 0 0;color:#6b7280;font-size:12px">GST: 33ABFCS9387K1ZN | IEC: ABFCS9387K</p>
            <p style="margin:2px 0 0;color:#6b7280;font-size:12px">MOB: +917092177092 | EMAIL: SALES@SATHVAM.IN</p>
          </div>
        </div>
      </div>`;

    // ── Send email with Excel attachments ──
    const nodemailer = require('nodemailer');
    const mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '465'),
      secure: process.env.SMTP_PORT !== '587',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const subject = `Invoice & Packing List — ${proj.project_name||orderNo} — ${buyerName} [${full.mfg?.invoiceNo||''}${full.merch?.invoiceNo?', '+full.merch.invoiceNo:''}]`;

    await mailer.sendMail({
      from: process.env.SMTP_FROM || `"Sathvam Export" <${process.env.SMTP_USER}>`,
      to: allEmails.join(', '),
      replyTo: process.env.SMTP_USER,
      subject,
      html: emailHtml,
      attachments,
    });

    // Record in project data
    const sentRecord = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
      date: new Date().toISOString(),
      to: allEmails,
      subject,
      sentBy: req.user?.name || req.user?.username || 'admin',
      type: 'docs_to_logistics',
      attachmentCount: attachments.length,
    };
    const emailLog = full._emailLog || [];
    emailLog.push(sentRecord);
    full._emailLog = emailLog;

    // Update logistics.docsSentDate
    full.logistics = { ...(full.logistics || {}), docsSentDate: new Date().toISOString().slice(0, 10) };
    await supabase.from('settings').upsert({ key: `project_full_${req.params.id}`, value: full });

    res.json({ success: true, sentTo: allEmails.join(', '), record: sentRecord });
  } catch (err) {
    console.error('[email-logistics-vendor]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Logistics Email Thread (IMAP fetch + cache) ──────────────────────────────

projects.get('/:id/email-thread', auth, requireRole('admin','manager','ceo'), async (req, res) => {
  try {
    const { data: projRow } = await supabase.from('projects').select('*').eq('id', req.params.id).single();
    if (!projRow) return res.status(404).json({ error: 'Project not found' });
    const { data: fullRow } = await supabase.from('settings').select('value').eq('key', `project_full_${req.params.id}`).maybeSingle();
    const full = fullRow?.value || {};

    // Return cached thread if fresh (< 5 min) and not force-refresh
    const cache = full._emailThreadCache;
    if (cache && !req.query.refresh && (Date.now() - new Date(cache.fetchedAt).getTime()) < 5 * 60 * 1000) {
      return res.json({ emails: cache.emails, cached: true, fetchedAt: cache.fetchedAt });
    }

    // Build search addresses — logistics vendor + known logistics contacts + email log recipients
    const logisticsEmail = (full.logistics?.vendorEmail || '').trim();
    const knownLogistics = [
      'dta@ilogisolutions.com', 'docscjb@ilogisolutions.com', 'suresh@ilogisolutions.com',
      'muraly@ilogisolutions.com', 'opscjb@ilogisolutions.com', 'cs@ilogisolutions.com',
      'charles@ilogisolutions.com',
    ];
    // Also include any emails from the send log (covers test sends + ad-hoc recipients)
    const logEmails = (full._emailLog || []).flatMap(l => [...(l.to || []), ...(l.cc || [])]);
    const searchAddrs = [...new Set([logisticsEmail, ...knownLogistics, ...logEmails].filter(Boolean).map(e => e.toLowerCase().trim()))];
    if (!searchAddrs.length) return res.json({ emails: [], cached: false, error: 'No logistics email configured' });

    // Build search keywords from project identifiers
    const keywords = [
      projRow.project_name, full.mfg?.invoiceNo, full.merch?.invoiceNo,
      full.mfg?.piNo, projRow.bl_no,
    ].filter(Boolean).map(k => k.trim()).filter(k => k.length > 2);

    const { ImapFlow } = require('imapflow');
    const { simpleParser } = require('mailparser');
    const imapConfig = {
      host: process.env.IMAP_HOST || 'imap.gmail.com',
      port: parseInt(process.env.IMAP_PORT || '993'),
      secure: true,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      logger: false,
    };

    const emails = [];
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // last 90 days
    const MAX_EMAILS = 20;

    // Helper to fetch from a mailbox — uses IMAP server-side subject search (fast)
    async function fetchFromMailbox(client, mailbox, direction) {
      let lock;
      try {
        lock = await client.getMailboxLock(mailbox);
        // Use IMAP server-side search: address + subject keyword (instant, no download needed)
        const allUids = new Set();
        for (const addr of searchAddrs) {
          for (const kw of (keywords.length ? keywords : [''])) {
            const criteria = direction === 'received'
              ? { from: addr, since, ...(kw ? { subject: kw } : {}) }
              : { to: addr, since, ...(kw ? { subject: kw } : {}) };
            try {
              const uids = await client.search(criteria, { uid: true });
              if (uids?.length) uids.slice(-10).forEach(u => allUids.add(u));
            } catch (se) { /* skip */ }
            if (allUids.size >= MAX_EMAILS) break;
          }
          if (allUids.size >= MAX_EMAILS) break;
        }
        if (!allUids.size) return;

        // Sort descending (newest first), download only matched emails
        const sortedUids = [...allUids].sort((a, b) => b - a).slice(0, MAX_EMAILS);

        for (const uid of sortedUids) {
          if (emails.length >= MAX_EMAILS) break;
          try {
            const dl = await client.download(uid.toString(), undefined, { uid: true });
            const chunks = [];
            let total = 0;
            for await (const chunk of dl.content) {
              chunks.push(chunk);
              total += chunk.length;
              if (total > 512000) break; // cap at 500KB per email
            }
            const source = Buffer.concat(chunks);
            if (!source.length) continue;
            const parsed = await simpleParser(source);
            const subject = parsed.subject || '(no subject)';

            // Keyword filter on subject
            if (keywords.length > 0) {
              const subjectLower = subject.toLowerCase();
              if (!keywords.some(kw => subjectLower.includes(kw.toLowerCase()))) continue;
            }

            emails.push({
              id: `${mailbox}-${uid}`,
              uid,
              messageId: parsed.messageId,
              inReplyTo: parsed.inReplyTo,
              from: parsed.from?.text || '',
              to: parsed.to?.text || '',
              cc: parsed.cc?.text || '',
              subject,
              date: (parsed.date || new Date()).toISOString(),
              body: (parsed.text || '').slice(0, 5000),
              bodyHtml: '',
              direction,
              attachments: (parsed.attachments || []).map((a, idx) => ({ filename: a.filename, size: a.size, idx, mailbox, uid })),
            });
          } catch (fe) { /* skip unparseable */ }
        }
      } finally { if (lock) lock.release(); }
    }

    const client = new ImapFlow(imapConfig);
    await client.connect();
    try {
      await fetchFromMailbox(client, 'INBOX', 'received');
      await fetchFromMailbox(client, '[Gmail]/Sent Mail', 'sent');
    } finally {
      await client.logout();
    }

    // Deduplicate by messageId and sort chronologically
    const seen = new Set();
    const unique = emails.filter(e => {
      if (!e.messageId || seen.has(e.messageId)) return !e.messageId ? true : false;
      seen.add(e.messageId);
      return true;
    }).sort((a, b) => new Date(a.date) - new Date(b.date));

    // Cache in project blob
    full._emailThreadCache = { emails: unique, fetchedAt: new Date().toISOString() };
    await supabase.from('settings').upsert({ key: `project_full_${req.params.id}`, value: full, updated_at: new Date().toISOString() });

    res.json({ emails: unique, cached: false, fetchedAt: full._emailThreadCache.fetchedAt });
  } catch (err) {
    console.error('[email-thread]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Download email attachment ─────────────────────────────────────────────────

projects.get('/:id/email-attachment', auth, requireRole('admin','manager','ceo'), async (req, res) => {
  try {
    const { mailbox, uid, idx } = req.query;
    if (!mailbox || !uid || idx === undefined) return res.status(400).json({ error: 'mailbox, uid, idx required' });

    const { ImapFlow } = require('imapflow');
    const { simpleParser } = require('mailparser');
    const client = new ImapFlow({
      host: process.env.IMAP_HOST || 'imap.gmail.com',
      port: parseInt(process.env.IMAP_PORT || '993'),
      secure: true,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      logger: false,
    });

    await client.connect();
    let lock;
    try {
      lock = await client.getMailboxLock(mailbox);
      const dl = await client.download(uid, undefined, { uid: true });
      const chunks = [];
      for await (const chunk of dl.content) chunks.push(chunk);
      const source = Buffer.concat(chunks);
      const parsed = await simpleParser(source);
      const att = (parsed.attachments || [])[parseInt(idx)];
      if (!att) { lock.release(); await client.logout(); return res.status(404).json({ error: 'Attachment not found' }); }

      const ct = att.contentType || 'application/octet-stream';
      const isInline = /^(image\/|application\/pdf)/.test(ct);
      res.setHeader('Content-Type', ct);
      res.setHeader('Content-Disposition', `${isInline?'inline':'attachment'}; filename="${(att.filename || 'attachment').replace(/"/g, '_')}"`);
      res.send(att.content);
    } finally {
      if (lock) lock.release();
      await client.logout();
    }
  } catch (err) {
    console.error('[email-attachment]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── AI summary of email thread ───────────────────────────────────────────────

projects.get('/:id/email-summary', auth, requireRole('admin','manager','ceo'), async (req, res) => {
  try {
    const { data: fullRow } = await supabase.from('settings').select('value').eq('key', `project_full_${req.params.id}`).maybeSingle();
    const full = fullRow?.value || {};
    const cache = full._emailThreadCache;
    if (!cache?.emails?.length) return res.json({ summary: 'No emails to summarize.', suggestions: [] });

    // Build thread text for Claude
    const threadText = cache.emails.map(e =>
      `[${e.direction.toUpperCase()}] ${new Date(e.date).toLocaleDateString()} | From: ${e.from} | To: ${e.to}\nSubject: ${e.subject}\n${(e.body || '').slice(0, 1000)}\n---`
    ).join('\n');

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: `You are a logistics coordinator assistant. Analyze this email thread between an exporter (Sathvam) and their logistics vendor. Respond in JSON format only:
{"summary":"1-2 sentence status summary of where things stand","stage":"one of: docs_sent|vendor_confirmed|checklist_verified|customs_clearing|shipping|delivered","suggestions":["suggested reply 1","suggested reply 2","suggested reply 3"]}

Email thread:
${threadText}` }],
    });

    const text = resp.content[0]?.text || '{}';
    let parsed;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch {
      parsed = { summary: text.slice(0, 200), stage: 'unknown', suggestions: [] };
    }
    res.json(parsed);
  } catch (err) {
    console.error('[email-summary]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Forward email to B2B buyer ──────────────────────────────────────────────

projects.post('/:id/email-forward', auth, requireRole('admin','manager','ceo'), async (req, res) => {
  try {
    const { emailId, note } = req.body;

    // Get project and buyer email
    const { data: projRow } = await supabase.from('projects').select('*').eq('id', req.params.id).single();
    if (!projRow) return res.status(404).json({ error: 'Project not found' });

    // Get buyer email from linked B2B order
    let buyerEmail = '';
    if (projRow.b2b_order_id) {
      const { data: order } = await supabase.from('b2b_orders').select('customer_id, b2b_customers(email, contact_name)').eq('id', projRow.b2b_order_id).single();
      buyerEmail = order?.b2b_customers?.email || '';
    }
    if (!buyerEmail) return res.status(400).json({ error: 'No buyer email found' });

    // Find the email in cache
    const { data: fullRow } = await supabase.from('settings').select('value').eq('key', `project_full_${req.params.id}`).maybeSingle();
    const full = fullRow?.value || {};
    const email = (full._emailThreadCache?.emails || []).find(e => e.id === emailId);
    if (!email) return res.status(404).json({ error: 'Email not found in cache' });

    const forwardBody = `${note ? note + '\n\n' : ''}---------- Forwarded message ----------\nFrom: ${email.from}\nDate: ${new Date(email.date).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})}\nSubject: ${email.subject}\nTo: ${email.to}\n\n${email.body || '(no content)'}`;

    await mailer.sendMail({
      from: process.env.SMTP_FROM || `Sathvam Exports <${process.env.SMTP_USER}>`,
      to: buyerEmail,
      subject: `Fwd: ${email.subject}`,
      text: forwardBody,
    });

    // Log
    const fwdRecord = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      date: new Date().toISOString(),
      to: [buyerEmail],
      subject: `Fwd: ${email.subject}`,
      sentBy: req.user?.name || req.user?.username || 'admin',
      type: 'forward_to_buyer',
    };
    full._emailLog = [...(full._emailLog || []), fwdRecord];
    delete full._emailThreadCache;
    await supabase.from('settings').upsert({ key: `project_full_${req.params.id}`, value: full, updated_at: new Date().toISOString() });

    res.json({ success: true, sentTo: buyerEmail });
  } catch (err) {
    console.error('[email-forward]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Email unread count & mark viewed ────────────────────────────────────────

projects.get('/:id/email-unread-count', auth, async (req, res) => {
  try {
    const { data: fullRow } = await supabase.from('settings').select('value').eq('key', `project_full_${req.params.id}`).maybeSingle();
    const full = fullRow?.value || {};
    const cache = full._emailThreadCache;
    if (!cache?.emails?.length) return res.json({ count: 0 });

    const lastViewed = full._emailLastViewed || '2000-01-01';
    const newEmails = cache.emails.filter(e => e.direction === 'received' && new Date(e.date) > new Date(lastViewed));
    res.json({ count: newEmails.length });
  } catch (err) {
    res.json({ count: 0 });
  }
});

// Mark emails as viewed
projects.post('/:id/email-mark-viewed', auth, async (req, res) => {
  try {
    const { data: fullRow } = await supabase.from('settings').select('value').eq('key', `project_full_${req.params.id}`).maybeSingle();
    const full = fullRow?.value || {};
    full._emailLastViewed = new Date().toISOString();
    await supabase.from('settings').upsert({ key: `project_full_${req.params.id}`, value: full, updated_at: new Date().toISOString() });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

// ── Reply to logistics email thread ──────────────────────────────────────────

projects.post('/:id/email-reply', auth, requireRole('admin','manager','ceo'), async (req, res) => {
  try {
    const { to, cc, subject, body, inReplyTo } = req.body;
    if (!to?.length || !subject || !body) return res.status(400).json({ error: 'to, subject, body required' });

    const { data: fullRow } = await supabase.from('settings').select('value').eq('key', `project_full_${req.params.id}`).maybeSingle();
    const full = fullRow?.value || {};

    const mailOpts = {
      from: process.env.SMTP_FROM || `Sathvam Exports <${process.env.SMTP_USER}>`,
      to: Array.isArray(to) ? to.join(', ') : to,
      cc: Array.isArray(cc) ? cc.filter(Boolean).join(', ') : (cc || ''),
      subject,
      text: body,
      ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
    };
    await mailer.sendMail(mailOpts);

    // Log the send
    const sentRecord = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      date: new Date().toISOString(),
      to: Array.isArray(to) ? to : [to],
      cc: mailOpts.cc ? mailOpts.cc.split(',').map(s => s.trim()) : [],
      subject,
      sentBy: req.user?.name || req.user?.username || 'admin',
      type: 'logistics_reply',
    };
    full._emailLog = [...(full._emailLog || []), sentRecord];
    // Invalidate thread cache so next fetch is fresh
    delete full._emailThreadCache;
    await supabase.from('settings').upsert({ key: `project_full_${req.params.id}`, value: full, updated_at: new Date().toISOString() });

    res.json({ success: true, record: sentRecord });
  } catch (err) {
    console.error('[email-reply]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Email Signature Image ────────────────────────────────────────────────────
projects.post('/email-signature', auth, requireRole('admin','manager','ceo'), async (req, res) => {
  try {
    const { email, signatureB64 } = req.body;
    if (!email) return res.status(400).json({ error: 'Email address required' });
    if (!signatureB64) return res.status(400).json({ error: 'No signature image provided' });

    // Extract MIME type and buffer from data URL
    const match = signatureB64.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'Invalid signature image format' });
    const mimeType = match[1];
    const ext = mimeType.split('/')[1] || 'png';
    const buffer = Buffer.from(match[2], 'base64');

    await mailer.sendMail({
      from: `"Sathvam Export Docs" <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'Sathvam — Authorized Signature',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
          <h2 style="color:#0a4840;">Sathvam Oils & Spices Pvt Ltd</h2>
          <p>Please find the authorized signature image attached.</p>
          <img src="cid:signature" style="max-width:300px;border:1px solid #e5e7eb;border-radius:8px;padding:10px;" />
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;" />
          <p style="font-size:12px;color:#6b7280;">This is an automated message from Sathvam ERP.</p>
        </div>
      `,
      attachments: [{
        filename: `sathvam-signature.${ext}`,
        content: buffer,
        contentType: mimeType,
        cid: 'signature',
      }],
    });

    res.json({ success: true, sentTo: email });
  } catch (err) {
    console.error('[email-signature]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── AI Project Monitor Agent ─────────────────────────────────────────────────
projects.post('/:id/ai-monitor', auth, requireRole('admin','manager','ceo'), async (req, res) => {
  try {
    const { data: projRow } = await supabase.from('projects')
      .select('*').eq('id', req.params.id).single();
    if (!projRow) return res.status(404).json({ error: 'Project not found' });

    const { data: fullRow } = await supabase.from('settings').select('value').eq('key', `project_full_${req.params.id}`).single();
    const full = fullRow?.value || {};
    const log = full.logistics || {};
    const fin = full.financials || {};

    // Load B2B order + payments
    let order = null, payments = {};
    if (projRow.b2b_order_id) {
      const { data: ord } = await supabase.from('b2b_orders').select('*').eq('id', projRow.b2b_order_id).single();
      order = ord;
      const { data: pmtRow } = await supabase.from('settings').select('value').eq('key', 'b2b_payments').single();
      payments = (pmtRow?.value || {})[projRow.b2b_order_id] || {};
    }

    // ── Rule-based checks ────────────────────────────────────────────────
    const findings = [];
    const warn = (cat, msg, sev='medium') => findings.push({ category: cat, message: msg, severity: sev });

    // INVOICES
    const mfgItems = (full.mfg?.items||[]).filter(i=>i.product);
    const merchItems = (full.merch?.items||[]).filter(i=>i.product);
    if (!full.mfg?.invoiceNo && mfgItems.length > 0) warn('invoice', 'MFG Invoice number not assigned yet', 'high');
    if (!full.merch?.invoiceNo && merchItems.length > 0) warn('invoice', 'MERCH Invoice number not assigned yet', 'high');
    if (!full.mfg?.invoiceDate && full.mfg?.invoiceNo) warn('invoice', 'MFG Invoice date missing');
    if (!full.merch?.invoiceDate && full.merch?.invoiceNo) warn('invoice', 'MERCH Invoice date missing');

    // ITEMS with missing data
    [...mfgItems, ...merchItems].forEach(it => {
      if (!it.hsnCode) warn('item', `"${it.exportName||it.product}" missing HSN code`, 'high');
      if (!it.qty || parseFloat(it.qty) <= 0) warn('item', `"${it.exportName||it.product}" has zero/missing quantity`, 'high');
      if (!it.unitPriceINR || parseFloat(it.unitPriceINR) <= 0) warn('item', `"${it.exportName||it.product}" has no unit price`, 'high');
      if (!it.packSize) warn('item', `"${it.exportName||it.product}" missing pack size`);
    });

    // PACKING
    const boxes = full.packingBoxes || [];
    if (boxes.length === 0 && (mfgItems.length + merchItems.length) > 0) warn('packing', 'No packing boxes/sacks created yet', 'high');
    boxes.forEach(b => {
      if (!b.grossWt || parseFloat(b.grossWt) <= 0) warn('packing', `Box ${b.displayLabel||b.id}: missing gross weight`);
      if (!b.netWt || parseFloat(b.netWt) <= 0) warn('packing', `Box ${b.displayLabel||b.id}: missing net weight`);
      if (parseFloat(b.netWt) > parseFloat(b.grossWt)) warn('packing', `Box ${b.displayLabel||b.id}: net weight > gross weight — impossible`, 'high');
      if (!(b.products||[]).length) warn('packing', `Box ${b.displayLabel||b.id}: empty — no products assigned`, 'high');
    });

    // BUYER INFO
    if (!full.buyerName) warn('buyer', 'Buyer/consignee name missing', 'high');
    if (!full.buyerAddress) warn('buyer', 'Buyer address missing for invoice');
    if (!full.buyerCountry) warn('buyer', 'Buyer country missing');
    if (!full.portOfDischarge) warn('buyer', 'Port of discharge not set');

    // LOGISTICS
    if (!log.vendorName && boxes.length > 0) warn('logistics', 'Logistics vendor not assigned', 'medium');
    if (!log.vendorEmail && log.vendorName) warn('logistics', 'Logistics vendor email missing — cannot send docs', 'medium');
    if (log.vendorName && !log.docsSentDate) warn('logistics', 'Documents not yet sent to logistics vendor', 'medium');
    if (log.docsSentDate && !log.vendorConfirmed) warn('logistics', 'Logistics vendor has not confirmed receipt of docs');
    if (!log.billAmt && order && ['shipped','sailing','in_transit','delivered'].includes(order.stage)) warn('logistics', 'Shipment dispatched but logistics bill amount not recorded', 'high');
    if (log.billAmt && !log.billDate) warn('logistics', 'Logistics bill amount set but bill date missing');

    // FINANCIALS
    const mfgTotal = mfgItems.reduce((s,it) => s + (parseFloat(it.totalINR)||0), 0);
    const merchTotal = merchItems.reduce((s,it) => s + (parseFloat(it.totalINR)||0), 0);
    const totalVal = mfgTotal + merchTotal;
    if (totalVal <= 0 && (mfgItems.length + merchItems.length) > 0) warn('finance', 'Total invoice value is ₹0 — check item prices', 'critical');

    const advPaid = parseFloat(payments.advance_paid || 0);
    const remPaid = parseFloat(payments.remaining_paid || 0);
    const logiPaid = parseFloat(payments.logistics_paid || 0);
    const totalPaid = advPaid + remPaid + logiPaid;
    const logiCharge = parseFloat(fin.logisticsCharge || order?.logistics_charge || 0);
    const otherCharge = parseFloat(fin.otherCharges || order?.other_charges || 0);
    const totalDue = totalVal + logiCharge + otherCharge;
    const outstanding = Math.max(0, totalDue - totalPaid);

    if (advPaid <= 0 && order && !['order_placed','confirmed'].includes(order.stage)) warn('finance', 'No advance payment received but order is past confirmation stage', 'high');
    if (outstanding > 0 && order && ['delivered','payment_received'].includes(order.stage)) warn('finance', `Outstanding balance ₹${Math.round(outstanding).toLocaleString()} but order marked as delivered`, 'high');

    // SHIPPING
    if (!full.piNo && !full.mfg?.piNo) warn('shipping', 'Proforma Invoice number not set');
    if (!full.portOfLoading) warn('shipping', 'Port of loading not configured');
    if (!full.vessel) warn('shipping', 'Vessel/flight info not set');

    // COMPLIANCE
    if (!full.lutArn) warn('compliance', 'LUT ARN not set — required for export without IGST');

    // EMAIL LOG
    const emailLog = full._emailLog || [];
    if (emailLog.length === 0 && log.vendorName) warn('communication', 'No emails sent to logistics vendor yet');

    // ORDER STAGE vs PROJECT STATE
    if (order) {
      if (order.stage === 'order_placed' && (full.mfg?.invoiceNo || full.merch?.invoiceNo)) warn('workflow', 'Invoice assigned but B2B order still at "Order Placed" — update order stage');
      if (['shipped','sailing','in_transit'].includes(order.stage) && !log.vendorName) warn('workflow', 'Shipment in transit but no logistics vendor assigned — who shipped this?', 'high');
    }

    // ── AI Analysis ──────────────────────────────────────────────────────────
    let aiSummary = '';
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const snapshot = {
        project: projRow.project_name,
        buyer: full.buyerName,
        country: full.buyerCountry,
        orderStage: order?.stage,
        mfgInvoice: full.mfg?.invoiceNo || null,
        merchInvoice: full.merch?.invoiceNo || null,
        mfgItemCount: mfgItems.length,
        merchItemCount: merchItems.length,
        totalBoxes: boxes.length,
        totalValue: Math.round(totalVal),
        advancePaid: advPaid,
        balancePaid: remPaid,
        outstanding: Math.round(outstanding),
        logisticsVendor: log.vendorName || null,
        logisticsDocsSent: !!log.docsSentDate,
        logisticsConfirmed: !!log.vendorConfirmed,
        logisticsBillAmount: parseFloat(log.billAmt) || 0,
        emailsSent: emailLog.length,
        piNo: full.piNo || full.mfg?.piNo || null,
        portOfLoading: full.portOfLoading || null,
        portOfDischarge: full.portOfDischarge || null,
        terms: full.terms || full.paymentTerms || null,
        ruleFindings: findings.length,
        criticalFindings: findings.filter(f => f.severity === 'critical').length,
        highFindings: findings.filter(f => f.severity === 'high').length,
      };

      const resp = await claude.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: `You are an AI export operations monitor for Sathvam Oils & Spices, an Indian FMCG exporter.
Analyze the B2B export project state and provide:
1. A 2-3 sentence overall assessment
2. Top 3 actionable next steps (what to do RIGHT NOW)
3. Any automation suggestions (what could be automated in this workflow)
4. Risk alerts (deadline risks, compliance risks, payment risks)
Keep it concise and actionable. Use bullet points. No markdown headers.`,
        messages: [{ role: 'user', content: `Project snapshot:\n${JSON.stringify(snapshot, null, 2)}\n\nRule-based findings (${findings.length}):\n${findings.map(f => `[${f.severity.toUpperCase()}] ${f.category}: ${f.message}`).join('\n')}` }],
      });
      aiSummary = resp.content?.[0]?.text || '';
    } catch (aiErr) {
      console.error('[ai-monitor] Claude error:', aiErr.message);
      aiSummary = 'AI analysis unavailable — check ANTHROPIC_API_KEY.';
    }

    res.json({
      projectName: projRow.project_name,
      orderStage: order?.stage || null,
      findings,
      aiSummary,
      stats: {
        total: findings.length,
        critical: findings.filter(f => f.severity === 'critical').length,
        high: findings.filter(f => f.severity === 'high').length,
        medium: findings.filter(f => f.severity === 'medium').length,
      },
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[ai-monitor]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── AI Project Chat — can read project data, answer questions, and apply fixes ──
projects.post('/:id/ai-chat', auth, requireRole('admin','manager','ceo'), async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    // Load project data
    const { data: fullRow } = await supabase.from('settings').select('value').eq('key', `project_full_${req.params.id}`).single();
    const full = fullRow?.value || {};
    const { data: projRow } = await supabase.from('projects').select('*').eq('id', req.params.id).single();

    // Build context
    const mfgItems = (full.mfg?.items||[]).filter(i=>i.product);
    const merchItems = (full.merch?.items||[]).filter(i=>i.product);
    const boxes = full.packingBoxes || [];
    const allItems = [...mfgItems.map((it,i)=>({...it,_section:"mfg",_idx:i})), ...merchItems.map((it,i)=>({...it,_section:"merch",_idx:i}))];

    const itemsJson = allItems.map(it => ({
      section: it._section,
      index: it._idx,
      product: it.exportName || it.product,
      hsnCode: it.hsnCode || null,
      qty: it.qty,
      packSize: it.packSize,
      packUnit: it.packUnit,
      unitPriceINR: it.unitPriceINR,
      totalINR: it.totalINR,
      cat: it.cat || '',
    }));

    const Anthropic = require('@anthropic-ai/sdk');
    const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const systemPrompt = `You are the AI operations assistant for Sathvam Oils & Spices Pvt Ltd, an Indian FMCG exporter of cold-pressed oils, spices, millets, and food products.

You are chatting inside a B2B export project. You can:
1. Answer questions about the project, export procedures, Indian customs, HSN codes, compliance
2. **Fix data** by returning a JSON action block that the system will execute

PROJECT DATA:
- Project: ${projRow?.project_name || full.projectName || ''}
- Buyer: ${full.buyerName || ''} (${full.buyerCountry || ''})
- MFG Items: ${mfgItems.length}, MERCH Items: ${merchItems.length}
- Boxes: ${boxes.length}
- MFG Invoice: ${full.mfg?.invoiceNo || 'not set'}
- MERCH Invoice: ${full.merch?.invoiceNo || 'not set'}
- Port: ${full.portOfLoading || '—'} → ${full.portOfDischarge || '—'}
- Logistics Vendor: ${full.logistics?.vendorName || 'not set'}

ALL ITEMS (use section + index to reference):
${JSON.stringify(itemsJson, null, 1)}

WHEN THE USER ASKS YOU TO FIX SOMETHING (e.g. "fix HSN codes", "set all missing HSN"):
Return your response text FOLLOWED BY an action block like this:

\`\`\`action
{
  "type": "update_items",
  "updates": [
    {"section": "mfg", "index": 0, "field": "hsnCode", "value": "15081000"},
    {"section": "merch", "index": 3, "field": "hsnCode", "value": "07132090"}
  ]
}
\`\`\`

Supported action types:
- "update_items": update item fields (hsnCode, exportName, packSize, packUnit, unitPriceINR, qty)
- "update_project": update project fields: {"type":"update_project","updates":{"portOfLoading":"CHENNAI","vessel":"BY SEA"}}
- "update_logistics": update logistics fields: {"type":"update_logistics","updates":{"vendorName":"ABC Logistics"}}

HSN CODE REFERENCE (8-digit Indian Customs Tariff):
- Groundnut oil: 15081000
- Sesame oil: 15154000
- Coconut oil: 15131100
- Mustard oil: 15141100
- Castor oil: 15153000
- Sunflower oil: 15121100
- Rice bran oil: 15159030
- Turmeric powder: 09103020
- Chilli powder: 09042110
- Coriander powder: 09092110
- Cumin powder: 09093110
- Pepper powder: 09041110
- Sambar powder: 21039090
- Rasam powder: 21039090
- Curry powder: 09109100
- Garam masala: 09109990
- Rice: 10063090
- Wheat flour (atta): 11010010
- Ragi flour: 11029090
- Millet (general): 10089090
- Foxtail millet: 10082900
- Little millet: 10089040
- Barnyard millet: 10089050
- Kodo millet: 10089060
- Bajra: 10082100
- Jowar/Sorghum: 10070090
- Moong dal: 07132090
- Toor dal: 07139090
- Urad dal: 07139020
- Chana dal: 07132010
- Masoor dal: 07139040
- Jaggery: 17011490
- Palm jaggery: 17011490
- Poha/Aval/Beaten rice: 19041090
- Vermicelli: 19021900
- Papad: 19059090
- Pickle: 20011000
- Honey: 04090000
- Ghee: 04059010
- Cardamom: 09083110
- Clove: 09071010
- Cinnamon: 09061010
- Fenugreek: 09109930
- Idli/Dosa Batter: 19019090
- Flakes/Cornflakes: 19041020

Be concise but thorough. When fixing HSN codes, match product names to the closest category above. If unsure, say so.`;

    const messages = [
      ...(history || []).slice(-10).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    const resp = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: systemPrompt,
      messages,
    });

    const aiText = resp.content?.[0]?.text || '';

    // Parse action block if present
    const actionMatch = aiText.match(/```action\s*\n([\s\S]*?)\n```/);
    let actionResult = null;
    if (actionMatch) {
      try {
        const action = JSON.parse(actionMatch[1]);
        if (action.type === 'update_items' && Array.isArray(action.updates)) {
          const mfg = { ...(full.mfg || {}), items: [...(full.mfg?.items || [])] };
          const merch = { ...(full.merch || {}), items: [...(full.merch?.items || [])] };
          let applied = 0;
          action.updates.forEach(u => {
            const items = u.section === 'mfg' ? mfg.items : merch.items;
            if (items[u.index] && u.field && u.value !== undefined) {
              items[u.index] = { ...items[u.index], [u.field]: u.value };
              applied++;
            }
          });
          full.mfg = mfg;
          full.merch = merch;
          await supabase.from('settings').upsert({ key: `project_full_${req.params.id}`, value: full });
          actionResult = { type: 'update_items', applied, total: action.updates.length };
        } else if (action.type === 'update_project' && action.updates) {
          Object.assign(full, action.updates);
          await supabase.from('settings').upsert({ key: `project_full_${req.params.id}`, value: full });
          actionResult = { type: 'update_project', fields: Object.keys(action.updates) };
        } else if (action.type === 'update_logistics' && action.updates) {
          full.logistics = { ...(full.logistics || {}), ...action.updates };
          await supabase.from('settings').upsert({ key: `project_full_${req.params.id}`, value: full });
          actionResult = { type: 'update_logistics', fields: Object.keys(action.updates) };
        }
      } catch (parseErr) {
        console.error('[ai-chat] Action parse error:', parseErr.message);
      }
    }

    // Clean action block from visible text
    const cleanText = aiText.replace(/```action\s*\n[\s\S]*?\n```/g, '').trim();

    res.json({ reply: cleanText, action: actionResult, updatedFull: actionResult ? full : null });
  } catch (err) {
    console.error('[ai-chat]', err.message);
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

    const publicUrl = await uploadFile('documents', path, req.file.buffer, req.file.mimetype);

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
      await deleteFile('documents', target.path);
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
      if (f.path) await deleteFile('documents', f.path);
    }
    delete docs[type];
    await supabase.from('settings').upsert({ key: `project_shipping_docs_${req.params.id}`, value: docs, updated_at: new Date() });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Logistics Agent Monitoring Routes ────────────────────────────────────────

// GET /projects/:id/logistics-log — get agent activity log
projects.get('/:id/logistics-log', auth, async (req, res) => {
  try {
    const { data: row } = await supabase.from('settings').select('value').eq('key', `project_full_${req.params.id}`).single();
    if (!row) return res.status(404).json({ error: 'Project not found' });
    const full = row.value || {};
    res.json({
      log: full.logisticsLog || [],
      logistics: full.logistics || {},
      stage: full.logistics?.agentStage || 'idle',
      paused: !!full.logistics?.agentPaused,
      pendingBuyerEmail: full.logistics?.pendingBuyerEmail ? {
        subject: full.logistics.pendingBuyerEmail.subject,
        hasBlAttachments: (full.logistics.pendingBuyerEmail.blAttachments || []).length > 0,
      } : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /projects/:id/logistics-agent/approve/:logId — approve a pending action
projects.post('/:id/logistics-agent/approve/:logId', auth, requireRole('admin','ceo'), async (req, res) => {
  try {
    const { data: row } = await supabase.from('settings').select('value').eq('key', `project_full_${req.params.id}`).single();
    if (!row) return res.status(404).json({ error: 'Project not found' });
    const full = row.value || {};
    const logEntry = (full.logisticsLog || []).find(e => e.id === req.params.logId);
    if (!logEntry) return res.status(404).json({ error: 'Log entry not found' });
    logEntry.approved = true;
    logEntry.approvedBy = req.user?.name || req.user?.username;
    logEntry.approvedAt = new Date().toISOString();
    logEntry.needsApproval = false;

    // If this was a buyer email approval, set the flag
    if (logEntry.buyerEmailReady) {
      full.logistics = { ...(full.logistics || {}), buyerEmailApproved: true };
    }

    await supabase.from('settings').upsert({ key: `project_full_${req.params.id}`, value: full });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /projects/:id/logistics-agent/pause — pause agent for this project
projects.post('/:id/logistics-agent/pause', auth, requireRole('admin','ceo','manager'), async (req, res) => {
  try {
    const { data: row } = await supabase.from('settings').select('value').eq('key', `project_full_${req.params.id}`).single();
    if (!row) return res.status(404).json({ error: 'Project not found' });
    const full = row.value || {};
    full.logistics = { ...(full.logistics || {}), agentPaused: true };
    await supabase.from('settings').upsert({ key: `project_full_${req.params.id}`, value: full });
    res.json({ success: true, paused: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /projects/:id/logistics-agent/resume — resume agent for this project
projects.post('/:id/logistics-agent/resume', auth, requireRole('admin','ceo','manager'), async (req, res) => {
  try {
    const { data: row } = await supabase.from('settings').select('value').eq('key', `project_full_${req.params.id}`).single();
    if (!row) return res.status(404).json({ error: 'Project not found' });
    const full = row.value || {};
    full.logistics = { ...(full.logistics || {}), agentPaused: false };
    await supabase.from('settings').upsert({ key: `project_full_${req.params.id}`, value: full });
    res.json({ success: true, paused: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /projects/:id/logistics-agent/send-to-buyer — manually trigger buyer email
projects.post('/:id/logistics-agent/send-to-buyer', auth, requireRole('admin','ceo'), async (req, res) => {
  try {
    const { data: row } = await supabase.from('settings').select('value').eq('key', `project_full_${req.params.id}`).single();
    if (!row) return res.status(404).json({ error: 'Project not found' });
    const full = row.value || {};
    const pendingEmail = full.logistics?.pendingBuyerEmail;
    if (!pendingEmail) return res.status(400).json({ error: 'No pending buyer email to send' });

    const buyerEmail = full.buyerEmail || req.body.buyerEmail || '';
    if (!buyerEmail) return res.status(400).json({ error: 'No buyer email configured' });

    const nodemailer = require('nodemailer');
    const mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '465'),
      secure: process.env.SMTP_PORT !== '587',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    // Prepare BL attachments from S3
    const attachments = [];
    if (pendingEmail.blAttachments?.length) {
      const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
      const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
      for (const att of pendingEmail.blAttachments) {
        try {
          const resp = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET || 'sathvam-storage', Key: att.s3Key }));
          const chunks = []; for await (const chunk of resp.Body) chunks.push(chunk);
          attachments.push({ filename: att.filename, content: Buffer.concat(chunks), contentType: att.contentType });
        } catch (e) { console.error('S3 download:', e.message); }
      }
    }

    await mailer.sendMail({
      from: process.env.SMTP_FROM || `"Sathvam Export" <${process.env.SMTP_USER}>`,
      to: buyerEmail,
      replyTo: process.env.SMTP_USER,
      subject: pendingEmail.subject,
      html: pendingEmail.html,
      attachments,
    });

    // Update project
    full.logistics.agentStage = 'buyer_notified';
    full.logistics.blSharedToCustomerDate = new Date().toISOString().slice(0, 10);
    full.logistics.pendingBuyerEmail = null;
    full.logistics.buyerEmailApproved = false;

    // Add log entry
    full.logisticsLog = full.logisticsLog || [];
    full.logisticsLog.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: new Date().toISOString(),
      phase: 'buyer_update',
      action: 'Vessel schedule + shipping docs sent to buyer',
      detail: `Sent to: ${buyerEmail}\nSubject: ${pendingEmail.subject}`,
      autoAction: false,
      sentBy: req.user?.name || req.user?.username,
    });

    await supabase.from('settings').upsert({ key: `project_full_${req.params.id}`, value: full });
    res.json({ success: true, sentTo: buyerEmail });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /projects/:id/logistics-agent/run — manually trigger agent for this project
projects.post('/:id/logistics-agent/run', auth, requireRole('admin','ceo'), async (req, res) => {
  try {
    const { exec } = require('child_process');
    exec(`node ${require('path').resolve(__dirname, '../scripts/logistics-agent.js')}`, { env: process.env, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) console.error('[logistics-agent-manual]', stderr);
      else console.log('[logistics-agent-manual]', stdout);
    });
    res.json({ success: true, message: 'Agent triggered — check log in a few minutes' });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  if (q.status === 'quoted') {
    setImmediate(async () => {
      try {
        const { data: cust } = await supabase.from('b2b_customers').select('phone,contact_name').eq('id', existing.customer_id).single();
        if (!cust?.phone) return;
        const msg = `🌿 *Sathvam Organics – Quotation Ready*\n\nDear ${cust.contact_name},\n\nYour quotation request has been responded to. Please login to your portal to review and accept.\n\n_sathvam.in/b2b_`;
        await gaSendText(cust.phone, msg);
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
        <div style="font-size:10px;color:#6b7280;margin-top:4px;line-height:1.7">Plot No. 6, Anand Jothi Nagar, Near ABS Hospital, Thanthoni, Tamil Nadu 639005<br>GSTIN: 33ABFCS9387K1ZN | PAN: ABFCS9387K | CIN: U15400TN2021PTC142893 | TAN: CHES61531B<br>Ph: +91 70923 77092 | Email: sales@sathvam.in | www.sathvam.in</div>
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
        <div>UPI: sales@sathvam.in | Phone Pay / GPay: +91 70923 77092</div>
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
          <p style="margin:0;font-size:11px;color:#9ca3af">For queries, contact: sales@sathvam.in | +91 70923 77092</p>
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
      gaSendText(wa, `💰 Advance Payment Claim\n${order?.order_no||req.params.id} · ${company}\nAmount: ₹${parseFloat(amount).toLocaleString('en-IN')}\nRef: ${txnRef||'—'}\nDate: ${date||'Today'}\n\nPlease verify and record the payment in the admin panel.`).catch(()=>{});
    }
  } catch(_) {}
  res.json({ ok: true, claim });
});

// POST /api/b2b/orders/:id/balance-claim — customer submits final/balance payment details (notification to admin)
b2bOrders.post('/:id/balance-claim', auth, async (req, res) => {
  if (req.user.type === 'b2b_customer' && !(await ownsOrder(req.user.id, req.params.id)))
    return res.status(403).json({ error: 'Forbidden' });
  const { amount, txnRef, date, notes } = req.body;
  if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Amount is required' });
  const SETTINGS_KEY = 'b2b_payments';
  const all = await getSettingsBlob(SETTINGS_KEY);
  const claim = { amount: parseFloat(amount), txnRef: txnRef||'', date: date||new Date().toISOString().slice(0,10), notes: notes||'', submittedAt: new Date().toISOString(), status: 'pending_verification' };
  all[req.params.id] = { ...(all[req.params.id]||{}), customer_balance_claim: claim };
  await saveSettingsBlob(SETTINGS_KEY, all);
  // WhatsApp notification to admin
  try {
    const { data: order } = await supabase.from('b2b_orders').select('order_no,b2b_customers(company_name,contact_name)').eq('id', req.params.id).single();
    const company = order?.b2b_customers?.company_name || 'Customer';
    const wa = process.env.WA_ADMIN_PHONE1||process.env.ADMIN_WHATSAPP_PHONE;
    if (wa) {
      gaSendText(wa, `🏦 Balance Payment Claim\n${order?.order_no||req.params.id} · ${company}\nAmount: ₹${parseFloat(amount).toLocaleString('en-IN')}\nRef: ${txnRef||'—'}\nDate: ${date||'Today'}\n\nPlease verify and record the final payment in the admin panel.`).catch(()=>{});
    }
  } catch(_) {}
  res.json({ ok: true, claim });
});

// POST /api/b2b/orders/:id/logistics-claim — customer submits logistics payment details (notification to admin)
b2bOrders.post('/:id/logistics-claim', auth, async (req, res) => {
  if (req.user.type === 'b2b_customer' && !(await ownsOrder(req.user.id, req.params.id)))
    return res.status(403).json({ error: 'Forbidden' });
  const { amount, txnRef, date, notes } = req.body;
  if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Amount is required' });
  const SETTINGS_KEY = 'b2b_payments';
  const all = await getSettingsBlob(SETTINGS_KEY);
  const claim = { amount: parseFloat(amount), txnRef: txnRef||'', date: date||new Date().toISOString().slice(0,10), notes: notes||'', submittedAt: new Date().toISOString(), status: 'pending_verification' };
  all[req.params.id] = { ...(all[req.params.id]||{}), customer_logistics_claim: claim };
  await saveSettingsBlob(SETTINGS_KEY, all);
  // WhatsApp notification to admin
  try {
    const { data: order } = await supabase.from('b2b_orders').select('order_no,b2b_customers(company_name,contact_name)').eq('id', req.params.id).single();
    const company = order?.b2b_customers?.company_name || 'Customer';
    const wa = process.env.WA_ADMIN_PHONE1||process.env.ADMIN_WHATSAPP_PHONE;
    if (wa) {
      gaSendText(wa, `🚛 Logistics Payment Claim\n${order?.order_no||req.params.id} · ${company}\nAmount: ₹${parseFloat(amount).toLocaleString('en-IN')}\nRef: ${txnRef||'—'}\nDate: ${date||'Today'}\n\nPlease verify and record the logistics payment in the admin panel.`).catch(()=>{});
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
    // Mark customer claim as verified
    if (orderPayment.customer_advance_claim) orderPayment.customer_advance_claim.status = 'verified';
  } else if (type === 'remaining') {
    // Migrate legacy single-entry format to array (like advance)
    if (!Array.isArray(orderPayment.remaining_entries)) {
      orderPayment.remaining_entries = orderPayment.remaining_paid > 0
        ? [{ amount: orderPayment.remaining_paid, date: orderPayment.remaining_date||'', ref: orderPayment.remaining_ref||'', notes: orderPayment.remaining_notes||'' }]
        : [];
    }
    orderPayment.remaining_entries.push({
      amount: parseFloat(amount)||0,
      date:   date || new Date().toISOString().slice(0,10),
      ref:    ref   || '',
      notes:  notes || '',
    });
    orderPayment.remaining_paid   = orderPayment.remaining_entries.reduce((s,e)=>s+(parseFloat(e.amount)||0), 0);
    orderPayment.remaining_date   = orderPayment.remaining_entries[orderPayment.remaining_entries.length-1].date;
    orderPayment.remaining_ref    = orderPayment.remaining_entries[orderPayment.remaining_entries.length-1].ref;
    orderPayment.remaining_notes  = orderPayment.remaining_entries[orderPayment.remaining_entries.length-1].notes;
    // Auto-detect fully_paid: check if total paid covers total due
    const _advPaid  = parseFloat(orderPayment.advance_paid)||0;
    const _remPaid  = orderPayment.remaining_paid;
    const _logiPaid = parseFloat(orderPayment.logistics_paid)||0;
    const _totalPaid = _advPaid + _remPaid + _logiPaid;
    // Fetch order value to compare
    const { data: _ord } = await supabase.from('b2b_orders').select('total_value,logistics_charge,other_charges').eq('id', req.params.id).single();
    const _totalDue = (parseFloat(_ord?.total_value)||0) + (parseFloat(_ord?.logistics_charge)||0) + (parseFloat(_ord?.other_charges)||0);
    orderPayment.payment_status = _totalPaid >= _totalDue && _totalDue > 0 ? 'fully_paid' : 'advance_paid';
    // Mark customer claim as verified
    if (orderPayment.customer_balance_claim) orderPayment.customer_balance_claim.status = 'verified';
  } else {
    // logistics payment
    orderPayment.logistics_paid   = parseFloat(amount)||0;
    orderPayment.logistics_date   = date || new Date().toISOString().slice(0,10);
    orderPayment.logistics_ref    = ref || '';
    orderPayment.logistics_notes  = notes || '';
    // Mark customer claim as verified
    if (orderPayment.customer_logistics_claim) orderPayment.customer_logistics_claim.status = 'verified';
  }
  allPayments[req.params.id] = orderPayment;

  const { error } = await supabase.from('settings').upsert({ key: SETTINGS_KEY, value: allPayments });
  if (error) return res.status(400).json({ error: 'Payment update failed: ' + error.message });

  // Auto-feed money_ledger — B2B payment received
  setImmediate(async () => {
    try {
      const { data: ord } = await supabase.from('b2b_orders').select('order_no,buyer_name').eq('id', req.params.id).single();
      const subcatMap = { advance: 'b2b_advance', remaining: 'b2b_balance', logistics: 'b2b_logistics' };
      insertLedger({
        txn_date:     date || new Date().toISOString().slice(0, 10),
        direction:    type === 'logistics' ? 'out' : 'in',
        amount:       parseFloat(amount) || 0,
        category:     type === 'logistics' ? 'expense' : 'sales',
        subcategory:  subcatMap[type] || 'b2b',
        party:        ord?.buyer_name || 'B2B Customer',
        party_type:   type === 'logistics' ? 'vendor' : 'customer',
        payment_mode: 'bank_transfer',
        narration:    `B2B ${type} payment — ${ord?.order_no || req.params.id}`,
        reference_no: ref || '',
        source_table: 'b2b_orders',
        source_id:    req.params.id,
        created_by:   req.user?.name || '',
      }).catch(() => {});
    } catch(_) {}
  });

  res.json({ id: req.params.id, ...orderPayment });
  // Auto WhatsApp
  setImmediate(async () => {
    try {
      const { data: order } = await supabase.from('b2b_orders').select('order_no,customer_id,buyer_name').eq('id', req.params.id).single();
      if (!order) return;
      const { data: cust } = await supabase.from('b2b_customers').select('phone,contact_name').eq('id', order.customer_id).maybeSingle();
      const phone = cust?.phone;
      if (!phone) return;
      const typeLabel = type === 'advance' ? 'Advance Payment' : type === 'remaining' ? 'Final Payment' : 'Logistics Payment';
      const msg = `🌿 *Sathvam Organics – Payment Received*\n\nDear ${cust?.contact_name || order.buyer_name || 'Customer'},\n\nWe have received your *${typeLabel}* of *₹${amount}* for order *${order.order_no}*.\n\nReference: ${ref || 'N/A'} · Date: ${date}\n\nThank you!\n_sathvam.in_`;
      await gaSendText(phone, msg);
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
// ensureB2bBucket no longer needed — S3 storage helper handles bucket/prefix automatically
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
  const fname = `proof-${req.params.orderId}-${Date.now()}.${ext}`;
  const publicUrl = await uploadFile(B2B_DOC_BUCKET, fname, req.file.buffer, req.file.mimetype);
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
  const fname = `cust-doc-${req.params.orderId}-${Date.now()}.${ext}`;
  const publicUrl = await uploadFile(B2B_DOC_BUCKET, fname, req.file.buffer, req.file.mimetype);
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
    // Fetch orders + payments + customer + projects (for ETD/BL/container on active orders)
    const [{ data: orders }, { data: pmtRow }, { data: cust }, { data: projectRows }] = await Promise.all([
      supabase.from('b2b_orders')
        .select('id,order_no,stage,total_value,created_at,b2b_order_items(product_name,qty,unit)')
        .eq('customer_id', customerId)
        .order('created_at', { ascending: false })
        .limit(20),
      supabase.from('settings').select('value').eq('key', 'b2b_payments').single(),
      supabase.from('b2b_customers').select('company_name,contact_name,country,currency').eq('id', customerId).single(),
      supabase.from('projects').select('b2b_order_id,etd,bl_no,container_no,status').order('created_at', { ascending: false }).limit(50),
    ]);
    // Fallback: if no orders found by customer_id, find sibling records with same company name
    // (handles duplicate b2b_customer entries — orders may be linked to a different record ID)
    let allOrders = orders || [];
    if (allOrders.length === 0 && cust?.company_name) {
      const { data: sameNameCusts } = await supabase.from('b2b_customers')
        .select('id').ilike('company_name', cust.company_name);
      const siblingIds = (sameNameCusts || []).map(c => c.id).filter(id => id !== customerId);
      if (siblingIds.length > 0) {
        const { data: byId } = await supabase.from('b2b_orders')
          .select('id,order_no,stage,total_value,created_at,b2b_order_items(product_name,qty,unit)')
          .in('customer_id', siblingIds)
          .order('created_at', { ascending: false })
          .limit(20);
        if (byId?.length) allOrders = byId;
      }
    }

    const payments = pmtRow?.value || {};
    const today = new Date().toISOString().slice(0, 10);

    // Build project lookup by b2b_order_id for ETD/BL info
    const projectByOrder = {};
    (projectRows || []).forEach(p => { if (p.b2b_order_id) projectByOrder[p.b2b_order_id] = p; });

    const orderSummaries = allOrders.map(o => {
      const pmt = payments[o.id] || {};
      const proj = projectByOrder[o.id] || {};
      const items = o.b2b_order_items || [];
      const advPaid = parseFloat(pmt.advance_paid || 0);
      const finPaid = parseFloat(pmt.remaining_paid || 0);
      const logiPaid = parseFloat(pmt.logistics_paid || 0);
      const totalPaid = advPaid + finPaid + logiPaid;
      const orderVal = parseFloat(o.total_value || 0);
      const outstanding = Math.max(0, orderVal - totalPaid);
      // Summarise products: e.g. "Sesame Oil 500ml × 120, Groundnut Oil 1L × 60"
      const productSummary = items.slice(0, 5).map(it => `${it.product_name} × ${it.qty}${it.unit ? ' ' + it.unit : ''}`).join(', ') + (items.length > 5 ? ` + ${items.length - 5} more` : '');
      const summary = {
        order_no: o.order_no,
        stage: o.stage,
        order_date: (o.created_at || '').slice(0, 10),
        total_items: items.length,
        products: productSummary || 'N/A',
        order_value: orderVal > 0 ? `₹${orderVal.toLocaleString('en-IN')}` : 'TBD',
        advance_paid: advPaid > 0 ? `₹${advPaid.toLocaleString('en-IN')}` : 'None',
        final_paid: finPaid > 0 ? `₹${finPaid.toLocaleString('en-IN')}` : 'None',
        outstanding_balance: outstanding > 0 ? `₹${outstanding.toLocaleString('en-IN')} still due` : 'Fully paid',
        payment_status: pmt.payment_status || 'unpaid',
      };
      if (proj.etd) summary.expected_delivery = proj.etd;
      if (proj.bl_no) summary.bl_number = proj.bl_no;
      if (proj.container_no) summary.container = proj.container_no;
      return summary;
    });

    // Total business volume
    const totalBusinessVal = allOrders.reduce((s, o) => s + parseFloat(o.total_value || 0), 0);

    const prompt = `You are a friendly and professional export account manager for Sathvam Natural Products Pvt Ltd, a premium cold-pressed oil and spice exporter from India.

Today is ${today}. The customer is ${cust?.company_name || 'Valued Buyer'} (Contact: ${cust?.contact_name || 'N/A'}) from ${cust?.country || 'International'}. Total lifetime business: ₹${totalBusinessVal.toLocaleString('en-IN')}.

Here are their B2B export orders with full details:
${JSON.stringify(orderSummaries, null, 2)}

Write a concise, warm, and professional account summary for this customer. Include:
1. A brief personalised greeting mentioning their name and country (1 sentence)
2. For each active order: stage, key products, outstanding payment if any, and ETD/BL number if available
3. Any clear action items (e.g. "confirm order", "transfer balance ₹X before delivery")
4. Lifetime business value as a trust signal
5. One warm closing line

Keep it under 150 words. Use natural, friendly language — not bullet points. No markdown headers. Be specific and actionable — mention actual amounts, product names, and dates.`;

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
