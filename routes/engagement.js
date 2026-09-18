/**
 * Customer Re-engagement API
 * Manage automated WhatsApp broadcasts for inactive customers.
 *
 * Routes:
 *   GET  /api/engagement/stats       — segment counts + run history + templates
 *   GET  /api/engagement/templates   — get message templates
 *   PUT  /api/engagement/templates   — update message templates (admin only)
 *   POST /api/engagement/run         — trigger broadcast in background (admin only)
 */

const express  = require('express');
const router   = express.Router();
const { spawn } = require('child_process');
const path     = require('path');
const { auth, requireRole } = require('../middleware/auth');
const supabase = require('../config/supabase');

const COOLDOWN_DAYS = 30;

const DEFAULT_TEMPLATES = {
  at_risk: `Hi {name}! 👋 It's been a while since your last Sathvam order. Your fresh cold-pressed oils are just a tap away!\n\n🛒 Shop now: https://sathvam.in\n\n_— Team Sathvam 🌿_`,
  lapsing: `Hi {name}! 🌿 We noticed you haven't visited us in over 2 months. We miss you! Come back to pure cold-pressed goodness.\n\n❤️ Order today: https://sathvam.in\n\n_— Team Sathvam_`,
  churned: `Hi {name}! 💛 It's been a long time! A fresh batch of cold-pressed oils was just made. We'd love to have you back.\n\n🏠 Visit us: https://sathvam.in\n\n_— Team Sathvam 🌿_`,
};

