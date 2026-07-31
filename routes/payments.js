const express      = require('express');
const Razorpay     = require('razorpay');
const crypto       = require('crypto');
const nodemailer   = require('nodemailer');
const supabase     = require('../config/supabase');
const { createInvoice, recordPayment } = require('../config/zoho');
const { sendCustomerInvoice, sendInvoiceWhatsApp } = require('./webstoreOrders');
const { auth, requireRole } = require('../middleware/auth');
const { encrypt, hmac, encryptCustomer } = require('../config/crypto');
const { insertLedger } = require('../utils/ledger');
const { sendText: gaSendText, sendFile: gaSendFile, sendToGroup, isAutomationDisabled } = require('../lib/greenapi');

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

// ── WhatsApp send helper ──────────────────────────────────────────────────────
const SATHVAM_LOGO_URL = 'https://sathvam.in/logo.jpg';

async function sendViaBotSailor(phone, message, imageUrl = SATHVAM_LOGO_URL) {
  if (imageUrl) return gaSendFile(phone, imageUrl, 'sathvam.jpg', message);
  return gaSendText(phone, message);
}

// ── WhatsApp order alert (to admin) ──────────────────────────────────────────
async function sendWhatsAppAlert(order) {
  if (await isAutomationDisabled('order_confirmed')) return; // respect toggle

  const adminNumbers = [
    process.env.WA_NOTIFY_TO,
    process.env.WA_ADMIN_PHONE1,
    process.env.WA_ADMIN_PHONE2,
  ].filter(Boolean).map(n => n.replace(/\D/g, '')).filter((v, i, a) => v && a.indexOf(v) === i);

  if (!adminNumbers.length) return;

  const cust     = order.customer || {};
  const items    = (order.items || []).map(i => `• ${i.name} × ${i.qty}`).join('\n');
  const orderNo  = order.orderNo || order.order_no || '—';
  const total    = parseFloat(order.total || 0).toLocaleString('en-IN');
  const text     =
    `🛒 *New Webstore Order — ${orderNo}*\n\n` +
    `👤 *${cust.name || 'Guest'}*\n` +
    `📞 ${cust.phone || '—'}\n` +
    `📍 ${[cust.city, cust.state, cust.pincode].filter(Boolean).join(', ')}\n\n` +
    `📋 *Items:*\n${items}\n\n` +
    `💰 *Total: ₹${total}*` +
    `${order.shipping ? `  |  🚚 Shipping: ₹${order.shipping}` : ''}\n` +
    `✅ Payment: ${order.paymentId || order.payment_id || 'Online'}\n\n` +
    `📦 Action: admin.sathvam.in → Webstore Orders`;

  for (const phone of adminNumbers) {
    try {
      await sendViaBotSailor(phone, text, null);
    } catch (e) {
      console.error('Admin WA alert failed:', e.message);
    }
  }

  // Also send to factory group if configured
  const groupId = process.env.WA_FACTORY_GROUP_ID;
  if (groupId) {
    try { await sendToGroup(groupId, text); } catch (e) { console.error('Group WA alert failed:', e.message); }
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
    `📞 *+91 70923 77092*\n` +
    `🌐 sathvam.in`;

  try {
    const ok = await sendViaBotSailor(phone, text);
    if (!ok) console.error('Customer WA confirmation: send failed for', phone.slice(0,4)+'****'+phone.slice(-3));
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
    const { amount, orderNo, orderData } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const rzpOrder = await razorpay.orders.create({
      amount:   Math.round(parseFloat(amount) * 100), // paise
      currency: 'INR',
      receipt:  orderNo || `SW-${Date.now()}`,
      notes:    { source: 'sathvam.in' },
    });

    // Stash order data so webhook can recover if /verify never fires
    if (orderData) {
      supabase.from('settings').upsert({
        key:   `pending_order_${rzpOrder.id}`,
        value: { ...orderData, stashed_at: new Date().toISOString() },
      }).then(() => {}).catch(e => console.error('Stash pending order error:', e.message));
    }

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

    // Auto-feed money_ledger — sales income
    insertLedger({
      txn_date:     o.date || new Date().toISOString().slice(0, 10),
      direction:    'in',
      amount:       parseFloat(o.total) || 0,
      category:     'sales',
      subcategory:  'webstore',
      party:        rawCustomer.name || 'Webstore Customer',
      party_type:   'customer',
      payment_mode: 'online',
      narration:    `Webstore order ${generatedOrderNo}`,
      reference_no: razorpay_payment_id,
      source_table: 'webstore_orders',
      source_id:    dbId,
      created_by:   'system',
    }).catch(() => {});

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

      // WhatsApp invoice PDF to customer
      await sendInvoiceWhatsApp({ ...o, order_no: generatedOrderNo });

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

    // Clean up stashed pending order data
    supabase.from('settings').delete().eq('key', `pending_order_${razorpay_order_id}`)
      .then(() => {}).catch(() => {});

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

// Razorpay webhook handler — shared by both /webhook and / routes
async function handleRazorpayWebhook(req, res) {
  try {
    const signature = req.headers['x-razorpay-signature'];
    // Use rawBody (Buffer) stored by express.json verify callback for HMAC verification
    const rawBody   = req.rawBody || Buffer.from(JSON.stringify(req.body));
    const expected  = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
                            .update(rawBody).digest('hex');

    if (expected !== signature) {
      console.error('[webhook] Signature mismatch — expected:', expected, 'got:', signature);
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const event = typeof req.body === 'object' ? req.body : JSON.parse(rawBody);
    if (event.event === 'payment.captured') {
      const payment = event.payload.payment.entity;
      console.log(`[webhook] payment.captured: ${payment.id} ₹${payment.amount / 100}`);

      // Check if order was already saved by /verify
      const { data: existing } = await supabase.from('webstore_orders')
        .select('id')
        .or(`notes.ilike.%${payment.id}%,payment_id.eq.${payment.id}`)
        .limit(1).maybeSingle();

      if (!existing) {
        // /verify never fired — recover from stashed pending order data
        console.log(`[webhook] No order found for payment ${payment.id} — attempting recovery`);
        const rzpOrderId = payment.order_id;
        const { data: stashed } = await supabase.from('settings')
          .select('value').eq('key', `pending_order_${rzpOrderId}`).maybeSingle();

        if (stashed?.value) {
          const o = stashed.value;
          const rawCustomer = o.customer || {};
          const encCustomer = encryptCustomer(rawCustomer);
          const custEmailHash = hmac(rawCustomer.email || '');
          const dbId = crypto.randomUUID();
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
            notes:               `Razorpay: ${payment.id} (webhook-recovered)`,
          }, { onConflict: 'id' });

          if (!wsErr) {
            console.log(`[webhook] ✅ Order ${generatedOrderNo} recovered for payment ${payment.id}`);

            // Sales record
            const customer = rawCustomer;
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
              notes:          encrypt(`${addrNote} | Razorpay: ${payment.id} (webhook-recovered)`),
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

            // Ledger entry
            insertLedger({
              txn_date:     o.date || new Date().toISOString().slice(0, 10),
              direction:    'in',
              amount:       parseFloat(o.total) || 0,
              category:     'sales',
              subcategory:  'webstore',
              party:        rawCustomer.name || 'Webstore Customer',
              party_type:   'customer',
              payment_mode: 'online',
              narration:    `Webstore order ${generatedOrderNo} (webhook-recovered)`,
              reference_no: payment.id,
              source_table: 'webstore_orders',
              source_id:    dbId,
              created_by:   'system',
            }).catch(() => {});

            // Non-blocking: send all notifications
            setImmediate(async () => {
              await sendWhatsAppAlert({ ...o, paymentId: payment.id, orderNo: generatedOrderNo });
              await sendOrderEmail({ ...o, orderNo: generatedOrderNo }, payment.id);
              await sendCustomerOrderWhatsApp({ ...o, orderNo: generatedOrderNo });
              await sendCustomerInvoice({ ...o, orderNo: generatedOrderNo }, payment.id);
              await sendInvoiceWhatsApp({ ...o, order_no: generatedOrderNo });
              try {
                const invoice = await createInvoice(o);
                if (invoice?.invoice_id) await recordPayment(invoice, o.total, 'online', payment.id);
              } catch (ze) { console.error('[webhook-recovery] Zoho error:', ze.message); }
              try {
                const fgItems = (o.items || []).filter(i => parseFloat(i.qty) > 0);
                if (fgItems.length) {
                  await supabase.from('finished_goods').insert(fgItems.map(i => ({
                    product_name: i.name || '', category: 'other', unit: 'pcs',
                    qty: parseFloat(i.qty), type: 'out',
                    date: o.date || new Date().toISOString().slice(0, 10),
                    notes: `Auto: Webstore order ${generatedOrderNo} (webhook)`,
                    batch_ref: generatedOrderNo, created_by: 'system',
                    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
                  })));
                }
              } catch (fgErr) { console.error('[webhook-recovery] FG deduction error:', fgErr.message); }
            });

            // Clean up stashed data
            await supabase.from('settings').delete().eq('key', `pending_order_${rzpOrderId}`);
          } else {
            console.error(`[webhook] Order recovery failed:`, wsErr.message);
          }
        } else {
          // No stashed data — send admin alert about orphaned payment
          console.error(`[webhook] ⚠️ Payment ${payment.id} captured but no pending order data found`);
          const adminNumbers = [process.env.WA_ADMIN_PHONE1, process.env.WA_NOTIFY_TO]
            .filter(Boolean).map(n => n.replace(/\D/g, '')).filter((v, i, a) => v && a.indexOf(v) === i);
          const msg = `⚠️ *Payment Without Order*\n\n` +
            `💳 ₹${(payment.amount / 100).toLocaleString('en-IN')} captured\n` +
            `📧 ${payment.email || '—'}\n📞 ${payment.contact || '—'}\n` +
            `🔑 ${payment.id}\n\n` +
            `Order was NOT saved — /verify never called and no pending data found.\n` +
            `➡️ Create order manually in admin panel.`;
          for (const phone of adminNumbers) {
            try { await gaSendText(phone, msg); } catch(e) {}
          }
        }
      }
    }

    if (event.event === 'payment_link.paid' || event.event === 'payment_link.completed') {
      const paymentLinkId = event.payload?.payment_link?.entity?.id;
      const paymentId     = event.payload?.payment?.entity?.id;
      const linkNotes     = event.payload?.payment_link?.entity?.notes || {};

      if (paymentLinkId && paymentId) {
        // Check if this is a POS sale payment link
        if (linkNotes.source === 'pos_sale' && linkNotes.sale_id) {
          try {
            const paidAmount = (event.payload?.payment_link?.entity?.amount_paid || event.payload?.payment?.entity?.amount || 0) / 100;
            console.log(`[webhook] POS payment link paid: ${paymentLinkId} ₹${paidAmount} for sale ${linkNotes.sale_id}`);

            // Update sale record
            await supabase.from('sales').update({
              amount_paid: paidAmount,
              payment_method: 'upi',
              payment_id: paymentId,
              payment_status: 'paid',
            }).eq('id', linkNotes.sale_id);

            // Clean up stashed data
            await supabase.from('settings').delete().eq('key', `pos_payment_link_${paymentLinkId}`).catch(() => {});

            // Notify admin
            const adminPhones = [process.env.WA_ADMIN_PHONE1, process.env.WA_NOTIFY_TO].filter(Boolean);
            const msg = `✅ *POS Payment Received*\n\n` +
              `📋 Order: ${linkNotes.order_no || '—'}\n` +
              `💰 Amount: ₹${paidAmount.toLocaleString('en-IN')}\n` +
              `💳 Via: Payment Link\n` +
              `🔑 ${paymentId}\n\n` +
              `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`;
            for (const phone of adminPhones) {
              try { await gaSendText(phone, msg); } catch(e) {}
            }

            // Send receipt to customer
            const { data: stashed } = await supabase.from('settings').select('value').eq('key', `pos_payment_link_${paymentLinkId}`).maybeSingle();
            const custPhone = stashed?.value?.customerPhone || linkNotes.wa_phone;
            if (custPhone) {
              try {
                await gaSendText(custPhone,
                  `✅ *Payment Received — Sathvam*\n\n` +
                  `Thank you! Your payment of ₹${paidAmount.toLocaleString('en-IN')} for order ${linkNotes.order_no || ''} has been received.\n\n` +
                  `— Team Sathvam 🌿`
                );
              } catch(e) {}
            }
          } catch (e) {
            console.error('[webhook] POS payment link processing error:', e.message);
          }
        } else {
          // WhatsApp ordering flow payment link
          try {
            const { handlePaymentLinkPaid } = require('./waOrdering');
            await handlePaymentLinkPaid(paymentLinkId, paymentId);
          } catch (e) {
            console.error('[wa-order-webhook]', e.message);
          }
        }
      }
    }

    if (event.event === 'payment.failed') {
      const payment = event.payload.payment.entity;
      if (!await isAutomationDisabled('order_confirmed')) { // payment alerts follow order notification toggle
      const adminNumbers = [process.env.WA_ADMIN_PHONE1, process.env.WA_NOTIFY_TO]
        .filter(Boolean).map(n => n.replace(/\D/g, ''));
      const amt = (payment.amount || 0) / 100;
      const msg = `❌ *Payment Failed Alert*\n\n` +
        `💳 Amount: ₹${amt.toLocaleString('en-IN')}\n` +
        `📞 Contact: ${payment.contact || '—'}\n` +
        `📧 Email: ${payment.email || '—'}\n` +
        `❌ Reason: ${payment.error_description || payment.error_code || 'Unknown'}\n` +
        `🔑 Payment ID: ${payment.id}\n\n` +
        `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`;
      for (const phone of adminNumbers) {
        try { await gaSendText(phone, msg); } catch(e) {}
      }
      } // end automation toggle check
      console.log(`Payment failed: ${payment.id} ₹${amt} — ${payment.error_description}`);
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
}

// Mount webhook handler on both /webhook and / so it works whether
// Razorpay is configured to POST to /api/webhooks or /api/webhooks/webhook
router.post('/webhook', handleRazorpayWebhook);
router.post('/', handleRazorpayWebhook);

// POST /api/payments/place-cod
// Place a Cash on Delivery order (no Razorpay)
router.post('/place-cod', async (req, res) => {
  try {
    const { order } = req.body;
    if (!order) return res.status(400).json({ error: 'order required' });

    const rawCustomer = order.customer || {};
    const encCustomer = encryptCustomer(rawCustomer);
    const custEmailHash = hmac(rawCustomer.email || '');
    const dbId = crypto.randomUUID();
    const generatedOrderNo = await generateOrderNo();

    const { error: wsErr } = await supabase.from('webstore_orders').upsert({
      id:                  dbId,
      order_no:            generatedOrderNo,
      date:                order.date || new Date().toISOString().slice(0, 10),
      customer:            encCustomer,
      customer_email_hash: custEmailHash,
      items:               order.items || [],
      subtotal:            parseFloat(order.subtotal) || 0,
      gst:                 parseFloat(order.gst) || 0,
      shipping:            parseFloat(order.shipping) || 0,
      total:               parseFloat(order.total) || 0,
      status:              'confirmed',
      payment_status:      'pending',
      payment_mode:        'cod',
      channel:             'website',
      notes:               'COD Order — payment on delivery',
    }, { onConflict: 'id' });

    if (wsErr) return res.status(500).json({ error: 'Order save failed: ' + wsErr.message });

    // Auto-feed money_ledger — COD sale (payment pending at delivery)
    insertLedger({
      txn_date:     order.date || new Date().toISOString().slice(0, 10),
      direction:    'in',
      amount:       parseFloat(order.total) || 0,
      category:     'sales',
      subcategory:  'webstore_cod',
      party:        rawCustomer.name || 'COD Customer',
      party_type:   'customer',
      payment_mode: 'cash',
      narration:    `COD order ${generatedOrderNo} — payment on delivery`,
      reference_no: generatedOrderNo,
      source_table: 'webstore_orders',
      source_id:    dbId,
      created_by:   'system',
    }).catch(() => {});

    // Non-blocking notifications
    setImmediate(async () => {
      await sendWhatsAppAlert({ ...order, paymentId: 'COD', orderNo: generatedOrderNo });
      await sendOrderEmail({ ...order, orderNo: generatedOrderNo }, 'COD');

      // COD confirmation to customer
      const cust = order.customer || {};
      const phone = (cust.phone || '').replace(/\D/g, '');
      const firstName = (cust.name || '').split(' ')[0] || 'Customer';
      if (phone) {
        const custPhone = phone.length === 10 ? `91${phone}` : phone;
        const items = (order.items || []).map(i => `  • ${i.name} × ${i.qty}`).join('\n');
        const codMsg =
          `🌿 *சத்துவம் இயற்கை உணவுகள்*\n` +
          `━━━━━━━━━━━━━━━━━━━━━\n\n` +
          `✅ *COD ஆர்டர் பதிவு செய்யப்பட்டது!*\n` +
          `_Cash on Delivery Order Placed!_\n\n` +
          `வணக்கம் ${firstName}! 🙏\n\n` +
          `📋 *ஆர்டர் எண்:* ${generatedOrderNo}\n` +
          `💵 *கட்டணம்:* ₹${parseFloat(order.total || 0).toLocaleString('en-IN')} (டெலிவரியில் செலுத்தவும்)\n` +
          `_Pay ₹${parseFloat(order.total || 0).toLocaleString('en-IN')} at delivery_\n\n` +
          `*📦 Items:*\n${items}\n\n` +
          `📍 *முகவரி:*\n${[cust.address, cust.city, cust.state, cust.pincode].filter(Boolean).join(', ')}\n\n` +
          `━━━━━━━━━━━━━━━━━━━━━\n` +
          `🚚 நாங்கள் விரைவில் அனுப்புவோம்!\n` +
          `_We'll dispatch your order soon!_\n\n` +
          `❓ கேள்விகளா? +91 70923 77092`;
        try { await gaSendText(custPhone, codMsg); } catch(e) {}
      }
    });

    res.json({ success: true, orderNo: generatedOrderNo, orderId: dbId });
  } catch (err) {
    console.error('COD order error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POS Payment Link + QR ─────────────────────────────────────────────────────
// POST /api/payments/create-payment-link
// Creates a Razorpay payment link for POS sales, sends via WhatsApp + SMS
router.post('/create-payment-link', auth, async (req, res) => {
  try {
    const { saleId, amount, customerName, customerPhone, orderNo, items } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!customerPhone) return res.status(400).json({ error: 'Customer phone required' });

    const keyId     = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    const authHeader = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

    const digits  = (customerPhone || '').replace(/\D/g, '');
    const contact = digits.length === 10 ? `+91${digits}` : `+${digits}`;
    const expireBy = Math.floor(Date.now() / 1000) + 48 * 60 * 60; // 48hr expiry

    // Build item description
    const itemDesc = (items || []).slice(0, 3).map(i =>
      `${i.productName || i.name || 'Item'} × ${i.qty || 1}`
    ).join(', ');
    const desc = `${orderNo || 'Sathvam Order'} — ${itemDesc}`.slice(0, 250);

    // Create Razorpay payment link
    const linkRes = await fetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${authHeader}` },
      body: JSON.stringify({
        amount:          Math.round(parseFloat(amount) * 100), // paise
        currency:        'INR',
        description:     desc,
        customer:        { name: customerName || 'Customer', contact },
        notify:          { sms: true, email: false },
        reminder_enable: true,
        expire_by:       expireBy,
        upi_link:        true,   // generates a UPI deep-link for GPay/PhonePe
        notes: {
          source:     'pos_sale',
          sale_id:    saleId || '',
          order_no:   orderNo || '',
        },
      }),
    });
    const linkData = await linkRes.json();

    if (!linkData.id) {
      console.error('[payment-link] Razorpay error:', JSON.stringify(linkData));
      return res.status(500).json({ error: linkData.error?.description || 'Failed to create payment link' });
    }

    const paymentUrl = linkData.short_url;
    const paymentLinkId = linkData.id;

    // Store payment link reference in sales record (if saleId provided)
    if (saleId) {
      try {
        await supabase.from('sales').update({
          payment_link_id: paymentLinkId,
          payment_link_url: paymentUrl,
        }).eq('id', saleId);
      } catch (e) { console.warn('[payment-link] Update sale error:', e.message); }
    }

    // Also stash in settings for webhook recovery
    try {
      await supabase.from('settings').upsert({
        key: `pos_payment_link_${paymentLinkId}`,
        value: { saleId, orderNo, amount, customerName, customerPhone, created_at: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      });
    } catch (e) { console.warn('[payment-link] Stash error:', e.message); }

    // Send via WhatsApp
    if (!await isAutomationDisabled('payment_link')) {
      const waMsg =
        `🛒 *Payment Request — Sathvam*\n\n` +
        `Hi ${(customerName || 'Customer').split(' ')[0]}!\n\n` +
        `📋 Order: *${orderNo || 'Sathvam Purchase'}*\n` +
        `💰 Amount: *₹${parseFloat(amount).toLocaleString('en-IN')}*\n\n` +
        `Pay securely via UPI, card, or netbanking:\n` +
        `🔗 ${paymentUrl}\n\n` +
        `Link valid for 48 hours.\n` +
        `— Team Sathvam 🌿`;

      try {
        await gaSendText(customerPhone, waMsg);
        // Send QR code image via WhatsApp
        const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&format=png&data=${encodeURIComponent(paymentUrl)}`;
        await gaSendFile(customerPhone, qrImageUrl, 'payment-qr.png',
          `📱 Scan this QR to pay ₹${parseFloat(amount).toLocaleString('en-IN')} for order ${orderNo || 'Sathvam'}`
        );
      } catch (e) {
        console.error('[payment-link] WhatsApp send failed:', e.message);
      }
    }

    // Send via SMS (Razorpay does this via notify.sms=true above, but also manual backup)
    // Razorpay already sends SMS if notify.sms=true, so we skip manual SMS

    console.log(`[payment-link] Created: ${paymentLinkId} for ${orderNo} ₹${amount} → ${paymentUrl}`);

    res.json({
      success: true,
      paymentLinkId,
      paymentUrl,
      amount: parseFloat(amount),
      expiresAt: new Date(expireBy * 1000).toISOString(),
    });
  } catch (err) {
    console.error('[payment-link] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payments/payment-link-status/:linkId
// Check payment link status (polling from frontend for real-time updates)
router.get('/payment-link-status/:linkId', auth, async (req, res) => {
  try {
    const keyId     = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    const authHeader = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

    const r = await fetch(`https://api.razorpay.com/v1/payment_links/${req.params.linkId}`, {
      headers: { Authorization: `Basic ${authHeader}` },
    });
    const data = await r.json();
    res.json({
      id: data.id,
      status: data.status,              // created | paid | expired | cancelled
      amount: (data.amount || 0) / 100,
      amountPaid: (data.amount_paid || 0) / 100,
      shortUrl: data.short_url,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
