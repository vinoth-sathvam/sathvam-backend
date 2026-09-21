/**
 * Checkout Recovery — auto-WhatsApp abandoned checkout sessions
 *
 * Public (store):
 *   POST /api/checkout-recovery/session         — record new checkout session
 *   PATCH /api/checkout-recovery/session/:id/complete — mark completed (order placed)
 *
 * Admin (auth required):
 *   GET  /api/checkout-recovery/sessions        — list active/recent sessions
 *   POST /api/checkout-recovery/sessions/:id/send-wa — manually send WA now
 *   POST /api/checkout-recovery/process         — trigger manual sweep (also runs via cron)
 *   GET  /api/checkout-recovery/config          — get config
 *   PUT  /api/checkout-recovery/config          — update config
 *
 * Sessions stored in Supabase settings table:
 *   key = 'checkout_sessions'   → JSON array of session objects
 *   key = 'checkout_recovery_config' → config object
 */

const express  = require('express');
const cron     = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const supabase = require('../config/supabase');
const { sendText, isAutomationDisabled } = require('../lib/greenapi');
const { auth }         = require('../middleware/auth');

const router  = express.Router();

const SESSIONS_KEY = 'checkout_sessions';
const CONFIG_KEY   = 'checkout_recovery_config';

// ── Helper: refresh session cart with current DB prices ─────────────────────
// Looks up the customer's saved cart in abandoned_carts (by phone → customer_id)
// and fetches current product prices from products table. Returns updated
// { cart, cart_total } or null if no fresh data found.
async function refreshCartFromDB(phone) {
  try {
    if (!phone) return null;
    // Normalize phone to 10-digit for matching
    const clean = String(phone).replace(/\D/g, '');
    const last10 = clean.length > 10 ? clean.slice(-10) : clean;

    // Find customer by phone
    const { data: customers } = await supabase
      .from('customers')
      .select('id, name')
      .like('phone', `%${last10}`)
      .limit(1);
    if (!customers?.length) return null;

    const custId = customers[0].id;
    const sessionId = 'cust_' + custId;

    // Fetch saved cart
    const { data: cartRow } = await supabase
      .from('abandoned_carts')
      .select('items')
      .eq('session_id', sessionId)
      .maybeSingle();
    if (!cartRow?.items?.length) return null;

    // Fetch current prices for all products in cart
    const productIds = cartRow.items.map(i => i.id).filter(Boolean);
    if (!productIds.length) return null;

    const { data: products } = await supabase
      .from('products')
      .select('id, website_price, price, offer_price, offer_ends_at, name')
      .in('id', productIds);
    if (!products?.length) return null;

    const priceMap = {};
    for (const p of products) priceMap[p.id] = p;

    // Recalculate with current prices
    let total = 0;
    const freshCart = cartRow.items.map(item => {
      const dbProd = priceMap[item.id];
      if (!dbProd) return item;
      let currentPrice = parseFloat(dbProd.website_price || dbProd.price || 0);
      if (dbProd.offer_price && dbProd.offer_ends_at) {
        const offerEnd = new Date(dbProd.offer_ends_at);
        if (offerEnd > new Date() && parseFloat(dbProd.offer_price) < currentPrice) {
          currentPrice = parseFloat(dbProd.offer_price);
        }
      }
      const qty = item.qty || 1;
      total += currentPrice * qty;
      return { ...item, name: dbProd.name || item.name, price: currentPrice };
    });

    return { cart: freshCart, cart_total: Math.round(total) };
  } catch (e) {
    console.error('[checkoutRecovery] refreshCartFromDB error:', e.message);
    return null;
  }
}
const SESSION_TTL  = 48 * 60 * 60 * 1000; // 48 hours

