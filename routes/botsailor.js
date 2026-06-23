/**
 * Green API WhatsApp Integration
 *
 * Green API connects a regular WhatsApp account via phone session (QR scan).
 * No Meta/WhatsApp Business API approval required.
 *
 * Endpoints:
 *   POST /api/botsailor/webhook          — Green API sends incoming messages here
 *   POST /api/botsailor/quick-send       — Admin sends a text message to a phone
 *   POST /api/botsailor/quick-send-image — Admin sends an image + caption
 *   GET  /api/botsailor/templates        — Returns empty list (no templates in Green API)
 *   POST /api/botsailor/send-template    — Sends as plain text (no template approval needed)
 *   POST /api/botsailor/broadcast-social — Broadcast image + caption to all customers
 *
 * Required .env:
 *   GREENAPI_INSTANCE_ID  — idInstance from green-api.com dashboard
 *   GREENAPI_API_TOKEN    — apiTokenInstance from green-api.com dashboard
 *
 * Green API webhook payload (typeWebhook: "incomingMessageReceived"):
 *   {
 *     typeWebhook: "incomingMessageReceived",
 *     senderData: { chatId: "919876543210@c.us", senderName: "Name" },
 *     messageData: { typeMessage: "textMessage", textMessageData: { textMessage: "Hi" } }
 *   }
 */

const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { sendText, sendFile, toChatId } = require('../lib/greenapi');
const { handleBotMessage } = require('./waOrdering');
const { decrypt } = require('../config/crypto');

const router    = express.Router();
const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const AI_REPLIES_ENABLED = process.env.WHATSAPP_AI_REPLIES !== 'false';

// ── Helper: store message in whatsapp_messages ────────────────────────────────
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
    console.error('GreenAPI getProductContext error:', e.message);
    return '(product data unavailable)';
  }
}

// ── Chat history ───────────────────────────────────────────────────────────────
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
  } catch (e) { console.error('GreenAPI saveHistory error:', e.message); }
}

// ── WhatsApp 5% coupon generator ───────────────────────────────────────────────
async function getOrCreateWACoupon(phone) {
  const tag = `wa_coupon:${phone}`;
  const { data: existing } = await supabase
    .from('coupons')
    .select('code')
    .eq('description', tag)
    .eq('active', true)
    .maybeSingle();
  if (existing) return { code: existing.code, isNew: false };

  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  const code = `WA5-${rand}`;
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await supabase.from('coupons').insert({
    code, type: 'percent', value: 5, min_order: 0, max_uses: 1,
    uses_count: 0, expires_at: expires, description: tag, active: true,
  });
  return { code, isNew: true };
}

// ── Referral coupon generator ───────────────────────────────────────────────────
async function getOrCreateReferralCoupon(phone) {
  const tag = `wa_referral:${phone}`;
  const { data: existing } = await supabase
    .from('coupons')
    .select('code')
    .eq('description', tag)
    .eq('active', true)
    .maybeSingle();
  if (existing) return { code: existing.code, isNew: false };

  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  const code = `REF${rand}`;
  const expires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  await supabase.from('coupons').insert({
    code, type: 'percent', value: 5, min_order: 0, max_uses: 10,
    uses_count: 0, expires_at: expires, description: tag, active: true,
  });
  return { code, isNew: true };
}

