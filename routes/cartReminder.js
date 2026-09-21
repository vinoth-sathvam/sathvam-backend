/**
 * Cart Reminder Image Generator + WhatsApp Sender
 *
 * POST /api/cart-reminder/send
 *   Body: { phone, name, items: [{product, qty}], cart_value }
 *
 * POST /api/cart-reminder/send-order
 *   Body: { phone, name, order_no, status, items: [{product, qty}], cart_value,
 *           tracking_no?, courier?, cancel_reason?, payment_method? }
 *
 * Generates a branded PNG via the Python/Playwright script at
 * /home/ubuntu/cart-reminder/generate_reminder.py, then uploads
 * it to Green API via sendFileByUpload (direct binary upload, no public URL needed).
 */

const express    = require('express');
const fs         = require('fs');
const { auth }   = require('../middleware/auth');
const { toChatId, isAutomationDisabled } = require('../lib/greenapi');
const supabase   = require('../config/supabase');

const router     = express.Router();

const GREENAPI_BASE  = 'https://api.green-api.com';
const PNG_GEN_URL    = process.env.DOCKER_ENV === 'true'
  ? 'http://host.docker.internal:8765/generate'
  : 'http://localhost:8765/generate';

// ── Order status metadata (mirrors ORDER_STATUSES in Python) ──────────────────
const STATUS_META = {
  confirmed: { label: 'Order Confirmed',   icon: '✅', msg: "Your order has been confirmed and we're preparing it now.", cta: 'https://www.sathvam.in/orders' },
  packed:    { label: 'Order Packed',       icon: '📦', msg: 'Your order is carefully packed and ready to ship.',          cta: 'https://www.sathvam.in/orders' },
  shipped:   { label: 'On the Way!',        icon: '🚚', msg: 'Your order is on its way to you.',                           cta: 'https://www.sathvam.in/orders' },
  delivered: { label: 'Order Delivered',    icon: '🎉', msg: 'Your order has been delivered. Enjoy your Sathvam products!', cta: 'https://www.sathvam.in/orders' },
  cancelled: { label: 'Order Cancelled',    icon: '❌', msg: 'Your order has been cancelled.',                             cta: 'https://www.sathvam.in/orders' },
  paid:      { label: 'Payment Confirmed',  icon: '💳', msg: 'Your payment has been received successfully.',              cta: 'https://www.sathvam.in/orders' },
};

// ── Helper: upload PNG file to Green API and send to WhatsApp ─────────────────
async function sendPngViaGreenApi(phone, pngPath, caption) {
  const instanceId = process.env.GREENAPI_INSTANCE_ID;
  const token      = process.env.GREENAPI_API_TOKEN;
  const chatId     = toChatId(phone);
  if (!chatId) throw new Error(`Invalid phone number: ${phone}`);

  const fileBuffer = fs.readFileSync(pngPath);
  const blob       = new Blob([fileBuffer], { type: 'image/png' });

  const form = new FormData();
  form.append('chatId', chatId);
  form.append('caption', caption || '');
  form.append('file', blob, 'Sathvam_Cart_Reminder.png');

  const res  = await fetch(
    `${GREENAPI_BASE}/waInstance${instanceId}/sendFileByUpload/${token}`,
    { method: 'POST', body: form }
  );
  const data = await res.json();
  if (!data.idMessage) throw new Error(`Green API error: ${JSON.stringify(data)}`);
  return data.idMessage;
}

// ── Helper: safe filename from customer name ──────────────────────────────────
function safeName(name) {
  return (name || 'Customer').replace(/[^a-zA-Z0-9_-]/g, '_');
}

// ── Helper: call host-side PNG generator microservice ──────────────────────────
async function runGenerator(data, type) {
  const res  = await fetch(PNG_GEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ type: type || 'cart', data }),
    signal:  AbortSignal.timeout(60_000),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'PNG generation failed');
  return json.path;
}

// ── Helper: fetch current cart from DB with live product prices ──────────────
async function refreshCartForPhone(phone) {
  try {
    if (!phone) return null;
    const clean = String(phone).replace(/\D/g, '');
    const last10 = clean.length > 10 ? clean.slice(-10) : clean;

    // Find customer by phone
    const { data: customers } = await supabase
      .from('customers')
      .select('id')
      .like('phone', `%${last10}`)
      .limit(1);
    if (!customers?.length) return null;

    const sessionId = 'cust_' + customers[0].id;
    const { data: cartRow } = await supabase
      .from('abandoned_carts')
      .select('items')
      .eq('session_id', sessionId)
      .maybeSingle();
    if (!cartRow?.items?.length) return null;

    // Fetch current prices
    const productIds = cartRow.items.map(i => i.id).filter(Boolean);
    if (!productIds.length) return null;

    const { data: products } = await supabase
      .from('products')
      .select('id, website_price, price, offer_price, offer_ends_at, name')
      .in('id', productIds);
    if (!products?.length) return null;

    const priceMap = {};
    for (const p of products) priceMap[p.id] = p;

    let total = 0;
    const freshItems = cartRow.items.map(item => {
      const dbProd = priceMap[item.id];
      if (!dbProd) return { product: item.name || 'Item', qty: item.qty || 1 };
      let currentPrice = parseFloat(dbProd.website_price || dbProd.price || 0);
      if (dbProd.offer_price && dbProd.offer_ends_at) {
        const offerEnd = new Date(dbProd.offer_ends_at);
        if (offerEnd > new Date() && parseFloat(dbProd.offer_price) < currentPrice) {
          currentPrice = parseFloat(dbProd.offer_price);
        }
      }
      const qty = item.qty || 1;
      total += currentPrice * qty;
      return { product: dbProd.name || item.name, qty };
    });

    return { items: freshItems, cart_value: Math.round(total) };
  } catch (e) {
    console.error('[cart-reminder] refreshCartForPhone error:', e.message);
    return null;
  }
}

