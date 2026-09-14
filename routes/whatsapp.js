/**
 * WhatsApp Business API — Meta Graph API v19.0
 *
 * Endpoints:
 *   GET  /api/whatsapp/webhook         — Meta webhook verification
 *   POST /api/whatsapp/webhook         — Incoming messages + status updates (no auth, verified by token)
 *   GET  /api/whatsapp/conversations   — List all conversations (admin auth)
 *   GET  /api/whatsapp/conversations/:phone — Messages for a phone (admin auth)
 *   POST /api/whatsapp/send            — Send text or template message (admin auth)
 *   GET  /api/whatsapp/templates       — List approved templates from Meta (admin auth)
 *   POST /api/whatsapp/notify/order    — Send order notification to customer (admin auth)
 *   GET  /api/whatsapp/status          — Config status check (admin auth)
 */

const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const crypto     = require('crypto');
const Razorpay   = require('razorpay');
const { auth } = require('../middleware/auth');
const { sendText: gaSendText, sendFile: gaSendFile, sendFileByUpload: gaSendFileByUpload, sendTyping: gaSendTyping } = require('../lib/greenapi');
const supabase  = require('../config/supabase');

const router    = express.Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── WA auto-reply: set WHATSAPP_AI_REPLIES=false in .env to disable ───────────
const AI_REPLIES_ENABLED = process.env.WHATSAPP_AI_REPLIES !== 'false';

const WA_BASE = 'https://graph.facebook.com/v19.0';

// ── Product context cache (5 minute TTL) — avoids DB hit on every message ────
let _productContextCache = { data: null, expiry: 0, stockMap: null };
const PRODUCT_CACHE_TTL = 5 * 60 * 1000;

async function getProductContext() {
  const now = Date.now();
  if (_productContextCache.data && _productContextCache.expiry > now) {
    return _productContextCache.data;
  }
  try {
    const [{ data: products }, { data: stockData }, { data: enabledSetting }] = await Promise.all([
      supabase.from('products')
        .select('id,name,cat,pack_size,pack_unit,unit,website_price,price,active,health_benefits,certifications')
        .eq('active', true).order('name'),
      supabase.from('stock_ledger').select('product_id,type,qty'),
      supabase.from('settings').select('value').eq('key', 'website_enabled_products').single(),
    ]);

    const stock = {};
    for (const row of stockData || []) {
      stock[row.product_id] = (stock[row.product_id] || 0) + (row.type === 'in' ? +row.qty : -+row.qty);
    }
    for (const id of Object.keys(stock)) if (stock[id] < 0) stock[id] = 0;

    const enabledArr = Array.isArray(enabledSetting?.value) ? enabledSetting.value
      : Array.isArray(enabledSetting?.value?.value) ? enabledSetting.value.value : [];
    const enabledSet = new Set(enabledArr);

    const result = (products || [])
      .filter(p => p.cat !== 'raw' && (enabledSet.size === 0 || enabledSet.has(p.id)) && (p.website_price || p.price) > 0)
      .map(p => {
        const price    = p.website_price || p.price;
        const packStr  = p.pack_size ? `${p.pack_size}${p.pack_unit || p.unit}` : p.unit;
        const qty      = stock[p.id] ?? 0;
        const stockStr = qty > 10 ? 'In Stock' : qty > 0 ? `Only ${qty} left` : 'Out of Stock';
        const benefits = Array.isArray(p.health_benefits) && p.health_benefits.length
          ? ` | ${p.health_benefits.slice(0, 2).join(', ')}` : '';
        return `• ${p.name} (${packStr}) ₹${price} — ${stockStr}${benefits}`;
      })
      .join('\n');

    _productContextCache = { data: result, expiry: now + PRODUCT_CACHE_TTL, stockMap: stock };
    return result;
  } catch (e) {
    console.error('WA getProductContext error:', e.message);
    return _productContextCache.data || '(product data unavailable)';
  }
}

// ── Helper: get cached stock for a product (used by Flow stock validation) ───
async function getStockForProduct(productId) {
  // Ensure cache is fresh
  await getProductContext();
  return _productContextCache.stockMap?.[productId] ?? 0;
}

// ── Helper: lookup recent orders for a WhatsApp phone number ─────────────────
async function getOrdersByPhone(waPhone) {
  const digits = waPhone.replace(/\D/g, '').slice(-10);
  try {
    const { data } = await supabase
      .from('webstore_orders')
      .select('order_no,status,total,created_at,customer,tracking_no,courier')
      .ilike('customer->>phone', `%${digits}`)
      .order('created_at', { ascending: false })
      .limit(5);
    return data || [];
  } catch (e) {
    console.error('WA getOrdersByPhone error:', e.message);
    return [];
  }
}

// ── Helper: lookup one order by order_no ─────────────────────────────────────
async function lookupOrderNo(rawNo, waPhone) {
  try {
    const { data } = await supabase
      .from('webstore_orders')
      .select('order_no,status,total,created_at,customer,tracking_no,courier,items')
      .ilike('order_no', rawNo.trim())
      .maybeSingle();
    if (!data) return null;
    // Verify phone ownership (optional safety check)
    const orderDigits = (data.customer?.phone || '').replace(/\D/g, '').slice(-10);
    const inputDigits = waPhone.replace(/\D/g, '').slice(-10);
    if (orderDigits && inputDigits && orderDigits !== inputDigits) return null;
    return data;
  } catch (e) { return null; }
}

const STATUS_LABEL = {
  new: 'Received ✅', confirmed: 'Confirmed ✅', packed: 'Packed 📦',
  shipped: 'Shipped 🚚', delivered: 'Delivered ✅', cancelled: 'Cancelled ❌',
};

function formatOrder(o) {
  const status  = STATUS_LABEL[o.status] || o.status;
  const date    = o.created_at ? new Date(o.created_at).toLocaleDateString('en-IN') : '';
  const track   = o.tracking_no ? `\n🔍 Tracking: ${o.courier || ''} ${o.tracking_no}` : '';
  return `📦 *${o.order_no}*\nStatus: ${status}\nDate: ${date}\nTotal: ₹${o.total}${track}`;
}

// ── Helper: chat history from settings table ──────────────────────────────────
const HISTORY_KEY = phone => `wa_chat_${phone}`;
const MAX_HISTORY = 10; // pairs kept

async function loadHistory(phone) {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', HISTORY_KEY(phone)).single();
    return data?.value?.messages || [];
  } catch { return []; }
}

async function saveHistory(phone, messages) {
  try {
    await supabase.from('settings').upsert({
      key:   HISTORY_KEY(phone),
      value: { messages: messages.slice(-(MAX_HISTORY * 2)), updated_at: new Date().toISOString() },
    });
  } catch (e) { console.error('WA saveHistory error:', e.message); }
}

// ── Helper: send a WhatsApp text reply ────────────────────────────────────────
async function sendReply(to, text) {
  try {
    const result = await waRequest('/messages', 'POST', {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    });
    await storeMessage({
      wa_message_id: result.messages?.[0]?.id,
      phone:     to,
      direction: 'outbound',
      type:      'text',
      content:   text,
      status:    'sent',
      timestamp: new Date().toISOString(),
      sent_by:   'bot',
    });
  } catch (e) {
    console.error('WA sendReply error:', e.message);
  }
}

