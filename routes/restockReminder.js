// restockReminder.js — daily restock reminder emails + WhatsApp to customers
// POST /api/restock-reminders/run  (protected by x-service-key header)
// Called daily by sathvam-restock-reminder.timer via curl

const express    = require('express');
const nodemailer = require('nodemailer');
const supabase   = require('../config/supabase');
const router     = express.Router();

const SERVICE_KEY   = process.env.SCHEDULER_SECRET || process.env.SUPABASE_SERVICE_KEY?.slice(-16);
const BOT_TOKEN     = process.env.BOTSAILOR_API_TOKEN;
const BOT_PHONE_ID  = process.env.BOTSAILOR_PHONE_NUMBER_ID || process.env.WA_PHONE_NUMBER_ID;
const BOTSAILOR_URL = 'https://botsailor.com/api/v1/whatsapp/send';
const STORE_URL     = 'https://sathvam.in';

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// Compute restock interval (days) based on item pack size × qty
function restockDays(items) {
  let minDays = 999;
  for (const it of (items || [])) {
    const name = (it.productName || it.name || '').toLowerCase();
    const qty  = Math.max(1, parseFloat(it.qty || 1));
    let base;
    if      (name.includes('2l') || name.includes('2000')) base = 35;
    else if (name.includes('1l') || name.includes('1000')) base = 20;
    else if (name.includes('500'))                          base = 12;
    else if (name.includes('250'))                          base = 8;
    else                                                    base = 15;
    const days = Math.round(base * Math.min(qty, 4));
    if (days < minDays) minDays = days;
  }
  return minDays === 999 ? 15 : minDays;
}

