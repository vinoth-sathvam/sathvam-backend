/**
 * BotSailor WhatsApp Integration
 *
 * BotSailor acts as a middleware between WhatsApp Business and this backend.
 * It handles the Meta/WhatsApp connection — we just receive webhooks and reply via their API.
 *
 * Endpoints:
 *   POST /api/botsailor/webhook  — BotSailor sends incoming messages here (no auth, verified by secret)
 *
 * Required .env:
 *   BOTSAILOR_API_TOKEN    — from BotSailor Settings → API
 *   BOTSAILOR_WEBHOOK_SECRET (optional) — to verify incoming webhook calls
 *
 * BotSailor webhook payload:
 *   { subscriber_phone, subscriber_id, subscriber_name, last_message, bot_id, ... }
 *
 * BotSailor send API:
 *   POST https://www.botsailor.com/api/whatsapp/send-text-message?apiToken=TOKEN
 *   Body: { subscriber_id, message }
 */

const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const router    = express.Router();
const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BOTSAILOR_API_TOKEN  = () => process.env.BOTSAILOR_API_TOKEN;
const BOTSAILOR_PHONE_ID   = () => process.env.BOTSAILOR_PHONE_NUMBER_ID || process.env.WA_PHONE_NUMBER_ID;
const BOTSAILOR_SEND_URL   = 'https://botsailor.com/api/v1/whatsapp/send';
const AI_REPLIES_ENABLED   = process.env.WHATSAPP_AI_REPLIES !== 'false';

// ── Helper: send reply via BotSailor API ──────────────────────────────────────
async function sendReply(phone, message) {
  const token   = BOTSAILOR_API_TOKEN();
  const phoneId = BOTSAILOR_PHONE_ID();
  if (!token)   { console.error('BotSailor: BOTSAILOR_API_TOKEN not set'); return; }
  if (!phoneId) { console.error('BotSailor: BOTSAILOR_PHONE_NUMBER_ID not set'); return; }
  try {
    const params = new URLSearchParams({ apiToken: token, phone_number_id: phoneId, phone_number: phone, message });
    const res = await fetch(BOTSAILOR_SEND_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
    });
    const data = await res.json();
    if (data.status !== '1' && data.status !== 1) {
      console.error('BotSailor send error:', JSON.stringify(data));
    }
  } catch (e) {
    console.error('BotSailor sendReply error:', e.message);
  }
}

// ── Helper: store message in whatsapp_messages (same table as Meta route) ─────
async function storeMessage(fields) {
  try {
    await supabase.from('whatsapp_messages').insert(fields);
  } catch (e) {
    // non-fatal
  }
}

// ── Helper: fetch live product context for AI ─────────────────────────────────
async function getProductContext() {
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

    return (products || [])
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
  } catch (e) {
    console.error('BS getProductContext error:', e.message);
    return '(product data unavailable)';
  }
}

// ── Helper: get recent orders for a phone number ──────────────────────────────
async function getOrdersByPhone(phone) {
  const digits = (phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length < 10) return [];
  try {
    const { data } = await supabase
      .from('webstore_orders')
      .select('order_no,status,total,created_at,customer,tracking_no,courier')
      .order('created_at', { ascending: false })
      .limit(300);

    return (data || []).filter(o => {
      const ph = (o.customer?.phone || '').replace(/\D/g, '').slice(-10);
      return ph === digits;
    }).slice(0, 5);
  } catch (e) { return []; }
}

// ── Helper: lookup one order by number ───────────────────────────────────────
async function lookupOrderNo(rawNo, phone) {
  try {
    const { data } = await supabase
      .from('webstore_orders')
      .select('order_no,status,total,created_at,customer,tracking_no,courier')
      .ilike('order_no', rawNo.trim())
      .maybeSingle();
    if (!data) return null;
    // Optional phone ownership check
    const orderDigits = (data.customer?.phone || '').replace(/\D/g, '').slice(-10);
    const inputDigits = (phone || '').replace(/\D/g, '').slice(-10);
    if (orderDigits && inputDigits && orderDigits !== inputDigits) return null;
    return data;
  } catch { return null; }
}

