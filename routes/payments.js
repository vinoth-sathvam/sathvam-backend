const express      = require('express');
const Razorpay     = require('razorpay');
const crypto       = require('crypto');
const nodemailer   = require('nodemailer');
const supabase     = require('../config/supabase');
const { createInvoice, recordPayment } = require('../config/zoho');
const { sendCustomerInvoice } = require('./webstoreOrders');
const { auth, requireRole } = require('../middleware/auth');
const { encrypt, hmac, encryptCustomer } = require('../config/crypto');

// ── Email transporter ─────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// ── Sequential order number generator ────────────────────────────────────────
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
async function generateOrderNo() {
  const today = new Date().toISOString().slice(0, 10);
  const d = new Date();
  const prefix = `SA${d.getFullYear()}${MONTHS[d.getMonth()]}${String(d.getDate()).padStart(2, '0')}`;
  const [s, w] = await Promise.all([
    supabase.from('sales').select('id', { count: 'exact', head: true }).eq('date', today),
    supabase.from('webstore_orders').select('id', { count: 'exact', head: true }).eq('date', today),
  ]);
  const seq = (s.count || 0) + (w.count || 0) + 1;
  return `${prefix}-${String(seq).padStart(2, '0')}`;
}

// ── Order email alert ─────────────────────────────────────────────────────────
async function sendOrderEmail(order, paymentId) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return; // skip if not configured
  const cust  = order.customer || {};
  const items = (order.items || []).map(i => `<tr><td style="padding:4px 8px">${i.name}</td><td style="padding:4px 8px;text-align:center">${i.qty}</td><td style="padding:4px 8px;text-align:right">₹${((i.qty||1)*(i.price||0)).toLocaleString('en-IN')}</td></tr>`).join('');
  const html = `
<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
  <div style="background:#1a5c2a;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0">
    <h2 style="margin:0">🛒 New Order — ${order.orderNo}</h2>
  </div>
  <div style="border:1px solid #ddd;border-top:none;padding:20px 24px;border-radius:0 0 8px 8px">
    <p><strong>Customer:</strong> ${cust.name || 'Guest'}<br>
    <strong>Phone:</strong> ${cust.phone || '—'}<br>
    <strong>Address:</strong> ${[cust.address, cust.city, cust.state, cust.pincode].filter(Boolean).join(', ')}</p>
    <table style="width:100%;border-collapse:collapse;margin:12px 0">
      <thead><tr style="background:#f5f5f5"><th style="padding:4px 8px;text-align:left">Item</th><th style="padding:4px 8px">Qty</th><th style="padding:4px 8px;text-align:right">Amount</th></tr></thead>
      <tbody>${items}</tbody>
    </table>
    <p style="text-align:right"><strong>Subtotal:</strong> ₹${parseFloat(order.subtotal||0).toLocaleString('en-IN')}<br>
    <strong>GST:</strong> ₹${parseFloat(order.gst||0).toLocaleString('en-IN')}<br>
    <strong>Shipping:</strong> ₹${parseFloat(order.shipping||0).toLocaleString('en-IN')}<br>
    <strong style="font-size:1.1em">Total: ₹${parseFloat(order.total||0).toLocaleString('en-IN')}</strong></p>
    <p style="color:#888;font-size:0.85em">Razorpay ID: ${paymentId}</p>
  </div>
</div>`;

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || 'Sathvam Exports <noreply@sathvam.in>',
      to:   'vinoth@sathvam.in',
      subject: `New Order ${order.orderNo} — ₹${parseFloat(order.total||0).toLocaleString('en-IN')}`,
      html,
    });
  } catch (e) { console.error('Order email failed:', e.message); }
}

// ── BotSailor send helper ─────────────────────────────────────────────────────
const SATHVAM_LOGO_URL = 'https://sathvam.in/logo.jpg';

