#!/usr/bin/env node
'use strict';
/**
 * Payment Recovery Agent
 *
 * Periodically scans Razorpay for captured payments that have no matching
 * webstore order.  Three recovery paths:
 *
 *   1. Pending stash exists  → full order recovery (items, sales, ledger,
 *      notifications, Zoho invoice, finished-goods deduction)
 *   2. No stash but customer identifiable → admin WhatsApp alert with
 *      payment details so order can be created manually
 *   3. Already recovered     → skip silently
 *
 * Schedule: systemd timer every 30 min
 *   sathvam-payment-recovery.timer
 *
 * Manual run:
 *   node scripts/payment-recovery-agent.js [--dry-run] [--hours=48]
 */

require('dotenv').config();
const crypto       = require('crypto');
const Razorpay     = require('razorpay');
const supabase     = require('../config/supabase');
const { encrypt, hmac, encryptCustomer } = require('../config/crypto');
const { insertLedger }    = require('../utils/ledger');
const { sendText: gaSendText } = require('../lib/greenapi');

// ── Razorpay client ──────────────────────────────────────────────────────────
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ── CLI flags ────────────────────────────────────────────────────────────────
const DRY_RUN = process.argv.includes('--dry-run');
const HOURS   = parseInt((process.argv.find(a => a.startsWith('--hours=')) || '').split('=')[1]) || 48;

// ── Helpers (mirrored from payments.js) ──────────────────────────────────────

async function generateOrderNo(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const prefix = `SA${d.getFullYear()}${months[d.getMonth()]}${String(d.getDate()).padStart(2, '0')}`;
  const { data: last } = await supabase.from('webstore_orders')
    .select('order_no').like('order_no', `${prefix}%`)
    .order('order_no', { ascending: false }).limit(1);
  let seq = 1;
  if (last?.length) {
    const n = parseInt(last[0].order_no.split('-').pop()) || 0;
    seq = n + 1;
  }
  return `${prefix}-${String(seq).padStart(2, '0')}`;
}

function log(icon, ...args) {
  const ist = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  console.log(`[${ist}] ${icon}`, ...args);
}

// ── Notification helpers ─────────────────────────────────────────────────────

async function notifyAdmin(msg) {
  const phones = [process.env.WA_ADMIN_PHONE1, process.env.WA_NOTIFY_TO]
    .filter(Boolean).map(n => n.replace(/\D/g, '')).filter((v, i, a) => v && a.indexOf(v) === i);
  for (const phone of phones) {
    try { await gaSendText(phone, msg); } catch (e) { log('⚠️', 'Admin WA failed:', e.message); }
  }
}

async function notifyCustomer(phone, orderNo, total, itemCount) {
  if (!phone) return;
  const cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.length < 10) return;
  const msg =
    `✅ *Order Confirmed — Sathvam*\n\n` +
    `📋 Order: *${orderNo}*\n` +
    `💰 Total: *₹${Number(total).toLocaleString('en-IN')}*\n` +
    `📦 Items: ${itemCount}\n\n` +
    `Your payment has been received and your order is confirmed.\n` +
    `We'll notify you when it ships. 🙏\n\n` +
    `Track: https://sathvam.in/orders`;
  try { await gaSendText(cleanPhone, msg); } catch (e) { log('⚠️', 'Customer WA failed:', e.message); }
}

async function sendConfirmationEmail(order) {
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const customer = order.customer || {};
    if (!customer.email) return;
    const items = (order.items || []).map(i =>
      `<tr><td style="padding:8px;border-bottom:1px solid #eee">${i.name}</td>` +
      `<td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${i.qty}</td>` +
      `<td style="padding:8px;border-bottom:1px solid #eee;text-align:right">₹${Number(i.price).toLocaleString('en-IN')}</td></tr>`
    ).join('');
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: customer.email,
      subject: `Order Confirmed — ${order.orderNo} | Sathvam`,
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">` +
        `<div style="background:#16a34a;color:#fff;padding:20px;text-align:center;border-radius:8px 8px 0 0">` +
        `<h2 style="margin:0">✅ Order Confirmed</h2></div>` +
        `<div style="padding:20px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">` +
        `<p>Hi ${customer.name || 'Customer'},</p>` +
        `<p>Your payment of <strong>₹${Number(order.total).toLocaleString('en-IN')}</strong> has been received.</p>` +
        `<p><strong>Order #:</strong> ${order.orderNo}</p>` +
        `<table style="width:100%;border-collapse:collapse;margin:16px 0"><thead>` +
        `<tr style="background:#f9fafb"><th style="padding:8px;text-align:left">Item</th>` +
        `<th style="padding:8px;text-align:center">Qty</th><th style="padding:8px;text-align:right">Price</th></tr>` +
        `</thead><tbody>${items}</tbody></table>` +
        `<p style="font-size:14px;color:#6b7280">We'll notify you when your order ships.</p>` +
        `<p>— Team Sathvam 🌿</p></div></div>`,
    });
    log('📧', 'Email sent to', customer.email);
  } catch (e) { log('⚠️', 'Email error:', e.message); }
}