const STATUS_LABEL = {
  new: 'Received ✅', confirmed: 'Confirmed ✅', packed: 'Packed 📦',
  shipped: 'Shipped 🚚', delivered: 'Delivered ✅', cancelled: 'Cancelled ❌',
};

function formatOrder(o) {
  const status = STATUS_LABEL[o.status] || o.status;
  const date   = o.created_at ? new Date(o.created_at).toLocaleDateString('en-IN') : '';
  const track  = o.tracking_no ? `\n🔍 Tracking: ${o.courier || ''} ${o.tracking_no}` : '';
  return `📦 *${o.order_no}*\nStatus: ${status}\nDate: ${date}\nTotal: ₹${o.total}${track}`;
}

// ── Chat history (same settings table) ───────────────────────────────────────
const HISTORY_KEY = phone => `wa_chat_${phone}`;

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
      value: { messages: messages.slice(-20), updated_at: new Date().toISOString() },
    });
  } catch (e) { console.error('BS saveHistory error:', e.message); }
}

// ── WhatsApp 5% coupon generator ──────────────────────────────────────────────
async function getOrCreateWACoupon(phone) {
  const tag = `wa_coupon:${phone}`;
  // Check if already issued for this phone
  const { data: existing } = await supabase
    .from('coupons')
    .select('code')
    .eq('description', tag)
    .eq('active', true)
    .maybeSingle();
  if (existing) return { code: existing.code, isNew: false };

  // Generate unique code: WA5-XXXXXX
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  const code = `WA5-${rand}`;
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
  await supabase.from('coupons').insert({
    code,
    type:        'percent',
    value:       5,
    min_order:   0,
    max_uses:    1,
    uses_count:  0,
    expires_at:  expires,
    description: tag,
    active:      true,
  });
  return { code, isNew: true };
}