async function sendViaBotSailor(phone, message, imageUrl = SATHVAM_LOGO_URL) {
  const token   = process.env.BOTSAILOR_API_TOKEN;
  const phoneId = process.env.BOTSAILOR_PHONE_NUMBER_ID || process.env.WA_PHONE_NUMBER_ID;
  if (!token || !phoneId) return false;
  const res = imageUrl
    ? await fetch('https://botsailor.com/api/v1/whatsapp/send', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ apiToken: token, phone_number_id: phoneId, phone_number: phone, type: 'image', url: imageUrl, message }),
      })
    : await fetch('https://botsailor.com/api/v1/whatsapp/send', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({ apiToken: token, phone_number_id: phoneId, phone_number: phone, message }).toString(),
      });
  const data = await res.json();
  return data.status === '1' || data.status === 1;
}

// ── WhatsApp order alert (to admin) ──────────────────────────────────────────
async function sendWhatsAppAlert(order) {
  // Notify all configured admin numbers
  const adminNumbers = [
    process.env.WA_NOTIFY_TO,
    process.env.WA_ADMIN_PHONE1,
    process.env.WA_ADMIN_PHONE2,
  ].filter(Boolean).map(n => n.replace(/\D/g, '')).filter((v, i, a) => v && a.indexOf(v) === i);

  if (!adminNumbers.length) return;

  const cust  = order.customer || {};
  const items = (order.items || []).map(i => `• ${i.name} × ${i.qty}`).join('\n');
  const text  =
    `🛒 *New Webstore Order — ${order.orderNo || order.order_no}*\n\n` +
    `👤 *${cust.name || 'Guest'}*\n` +
    `📞 ${cust.phone || '—'}\n` +
    `📍 ${[cust.city, cust.state, cust.pincode].filter(Boolean).join(', ')}\n\n` +
    `📋 *Items:*\n${items}\n\n` +
    `💰 *Total: ₹${parseFloat(order.total || 0).toLocaleString('en-IN')}*` +
    `${order.shipping ? `  |  🚚 Shipping: ₹${order.shipping}` : ''}\n` +
    `✅ Payment: ${order.paymentId || order.payment_id || 'Online'}\n\n` +
    `📦 Action: admin.sathvam.in → Webstore Orders`;

  for (const phone of adminNumbers) {
    try { await sendViaBotSailor(phone, text); } catch (e) { console.error('Admin WA alert failed:', e.message); }
  }
}

// ── WhatsApp order confirmation to customer ───────────────────────────────────
async function sendCustomerOrderWhatsApp(order) {
  const cust  = order.customer || {};
  const phone = (cust.phone || '').replace(/\D/g, '');
  if (!phone) return;

  const firstName = (cust.name || '').split(' ')[0] || 'அன்பான வாடிக்கையாளர்';
  const items = (order.items || []).map(i => `  • ${i.name} × ${i.qty}`).join('\n');

  const firstOrderBonus = order.isFirstOrder
    ? `\n🎉 *முதல் ஆர்டர் சிறப்பு!*\n` +
      `_Welcome to Sathvam family! 🌱_\n` +
      `உங்கள் அடுத்த ஆர்டருக்கு *WELCOME5* என்று குறிப்பிட்டு ₹50 சேமிக்கலாம்!\n` +
      `_Use code *WELCOME5* on your next order and save ₹50!_\n`
    : '';

  const text  =
    `🌿 *சத்துவம் இயற்கை உணவுகள்*\n` +
    `_Sathvam Natural Products_\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `✅ *ஆர்டர் உறுதிப்படுத்தப்பட்டது!*\n` +
    `_Order Confirmed & Payment Received!_\n\n` +
    `வணக்கம் ${firstName}! 🙏\n` +
    `_Dear ${cust.name || 'Valued Customer'}, thank you for choosing Sathvam!_\n` +
    firstOrderBonus + `\n` +
    `📋 *ஆர்டர் எண்:* ${order.orderNo}\n` +
    `💳 *கட்டணம்:* ₹${parseFloat(order.total || 0).toLocaleString('en-IN')} பெறப்பட்டது\n` +
    `_Payment of ₹${parseFloat(order.total || 0).toLocaleString('en-IN')} received_\n\n` +
    `*📦 ஆர்டர் விவரங்கள் | Order Details:*\n${items}\n\n` +
    `📍 *டெலிவரி முகவரி:*\n${[cust.address, cust.city, cust.state, cust.pincode].filter(Boolean).join(', ')}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `🚚 உங்கள் ஆர்டர் அனுப்பப்படும்போது தகவல் தெரிவிக்கப்படும்.\n` +
    `_We'll notify you once your order is dispatched._\n\n` +
    `❓ கேள்விகளா? | Questions?\n` +
    `📞 *+91 70921 77092*\n` +
    `🌐 sathvam.in`;

  try {
    const ok = await sendViaBotSailor(phone, text);
    if (!ok) console.error('Customer WA confirmation: BotSailor returned non-success for', phone.slice(0,4)+'****'+phone.slice(-3));
  } catch (e) {
    console.error('Customer WA confirmation error:', e.message);
  }
}