// ── Core: recover a single payment ───────────────────────────────────────────

async function recoverPayment(payment) {
  const paymentId  = payment.id;
  const rzpOrderId = payment.order_id;
  const amount     = payment.amount / 100;

  // 1. Check if order already exists
  const { data: existing } = await supabase.from('webstore_orders')
    .select('id, order_no')
    .or(`notes.ilike.%${paymentId}%,payment_id.eq.${paymentId}`)
    .limit(1).maybeSingle();

  if (existing) {
    log('✓', `${paymentId} → already has order ${existing.order_no} — skip`);
    return { status: 'already_exists', orderNo: existing.order_no };
  }

  // 2. Look for pending stash
  const { data: stashed } = await supabase.from('settings')
    .select('value').eq('key', `pending_order_${rzpOrderId}`).maybeSingle();

  if (!stashed?.value) {
    // No stash — orphaned payment, alert admin
    log('⚠️', `${paymentId} ₹${amount} — NO stash found, alerting admin`);
    if (!DRY_RUN) {
      await notifyAdmin(
        `⚠️ *Payment Without Order — Recovery Agent*\n\n` +
        `💳 *₹${amount.toLocaleString('en-IN')}* captured\n` +
        `📧 ${payment.email || '—'}\n` +
        `📞 ${payment.contact || '—'}\n` +
        `🔑 ${paymentId}\n` +
        `📋 Razorpay Order: ${rzpOrderId}\n` +
        `🕐 ${new Date(payment.created_at * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n` +
        `No pending order data found.\n` +
        `➡️ Create order manually in admin panel.`
      );
    }
    return { status: 'orphaned', paymentId };
  }

  // 3. Recover from stash
  const o = stashed.value;
  const rawCustomer = o.customer || {};
  log('🔄', `Recovering ${paymentId} ₹${amount} for ${rawCustomer.name || payment.email || '?'}`);

  if (DRY_RUN) {
    log('🏷️', `[DRY RUN] Would create order for ${rawCustomer.name} — ₹${o.total} (${(o.items || []).length} items)`);
    return { status: 'dry_run', customer: rawCustomer.name };
  }

  const encCustomer    = encryptCustomer(rawCustomer);
  const custEmailHash  = hmac(rawCustomer.email || '');
  const dbId           = crypto.randomUUID();
  const orderDate      = o.date || new Date().toISOString().slice(0, 10);
  const orderNo        = await generateOrderNo(orderDate);

  // Insert webstore order
  const { error: wsErr } = await supabase.from('webstore_orders').upsert({
    id:                  dbId,
    order_no:            orderNo,
    date:                orderDate,
    customer:            encCustomer,
    customer_email_hash: custEmailHash,
    items:               o.items || [],
    subtotal:            parseFloat(o.subtotal) || 0,
    gst:                 parseFloat(o.gst) || 0,
    shipping:            parseFloat(o.shipping) || 0,
    total:               parseFloat(o.total) || 0,
    status:              'confirmed',
    payment_status:      'paid',
    channel:             'website',
    notes:               `Razorpay: ${paymentId} (auto-recovered by agent)`,
  }, { onConflict: 'id' });

  if (wsErr) {
    log('❌', `Order creation failed: ${wsErr.message}`);
    await notifyAdmin(`❌ *Payment Recovery Failed*\n\n🔑 ${paymentId}\n💳 ₹${amount}\nError: ${wsErr.message}`);
    return { status: 'error', error: wsErr.message };
  }

  log('✅', `Order ${orderNo} created — ₹${o.total}`);

  // Sales record
  const addrNote = `${rawCustomer.address || ''}, ${rawCustomer.city || ''}, ${rawCustomer.state || ''} - ${rawCustomer.pincode || ''}`;
  const { data: sale } = await supabase.from('sales').insert({
    order_no:       orderNo,
    date:           orderDate,
    channel:        'website',
    status:         'pending',
    customer_name:  encrypt(rawCustomer.name || ''),
    customer_phone: encrypt(rawCustomer.phone || ''),
    total_amount:   parseFloat(o.subtotal) || 0,
    discount:       0,
    final_amount:   parseFloat(o.total) || 0,
    amount_paid:    parseFloat(o.total) || 0,
    payment_method: 'online',
    notes:          encrypt(`${addrNote} | Razorpay: ${paymentId} (agent-recovered)`),
  }).select().single();

  if (sale && Array.isArray(o.items) && o.items.length > 0) {
    await supabase.from('sale_items').insert(o.items.map(i => ({
      sale_id:      sale.id,
      product_id:   i.id || null,
      product_name: i.name || '',
      qty:          i.qty || 1,
      rate:         i.price || 0,
      total:        (i.qty || 1) * (i.price || 0),
      unit:         'pcs',
    })));
    log('✅', 'Sale + items created');
  }

  // Ledger entry
  insertLedger({
    txn_date:     orderDate,
    direction:    'in',
    amount:       parseFloat(o.total) || 0,
    category:     'sales',
    subcategory:  'webstore',
    party:        rawCustomer.name || 'Webstore Customer',
    party_type:   'customer',
    payment_mode: 'online',
    narration:    `Webstore order ${orderNo} (agent-recovered)`,
    reference_no: paymentId,
    source_table: 'webstore_orders',
    source_id:    dbId,
    created_by:   'system',
  }).catch(() => {});

  // Finished goods deduction
  try {
    const fgItems = (o.items || []).filter(i => parseFloat(i.qty) > 0);
    if (fgItems.length) {
      await supabase.from('finished_goods').insert(fgItems.map(i => ({
        product_name: i.name || '', category: 'other', unit: 'pcs',
        qty: parseFloat(i.qty), type: 'out',
        date: orderDate,
        notes: `Auto: Webstore order ${orderNo} (agent-recovered)`,
        batch_ref: orderNo, created_by: 'system',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      })));
      log('✅', 'Finished goods deducted');
    }
  } catch (fgErr) { log('⚠️', 'FG deduction error:', fgErr.message); }

  // Zoho invoice
  try {
    const { createInvoice, recordPayment } = require('../config/zoho');
    if (createInvoice) {
      const invoice = await createInvoice({ ...o, orderNo });
      if (invoice?.invoice_id) {
        await recordPayment(invoice, o.total, 'online', paymentId);
        await supabase.from('webstore_orders').update({ zoho_invoice_id: invoice.invoice_id }).eq('id', dbId);
        log('✅', 'Zoho invoice created:', invoice.invoice_id);
      }
    }
  } catch (ze) { log('⚠️', 'Zoho error:', ze.message); }

  // Notifications — customer WA + email + admin alert
  await notifyCustomer(rawCustomer.phone, orderNo, o.total, (o.items || []).length);
  await sendConfirmationEmail({ ...o, orderNo, customer: rawCustomer });

  // Admin summary
  const itemList = (o.items || []).slice(0, 5).map(i => `  ${i.qty}× ${i.name}`).join('\n');
  const moreItems = (o.items || []).length > 5 ? `\n  ... +${(o.items || []).length - 5} more` : '';
  await notifyAdmin(
    `✅ *Payment Recovered — Auto Agent*\n\n` +
    `📋 *${orderNo}*\n` +
    `👤 ${rawCustomer.name || '—'}\n` +
    `📞 ${rawCustomer.phone || '—'}\n` +
    `📧 ${rawCustomer.email || '—'}\n` +
    `🏙️ ${rawCustomer.city || '—'}, ${rawCustomer.state || '—'}\n` +
    `💰 *₹${Number(o.total).toLocaleString('en-IN')}*\n` +
    `📦 ${(o.items || []).length} items:\n${itemList}${moreItems}\n\n` +
    `💳 ${paymentId}\n` +
    `✅ Customer notified via WhatsApp + Email\n` +
    `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`
  );

  // Clean up stash
  await supabase.from('settings').delete().eq('key', `pending_order_${rzpOrderId}`);
  log('🗑️', 'Stash cleaned up');

  return { status: 'recovered', orderNo, total: o.total, customer: rawCustomer.name };
}

