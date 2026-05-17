const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET;
const SIG_TTL    = 180 * 1000; // 3 min signal TTL

// Helper: serialise signal queue writes
const sigLocks = new Map();
function withLock(key, fn) {
  const prev = sigLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  sigLocks.set(key, next.catch(() => {}));
  return next;
}

// ── POST /api/guest-call/invite — create a secure expiring call link ────────
router.post('/invite', auth, async (req, res) => {
  try {
    const { expiresInHours = 24, maxUses = 1, note = '', callType = 'video' } = req.body;
    const roomId = crypto.randomUUID();

    const token = jwt.sign({
      type:            'guest_call',
      roomId,
      invitedBy:       String(req.user.id),
      invitedByName:   req.user.name || req.user.username,
      invitedByRole:   req.user.role,
      callType,
      maxUses,
      note,
    }, JWT_SECRET, { expiresIn: `${expiresInHours}h` });

    // Persist usage tracking
    await supabase.from('settings').upsert({
      key:   `gcall_${roomId}`,
      value: { uses: 0, maxUses, invitedBy: String(req.user.id), note, callType, createdAt: Date.now() },
      updated_at: new Date().toISOString(),
    });

    const link = `${process.env.PORTAL_URL}/call/join/${token}`;
    res.json({ token, link, roomId, expiresInHours, callType });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/guest-call/validate/:token — public validation (no auth) ───────
router.get('/validate/:token', async (req, res) => {
  try {
    let payload;
    try { payload = jwt.verify(req.params.token, JWT_SECRET); }
    catch (e) { return res.status(401).json({ error: 'Link is invalid or has expired' }); }

    if (payload.type !== 'guest_call')
      return res.status(400).json({ error: 'Invalid link type' });

    const { data: row } = await supabase.from('settings')
      .select('value').eq('key', `gcall_${payload.roomId}`).maybeSingle();
    if (!row) return res.status(404).json({ error: 'Link not found' });
    if (row.value.uses >= row.value.maxUses)
      return res.status(410).json({ error: 'This invite link has already been used' });

    res.json({
      valid:         true,
      roomId:        payload.roomId,
      invitedByName: payload.invitedByName,
      invitedBy:     payload.invitedBy,
      callType:      payload.callType || 'video',
      note:          payload.note || '',
      expiresAt:     payload.exp * 1000,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/guest-call/join/:token — guest joins; gets guestToken ──────────
router.post('/join/:token', async (req, res) => {
  try {
    const { guestName } = req.body;
    if (!guestName?.trim()) return res.status(400).json({ error: 'guestName is required' });

    let payload;
    try { payload = jwt.verify(req.params.token, JWT_SECRET); }
    catch (e) { return res.status(401).json({ error: 'Link is invalid or has expired' }); }

    if (payload.type !== 'guest_call') return res.status(400).json({ error: 'Invalid link type' });

    const { data: row } = await supabase.from('settings')
      .select('value').eq('key', `gcall_${payload.roomId}`).maybeSingle();
    if (!row) return res.status(404).json({ error: 'Link not found' });
    if (row.value.uses >= row.value.maxUses)
      return res.status(410).json({ error: 'This invite link has already been used' });

    // Increment use counter
    await supabase.from('settings').update({
      value:      { ...row.value, uses: row.value.uses + 1 },
      updated_at: new Date().toISOString(),
    }).eq('key', `gcall_${payload.roomId}`);

    // Issue short-lived guest session token (4 h)
    const guestId    = `guest_${crypto.randomBytes(8).toString('hex')}`;
    const guestToken = jwt.sign({
      type:        'guest_session',
      guestId,
      guestName:   guestName.trim(),
      roomId:      payload.roomId,
      hostUserId:  payload.invitedBy,
      hostName:    payload.invitedByName,
      callType:    payload.callType || 'video',
    }, JWT_SECRET, { expiresIn: '4h' });

    // Push "guest_ring" into host's signal queue
    const sigKey = `call_sig_${payload.invitedBy}`;
    await withLock(sigKey, async () => {
      const { data: sigRow } = await supabase.from('settings')
        .select('value').eq('key', sigKey).maybeSingle();
      const queue = Array.isArray(sigRow?.value)
        ? sigRow.value.filter(s => Date.now() - (s.ts || 0) < SIG_TTL)
        : [];
      queue.push({
        type:        'guest_ring',
        data:        { guestId, guestName: guestName.trim(), roomId: payload.roomId, callType: payload.callType || 'video' },
        fromUserId:  guestId,
        fromName:    guestName.trim(),
        isGuest:     true,
        ts:          Date.now(),
      });
      await supabase.from('settings').upsert({
        key: sigKey, value: queue.slice(-40), updated_at: new Date().toISOString(),
      });
    });

    res.json({
      guestId,
      guestToken,
      roomId:      payload.roomId,
      hostUserId:  payload.invitedBy,
      hostName:    payload.invitedByName,
      callType:    payload.callType || 'video',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/guest-call/signal — guest → host signal ────────────────────────
router.post('/signal', async (req, res) => {
  try {
    const { guestToken, type, data: sigData } = req.body;
    if (!guestToken || !type) return res.status(400).json({ error: 'Missing guestToken or type' });

    let payload;
    try { payload = jwt.verify(guestToken, JWT_SECRET); }
    catch (e) { return res.status(401).json({ error: 'Invalid or expired guest session' }); }
    if (payload.type !== 'guest_session') return res.status(400).json({ error: 'Invalid token type' });

    const sigKey = `call_sig_${payload.hostUserId}`;
    await withLock(sigKey, async () => {
      const { data: row } = await supabase.from('settings')
        .select('value').eq('key', sigKey).maybeSingle();
      const queue = Array.isArray(row?.value)
        ? row.value.filter(s => Date.now() - (s.ts || 0) < SIG_TTL)
        : [];
      queue.push({
        type,
        data:        sigData ?? null,
        fromUserId:  payload.guestId,
        fromName:    payload.guestName,
        isGuest:     true,
        ts:          Date.now(),
      });
      await supabase.from('settings').upsert({
        key: sigKey, value: queue.slice(-40), updated_at: new Date().toISOString(),
      });
    });

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/guest-call/pending — guest polls for signals from host ───────────
// (host sends via /api/calls/signal with toUserId = guestId, which stores in call_sig_<guestId>)
router.get('/pending', async (req, res) => {
  try {
    const { guestToken } = req.query;
    if (!guestToken) return res.status(400).json({ error: 'Missing guestToken' });

    let payload;
    try { payload = jwt.verify(guestToken, JWT_SECRET); }
    catch (e) { return res.status(401).json({ error: 'Invalid or expired guest session' }); }
    if (payload.type !== 'guest_session') return res.status(400).json({ error: 'Invalid token type' });

    const sigKey = `call_sig_${payload.guestId}`;
    const { data: row } = await supabase.from('settings')
      .select('value').eq('key', sigKey).maybeSingle();
    const now     = Date.now();
    const signals = Array.isArray(row?.value)
      ? row.value.filter(s => now - (s.ts || 0) < SIG_TTL)
      : [];

    if (signals.length > 0) {
      await supabase.from('settings').upsert({
        key: sigKey, value: [], updated_at: new Date().toISOString(),
      });
    }

    res.json({ signals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
