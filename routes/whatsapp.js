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
const { createClient } = require('@supabase/supabase-js');
const { auth } = require('../middleware/auth');

const router    = express.Router();
const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── WA auto-reply: set WHATSAPP_AI_REPLIES=false in .env to disable ───────────
const AI_REPLIES_ENABLED = process.env.WHATSAPP_AI_REPLIES !== 'false';

const WA_BASE = 'https://graph.facebook.com/v19.0';

// ── Helper: fetch products + stock for AI context ────────────────────────────
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
    console.error('WA getProductContext error:', e.message);
    return '(product data unavailable)';
  }
}

// ── Helper: lookup recent orders for a WhatsApp phone number ─────────────────
async function getOrdersByPhone(waPhone) {
  // WA numbers arrive as 91XXXXXXXXXX; match last 10 digits
  const digits = waPhone.replace(/\D/g, '').slice(-10);
  try {
    const { data } = await supabase
      .from('webstore_orders')
      .select('order_no,status,total,created_at,customer,tracking_no,courier')
      .order('created_at', { ascending: false })
      .limit(200);

    return (data || []).filter(o => {
      const ph = (o.customer?.phone || '').replace(/\D/g, '').slice(-10);
      return ph === digits;
    }).slice(0, 5);
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
  const { error } = await supabase.from('whatsapp_messages').insert(fields);
  if (error) console.error('WA store message error:', error.message);
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
          }
        }

        // Process delivery/read status updates for outbound messages
        for (const status of statuses) {
          await supabase.from('whatsapp_messages')
            .update({ status: status.status })
            .eq('wa_message_id', status.id);
        }
      }
    }
  } catch (e) {
    console.error('WhatsApp webhook processing error:', e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/status  — Check configuration status
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status', auth, (req, res) => {
  res.json({
    configured: !!(process.env.WA_PHONE_NUMBER_ID && process.env.WA_ACCESS_TOKEN),
    phone_number_id: process.env.WA_PHONE_NUMBER_ID ? '✅ Set' : '❌ Missing',
    access_token:    process.env.WA_ACCESS_TOKEN    ? '✅ Set' : '❌ Missing',
    waba_id:         process.env.WA_WABA_ID         ? '✅ Set' : '❌ Missing (needed for templates)',
    webhook_token:   process.env.WA_WEBHOOK_VERIFY_TOKEN ? '✅ Set' : '❌ Missing',
    notify_to:       process.env.WA_NOTIFY_TO || '(not set — used for internal order alerts)',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/conversations  — All conversations grouped by phone
// ─────────────────────────────────────────────────────────────────────────────
router.get('/conversations', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('whatsapp_messages')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(2000);
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

    let payload;
    if (type === 'template' && template) {
      payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name:     template.name,
          language: { code: template.language || 'en' },
          ...(template.components?.length ? { components: template.components } : {}),
        },
      };
    } else {
      if (!text?.trim()) return res.status(400).json({ error: 'text required' });
      payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text.trim() },
      };
    }

    const result = await waRequest('/messages', 'POST', payload);
    const msgId  = result.messages?.[0]?.id;

    await storeMessage({
      wa_message_id: msgId,
      phone: to,
      direction:     'outbound',
      type,
      content:       type === 'template' ? `[Template: ${template?.name}]` : text.trim(),
      status:        'sent',
      timestamp:     new Date().toISOString(),
      sent_by:       req.user?.username || req.user?.name || 'admin',
    });

    res.json({ ok: true, message_id: msgId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/whatsapp/templates  — Fetch approved templates from Meta
// ─────────────────────────────────────────────────────────────────────────────
router.get('/templates', auth, async (req, res) => {
  try {
    const wabaId = process.env.WA_WABA_ID;
    const token  = process.env.WA_ACCESS_TOKEN;
    if (!wabaId || !token) return res.json({ templates: [], error: 'WA_WABA_ID or WA_ACCESS_TOKEN not set' });

    const r    = await fetch(`${WA_BASE}/${wabaId}/message_templates?limit=50&status=APPROVED`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    res.json({ templates: data.data || [], error: data.error?.message || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/whatsapp/notify/order  — Send order notification template to customer
// ─────────────────────────────────────────────────────────────────────────────
router.post('/notify/order', auth, async (req, res) => {
  try {
    const { phone, orderNo, event = 'confirmed', templateName } = req.body;
    if (!phone || !orderNo) return res.status(400).json({ error: 'phone and orderNo required' });

    const to    = normalisePhone(phone);
    const tName = templateName || process.env.WA_ORDER_TEMPLATE;
    if (!tName) return res.status(400).json({ error: 'templateName required (or set WA_ORDER_TEMPLATE in env)' });

    const result = await waRequest('/messages', 'POST', {
      messaging_product: 'whatsapp',
      to,
      type:     'template',
      template: { name: tName, language: { code: 'en' } },
    });

    await storeMessage({
      wa_message_id: result.messages?.[0]?.id,
      phone:   to,
      direction: 'outbound',
      type:    'template',
      content: `[Order ${event}: ${orderNo}] Template: ${tName}`,
      status:  'sent',
      timestamp: new Date().toISOString(),
      sent_by: 'system',
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

module.exports = router;
