#!/usr/bin/env node
/**
 * Payment Reminder Script
 * Sends WhatsApp reminders for COD / unpaid orders older than 1 day
 * Run via systemd timer: sathvam-payment-reminder.timer (daily 10 AM IST)
 * Or manually: node scripts/payment-reminder.js
 *
 * Targets orders where:
 *  - payment_status = 'pending'
 *  - status NOT IN (cancelled, rejected, delivered)
 *  - created_at between 1 and 3 days ago (reminder window)
 *  - payment_reminder_sent_at IS NULL (not already reminded today)
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { sendText: gaSendText, isAutomationDisabled } = require('../lib/greenapi');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function sendWA(phone, message) {
  return gaSendText(phone, message);
}

async function run() {
  if (await isAutomationDisabled('payment_reminder')) { console.log('Payment reminder disabled via toggle'); return; }

  const now      = new Date();
  const from     = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(); // 3 days ago
  const to       = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago

  const { data: orders, error } = await supabase
    .from('webstore_orders')
    .select('id, order_no, total, status, payment_status, customer, created_at, payment_reminder_sent_at')
    .eq('payment_status', 'pending')
    .not('status', 'in', '("cancelled","rejected","delivered")')
    .gte('created_at', from)
    .lte('created_at', to)
    .is('payment_reminder_sent_at', null);

  if (error) { console.error('DB error:', error.message); process.exit(1); }
  if (!orders?.length) { console.log('No pending payment orders to remind'); return; }

  console.log(`Found ${orders.length} order(s) to remind`);

  for (const o of orders) {
    let cust = o.customer || {};
    // decrypt if needed
    try {
      if (typeof cust === 'string') cust = JSON.parse(cust);
    } catch (_) {}

    const digits = (cust.phone || cust.mobile || '').replace(/\D/g, '');
    if (!digits || digits.length < 10) {
      console.log(`[SKIP] ${o.order_no} — no phone`);
      continue;
    }
    const phone = digits.length === 10 ? `91${digits}` : digits;
    const name  = cust.name || 'Customer';
    const total = parseFloat(o.total || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const message =
      `⏳ *Payment Reminder — ${o.order_no}*\n\n` +
      `Hi ${name.split(' ')[0]}, your Sathvam order *#${o.order_no}* worth *₹${total}* is awaiting payment.\n\n` +
      `Please complete your payment to avoid order cancellation.\n\n` +
      `💳 Pay now: https://sathvam.in/orders\n\n` +
      `Need help? Reply here or call *+91 76187 73778*\n\n` +
      `_— Team Sathvam 🌿_`;

    try {
      const result = await sendWA(phone, message);
      const ok = result.status === '1' || result.status === 1;
      console.log(`[${ok ? 'SENT' : 'FAIL'}] ${o.order_no} → ${phone.slice(0,4)}****${phone.slice(-3)} ${ok ? '' : result.message}`);

      // Log to whatsapp_messages
      await supabase.from('whatsapp_messages').insert({
        phone, contact_name: `${name} | ${o.order_no}`,
        direction: 'outbound', type: 'text', content: message,
        status: ok ? 'sent' : 'failed',
        sent_by: 'payment-reminder', timestamp: new Date().toISOString(),
      });

      // Mark reminded
      await supabase.from('webstore_orders')
        .update({ payment_reminder_sent_at: new Date().toISOString() })
        .eq('id', o.id);

    } catch (e) {
      console.error(`[ERROR] ${o.order_no}:`, e.message);
    }
  }

  console.log('Payment reminder run complete');
}

run().catch(e => { console.error(e); process.exit(1); });
