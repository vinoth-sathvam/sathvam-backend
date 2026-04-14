const express      = require('express');
const nodemailer   = require('nodemailer');
const supabase     = require('../config/supabase');
const { auth }     = require('../middleware/auth');
const rateLimit    = require('express-rate-limit');
const router       = express.Router();

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

function buildInvoiceHtml(o, autoPrint = false) {
  const cust      = o.customer || {};
  const name      = cust.name || 'Customer';
  const phone     = cust.phone || '';
  const email     = cust.email || '';
  const addr      = cust.address || '';
  const city      = cust.city || '';
  const state     = cust.state || 'Tamil Nadu';
  const pin       = cust.pincode || '';
  const subtotal  = parseFloat(o.subtotal) || 0;
  const gstTotal  = parseFloat(o.gst) || 0;
  const shipping  = parseFloat(o.shipping) || 0;
  const total     = parseFloat(o.total) || (subtotal + gstTotal + shipping);
  const payMethod = cust.payment || 'online';
  const orderNo   = o.order_no || o.orderNo || '';
  const isIntra   = state.trim().toLowerCase() === 'tamil nadu'; // CGST+SGST vs IGST

  // Build items with per-item GST split
  let taxableTotal = 0, cgstTotal = 0, sgstTotal = 0, igstTotal = 0;
  const itemRows = (o.items || []).map((it, idx) => {
    const nm       = it.productName || it.name || 'Product';
    const hsn      = it.hsn_code || it.hsnCode || '—';
    const rate     = parseFloat(it.rate || it.price || 0);
    const qty      = parseInt(it.qty) || 1;
    const gstPct   = parseFloat(it.gst || 5);
    const baseRate = +(rate / (1 + gstPct / 100)).toFixed(2);
    const taxable  = +(baseRate * qty).toFixed(2);
    const gstAmt   = +(rate * qty - taxable).toFixed(2);
    const half     = +(gstAmt / 2).toFixed(2);
    const lineTotal = +(rate * qty).toFixed(2);
    const size     = it.packSize ? `${it.packSize}${it.packUnit || ''}` : '';
    taxableTotal  += taxable;
    if (isIntra) { cgstTotal += half; sgstTotal += half; }
    else { igstTotal += gstAmt; }
    const gstCols = isIntra
      ? `<td style="text-align:right">₹${half.toFixed(2)}</td><td style="text-align:right">₹${half.toFixed(2)}</td>`
      : `<td style="text-align:right" colspan="2">₹${gstAmt.toFixed(2)}</td>`;
    return `<tr style="background:${idx%2===0?'#fff':'#f9fdf9'}">
      <td>${idx+1}</td>
      <td><strong>${nm}</strong>${size?`<br><span style="color:#888;font-size:9px">${size}</span>`:''}</td>
      <td style="text-align:center;font-size:10px">${hsn}</td>
      <td style="text-align:center">${qty}</td>
      <td style="text-align:right">₹${baseRate.toFixed(2)}</td>
      <td style="text-align:right">₹${taxable.toFixed(2)}</td>
      <td style="text-align:center">${gstPct}%</td>
      ${gstCols}
      <td style="text-align:right;font-weight:700">₹${lineTotal.toFixed(2)}</td>
    </tr>`;
  }).join('');

  const gstHeader = isIntra
    ? `<th style="text-align:right">CGST (2.5%)</th><th style="text-align:right">SGST (2.5%)</th>`
    : `<th style="text-align:right" colspan="2">IGST (5%)</th>`;

  const gstSummaryRows = isIntra ? `
    <div class="tot-row"><span>CGST (2.5%)</span><span>₹${cgstTotal.toFixed(2)}</span></div>
    <div class="tot-row"><span>SGST (2.5%)</span><span>₹${sgstTotal.toFixed(2)}</span></div>` : `
    <div class="tot-row"><span>IGST (5%)</span><span>₹${igstTotal.toFixed(2)}</span></div>`;

  const qrData = encodeURIComponent(`INV:${orderNo}|AMT:${total.toFixed(2)}|DATE:${o.date}|GSTIN:33ABFCS9387K1ZN`);
  const qrUrl  = `https://api.qrserver.com/v1/create-qr-code/?data=${qrData}&size=90x90&format=png&margin=4`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Invoice ${orderNo}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  @page{size:A4;margin:15mm}
  body{font-family:Arial,sans-serif;font-size:11px;color:#1a1a1a;max-width:800px;margin:0 auto}
  .hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:14px;border-bottom:3px double #1a5c2a;margin-bottom:16px}
  .co-name{font-size:17px;font-weight:900;color:#1a5c2a;margin-bottom:3px}
  .co-sub{font-size:10px;color:#555;line-height:1.7}
  .inv-right{text-align:right}
  .inv-title{font-size:20px;font-weight:900;color:#111;letter-spacing:2px}
  .inv-meta{font-size:11px;color:#444;margin-top:4px;line-height:1.7}
  .paid-badge{display:inline-block;background:#dcfce7;color:#16a34a;border:1px solid #86efac;border-radius:4px;padding:2px 10px;font-size:11px;font-weight:800;margin-top:6px}
  .section{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden}
  .sec-box{padding:12px 14px}
  .sec-box:first-child{border-right:1px solid #e5e7eb}
  .sec-title{font-size:9px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:1px;margin-bottom:5px;padding-bottom:4px;border-bottom:1px solid #f0f0f0}
  .sec-val{font-size:11px;color:#222;line-height:1.9}
  table{width:100%;border-collapse:collapse;margin-bottom:14px;font-size:10px}
  thead tr{background:#1a5c2a}
  th{color:#fff;padding:7px 8px;font-size:9px;text-transform:uppercase;letter-spacing:.4px;font-weight:700}
  td{padding:7px 8px;border-bottom:1px solid #f0f0f0;vertical-align:middle}
  .bottom{display:flex;justify-content:space-between;align-items:flex-end;margin-top:10px;gap:20px}
  .totals{min-width:260px}
  .tot-row{display:flex;justify-content:space-between;padding:4px 0;font-size:11px;color:#555;border-bottom:1px solid #f5f5f5}
  .tot-taxable{display:flex;justify-content:space-between;padding:5px 0;font-weight:700;font-size:11px;border-top:1px solid #ddd;border-bottom:1px solid #ddd;margin:4px 0}
  .tot-final{display:flex;justify-content:space-between;padding:8px 0 0;font-size:16px;font-weight:900;color:#1a5c2a;border-top:2px solid #1a5c2a;margin-top:4px}
  .sign-box{border:1px solid #e5e7eb;border-radius:6px;padding:12px 16px;min-width:180px;text-align:center}
  .sign-line{border-top:1px solid #555;margin-top:30px;padding-top:5px;font-size:10px;color:#666}
  .notes{margin-top:14px;font-size:10px;color:#666;padding:10px 12px;background:#f9fafb;border-radius:6px;line-height:1.7;border-left:3px solid #1a5c2a}
  .footer{margin-top:16px;padding-top:10px;border-top:1px dashed #ccc;font-size:10px;color:#aaa;text-align:center;line-height:1.7}
</style></head><body>
  <div class="hdr">
    <div style="display:flex;align-items:center;gap:12px">
      <img src="https://admin.sathvam.in/logo.jpg" alt="Sathvam" style="height:60px;width:auto;object-fit:contain"/>
      <div>
      <div class="co-name">Sathvam Oils and Spices Pvt Ltd</div>
      <div class="co-sub">
        Plot No. 6, Anand Jothi Nagar, Near ABS Hospital, Thanthoni, Tamil Nadu 639005<br>
        GSTIN: <strong>33ABFCS9387K1ZN</strong> &nbsp;|&nbsp; PAN: ABFCS9387K<br>
        Phone: +91 70921 77092 &nbsp;|&nbsp; Email: sales@sathvam.in<br>
        Website: www.sathvam.in
      </div>
      </div>
    </div>
    <div class="inv-right">
      <div class="inv-title">TAX INVOICE</div>
      <div class="inv-meta">
        Invoice No: <strong>${orderNo}</strong><br>
        Invoice Date: <strong>${o.date}</strong><br>
        Supply Type: <strong>${isIntra ? 'Intra-State (TN)' : 'Inter-State'}</strong>
      </div>
      <div><span class="paid-badge">✓ PAID</span></div>
    </div>
  </div>

  <div class="section">
    <div class="sec-box">
      <div class="sec-title">Bill To &amp; Ship To</div>
      <div class="sec-val">
        <strong style="font-size:13px">${name}</strong><br>
        ${addr}<br>${city}${state ? `, ${state}` : ''} — ${pin}<br>
        Ph: <strong>${phone}</strong>${email ? `<br>Email: ${email}` : ''}
      </div>
    </div>
    <div class="sec-box">
      <div class="sec-title">Order &amp; Payment Info</div>
      <div class="sec-val">
        Order No: <strong>${orderNo}</strong><br>
        Order Date: ${o.date}<br>
        Payment: <strong>${payMethod === 'cod' ? 'Cash on Delivery' : payMethod.toUpperCase()}</strong><br>
        Status: <strong style="color:#16a34a">Paid &amp; Confirmed</strong><br>
        Channel: sathvam.in
        ${o.courier ? `<br>Courier: ${o.courier}${o.awb_number ? ` / AWB: ${o.awb_number}` : ''}` : ''}
      </div>
    </div>
  </div>

  <table>
    <thead><tr>
      <th style="text-align:center">#</th>
      <th>Item Description</th>
      <th style="text-align:center">HSN</th>
      <th style="text-align:center">Qty</th>
      <th style="text-align:right">Unit Rate</th>
      <th style="text-align:right">Taxable Amt</th>
      <th style="text-align:center">GST%</th>
      ${gstHeader}
      <th style="text-align:right">Total</th>
    </tr></thead>
    <tbody>${itemRows}</tbody>
  </table>

  <div class="bottom">
    <div>
      <div class="notes">
        <strong>Payment Terms:</strong> Paid in full online via sathvam.in<br>
        <strong>Note:</strong> Goods once sold will not be taken back unless defective.<br>
        <strong>Subject to:</strong> Karur Jurisdiction
      </div>
      <div style="margin-top:10px;display:flex;align-items:center;gap:10px">
        <img src="${qrUrl}" alt="QR" width="90" height="90" style="border:1px solid #e5e7eb;border-radius:4px"/>
        <div style="font-size:9px;color:#888">Scan to verify<br>invoice details</div>
      </div>
    </div>
    <div>
      <div class="totals">
        <div class="tot-row"><span>Taxable Amount</span><span>₹${taxableTotal.toFixed(2)}</span></div>
        ${gstSummaryRows}
        <div class="tot-row"><span>Shipping Charges</span><span>₹${shipping.toFixed(2)}</span></div>
        <div class="tot-taxable"><span>Grand Total (Rounded)</span><span>₹${total.toFixed(2)}</span></div>
        <div class="tot-final"><span>AMOUNT PAID</span><span>₹${total.toFixed(2)}</span></div>
      </div>
      <div class="sign-box" style="margin-top:14px">
        <div style="font-size:10px;color:#555;margin-bottom:4px"><strong>For Sathvam Oils and Spices Pvt Ltd</strong></div>
        <div class="sign-line">Authorised Signatory</div>
      </div>
    </div>
  </div>

  <div class="footer">
    This is a computer-generated tax invoice and does not require a physical signature.<br>
    Thank you for shopping with Sathvam! &nbsp;|&nbsp; Queries: +91 70921 77092 &nbsp;|&nbsp; sales@sathvam.in
  </div>
  ${autoPrint ? '<script>window.onload=()=>{setTimeout(()=>window.print(),500);}<\/script>' : ''}
</body></html>`;
}

// POST /api/webstore-orders/:id/send-invoice — send invoice to customer via email
router.post('/:id/send-invoice', auth, async (req, res) => {
  try {
    const { data: o, error } = await supabase
      .from('webstore_orders').select('*').eq('id', req.params.id).single();
    if (error || !o) return res.status(404).json({ error: 'Order not found' });

    const cust  = o.customer || {};
    const email = cust.email || '';
    if (!email) return res.status(400).json({ error: 'Customer has no email address' });

    const html = buildInvoiceHtml(o, false);
    await mailer.sendMail({
      from:    process.env.SMTP_FROM || 'Sathvam Oils <sales@sathvam.in>',
      replyTo: process.env.SMTP_REPLY_TO || 'sales@sathvam.in',
      to:      email,
      subject: `Your Invoice ${o.order_no} — Sathvam Oils & Spices`,
      html,
    });
    res.json({ success: true });
  } catch (e) {
    console.error('Send invoice email error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const reviewLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: 'Too many review submissions. Please try again later.' },
  validate: { xForwardedForHeader: false },
});

// Admin: list all webstore orders
router.get('/', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('webstore_orders')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(2000);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── Status-change notification helpers ───────────────────────────────────────
const STATUS_LABELS = {
  confirmed:  'Order Confirmed ✅',
  packed:     'Order Packed 📦',
  dispatched: 'Order Dispatched 🚚',
  delivered:  'Order Delivered 🎉',
  cancelled:  'Order Cancelled ❌',
};

async function sendStatusEmail(order, newStatus, cancelReason) {
  const cust  = order.customer || {};
  const email = cust.email || '';
  if (!email || !process.env.SMTP_USER) return;

  const label    = STATUS_LABELS[newStatus] || newStatus;
  const orderNo  = order.order_no || order.orderNo || '';
  const courier  = order.courier  || '';
  const awb      = order.awb_number || '';
  const trackLine = (newStatus === 'dispatched' && (courier || awb))
    ? `<p style="margin:8px 0;font-size:14px;color:#374151">🚚 <strong>Courier:</strong> ${courier} &nbsp;|&nbsp; <strong>AWB:</strong> ${awb}</p>`
    : '';

  const cancelMsg = cancelReason
    ? `Your order has been cancelled.<br><strong>Reason:</strong> ${cancelReason}<br><br>If you have paid online, your refund will be processed within 5–7 business days. For questions, contact us at sales@sathvam.in.`
    : `Your order has been cancelled. If you have questions, please contact us at sales@sathvam.in.`;

  const msgMap = {
    confirmed:  `We've confirmed your order and it's being prepared for packing.`,
    packed:     `Your order is packed and will be handed to the courier shortly.`,
    dispatched: `Your order is on its way! ${courier ? `It's with ${courier}` : ''} ${awb ? `(AWB: ${awb})` : ''}.`.trim(),
    delivered:  `Your order has been delivered. We hope you love it! 🌿`,
    cancelled:  cancelMsg,
  };

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#2d1a0e,#5c3317);padding:24px 32px">
        <div style="color:#f5a800;font-size:20px;font-weight:900;letter-spacing:2px">SATHVAM</div>
        <div style="color:rgba(255,255,255,0.7);font-size:12px;margin-top:4px">Order Update</div>
      </div>
      <div style="padding:28px 32px">
        <div style="font-size:18px;font-weight:800;color:#1f2937;margin-bottom:12px">${label}</div>
        <p style="margin:0 0 16px;font-size:14px;color:#374151">Hi ${cust.name || 'there'},</p>
        <p style="margin:0 0 16px;font-size:14px;color:#374151">${msgMap[newStatus] || `Your order status has been updated to <strong>${newStatus}</strong>.`}</p>
        ${trackLine}
        <div style="background:#f9fafb;border-radius:8px;padding:14px 18px;margin:20px 0;font-size:13px;color:#6b7280">
          Order: <strong style="color:#1f2937">${orderNo}</strong>
        </div>
        <p style="font-size:13px;color:#9ca3af;margin:0">Questions? Reply to this email or WhatsApp us at +91 70921 77092.</p>
      </div>
      <div style="background:#f9fafb;padding:14px 32px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af">
        Sathvam Natural Products · export@sathvam.in · +91 70921 77092
      </div>
    </div>`;

  try {
    await mailer.sendMail({
      from:    process.env.SMTP_FROM    || 'Sathvam Natural Products <noreply@sathvam.in>',
      replyTo: process.env.SMTP_REPLY_TO || 'sales@sathvam.in',
      to:      email,
      subject: `${label} — Order ${orderNo}`,
      html,
    });
  } catch (e) {
    console.error('Status email error:', e.message);
  }
}

async function sendStatusWhatsApp(order, newStatus, cancelReason) {
  const phoneId = process.env.WA_PHONE_NUMBER_ID;
  const token   = process.env.WA_ACCESS_TOKEN;
  if (!phoneId || !token) return;

  const cust  = order.customer || {};
  const phone = (cust.phone || '').replace(/\D/g, '');
  if (!phone) return;

  const orderNo = order.order_no || order.orderNo || '';
  const courier = order.courier  || '';
  const awb     = order.awb_number || '';

  const cancelText = cancelReason
    ? `❌ *Order Cancelled*\n\nHi ${cust.name || 'there'}, your order *${orderNo}* has been cancelled.\n📋 *Reason:* ${cancelReason}\n\nIf paid online, refund will be processed in 5–7 business days.\nQuestions? WhatsApp +91 70921 77092.`
    : `❌ *Order Cancelled*\n\nHi ${cust.name || 'there'}, your order *${orderNo}* has been cancelled. Questions? Email sales@sathvam.in or WhatsApp +91 70921 77092.`;

  const msgMap = {
    confirmed:  `✅ *Order Confirmed!*\n\nHi ${cust.name || 'there'}, your Sathvam order *${orderNo}* is confirmed and being packed.\n\nFor help: +91 70921 77092`,
    packed:     `📦 *Order Packed!*\n\nHi ${cust.name || 'there'}, your order *${orderNo}* is packed and ready for dispatch soon.\n\nFor help: +91 70921 77092`,
    dispatched: `🚚 *Order Dispatched!*\n\nHi ${cust.name || 'there'}, your order *${orderNo}* is on its way!${courier ? `\nCourier: ${courier}` : ''}${awb ? `\nAWB: ${awb}` : ''}\n\nFor help: +91 70921 77092`,
    delivered:  `🎉 *Order Delivered!*\n\nHi ${cust.name || 'there'}, your Sathvam order *${orderNo}* has been delivered. Enjoy the goodness! 🌿\n\nFor help: +91 70921 77092`,
    cancelled:  cancelText,
  };

  const text = msgMap[newStatus];
  if (!text) return;

  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to:   phone,
        type: 'text',
        text: { body: text },
      }),
    });
    const data = await res.json();
    if (!res.ok) console.error('WA status notify error:', data?.error?.message);
  } catch (e) {
    console.error('WA status notify error:', e.message);
  }
}

// Admin: update order status + dispatch info
async function updateOrder(req, res) {
  const { status, notes, courier, awb_number, dispatch_date, delivered_date, cancel_reason } = req.body;
  const updates = {};
  if (status         !== undefined) updates.status         = status;
  if (notes          !== undefined) updates.notes          = notes;
  if (courier        !== undefined) updates.courier        = courier;
  if (awb_number     !== undefined) updates.awb_number     = awb_number;
  if (dispatch_date  !== undefined) updates.dispatch_date  = dispatch_date;
  if (delivered_date !== undefined) updates.delivered_date = delivered_date;
  if (cancel_reason  !== undefined) updates.cancel_reason  = cancel_reason;
  const { data, error } = await supabase
    .from('webstore_orders')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });

  // Fire-and-forget notifications when status changes
  if (status && data) {
    setImmediate(async () => {
      await sendStatusEmail(data, status, cancel_reason);
      await sendStatusWhatsApp(data, status, cancel_reason);
    });
  }

  res.json(data);
}
router.put('/:id',   auth, updateOrder);
router.patch('/:id', auth, updateOrder);

// Bulk insert — used once to migrate existing localStorage data
router.post('/bulk', auth, async (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : [];
  if (rows.length === 0) return res.json({ synced: 0 });
  const ins = rows.map(o => ({
    id:       o.id,
    order_no: o.orderNo || o.order_no || '',
    date:     o.date || new Date().toISOString().slice(0, 10),
    customer: o.customer || {},
    items:    o.items || [],
    subtotal: parseFloat(o.subtotal) || 0,
    gst:      parseFloat(o.gst) || 0,
    shipping: parseFloat(o.shipping) || 0,
    total:    parseFloat(o.total) || 0,
    status:   o.status || 'confirmed',
    channel:  o.channel || 'website',
  }));
  const { data, error } = await supabase.from('webstore_orders').upsert(ins, { onConflict: 'id' }).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ synced: (data || []).length });
});

// Public: look up order status by order_no + phone (customer self-serve)
router.get('/status', async (req, res) => {
  const { order_no, phone } = req.query;
  if (!order_no || !phone) return res.status(400).json({ error: 'order_no and phone required' });
  const { data, error } = await supabase
    .from('webstore_orders')
    .select('id,order_no,status,delivered_date,items,customer')
    .ilike('order_no', order_no.trim())
    .single();
  if (error || !data) return res.status(404).json({ error: 'Order not found' });
  const orderPhone = (data.customer?.phone || '').replace(/\D/g,'');
  const inputPhone = phone.trim().replace(/\D/g,'');
  if (!orderPhone.endsWith(inputPhone.slice(-10)) && !inputPhone.endsWith(orderPhone.slice(-10)))
    return res.status(403).json({ error: 'Phone number does not match' });
  res.json({ id: data.id, order_no: data.order_no, status: data.status, delivered_date: data.delivered_date, items: data.items });
});

// ── Product Reviews ──────────────────────────────────────────────────────────

// GET /api/webstore-orders/reviews — list all reviews (admin)
router.get('/reviews', auth, async (req, res) => {
  try {
    const { product_id, status, limit = 200 } = req.query;
    let q = supabase.from('product_reviews')
      .select('*').order('created_at', { ascending: false }).limit(parseInt(limit));
    if (product_id) q = q.eq('product_id', product_id);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/webstore-orders/reviews/public/:product_id — public approved reviews
router.get('/reviews/public/:product_id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('product_reviews')
      .select('id,reviewer_name,rating,title,body,created_at')
      .eq('product_id', req.params.product_id)
      .eq('status', 'approved')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/webstore-orders/reviews/verify-purchase — check order before allowing review
router.post('/reviews/verify-purchase', reviewLimiter, async (req, res) => {
  try {
    const { order_no } = req.body;
    if (!order_no || !order_no.trim()) return res.status(400).json({ error: 'Order number required' });
    const { data, error } = await supabase.from('webstore_orders')
      .select('order_no, customer, items, status')
      .eq('order_no', order_no.trim().toUpperCase())
      .single();
    if (error || !data) return res.status(404).json({ error: 'Order not found. Please check your order number.' });
    if (!['confirmed','dispatched','delivered'].includes(data.status)) {
      return res.status(400).json({ error: 'Only delivered or confirmed orders can be reviewed.' });
    }
    res.json({
      valid: true,
      customer_name: data.customer?.name || '',
      items: (data.items || []).map(i => ({ id: i.id, name: i.name })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/webstore-orders/reviews — submit review (verified purchase only)
router.post('/reviews', reviewLimiter, async (req, res) => {
  try {
    const { product_id, product_name, order_no, reviewer_name, reviewer_email, rating, title, body } = req.body;
    if (!product_id || !rating || !reviewer_name || !order_no) return res.status(400).json({ error: 'product_id, rating, reviewer_name, order_no required' });
    if (reviewer_name.length > 100) return res.status(400).json({ error: 'Name too long' });
    if (title && title.length > 200) return res.status(400).json({ error: 'Title too long' });
    if (body && body.length > 2000) return res.status(400).json({ error: 'Review too long' });

    // Verify the order exists and is from a real customer
    const { data: order } = await supabase.from('webstore_orders')
      .select('order_no, status').eq('order_no', order_no.trim().toUpperCase()).single();
    if (!order) return res.status(400).json({ error: 'Invalid order number.' });

    // Prevent duplicate review for same order + product
    const { data: existing } = await supabase.from('product_reviews')
      .select('id').eq('order_id', order_no.trim().toUpperCase()).eq('product_id', product_id).single();
    if (existing) return res.status(400).json({ error: 'You have already reviewed this product.' });

    const { data, error } = await supabase.from('product_reviews')
      .insert({ product_id, product_name: product_name || '', order_id: order_no.trim().toUpperCase(), reviewer_name, reviewer_email: reviewer_email || '', rating: Math.min(5, Math.max(1, parseInt(rating))), title: title || '', body: body || '', status: 'pending' })
      .select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/webstore-orders/reviews/:id — approve/reject (admin)
router.patch('/reviews/:id', auth, async (req, res) => {
  try {
    const { status, admin_reply } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (status !== undefined) updates.status = status;
    if (admin_reply !== undefined) updates.admin_reply = admin_reply;
    const { data, error } = await supabase.from('product_reviews')
      .update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Customer CRM ─────────────────────────────────────────────────────────────

// GET /api/webstore-orders/crm — customer list with order stats
router.get('/crm', auth, async (req, res) => {
  try {
    const { data: orders, error } = await supabase.from('webstore_orders')
      .select('customer_name,customer_phone,customer_email,total_amount,status,created_at')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    const customers = {};
    for (const o of orders || []) {
      const key = o.customer_phone || o.customer_email || o.customer_name;
      if (!key) continue;
      if (!customers[key]) {
        customers[key] = { name: o.customer_name, phone: o.customer_phone, email: o.customer_email, orders: 0, total_spent: 0, first_order: o.created_at, last_order: o.created_at };
      }
      customers[key].orders++;
      if (o.status !== 'cancelled') customers[key].total_spent += (o.total_amount || 0);
      if (o.created_at > customers[key].last_order) customers[key].last_order = o.created_at;
      if (o.created_at < customers[key].first_order) customers[key].first_order = o.created_at;
    }
    const list = Object.values(customers).sort((a, b) => b.total_spent - a.total_spent);
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Exported helper: send order confirmation + invoice email to customer ───────
async function sendCustomerInvoice(order, paymentId) {
  const cust  = order.customer || {};
  const email = cust.email || order.email;
  if (!email) return; // no email — skip silently
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  try {
    const html = buildInvoiceHtml(order, false);
    await mailer.sendMail({
      from:    process.env.SMTP_FROM || 'Sathvam Natural Products <noreply@sathvam.in>',
      replyTo: process.env.SMTP_REPLY_TO || 'sales@sathvam.in',
      to:      email,
      subject: `Your Order Confirmation — ${order.orderNo || order.order_no} 🌿`,
      html: `<div style="font-family:sans-serif;max-width:640px;margin:0 auto">
  <div style="background:linear-gradient(135deg,#1a5c2a,#2d7a3a);color:#fff;padding:20px 28px;border-radius:10px 10px 0 0;text-align:center">
    <div style="font-size:32px;margin-bottom:6px">🌿</div>
    <h2 style="margin:0;font-size:20px">Order Confirmed!</h2>
    <div style="opacity:.85;font-size:13px;margin-top:4px">Thank you for choosing Sathvam Natural Products</div>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:20px 28px;background:#fffdf7;border-radius:0 0 10px 10px">
    <p style="color:#1f2937;font-size:15px;margin-top:0">Hi <strong>${cust.name || 'there'}</strong>! 👋</p>
    <p style="color:#374151;font-size:14px;line-height:1.6">
      Your order <strong>#${order.orderNo || order.order_no}</strong> has been placed successfully and will be dispatched within 1–2 business days.
      ${paymentId ? `<br><span style="color:#6b7280;font-size:12px">Payment ID: ${paymentId}</span>` : ''}
    </p>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px 16px;margin:16px 0;font-size:13px;color:#166534">
      📦 We'll send you a WhatsApp/SMS update once your order is dispatched with tracking details.
    </div>
    <p style="color:#374151;font-size:13px">Your invoice is attached below for reference:</p>
  </div>
</div>
<div style="margin-top:16px">${html}</div>`,
    });
  } catch (e) { console.error('Customer invoice email error:', e.message); }
}

module.exports = router;
module.exports.sendCustomerInvoice = sendCustomerInvoice;