// ── Keyword router ─────────────────────────────────────────────────────────────
async function keywordReply(text, phone) {
  const t = text.trim();

  // HI SATHVAM — welcome coupon
  if (/^hi\s+sathvam$/i.test(t)) {
    try {
      const { code, isNew } = await getOrCreateWACoupon(phone);
      if (isNew) {
        return `🎉 *நன்றி! Thank you for connecting with Sathvam!*\n\n` +
          `Here's your exclusive *5% OFF* coupon 🎁\n\n` +
          `🏷️ Code: *${code}*\n\n` +
          `✅ Valid for 30 days · One-time use\n` +
          `💰 Apply at checkout on *sathvam.in*\n\n` +
          `🛒 Shop now: https://sathvam.in\n\n` +
          `Reply *MENU* to see all commands.`;
      } else {
        return `😊 *Your 5% OFF coupon is already ready!*\n\n` +
          `🏷️ Code: *${code}*\n\n` +
          `Apply at checkout on *sathvam.in* 🛒\n` +
          `https://sathvam.in\n\n` +
          `Reply *MENU* to see all commands.`;
      }
    } catch (e) {
      console.error('WA coupon error:', e.message);
      return `🎉 Thanks for reaching out! Shop at https://sathvam.in 🌿\nReply *PRODUCTS* to see our range.`;
    }
  }

  // POINTS — loyalty balance
  if (/^points$/i.test(t)) {
    try {
      const { data: customers } = await supabase.from('customers').select('id,phone');
      let custId = null;
      for (const c of customers || []) {
        try {
          const decPhone = (decrypt(c.phone) || '').replace(/\D/g, '');
          const inPhone  = phone.replace(/\D/g, '');
          if (decPhone && (decPhone === inPhone || decPhone.endsWith(inPhone) || inPhone.endsWith(decPhone))) {
            custId = c.id;
            break;
          }
        } catch {}
      }
      if (!custId) {
        return `ℹ️ *Loyalty Points*\n\nWe couldn't find an account linked to your number.\n\nShop at sathvam.in to start earning points! (1 pt per ₹100)`;
      }
      const key = `cust_loyalty_${custId}`;
      const { data: setting } = await supabase.from('settings').select('value').eq('key', key).single();
      const pts = setting?.value?.points || 0;
      return `⭐ *Your Loyalty Points Balance*\n\n` +
        `🏆 Points: *${pts}*\n` +
        `💰 Value: ₹${pts} (1 pt = ₹1 off)\n\n` +
        `Earn more: 1 pt for every ₹100 spent!\n` +
        `🛒 Shop: https://sathvam.in`;
    } catch (e) {
      console.error('WA points error:', e.message);
      return `ℹ️ Could not fetch your points right now. Please try again later.`;
    }
  }

  // ORDER <no> or TRACK <no> — order status
  const orderMatch = t.match(/^(?:order|track)\s+(\S+)$/i);
  if (orderMatch) {
    const orderNo = orderMatch[1].toUpperCase();
    try {
      const { data: order } = await supabase
        .from('webstore_orders')
        .select('order_no,status,date,total')
        .ilike('order_no', orderNo)
        .maybeSingle();
      if (!order) {
        return `❓ Order *${orderNo}* not found.\n\nPlease check the order number and try again.\nFor help call +91 76187 73778`;
      }
      const statusEmoji = {
        confirmed: '✅', processing: '⚙️', packed: '📦',
        dispatched: '🚚', shipped: '🚚', delivered: '🎉',
        cancelled: '❌', refunded: '💸',
      };
      const emoji = statusEmoji[order.status] || '📋';
      return `${emoji} *Order Status — ${order.order_no}*\n\n` +
        `📋 Status: *${order.status.toUpperCase()}*\n` +
        `📅 Date: ${order.date}\n` +
        `💰 Total: ₹${parseFloat(order.total || 0).toLocaleString('en-IN')}\n\n` +
        `❓ Questions? Call +91 76187 73778`;
    } catch (e) {
      console.error('WA order status error:', e.message);
      return `❓ Could not fetch order status. Please try again or call +91 76187 73778`;
    }
  }

  // STOP — opt out
  if (/^stop$/i.test(t)) {
    try {
      await supabase.from('settings').upsert({
        key:   `wa_optout_${phone}`,
        value: { opted_out: true, date: new Date().toISOString(), phone },
      });
    } catch (e) { console.error('WA opt-out error:', e.message); }
    return `✅ You have been unsubscribed from Sathvam WhatsApp messages.\n\n` +
      `To re-subscribe, reply *START* or visit sathvam.in\n` +
      `For urgent help: +91 76187 73778`;
  }

  // INVOICE <no> — invoice info
  const invoiceMatch = t.match(/^invoice\s+(\S+)$/i);
  if (invoiceMatch) {
    return `🧾 *Invoice — ${invoiceMatch[1].toUpperCase()}*\n\n` +
      `To download your invoice, please visit:\n` +
      `🌐 https://sathvam.in/orders\n\n` +
      `Or contact us:\n` +
      `📞 +91 76187 73778\n` +
      `We'll send it to your email within 24 hours.`;
  }

  // REFER — referral coupon
  if (/^refer$/i.test(t)) {
    try {
      const { code, isNew } = await getOrCreateReferralCoupon(phone);
      return `🎁 *Your Referral Code*\n\n` +
        `Share this code with friends:\n` +
        `🏷️ *${code}* — 5% OFF for them!\n\n` +
        `How it works:\n` +
        `• Share code with a friend\n` +
        `• They use it at sathvam.in checkout\n` +
        `• They get 5% off their order\n\n` +
        `🛒 https://sathvam.in`;
    } catch (e) {
      console.error('WA referral error:', e.message);
      return `❓ Could not generate referral code. Please try again later.`;
    }
  }

  // PRODUCTS — product list prompt
  if (/^products$/i.test(t)) {
    return `🌿 *Sathvam Natural Products*\n\n` +
      `We offer:\n` +
      `• 🫒 Cold-Pressed Groundnut Oil\n` +
      `• 🌿 Cold-Pressed Sesame (Til) Oil\n` +
      `• 🧡 Turmeric Powder\n` +
      `• 🌾 Ragi (Finger Millet) Products\n` +
      `• 🥜 Natural Groundnuts\n` +
      `• And more!\n\n` +
      `Reply with a product name for details or visit:\n` +
      `🛒 https://sathvam.in\n\n` +
      `📞 +91 76187 73778`;
  }

  // HELP or MENU — command list
  if (/^(?:help|menu)$/i.test(t)) {
    return `📋 *Sathvam WhatsApp Menu*\n\n` +
      `Reply with any of these commands:\n\n` +
      `👋 *HI SATHVAM* — Get a welcome coupon\n` +
      `⭐ *POINTS* — Check loyalty points balance\n` +
      `🚚 *TRACK <order no>* — Track your order\n` +
      `📋 *ORDER <order no>* — Order status\n` +
      `🧾 *INVOICE <order no>* — Get invoice\n` +
      `🎁 *REFER* — Get your referral code\n` +
      `🌿 *PRODUCTS* — See our product range\n` +
      `🚫 *STOP* — Unsubscribe from messages\n\n` +
      `🛒 Shop: https://sathvam.in\n` +
      `📞 Help: +91 76187 73778`;
  }

  // All other message types fall through to AI
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/botsailor/quick-send-image  — Send image + caption to a phone
// Body: { phone, image_url, caption }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/quick-send-image', async (req, res) => {
  const { phone, image_url, caption } = req.body;
  if (!phone || !image_url) return res.status(400).json({ error: 'phone and image_url are required' });

  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return res.status(400).json({ error: 'Invalid phone number' });

  const ok = await sendFile(digits, image_url, 'image.jpg', caption || '');
  if (!ok) return res.status(500).json({ error: 'Green API send failed — check GREENAPI_INSTANCE_ID and GREENAPI_API_TOKEN' });

  await storeMessage({
    phone: digits, direction: 'outbound', type: 'image',
    content: caption || image_url, status: 'sent', sent_by: 'admin',
    timestamp: new Date().toISOString(),
  });
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/botsailor/quick-send  — Admin sends a text message to a phone
// Body: { phone, message }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/quick-send', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message are required' });

  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return res.status(400).json({ error: 'Invalid phone number' });

  const ok = await sendText(digits, message);
  if (!ok) return res.status(500).json({ error: 'Green API send failed — check GREENAPI_INSTANCE_ID and GREENAPI_API_TOKEN' });

  await storeMessage({
    phone: digits, direction: 'outbound', type: 'text',
    content: message, status: 'sent', sent_by: 'admin',
    timestamp: new Date().toISOString(),
  });
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/botsailor/templates  — Green API has no pre-approved templates
// Returns empty list for UI compatibility
// ─────────────────────────────────────────────────────────────────────────────
router.get('/templates', (req, res) => {
  res.json({ message: [], note: 'Green API does not require pre-approved templates — use quick-send for any message.' });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/botsailor/send-template  — Sends as plain text (no templates needed)
// Body: { phone, templateId, variables }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/send-template', async (req, res) => {
  const { phone, templateId, variables } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return res.status(400).json({ error: 'Invalid phone number' });

  // Build message from variables if provided, otherwise send a generic message
  const varText = variables && typeof variables === 'object'
    ? Object.values(variables).join(' — ')
    : '';
  const message = varText || `Message from Sathvam (template #${templateId || 'N/A'})`;

  const ok = await sendText(digits, message);
  if (!ok) return res.status(500).json({ error: 'Green API send failed' });

  await storeMessage({
    phone: digits, direction: 'outbound', type: 'template',
    content: message, status: 'sent', sent_by: 'admin',
    timestamp: new Date().toISOString(),
  });
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/botsailor/trigger-bot  — Not applicable to Green API; returns ok
// ─────────────────────────────────────────────────────────────────────────────
router.post('/trigger-bot', async (req, res) => {
  res.json({ ok: true, note: 'Bot flows not applicable with Green API — use quick-send instead.' });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/botsailor/instance-status  — Check Green API instance connection state
// Returns: { stateInstance, phoneNumber, displayName, ok }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/instance-status', async (req, res) => {
  const instanceId = process.env.GREENAPI_INSTANCE_ID;
  const token      = process.env.GREENAPI_API_TOKEN;
  if (!instanceId || !token) {
    return res.status(400).json({ ok: false, error: 'GREENAPI_INSTANCE_ID or GREENAPI_API_TOKEN not set in .env' });
  }
  try {
    const BASE = 'https://api.green-api.com';
    const [stateRes, accountRes] = await Promise.all([
      fetch(`${BASE}/waInstance${instanceId}/getStateInstance/${token}`),
      fetch(`${BASE}/waInstance${instanceId}/getSettings/${token}`),
    ]);
    const stateData   = await stateRes.json();
    const accountData = await accountRes.json().catch(() => ({}));
    const state       = stateData.stateInstance || 'unknown';
    res.json({
      ok:            state === 'authorized',
      stateInstance: state,
      webhookUrl:    accountData.webhookUrl || '',
      webhookMode:   accountData.webhookUrlToken || '',
      instanceId,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/botsailor/set-webhook  — Update webhook URL in Green API settings
// Body: { webhookUrl }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/set-webhook', async (req, res) => {
  const instanceId = process.env.GREENAPI_INSTANCE_ID;
  const token      = process.env.GREENAPI_API_TOKEN;
  if (!instanceId || !token) return res.status(400).json({ ok: false, error: 'Green API credentials not set' });

  const webhookUrl = req.body.webhookUrl || 'https://api.sathvam.in/api/botsailor/webhook';
  try {
    const BASE = 'https://api.green-api.com';
    const r = await fetch(`${BASE}/waInstance${instanceId}/setSettings/${token}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webhookUrl,
        incomingWebhook: 'yes',
        outgoingWebhook: 'yes',
        outgoingMessageWebhook: 'yes',
        stateWebhook: 'yes',
      }),
    });
    const data = await r.json();
    res.json({ ok: data.saveSettings === true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/botsailor/send-test-message  — Send a test WA message to admin phone
// ─────────────────────────────────────────────────────────────────────────────
router.post('/send-test-message', async (req, res) => {
  const adminPhone = process.env.WA_ADMIN_PHONE1;
  if (!adminPhone) return res.status(400).json({ ok: false, error: 'WA_ADMIN_PHONE1 not set in .env' });
  const msg = `✅ *Sathvam Green API Test*\n\nThis is a test message from your admin panel.\nTimestamp: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`;
  const ok = await sendText(adminPhone, msg);
  if (!ok) return res.status(500).json({ ok: false, error: 'Send failed — check Green API credentials and WhatsApp connection' });
  res.json({ ok: true, sentTo: adminPhone });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/botsailor/broadcast-social  — Broadcast image + caption to all customers
// Body: { caption, image_url }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/broadcast-social', async (req, res) => {
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
      const ok = await sendFile(digits, imgUrl, 'sathvam.jpg', caption);
      if (ok) sent++; else failed++;
    }
    res.json({ ok: true, sent, failed, skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/botsailor/webhook  — Green API sends incoming WhatsApp messages here
//
// Green API webhook URL to configure:
//   https://api.sathvam.in/api/botsailor/webhook
//
// Green API webhook payload (typeWebhook: "incomingMessageReceived"):
//   {
//     typeWebhook: "incomingMessageReceived",
//     senderData: { chatId: "919876543210@c.us", senderName: "Name" },
//     messageData: { typeMessage: "textMessage", textMessageData: { textMessage: "Hi" } }
//   }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/webhook', async (req, res) => {
  // Respond 200 immediately so Green API doesn't retry
  res.status(200).json({ status: '1', message: 'ok' });

  try {
    const body = req.body;
    console.log('[wa-raw] typeWebhook=' + body?.typeWebhook + ' msgType=' + body?.messageData?.typeMessage + ' chatId=' + body?.senderData?.chatId);

    // Handle outbound message status updates
    if (body.typeWebhook === 'outgoingMessageStatus') {
      const status = (body.status || 'sent').toLowerCase();
      if (body.idMessage) {
        await supabase
          .from('whatsapp_messages')
          .update({ status })
          .eq('wa_message_id', body.idMessage);
      }
      return;
    }

    // Only process incoming text messages
    console.log('[wa-debug] webhook type:', body.typeWebhook, 'msgType:', body.messageData?.typeMessage);
    if (body.typeWebhook !== 'incomingMessageReceived') return;

    const typeMessage = body.messageData?.typeMessage;
    const ACCEPTED_TYPES = ['textMessage', 'extendedTextMessage', 'buttonsResponseMessage', 'listResponseMessage', 'templateButtonReplyMessage'];
    if (typeMessage && !ACCEPTED_TYPES.includes(typeMessage)) return;

    const rawChatId = body.senderData?.chatId || body.senderData?.sender || '';
    const phone = rawChatId.replace('@c.us', '').replace(/\D/g, '');
    if (!phone) return;

    // Extract text from all supported message types
    const last_message =
      body.messageData?.textMessageData?.textMessage ||
      body.messageData?.extendedTextMessageData?.text ||
      body.messageData?.buttonsResponseMessage?.selectedButtonId ||
      body.messageData?.listResponseMessage?.listResponseRow?.rowId ||
      body.messageData?.templateButtonReplyMessage?.selectedId || '';
    console.log('[wa-debug] phone:', phone, 'type:', typeMessage, 'msg:', JSON.stringify(last_message));
    if (!last_message.trim()) return;

    const subscriber_name = body.senderData?.senderName || body.senderData?.chatName || null;

    // ── Admin approval flow for broadcasts ───────────────────────────────────
    const adminNo  = (process.env.THIRUKURAL_APPROVAL_PHONE || process.env.WA_NOTIFY_TO || '').replace(/\D/g, '');
    const isAdmin  = adminNo && (phone === adminNo || phone.endsWith(adminNo) || adminNo.endsWith(phone));
    const msgLower = last_message.trim().toLowerCase();

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
          await sendText(phone, reply);
        } catch (e) {
          await sendText(phone, `❌ Broadcast failed: ${e.message}`);
        }
        return;
      }

      if (/^skip\s*(morning|afternoon|night)?$/i.test(msgLower)) {
        await sendText(phone, `⏭️ Broadcast skipped.`);
        return;
      }
    }

    // Store inbound message
    await storeMessage({
      phone,
      contact_name:  subscriber_name,
      direction:     'inbound',
      type:          'text',
      content:       last_message,
      status:        'received',
      timestamp:     new Date().toISOString(),
    });

    // 1. WhatsApp bot state machine (takes priority over keyword replies and AI)
    try {
      const botResult = await handleBotMessage(phone, last_message, subscriber_name);
      // handled=true means bot sent interactively (buttons/list) — don't fall through to AI
      if (botResult.handled || botResult.reply !== null) {
        if (botResult.reply !== null) {
          await sendText(phone, botResult.reply);
          await storeMessage({
            phone, direction: 'outbound', type: 'text',
            content: botResult.reply, status: 'sent', sent_by: 'bot',
            timestamp: new Date().toISOString(),
          });
        }
        return;
      }
    } catch (botErr) {
      console.error('[wa-bot] handleBotMessage error:', botErr.message);
      // Non-fatal — fall through to keyword/AI
    }

    // 2. Keyword shortcuts
    const kwReply = await keywordReply(last_message, phone);
    if (kwReply) {
      await sendText(phone, kwReply);
      await storeMessage({
        phone, direction: 'outbound', type: 'text',
        content: kwReply, status: 'sent', sent_by: 'bot',
        timestamp: new Date().toISOString(),
      });
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

    await sendText(phone, reply);
    await storeMessage({
      phone, direction: 'outbound', type: 'text',
      content: reply, status: 'sent', sent_by: 'bot',
      timestamp: new Date().toISOString(),
    });
    await saveHistory(phone, [
      ...history,
      { role: 'user',      content: last_message },
      { role: 'assistant', content: reply },
    ]);

  } catch (e) {
    console.error('Green API webhook error:', e.message);
  }
});

module.exports = router;
