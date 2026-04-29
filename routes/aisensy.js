/**
 * AiSensy WhatsApp Integration
 *
 * AiSensy is a Meta-approved BSP (Business Solution Provider) for WhatsApp.
 * All messages (text, image, template) use a single send endpoint.
 * Campaigns (templates) must be created in AiSensy dashboard → set to "Live".
 *
 * Endpoints exposed:
 *   POST /api/aisensy/send          — Send text message (within 24h window)
 *   POST /api/aisensy/send-image    — Send image + caption
 *   POST /api/aisensy/send-template — Send a pre-approved template (anytime)
 *   POST /api/aisensy/broadcast     — Broadcast template to all customers
 *   GET  /api/aisensy/campaigns     — List saved campaigns (from DB settings)
 *   POST /api/aisensy/webhook       — AiSensy sends incoming messages here
 *
 * Required .env:
 *   AISENSY_API_KEY      — from AiSensy Dashboard → Settings → API
 *
 * AiSensy send API:
 *   POST https://backend.aisensy.com/campaign/t1/api/v2
 *   Body: { apiKey, campaignName, destination, userName, templateParams?, media? }
 *
 * Webhook payload from AiSensy:
 *   { timestamp, from, message, status, id }
 */

const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const router    = express.Router();
const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const AISENSY_API_KEY  = () => process.env.AISENSY_API_KEY;
const AISENSY_SEND_URL = 'https://backend.aisensy.com/campaign/t1/api/v2';
const AI_REPLIES_ENABLED = process.env.WHATSAPP_AI_REPLIES !== 'false';

// ── Helper: send via AiSensy ──────────────────────────────────────────────────
async function asSend({ campaignName, destination, userName, templateParams, media }) {
  const apiKey = AISENSY_API_KEY();
  if (!apiKey) throw new Error('AISENSY_API_KEY not set');

  const body = { apiKey, campaignName, destination, userName };
  if (templateParams && templateParams.length) body.templateParams = templateParams;
  if (media) body.media = media;

  const res = await fetch(AISENSY_SEND_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data?.message || data?.raw || `HTTP ${res.status}`);
  return data;
}

// ── Helper: store message in whatsapp_messages ────────────────────────────────
async function storeMessage(fields) {
  try { await supabase.from('whatsapp_messages').insert({ ...fields, provider: 'aisensy' }); }
  catch (e) { /* non-fatal */ }
}

// ── Helper: fetch live product context for AI ─────────────────────────────────
async function getProductContext() {
  try {
    const [{ data: products }, { data: stockData }, { data: enabledSetting }] = await Promise.all([
      supabase.from('products')
        .select('id,name,cat,pack_size,pack_unit,unit,website_price,price,active,health_benefits')
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
        return `• ${p.name} (${packStr}) ₹${price} — ${stockStr}`;
      })
      .join('\n');
  } catch (e) {
    console.error('AS getProductContext error:', e.message);
    return '(product data unavailable)';
  }
}

// ── Helper: get recent orders for a phone ─────────────────────────────────────
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
  } catch { return []; }
}

async function lookupOrderNo(rawNo, phone) {
  try {
    const { data } = await supabase
      .from('webstore_orders')
      .select('order_no,status,total,created_at,customer,tracking_no,courier')
      .ilike('order_no', rawNo.trim())
      .maybeSingle();
    if (!data) return null;
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

// ── Chat history ──────────────────────────────────────────────────────────────
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
  } catch (e) { console.error('AS saveHistory error:', e.message); }
}

// ── WhatsApp 5% coupon generator ──────────────────────────────────────────────
async function getOrCreateWACoupon(phone) {
  const tag = `wa_coupon:${phone}`;
  const { data: existing } = await supabase.from('coupons').select('code').eq('description', tag).eq('active', true).maybeSingle();
  if (existing) return { code: existing.code, isNew: false };
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  const code = `WA5-${rand}`;
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await supabase.from('coupons').insert({ code, type: 'percent', value: 5, min_order: 0, max_uses: 1, uses_count: 0, expires_at: expires, description: tag, active: true });
  return { code, isNew: true };
}