// ── Keyword router — returns a reply string or null ───────────────────────────
async function keywordReply(text, phone) {
  const t = text.trim();
  const upper = t.toUpperCase();

  // MENU / HI / HELLO / START
  if (/^(hi|hello|hey|start|menu|help|\u0b39\u0b3e\u0b0f|\u0b35\u0b23\u0b15\u0bcd\u0b15\u0bae\u0bcd)$/i.test(t)) {
    return `👋 *Welcome to Sathvam!*\n\nNatural cold-pressed oils, directly from our mill 🌿\n\nReply with:\n📦 *ORDERS* — your recent orders\n🔍 *TRACK <order no>* — e.g. TRACK SAT-20260410-0042\n🛍 *PRODUCTS* — what we sell\n💬 *anything else* — ask me anything!`;
  }

  // PRODUCTS
  if (/^(products?|shop|buy|oils?|list|catalogue|catalog)$/i.test(t)) {
    const ctx = await getProductContext();
    return `🌿 *Our Products*\n\n${ctx}\n\n🛒 Order at: https://sathvam.in`;
  }

  // ORDERS — list recent orders for this phone
  if (/^(orders?|my orders?|order history)$/i.test(t)) {
    const orders = await getOrdersByPhone(phone);
    if (!orders.length) return `No orders found for this number.\n\nShop at 👉 https://sathvam.in`;
    return `📦 *Your Recent Orders*\n\n${orders.map(formatOrder).join('\n\n')}`;
  }

  // TRACK <order_no>
  const trackMatch = t.match(/^track\s+([A-Z0-9\-]+)$/i);
  if (trackMatch) {
    const order = await lookupOrderNo(trackMatch[1], phone);
    if (!order) return `❌ Order *${trackMatch[1]}* not found or doesn't match this number.\n\nReply *ORDERS* to see your orders.`;
    return formatOrder(order);
  }

  // Order number typed directly (e.g. SAT-20260410-0042)
  const orderNoMatch = t.match(/\b(SAT-\d{8}-\d{4})\b/i);
  if (orderNoMatch) {
    const order = await lookupOrderNo(orderNoMatch[1], phone);
    if (order) return formatOrder(order);
  }

  // REFUND / RETURN / CANCEL
  if (/^(refund|return|cancel|exchange|replace|damaged|broken|wrong)$/i.test(t)) {
    return `📋 *Returns & Refunds*\n\nTo process a return/refund, please share:\n1️⃣ Order number (e.g. SAT-20260410-0042)\n2️⃣ Reason for return\n3️⃣ Photos (if damaged product)\n\nWe'll respond within 24 hours.\n\n📞 Call: +91 70923 77092\n🌐 Policy: https://sathvam.in/returns`;
  }

  // PAYMENT / PAY / UPI
  if (/^(pay|payment|upi|how to pay|payment method|gpay|phonepe|paytm|cod|cash on delivery)$/i.test(t)) {
    return `💳 *Payment Methods*\n\n✅ UPI (GPay, PhonePe, Paytm)\n✅ Credit/Debit Cards\n✅ Net Banking\n✅ Cash on Delivery\n\n🛒 Shop: https://sathvam.in`;
  }

  // DELIVERY / SHIPPING / WHEN
  if (/^(delivery|shipping|when|how long|deliver|dispatch|courier|time)$/i.test(t)) {
    return `📦 *Delivery Info*\n\n🚚 Dispatch: Within 2 business days\n📍 Pan-India delivery via trusted couriers\n🆓 Free shipping on orders above ₹499\n\n📋 Track your order: Reply *TRACK <order no>*`;
  }

  // CONTACT / CALL / PHONE
  if (/^(contact|call|phone|speak|human|agent|support|complaint)$/i.test(t)) {
    return `📞 *Contact Us*\n\n📱 Call/WhatsApp: +91 70923 77092\n📧 Email: info@sathvam.in\n🕐 Mon–Sat, 9 AM – 6 PM IST\n🌐 https://sathvam.in/contact`;
  }

  // PRICE / COST / RATE
  if (/^(price|cost|rate|how much|kitna|vilai|என்ன விலை)$/i.test(t)) {
    const ctx = await getProductContext();
    return `💰 *Current Prices*\n\n${ctx}\n\n🛒 Order at: https://sathvam.in`;
  }

  // THANK / THANKS
  if (/^(thanks?|thank you|nandri|நன்றி|dhanyavaad)$/i.test(t)) {
    return `🙏 You're welcome! Happy to help.\n\nShop anytime at https://sathvam.in 🌿`;
  }

  return null; // fall through to AI
}

// ── Helper: make a WhatsApp API request ──────────────────────────────────────
async function waRequest(path, method = 'GET', body = null) {
  const phoneId = process.env.WA_PHONE_NUMBER_ID;
  const token   = process.env.WA_ACCESS_TOKEN;
  if (!phoneId || !token) throw new Error('WhatsApp not configured — set WA_PHONE_NUMBER_ID and WA_ACCESS_TOKEN');

  const url = path.startsWith('http') ? path : `${WA_BASE}/${phoneId}${path}`;
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  const res  = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || JSON.stringify(data);
    throw new Error(`WhatsApp API error (${res.status}): ${msg}`);
  }
  return data;
}

// ── Helper: normalise phone to E.164 digits ───────────────────────────────────
function normalisePhone(phone) {
  return (phone || '').replace(/\D/g, '');
}

// ── Helper: store a message in DB ─────────────────────────────────────────────
async function storeMessage(fields) {
  // Accept optional new columns: media_url, media_type, quoted_message_id, quoted_content, delivery_error
  const row = { ...fields };
  // Only include new fields if provided (avoids inserting nulls on older schema)
  if (!row.media_url) delete row.media_url;
  if (!row.media_type) delete row.media_type;
  if (!row.quoted_message_id) delete row.quoted_message_id;
  if (!row.quoted_content) delete row.quoted_content;
  if (!row.delivery_error) delete row.delivery_error;
  const { error } = await supabase.from('whatsapp_messages').insert(row);
  if (error) console.error('WA store message error:', error.message);
}

// ── Flow: order number generator ─────────────────────────────────────────────
const FLOW_MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
async function generateFlowOrderNo() {
  const today  = new Date().toISOString().slice(0, 10);
  const d      = new Date();
  const prefix = `SA${d.getFullYear()}${FLOW_MONTHS[d.getMonth()]}${String(d.getDate()).padStart(2, '0')}`;
  const [s, w] = await Promise.all([
    supabase.from('sales').select('id', { count: 'exact', head: true }).eq('date', today),
    supabase.from('webstore_orders').select('id', { count: 'exact', head: true }).eq('date', today),
  ]);
  const seq = ((s.count || 0) + (w.count || 0) + 1);
  return `${prefix}-${String(seq).padStart(2, '0')}`;
}

// ── Flow: send helper via Green API ──────────────────────────────────────────
async function sendFlowViaBotSailor(phone, message) {
  return gaSendText(phone, message);
}

