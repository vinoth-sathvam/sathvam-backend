const express  = require('express');
const router   = express.Router();
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');

// Uses Supabase `settings` table as a lightweight signal queue — no extra table needed.
// Keys used:
//   call_sig_<userId>  — WebRTC signal queue for a user (offer/answer/ICE/ring/reject/hangup)
//   call_hb_<userId>   — heartbeat/presence record

const SIG_TTL  = 180 * 1000; // signals expire after 3 min (background tab throttling)
const HB_TTL   = 180 * 1000; // user shown "online" for 3 min after last heartbeat

// Per-user write lock — serialises concurrent signal writes to avoid read-modify-write races
const sigLocks = new Map();
function withSignalLock(userId, fn) {
  const prev = sigLocks.get(userId) || Promise.resolve();
  const next = prev.then(fn, fn); // run fn regardless of prev outcome
  sigLocks.set(userId, next.catch(() => {}));
  return next;
}

// ── POST /api/calls/signal — push a WebRTC signal into another user's queue ──
router.post('/signal', auth, async (req, res) => {
  const { toUserId, type, data } = req.body;
  if (!toUserId || !type) return res.status(400).json({ error: 'Missing toUserId or type' });

  console.log(`[calls/signal] from=${req.user.id}(${req.user.name}) to=${toUserId} type=${type}`);
  const key = `call_sig_${toUserId}`;

  await withSignalLock(toUserId, async () => {
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
    console.log(`[calls/pending] user=${req.user.id}(${req.user.name}) got signals: ${signals.map(s=>s.type).join(',')}`);
    // Clear queue after reading
    await supabase.from('settings').upsert({ key, value: [], updated_at: new Date().toISOString() });
  }

  res.json({ signals });
});

// ── POST /api/calls/heartbeat — mark this user as online (accepts status) ────
router.post('/heartbeat', auth, async (req, res) => {
  const { status } = req.body; // 'available'|'busy'|'away'
  await supabase.from('settings').upsert({
    key:        `call_hb_${req.user.id}`,
    value:      { name: req.user.name || req.user.username, role: req.user.role, ts: Date.now(), status: status || 'available' },
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
      status: r.value.status || 'available',
    }))
    .filter(u => u.userId !== String(req.user.id));

  res.json({ online });
});

// ── POST /api/calls/notes — save a post-call note ────────────────────────────
router.post('/notes', auth, async (req, res) => {
  try {
    const { peerId, peerName, note, callType, duration } = req.body;
    const key = `call_notes_${req.user.id}`;
    const { data: row } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
    const notes = Array.isArray(row?.value) ? row.value : [];
    notes.unshift({ id: Date.now(), peerId, peerName, note: note || '', callType, duration, ts: Date.now() });
    await supabase.from('settings').upsert({ key, value: notes.slice(0, 100), updated_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/calls/notes — fetch my post-call notes ──────────────────────────
router.get('/notes', auth, async (req, res) => {
  try {
    const key = `call_notes_${req.user.id}`;
    const { data: row } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
    res.json(Array.isArray(row?.value) ? row.value : []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/calls/schedule — schedule a call ───────────────────────────────
router.post('/schedule', auth, async (req, res) => {
  try {
    const { peerId, peerName, scheduledAt, callType, note } = req.body;
    if (!peerId || !scheduledAt) return res.status(400).json({ error: 'peerId and scheduledAt required' });
    const key = `call_schedule_${req.user.id}`;
    const { data: row } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
    const schedules = Array.isArray(row?.value) ? row.value : [];
    schedules.push({ id: Date.now(), peerId, peerName, scheduledAt, callType: callType || 'audio', note: note || '', ts: Date.now() });
    await supabase.from('settings').upsert({ key, value: schedules.slice(0, 50), updated_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/calls/schedule — list my upcoming scheduled calls ────────────────
router.get('/schedule', auth, async (req, res) => {
  try {
    const key = `call_schedule_${req.user.id}`;
    const { data: row } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
    const now = Date.now();
    const active = (Array.isArray(row?.value) ? row.value : [])
      .filter(s => new Date(s.scheduledAt).getTime() > now - 3600000); // keep past 1h too
    res.json(active);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/calls/schedule/:id — cancel scheduled call ───────────────────
router.delete('/schedule/:id', auth, async (req, res) => {
  try {
    const key = `call_schedule_${req.user.id}`;
    const { data: row } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
    const schedules = (Array.isArray(row?.value) ? row.value : [])
      .filter(s => String(s.id) !== req.params.id);
    await supabase.from('settings').upsert({ key, value: schedules, updated_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
