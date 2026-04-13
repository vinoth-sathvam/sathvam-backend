const express  = require('express');
const router   = express.Router();
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');

// Uses Supabase `settings` table as a lightweight signal queue — no extra table needed.
// Keys used:
//   call_sig_<userId>  — WebRTC signal queue for a user (offer/answer/ICE/ring/reject/hangup)
//   call_hb_<userId>   — heartbeat/presence record

const SIG_TTL  = 60 * 1000;  // signals expire after 60s
const HB_TTL   = 120 * 1000; // user shown "online" for 120s after last heartbeat

// ── POST /api/calls/signal — push a WebRTC signal into another user's queue ──
router.post('/signal', auth, async (req, res) => {
  const { toUserId, type, data } = req.body;
  if (!toUserId || !type) return res.status(400).json({ error: 'Missing toUserId or type' });

  const key = `call_sig_${toUserId}`;
  const { data: row } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
  const queue = Array.isArray(row?.value)
    ? row.value.filter(s => Date.now() - (s.ts || 0) < SIG_TTL)
    : [];

  queue.push({
    type,
    data:       data ?? null,
    fromUserId: String(req.user.id),
    fromName:   req.user.name || req.user.username,
    ts:         Date.now(),
  });

  await supabase.from('settings').upsert({
    key,
    value:      queue.slice(-40),  // keep max 40 entries
    updated_at: new Date().toISOString(),
  });

  res.json({ ok: true });
});

// ── GET /api/calls/pending — fetch and clear this user's signal queue ─────────
router.get('/pending', auth, async (req, res) => {
  const key = `call_sig_${req.user.id}`;
  const { data: row } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
  const now     = Date.now();
  const signals = Array.isArray(row?.value)
    ? row.value.filter(s => now - (s.ts || 0) < SIG_TTL)
    : [];

  if (signals.length > 0) {
    // Clear queue after reading
    await supabase.from('settings').upsert({ key, value: [], updated_at: new Date().toISOString() });
  }

  res.json({ signals });
});

// ── POST /api/calls/heartbeat — mark this user as online ─────────────────────
router.post('/heartbeat', auth, async (req, res) => {
  await supabase.from('settings').upsert({
    key:        `call_hb_${req.user.id}`,
    value:      { name: req.user.name || req.user.username, role: req.user.role, ts: Date.now() },
    updated_at: new Date().toISOString(),
  });
  res.json({ ok: true });
});

// ── GET /api/calls/online — list users active in last 2 minutes ───────────────
router.get('/online', auth, async (req, res) => {
  const { data } = await supabase
    .from('settings')
    .select('key,value')
    .like('key', 'call_hb_%');

  const now    = Date.now();
  const online = (data || [])
    .filter(r => r.value?.ts && now - r.value.ts < HB_TTL)
    .map(r => ({
      userId: r.key.replace('call_hb_', ''),
      name:   r.value.name,
      role:   r.value.role,
    }))
    .filter(u => u.userId !== String(req.user.id));

  res.json({ online });
});

module.exports = router;