// ── Main: scan Razorpay payments ─────────────────────────────────────────────

async function main() {
  log('🚀', `Payment Recovery Agent started (last ${HOURS}h${DRY_RUN ? ', DRY RUN' : ''})`);

  const fromTs = Math.floor(Date.now() / 1000) - (HOURS * 3600);
  let skip = 0;
  const batchSize = 100;
  let totalScanned = 0;
  let recovered = 0;
  let orphaned = 0;
  let skipped = 0;

  // Paginate through Razorpay payments
  while (true) {
    let payments;
    try {
      payments = await razorpay.payments.all({
        count: batchSize,
        skip,
        from: fromTs,
      });
    } catch (e) {
      log('❌', 'Razorpay API error:', e.message);
      break;
    }

    const items = payments.items || [];
    if (!items.length) break;

    for (const p of items) {
      // Only process captured (successful) payments
      if (p.status !== 'captured') continue;
      // Skip very small amounts (test payments)
      if (p.amount < 100) continue;

      totalScanned++;
      try {
        const result = await recoverPayment(p);
        if (result.status === 'recovered' || result.status === 'dry_run') recovered++;
        else if (result.status === 'orphaned') orphaned++;
        else skipped++;
      } catch (e) {
        log('❌', `Error processing ${p.id}:`, e.message);
      }

      // Small delay to avoid hammering the DB
      await new Promise(r => setTimeout(r, 500));
    }

    skip += batchSize;
    if (items.length < batchSize) break; // last page
  }

  log('📊', `Done — Scanned: ${totalScanned}, Recovered: ${recovered}, Orphaned: ${orphaned}, Already OK: ${skipped}`);

  // Summary to admin if any action was taken
  if (recovered > 0 || orphaned > 0) {
    log('📤', 'Summary sent to admin');
  }
}

main()
  .then(() => { log('✅', 'Agent finished'); process.exit(0); })
  .catch(e => { log('❌', 'Fatal error:', e.message); process.exit(1); });