const router = express.Router();

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// POST /api/payments/create-order
// Frontend calls this to create a Razorpay order before showing checkout modal
router.post('/create-order', async (req, res) => {
  try {
    const { amount, orderNo } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const rzpOrder = await razorpay.orders.create({
      amount:   Math.round(parseFloat(amount) * 100), // paise
      currency: 'INR',
      receipt:  orderNo || `SW-${Date.now()}`,
      notes:    { source: 'sathvam.in' },
    });

    res.json({ orderId: rzpOrder.id, amount: rzpOrder.amount, currency: rzpOrder.currency });
  } catch (err) {
    console.error('Razorpay order create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/verify
// Called after Razorpay payment success to verify signature + save order
router.post('/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, order } = req.body;

    // Verify signature
    const body     = razorpay_order_id + '|' + razorpay_payment_id;
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
                           .update(body).digest('hex');

    if (expected !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed' });
    }

    // Verify the actual amount paid matches order total via Razorpay API
    try {
      const rzpPayment = await razorpay.payments.fetch(razorpay_payment_id);
      const paidAmount = rzpPayment.amount / 100; // paise → rupees
      // chargedAmount = what Razorpay actually charged (cartFinal, before loyalty discount)
      const chargedAmount = parseFloat(order?.total || 0) + parseFloat(order?.loyalty_discount || 0);
      if (Math.abs(paidAmount - chargedAmount) > 1) { // allow ₹1 rounding tolerance
        console.error(`Amount mismatch: paid ₹${paidAmount}, charged ₹${chargedAmount} (order ₹${order?.total} + loyalty ₹${order?.loyalty_discount||0})`);
        return res.status(400).json({ error: 'Payment amount mismatch' });
      }
    } catch (amtErr) {
      console.error('Amount verification error:', amtErr.message);
      // Non-blocking: continue if Razorpay API is unavailable — signature already verified
    }

    // Save webstore order — encrypt customer PII before storing
    const o = order;
    const rawCustomer = o.customer || {};
    const encCustomer = encryptCustomer(rawCustomer);
    const custEmailHash = hmac(rawCustomer.email || '');
    const dbId = crypto.randomUUID(); // always use a proper UUID for the DB row
    const generatedOrderNo = await generateOrderNo();
    const { error: wsErr } = await supabase.from('webstore_orders').upsert({
      id:                  dbId,
      order_no:            generatedOrderNo,
      date:                o.date || new Date().toISOString().slice(0, 10),
      customer:            encCustomer,
      customer_email_hash: custEmailHash,
      items:               o.items || [],
      subtotal:            parseFloat(o.subtotal) || 0,
      gst:                 parseFloat(o.gst) || 0,
      shipping:            parseFloat(o.shipping) || 0,
      total:               parseFloat(o.total) || 0,
      status:              'confirmed',
      payment_status:      'paid',
      channel:             'website',
      notes:               `Razorpay: ${razorpay_payment_id}`,
    }, { onConflict: 'id' });
    if (wsErr) {
      console.error('Webstore order save error:', wsErr.message, 'order_no:', generatedOrderNo, 'payment:', razorpay_payment_id);
      return res.status(500).json({ error: 'Order save failed: ' + wsErr.message });
    }

    // Save factory sale — encrypt customer PII
    const customer = o.customer || {};
    const addrNote = `${customer.address || ''}, ${customer.city || ''}, ${customer.state || ''} - ${customer.pincode || ''}`;
    const { data: sale } = await supabase.from('sales').insert({
      order_no:       generatedOrderNo,
      date:           o.date || new Date().toISOString().slice(0, 10),
      channel:        'website',
      status:         'pending',
      customer_name:  encrypt(customer.name  || ''),
      customer_phone: encrypt(customer.phone || ''),
      total_amount:   parseFloat(o.subtotal) || 0,
      discount:       0,
      final_amount:   parseFloat(o.total) || 0,
      amount_paid:    parseFloat(o.total) || 0,
      payment_method: 'online',
      notes:          encrypt(`${addrNote} | Razorpay: ${razorpay_payment_id}`),
    }).select().single();

    if (sale && Array.isArray(o.items) && o.items.length > 0) {
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

    // Non-blocking: WhatsApp alert + Zoho invoice + customer confirmation + finished goods
    setImmediate(async () => {
      // WhatsApp + email notifications to owner
      await sendWhatsAppAlert({ ...o, paymentId: razorpay_payment_id });
      await sendOrderEmail(o, razorpay_payment_id);

      // Detect first-time customer (count orders with same email hash)
      let isFirstOrder = false;
      if (custEmailHash) {
        const { count } = await supabase.from('webstore_orders')
          .select('id', { count: 'exact', head: true })
          .eq('customer_email_hash', custEmailHash);
        isFirstOrder = (count || 0) <= 1; // just saved = 1 means first order
      }

      // WhatsApp confirmation to customer (first-order gets special message)
      await sendCustomerOrderWhatsApp({ ...o, orderNo: generatedOrderNo, isFirstOrder });

      // Invoice/confirmation email to customer
      await sendCustomerInvoice({ ...o, orderNo: generatedOrderNo }, razorpay_payment_id);

      // Zoho Books invoice
      try {
        const invoice = await createInvoice(o);
        if (invoice?.invoice_id) {
          await recordPayment(invoice, o.total, 'online', razorpay_payment_id);
        }
      } catch (ze) {
        console.error('Zoho invoice error:', ze.message);
      }

      // Auto-deduct from finished goods
      try {
        const fgItems = (o.items || []).filter(i => parseFloat(i.qty) > 0);
        if (fgItems.length) {
          await supabase.from('finished_goods').insert(
            fgItems.map(i => ({
              product_name: i.name || '',
              category:     'other',
              unit:         'pcs',
              qty:          parseFloat(i.qty),
              type:         'out',
              date:         o.date || new Date().toISOString().slice(0, 10),
              notes:        `Auto: Webstore order ${o.orderNo}`,
              batch_ref:    o.orderNo || '',
              created_by:   'system',
              created_at:   new Date().toISOString(),
              updated_at:   new Date().toISOString(),
            }))
          );
        }
      } catch (fgErr) {
        console.error('Finished goods webstore deduction error:', fgErr.message);
      }
    });

    res.json({ success: true, paymentId: razorpay_payment_id, orderNo: generatedOrderNo });
  } catch (err) {
    console.error('Payment verify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Helper: actually call Razorpay and mark order refunded
async function executeRefund(order, reason, approvedBy) {
  const match = (order.notes || '').match(/Razorpay:\s*(pay_\S+)/);
  if (!match) throw new Error('No Razorpay payment ID found on this order');
  const paymentId = match[1];

  const refund = await razorpay.payments.refund(paymentId, {
    amount: Math.round(parseFloat(order.total) * 100),
    speed:  'normal',
    notes:  { order_no: order.order_no, reason: reason || 'Customer cancellation', approved_by: approvedBy || '' },
  });

  const orderStatus = refund.status === 'processed' ? 'refunded' : 'refund_initiated';
  await supabase.from('webstore_orders').update({
    status:                orderStatus,
    refund_id:             refund.id,
    refund_status:         refund.status,
    refund_approval_status:'approved',
    notes:                 (order.notes || '') + ` | Refund: ${refund.id}`,
  }).eq('id', order.id);

  console.log(`Refund initiated: ${refund.id} for order ${order.order_no} ₹${order.total} by ${approvedBy}`);
  return { refund_id: refund.id, status: refund.status, order_status: orderStatus };
}

// POST /api/payments/refund
// Manager → queues for approval; Admin/CEO → executes immediately
router.post('/refund', auth, async (req, res) => {
  try {
    const { orderId, reason } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId required' });

    const { data: order, error: fetchErr } = await supabase
      .from('webstore_orders')
      .select('id, order_no, total, status, notes, refund_id, refund_approval_status')
      .eq('id', orderId)
      .single();

    if (fetchErr || !order) return res.status(404).json({ error: 'Order not found' });
    if (order.refund_id)    return res.status(400).json({ error: 'Refund already initiated', refund_id: order.refund_id });

    const role = req.user?.role;
    const name = req.user?.name || req.user?.username || 'Unknown';

    // Manager: queue for approval
    if (role === 'manager' || role === 'hr') {
      await supabase.from('webstore_orders').update({
        status:                'refund_pending_approval',
        refund_approval_status:'pending',
        cancel_reason:         reason || order.cancel_reason || 'Customer cancellation',
        notes:                 (order.notes || '') + ` | Refund requested by ${name}`,
      }).eq('id', orderId);
      console.log(`Refund approval requested for order ${order.order_no} by ${name}`);
      return res.json({ success: true, pending_approval: true, order_status: 'refund_pending_approval' });
    }

    // Admin/CEO: execute immediately
    const result = await executeRefund({ ...order, notes: (order.notes||'') }, reason, name);
    res.json({ success: true, ...result });
  } catch (err) {
    const msg = err.error?.description || err.message || (err.statusCode ? `Razorpay error ${err.statusCode}` : JSON.stringify(err));
    console.error('Refund error:', JSON.stringify(err));
    res.status(err.statusCode || 500).json({ error: msg });
  }
});

// POST /api/payments/approve-refund/:orderId
// Admin/CEO approves a manager's refund request → executes Razorpay refund
router.post('/approve-refund/:orderId', auth, requireRole('admin', 'ceo'), async (req, res) => {
  try {
    const { data: order, error: fetchErr } = await supabase
      .from('webstore_orders')
      .select('id, order_no, total, status, notes, refund_id, cancel_reason')
      .eq('id', req.params.orderId)
      .single();

    if (fetchErr || !order) return res.status(404).json({ error: 'Order not found' });
    if (order.refund_id)    return res.status(400).json({ error: 'Refund already initiated' });
    if (order.status !== 'refund_pending_approval') return res.status(400).json({ error: 'No pending refund approval for this order' });

    const approvedBy = req.user?.name || req.user?.username || 'Admin';
    const result = await executeRefund(order, order.cancel_reason, approvedBy);
    res.json({ success: true, ...result });
  } catch (err) {
    const msg = err.error?.description || err.message || (err.statusCode ? `Razorpay error ${err.statusCode}` : JSON.stringify(err));
    console.error('Approve refund error:', JSON.stringify(err));
    res.status(err.statusCode || 500).json({ error: msg });
  }
});

// POST /api/payments/reject-refund/:orderId
// Admin/CEO rejects a manager's refund request → status back to cancelled
router.post('/reject-refund/:orderId', auth, requireRole('admin', 'ceo'), async (req, res) => {
  try {
    const { reason } = req.body;
    const { data: order, error: fetchErr } = await supabase
      .from('webstore_orders')
      .select('id, order_no, status')
      .eq('id', req.params.orderId)
      .single();

    if (fetchErr || !order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'refund_pending_approval') return res.status(400).json({ error: 'No pending refund approval for this order' });

    const rejectedBy = req.user?.name || req.user?.username || 'Admin';
    await supabase.from('webstore_orders').update({
      status:                'cancelled',
      refund_approval_status:'rejected',
      notes:                 `Refund rejected by ${rejectedBy}${reason ? ': ' + reason : ''}`,
    }).eq('id', req.params.orderId);

    console.log(`Refund rejected for order ${order.order_no} by ${rejectedBy}`);
    res.json({ success: true, order_status: 'cancelled' });
  } catch (err) {
    console.error('Reject refund error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/partial-refund
// Cancel specific items and refund their amount via Razorpay
router.post('/partial-refund', auth, async (req, res) => {
  try {
    const { orderId, cancelItems, reason } = req.body;
    // cancelItems: [{ idx: 0, qty: 1 }, ...]  — index into items array, qty to cancel
    if (!orderId || !Array.isArray(cancelItems) || cancelItems.length === 0)
      return res.status(400).json({ error: 'orderId and cancelItems required' });

    const { data: order, error: fetchErr } = await supabase
      .from('webstore_orders')
      .select('id, order_no, total, status, notes, items, refund_id')
      .eq('id', orderId)
      .single();

    if (fetchErr || !order) return res.status(404).json({ error: 'Order not found' });
    if (order.refund_id) return res.status(400).json({ error: 'Full refund already initiated on this order' });

    // Get Razorpay payment ID from notes
    const match = (order.notes || '').match(/Razorpay:\s*(pay_\S+)/);
    if (!match) return res.status(400).json({ error: 'No Razorpay payment found on this order' });
    const paymentId = match[1];

    const items = order.items || [];

    // Calculate refund amount and validate
    let refundAmount = 0;
    const updatedItems = items.map((item, idx) => ({ ...item }));

    for (const ci of cancelItems) {
      const item = items[ci.idx];
      if (!item) return res.status(400).json({ error: `Item at index ${ci.idx} not found` });
      if (item.cancelled) return res.status(400).json({ error: `Item "${item.name}" already cancelled` });

      const itemQty   = parseFloat(item.qty) || 0;
      const cancelQty = Math.min(parseFloat(ci.qty) || itemQty, itemQty);
      const unitPrice = parseFloat(item.price || item.rate || 0);
      const lineRefund = parseFloat((unitPrice * cancelQty).toFixed(2));

      refundAmount += lineRefund;

      // Mark item as cancelled in the array
      updatedItems[ci.idx] = {
        ...item,
        cancelled:      cancelQty >= itemQty,
        cancelled_qty:  cancelQty,
        cancelled_at:   new Date().toISOString(),
        refund_amount:  lineRefund,
      };
    }

    if (refundAmount <= 0) return res.status(400).json({ error: 'Refund amount is zero' });

    // Check we're not refunding more than the order total
    const alreadyRefunded = items.reduce((s, it) => s + parseFloat(it.refund_amount || 0), 0);
    if (alreadyRefunded + refundAmount > parseFloat(order.total) + 1)
      return res.status(400).json({ error: `Refund ₹${refundAmount} exceeds remaining order value` });

    // Call Razorpay partial refund
    const refund = await razorpay.payments.refund(paymentId, {
      amount: Math.round(refundAmount * 100), // paise
      speed:  'normal',
      notes:  { order_no: order.order_no, reason: reason || 'Partial cancellation', items: cancelItems.map(ci => items[ci.idx]?.name).join(', ') },
    });

    // Determine new order status
    const allCancelled = updatedItems.every(it => it.cancelled || parseFloat(it.qty) === 0);
    const newStatus = allCancelled ? 'refund_initiated' : 'partial_refund';
    const byName = req.user?.name || req.user?.username || 'Admin';
    const noteAppend = ` | PartialRefund: ${refund.id} ₹${refundAmount} (${cancelItems.map(ci => `${updatedItems[ci.idx]?.cancelled_qty}x ${items[ci.idx]?.name}`).join(', ')}) by ${byName}`;

    await supabase.from('webstore_orders').update({
      items:  updatedItems,
      status: newStatus,
      notes:  (order.notes || '') + noteAppend,
    }).eq('id', orderId);

    console.log(`Partial refund ${refund.id} ₹${refundAmount} for order ${order.order_no} by ${byName}`);
    res.json({ success: true, refund_id: refund.id, refund_status: refund.status, refund_amount: refundAmount, order_status: newStatus });
  } catch (err) {
    const msg = err.error?.description || err.message || JSON.stringify(err);
    console.error('Partial refund error:', JSON.stringify(err));
    res.status(err.statusCode || 500).json({ error: msg });
  }
});

// GET /api/payments/refund-status/:orderId
router.get('/refund-status/:orderId', async (req, res) => {
  try {
    const { data: order, error } = await supabase
      .from('webstore_orders')
      .select('id, order_no, refund_id, refund_status')
      .eq('id', req.params.orderId)
      .single();

    if (error || !order) return res.status(404).json({ error: 'Order not found' });
    if (!order.refund_id)  return res.status(400).json({ error: 'No refund initiated for this order' });

    const refund = await razorpay.refunds.fetch(order.refund_id);

    // Update status in DB if changed
    if (refund.status !== order.refund_status) {
      const orderStatus = refund.status === 'processed' ? 'refunded' : 'refund_initiated';
      await supabase.from('webstore_orders').update({
        refund_status: refund.status,
        status:        orderStatus,
      }).eq('id', order.id);
    }

    res.json({ refund_id: refund.id, status: refund.status, amount: refund.amount / 100, speed: refund.speed_processed || refund.speed_requested });
  } catch (err) {
    const msg = err.error?.description || err.message || (err.statusCode ? `Razorpay error ${err.statusCode}` : JSON.stringify(err));
    console.error('Refund status error:', JSON.stringify(err));
    res.status(err.statusCode || 500).json({ error: msg });
  }
});

// POST /api/webhooks/razorpay
// Razorpay webhook — backup for payment.captured events
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const body      = req.body;
    const expected  = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
                            .update(body).digest('hex');

    if (expected !== signature) return res.status(400).json({ error: 'Invalid signature' });

    const event = JSON.parse(body);
    if (event.event === 'payment.captured') {
      const payment = event.payload.payment.entity;
      console.log(`Razorpay payment captured: ${payment.id} ₹${payment.amount / 100}`);
      // Order is already saved via /verify — this is just a backup log
    }

    if (event.event === 'refund.processed') {
      const refund = event.payload.refund.entity;
      console.log(`Razorpay refund processed: ${refund.id} ₹${refund.amount / 100}`);
      // Find order by refund_id and mark as refunded
      const { data: order } = await supabase
        .from('webstore_orders')
        .select('id, order_no')
        .eq('refund_id', refund.id)
        .single();
      if (order) {
        await supabase.from('webstore_orders').update({
          status:        'refunded',
          refund_status: 'processed',
        }).eq('id', order.id);
        console.log(`Order ${order.order_no} marked as refunded via webhook`);
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: 'Webhook processing error' });
  }
});

module.exports = router;
