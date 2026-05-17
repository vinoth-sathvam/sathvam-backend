/**
 * guestCall.js — Secure expiring call links for external guests
 *
 * Security model:
 *  - Invite token: JWT signed with JWT_SECRET, short-lived (1–168 h), single-use by default
 *  - Use counter stored in Supabase settings with in-process serialisation lock
 *  - Optional PIN: bcrypt-hashed in settings, never exposed in token or API response
 *  - Guest session token: 4 h JWT, separate from invite token
 *  - Signal type whitelist: only offer/answer/ice/hangup allowed
 *  - Signal payload size capped at 16 KB
 *  - Guest name: max 60 printable ASCII/Unicode chars, stripped of HTML
 *  - maxUses capped at 3; expiresInHours capped at 168 (7 days)
 *  - Dedicated rate limits on all public (unauthenticated) routes
 *  - Link revocation: authenticated host can revoke any of their own links
 *  - Audit log: every join recorded with timestamp + guest IP
 */
const express    = require('express');
const router     = express.Router();
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const crypto     = require('crypto');
const rateLimit  = require('express-rate-limit');
const supabase   = require('../config/supabase');
const { auth }   = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET;
const SIG_TTL    = 180 * 1000; // 3 min

// ── Constants / limits ────────────────────────────────────────────────────────
const MAX_USES_CAP       = 3;
const MAX_EXPIRY_HOURS   = 168; // 7 days
const MIN_EXPIRY_HOURS   = 1;
const MAX_GUEST_NAME_LEN = 60;
const MAX_GUEST_EMAIL_LEN = 120;
const MAX_SIG_DATA_BYTES = 16384; // 16 KB — enough for any SDP/ICE candidate
const ALLOWED_SIG_TYPES  = new Set(['offer', 'answer', 'ice', 'hangup']);
const UUID_RE            = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Rate limiters (applied per route, not globally) ───────────────────────────
const rlOpts = { validate: { xForwardedForHeader: false } };

// Join: 5 per 10 min per IP — prevents link enumeration / brute-force
const joinLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many join attempts. Please wait.' }, ...rlOpts,
});

// Validate: 20 per 10 min per IP — allow repeated page opens without abuse
const validateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests. Please wait.' }, ...rlOpts,
});

// Signal / pending: 120 per min per IP — must be fast for WebRTC
const signalLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Signal rate limit exceeded.' }, ...rlOpts,
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const sigLocks = new Map();
function withLock(key, fn) {
  const prev = sigLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  sigLocks.set(key, next.catch(() => {}));
  return next;
}

// Strip HTML tags and control characters from user-supplied strings
function sanitiseText(s, maxLen) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/<[^>]*>/g, '')          // strip tags
    .replace(/[\x00-\x1f\x7f]/g, '')  // strip control chars
    .trim()
    .slice(0, maxLen);
}

// Verify a guest session token and return payload or throw
function verifyGuestToken(token) {
  let p;
  try { p = jwt.verify(token, JWT_SECRET); } catch (e) { throw Object.assign(new Error('Invalid or expired guest session'), { status: 401 }); }
  if (p.type !== 'guest_session') throw Object.assign(new Error('Invalid token type'), { status: 400 });
  return p;
}