// ── Flow: handle nfm_reply submission ────────────────────────────────────────
async function handleFlowSubmission(fromPhone, nfmReply) {
  try {
    let payload;
    try {
      payload = JSON.parse(nfmReply.response_json || '{}');
    } catch (e) {
      console.error('WA Flow: invalid response_json', e.message);
      return;
    }

    const { product1, qty1, product2, qty2, cust_name, cust_phone, address, city, state, pincode } = payload;

    if (!product1 || !qty1 || !cust_name || !address) {
      console.error('WA Flow: missing required fields', JSON.stringify(payload));
      await sendFlowViaBotSailor(fromPhone, '❌ Order submission incomplete. Please try again or call +91 70923 77092.');
      return;
    }

    // Look up products by UUID
    const productIds = [product1];
    if (product2 && product2 !== 'none') productIds.push(product2);

    const { data: products, error: prodErr } = await supabase
      .from('products')
      .select('id,name,website_price,price,pack_size,pack_unit,unit')
      .in('id', productIds);

    if (prodErr || !products?.length) {
      console.error('WA Flow: product lookup failed', prodErr?.message);
      await sendFlowViaBotSailor(fromPhone, '❌ Product lookup failed. Please call +91 70923 77092.');
      return;
    }

    const prodMap = {};
    for (const p of products) prodMap[p.id] = p;

    // Build items with stock validation
    const items = [];
    const stockIssues = [];
    const p1 = prodMap[product1];
    if (p1) {
      const price = p1.website_price || p1.price || 0;
      const qty   = Math.max(1, parseInt(qty1) || 1);
      const pack  = `${p1.pack_size || ''}${p1.pack_unit || p1.unit || ''}`.trim();
      // Stock availability check
      const available1 = await getStockForProduct(p1.id);
      if (available1 <= 0) {
        stockIssues.push(`❌ *${p1.name}* is currently out of stock.`);
      } else if (qty > available1) {
        stockIssues.push(`⚠️ *${p1.name}* — only ${available1} available (you requested ${qty}).`);
      }
      items.push({ id: p1.id, name: `${p1.name}${pack ? ' ' + pack : ''}`, qty, price });
    }
    if (product2 && product2 !== 'none') {
      const p2  = prodMap[product2];
      const qty = Math.max(0, parseInt(qty2) || 0);
      if (p2 && qty > 0) {
        const price = p2.website_price || p2.price || 0;
        const pack  = `${p2.pack_size || ''}${p2.pack_unit || p2.unit || ''}`.trim();
        const available2 = await getStockForProduct(p2.id);
        if (available2 <= 0) {
          stockIssues.push(`❌ *${p2.name}* is currently out of stock.`);
        } else if (qty > available2) {
          stockIssues.push(`⚠️ *${p2.name}* — only ${available2} available (you requested ${qty}).`);
        }
        items.push({ id: p2.id, name: `${p2.name}${pack ? ' ' + pack : ''}`, qty, price });
      }
    }

    if (!items.length) {
      await sendFlowViaBotSailor(fromPhone, '❌ No valid products in order. Please try again.');
      return;
    }

    // If any stock issues, warn customer but still process the order (admin can adjust)
    if (stockIssues.length) {
      await sendFlowViaBotSailor(fromPhone, `⚠️ *Stock Alert*\n\n${stockIssues.join('\n')}\n\nWe'll process your order and our team will confirm availability shortly. 📞 +91 70923 77092`);
    }

    // Calculate totals
    const subtotal = items.reduce((sum, i) => sum + i.qty * i.price, 0);
    const gst      = Math.round(subtotal * 0.05 * 100) / 100;
    const shipping  = subtotal >= 499 ? 0 : 50;
    const total     = Math.round((subtotal + gst + shipping) * 100) / 100;

    // Generate order number
    const orderNo = await generateFlowOrderNo();
    const dbId    = crypto.randomUUID();

    // Customer data (stored plain — not PII-encrypted here since no login)
    const waPhone  = fromPhone.replace(/\D/g, '');
    const formPhone = (cust_phone || '').replace(/\D/g, '');
    const customer = {
      name:    cust_name.trim(),
      phone:   formPhone || waPhone,
      address: address.trim(),
      city:    (city    || '').trim(),
      state:   (state   || '').trim(),
      pincode: (pincode || '').trim(),
      wa_phone: waPhone,
    };

    // Save order with pending payment
    const { error: insertErr } = await supabase.from('webstore_orders').insert({
      id:             dbId,
      order_no:       orderNo,
      date:           new Date().toISOString().slice(0, 10),
      customer,
      items,
      subtotal,
      gst,
      shipping,
      total,
      status:         'new',
      payment_status: 'pending',
      channel:        'whatsapp_flow',
      notes:          `WhatsApp Flow | wa: ${waPhone}`,
    });

    if (insertErr) {
      console.error('WA Flow: order insert failed', insertErr.message);
      await sendFlowViaBotSailor(fromPhone, '❌ Could not save your order. Please call +91 70923 77092.');
      return;
    }

    // Create Razorpay Payment Link
    let payUrl = null;
    try {
      const rzp = new Razorpay({
        key_id:     process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
      });
      const custContact = customer.phone.startsWith('91')
        ? `+${customer.phone}`
        : `+91${customer.phone.slice(-10)}`;

      const payLink = await rzp.paymentLink.create({
        amount:          Math.round(total * 100),
        currency:        'INR',
        accept_partial:  false,
        description:     `Sathvam Order ${orderNo}`,
        customer:        { name: customer.name, contact: custContact },
        notify:          { sms: true, email: false },
        reminder_enable: true,
        notes:           { order_no: orderNo, order_id: dbId, channel: 'whatsapp_flow' },
      });
      payUrl = payLink.short_url;

      // Store payment link ID in notes
      await supabase.from('webstore_orders')
        .update({ notes: `WhatsApp Flow | wa: ${waPhone} | rzp_link: ${payLink.id}` })
        .eq('id', dbId);
    } catch (rzpErr) {
      console.error('WA Flow: Razorpay link creation failed', rzpErr.message);
      // Order is saved — continue without payment link, admin will follow up
    }

    // Send order summary + payment link to customer
    const itemList = items.map(i =>
      `  • ${i.name} × ${i.qty} — ₹${(i.qty * i.price).toLocaleString('en-IN')}`
    ).join('\n');

    const custMsg =
      `🌿 *Sathvam — Order Received!*\n\n` +
      `📋 *Order No:* ${orderNo}\n\n` +
      `*Items:*\n${itemList}\n\n` +
      `─────────────────\n` +
      `Subtotal: ₹${subtotal.toLocaleString('en-IN')}\n` +
      (gst > 0 ? `GST (5%):  ₹${gst.toLocaleString('en-IN')}\n` : '') +
      `Shipping:  ${shipping > 0 ? '₹' + shipping : 'FREE 🎉'}\n` +
      `*Total: ₹${total.toLocaleString('en-IN')}*\n\n` +
      `📍 *Deliver to:*\n${[customer.address, customer.city, customer.state, customer.pincode].filter(Boolean).join(', ')}\n\n` +
      (payUrl
        ? `💳 *Pay securely here:*\n${payUrl}\n\n_Your order will be processed once payment is received._`
        : `💳 Our team will send you a payment link shortly.\n📞 For queries: +91 70923 77092`) +
      `\n\n_Thank you for choosing Sathvam! 🙏_`;

    await sendFlowViaBotSailor(fromPhone, custMsg);

    // Notify admins
    const adminNumbers = [
      process.env.WA_ADMIN_PHONE1,
      process.env.WA_ADMIN_PHONE2,
    ].filter(Boolean).map(n => n.replace(/\D/g, '')).filter(Boolean);

    const adminMsg =
      `🛒 *New WhatsApp Flow Order — ${orderNo}*\n\n` +
      `👤 ${customer.name}\n` +
      `📞 ${customer.phone}\n` +
      `📍 ${[customer.city, customer.state].filter(Boolean).join(', ')}\n\n` +
      `📋 ${items.map(i => `${i.name} × ${i.qty}`).join(', ')}\n` +
      `💰 Total: ₹${total.toLocaleString('en-IN')}\n` +
      (payUrl ? `🔗 Pay link sent ✅` : `⚠️ Pay link FAILED — send manually`) +
      `\n\n🔗 admin.sathvam.in → Webstore Orders`;

    for (const ap of adminNumbers) {
      try { await sendFlowViaBotSailor(ap, adminMsg); } catch (e) {}
    }

    console.log(`WA Flow order created: ${orderNo} | total: ₹${total} | from: ${waPhone}`);
  } catch (err) {
    console.error('WA Flow submission error:', err.message);
    try {
      await sendFlowViaBotSailor(fromPhone, '❌ Something went wrong. Please call +91 70923 77092 to place your order.');
    } catch (e) {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/webhook  — Meta webhook challenge verification
// ─────────────────────────────────────────────────────────────────────────────
router.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WA_WEBHOOK_VERIFY_TOKEN) {
    console.log('WhatsApp webhook verified ✅');
    return res.status(200).send(challenge);
  }
  console.warn('WhatsApp webhook verification failed — token mismatch');
  res.status(403).json({ error: 'Forbidden' });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/webhook  — Incoming messages from Meta (no auth)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/webhook', express.json(), async (req, res) => {
  // Always respond 200 immediately so Meta doesn't retry
  res.status(200).json({ ok: true });

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of (body.entry || [])) {
      for (const change of (entry.changes || [])) {
        if (change.field !== 'messages') continue;
        const value    = change.value || {};
        const messages = value.messages || [];
        const contacts = value.contacts || [];
        const statuses = value.statuses || [];

        // Process incoming messages
        for (const msg of messages) {
          const phone       = msg.from;
          const contact     = contacts.find(c => c.wa_id === phone);
          const contactName = contact?.profile?.name || null;

          let content = '';
          switch (msg.type) {
            case 'text':     content = msg.text?.body || '';                                          break;
            case 'image':    content = `[Image${msg.image?.caption ? ': ' + msg.image.caption : ''}]`; break;
            case 'document': content = `[Document: ${msg.document?.filename || 'file'}]`;             break;
            case 'audio':    content = '[Voice message]';                                              break;
            case 'video':    content = `[Video${msg.video?.caption ? ': ' + msg.video.caption : ''}]`; break;
            case 'location': content = `[Location: ${msg.location?.latitude},${msg.location?.longitude}]`; break;
            case 'sticker':  content = '[Sticker]';                                                    break;
            case 'button':   content = `[Button reply: ${msg.button?.text || ''}]`;                   break;
            case 'interactive': content = `[Interactive: ${msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || ''}]`; break;
            default:         content = `[${msg.type}]`;
          }

          await storeMessage({
            wa_message_id: msg.id,
            phone,
            contact_name:  contactName,
            direction:     'inbound',
            type:          msg.type,
            content,
            status:        'received',
            timestamp:     new Date(parseInt(msg.timestamp) * 1000).toISOString(),
          });

          // ── WhatsApp Flow submission ──────────────────────────────────────
          if (msg.type === 'interactive' && msg.interactive?.type === 'nfm_reply') {
            setImmediate(() => handleFlowSubmission(phone, msg.interactive.nfm_reply));
            continue;
          }

          // ── Blog WA share approval via WhatsApp reply ──────────────────
          if (msg.type === 'text' && /^(approve|approved|ok|yes)\s*$/i.test(content.trim())) {
            const adminPhones = [process.env.WA_ADMIN_PHONE1, process.env.WA_ADMIN_PHONE2].filter(Boolean).map(p => {
              const d = (p || '').replace(/\D/g, '');
              return d.length === 10 ? '91' + d : d;
            });
            if (adminPhones.includes(phone)) {
              try {
                const { data: apRow } = await supabase.from('settings').select('value').eq('key', 'blog_wa_approvals').single();
                const approvals = apRow?.value || {};
                const pending = Object.entries(approvals).filter(([, v]) => v === 'pending');
                if (pending.length) {
                  for (const [blogId] of pending) approvals[blogId] = 'approved';
                  await supabase.from('settings').upsert({ key: 'blog_wa_approvals', value: approvals, updated_at: new Date().toISOString() });
                  const { sendText: gaSend } = require('../lib/greenapi');
                  await gaSend(phone, `✅ ${pending.length} blog(s) approved for WhatsApp sharing! Sending will start within 15 minutes.`);
                  continue;
                }
              } catch (e) { console.error('[blog-approve-wa]', e.message); }
            }
          }

          // ── Auto-reply (text messages only) ──────────────────────────────
          if (!AI_REPLIES_ENABLED || msg.type !== 'text' || !content.trim()) continue;

          // 1. Keyword shortcuts — fast, no AI needed
          const kwReply = await keywordReply(content, phone);
          if (kwReply) {
            await sendReply(phone, kwReply);
            continue;
          }

          // 2. AI reply via Claude
          try {
            const history     = await loadHistory(phone);
            const productCtx  = await getProductContext();

            const aiResponse = await anthropic.messages.create({
              model:      'claude-sonnet-4-6',
              max_tokens: 350,
              system: `You are Sathvam's WhatsApp assistant. Sathvam sells cold-pressed oils and natural products.
Keep replies SHORT (3-4 lines max) — this is WhatsApp, not email.
Use simple language. Support English and Tamil.
Never make up prices or availability — use only what's listed below.
If asked about order tracking, tell them to reply with: TRACK <order number>
Store: https://sathvam.in | WhatsApp orders: message us here.

CURRENT PRODUCTS:
${productCtx}`,
              messages: [
                ...history,
                { role: 'user', content },
              ],
            });

            const reply = aiResponse.content[0]?.text || '';
            if (!reply) continue;

            await sendReply(phone, reply);
            await saveHistory(phone, [
              ...history,
              { role: 'user',      content },
              { role: 'assistant', content: reply },
            ]);
          } catch (aiErr) {
            console.error('WA AI reply error:', aiErr.message);
            // Send fallback message so customer isn't left waiting
            try {
              await sendReply(phone, '🙏 Sorry, I couldn\'t process that right now. Please try again or call us at +91 70923 77092 for immediate help.\n\n🛒 Shop: https://sathvam.in');
            } catch (fallbackErr) {
              console.error('WA fallback reply error:', fallbackErr.message);
            }
          }
        }

        // Process delivery/read status updates for outbound messages
        for (const status of statuses) {
          const updateFields = { status: status.status };
          // Track delivery failures
          if (status.status === 'failed' && status.errors?.length) {
            updateFields.delivery_error = status.errors.map(e => `${e.code}: ${e.title}`).join('; ');
          }
          await supabase.from('whatsapp_messages')
            .update(updateFields)
            .eq('wa_message_id', status.id);
        }
      }
    }
  } catch (e) {
    console.error('WhatsApp webhook processing error:', e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/green-webhook  — Green API incoming notifications
// ─────────────────────────────────────────────────────────────────────────────
router.post('/green-webhook', express.json(), async (req, res) => {
  res.status(200).json({ ok: true });

  try {
    const body = req.body;
    const type = body.typeWebhook;

    // Only process incoming messages
    if (type === 'incomingMessageReceived' || type === 'incomingMessageReceivedByEvent') {
      const sender   = body.senderData || {};
      const msgData  = body.messageData || {};
      const chatId   = sender.chatId || '';

      // Skip group messages
      if (chatId.endsWith('@g.us')) return;

      // Extract phone from chatId: "91XXXXXXXXXX@c.us" → "91XXXXXXXXXX"
      const phone = chatId.replace('@c.us', '');
      if (!phone || phone.length < 10) return;

      const contactName = sender.senderName || sender.senderContactName || null;
      const msgType     = msgData.typeMessage || 'unknown';
      const msgId       = body.idMessage || `ga_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

      let content = '';
      let mediaUrl = null;
      let mediaType = null;
      let quotedMsgId = null;
      let quotedContent = null;

      switch (msgType) {
        case 'textMessage':
          content = msgData.textMessageData?.textMessage || '';
          break;
        case 'extendedTextMessage':
          content = msgData.extendedTextMessageData?.text || '';
          // Check for quoted message in extended text
          if (msgData.extendedTextMessageData?.stanzaId) {
            quotedMsgId = msgData.extendedTextMessageData.stanzaId;
            quotedContent = msgData.extendedTextMessageData?.quotedMessage?.conversation || null;
          }
          break;
        case 'imageMessage':
          content = `[Image${msgData.imageMessage?.caption ? ': ' + msgData.imageMessage.caption : ''}]`;
          mediaUrl = msgData.imageMessage?.downloadUrl || null;
          mediaType = 'image';
          break;
        case 'videoMessage':
          content = `[Video${msgData.videoMessage?.caption ? ': ' + msgData.videoMessage.caption : ''}]`;
          mediaUrl = msgData.videoMessage?.downloadUrl || null;
          mediaType = 'video';
          break;
        case 'documentMessage':
          content = `[Document: ${msgData.documentMessage?.fileName || 'file'}]`;
          mediaUrl = msgData.documentMessage?.downloadUrl || null;
          mediaType = 'document';
          break;
        case 'audioMessage':
          content = '[Voice message]';
          mediaUrl = msgData.audioMessage?.downloadUrl || null;
          mediaType = 'audio';
          break;
        case 'stickerMessage':
          content = '[Sticker]';
          break;
        case 'locationMessage':
          content = `[Location: ${msgData.locationMessage?.latitude || ''},${msgData.locationMessage?.longitude || ''}]`;
          break;
        case 'contactMessage':
          content = `[Contact: ${msgData.contactMessage?.displayName || 'contact'}]`;
          break;
        case 'quotedMessage':
          content = msgData.quotedMessage?.textMessage || msgData.extendedTextMessageData?.text || '[Quoted message]';
          break;
        default:
          content = `[${msgType}]`;
      }

      if (!content) return;

      await storeMessage({
        wa_message_id: msgId,
        phone,
        contact_name:  contactName,
        direction:     'inbound',
        type:          msgType === 'textMessage' || msgType === 'extendedTextMessage' ? 'text' : msgType.replace('Message', ''),
        content,
        status:        'received',
        timestamp:     body.timestamp ? new Date(body.timestamp * 1000).toISOString() : new Date().toISOString(),
        media_url:     mediaUrl,
        media_type:    mediaType,
        quoted_message_id: quotedMsgId,
        quoted_content:    quotedContent,
      });

      console.log(`[green-webhook] Inbound from ${phone}: ${content.slice(0, 80)}`);

      // AI auto-reply for text messages
      if (AI_REPLIES_ENABLED && (msgType === 'textMessage' || msgType === 'extendedTextMessage') && content.trim()) {
        // Check auto-reply schedule — send away message outside business hours
        try {
          const { data: arRow } = await supabase.from('settings').select('value').eq('key', 'wa_auto_reply').maybeSingle();
          const arConfig = arRow?.value;
          if (arConfig && arConfig.enabled) {
            const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
            const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
            const todayDay = dayNames[nowIST.getUTCDay()];
            const todayHours = arConfig.businessHours?.[todayDay];
            if (todayHours && todayHours.start && todayHours.end) {
              const hhmm = `${String(nowIST.getUTCHours()).padStart(2, '0')}:${String(nowIST.getUTCMinutes()).padStart(2, '0')}`;
              if (hhmm < todayHours.start || hhmm >= todayHours.end) {
                // Outside business hours — send away message
                const awayMsg = arConfig.awayMessage || 'Thank you for reaching out! We are currently away and will get back to you during business hours. 🙏';
                await sendReply(phone, awayMsg);
                return;
              }
            } else if (!todayHours) {
              // No hours configured for today = closed
              const awayMsg = arConfig.awayMessage || 'Thank you for reaching out! We are currently away and will get back to you during business hours. 🙏';
              await sendReply(phone, awayMsg);
              return;
            }
          }
        } catch (arErr) {
          console.error('[green-webhook] Auto-reply schedule check error:', arErr.message);
          // Fail open — continue to AI reply
        }

        // Check keyword shortcuts first
        const kwReply = await keywordReply(content, phone);
        if (kwReply) {
          await sendReply(phone, kwReply);
          return;
        }

        // AI reply
        try {
          const history    = await loadHistory(phone);
          const productCtx = await getProductContext();

          const aiResponse = await anthropic.messages.create({
            model:      'claude-sonnet-4-6',
            max_tokens: 350,
            system: `You are Sathvam's WhatsApp assistant. Sathvam sells cold-pressed oils and natural products.
Keep replies SHORT (3-4 lines max) — this is WhatsApp, not email.
Use simple language. Support English and Tamil.
Never make up prices or availability — use only what's listed below.
If asked about order tracking, tell them to reply with: TRACK <order number>
Store: https://sathvam.in | WhatsApp orders: message us here.

CURRENT PRODUCTS:
${productCtx}`,
            messages: [
              ...history,
              { role: 'user', content },
            ],
          });

          const reply = aiResponse.content[0]?.text || '';
          if (reply) {
            await sendReply(phone, reply);
            await saveHistory(phone, [
              ...history,
              { role: 'user', content },
              { role: 'assistant', content: reply },
            ]);
          }
        } catch (aiErr) {
          console.error('[green-webhook] AI reply error:', aiErr.message);
          // Send fallback message so customer isn't left waiting
          try {
            await sendReply(phone, '🙏 Sorry, I couldn\'t process that right now. Please try again or call us at +91 70923 77092 for immediate help.\n\n🛒 Shop: https://sathvam.in');
          } catch (fallbackErr) {
            console.error('[green-webhook] Fallback reply error:', fallbackErr.message);
          }
        }
      }
    }

    // Outgoing message status updates — track delivery failures
    if (type === 'outgoingMessageStatus' || type === 'outgoingAPIMessageStatus') {
      const msgId  = body.idMessage;
      const status = body.status; // 'sent', 'delivered', 'read', 'failed', 'noAccount', 'notInGroup'
      if (msgId && status) {
        const updateFields = { status };
        // Track failure details
        if (['failed', 'noAccount', 'notInGroup'].includes(status)) {
          updateFields.delivery_error = body.description || body.sendByApi || status;
        }
        await supabase.from('whatsapp_messages')
          .update(updateFields)
          .eq('wa_message_id', msgId);
      }
    }
  } catch (e) {
    console.error('[green-webhook] Error:', e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/setup-green-webhook  — Configure Green API webhook URL
// ─────────────────────────────────────────────────────────────────────────────
router.post('/setup-green-webhook', auth, async (req, res) => {
  try {
    const instanceId = process.env.GREENAPI_INSTANCE_ID;
    const apiToken   = process.env.GREENAPI_API_TOKEN;
    if (!instanceId || !apiToken) {
      return res.status(400).json({ error: 'GREENAPI_INSTANCE_ID or GREENAPI_API_TOKEN not set' });
    }

    const webhookUrl = `https://api.sathvam.in/api/whatsapp/green-webhook`;

    const r = await fetch(`https://api.green-api.com/waInstance${instanceId}/setSettings/${apiToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webhookUrl,
        webhookUrlToken: '',
        incomingWebhook: 'yes',
        outgoingWebhook: 'yes',
        outgoingAPIMessageWebhook: 'yes',
        outgoingMessageWebhook: 'yes',
        stateWebhook: 'no',
        deviceWebhook: 'no',
      }),
    });
    const data = await r.json();
    console.log('[green-webhook] Setup response:', JSON.stringify(data));

    res.json({ ok: true, webhookUrl, response: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/status  — Check configuration status
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status', auth, async (req, res) => {
  // Check Green API webhook status
  let greenWebhookOk = false;
  let greenWebhookUrl = '';
  try {
    const instanceId = process.env.GREENAPI_INSTANCE_ID;
    const apiToken   = process.env.GREENAPI_API_TOKEN;
    if (instanceId && apiToken) {
      const r = await fetch(`https://api.green-api.com/waInstance${instanceId}/getSettings/${apiToken}`);
      const settings = await r.json();
      greenWebhookUrl = settings.webhookUrl || '';
      greenWebhookOk = greenWebhookUrl.includes('sathvam.in');
    }
  } catch (e) {}

  res.json({
    configured: !!(process.env.GREENAPI_INSTANCE_ID && process.env.GREENAPI_API_TOKEN),
    green_api_instance: process.env.GREENAPI_INSTANCE_ID ? '✅ Set' : '❌ Missing',
    green_api_token:    process.env.GREENAPI_API_TOKEN    ? '✅ Set' : '❌ Missing',
    green_webhook:      greenWebhookOk ? `✅ ${greenWebhookUrl}` : `❌ Not configured`,
    waba_id:            process.env.WA_WABA_ID         ? '✅ Set' : '❌ Missing',
    notify_to:          process.env.WA_NOTIFY_TO || '(not set)',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/conversations  — All conversations grouped by phone
// ─────────────────────────────────────────────────────────────────────────────
router.get('/conversations', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('whatsapp_messages')
      .select('phone,contact_name,content,direction,timestamp,read_at,type')
      .order('timestamp', { ascending: false })
      .limit(500);
    if (error) throw error;

    const convMap = {};
    for (const msg of (data || [])) {
      if (!convMap[msg.phone]) {
        convMap[msg.phone] = {
          phone:        msg.phone,
          contact_name: msg.contact_name,
          last_message: msg.content,
          last_time:    msg.timestamp,
          unread:       0,
          total:        0,
        };
      }
      convMap[msg.phone].total++;
      // Update contact name if this message has one and we don't have one yet
      if (msg.contact_name && !convMap[msg.phone].contact_name) {
        convMap[msg.phone].contact_name = msg.contact_name;
      }
      if (msg.direction === 'inbound' && !msg.read_at) {
        convMap[msg.phone].unread++;
      }
    }

    const conversations = Object.values(convMap)
      .sort((a, b) => new Date(b.last_time) - new Date(a.last_time));

    res.json(conversations);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/conversations/:phone  — Message thread for one contact
// ─────────────────────────────────────────────────────────────────────────────
router.get('/conversations/:phone', auth, async (req, res) => {
  try {
    const phone = normalisePhone(req.params.phone);
    if (!phone) return res.status(400).json({ error: 'Invalid phone' });

    const { data, error } = await supabase
      .from('whatsapp_messages')
      .select('*')
      .eq('phone', phone)
      .order('timestamp', { ascending: true });
    if (error) throw error;

    // Mark inbound as read
    await supabase.from('whatsapp_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('phone', phone)
      .eq('direction', 'inbound')
      .is('read_at', null);

    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/send  — Send a message (text or template)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/send', auth, async (req, res) => {
  try {
    const { phone, type = 'text', text, template } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });

    const to = normalisePhone(phone);
    if (to.length < 10) return res.status(400).json({ error: 'Invalid phone number' });

    if (!text?.trim()) return res.status(400).json({ error: 'text required' });

    const ok = await gaSendText(to, text.trim(), { priority: true });
    if (!ok) return res.status(500).json({ error: 'Failed to send via Green API' });

    await storeMessage({
      phone:     to,
      direction: 'outbound',
      type:      'text',
      content:   text.trim(),
      status:    'sent',
      timestamp: new Date().toISOString(),
      sent_by:   req.user?.username || req.user?.name || 'admin',
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/typing  — Send "typing..." presence indicator to customer
// ─────────────────────────────────────────────────────────────────────────────
router.post('/typing', auth, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const to = normalisePhone(phone);
    await gaSendTyping(to);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/templates  — Fetch approved templates from Meta
// ─────────────────────────────────────────────────────────────────────────────
router.get('/templates', auth, async (req, res) => {
  // Green API does not use pre-approved templates — send plain text messages freely
  res.json({ templates: [], note: 'Green API does not require pre-approved templates. Use plain text messages.' });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/notify/order  — Send order notification template to customer
// ─────────────────────────────────────────────────────────────────────────────
router.post('/notify/order', auth, async (req, res) => {
  try {
    const { phone, orderNo, event = 'confirmed', templateName } = req.body;
    if (!phone || !orderNo) return res.status(400).json({ error: 'phone and orderNo required' });

    const to  = normalisePhone(phone);
    const msg = `🛍️ *Order Update — ${orderNo}*\n\nYour order status has been updated to: *${event}*.\n\nFor details visit: https://sathvam.in\nQueries: +91 70923 77092`;

    const ok = await gaSendText(to, msg);
    if (!ok) return res.status(500).json({ error: 'Failed to send via Green API' });

    await storeMessage({
      phone:     to,
      direction: 'outbound',
      type:      'text',
      content:   msg,
      status:    'sent',
      timestamp: new Date().toISOString(),
      sent_by:   'system',
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/unread-count  — Badge count for nav
// ─────────────────────────────────────────────────────────────────────────────
router.get('/unread-count', auth, async (req, res) => {
  try {
    const { count, error } = await supabase
      .from('whatsapp_messages')
      .select('*', { count: 'exact', head: true })
      .eq('direction', 'inbound')
      .is('read_at', null);
    if (error) throw error;
    res.json({ count: count || 0 });
  } catch (e) {
    res.status(500).json({ count: 0 });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/send-file  — Send a file via URL
// ─────────────────────────────────────────────────────────────────────────────
router.post('/send-file', auth, async (req, res) => {
  try {
    const { phone, fileUrl, fileName, caption } = req.body;
    if (!phone || !fileUrl) return res.status(400).json({ error: 'phone and fileUrl required' });

    const to = normalisePhone(phone);
    if (to.length < 10) return res.status(400).json({ error: 'Invalid phone number' });

    const ok = await gaSendFile(to, fileUrl, fileName || 'file', caption || '', { priority: true });
    if (!ok) return res.status(500).json({ error: 'Failed to send file via Green API' });

    // Determine type from fileName extension
    const ext = (fileName || '').split('.').pop().toLowerCase();
    const type = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext) ? 'image' : 'document';

    await storeMessage({
      phone:      to,
      direction:  'outbound',
      type,
      content:    caption || `[${type === 'image' ? 'Image' : 'Document'}: ${fileName || 'file'}]`,
      status:     'sent',
      timestamp:  new Date().toISOString(),
      sent_by:    req.user?.username || 'admin',
      media_url:  fileUrl,
      media_type: type,
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/search  — Search messages by content
// ─────────────────────────────────────────────────────────────────────────────
router.get('/search', auth, async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'q query param required' });

    const { data, error } = await supabase
      .from('whatsapp_messages')
      .select('phone,contact_name,content,timestamp,direction')
      .ilike('content', `%${q}%`)
      .order('timestamp', { ascending: false })
      .limit(50);
    if (error) throw error;

    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/contact-info/:phone  — CRM info for a WhatsApp contact
// ─────────────────────────────────────────────────────────────────────────────
router.get('/contact-info/:phone', auth, async (req, res) => {
  try {
    const rawPhone = normalisePhone(req.params.phone);
    if (!rawPhone) return res.status(400).json({ error: 'Invalid phone' });

    const last10 = rawPhone.slice(-10);
    const with91 = '91' + last10;

    // Look up in customers table
    let customer = null;
    try {
      const { data } = await supabase
        .from('customers')
        .select('id,name,email,phone,address,city,state')
        .or(`phone.eq.${last10},phone.eq.${with91},phone.eq.${rawPhone}`)
        .limit(1)
        .maybeSingle();
      customer = data;
    } catch (e) {}

    // Look up orders
    const { data: orders } = await supabase
      .from('webstore_orders')
      .select('order_no,status,total,created_at')
      .ilike('customer->>phone', `%${last10}`)
      .order('created_at', { ascending: false })
      .limit(10);

    const orderList = orders || [];
    const totalSpent = orderList.reduce((s, o) => s + (parseFloat(o.total) || 0), 0);
    const lastOrderDate = orderList.length ? orderList[0].created_at : null;

    // Loyalty points
    let loyaltyPoints = 0;
    if (customer?.id) {
      try {
        const { data: loyaltyRow } = await supabase.from('settings').select('value').eq('key', `cust_loyalty_${customer.id}`).maybeSingle();
        loyaltyPoints = loyaltyRow?.value?.points || 0;
      } catch (e) {}
    }

    res.json({
      name:           customer?.name || null,
      phone:          rawPhone,
      email:          customer?.email || null,
      address:        customer?.address || null,
      city:           customer?.city || null,
      state:          customer?.state || null,
      orderCount:     orderList.length,
      totalSpent:     Math.round(totalSpent * 100) / 100,
      lastOrderDate,
      loyaltyPoints,
      orders:         orderList,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/labels  — Conversation label definitions
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_LABELS = [
  { id: 'payment',  name: 'Payment Issue', color: '#ef4444' },
  { id: 'return',   name: 'Return/Refund', color: '#f97316' },
  { id: 'lead',     name: 'New Lead',      color: '#22c55e' },
  { id: 'vip',      name: 'VIP',           color: '#a855f7' },
  { id: 'support',  name: 'Support',       color: '#3b82f6' },
  { id: 'followup', name: 'Follow Up',     color: '#eab308' },
];

router.get('/labels', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'wa_labels').maybeSingle();
    res.json(data?.value?.labels || DEFAULT_LABELS);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/labels  — Update label definitions
// ─────────────────────────────────────────────────────────────────────────────
router.post('/labels', auth, async (req, res) => {
  try {
    const { labels } = req.body;
    if (!Array.isArray(labels)) return res.status(400).json({ error: 'labels array required' });

    await supabase.from('settings').upsert({
      key:        'wa_labels',
      value:      { labels },
      updated_at: new Date().toISOString(),
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/conv-labels  — Labels assigned to conversations
// ─────────────────────────────────────────────────────────────────────────────
router.get('/conv-labels', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'wa_conv_labels').maybeSingle();
    res.json(data?.value || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/conversations/:phone/labels  — Set labels for a conversation
// ─────────────────────────────────────────────────────────────────────────────
router.post('/conversations/:phone/labels', auth, async (req, res) => {
  try {
    const phone = normalisePhone(req.params.phone);
    if (!phone) return res.status(400).json({ error: 'Invalid phone' });
    const { labels } = req.body;
    if (!Array.isArray(labels)) return res.status(400).json({ error: 'labels array required' });

    const { data: existing } = await supabase.from('settings').select('value').eq('key', 'wa_conv_labels').maybeSingle();
    const convLabels = existing?.value || {};
    convLabels[phone] = labels;

    await supabase.from('settings').upsert({
      key:        'wa_conv_labels',
      value:      convLabels,
      updated_at: new Date().toISOString(),
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/assignments  — Conversation assignments
// ─────────────────────────────────────────────────────────────────────────────
router.get('/assignments', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'wa_assignments').maybeSingle();
    res.json(data?.value || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/conversations/:phone/assign  — Assign conversation to a user
// ─────────────────────────────────────────────────────────────────────────────
router.post('/conversations/:phone/assign', auth, async (req, res) => {
  try {
    const phone = normalisePhone(req.params.phone);
    if (!phone) return res.status(400).json({ error: 'Invalid phone' });
    const { assignee } = req.body; // username string or null to unassign

    const { data: existing } = await supabase.from('settings').select('value').eq('key', 'wa_assignments').maybeSingle();
    const assignments = existing?.value || {};

    if (assignee) {
      assignments[phone] = {
        assignee,
        assigned_at: new Date().toISOString(),
        assigned_by: req.user?.username || req.user?.name || 'admin',
      };
    } else {
      delete assignments[phone];
    }

    await supabase.from('settings').upsert({
      key:        'wa_assignments',
      value:      assignments,
      updated_at: new Date().toISOString(),
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/conversations/:phone/notes  — Internal notes for a conversation
// ─────────────────────────────────────────────────────────────────────────────
router.get('/conversations/:phone/notes', auth, async (req, res) => {
  try {
    const phone = normalisePhone(req.params.phone);
    if (!phone) return res.status(400).json({ error: 'Invalid phone' });

    const { data } = await supabase.from('settings').select('value').eq('key', `wa_notes_${phone}`).maybeSingle();
    res.json({ notes: data?.value?.notes || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/conversations/:phone/notes  — Add internal note
// ─────────────────────────────────────────────────────────────────────────────
router.post('/conversations/:phone/notes', auth, async (req, res) => {
  try {
    const phone = normalisePhone(req.params.phone);
    if (!phone) return res.status(400).json({ error: 'Invalid phone' });
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'text required' });

    const settingsKey = `wa_notes_${phone}`;
    const { data: existing } = await supabase.from('settings').select('value').eq('key', settingsKey).maybeSingle();
    const notes = existing?.value?.notes || [];

    notes.push({
      text: text.trim(),
      by:   req.user?.username || req.user?.name || 'admin',
      at:   new Date().toISOString(),
    });

    await supabase.from('settings').upsert({
      key:        settingsKey,
      value:      { notes },
      updated_at: new Date().toISOString(),
    });

    res.json({ ok: true, notes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/conversations/:phone/export  — Export chat as text file
// ─────────────────────────────────────────────────────────────────────────────
router.get('/conversations/:phone/export', auth, async (req, res) => {
  try {
    const phone = normalisePhone(req.params.phone);
    if (!phone) return res.status(400).json({ error: 'Invalid phone' });

    const { data, error } = await supabase
      .from('whatsapp_messages')
      .select('content,direction,timestamp,sent_by,contact_name')
      .eq('phone', phone)
      .order('timestamp', { ascending: true });
    if (error) throw error;

    const lines = (data || []).map(m => {
      const ts     = m.timestamp ? new Date(m.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '';
      const sender = m.direction === 'inbound'
        ? (m.contact_name || phone)
        : (m.sent_by || 'Sathvam');
      return `[${ts}] ${sender}: ${m.content}`;
    });

    const text = lines.join('\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="chat_${phone}.txt"`);
    res.send(text);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/auto-reply-schedule  — Auto-reply / away message config
// ─────────────────────────────────────────────────────────────────────────────
router.get('/auto-reply-schedule', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'wa_auto_reply').maybeSingle();
    res.json(data?.value || {
      enabled: false,
      awayMessage: 'Thank you for reaching out! We are currently away and will get back to you during business hours. 🙏',
      businessHours: {
        mon: { start: '09:00', end: '18:00' },
        tue: { start: '09:00', end: '18:00' },
        wed: { start: '09:00', end: '18:00' },
        thu: { start: '09:00', end: '18:00' },
        fri: { start: '09:00', end: '18:00' },
        sat: { start: '09:00', end: '14:00' },
        sun: null,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/auto-reply-schedule  — Save auto-reply config
// ─────────────────────────────────────────────────────────────────────────────
router.post('/auto-reply-schedule', auth, async (req, res) => {
  try {
    const config = req.body;
    if (typeof config !== 'object') return res.status(400).json({ error: 'config object required' });

    await supabase.from('settings').upsert({
      key:        'wa_auto_reply',
      value:      config,
      updated_at: new Date().toISOString(),
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/analytics  — Message analytics for last 30 days
// ─────────────────────────────────────────────────────────────────────────────
router.get('/analytics', auth, async (req, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('whatsapp_messages')
      .select('phone,direction,timestamp')
      .gte('timestamp', thirtyDaysAgo)
      .order('timestamp', { ascending: true });
    if (error) throw error;

    const messages = data || [];

    // Messages per day
    const dayMap = {};
    for (const m of messages) {
      const day = m.timestamp?.slice(0, 10);
      if (!day) continue;
      if (!dayMap[day]) dayMap[day] = { date: day, inbound: 0, outbound: 0 };
      dayMap[day][m.direction === 'inbound' ? 'inbound' : 'outbound']++;
    }
    const messagesPerDay = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));

    // Busiest hours (IST)
    const hourCounts = new Array(24).fill(0);
    for (const m of messages) {
      if (!m.timestamp) continue;
      const utcHour = new Date(m.timestamp).getUTCHours();
      const istHour = (utcHour + 5) % 24; // approximate IST (+5:30 rounded)
      hourCounts[istHour]++;
    }
    const busiestHours = hourCounts.map((count, hour) => ({ hour, count }));

    // Avg response time (minutes) — time between inbound and next outbound for same phone
    const phoneMessages = {};
    for (const m of messages) {
      if (!phoneMessages[m.phone]) phoneMessages[m.phone] = [];
      phoneMessages[m.phone].push(m);
    }

    let totalResponseMs = 0;
    let responseCount = 0;
    for (const phone of Object.keys(phoneMessages)) {
      const msgs = phoneMessages[phone];
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].direction !== 'inbound') continue;
        // Find next outbound
        for (let j = i + 1; j < msgs.length; j++) {
          if (msgs[j].direction === 'outbound') {
            const diff = new Date(msgs[j].timestamp) - new Date(msgs[i].timestamp);
            if (diff > 0 && diff < 24 * 60 * 60 * 1000) { // within 24h
              totalResponseMs += diff;
              responseCount++;
            }
            break;
          }
        }
      }
    }

    const avgResponseMinutes = responseCount > 0 ? Math.round(totalResponseMs / responseCount / 60000) : null;

    // Totals
    const phones = new Set(messages.map(m => m.phone));
    const totalInbound  = messages.filter(m => m.direction === 'inbound').length;
    const totalOutbound = messages.filter(m => m.direction === 'outbound').length;

    res.json({
      messagesPerDay,
      avgResponseMinutes,
      busiestHours,
      totals: {
        totalConversations: phones.size,
        totalInbound,
        totalOutbound,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Quick Replies — backend-persisted, shared across team (#7)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/quick-replies', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'wa_quick_replies').maybeSingle();
    res.json(data?.value?.replies || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/quick-replies', auth, async (req, res) => {
  try {
    const { replies } = req.body;
    if (!Array.isArray(replies)) return res.status(400).json({ error: 'replies array required' });
    await supabase.from('settings').upsert({
      key: 'wa_quick_replies',
      value: { replies, updated_by: req.user?.username || 'admin', updated_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Paginated conversations — for large message history (#10)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/conversations/:phone/paginated', auth, async (req, res) => {
  try {
    const phone = normalisePhone(req.params.phone);
    if (!phone) return res.status(400).json({ error: 'Invalid phone' });
    const page = parseInt(req.query.page || '1');
    const limit = parseInt(req.query.limit || '50');
    const offset = (page - 1) * limit;

    // Get total count
    const { count } = await supabase
      .from('whatsapp_messages')
      .select('*', { count: 'exact', head: true })
      .eq('phone', phone);

    // Get paginated messages (newest first for pagination, reverse for display)
    const { data, error } = await supabase
      .from('whatsapp_messages')
      .select('*')
      .eq('phone', phone)
      .order('timestamp', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;

    // Mark inbound as read (only first page)
    if (page === 1) {
      await supabase.from('whatsapp_messages')
        .update({ read_at: new Date().toISOString() })
        .eq('phone', phone)
        .eq('direction', 'inbound')
        .is('read_at', null);
    }

    res.json({
      messages: (data || []).reverse(),
      total: count || 0,
      page,
      pages: Math.ceil((count || 0) / limit),
      hasMore: offset + limit < (count || 0),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Bulk conversation actions — assign/label multiple conversations (#12)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/bulk-action', auth, async (req, res) => {
  try {
    const { phones, action, labelId, assignee, markRead } = req.body;
    if (!Array.isArray(phones) || !phones.length) return res.status(400).json({ error: 'phones array required' });
    if (!action) return res.status(400).json({ error: 'action required (label, assign, read)' });

    if (action === 'label' && labelId) {
      const { data: existing } = await supabase.from('settings').select('value').eq('key', 'wa_conv_labels').maybeSingle();
      const convLabels = existing?.value || {};
      for (const phone of phones) {
        const cur = convLabels[phone] || [];
        if (!cur.includes(labelId)) convLabels[phone] = [...cur, labelId];
      }
      await supabase.from('settings').upsert({ key: 'wa_conv_labels', value: convLabels, updated_at: new Date().toISOString() });
      return res.json({ ok: true, action: 'label', count: phones.length });
    }

    if (action === 'unlabel' && labelId) {
      const { data: existing } = await supabase.from('settings').select('value').eq('key', 'wa_conv_labels').maybeSingle();
      const convLabels = existing?.value || {};
      for (const phone of phones) {
        convLabels[phone] = (convLabels[phone] || []).filter(l => l !== labelId);
      }
      await supabase.from('settings').upsert({ key: 'wa_conv_labels', value: convLabels, updated_at: new Date().toISOString() });
      return res.json({ ok: true, action: 'unlabel', count: phones.length });
    }

    if (action === 'assign' && assignee !== undefined) {
      const { data: existing } = await supabase.from('settings').select('value').eq('key', 'wa_assignments').maybeSingle();
      const assignments = existing?.value || {};
      for (const phone of phones) {
        if (assignee) {
          assignments[phone] = { assignee, assigned_at: new Date().toISOString(), assigned_by: req.user?.username || 'admin' };
        } else {
          delete assignments[phone];
        }
      }
      await supabase.from('settings').upsert({ key: 'wa_assignments', value: assignments, updated_at: new Date().toISOString() });
      return res.json({ ok: true, action: 'assign', count: phones.length });
    }

    if (action === 'read') {
      for (const phone of phones) {
        await supabase.from('whatsapp_messages')
          .update({ read_at: new Date().toISOString() })
          .eq('phone', normalisePhone(phone))
          .eq('direction', 'inbound')
          .is('read_at', null);
      }
      return res.json({ ok: true, action: 'read', count: phones.length });
    }

    res.status(400).json({ error: 'Invalid action. Use: label, unlabel, assign, read' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Enhanced Analytics — top customers, message types, AI success, failed msgs (#14)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/analytics/enhanced', auth, async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30');
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('whatsapp_messages')
      .select('phone,contact_name,direction,type,status,timestamp,sent_by,delivery_error')
      .gte('timestamp', since)
      .order('timestamp', { ascending: true });
    if (error) throw error;

    const messages = data || [];

    // Top customers by message count
    const custCounts = {};
    for (const m of messages) {
      if (m.direction !== 'inbound') continue;
      const key = m.phone;
      if (!custCounts[key]) custCounts[key] = { phone: key, name: m.contact_name, count: 0 };
      custCounts[key].count++;
      if (m.contact_name && !custCounts[key].name) custCounts[key].name = m.contact_name;
    }
    const topCustomers = Object.values(custCounts).sort((a, b) => b.count - a.count).slice(0, 10);

    // Message type breakdown
    const typeCounts = {};
    for (const m of messages) {
      const t = m.type || 'unknown';
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }

    // Delivery status breakdown
    const statusCounts = {};
    const outbound = messages.filter(m => m.direction === 'outbound');
    for (const m of outbound) {
      const s = m.status || 'unknown';
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    }

    // Failed messages
    const failedMessages = messages.filter(m => m.direction === 'outbound' && ['failed', 'noAccount', 'notInGroup'].includes(m.status));

    // AI vs manual replies
    const botReplies = outbound.filter(m => m.sent_by === 'bot' || m.sent_by === 'system').length;
    const humanReplies = outbound.filter(m => m.sent_by && m.sent_by !== 'bot' && m.sent_by !== 'system').length;

    // First response time (how fast we reply to NEW contacts)
    const phoneFirst = {};
    const responseTimes = [];
    for (const m of messages) {
      if (!phoneFirst[m.phone]) phoneFirst[m.phone] = [];
      phoneFirst[m.phone].push(m);
    }
    for (const msgs of Object.values(phoneFirst)) {
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].direction !== 'inbound') continue;
        for (let j = i + 1; j < msgs.length; j++) {
          if (msgs[j].direction === 'outbound') {
            const diff = new Date(msgs[j].timestamp) - new Date(msgs[i].timestamp);
            if (diff > 0 && diff < 24 * 60 * 60 * 1000) responseTimes.push(diff);
            break;
          }
        }
      }
    }
    const avgResponseMs = responseTimes.length ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length : null;

    // Rate limit status
    const { getDailySendCount } = require('../lib/greenapi');
    const rateLimitStatus = getDailySendCount();

    res.json({
      topCustomers,
      messageTypes: typeCounts,
      deliveryStatus: statusCounts,
      failedCount: failedMessages.length,
      failedMessages: failedMessages.slice(0, 20).map(m => ({ phone: m.phone, content: (m.content || '').slice(0, 80), timestamp: m.timestamp, error: m.delivery_error })),
      aiVsHuman: { bot: botReplies, human: humanReplies, total: outbound.length },
      avgResponseMinutes: avgResponseMs ? Math.round(avgResponseMs / 60000) : null,
      rateLimitStatus,
      totalInbound: messages.filter(m => m.direction === 'inbound').length,
      totalOutbound: outbound.length,
      uniqueContacts: new Set(messages.map(m => m.phone)).size,
      period: `${days} days`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/failed-messages — List failed outbound messages (#3)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/failed-messages', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('whatsapp_messages')
      .select('phone,contact_name,content,timestamp,status,delivery_error')
      .eq('direction', 'outbound')
      .in('status', ['failed', 'noAccount', 'notInGroup'])
      .order('timestamp', { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