function daysSince(dateStr) {
  if (!dateStr) return 9999;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

// GET /api/engagement/stats
router.get('/stats', auth, async (req, res) => {
  try {
    const [tplRow, histRow, coolRow] = await Promise.all([
      supabase.from('settings').select('value').eq('key', 're_engagement_templates').single(),
      supabase.from('settings').select('value').eq('key', 're_engagement_runs').single(),
      supabase.from('settings').select('value').eq('key', 're_engagement_cooldowns').single(),
    ]);

    const templates  = { ...DEFAULT_TEMPLATES, ...(tplRow.data?.value || {}) };
    const runs       = Array.isArray(histRow.data?.value) ? histRow.data.value : [];
    const cooldowns  = coolRow.data?.value || {};

    // Count customers per segment using DB data
    const [wsRes, posRes] = await Promise.all([
      supabase.from('webstore_orders').select('customer, date, created_at').not('status', 'eq', 'cancelled'),
      supabase.from('sales').select('customer_phone, date').not('status', 'eq', 'cancelled'),
    ]);

    const custMap = new Map();
    const normPhone = p => {
      const d = (p || '').replace(/\D/g, '');
      if (d.length === 10) return '91' + d;
      if (d.length >= 11 && d.startsWith('91')) return d;
      return null;
    };

    (wsRes.data || []).forEach(o => {
      try {
        const c = typeof o.customer === 'string' ? JSON.parse(o.customer) : (o.customer || {});
        const ph = normPhone(c.phone);
        if (!ph) return;
        const date = o.date || (o.created_at || '').slice(0, 10);
        const ex = custMap.get(ph) || { lastOrder: null };
        if (date && (!ex.lastOrder || date > ex.lastOrder)) ex.lastOrder = date;
        custMap.set(ph, ex);
      } catch (_) {}
    });

    (posRes.data || []).forEach(s => {
      const ph = normPhone(s.customer_phone);
      if (!ph) return;
      const ex = custMap.get(ph) || { lastOrder: null };
      if (s.date && (!ex.lastOrder || s.date > ex.lastOrder)) ex.lastOrder = s.date;
      custMap.set(ph, ex);
    });

    const counts = { active: 0, at_risk: 0, lapsing: 0, churned: 0, total: custMap.size };
    for (const cust of custMap.values()) {
      const d = daysSince(cust.lastOrder);
      if (d <= 30)  counts.active++;
      else if (d <= 60) counts.at_risk++;
      else if (d <= 90) counts.lapsing++;
      else counts.churned++;
    }

    // Count customers still in cooldown
    const inCooldown = Object.values(cooldowns).filter(d => daysSince(d) < COOLDOWN_DAYS).length;

    res.json({ templates, runs, counts, inCooldown, cooldownDays: COOLDOWN_DAYS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/engagement/templates
router.get('/templates', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 're_engagement_templates').single();
    res.json({ ...DEFAULT_TEMPLATES, ...(data?.value || {}) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/engagement/templates
router.put('/templates', auth, requireRole('admin'), async (req, res) => {
  try {
    const { at_risk, lapsing, churned } = req.body;
    const value = {};
    if (at_risk) value.at_risk = at_risk;
    if (lapsing) value.lapsing = lapsing;
    if (churned) value.churned = churned;
    await supabase.from('settings').upsert({ key: 're_engagement_templates', value, updated_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/engagement/run  — spawn script in background, return immediately
router.post('/run', auth, requireRole('admin'), async (req, res) => {
  try {
    const { segment = 'all', dry_run = false } = req.body;
    const scriptPath = path.resolve(__dirname, '../scripts/re-engagement.js');
    const args = [];
    if (segment && segment !== 'all') args.push(`--segment=${segment}`);
    if (dry_run) args.push('--dry-run');

    const child = spawn(process.execPath, [scriptPath, ...args], {
      detached: true,
      stdio:    'ignore',
      env:      { ...process.env },
    });
    child.unref();

    res.json({
      ok: true,
      message: `Re-engagement broadcast started${dry_run ? ' (dry run)' : ''}`,
      segment,
      pid: child.pid,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /report — follow-up report for both re-engagement and review requests ──
router.get('/report', auth, async (req, res) => {
  try {
    const { from, to, type, page } = req.query;
    const pageSize = 50;
    const pageNum  = Math.max(1, parseInt(page) || 1);
    const offset   = (pageNum - 1) * pageSize;

    let fromDate = from || null;
    let toDate   = to   || null;
    if (!fromDate) { const d = new Date(); d.setDate(d.getDate() - 30); fromDate = d.toISOString().slice(0, 10); }
    if (!toDate)   toDate = new Date().toISOString().slice(0, 10);
    const startTs = fromDate + 'T00:00:00.000Z';
    const endTs   = toDate + 'T23:59:59.999Z';

    // Filter by type if specified
    let query = supabase.from('customer_followup_log')
      .select('type, phone, name, segment, order_no, days_since, status, ai_personalized, sent_at, run_id')
      .gte('sent_at', startTs).lte('sent_at', endTs);
    if (type && (type === 're_engagement' || type === 'review_request')) query = query.eq('type', type);

    const { data: allRows, error: allErr } = await query;
    if (allErr) throw new Error(allErr.message || JSON.stringify(allErr));
    const rows = allRows || [];

    // KPIs
    const reRows = rows.filter(r => r.type === 're_engagement');
    const revRows = rows.filter(r => r.type === 'review_request');

    const reSent     = reRows.filter(r => r.status === 'sent').length;
    const reFailed   = reRows.filter(r => r.status === 'failed').length;
    const reAI       = reRows.filter(r => r.ai_personalized).length;
    const reAtRisk   = reRows.filter(r => r.segment === 'at_risk' && r.status === 'sent').length;
    const reLapsing  = reRows.filter(r => r.segment === 'lapsing' && r.status === 'sent').length;
    const reChurned  = reRows.filter(r => r.segment === 'churned' && r.status === 'sent').length;
    const reUniquePhones = new Set(reRows.filter(r => r.status === 'sent').map(r => r.phone)).size;
    const reRuns     = new Set(reRows.map(r => r.run_id).filter(Boolean)).size;

    const revSent    = revRows.filter(r => r.status === 'sent').length;
    const revFailed  = revRows.filter(r => r.status === 'failed').length;
    const revUniquePhones = new Set(revRows.filter(r => r.status === 'sent').map(r => r.phone)).size;
    const revRuns    = new Set(revRows.map(r => r.run_id).filter(Boolean)).size;

    // Daily breakdown
    const dailyMap = {};
    for (const r of rows) {
      const day = String(r.sent_at).slice(0, 10);
      if (!dailyMap[day]) dailyMap[day] = { date: day, re_sent: 0, re_failed: 0, rev_sent: 0, rev_failed: 0, total: 0 };
      dailyMap[day].total++;
      if (r.type === 're_engagement') { r.status === 'sent' ? dailyMap[day].re_sent++ : dailyMap[day].re_failed++; }
      if (r.type === 'review_request') { r.status === 'sent' ? dailyMap[day].rev_sent++ : dailyMap[day].rev_failed++; }
    }
    const daily = Object.values(dailyMap).sort((a, b) => b.date.localeCompare(a.date));

    // Paginated detail list
    let detailQuery = supabase.from('customer_followup_log')
      .select('*').gte('sent_at', startTs).lte('sent_at', endTs)
      .order('sent_at', { ascending: false }).range(offset, offset + pageSize - 1);
    if (type && (type === 're_engagement' || type === 'review_request')) detailQuery = detailQuery.eq('type', type);

    const { data: detailRows, error: detErr } = await detailQuery;
    if (detErr) throw new Error(detErr.message || JSON.stringify(detErr));

    res.json({
      kpi: {
        re_engagement: { sent: reSent, failed: reFailed, ai_personalized: reAI, unique_customers: reUniquePhones, runs: reRuns, at_risk: reAtRisk, lapsing: reLapsing, churned: reChurned },
        review_request: { sent: revSent, failed: revFailed, unique_customers: revUniquePhones, runs: revRuns },
        total_sent: reSent + revSent,
        total_failed: reFailed + revFailed,
      },
      daily,
      sessions: detailRows || [],
      page: pageNum,
      page_size: pageSize,
      from: fromDate,
      to: toDate,
    });
  } catch (e) {
    console.error('[engagement] GET /report', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