// ── Keyword router ────────────────────────────────────────────────────────────
async function keywordReply(text, phone) {
  const t = text.trim();

  if (/^hi\s+sathvam$/i.test(t)) {
    try {
      const { code, isNew } = await getOrCreateWACoupon(phone);
      if (isNew) {
        return `🎉 *நன்றி! Thank you for connecting with Sathvam!*\n\n` +
          `Here's your exclusive *5% OFF* coupon 🎁\n\n` +
          `🏷️ Code: *${code}*\n\n✅ Valid for 30 days · One-time use\n` +
          `💰 Apply at checkout on *sathvam.in*\n\n🛒 Shop now: https://sathvam.in`;
      }
      return `😊 *Your 5% OFF coupon is already ready!*\n\n🏷️ Code: *${code}*\n\nApply at checkout on *sathvam.in* 🛒\nhttps://sathvam.in`;
    } catch (e) {
      return `🎉 Thanks for reaching out! Shop at https://sathvam.in 🌿\nReply *PRODUCTS* to see our range.`;
    }
  }

  if (/^(hi|hello|hey|start|menu|help|வணக்கம்|ஹலோ)$/i.test(t)) {
    return `👋 *Welcome to Sathvam!*\n\nNatural cold-pressed oils, directly from our mill 🌿\n\nReply with:\n📦 *ORDERS* — your recent orders\n🔍 *TRACK <order no>* — e.g. TRACK SAT-20260410-0042\n🛍 *PRODUCTS* — what we sell\n💬 *anything else* — ask me anything!`;
  }

  if (/^(products?|shop|buy|oils?|list|catalogue|catalog|விலை|தயாரிப்பு)$/i.test(t)) {
    const ctx = await getProductContext();
    return `🌿 *Our Products*\n\n${ctx}\n\n🛒 Order at: https://sathvam.in`;
  }

  if (/^(orders?|my orders?|order history|என்.*ஆர்டர்)$/i.test(t)) {
    const orders = await getOrdersByPhone(phone);
    if (!orders.length) return `No orders found for this number.\n\nShop at 👉 https://sathvam.in`;
    return `📦 *Your Recent Orders*\n\n${orders.map(formatOrder).join('\n\n')}`;
  }

  const trackMatch = t.match(/^track\s+([A-Z0-9\-]+)$/i);
  if (trackMatch) {
    const order = await lookupOrderNo(trackMatch[1], phone);
    if (!order) return `❌ Order *${trackMatch[1]}* not found.\n\nReply *ORDERS* to see your orders.`;
    return formatOrder(order);
  }

  const orderNoMatch = t.match(/\b(SAT-\d{8}-\d{4})\b/i);
  if (orderNoMatch) {
    const order = await lookupOrderNo(orderNoMatch[1], phone);
    if (order) return formatOrder(order);
  }

  return null; // fall through to AI
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/aisensy/send  — Send a text message to a phone number
// Body: { phone, message, userName? }
// Note: Only works within 24h of customer's last message (WhatsApp rule)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/send', async (req, res) => {
  if (!AISENSY_API_KEY()) return res.status(500).json({ error: 'AISENSY_API_KEY not set' });

  const { phone, message, userName = 'Customer' } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message are required' });

  const digits = `+${phone.replace(/\D/g, '')}`;
  if (digits.length < 11) return res.status(400).json({ error: 'Invalid phone number' });

  // AiSensy requires a campaign name — use a generic "direct-message" campaign
  // Create a campaign called "direct-message" in AiSensy dashboard with a single {{1}} body param
  try {
    await asSend({ campaignName: 'direct-message', destination: digits, userName, templateParams: [message] });
    await storeMessage({ phone: digits, direction: 'outbound', type: 'text', content: message, status: 'sent', sent_by: 'admin', timestamp: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/aisensy/send-image  — Send image + caption
// Body: { phone, image_url, caption, userName? }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/send-image', async (req, res) => {
  if (!AISENSY_API_KEY()) return res.status(500).json({ error: 'AISENSY_API_KEY not set' });

  const { phone, image_url, caption = '', userName = 'Customer' } = req.body;
  if (!phone || !image_url) return res.status(400).json({ error: 'phone and image_url are required' });

  const digits = `+${phone.replace(/\D/g, '')}`;
  if (digits.length < 11) return res.status(400).json({ error: 'Invalid phone number' });

  try {
    await asSend({
      campaignName: 'send-image',
      destination: digits,
      userName,
      media: { url: image_url, filename: 'image.jpg' },
      templateParams: caption ? [caption] : undefined,
    });
    await storeMessage({ phone: digits, direction: 'outbound', type: 'image', content: caption || image_url, status: 'sent', sent_by: 'admin', timestamp: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/aisensy/send-template  — Send pre-approved template (no 24h limit)
// Body: { phone, campaignName, templateParams?, userName? }
// campaignName: exact name of Live campaign in AiSensy dashboard
// ─────────────────────────────────────────────────────────────────────────────
router.post('/send-template', async (req, res) => {
  if (!AISENSY_API_KEY()) return res.status(500).json({ error: 'AISENSY_API_KEY not set' });

  const { phone, campaignName, templateParams = [], userName = 'Customer' } = req.body;
  if (!phone || !campaignName) return res.status(400).json({ error: 'phone and campaignName are required' });

  const digits = `+${phone.replace(/\D/g, '')}`;
  if (digits.length < 11) return res.status(400).json({ error: 'Invalid phone number' });

  try {
    await asSend({ campaignName, destination: digits, userName, templateParams });
    await storeMessage({ phone: digits, direction: 'outbound', type: 'template', content: `[Campaign: ${campaignName}] ${JSON.stringify(templateParams)}`, status: 'sent', sent_by: 'admin', timestamp: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/aisensy/broadcast  — Broadcast a template to all customers
// Body: { campaignName, templateParams?, imageUrl? }
// Rate: AiSensy handles rate-limiting internally
// ─────────────────────────────────────────────────────────────────────────────
router.post('/broadcast', async (req, res) => {
  if (!AISENSY_API_KEY()) return res.status(500).json({ error: 'AISENSY_API_KEY not set' });

  const { campaignName, templateParams = [], imageUrl } = req.body;
  if (!campaignName) return res.status(400).json({ error: 'campaignName is required' });

  try {
    const { data: customers } = await supabase.from('customers').select('id,name,phone').not('phone', 'is', null);

    let sent = 0, failed = 0, skipped = 0;
    for (const cust of customers || []) {
      const digits = `+${(cust.phone || '').replace(/\D/g, '')}`;
      if (digits.length < 11) { skipped++; continue; }
      try {
        await asSend({
          campaignName,
          destination: digits,
          userName: cust.name || 'Customer',
          templateParams,
          media: imageUrl ? { url: imageUrl, filename: 'promo.jpg' } : undefined,
        });
        sent++;
      } catch { failed++; }
      // Small delay to avoid flooding
      await new Promise(r => setTimeout(r, 100));
    }
    res.json({ ok: true, sent, failed, skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/aisensy/status  — Check if AiSensy API key is configured
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  const key = AISENSY_API_KEY();
  if (!key) return res.json({ configured: false, message: 'AISENSY_API_KEY not set in .env' });

  // Test API key with a minimal request
  try {
    const testRes = await fetch(AISENSY_SEND_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ apiKey: key, campaignName: '__test__', destination: '+910000000000', userName: 'Test' }),
    });
    const text = await testRes.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    // Any response (even campaign-not-found) means API key is valid
    const keyValid = !text.includes('Invalid API') && !text.includes('Unauthorized') && !text.includes('apiKey');
    res.json({ configured: true, keyValid, response: data });
  } catch (e) {
    res.json({ configured: true, keyValid: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/aisensy/webhook  — AiSensy sends incoming WhatsApp messages here
// Configure in AiSensy: Settings → API → Webhook URL
// ─────────────────────────────────────────────────────────────────────────────
router.post('/webhook', async (req, res) => {
  // Respond 200 immediately so AiSensy doesn't retry
  res.status(200).json({ status: 'ok' });

  try {
    // AiSensy webhook payload: { timestamp, from, message, status, id }
    const { from: rawPhone, message: last_message, status, id: messageId } = req.body;

    // Only process incoming messages (not delivery status updates)
    if (!last_message || !last_message.trim()) return;
    if (status && status !== 'received' && status !== 'inbound') return;

    const phone = (rawPhone || '').replace(/\D/g, '');

    // Store inbound message
    await storeMessage({
      phone,
      direction: 'inbound',
      type:      'text',
      content:   last_message,
      status:    'received',
      provider:  'aisensy',
      timestamp: new Date().toISOString(),
    });

    // 1. Keyword shortcuts
    const kwReply = await keywordReply(last_message, phone);
    if (kwReply) {
      // For replies within webhook, we need a default campaign for free-form replies
      // Create "bot-reply" campaign in AiSensy with body {{1}}
      try {
        await asSend({ campaignName: 'bot-reply', destination: `+${phone}`, userName: 'Customer', templateParams: [kwReply] });
        await storeMessage({ phone, direction: 'outbound', type: 'text', content: kwReply, status: 'sent', sent_by: 'bot', timestamp: new Date().toISOString() });
      } catch (e) {
        console.error('AS keyword reply send error:', e.message);
      }
      return;
    }

    // 2. AI reply
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

    try {
      await asSend({ campaignName: 'bot-reply', destination: `+${phone}`, userName: 'Customer', templateParams: [reply] });
      await storeMessage({ phone, direction: 'outbound', type: 'text', content: reply, status: 'sent', sent_by: 'bot', timestamp: new Date().toISOString() });
      await saveHistory(phone, [...history, { role: 'user', content: last_message }, { role: 'assistant', content: reply }]);
    } catch (e) {
      console.error('AS AI reply send error:', e.message);
    }

  } catch (e) {
    console.error('AiSensy webhook error:', e.message);
  }
});

module.exports = router;
