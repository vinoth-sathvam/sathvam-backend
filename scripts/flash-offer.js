#!/usr/bin/env node
/**
 * Flash Offer WhatsApp Broadcast
 * Sends a 10% discount offer to customers during two daily windows:
 *   - Evening: 4–5 PM IST  (systemd fires at 10:30 UTC + random 0–60 min)
 *   - Night:   9–11 PM IST (systemd fires at 15:30 UTC + random 0–120 min)
 *
 * Rules:
 *   - Same customer gets at most 1 flash offer per 7 days (cooldown)
 *   - If offer already sent today by the other window, skip entirely
 *   - Message is chosen randomly from a pool to stay fresh
 *
 * Usage:
 *   node scripts/flash-offer.js              # auto-detect window from current IST hour
 *   node scripts/flash-offer.js --window=eve # force evening pool
 *   node scripts/flash-offer.js --window=night
 *   node scripts/flash-offer.js --dry-run    # preview only
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { sendText }     = require('../lib/greenapi');
const { decryptCustomer } = require('../config/crypto');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const COOLDOWN_DAYS = 7;   // min days between flash offers to same customer
const DAILY_LIMIT   = 10;  // max customers per run (random pick)
const SEND_DELAY_MS  = 5000;  // delay between individual messages
const BATCH_SIZE     = 10;    // messages per batch
const BATCH_PAUSE_MS = 30000; // 30s pause between batches
const COUPON_CODE   = 'FLASH10';

// ── Message pools ─────────────────────────────────────────────────────────────

const EVE_MESSAGES = [
  `☀️ Hi {name}! *4 PM Flash Offer* from Sathvam 🌿\n\nGet *10% OFF* your next order of pure cold-pressed oils!\n\n🏷 Use code: *${COUPON_CODE}*\n🕐 Valid today only\n🛒 Shop now: https://sathvam.in\n\n_— Team Sathvam_`,

  `🥜 Good afternoon {name}! Your surprise is here —\n\n*10% discount* on all Sathvam cold-pressed oils today!\n\n✅ Code: *${COUPON_CODE}*\n✅ Fresh batch just processed\n✅ Free delivery above ₹499\n\n👉 https://sathvam.in\n\n_— Team Sathvam 🌿_`,

  `🌿 Hi {name}! Evening special for you —\n\nStock up on pure cold-pressed oils at *10% OFF* today!\n\nGroundnut · Sesame · Coconut · Wood-pressed\n\n🏷 Coupon: *${COUPON_CODE}*\n🛒 https://sathvam.in\n\n_Valid till midnight tonight_ — Team Sathvam`,

  `✨ {name}, your 4 PM deal! 🌿\n\nSathvam Natural Oils — *10% Flash Discount*\n\nPure | Cold-pressed | Chemical-free\n\n💰 Use code *${COUPON_CODE}* at checkout\n📦 Orders placed today ship tomorrow\n\n👉 https://sathvam.in`,

  `🛒 Flash Sale alert, {name}!\n\n*10% OFF* on Sathvam cold-pressed oils — today only!\n\nWhy Sathvam?\n✅ Extracted without heat\n✅ No preservatives\n✅ Straight from our factory\n\nCode: *${COUPON_CODE}* · https://sathvam.in\n\n_— Team Sathvam 🌿_`,
];

const NIGHT_MESSAGES = [
  `🌙 Good evening {name}! Tonight's special from Sathvam —\n\n*10% OFF* your next order of cold-pressed oils!\n\n🏷 Code: *${COUPON_CODE}*\n⏰ Valid till midnight\n🛒 https://sathvam.in\n\n_— Team Sathvam 🌿_`,

  `⭐ Hi {name}! Your night deal is here —\n\n*10% discount* on pure cold-pressed oils from Sathvam.\n\nGroundnut | Sesame | Coconut | Wood-pressed\n\n💰 Use *${COUPON_CODE}* at checkout\n👉 https://sathvam.in\n\n_Valid tonight only — Team Sathvam_`,

  `🌿 Evening {name}! Thought you'd like this —\n\nSathvam Flash Offer: *10% OFF* everything!\n\nPure · Cold-pressed · From our factory to your kitchen 🍳\n\nCode: *${COUPON_CODE}* · https://sathvam.in\n\n_— Team Sathvam_`,

  `🔥 Night flash sale, {name}!\n\n*10% OFF* Sathvam cold-pressed oils — this offer expires at midnight!\n\n✅ No minimum order\n✅ Same-day dispatch for orders before 8 PM\n\nCode: *${COUPON_CODE}*\n🛒 https://sathvam.in`,

  `💛 Hi {name}! A small gift from Sathvam tonight —\n\n*10% off* on your next order of pure cold-pressed oils.\n\nYour health deserves the best 🌿\n\nUse *${COUPON_CODE}* at https://sathvam.in\n\n_Valid today only — Team Sathvam_`,
];

// ── Coupon auto-enable ────────────────────────────────────────────────────────

async function enableFlashCoupon() {
  // expires_at is a DATE column — new Date('YYYY-MM-DD') is parsed as midnight UTC.
  // Setting it to tomorrow's date means the coupon is valid until 5:30 AM IST next day,
  // which effectively covers "today only" in IST without being already-expired.
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const expiresAt = tomorrow.toISOString().slice(0, 10); // 'YYYY-MM-DD'

  const { data: existing } = await supabase
    .from('coupons').select('id').eq('code', COUPON_CODE).maybeSingle();

  if (existing) {
    await supabase.from('coupons')
      .update({ active: true, expires_at: expiresAt })
      .eq('code', COUPON_CODE);
    console.log(`[flash-offer] Coupon ${COUPON_CODE} activated — expires at ${expiresAt} (midnight IST)`);
  } else {
    await supabase.from('coupons').insert({
      code: COUPON_CODE, type: 'percent', value: 10,
      min_order: 0, max_uses: null, uses_count: 0,
      expires_at: expiresAt, description: 'Flash offer — auto-created', active: true,
    });
    console.log(`[flash-offer] Coupon ${COUPON_CODE} created and activated — expires at ${expiresAt} (midnight IST)`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep     = ms => new Promise(r => setTimeout(r, ms));
const pick      = arr => arr[Math.floor(Math.random() * arr.length)];
const daysSince = d => !d ? 9999 : Math.floor((Date.now() - new Date(d).getTime()) / 86400000);

function normPhone(p) {
  const d = (p || '').replace(/\D/g, '');
  if (d.length === 10) return '91' + d;
  if (d.length >= 11 && d.startsWith('91')) return d;
  return null;
}

function detectWindow() {
  // IST = UTC + 5:30
  const now = new Date();
  const istHour = (now.getUTCHours() + 5 + Math.floor((now.getUTCMinutes() + 30) / 60)) % 24;
  if (istHour >= 16 && istHour < 21) return 'eve';   // 4 PM – 9 PM → evening pool
  return 'night';                                      // 9 PM – 11 PM → night pool
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const args   = process.argv.slice(2);
  const winArg = (args.find(a => a.startsWith('--window=')) || '').replace('--window=', '');
  const dryRun = args.includes('--dry-run');
  const window = winArg || detectWindow();
  const pool   = window === 'eve' ? EVE_MESSAGES : NIGHT_MESSAGES;
  const today  = new Date().toISOString().slice(0, 10);

  console.log(`[flash-offer] Starting — window=${window}${dryRun ? ' DRY RUN' : ''} — ${today}`);

  // Load cooldown log + check if already sent today
  const { data: coolRow } = await supabase.from('settings').select('value').eq('key', 'flash_offer_cooldowns').single();
  const cooldowns = coolRow?.value || {};

  const { data: histRow } = await supabase.from('settings').select('value').eq('key', 'flash_offer_runs').single();
  const history = Array.isArray(histRow?.value) ? histRow.value : [];
  const sentToday = history.find(r => r.date === today && !r.dryRun);
  if (sentToday) {
    console.log(`[flash-offer] Already sent today (${sentToday.window} window, ${sentToday.sent} sent). Skipping.`);
    return;
  }

  // Load customers from webstore orders (ordered, real customers only)
  const { data: orders } = await supabase
    .from('webstore_orders')
    .select('customer, date, created_at, status')
    .not('status', 'eq', 'cancelled');

  // Also load registered customers for name/phone
  const { data: regCusts } = await supabase
    .from('customers')
    .select('name, phone, email')
    .not('phone', 'is', null);

  const custMap = new Map(); // phone → { name, phone, lastOrder }

  const upsert = (phone, name, date) => {
    const p = normPhone(phone);
    if (!p) return;
    const ex = custMap.get(p) || { name: '', phone: p, lastOrder: null };
    if (name && !ex.name) ex.name = name;
    if (date && (!ex.lastOrder || date > ex.lastOrder)) ex.lastOrder = date;
    custMap.set(p, ex);
  };

  (regCusts || []).forEach(c => {
    const dec = decryptCustomer(c);
    upsert(dec.phone, dec.name, null);
  });

  (orders || []).forEach(o => {
    try {
      const c = typeof o.customer === 'string' ? JSON.parse(o.customer) : (o.customer || {});
      const dec = decryptCustomer(c);
      const date = o.date || (o.created_at || '').slice(0, 10);
      upsert(dec.phone, dec.name, date);
    } catch (_) {}
  });

  // Filter: must have placed at least 1 order + cooldown check
  const toSend = [];
  for (const [phone, cust] of custMap) {
    if (!cust.lastOrder) continue; // never ordered — skip (re-engagement handles them)
    const lastFlash = cooldowns[phone];
    if (lastFlash && daysSince(lastFlash) < COOLDOWN_DAYS) continue; // in cooldown
    toSend.push(cust);
  }

  // Shuffle and cap at DAILY_LIMIT — cooldown prevents same customer appearing on consecutive days
  toSend.sort(() => Math.random() - 0.5);
  const selected = toSend.slice(0, DAILY_LIMIT);

  // Enable coupon before sending (real runs only)
  if (!dryRun) await enableFlashCoupon();

  console.log(`[flash-offer] ${toSend.length} eligible, picking ${selected.length} randomly`);

  const results = [];
  for (let i = 0; i < selected.length; i++) {
    const cust      = selected[i];
    const batchNum  = Math.floor(i / BATCH_SIZE) + 1;
    const posInBatch = i % BATCH_SIZE;

    // Pause between batches (not before the very first message)
    if (i > 0 && posInBatch === 0) {
      console.log(`[flash-offer] Batch ${batchNum} starting — pausing ${BATCH_PAUSE_MS/1000}s…`);
      await sleep(BATCH_PAUSE_MS);
    }

    const firstName = (cust.name || '').split(' ')[0] || 'there';
    const message   = pick(pool).replace(/\{name\}/gi, firstName);

    if (dryRun) {
      console.log(`[DRY RUN] → ${cust.phone} (${cust.name}): ${message.slice(0, 60)}…`);
      results.push({ phone: cust.phone, name: cust.name, status: 'dry_run' });
      continue;
    }

    try {
      const ok = await sendText(cust.phone, message);
      console.log(`[${ok ? 'SENT' : 'FAIL'}] [batch ${batchNum}] ${cust.phone} (${cust.name})`);
      results.push({ phone: cust.phone, name: cust.name, status: ok ? 'sent' : 'failed' });
      if (ok) cooldowns[cust.phone] = today;
      await sleep(SEND_DELAY_MS);
    } catch (e) {
      console.error(`[ERROR] ${cust.phone}:`, e.message);
      results.push({ phone: cust.phone, name: cust.name, status: 'error', error: e.message });
    }
  }

  const sent   = results.filter(r => r.status === 'sent').length;
  const failed = results.filter(r => r.status === 'failed' || r.status === 'error').length;
  console.log(`[flash-offer] Done — ${sent} sent, ${failed} failed`);

  if (!dryRun) {
    // Save cooldowns
    await supabase.from('settings').upsert({ key: 'flash_offer_cooldowns', value: cooldowns, updated_at: new Date().toISOString() });
    // Append run log
    history.unshift({ date: today, window, sent, failed, total: selected.length, dryRun: false });
    if (history.length > 60) history.splice(60);
    await supabase.from('settings').upsert({ key: 'flash_offer_runs', value: history, updated_at: new Date().toISOString() });
  }
}

run().catch(e => { console.error('[flash-offer] Fatal:', e); process.exit(1); });