function buildReminderEmail(order, daysAgo) {
  const name     = order.customer?.name || order.customerName || 'Valued Customer';
  const items    = (order.items || []).slice(0, 5);
  const itemRows = items.map(it => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:13px">${it.productName || it.name || 'Product'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:center">${it.qty}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right">₹${parseFloat(it.price || it.rate || 0).toFixed(0)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f7f7f2;font-family:'Segoe UI',Arial,sans-serif">
<div style="max-width:560px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
  <div style="background:linear-gradient(135deg,#1a5c2a,#16a34a);padding:32px 28px;text-align:center">
    <div style="font-size:42px;margin-bottom:8px">🌿</div>
    <div style="color:#fff;font-size:22px;font-weight:800;letter-spacing:0.5px">Time to restock!</div>
    <div style="color:rgba(255,255,255,0.8);font-size:14px;margin-top:6px">Your Sathvam oils may be running low</div>
  </div>
  <div style="padding:28px">
    <p style="font-size:15px;color:#1f2937;margin:0 0 8px">Hi <strong>${name}</strong>,</p>
    <p style="font-size:14px;color:#6b7280;line-height:1.6;margin:0 0 20px">
      It's been <strong>${daysAgo} days</strong> since your last order. Based on typical usage, you may be running low on your cold-pressed oils. Here's what you ordered last time:
    </p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
      <thead>
        <tr style="background:#f9fafb">
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.8px">Product</th>
          <th style="padding:10px 12px;text-align:center;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.8px">Qty</th>
          <th style="padding:10px 12px;text-align:right;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.8px">Price</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>
    <div style="text-align:center;margin:24px 0">
      <a href="${STORE_URL}" style="display:inline-block;background:linear-gradient(135deg,#1a5c2a,#16a34a);color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-size:15px;font-weight:700;letter-spacing:0.3px">🛒 Reorder Now</a>
    </div>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px 16px;font-size:13px;color:#15803d">
      <strong>Why Sathvam?</strong> Cold-pressed oils retain natural nutrients, antioxidants and authentic flavour — extracted without heat.
    </div>
  </div>
  <div style="padding:16px 28px;background:#f9fafb;border-top:1px solid #e5e7eb;text-align:center;font-size:11px;color:#9ca3af">
    Sathvam Oils and Spices Pvt Ltd · Karur, Tamil Nadu · <a href="${STORE_URL}" style="color:#16a34a">sathvam.in</a><br>
    <a href="${STORE_URL}/unsubscribe" style="color:#9ca3af">Unsubscribe</a>
  </div>
</div>
</body></html>`;
}

function buildWAMessage(order, daysAgo) {
  const name  = order.customer?.name || order.customerName || 'Customer';
  const items = (order.items || []).slice(0, 3);
  const list  = items.map(it => `  • ${it.productName || it.name} × ${it.qty}`).join('\n');
  return `🌿 *Time to Restock Your Sathvam Oils!*

Hi ${name},

It's been *${daysAgo} days* since your last order. Your oils may be running low!

*Last ordered:*
${list}

Order fresh cold-pressed oils now 👇
🛒 ${STORE_URL}

— Team Sathvam`;
}

async function sendWA(phone, message) {
  if (!BOT_TOKEN || !BOT_PHONE_ID || !phone) return;
  const ph = String(phone).replace(/\D/g, '');
  const num = ph.length === 10 ? '91' + ph : ph;
  const params = new URLSearchParams({ apiToken: BOT_TOKEN, phone_number_id: BOT_PHONE_ID, phone_number: num, message });
  const res = await fetch(BOTSAILOR_URL, { method: 'POST', body: params });
  return res.json();
}

// Service key middleware
function serviceAuth(req, res, next) {
  const key = req.headers['x-service-key'];
  if (!SERVICE_KEY || key === SERVICE_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// POST /api/restock-reminders/run
router.post('/run', serviceAuth, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const results = { sent: 0, skipped: 0, errors: [] };

  try {
    // Fetch delivered orders from last 60 days
    const cutoff = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    const { data: orders, error } = await supabase
      .from('webstore_orders')
      .select('id,order_no,date,status,items,customer,restock_reminded_at')
      .eq('status', 'delivered')
      .gte('date', cutoff)
      .not('customer', 'is', null);

    if (error) throw error;

    for (const order of (orders || [])) {
      try {
        if (order.restock_reminded_at) { results.skipped++; continue; }
        const orderDate  = new Date(order.date);
        const daysAgo    = Math.round((Date.now() - orderDate.getTime()) / 86400000);
        const targetDays = restockDays(order.items);

        // Only send if today matches the target restock day (±1 day tolerance)
        if (Math.abs(daysAgo - targetDays) > 1) { results.skipped++; continue; }

        const email = order.customer?.email;
        const phone = order.customer?.phone || order.customer?.mobile;
        const name  = order.customer?.name || 'Customer';

        if (!email && !phone) { results.skipped++; continue; }

        // Send WhatsApp
        if (phone) {
          await sendWA(phone, buildWAMessage(order, daysAgo));
        }

        // Send email
        if (email) {
          await mailer.sendMail({
            from: process.env.SMTP_FROM || 'Sathvam Oils <vinoth@sathvam.in>',
            to:   `${name} <${email}>`,
            subject: `🌿 Time to restock your Sathvam oils, ${name.split(' ')[0]}!`,
            html: buildReminderEmail(order, daysAgo),
          });
        }

        // Mark as reminded
        await supabase.from('webstore_orders').update({ restock_reminded_at: today }).eq('id', order.id);

        results.sent++;
        console.log(`[restock-reminder] Sent to ${name} (order ${order.order_no}) — ${daysAgo} days ago`);
      } catch (e) {
        results.errors.push({ order: order.order_no, error: e.message });
        console.error(`[restock-reminder] Error for ${order.order_no}:`, e.message);
      }
    }

    console.log(`[restock-reminder] Done — sent:${results.sent} skipped:${results.skipped} errors:${results.errors.length}`);
    res.json({ ok: true, date: today, ...results });
  } catch (e) {
    console.error('[restock-reminder] Fatal:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/restock-reminders/preview — shows what would be sent today (no actual sending)
router.get('/preview', serviceAuth, async (req, res) => {
  const cutoff = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const { data: orders } = await supabase
    .from('webstore_orders')
    .select('id,order_no,date,status,items,customer,restock_reminded_at')
    .eq('status', 'delivered')
    .gte('date', cutoff);

  const preview = (orders || [])
    .filter(o => !o.restock_reminded_at)
    .map(o => {
      const daysAgo    = Math.round((Date.now() - new Date(o.date).getTime()) / 86400000);
      const targetDays = restockDays(o.items);
      return { order_no: o.order_no, date: o.date, daysAgo, targetDays, match: Math.abs(daysAgo - targetDays) <= 1, customer: o.customer?.name, email: o.customer?.email, phone: o.customer?.phone };
    })
    .filter(o => o.match);

  res.json({ date: new Date().toISOString().slice(0, 10), would_send: preview.length, orders: preview });
});

module.exports = router;
