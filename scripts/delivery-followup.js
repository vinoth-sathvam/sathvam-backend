#!/usr/bin/env node
/**
 * Day-7 Delivery Follow-up
 * Sends a WhatsApp check-in + Google Review request to customers
 * whose orders were delivered exactly 7 days ago.
 *
 * Run via systemd timer: sathvam-delivery-followup.timer (daily 11 AM IST)
 * Or manually: node scripts/delivery-followup.js [--dry-run]
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient }    = require('@supabase/supabase-js');
const { sendText }        = require('../lib/greenapi');
const { decryptCustomer } = require('../config/crypto');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const GOOGLE_REVIEW_URL = process.env.GOOGLE_REVIEW_URL || 'https://g.page/r/sathvam/review';
const SEND_DELAY_MS     = 2000;
const BATCH_SIZE        = 10;
const BATCH_PAUSE_MS    = 30000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function normPhone(p) {
  const d = (p || '').replace(/\D/g, '');
  if (d.length === 10) return '91' + d;
  if (d.length >= 11 && d.startsWith('91')) return d;
  return null;
}

function buildMessage(name) {
  const first = (name || '').split(' ')[0] || 'there';
  return (
    `🌿 Hi ${first}! Hope you're loving your Sathvam cold-pressed oils!\n\n` +
    `It's been a week since your order arrived. How's the experience? 😊\n\n` +
    `Your honest review means a lot — it helps other families discover pure, natural oils.\n\n` +
    `⭐ Leave a Google Review (takes 1 min):\n${GOOGLE_REVIEW_URL}\n\n` +
    `Any questions or feedback? Just reply here — we're always happy to help! 🙏\n\n` +
    `_— Team Sathvam_`
  );
}

async function run() {
  const args   = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const today  = new Date();
  const target = new Date(today - 7 * 86400000).toISOString().slice(0, 10);

  console.log(`[delivery-followup] Checking delivered_date = ${target}${dryRun ? ' (DRY RUN)' : ''}`);

  // Load already-sent log to avoid duplicates
  const { data: logRow } = await supabase.from('settings').select('value').eq('key', 'delivery_followup_sent').single();
  const sentLog = logRow?.value || {}; // { orderId: date }

  // Find orders delivered 7 days ago
  const { data: orders, error } = await supabase
    .from('webstore_orders')
    .select('id, order_no, customer, delivered_date, items')
    .eq('delivered_date', target)
    .eq('status', 'delivered');

  if (error) { console.error('DB error:', error.message); process.exit(1); }
  if (!orders?.length) { console.log('No orders delivered 7 days ago.'); return; }

  console.log(`[delivery-followup] ${orders.length} order(s) found`);

  const toSend = [];
  for (const o of orders) {
    if (sentLog[o.id]) { console.log(`[SKIP] ${o.order_no} — already sent`); continue; }
    const cust  = decryptCustomer(typeof o.customer === 'string' ? JSON.parse(o.customer) : (o.customer || {}));
    const phone = normPhone(cust.phone);
    if (!phone) { console.log(`[SKIP] ${o.order_no} — no phone`); continue; }
    toSend.push({ orderId: o.id, orderNo: o.order_no, phone, name: cust.name });
  }

  console.log(`[delivery-followup] ${toSend.length} to message`);

  for (let i = 0; i < toSend.length; i++) {
    const t = toSend[i];
    if (i > 0 && i % BATCH_SIZE === 0) {
      console.log(`[delivery-followup] Batch pause ${BATCH_PAUSE_MS / 1000}s…`);
      await sleep(BATCH_PAUSE_MS);
    }

    const message = buildMessage(t.name);

    if (dryRun) {
      console.log(`[DRY RUN] → ${t.phone} (${t.name}) ${t.orderNo}`);
      continue;
    }

    try {
      const ok = await sendText(t.phone, message);
      console.log(`[${ok ? 'SENT' : 'FAIL'}] ${t.orderNo} → ${t.phone}`);
      if (ok) sentLog[t.orderId] = new Date().toISOString().slice(0, 10);
      await sleep(SEND_DELAY_MS);
    } catch (e) {
      console.error(`[ERROR] ${t.orderNo}:`, e.message);
    }
  }

  if (!dryRun && Object.keys(sentLog).length) {
    await supabase.from('settings').upsert({ key: 'delivery_followup_sent', value: sentLog, updated_at: new Date().toISOString() });
  }

  console.log('[delivery-followup] Done');
}

run().catch(e => { console.error(e); process.exit(1); });
