/**
 * Customer Delight API
 * Unified hub for all post-purchase and loyalty automation.
 *
 * GET  /api/customer-delight/stats          — status of all automations
 * POST /api/customer-delight/batch-notify   — "Oil pressed today" broadcast
 * POST /api/customer-delight/followup/run   — manual trigger day-7 followup
 * POST /api/customer-delight/birthday/run   — manual trigger birthday wishes
 */

const express  = require('express');
const router   = express.Router();
const { spawn } = require('child_process');
const path     = require('path');
const { auth, requireRole } = require('../middleware/auth');
const supabase = require('../config/supabase');
const { sendText, sendFile } = require('../lib/greenapi');
const { decryptCustomer }    = require('../config/crypto');

const SEND_DELAY_MS  = 2000;
const BATCH_SIZE     = 10;
const BATCH_PAUSE_MS = 30000;
const sleep          = ms => new Promise(r => setTimeout(r, ms));

function normPhone(p) {
  const d = (p || '').replace(/\D/g, '');
  if (d.length === 10) return '91' + d;
  if (d.length >= 11 && d.startsWith('91')) return d;
  return null;
}

// GET /api/customer-delight/stats
router.get('/stats', auth, async (req, res) => {
  try {
    const keys = ['delivery_followup_sent', 'birthday_wish_sent', 'flash_offer_runs', 're_engagement_runs'];
    const rows = await Promise.all(keys.map(k =>
      supabase.from('settings').select('key,value,updated_at').eq('key', k).single()
    ));
    const data = {};
    rows.forEach(({ data: d }) => { if (d) data[d.key] = { value: d.value, updated_at: d.updated_at }; });

    // Compute summary stats
    const followupCount  = Object.keys(data['delivery_followup_sent']?.value || {}).length;
    const birthdayCount  = Object.keys(data['birthday_wish_sent']?.value || {}).length;
    const flashRuns      = Array.isArray(data['flash_offer_runs']?.value) ? data['flash_offer_runs'].value : [];
    const reengRuns      = Array.isArray(data['re_engagement_runs']?.value) ? data['re_engagement_runs'].value : [];

    res.json({
      delivery_followup: { total_sent: followupCount, last_updated: data['delivery_followup_sent']?.updated_at },
      birthday_wish:     { total_sent: birthdayCount, last_updated: data['birthday_wish_sent']?.updated_at },
      flash_offer:       { runs: flashRuns.slice(0, 5), last_run: flashRuns[0]?.date },
      re_engagement:     { runs: reengRuns.slice(0, 5), last_run: reengRuns[0]?.date },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/customer-delight/batch-notify  — "Oil pressed today" WhatsApp blast
router.post('/batch-notify', auth, requireRole('admin'), async (req, res) => {
  try {
    const { oilType, outputLiters, batchDate, imageUrl, customMessage } = req.body;

    const defaultMsg =
      `🏭 *Fresh ${oilType || 'Cold-Pressed'} Oil — Just Pressed Today!*\n\n` +
      `We just finished a fresh batch at our factory 🌿\n\n` +
      (outputLiters ? `🫙 Output: ${outputLiters}L — limited stock!\n` : '') +
      (batchDate    ? `📅 Pressed on: ${batchDate}\n` : '') +
      `\nPure | Chemical-free | Straight from our wood press to your kitchen 🍳\n\n` +
      `🛒 Order now: https://sathvam.in\n\n` +
      `_— Team Sathvam_`;

    const message = customMessage || defaultMsg;

    // Fetch all customers with phone numbers
    const { data: wsOrders } = await supabase
      .from('webstore_orders')
      .select('customer')
      .not('status', 'eq', 'cancelled');

    const phones = new Map(); // phone → name
    (wsOrders || []).forEach(o => {
      try {
        const c = typeof o.customer === 'string' ? JSON.parse(o.customer) : (o.customer || {});
        const dec   = decryptCustomer(c);
        const phone = normPhone(dec.phone);
        if (phone && !phones.has(phone)) phones.set(phone, dec.name || '');
      } catch (_) {}
    });

    const list = Array.from(phones.entries()); // [[phone, name], ...]

    // Send in background
    res.json({ ok: true, message: `Broadcasting to ${list.length} customers…`, total: list.length });

    // Fire-and-forget batch send
    (async () => {
      let sent = 0, failed = 0;
      for (let i = 0; i < list.length; i++) {
        const [phone, name] = list[i];
        if (i > 0 && i % BATCH_SIZE === 0) await sleep(BATCH_PAUSE_MS);
        try {
          let ok;
          if (imageUrl) {
            ok = await sendFile(phone, imageUrl, 'sathvam-batch.jpg', message);
          } else {
            ok = await sendText(phone, message);
          }
          ok ? sent++ : failed++;
          await sleep(SEND_DELAY_MS);
        } catch (_) { failed++; }
      }
      // Log result
      const { data: histRow } = await supabase.from('settings').select('value').eq('key', 'batch_notify_runs').single();
      const history = Array.isArray(histRow?.value) ? histRow.value : [];
      history.unshift({ date: new Date().toISOString().slice(0, 10), oilType, sent, failed, total: list.length });
      if (history.length > 20) history.splice(20);
      await supabase.from('settings').upsert({ key: 'batch_notify_runs', value: history, updated_at: new Date().toISOString() });
      console.log(`[batch-notify] Done — ${sent} sent, ${failed} failed`);
    })();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/customer-delight/followup/run  — manual trigger
router.post('/followup/run', auth, requireRole('admin'), async (req, res) => {
  try {
    const { dry_run = false } = req.body;
    const scriptPath = path.resolve(__dirname, '../scripts/delivery-followup.js');
    const args = dry_run ? ['--dry-run'] : [];
    const child = spawn(process.execPath, [scriptPath, ...args], {
      detached: true, stdio: 'ignore', env: { ...process.env },
    });
    child.unref();
    res.json({ ok: true, message: `Delivery follow-up started${dry_run ? ' (dry run)' : ''}`, pid: child.pid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/customer-delight/birthday/run  — manual trigger
router.post('/birthday/run', auth, requireRole('admin'), async (req, res) => {
  try {
    const { dry_run = false } = req.body;
    const scriptPath = path.resolve(__dirname, '../scripts/birthday-wish.js');
    const args = dry_run ? ['--dry-run'] : [];
    const child = spawn(process.execPath, [scriptPath, ...args], {
      detached: true, stdio: 'ignore', env: { ...process.env },
    });
    child.unref();
    res.json({ ok: true, message: `Birthday wish script started${dry_run ? ' (dry run)' : ''}`, pid: child.pid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/customer-delight/batch-notify/runs
router.get('/batch-notify/runs', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'batch_notify_runs').single();
    res.json(Array.isArray(data?.value) ? data.value : []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
