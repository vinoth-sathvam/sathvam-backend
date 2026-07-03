#!/usr/bin/env node
/**
 * Birthday Wish WhatsApp
 * Sends a happy birthday message + 15% discount to customers born today.
 * Requires date_of_birth column in customers table (migrate_031_customer_dob.sql).
 *
 * Run via systemd timer: sathvam-birthday-wish.timer (daily 9 AM IST)
 * Or manually: node scripts/birthday-wish.js [--dry-run]
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient }    = require('@supabase/supabase-js');
const { sendText, isAutomationDisabled } = require('../lib/greenapi');
const { decryptCustomer } = require('../config/crypto');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const BIRTHDAY_COUPON = 'BDAY15';  // 15% off — set this up in your coupon system
const SEND_DELAY_MS   = 2000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function normPhone(p) {
  const d = (p || '').replace(/\D/g, '');
  if (d.length === 10) return '91' + d;
  if (d.length >= 11 && d.startsWith('91')) return d;
  return null;
}

const MESSAGES = [
  (name, code) =>
    `🎂 Happy Birthday, ${name}! 🎉\n\n` +
    `Wishing you a wonderful day filled with joy and good health!\n\n` +
    `Here's a special birthday gift from Sathvam — *15% OFF* your next order!\n\n` +
    `🏷 Code: *${code}*\n` +
    `📅 Valid for 3 days\n` +
    `🛒 https://sathvam.in\n\n` +
    `_— Team Sathvam 🌿_`,

  (name, code) =>
    `🌟 Many happy returns of the day, ${name}! 🎂\n\n` +
    `On your special day, we want to celebrate you with a *15% birthday discount*!\n\n` +
    `🎁 Code: *${code}* (valid 3 days)\n` +
    `💚 Pure cold-pressed oils, delivered with love\n\n` +
    `🛒 https://sathvam.in\n\n` +
    `— Team Sathvam`,

  (name, code) =>
    `🎉 Happy Birthday ${name}! 🌿\n\n` +
    `May your year be as pure and good as our cold-pressed oils! 😄\n\n` +
    `🎁 Birthday gift: *15% OFF* — Code *${code}*\n` +
    `⏰ Use within 3 days\n` +
    `🛒 https://sathvam.in\n\n` +
    `_With love, Team Sathvam_`,
];

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

async function run() {
  if (await isAutomationDisabled('birthday_greeting')) { console.log('[birthday-wish] Disabled via toggle'); return; }
  const args   = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  // IST date: UTC + 5:30
  const now    = new Date();
  const istMs  = now.getTime() + (5.5 * 60 * 60 * 1000);
  const istNow = new Date(istMs);
  const month  = istNow.getUTCMonth() + 1; // 1-12
  const day    = istNow.getUTCDate();

  console.log(`[birthday-wish] Checking birthdays for month=${month} day=${day}${dryRun ? ' (DRY RUN)' : ''}`);

  // Fetch customers with DOB matching today (month + day, any year)
  // date_of_birth stored as plain DATE — use Postgres EXTRACT
  const { data: customers, error } = await supabase
    .from('customers')
    .select('id, name, phone, date_of_birth')
    .not('date_of_birth', 'is', null)
    .not('phone', 'is', null);

  if (error) { console.error('DB error:', error.message); process.exit(1); }

  // Filter in JS since Supabase JS client doesn't expose EXTRACT easily
  const birthdays = (customers || []).filter(c => {
    if (!c.date_of_birth) return false;
    const d = new Date(c.date_of_birth);
    return (d.getUTCMonth() + 1) === month && d.getUTCDate() === day;
  });

  console.log(`[birthday-wish] ${birthdays.length} birthday(s) today`);

  // Load sent log to avoid duplicate sends
  const { data: logRow } = await supabase.from('settings').select('value').eq('key', 'birthday_wish_sent').single();
  const sentLog = logRow?.value || {}; // { customerId_YYYY: date }
  const year    = istNow.getUTCFullYear();

  for (let i = 0; i < birthdays.length; i++) {
    const c   = birthdays[i];
    const key = `${c.id}_${year}`;
    if (sentLog[key]) { console.log(`[SKIP] ${c.id} — already wished this year`); continue; }

    const dec   = decryptCustomer(c);
    const phone = normPhone(dec.phone);
    if (!phone) { console.log(`[SKIP] ${c.id} — no phone`); continue; }

    const name    = (dec.name || '').split(' ')[0] || 'there';
    const message = pick(MESSAGES)(name, BIRTHDAY_COUPON);

    if (dryRun) {
      console.log(`[DRY RUN] → ${phone} (${dec.name}): ${message.slice(0, 60)}…`);
      continue;
    }

    try {
      const ok = await sendText(phone, message);
      console.log(`[${ok ? 'SENT' : 'FAIL'}] ${dec.name} → ${phone}`);
      if (ok) sentLog[key] = new Date().toISOString().slice(0, 10);
      await sleep(SEND_DELAY_MS);
    } catch (e) {
      console.error(`[ERROR] ${dec.name}:`, e.message);
    }
  }

  if (!dryRun) {
    await supabase.from('settings').upsert({ key: 'birthday_wish_sent', value: sentLog, updated_at: new Date().toISOString() });
  }

  console.log('[birthday-wish] Done');
}

run().catch(e => { console.error(e); process.exit(1); });
