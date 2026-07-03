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

// ── POST /api/cart-reminder/send ──────────────────────────────────────────────
router.post('/send', auth, async (req, res) => {
  if (await isAutomationDisabled('checkout_recovery')) return res.status(403).json({ error: 'checkout_recovery automation is disabled' });
  const { phone, name, items, cart_value } = req.body;

  if (!phone)                           return res.status(400).json({ error: 'phone required' });
  if (!name)                            return res.status(400).json({ error: 'name required' });
  if (!Array.isArray(items) || !items.length)
                                        return res.status(400).json({ error: 'items must be a non-empty array' });

  try {
    // 1. Generate PNG via host microservice
    const pngPath = await runGenerator({ name, items, cart_value: cart_value || 0 }, 'cart');

    // 2. Send via Green API
    const caption = `🌿 *SATHVAM*\n_Pure. Cold-Pressed. Honest._\n\nDear *${name}*, your cart is saved and waiting for you 🛒\n\n👉 *Complete your order:*\nhttps://www.sathvam.in/cart\n\nReply here anytime — we're happy to help! 🙏`;
    const msgId   = await sendPngViaGreenApi(phone, pngPath, caption);

    res.json({ ok: true, idMessage: msgId });
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
