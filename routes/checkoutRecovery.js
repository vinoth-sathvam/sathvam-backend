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
const { createClient } = require('@supabase/supabase-js');
const { sendText }     = require('../lib/greenapi');
const { auth }         = require('../middleware/auth');

const router  = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const SESSIONS_KEY = 'checkout_sessions';
const CONFIG_KEY   = 'checkout_recovery_config';
const SESSION_TTL  = 48 * 60 * 60 * 1000; // 48 hours

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
      const msg = buildMessage(config.message_template, s);
      const ok  = await sendText(s.phone, msg);
      s.wa_sent    = true;
      s.wa_sent_at = new Date().toISOString();
      s.wa_ok      = ok;
      sent++;
    } else {
      sent++; // count as "would send"
    }
  }

  if (!dryRun) await saveSessions(sessions);
  return { sent, skipped };
}

// ── Cron: every 2 minutes ─────────────────────────────────────────────────────
cron.schedule('*/2 * * * *', () => {
  processAbandoned().catch(e => console.error('[checkoutRecovery cron]', e.message));
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
  const { id } = req.params;
  try {
    const [sessions, config] = await Promise.all([loadSessions(), loadConfig()]);
    const s = sessions.find(x => x.id === id);
    if (!s) return res.status(404).json({ error: 'session not found' });

    const msg = buildMessage(config.message_template, s);
    const ok  = await sendText(s.phone, msg);
    s.wa_sent    = true;
    s.wa_sent_at = new Date().toISOString();
    s.wa_ok      = ok;
    await saveSessions(sessions);

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

module.exports = router;
