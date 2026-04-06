const express  = require('express');
const Razorpay = require('razorpay');
const crypto   = require('crypto');
const supabase = require('../config/supabase');
const { createInvoice, recordPayment } = require('../config/zoho');

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

    // Save webstore order
    const o = order;
    const { error: wsErr } = await supabase.from('webstore_orders').insert({
      id:       o.id,
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
    });
    if (wsErr) console.error('Webstore order save error:', wsErr.message);

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

    // Create Zoho Books invoice + record payment (non-blocking)
    setImmediate(async () => {
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
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