// ── POST /api/cart-reminder/send ──────────────────────────────────────────────
router.post('/send', auth, async (req, res) => {
  if (await isAutomationDisabled('checkout_recovery')) return res.status(403).json({ error: 'checkout_recovery automation is disabled' });
  const { phone, name, items, cart_value, type } = req.body;

  if (!phone)                           return res.status(400).json({ error: 'phone required' });
  if (!name)                            return res.status(400).json({ error: 'name required' });

  const isNudge = type === 'nudge';

  // items required for checkout reminders, optional for nudge
  if (!isNudge && (!Array.isArray(items) || !items.length))
                                        return res.status(400).json({ error: 'items must be a non-empty array' });

  try {
    // Refresh cart value from DB with current product prices
    let freshItems = items;
    let freshCartValue = cart_value;
    if (!isNudge) {
      const freshData = await refreshCartForPhone(phone);
      if (freshData) {
        freshItems    = freshData.items;
        freshCartValue = freshData.cart_value;
      }
    }

    const caption = isNudge
      ? `🌿 *SATHVAM*\n_Pure. Cold-Pressed. Honest._\n\nHi *${name}*! 👋\n\nWe noticed you're exploring our store — great taste! 🌾\n\nNeed help choosing the right oil or have any questions? Just reply here, we'd love to help.\n\n👉 *Continue shopping:*\nhttps://www.sathvam.in/products\n\n🙏 Team Sathvam`
      : `🌿 *SATHVAM*\n_Pure. Cold-Pressed. Honest._\n\nDear *${name}*, your cart is saved and waiting for you 🛒\n\n👉 *Complete your order:*\nhttps://www.sathvam.in/cart\n\nReply here anytime — we're happy to help! 🙏`;

    if (!isNudge || (Array.isArray(freshItems) && freshItems.length)) {
      // Generate branded PNG + send with image
      const pngPath = await runGenerator({ name, items: freshItems || [], cart_value: freshCartValue || 0 }, 'cart');
      const msgId   = await sendPngViaGreenApi(phone, pngPath, caption);
      return res.json({ ok: true, idMessage: msgId });
    }

    // Nudge with no items — send text-only via Green API
    const instanceId = process.env.GREENAPI_INSTANCE_ID;
    const token      = process.env.GREENAPI_API_TOKEN;
    const chatId     = toChatId(phone);
    if (!chatId) throw new Error(`Invalid phone number: ${phone}`);
    const msgRes = await fetch(
      `${GREENAPI_BASE}/waInstance${instanceId}/sendMessage/${token}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, message: caption }) }
    );
    const msgData = await msgRes.json();
    if (!msgData.idMessage) throw new Error(`Green API error: ${JSON.stringify(msgData)}`);
    res.json({ ok: true, idMessage: msgData.idMessage });
  } catch (err) {
    console.error('[cart-reminder]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/cart-reminder/send-order ────────────────────────────────────────
router.post('/send-order', auth, async (req, res) => {
  if (await isAutomationDisabled('checkout_recovery')) return res.status(403).json({ error: 'checkout_recovery automation is disabled' });
  const { phone, name, order_no, status, items, cart_value,
          tracking_no, courier, cancel_reason, payment_method } = req.body;

  if (!phone)                               return res.status(400).json({ error: 'phone required' });
  if (!name)                                return res.status(400).json({ error: 'name required' });
  if (!order_no)                            return res.status(400).json({ error: 'order_no required' });
  if (!status)                              return res.status(400).json({ error: 'status required' });
  if (!Array.isArray(items) || !items.length)
                                            return res.status(400).json({ error: 'items must be a non-empty array' });

  try {
    // 1. Generate PNG via host microservice
    const orderData = {
      name, order_no, status, items,
      cart_value:     cart_value     || 0,
      tracking_no:    tracking_no    || '',
      courier:        courier        || '',
      cancel_reason:  cancel_reason  || '',
      payment_method: payment_method || '',
    };
    const pngPath = await runGenerator(orderData, 'order');

    // 2. Build WhatsApp caption
    const meta = STATUS_META[status] || STATUS_META['confirmed'];
    const caption = `🌿 *SATHVAM* | Order #${order_no}\n${meta.icon} *${meta.label}*\n\n${meta.msg}\n\n👉 ${meta.cta}\n\nReply anytime — Team Sathvam 🙏`;

    // 3. Send via Green API
    const msgId = await sendPngViaGreenApi(phone, pngPath, caption);

    res.json({ ok: true, idMessage: msgId });
  } catch (err) {
    console.error('[order-reminder]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
