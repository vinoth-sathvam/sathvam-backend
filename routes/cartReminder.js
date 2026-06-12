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
const { execFile } = require('child_process');
const fs         = require('fs');
const path       = require('path');
const { auth }   = require('../middleware/auth');
const { toChatId } = require('../lib/greenapi');

const router     = express.Router();

const SCRIPT_DIR = '/home/ubuntu/cart-reminder';
const SCRIPT     = path.join(SCRIPT_DIR, 'generate_reminder.py');
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output');
const PYTHON     = 'python3';

const GREENAPI_BASE = 'https://api.green-api.com';

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

// ── Helper: run the Python generator ─────────────────────────────────────────
function runGenerator(inputJsonPath, type) {
  return new Promise((resolve, reject) => {
    const args = ['--input', inputJsonPath];
    if (type) args.push('--type', type);
    execFile(
      PYTHON,
      [SCRIPT, ...args],
      { timeout: 45_000, cwd: SCRIPT_DIR },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      }
    );
  });
}

// ── POST /api/cart-reminder/send ──────────────────────────────────────────────
router.post('/send', auth, async (req, res) => {
  const { phone, name, items, cart_value } = req.body;

  if (!phone)                           return res.status(400).json({ error: 'phone required' });
  if (!name)                            return res.status(400).json({ error: 'name required' });
  if (!Array.isArray(items) || !items.length)
                                        return res.status(400).json({ error: 'items must be a non-empty array' });

  const tmpJson  = path.join('/tmp', `cart_rm_${Date.now()}.json`);
  const pngPath  = path.join(OUTPUT_DIR, `${safeName(name)}_cart_reminder.png`);

  try {
    // 1. Write temp input JSON
    fs.writeFileSync(tmpJson, JSON.stringify([{ name, items, cart_value: cart_value || 0 }]));

    // 2. Generate PNG
    await runGenerator(tmpJson);

    if (!fs.existsSync(pngPath)) throw new Error('PNG was not generated');

    // 3. Send via Green API
    const caption = `🌿 *SATHVAM*\n_Pure. Cold-Pressed. Honest._\n\nDear *${name}*, your cart is saved and waiting for you 🛒\n\n👉 *Complete your order:*\nhttps://www.sathvam.in/cart\n\nReply here anytime — we're happy to help! 🙏`;
    const msgId   = await sendPngViaGreenApi(phone, pngPath, caption);

    res.json({ ok: true, idMessage: msgId });
  } catch (err) {
    console.error('[cart-reminder]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (fs.existsSync(tmpJson)) fs.unlinkSync(tmpJson);
  }
});

// ── POST /api/cart-reminder/send-order ────────────────────────────────────────
router.post('/send-order', auth, async (req, res) => {
  const { phone, name, order_no, status, items, cart_value,
          tracking_no, courier, cancel_reason, payment_method } = req.body;

  if (!phone)                               return res.status(400).json({ error: 'phone required' });
  if (!name)                                return res.status(400).json({ error: 'name required' });
  if (!order_no)                            return res.status(400).json({ error: 'order_no required' });
  if (!status)                              return res.status(400).json({ error: 'status required' });
  if (!Array.isArray(items) || !items.length)
                                            return res.status(400).json({ error: 'items must be a non-empty array' });

  const tmpJson    = path.join('/tmp', `order_rm_${Date.now()}.json`);
  const safeN      = safeName(name);
  const safeOrderNo = safeName(order_no);
  const pngPath    = path.join(OUTPUT_DIR, `${safeN}_${safeOrderNo}_order.png`);

  try {
    // 1. Write temp input JSON
    const orderData = {
      name,
      order_no,
      status,
      items,
      cart_value: cart_value || 0,
      tracking_no:    tracking_no    || '',
      courier:        courier        || '',
      cancel_reason:  cancel_reason  || '',
      payment_method: payment_method || '',
    };
    fs.writeFileSync(tmpJson, JSON.stringify([orderData]));

    // 2. Generate PNG
    await runGenerator(tmpJson, 'order');

    if (!fs.existsSync(pngPath)) throw new Error('Order PNG was not generated');

    // 3. Build WhatsApp caption
    const meta = STATUS_META[status] || STATUS_META['confirmed'];
    const caption = `🌿 *SATHVAM* | Order #${order_no}\n${meta.icon} *${meta.label}*\n\n${meta.msg}\n\n👉 ${meta.cta}\n\nReply anytime — Team Sathvam 🙏`;

    // 4. Send via Green API
    const msgId = await sendPngViaGreenApi(phone, pngPath, caption);

    res.json({ ok: true, idMessage: msgId });
  } catch (err) {
    console.error('[order-reminder]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (fs.existsSync(tmpJson)) fs.unlinkSync(tmpJson);
  }
});

module.exports = router;
