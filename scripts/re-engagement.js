#!/usr/bin/env node
/**
 * Re-engagement WhatsApp broadcast
 * Sends targeted messages to customers who haven't ordered recently.
 *
 * Usage:
 *   node scripts/re-engagement.js                  # all segments
 *   node scripts/re-engagement.js --segment=lapsing
 *   node scripts/re-engagement.js --dry-run        # preview only, no sends
 *
 * Run via systemd timer: sathvam-re-engagement.timer (weekly Monday 10 AM IST)
 * Or manually: node scripts/re-engagement.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { sendText, isAutomationDisabled } = require('../lib/greenapi');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const COOLDOWN_DAYS  = 30;    // don't re-message same customer within 30 days
const SEND_DELAY_MS  = 2000;  // delay between individual messages
const BATCH_SIZE     = 10;    // messages per batch
const BATCH_PAUSE_MS = 30000; // 30s pause between batches

const DEFAULT_TEMPLATES = {
  at_risk: `Hi {name}! 👋 It's been a while since your last Sathvam order. Your fresh cold-pressed oils are just a tap away!\n\n🛒 Shop now: https://sathvam.in\n\n_— Team Sathvam 🌿_`,
  lapsing: `Hi {name}! 🌿 We noticed you haven't visited us in over 2 months. We miss you! Come back to pure cold-pressed goodness.\n\n❤️ Order today: https://sathvam.in\n\n_— Team Sathvam_`,
  churned: `Hi {name}! 💛 It's been a long time! A fresh batch of cold-pressed oils was just made. We'd love to have you back.\n\n🏠 Visit us: https://sathvam.in\n\n_— Team Sathvam 🌿_`,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function daysSince(dateStr) {
  if (!dateStr) return 9999;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function getSegment(days) {
  if (days <= 30)  return 'active';
  if (days <= 60)  return 'at_risk';
  if (days <= 90)  return 'lapsing';
  return 'churned';
}

function normPhone(p) {
  const d = (p || '').replace(/\D/g, '');
  if (d.length === 10) return '91' + d;
  if (d.length >= 11 && d.startsWith('91')) return d;
  return null;
}

async function run() {
  if (await isAutomationDisabled('re_engagement')) { console.log('[re-engagement] Disabled via toggle'); return; }
  const args      = process.argv.slice(2);
  const segArg    = (args.find(a => a.startsWith('--segment=')) || '').replace('--segment=', '');
  const dryRun    = args.includes('--dry-run');
  const targetSegs = segArg ? [segArg] : ['at_risk', 'lapsing', 'churned'];

  console.log(`[re-engagement] Starting${dryRun ? ' (DRY RUN)' : ''} — segments: ${targetSegs.join(', ')}`);

  // Load templates
  const { data: tplRow } = await supabase.from('settings').select('value').eq('key', 're_engagement_templates').single();
  const templates = { ...DEFAULT_TEMPLATES, ...(tplRow?.value || {}) };

  // Load cooldown log: phone → ISO date of last send
  const { data: coolRow } = await supabase.from('settings').select('value').eq('key', 're_engagement_cooldowns').single();
  const cooldowns = coolRow?.value || {};

  // Build customer map: phone → { name, lastOrder }
  const custMap = new Map();

  const merge = (phone, name, date) => {
    const p = normPhone(phone);
    if (!p) return;
    const ex = custMap.get(p) || { name: '', phone: p, lastOrder: null };
    if (name && !ex.name) ex.name = name;
    if (date && (!ex.lastOrder || date > ex.lastOrder)) ex.lastOrder = date;
    custMap.set(p, ex);
  };

  // Webstore orders
  const { data: wsOrders, error: wsErr } = await supabase
    .from('webstore_orders')
    .select('customer, date, created_at')
    .not('status', 'eq', 'cancelled');
  if (wsErr) console.error('[re-engagement] wsOrders error:', wsErr.message);

  (wsOrders || []).forEach(o => {
    try {
      const c = typeof o.customer === 'string' ? JSON.parse(o.customer) : (o.customer || {});
      merge(c.phone, c.name, o.date || (o.created_at || '').slice(0, 10));
    } catch (_) {}
  });

  // POS sales
  const { data: posSales, error: posErr } = await supabase
    .from('sales')
    .select('customer_name, customer_phone, date')
    .not('status', 'eq', 'cancelled');
  if (posErr) console.error('[re-engagement] sales error:', posErr.message);

  (posSales || []).forEach(s => merge(s.customer_phone, s.customer_name, s.date));

  // Filter by target segment + cooldown
  const today = new Date().toISOString().slice(0, 10);
  const toSend = [];
  for (const [phone, cust] of custMap) {
    const days = daysSince(cust.lastOrder);
    const seg  = getSegment(days);
    if (!targetSegs.includes(seg)) continue;
    const lastSent = cooldowns[phone];
    if (lastSent && daysSince(lastSent) < COOLDOWN_DAYS) {
      console.log(`[SKIP cooldown] ${phone} — last sent ${lastSent}`);
      continue;
    }
    toSend.push({ ...cust, segment: seg, daysSince: days });
  }

  console.log(`[re-engagement] ${toSend.length} customer(s) to message`);

  const results = [];
  console.log(`[re-engagement] ${toSend.length} customer(s) — ${BATCH_SIZE}/batch, ${BATCH_PAUSE_MS/1000}s pause between batches`);

  for (let i = 0; i < toSend.length; i++) {
    const cust       = toSend[i];
    const batchNum   = Math.floor(i / BATCH_SIZE) + 1;
    const posInBatch = i % BATCH_SIZE;

    if (i > 0 && posInBatch === 0) {
      console.log(`[re-engagement] Batch ${batchNum} starting — pausing ${BATCH_PAUSE_MS/1000}s…`);
      await sleep(BATCH_PAUSE_MS);
    }

    const firstName = (cust.name || '').split(' ')[0] || 'there';
    const tpl       = templates[cust.segment] || DEFAULT_TEMPLATES.at_risk;
    const message   = tpl.replace(/\{name\}/gi, firstName);

    if (dryRun) {
      console.log(`[DRY RUN] → ${cust.phone} (${cust.name}) [${cust.segment}]`);
      results.push({ phone: cust.phone, name: cust.name, segment: cust.segment, status: 'dry_run' });
      continue;
    }

    try {
      const ok = await sendText(cust.phone, message);
      console.log(`[${ok ? 'SENT' : 'FAIL'}] [batch ${batchNum}] ${cust.phone} (${cust.name}) [${cust.segment}]`);
      results.push({ phone: cust.phone, name: cust.name, segment: cust.segment, status: ok ? 'sent' : 'failed' });

      if (ok) {
        cooldowns[cust.phone] = today;
        await supabase.from('whatsapp_messages').insert({
          phone: cust.phone, contact_name: cust.name,
          direction: 'outbound', type: 'text', content: message,
          status: 'sent', sent_by: 're-engagement',
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }

      await sleep(SEND_DELAY_MS);
    } catch (e) {
      console.error(`[ERROR] ${cust.phone}:`, e.message);
      results.push({ phone: cust.phone, name: cust.name, segment: cust.segment, status: 'error', error: e.message });
    }
  }

  // Persist updated cooldowns
  if (!dryRun && Object.keys(cooldowns).length > 0) {
    await supabase.from('settings').upsert({
      key: 're_engagement_cooldowns',
      value: cooldowns,
      updated_at: new Date().toISOString(),
    });
  }

  const sent   = results.filter(r => r.status === 'sent').length;
  const failed = results.filter(r => r.status === 'failed' || r.status === 'error').length;
  const runLog = { date: today, segments: targetSegs, total: toSend.length, sent, failed, dryRun };
  console.log(`[re-engagement] Done — ${sent} sent, ${failed} failed`);

  // Append to run history (keep last 30 runs)
  if (!dryRun) {
    const { data: histRow } = await supabase.from('settings').select('value').eq('key', 're_engagement_runs').single();
    const history = Array.isArray(histRow?.value) ? histRow.value : [];
    history.unshift(runLog);
    if (history.length > 30) history.splice(30);
    await supabase.from('settings').upsert({
      key: 're_engagement_runs',
      value: history,
      updated_at: new Date().toISOString(),
    });
  }

  return runLog;
}

run().catch(e => { console.error('[re-engagement] Fatal error:', e); process.exit(1); });
