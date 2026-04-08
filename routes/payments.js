const express      = require('express');
const Razorpay     = require('razorpay');
const crypto       = require('crypto');
const nodemailer   = require('nodemailer');
const supabase     = require('../config/supabase');
const { createInvoice, recordPayment } = require('../config/zoho');

// ── Email transporter ─────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

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

// ── WhatsApp order alert ──────────────────────────────────────────────────────
async function sendWhatsAppAlert(order) {
  const phoneId  = process.env.WA_PHONE_NUMBER_ID;
  const token    = process.env.WA_ACCESS_TOKEN;
  const notifyTo = process.env.WA_NOTIFY_TO; // e.g. "917092177092"
  if (!phoneId || !token || !notifyTo) return; // skip if not configured

  const cust  = order.customer || {};
  const items = (order.items || []).map(i => `• ${i.name} × ${i.qty}`).join('\n');
  const text  =
    `🛒 *New Order — ${order.orderNo}*\n\n` +
    `👤 ${cust.name || 'Guest'}  📞 ${cust.phone || '—'}\n` +
    `📍 ${[cust.city, cust.state, cust.pincode].filter(Boolean).join(', ')}\n\n` +
    `${items}\n\n` +
    `💰 Total: ₹${order.total}  |  Shipping: ₹${order.shipping || 0}\n` +
    `🔑 Razorpay: ${order.paymentId || ''}`;

  try {
    await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: notifyTo,
        type: 'text',
        text: { body: text },
      }),
    });
  } catch (e) { console.error('WhatsApp alert failed:', e.message); }
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
      const orderTotal = parseFloat(order?.total || 0);
      if (Math.abs(paidAmount - orderTotal) > 1) { // allow ₹1 rounding tolerance
        console.error(`Amount mismatch: paid ₹${paidAmount}, order ₹${orderTotal}`);
        return res.status(400).json({ error: 'Payment amount mismatch' });
      }
    } catch (amtErr) {
      console.error('Amount verification error:', amtErr.message);
      // Non-blocking: continue if Razorpay API is unavailable — signature already verified
    }

    // Save webstore order
    const o = order;
    const dbId = crypto.randomUUID(); // always use a proper UUID for the DB row
    const { error: wsErr } = await supabase.from('webstore_orders').upsert({
      id:       dbId,
      order_no: o.orderNo,
      date:     o.date || new Date().toISOString().slice(0, 10),
      customer: o.customer || {},
      items:    o.items || [],
      subtotal: parseFloat(o.subtotal) || 0,
      gst:      parseFloat(o.gst) || 0,
      shipping: parseFloat(o.shipping) || 0,
      total:    parseFloat(o.total) || 0,
      status:   'confirmed',
      channel:  'website',
      notes:    `Razorpay: ${razorpay_payment_id}`,
    }, { onConflict: 'id' });
    if (wsErr) {
      console.error('Webstore order save error:', wsErr.message, 'order_no:', o.orderNo, 'payment:', razorpay_payment_id);
      return res.status(500).json({ error: 'Order save failed: ' + wsErr.message });
    }

    // Save factory sale
    const customer = o.customer || {};
    const { data: sale } = await supabase.from('sales').insert({
      order_no:       o.orderNo,
      date:           o.date || new Date().toISOString().slice(0, 10),
      channel:        'website',
      status:         'pending',
      customer_name:  customer.name || '',
      customer_phone: customer.phone || '',
      total_amount:   parseFloat(o.subtotal) || 0,
      discount:       0,
      final_amount:   parseFloat(o.total) || 0,
      amount_paid:    parseFloat(o.total) || 0,
      payment_method: 'online',
      notes:          `${customer.address || ''}, ${customer.city || ''}, ${customer.state || ''} - ${customer.pincode || ''} | Razorpay: ${razorpay_payment_id}`,
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

    // Non-blocking: WhatsApp alert + Zoho invoice
    setImmediate(async () => {
      // WhatsApp + email notifications to owner
      await sendWhatsAppAlert({ ...o, paymentId: razorpay_payment_id });
      await sendOrderEmail(o, razorpay_payment_id);

      // Zoho Books invoice
      try {
        const invoice = await createInvoice(o);
        if (invoice?.invoice_id) {
          await recordPayment(invoice, o.total, 'online', razorpay_payment_id);
        }
      } catch (ze) {
        console.error('Zoho invoice error:', ze.message);
      }
    });

    res.json({ success: true, paymentId: razorpay_payment_id });
  } catch (err) {
    console.error('Payment verify error:', err.message);
    res.status(500).json({ error: err.message });
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

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: 'Webhook processing error' });
  }
});

module.exports = router;