// ── Keyword router ────────────────────────────────────────────────────────────
async function keywordReply(text, phone) {
  const t = text.trim();

  // "Hi Sathvam" — WhatsApp offer coupon
  if (/^hi\s+sathvam$/i.test(t)) {
    try {
      const { code, isNew } = await getOrCreateWACoupon(phone);
      if (isNew) {
        return `🎉 *நன்றி! Thank you for connecting with Sathvam!*\n\n` +
          `Here's your exclusive *5% OFF* coupon 🎁\n\n` +
          `🏷️ Code: *${code}*\n\n` +
          `✅ Valid for 30 days · One-time use\n` +
          `💰 Apply at checkout on *sathvam.in*\n\n` +
          `🛒 Shop now: https://sathvam.in`;
      } else {
        return `😊 *Your 5% OFF coupon is already ready!*\n\n` +
          `🏷️ Code: *${code}*\n\n` +
          `Apply at checkout on *sathvam.in* 🛒\n` +
          `https://sathvam.in`;
      }
    } catch (e) {
      console.error('WA coupon error:', e.message);
      return `🎉 Thanks for reaching out! Shop at https://sathvam.in 🌿\nReply *PRODUCTS* to see our range.`;
    }
  }

  // Greeting / menu
  if (/^(hi|hello|hey|start|menu|help|வணக்கம்|ஹலோ)$/i.test(t)) {
    return `👋 *Welcome to Sathvam!*\n\nNatural cold-pressed oils, directly from our mill 🌿\n\nReply with:\n📦 *ORDERS* — your recent orders\n🔍 *TRACK <order no>* — e.g. TRACK SAT-20260410-0042\n🛍 *PRODUCTS* — what we sell\n💬 *anything else* — ask me anything!`;
  }

  // Products list
  if (/^(products?|shop|buy|oils?|list|catalogue|catalog|விலை|தயாரிப்பு)$/i.test(t)) {
    const ctx = await getProductContext();
    return `🌿 *Our Products*\n\n${ctx}\n\n🛒 Order at: https://sathvam.in`;
  }

  // My orders
  if (/^(orders?|my orders?|order history|என்.*ஆர்டர்)$/i.test(t)) {
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

  return null; // fall through to AI
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/botsailor/quick-send-image  — Send image + caption to a phone
// Body: { phone, image_url, caption }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/quick-send-image', async (req, res) => {
  const token   = BOTSAILOR_API_TOKEN();
  const phoneId = BOTSAILOR_PHONE_ID() || '';
  if (!token) return res.status(500).json({ error: 'BOTSAILOR_API_TOKEN not set' });

  const { phone, image_url, caption } = req.body;
  if (!phone || !image_url) return res.status(400).json({ error: 'phone and image_url are required' });

  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return res.status(400).json({ error: 'Invalid phone number' });

  try {
    const bsRes = await fetch('https://botsailor.com/api/v1/whatsapp/send', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ apiToken: token, phone_number_id: phoneId, phone_number: digits, type: 'image', url: image_url, message: caption || '' }),
    });
    const rawText = await bsRes.text();
    let data;
    try { data = JSON.parse(rawText); }
    catch (_) {
      console.error('BotSailor image non-JSON:', rawText.slice(0, 300));
      return res.status(502).json({ error: `BotSailor unexpected response (HTTP ${bsRes.status})` });
    }
    if (data.status !== '1' && data.status !== 1) {
      return res.status(400).json({ error: data.message || data.error || JSON.stringify(data) });
    }
    await storeMessage({
      phone: digits,
      direction: 'outbound',
      type:      'image',
      content:   caption || image_url,
      status:    'sent',
      sent_by:   'admin',
      timestamp: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/botsailor/quick-send  — Admin manually sends a message to a phone
// Body: { phone: "919876543210", message: "Hello!" }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/quick-send', async (req, res) => {
  const token   = BOTSAILOR_API_TOKEN();
  const phoneId = BOTSAILOR_PHONE_ID() || '';
  if (!token) return res.status(500).json({ error: 'BOTSAILOR_API_TOKEN not set in server .env' });

  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message are required' });

  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return res.status(400).json({ error: 'Invalid phone number' });

  try {
    const params = new URLSearchParams({ apiToken: token, phone_number_id: phoneId, phone_number: digits, message });
    const bsRes = await fetch(BOTSAILOR_SEND_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
    });
    const rawText = await bsRes.text();
    let data;
    try { data = JSON.parse(rawText); }
    catch (_) {
      console.error('BotSailor non-JSON response:', rawText.slice(0, 300));
      return res.status(502).json({ error: `BotSailor returned unexpected response (HTTP ${bsRes.status}). URL may still be wrong.` });
    }
    if (data.status !== '1' && data.status !== 1) {
      const msg = data.message || data.error || JSON.stringify(data);
      // Make 24h window error clear
      const friendly = msg.includes('24 hour') || msg.includes('template')
        ? `WhatsApp 24h rule: this customer hasn't messaged your number in the last 24 hours. Use a template message instead, or wait for them to initiate.`
        : msg;
      return res.status(400).json({ error: friendly });
    }
    // Store outbound message
    await storeMessage({
      phone: digits,
      direction: 'outbound',
      type:      'text',
      content:   message,
      status:    'sent',
      sent_by:   'admin',
      timestamp: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/botsailor/templates  — Fetch approved WhatsApp templates from BotSailor
// ─────────────────────────────────────────────────────────────────────────────
router.get('/templates', async (req, res) => {
  const token   = BOTSAILOR_API_TOKEN();
  const phoneId = BOTSAILOR_PHONE_ID() || '';
  if (!token) return res.status(500).json({ error: 'BOTSAILOR_API_TOKEN not set' });
  try {
    const params = new URLSearchParams({ apiToken: token, phone_number_id: phoneId });
    const r = await fetch('https://botsailor.com/api/v1/whatsapp/template/list', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
    });
    const rawText = await r.text();
    let data;
    try { data = JSON.parse(rawText); } catch { return res.status(502).json({ error: 'BotSailor returned non-JSON', raw: rawText.slice(0,200) }); }
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/botsailor/send-template  — Send a pre-approved template message
// Body: { phone, templateId, variables: { "key": "value", ... } }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/send-template', async (req, res) => {
  const token   = BOTSAILOR_API_TOKEN();
  const phoneId = BOTSAILOR_PHONE_ID() || '';
  if (!token) return res.status(500).json({ error: 'BOTSAILOR_API_TOKEN not set' });

  const { phone, templateId, variables } = req.body;
  if (!phone || !templateId) return res.status(400).json({ error: 'phone and templateId are required' });

  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return res.status(400).json({ error: 'Invalid phone number' });

  try {
    const params = new URLSearchParams({
      apiToken:          token,
      phoneNumberID:     phoneId,
      botTemplateID:     String(templateId),
      sendToPhoneNumber: digits,
    });
    if (variables && typeof variables === 'object') {
      for (const [key, val] of Object.entries(variables)) {
        params.append(`templateVariable-${key}`, String(val));
      }
    }
    const url = `https://botsailor.com/api/v1/whatsapp/send/template?${params.toString()}`;
    const bsRes = await fetch(url, { method: 'POST' });
    const rawText = await bsRes.text();
    let data;
    try { data = JSON.parse(rawText); } catch { return res.status(502).json({ error: 'BotSailor non-JSON', raw: rawText.slice(0,200) }); }
    if (data.status !== '1' && data.status !== 1) {
      return res.status(400).json({ error: data.message || data.error || JSON.stringify(data) });
    }
    // Store outbound template message
    const bodyText = variables
      ? `[Template #${templateId}] vars: ${JSON.stringify(variables)}`
      : `[Template #${templateId}]`;
    await storeMessage({ phone: digits, direction: 'outbound', type: 'template', content: bodyText, status: 'sent', sent_by: 'admin', timestamp: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/botsailor/broadcast-social  — Broadcast social post to all customers
// Body: { caption, image_url }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/broadcast-social', async (req, res) => {
  const token   = BOTSAILOR_API_TOKEN();
  const phoneId = BOTSAILOR_PHONE_ID() || '';
  if (!token) return res.status(500).json({ error: 'BOTSAILOR_API_TOKEN not set' });

  const { caption, image_url } = req.body;
  if (!caption) return res.status(400).json({ error: 'caption is required' });

  const imgUrl = image_url || 'https://sathvam.in/logo.jpg';

  try {
    const { data: customers } = await supabase
      .from('customers').select('id, name, phone').not('phone', 'is', null);

    let sent = 0, failed = 0, skipped = 0;
    for (const cust of customers || []) {
      const digits = (cust.phone || '').replace(/\D/g, '');
      if (digits.length < 10) { skipped++; continue; }
      try {
        const bsRes = await fetch('https://botsailor.com/api/v1/whatsapp/send', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ apiToken: token, phone_number_id: phoneId, phone_number: digits, type: 'image', url: imgUrl, message: caption }),
        });
        const d = await bsRes.json();
        if (d.status === '1' || d.status === 1) sent++; else failed++;
      } catch { failed++; }
    }
    res.json({ ok: true, sent, failed, skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/botsailor/webhook  — BotSailor sends incoming WhatsApp messages here
// ─────────────────────────────────────────────────────────────────────────────
router.post('/webhook', async (req, res) => {
  // Verify BotSailor secret if configured
  const webhookSecret = process.env.BOTSAILOR_WEBHOOK_SECRET;
  if (webhookSecret && req.headers['x-botsailor-secret'] !== webhookSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Respond 200 immediately so BotSailor doesn't retry
  res.status(200).json({ status: '1', message: 'ok' });

  try {
    const {
      subscriber_phone: rawPhone,
      subscriber_id,
      subscriber_name,
      last_message,
      message_type,
    } = req.body;

    // Ignore non-text or empty
    if (!last_message || !last_message.trim()) return;
    if (message_type && message_type !== 'text') return;

    const phone = (rawPhone || '').replace(/\D/g, '');

    // ── Admin approval flow for Thirukkural broadcast ────────────────────────
    const adminNo  = (process.env.THIRUKURAL_APPROVAL_PHONE || process.env.WA_NOTIFY_TO || '').replace(/\D/g, '');
    const isAdmin  = adminNo && (phone === adminNo || phone.endsWith(adminNo) || adminNo.endsWith(phone));
    const msgLower = (last_message || '').trim().toLowerCase();
    // ── Broadcast approval keywords ───────────────────────────────────────────
    if (isAdmin) {
      const broadcastType =
        /^morning$/i.test(msgLower)   ? 'morning'   :
        /^afternoon$/i.test(msgLower) ? 'afternoon' :
        /^night$/i.test(msgLower)     ? 'night'     : null;

      if (broadcastType) {
        try {
          const r = await fetch(`http://localhost:3001/api/broadcasts/${broadcastType}/approve-from-wa`, { method: 'POST' });
          const d = await r.json();
          const reply = d.ok
            ? `✅ ${broadcastType.toUpperCase()} broadcast sent to ${d.sent} customers! (${d.failed} failed, ${d.skipped} skipped)`
            : `ℹ️ ${d.reason || `No pending ${broadcastType} broadcast for today.`}`;
          await sendReply(phone, reply);
        } catch (e) {
          await sendReply(phone, `❌ Broadcast failed: ${e.message}`);
        }
        return;
      }

      if (/^skip\s*(morning|afternoon|night)?$/i.test(msgLower)) {
        await sendReply(phone, `⏭️ Broadcast skipped.`);
        return;
      }
    }

    // Store inbound message
    await storeMessage({
      phone,
      subscriber_id: subscriber_id || null,
      contact_name:  subscriber_name || null,
      direction:     'inbound',
      type:          'text',
      content:       last_message,
      status:        'received',
      timestamp:     new Date().toISOString(),
    });

    // 1. Keyword shortcuts — always run regardless of AI_REPLIES_ENABLED
    const kwReply = await keywordReply(last_message, phone);
    if (kwReply) {
      await sendReply(phone, kwReply);
      await storeMessage({
        phone,
        direction: 'outbound',
        type:      'text',
        content:   kwReply,
        status:    'sent',
        sent_by:   'bot',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // 2. AI reply — only if enabled
    if (!AI_REPLIES_ENABLED) return;

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
Store: https://sathvam.in

CURRENT PRODUCTS:
${productCtx}`,
      messages: [
        ...history,
        { role: 'user', content: last_message },
      ],
    });

    const reply = aiResponse.content[0]?.text || '';
    if (!reply) return;

    await sendReply(phone, reply);
    await storeMessage({
      phone,
      direction: 'outbound',
      type:      'text',
      content:   reply,
      status:    'sent',
      sent_by:   'bot',
      timestamp: new Date().toISOString(),
    });
    await saveHistory(phone, [
      ...history,
      { role: 'user',      content: last_message },
      { role: 'assistant', content: reply },
    ]);

  } catch (e) {
    console.error('BotSailor webhook error:', e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/botsailor/webhook/outgoing  — BotSailor notifies us when an outbound
// message is sent/delivered/read/failed. Updates status in whatsapp_messages.
// Configure in BotSailor: Outgoing Webhook URL → https://api.sathvam.in/api/botsailor/webhook/outgoing
// ─────────────────────────────────────────────────────────────────────────────
router.post('/webhook/outgoing', async (req, res) => {
  res.status(200).json({ status: '1', message: 'ok' });

  try {
    const secret = process.env.BOTSAILOR_WEBHOOK_SECRET;
    if (secret && req.headers['x-botsailor-secret'] !== secret) return;

    const {
      subscriber_phone: rawPhone,
      subscriber_id,
      subscriber_name,
      last_message,
      message_type,
      message_status, // sent | delivered | read | failed
    } = req.body;

    const phone = (rawPhone || '').replace(/\D/g, '');
    if (!phone) return;

    const status = (message_status || 'sent').toLowerCase();

    // Update the most recent matching outbound message status
    if (last_message) {
      await supabase
        .from('whatsapp_messages')
        .update({ status })
        .eq('phone', phone)
        .eq('direction', 'outbound')
        .eq('content', last_message)
        .order('timestamp', { ascending: false })
        .limit(1);
    }

    // Also store as a log entry if it's a new outbound message we don't have yet
    if (status === 'sent' && last_message) {
      const { count } = await supabase
        .from('whatsapp_messages')
        .select('id', { count: 'exact', head: true })
        .eq('phone', phone)
        .eq('direction', 'outbound')
        .eq('content', last_message);

      if (!count) {
        await storeMessage({
          phone,
          subscriber_id: subscriber_id || null,
          contact_name:  subscriber_name || null,
          direction:     'outbound',
          type:          message_type || 'text',
          content:       last_message,
          status:        'sent',
          sent_by:       'botsailor',
          timestamp:     new Date().toISOString(),
        });
      }
    }
  } catch (e) {
    console.error('BotSailor outgoing webhook error:', e.message);
  }
});

module.exports = router;
