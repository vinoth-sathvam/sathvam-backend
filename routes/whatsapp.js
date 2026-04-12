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

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { auth } = require('../middleware/auth');

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const WA_BASE = 'https://graph.facebook.com/v19.0';

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