// ── POST /api/guest-call/invite — create a secure expiring call link ──────────
// Requires full admin auth. Optional PIN adds a second factor for the guest.
router.post('/invite', auth, async (req, res) => {
  try {
    let { expiresInHours = 24, maxUses = 1, note = '', callType = 'video', pin = '' } = req.body;

    // Clamp & validate
    expiresInHours = Math.min(MAX_EXPIRY_HOURS, Math.max(MIN_EXPIRY_HOURS, Math.round(Number(expiresInHours) || 24)));
    maxUses        = Math.min(MAX_USES_CAP, Math.max(1, Math.round(Number(maxUses) || 1)));
    callType       = ['video', 'audio'].includes(callType) ? callType : 'video';
    note           = sanitiseText(note, 200);
    pin            = sanitiseText(String(pin || ''), 20);

    const roomId = crypto.randomUUID();

    // Hash PIN if provided (never store plain PIN)
    const pinHash = pin ? await bcrypt.hash(pin, 10) : null;

    const token = jwt.sign({
      type:          'guest_call',
      roomId,
      invitedBy:     String(req.user.id),
      invitedByName: sanitiseText(req.user.name || req.user.username, 80),
      callType,
      maxUses,
      hasPin:        !!pin,
      note,
    }, JWT_SECRET, { expiresIn: `${expiresInHours}h` });

    await supabase.from('settings').upsert({
      key:   `gcall_${roomId}`,
      value: {
        uses:       0,
        maxUses,
        revoked:    false,
        invitedBy:  String(req.user.id),
        callType,
        note,
        pinHash,          // null if no PIN
        createdAt:  Date.now(),
        auditLog:   [],   // [{ts, guestName, ip}]
      },
      updated_at: new Date().toISOString(),
    });

    const link = `${process.env.PORTAL_URL}/call/join/${token}`;
    res.json({ token, link, roomId, expiresInHours, callType, hasPin: !!pin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/guest-call/my-links — list active invite links for this user ─────
router.get('/my-links', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('settings')
      .select('key,value,updated_at')
      .like('key', 'gcall_%');
    const now = Date.now();
    const links = (data || [])
      .filter(r => r.value?.invitedBy === String(req.user.id))
      .map(r => ({
        roomId:    r.key.replace('gcall_', ''),
        uses:      r.value.uses,
        maxUses:   r.value.maxUses,
        revoked:   r.value.revoked,
        callType:  r.value.callType,
        note:      r.value.note,
        auditLog:  r.value.auditLog || [],
        hasPin:    !!r.value.pinHash,
        createdAt: r.value.createdAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json(links);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/guest-call/revoke/:roomId — revoke a link immediately ─────────
router.delete('/revoke/:roomId', auth, async (req, res) => {
  try {
    const roomId = req.params.roomId;
    if (!UUID_RE.test(roomId)) return res.status(400).json({ error: 'Invalid roomId' });

    const { data: row } = await supabase.from('settings')
      .select('value').eq('key', `gcall_${roomId}`).maybeSingle();
    if (!row) return res.status(404).json({ error: 'Link not found' });
    if (row.value.invitedBy !== String(req.user.id) && !['admin','ceo'].includes(req.user.role))
      return res.status(403).json({ error: 'Not authorised to revoke this link' });

    await supabase.from('settings').update({
      value: { ...row.value, revoked: true },
      updated_at: new Date().toISOString(),
    }).eq('key', `gcall_${roomId}`);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/guest-call/validate/:token — public validation (no auth) ─────────
router.get('/validate/:token', validateLimiter, async (req, res) => {
  try {
    let payload;
    try { payload = jwt.verify(req.params.token, JWT_SECRET); }
    catch (e) { return res.status(401).json({ error: 'Link is invalid or has expired' }); }

    if (payload.type !== 'guest_call')
      return res.status(400).json({ error: 'Invalid link type' });

    const { data: row } = await supabase.from('settings')
      .select('value').eq('key', `gcall_${payload.roomId}`).maybeSingle();

    if (!row)                               return res.status(404).json({ error: 'Link not found' });
    if (row.value.revoked)                  return res.status(410).json({ error: 'This invite link has been revoked' });
    if (row.value.uses >= row.value.maxUses) return res.status(410).json({ error: 'This invite link has already been used' });

    // Return only public info — never expose invitedBy user ID or PIN hash
    res.json({
      valid:         true,
      roomId:        payload.roomId,
      invitedByName: payload.invitedByName,
      callType:      payload.callType || 'video',
      note:          payload.note || '',
      hasPin:        !!row.value.pinHash,
      expiresAt:     payload.exp * 1000,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/guest-call/join/:token — guest joins; gets guestToken ───────────
router.post('/join/:token', joinLimiter, async (req, res) => {
  try {
    const rawName      = req.body?.guestName;
    const rawPin       = req.body?.pin || '';
    const rawEmail     = req.body?.guestEmail || '';
    const rawUserAgent = typeof req.body?.userAgent === 'string' ? req.body.userAgent.slice(0, 300) : '';

    if (!rawName) return res.status(400).json({ error: 'guestName is required' });
    if (!rawEmail) return res.status(400).json({ error: 'guestEmail is required' });

    const guestName  = sanitiseText(String(rawName), MAX_GUEST_NAME_LEN);
    const guestEmail = sanitiseText(String(rawEmail), MAX_GUEST_EMAIL_LEN).toLowerCase();
    if (!guestName) return res.status(400).json({ error: 'Invalid guest name' });
    // Basic email format check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)) return res.status(400).json({ error: 'Invalid email address' });

    let payload;
    try { payload = jwt.verify(req.params.token, JWT_SECRET); }
    catch (e) { return res.status(401).json({ error: 'Link is invalid or has expired' }); }

    if (payload.type !== 'guest_call') return res.status(400).json({ error: 'Invalid link type' });

    // Serialise join attempts for this room to prevent race on use counter
    const joinResult = await withLock(`gcall_join_${payload.roomId}`, async () => {
      const { data: row } = await supabase.from('settings')
        .select('value').eq('key', `gcall_${payload.roomId}`).maybeSingle();

      if (!row)                                return { err: 'Link not found',                     status: 404 };
      if (row.value.revoked)                   return { err: 'This invite link has been revoked',  status: 410 };
      if (row.value.uses >= row.value.maxUses) return { err: 'This invite link has already been used', status: 410 };

      // Verify PIN if set
      if (row.value.pinHash) {
        const pinOk = await bcrypt.compare(sanitiseText(String(rawPin), 20), row.value.pinHash);
        if (!pinOk) return { err: 'Incorrect PIN', status: 403 };
      }

      // Atomic increment + audit log
      const ip        = req.ip || 'unknown';
      const auditLog  = [...(row.value.auditLog || []), {
        ts:        Date.now(),
        guestName,
        guestEmail,
        ip,
        userAgent: rawUserAgent,
      }].slice(-50);
      await supabase.from('settings').update({
        value:      { ...row.value, uses: row.value.uses + 1, auditLog },
        updated_at: new Date().toISOString(),
      }).eq('key', `gcall_${payload.roomId}`);

      return { ok: true, pinHash: null }; // pinHash stripped
    });

    if (joinResult.err) return res.status(joinResult.status).json({ error: joinResult.err });

    // Issue short-lived guest session token (4 h)
    const guestId    = `guest_${crypto.randomBytes(12).toString('hex')}`; // 96-bit entropy
    const guestToken = jwt.sign({
      type:       'guest_session',
      guestId,
      guestName,
      guestEmail,
      roomId:     payload.roomId,
      hostUserId: payload.invitedBy,
      hostName:   payload.invitedByName,
      callType:   payload.callType || 'video',
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
        type:       'guest_ring',
        data:       { guestId, guestName, guestEmail, roomId: payload.roomId, callType: payload.callType || 'video' },
        fromUserId: guestId,
        fromName:   guestName,
        guestEmail,
        isGuest:    true,
        ts:         Date.now(),
      });
      await supabase.from('settings').upsert({
        key: sigKey, value: queue.slice(-40), updated_at: new Date().toISOString(),
      });
    });

    res.json({
      guestId,
      guestToken,
      roomId:    payload.roomId,
      hostName:  payload.invitedByName,
      callType:  payload.callType || 'video',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/guest-call/signal — guest → host WebRTC signal ─────────────────
router.post('/signal', signalLimiter, async (req, res) => {
  try {
    const { guestToken, type, data: sigData } = req.body;
    if (!guestToken || !type) return res.status(400).json({ error: 'Missing guestToken or type' });

    // Whitelist signal types — no arbitrary data injection
    if (!ALLOWED_SIG_TYPES.has(type)) return res.status(400).json({ error: 'Invalid signal type' });

    // Cap payload size
    if (sigData !== null && sigData !== undefined) {
      const size = Buffer.byteLength(JSON.stringify(sigData), 'utf8');
      if (size > MAX_SIG_DATA_BYTES) return res.status(413).json({ error: 'Signal payload too large' });
    }

    const payload = verifyGuestToken(guestToken);

    const sigKey = `call_sig_${payload.hostUserId}`;
    await withLock(sigKey, async () => {
      const { data: row } = await supabase.from('settings')
        .select('value').eq('key', sigKey).maybeSingle();
      const queue = Array.isArray(row?.value)
        ? row.value.filter(s => Date.now() - (s.ts || 0) < SIG_TTL)
        : [];
      queue.push({
        type,
        data:       sigData ?? null,
        fromUserId: payload.guestId,
        fromName:   payload.guestName,
        isGuest:    true,
        ts:         Date.now(),
      });
      await supabase.from('settings').upsert({
        key: sigKey, value: queue.slice(-40), updated_at: new Date().toISOString(),
      });
    });

    res.json({ ok: true });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/guest-call/pending — guest polls for signals from host ──────────
// Using POST (not GET) so guestToken never appears in server access logs / CDN logs
router.post('/pending', signalLimiter, async (req, res) => {
  try {
    const { guestToken } = req.body;
    if (!guestToken) return res.status(400).json({ error: 'Missing guestToken' });

    const payload = verifyGuestToken(guestToken);

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
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