// ── Persistent log helper ────────────────────────────────────────────────────
// Upserts a session snapshot into checkout_recovery_log so data survives the 48h purge
async function logSession(s) {
  try {
    await supabase.from('checkout_recovery_log').upsert({
      session_id:   s.id,
      phone:        s.phone || '',
      name:         s.name  || '',
      email:        s.email || '',
      city:         s.city  || '',
      referrer:     s.referrer || '',
      cart_items:   Array.isArray(s.cart) ? s.cart.length : 0,
      cart_total:   Number(s.cart_total) || 0,
      is_returning: Boolean(s.is_returning),
      started_at:   s.started_at,
      wa_sent:      Boolean(s.wa_sent),
      wa_sent_at:   s.wa_sent_at || null,
      wa_ok:        s.wa_ok != null ? Boolean(s.wa_ok) : null,
      completed:    Boolean(s.completed),
      completed_at: s.completed_at || null,
    }, { onConflict: 'session_id' });
  } catch (e) {
    console.error('[checkoutRecovery] logSession error:', e.message);
  }
}

const DEFAULT_CONFIG = {
  auto_enabled:     true,
  delay_minutes:    5,
  message_template: `Hi {name}! 👋

We noticed you left *₹{cart_total}* worth of Sathvam products in your cart 🛒

Your cold-pressed oils are still waiting! Don't miss out.

👉 Complete your order: https://www.sathvam.in

Need help choosing? Just reply here — we're happy to assist! 🙏

_Team Sathvam_`,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loadSessions() {
  const { data } = await supabase
    .from('settings')
    .select('value')
    .eq('key', SESSIONS_KEY)
    .single();
  const sessions = Array.isArray(data?.value) ? data.value : [];
  // drop sessions older than TTL
  const cutoff = Date.now() - SESSION_TTL;
  return sessions.filter(s => new Date(s.started_at).getTime() > cutoff);
}

async function saveSessions(sessions) {
  await supabase.from('settings').upsert(
    { key: SESSIONS_KEY, value: sessions, updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  );
}

async function loadConfig() {
  const { data } = await supabase
    .from('settings')
    .select('value')
    .eq('key', CONFIG_KEY)
    .single();
  return { ...DEFAULT_CONFIG, ...(data?.value || {}) };
}

function buildMessage(template, session) {
  const cartSummary = Array.isArray(session.cart) && session.cart.length
    ? session.cart.map(i => `• ${i.name}${i.qty > 1 ? ` ×${i.qty}` : ''}`).join('\n')
    : '';
  return template
    .replace(/{name}/g,       session.name || 'there')
    .replace(/{cart_total}/g, session.cart_total ? Number(session.cart_total).toLocaleString('en-IN') : '0')
    .replace(/{cart_items}/g, cartSummary)
    .replace(/{city}/g,       session.city || '');
}

// ── Auto-sweep: send WA to abandoned sessions ─────────────────────────────────
async function processAbandoned(dryRun = false) {
  if (await isAutomationDisabled('checkout_recovery')) { console.log('[checkoutRecovery] Disabled via toggle'); return { sent: 0, skipped: 0 }; }
  const config   = await loadConfig();
  const sessions = await loadSessions();
  if (!config.auto_enabled && !dryRun) return { sent: 0, skipped: 0 };

  const now       = Date.now();
  const delayMs   = (config.delay_minutes || 5) * 60 * 1000;
  let   sent = 0, skipped = 0;

  for (const s of sessions) {
    if (s.completed || s.wa_sent || !s.phone) { skipped++; continue; }
    const age = now - new Date(s.started_at).getTime();
    if (age < delayMs) { skipped++; continue; }

    if (!dryRun) {
      // Refresh cart with current DB prices before sending
      const fresh = await refreshCartFromDB(s.phone);
      if (fresh) {
        s.cart       = fresh.cart;
        s.cart_total = fresh.cart_total;
      }
      const msg = buildMessage(config.message_template, s);
      const ok  = await sendText(s.phone, msg, { priority: true });
      s.wa_sent    = true;
      s.wa_sent_at = new Date().toISOString();
      s.wa_ok      = ok;
      sent++;
    } else {
      sent++; // count as "would send"
    }
  }

  if (!dryRun) {
    await saveSessions(sessions);
    // persist WA-sent sessions to log
    for (const s of sessions) { if (s.wa_sent) await logSession(s); }
  }
  return { sent, skipped };
}

// ── Cron: every 10 minutes (reduced from 2 min to avoid Green API spam) ──────
cron.schedule('*/10 * * * *', () => {
  processAbandoned().then(r => {
    if (r.sent > 0 || r.skipped > 0) console.log(`[checkoutRecovery cron] sent=${r.sent} skipped=${r.skipped}`);
  }).catch(e => console.error('[checkoutRecovery cron]', e.message));
});

// ── POST /session ─────────────────────────────────────────────────────────────
// Called by store when customer enters checkout
router.post('/session', async (req, res) => {
  const { phone, name, email, city, referrer, cart, cart_total, is_returning } = req.body;

  if (!phone) return res.status(400).json({ error: 'phone required' });

  try {
    const sessions = await loadSessions();

    // Remove any existing incomplete session for this phone (dedup)
    const filtered = sessions.filter(s => !(s.phone === phone && !s.completed));

    const session = {
      id:           uuidv4(),
      phone:        String(phone).replace(/\D/g, '').replace(/^0/, '91').replace(/^(?!91)(\d{10})$/, '91$1'),
      name:         name  || 'Customer',
      email:        email || '',
      city:         city  || '',
      referrer:     referrer || '',
      cart:         Array.isArray(cart) ? cart : [],
      cart_total:   Number(cart_total) || 0,
      is_returning: Boolean(is_returning),
      started_at:   new Date().toISOString(),
      completed:    false,
      wa_sent:      false,
      wa_sent_at:   null,
    };

    filtered.push(session);
    await saveSessions(filtered);
    await logSession(session);

    res.json({ ok: true, session_id: session.id });
  } catch (e) {
    console.error('[checkoutRecovery] POST /session', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /session/:id/complete ───────────────────────────────────────────────
// Called by store when payment succeeds
router.patch('/session/:id/complete', async (req, res) => {
  const { id } = req.params;
  try {
    const sessions = await loadSessions();
    const s = sessions.find(x => x.id === id);
    if (s) {
      s.completed    = true;
      s.completed_at = new Date().toISOString();
      await saveSessions(sessions);
      await logSession(s);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /sessions ─────────────────────────────────────────────────────────────
// Admin: list all active/recent sessions
router.get('/sessions', auth, async (req, res) => {
  try {
    const sessions = await loadSessions();
    // newest first
    sessions.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
    res.json(sessions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /sessions/:id/send-wa ────────────────────────────────────────────────
// Admin: manually send WA to a session
router.post('/sessions/:id/send-wa', auth, async (req, res) => {
  if (await isAutomationDisabled('checkout_recovery')) return res.status(403).json({ error: 'checkout_recovery automation is disabled' });
  const { id } = req.params;
  try {
    const [sessions, config] = await Promise.all([loadSessions(), loadConfig()]);
    const s = sessions.find(x => x.id === id);
    if (!s) return res.status(404).json({ error: 'session not found' });

    // Refresh cart with current DB prices before sending
    const fresh = await refreshCartFromDB(s.phone);
    if (fresh) {
      s.cart       = fresh.cart;
      s.cart_total = fresh.cart_total;
    }
    const msg = buildMessage(config.message_template, s);
    const ok  = await sendText(s.phone, msg);
    s.wa_sent    = true;
    s.wa_sent_at = new Date().toISOString();
    s.wa_ok      = ok;
    await saveSessions(sessions);
    await logSession(s);

    res.json({ ok, message_sent: msg });
  } catch (e) {
    console.error('[checkoutRecovery] POST /sessions/:id/send-wa', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /process ─────────────────────────────────────────────────────────────
// Admin: trigger manual sweep
router.post('/process', auth, async (req, res) => {
  try {
    const result = await processAbandoned(false);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /config ───────────────────────────────────────────────────────────────
router.get('/config', auth, async (req, res) => {
  try {
    const config = await loadConfig();
    res.json(config);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /config ───────────────────────────────────────────────────────────────
router.put('/config', auth, async (req, res) => {
  try {
    const current = await loadConfig();
    const updated = { ...current, ...req.body };
    await supabase.from('settings').upsert(
      { key: CONFIG_KEY, value: updated, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /report ──────────────────────────────────────────────────────────────
// Admin: checkout recovery report with KPIs, daily breakdown, and session list
router.get('/report', auth, async (req, res) => {
  try {
    const { from, to, page } = req.query;
    const pageSize = 50;
    const pageNum  = Math.max(1, parseInt(page) || 1);
    const offset   = (pageNum - 1) * pageSize;

    // Date filters
    let fromDate = from || null;
    let toDate   = to   || null;

    // Default: last 30 days
    if (!fromDate) {
      const d = new Date(); d.setDate(d.getDate() - 30);
      fromDate = d.toISOString().slice(0, 10);
    }
    if (!toDate) {
      toDate = new Date().toISOString().slice(0, 10);
    }

    const startTs = fromDate + 'T00:00:00.000Z';
    const endTs   = toDate + 'T23:59:59.999Z';

    // KPI aggregates
    const { data: allRows, error: allErr } = await supabase
      .from('checkout_recovery_log')
      .select('cart_total, wa_sent, wa_ok, completed, is_returning, started_at, completed_at')
      .gte('started_at', startTs)
      .lte('started_at', endTs);

    if (allErr) throw new Error(allErr.message || allErr.details || JSON.stringify(allErr));
    const rows = allRows || [];

    const totalSessions      = rows.length;
    const waSent             = rows.filter(r => r.wa_sent).length;
    const waDelivered        = rows.filter(r => r.wa_sent && r.wa_ok).length;
    const converted          = rows.filter(r => r.completed).length;
    const convertedAfterWa   = rows.filter(r => r.completed && r.wa_sent).length;
    const abandoned          = rows.filter(r => !r.completed).length;
    const returningCount     = rows.filter(r => r.is_returning).length;
    const totalCartValue     = rows.reduce((s, r) => s + Number(r.cart_total || 0), 0);
    const recoveredValue     = rows.filter(r => r.completed).reduce((s, r) => s + Number(r.cart_total || 0), 0);
    const lostValue          = totalCartValue - recoveredValue;

    // Avg time to convert (for converted sessions that have both timestamps)
    const convertTimes = rows
      .filter(r => r.completed && r.started_at && r.completed_at)
      .map(r => new Date(r.completed_at).getTime() - new Date(r.started_at).getTime());
    const avgConvertMinutes = convertTimes.length
      ? Math.round(convertTimes.reduce((a, b) => a + b, 0) / convertTimes.length / 60000)
      : null;

    // Daily breakdown
    const dailyMap = {};
    for (const r of rows) {
      const day = String(r.started_at).slice(0, 10);
      if (!dailyMap[day]) dailyMap[day] = { date: day, sessions: 0, wa_sent: 0, converted: 0, cart_value: 0, recovered_value: 0 };
      dailyMap[day].sessions++;
      if (r.wa_sent) dailyMap[day].wa_sent++;
      if (r.completed) { dailyMap[day].converted++; dailyMap[day].recovered_value += Number(r.cart_total || 0); }
      dailyMap[day].cart_value += Number(r.cart_total || 0);
    }
    const daily = Object.values(dailyMap).sort((a, b) => b.date.localeCompare(a.date));

    // Paginated session list (newest first, with full details)
    const { data: sessionRows, error: sesErr } = await supabase
      .from('checkout_recovery_log')
      .select('*')
      .gte('started_at', startTs)
      .lte('started_at', endTs)
      .order('started_at', { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (sesErr) throw new Error(sesErr.message || sesErr.details || JSON.stringify(sesErr));

    res.json({
      kpi: {
        total_sessions:     totalSessions,
        wa_sent:            waSent,
        wa_delivered:       waDelivered,
        converted:          converted,
        converted_after_wa: convertedAfterWa,
        abandoned:          abandoned,
        returning_visitors: returningCount,
        total_cart_value:   Math.round(totalCartValue),
        recovered_value:    Math.round(recoveredValue),
        lost_value:         Math.round(lostValue),
        conversion_rate:    totalSessions ? Math.round(converted / totalSessions * 1000) / 10 : 0,
        wa_recovery_rate:   waSent ? Math.round(convertedAfterWa / waSent * 1000) / 10 : 0,
        wa_delivery_rate:   waSent ? Math.round(waDelivered / waSent * 1000) / 10 : 0,
        avg_convert_minutes: avgConvertMinutes,
      },
      daily,
      sessions: sessionRows || [],
      page: pageNum,
      page_size: pageSize,
      from: fromDate,
      to: toDate,
    });
  } catch (e) {
    console.error('[checkoutRecovery] GET /report', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
