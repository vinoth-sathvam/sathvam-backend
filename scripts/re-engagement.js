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
const supabase = require('../config/supabase');
const { sendText, isAutomationDisabled } = require('../lib/greenapi');
const { decrypt } = require('../config/crypto');
const Anthropic = process.env.ANTHROPIC_API_KEY ? require('@anthropic-ai/sdk') : null;

const COOLDOWN_DAYS  = 30;    // don't re-message same customer within 30 days
const DRIP_MODE      = true;  // send 1 message per run, exit — timer fires every 10 min
const SEND_DELAY_MS  = 2000;  // (legacy, unused in drip mode)
const BATCH_SIZE     = 10;    // (legacy, unused in drip mode)
const BATCH_PAUSE_MS = 30000; // (legacy, unused in drip mode)

const DEFAULT_TEMPLATES = {
  at_risk: `Hi {name}! 👋 It's been a while since your last Sathvam order. Your fresh cold-pressed oils are just a tap away!\n\n🛒 Shop now: https://sathvam.in\n\n_— Team Sathvam 🌿_`,
  lapsing: `Hi {name}! 🌿 We noticed you haven't visited us in over 2 months. We miss you! Come back to pure cold-pressed goodness.\n\n❤️ Order today: https://sathvam.in\n\n_— Team Sathvam_`,
  churned: `Hi {name}! 💛 It's been a long time! A fresh batch of cold-pressed oils was just made. We'd love to have you back.\n\n🏠 Visit us: https://sathvam.in\n\n_— Team Sathvam 🌿_`,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// AI-powered personalized re-engagement message
let _productsCache = null;
async function getAIReengagementMessage(cust) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try {
    const firstName = (cust.name || '').split(' ')[0] || 'there';
    // Load products once
    if (!_productsCache) {
      const { data } = await supabase.from('products').select('name,website_price,cat').eq('active', true).limit(20);
      _productsCache = (data || []).map(p => `${p.name} (₹${p.website_price || 0})`).join(', ');
    }

    const segDescs = {
      at_risk: `hasn't ordered in ${cust.daysSince} days (31-60 day gap). Gentle nudge needed.`,
      lapsing: `hasn't ordered in ${cust.daysSince} days (60-90 day gap). Getting cold — warmer message.`,
      churned: `hasn't ordered in ${cust.daysSince} days (90+ days). Win-back with something exciting.`,
    };

    const client = new Anthropic();
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 250,
      messages: [{
        role: 'user',
        content: `Write a WhatsApp re-engagement message for ${firstName} from Sathvam cold-pressed oils.
Context: Customer ${segDescs[cust.segment] || segDescs.at_risk}
Available products: ${_productsCache}
Mention 1-2 products they might like. Keep under 400 chars. Warm, personal tone.
End with shop link: https://sathvam.in. Sign: — Team Sathvam 🌿
No markdown bold/italic. Output ONLY the message.`,
      }],
    });
    return msg.content?.[0]?.text?.trim() || null;
  } catch (e) {
    console.error('[re-engagement] AI message failed:', e.message);
    return null;
  }
}

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
      const phone = decrypt(c.phone) || c.phone;
      const name  = decrypt(c.name)  || c.name;
      merge(phone, name, o.date || (o.created_at || '').slice(0, 10));
    } catch (_) {}
  });

  // POS sales
  const { data: posSales, error: posErr } = await supabase
    .from('sales')
    .select('customer_name, customer_phone, date')
    .not('status', 'eq', 'cancelled');
  if (posErr) console.error('[re-engagement] sales error:', posErr.message);

  (posSales || []).forEach(s => merge(s.customer_phone, s.customer_name, s.date));

  // Registered customers (includes users who signed up but never ordered)
  const { data: regCusts, error: regErr } = await supabase
    .from('customers')
    .select('name, phone, email, created_at');
  if (regErr) console.error('[re-engagement] customers error:', regErr.message);

  (regCusts || []).forEach(c => {
    const phone = decrypt(c.phone) || c.phone;
    const name  = decrypt(c.name)  || c.name;
    // Only merge if they have a phone number and aren't already in the map
    // Use created_at as a fallback "date" so they appear as churned/lapsing based on signup age
    if (phone) {
      const p = normPhone(phone);
      if (p && !custMap.has(p)) {
        // Not in map = never ordered → use null lastOrder so they get segment "churned"
        custMap.set(p, { name: name || '', phone: p, lastOrder: null });
      }
    }
  });

  console.log(`[re-engagement] ${custMap.size} total customers in map`);

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
  const runId = `re_${Date.now()}`;

  // IST business hours check (9 AM – 9 PM IST)
  const istHour = new Date(Date.now() + 5.5 * 3600000).getUTCHours();
  if (istHour < 9 || istHour >= 21) {
    console.log(`[re-engagement] Outside business hours (IST ${istHour}:00) — skipping`);
    return { date: today, segments: targetSegs, total: toSend.length, sent: 0, failed: 0, dryRun, skipped_hours: true };
  }

  if (DRIP_MODE && !dryRun) {
    // ── DRIP: send exactly 1 message, then exit ──
    // Timer fires every 20 min → ~48 messages/day during 9AM-9PM IST
    const cust = toSend[0];
    if (!cust) { console.log('[re-engagement] No customers to message'); return { date: today, segments: targetSegs, total: 0, sent: 0, failed: 0, dryRun }; }

    console.log(`[re-engagement] Drip: 1 of ${toSend.length} → ${cust.phone} (${cust.name}) [${cust.segment}]`);

    const firstName = (cust.name || '').split(' ')[0] || 'there';
    const tpl       = templates[cust.segment] || DEFAULT_TEMPLATES.at_risk;
    const staticMsg = tpl.replace(/\{name\}/gi, firstName);
    const aiMsg     = await getAIReengagementMessage({ ...cust, name: firstName });
    const message   = aiMsg || staticMsg;

    try {
      const ok = await sendText(cust.phone, message);
      console.log(`[${ok ? 'SENT' : 'FAIL'}] ${cust.phone} (${cust.name}) [${cust.segment}]`);
      results.push({ phone: cust.phone, name: cust.name, segment: cust.segment, status: ok ? 'sent' : 'failed' });

      if (ok) {
        cooldowns[cust.phone] = today;
        try {
          await supabase.from('whatsapp_messages').insert({
            phone: cust.phone, contact_name: cust.name,
            direction: 'outbound', type: 'text', content: message,
            status: 'sent', sent_by: 're-engagement',
            timestamp: new Date().toISOString(),
          });
        } catch (_) {}
      }

      try {
        await supabase.from('customer_followup_log').insert({
          type: 're_engagement', phone: cust.phone, name: cust.name,
          segment: cust.segment, days_since: cust.daysSince,
          status: ok ? 'sent' : 'failed', ai_personalized: !!aiMsg,
          run_id: runId,
        });
      } catch (e2) { console.error('[followup_log]', e2.message); }
    } catch (e) {
      console.error(`[ERROR] ${cust.phone}:`, e.message);
      results.push({ phone: cust.phone, name: cust.name, segment: cust.segment, status: 'error', error: e.message });
      try {
        await supabase.from('customer_followup_log').insert({
          type: 're_engagement', phone: cust.phone, name: cust.name,
          segment: cust.segment, days_since: cust.daysSince,
          status: 'failed', run_id: runId,
        });
      } catch (_) {}
    }

  } else {
    // ── BULK or DRY RUN: send all at once ──
    console.log(`[re-engagement] ${toSend.length} customer(s) — ${BATCH_SIZE}/batch`);

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
      const staticMsg = tpl.replace(/\{name\}/gi, firstName);
      const aiMsg     = await getAIReengagementMessage({ ...cust, name: firstName });
      const message   = aiMsg || staticMsg;

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
          try {
            await supabase.from('whatsapp_messages').insert({
              phone: cust.phone, contact_name: cust.name,
              direction: 'outbound', type: 'text', content: message,
              status: 'sent', sent_by: 're-engagement',
              timestamp: new Date().toISOString(),
            });
          } catch (_) {}
        }

        try {
          await supabase.from('customer_followup_log').insert({
            type: 're_engagement', phone: cust.phone, name: cust.name,
            segment: cust.segment, days_since: cust.daysSince,
            status: ok ? 'sent' : 'failed', ai_personalized: !!aiMsg,
            run_id: runId,
          });
        } catch (e2) { console.error('[followup_log]', e2.message); }

        await sleep(SEND_DELAY_MS);
      } catch (e) {
        console.error(`[ERROR] ${cust.phone}:`, e.message);
        results.push({ phone: cust.phone, name: cust.name, segment: cust.segment, status: 'error', error: e.message });
        try {
          await supabase.from('customer_followup_log').insert({
            type: 're_engagement', phone: cust.phone, name: cust.name,
            segment: cust.segment, days_since: cust.daysSince,
            status: 'failed', run_id: runId,
          });
        } catch (_) {}
      }
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

run().then(() => process.exit(0)).catch(e => { console.error('[re-engagement] Fatal error:', e); process.exit(1); });
