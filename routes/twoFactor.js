// ── 2FA (TOTP) routes ─────────────────────────────────────────────────────────
// Shared by admin (/api/auth/2fa) and customer (/api/customer/2fa)
// Usage: require('./twoFactor')(supabase, table, authMiddleware, cookieOptsOrNull)
//   table        = 'users' | 'customers'
//   cookieOpts   = cookie options for admin (null for customers who use Bearer tokens)

const express  = require('express');
const speakeasy = require('speakeasy');
const QRCode   = require('qrcode');
const jwt      = require('jsonwebtoken');

const JWT_SECRET   = () => process.env.JWT_SECRET;
const PRE_AUTH_EXP = '5m'; // time window to enter TOTP after password OK

// ── helpers ───────────────────────────────────────────────────────────────────
function issuePreAuthToken(payload) {
  return jwt.sign({ ...payload, purpose: 'pre-auth' }, JWT_SECRET(), { expiresIn: PRE_AUTH_EXP });
}

function verifyPreAuthToken(token) {
  const decoded = jwt.verify(token, JWT_SECRET());
  if (decoded.purpose !== 'pre-auth') throw new Error('Invalid token purpose');
  return decoded;
}

function verifyTOTP(secret, token) {
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token,
    window: 1, // allow ±30s clock drift
  });
}

// ── factory ───────────────────────────────────────────────────────────────────
module.exports = function make2FARouter(supabase, table, authMiddleware, cookieOpts) {
  // issueSessionToken may be passed in cookieOpts for admin logins
  const issueSessionToken = cookieOpts?.issueSessionToken || null;
  const router = express.Router();

  // POST /setup — generate secret + QR code (requires existing session)
  router.post('/setup', authMiddleware, async (req, res) => {
    try {
      const userId  = req.user?.id || req.customer?.id;
      const email   = req.user?.username || req.user?.email || req.customer?.email || 'sathvam';
      const secret  = speakeasy.generateSecret({ name: `Sathvam (${email})`, issuer: 'Sathvam' });

      // Store secret (not enabled yet — confirmed separately)
      const { error } = await supabase.from(table).update({ totp_secret: secret.base32 }).eq('id', userId);
      if (error) return res.status(500).json({ error: 'Failed to save secret' });

      const otpAuthUrl = speakeasy.otpauthURL({ secret: secret.base32, label: email, issuer: 'Sathvam', encoding: 'base32' });
      const qr = await QRCode.toDataURL(otpAuthUrl);
      res.json({ qr, secret: secret.base32 }); // secret shown once for manual entry
    } catch (e) {
      console.error('2FA setup error:', e);
      res.status(500).json({ error: 'Setup failed' });
    }
  });

  // POST /confirm — verify code and enable 2FA
  router.post('/confirm', authMiddleware, async (req, res) => {
    try {
      const { code } = req.body;
      if (!code) return res.status(400).json({ error: 'Code required' });
      const userId = req.user?.id || req.customer?.id;

      const { data: row } = await supabase.from(table).select('totp_secret').eq('id', userId).single();
      if (!row?.totp_secret) return res.status(400).json({ error: 'Run /setup first' });

      if (!verifyTOTP(row.totp_secret, code))
        return res.status(400).json({ error: 'Invalid code — check your authenticator app' });

      await supabase.from(table).update({ totp_enabled: true }).eq('id', userId);
      res.json({ ok: true, message: '2FA enabled successfully' });
    } catch (e) {
      console.error('2FA confirm error:', e);
      res.status(500).json({ error: 'Confirmation failed' });
    }
  });

  // POST /disable — requires current TOTP code to turn off
  router.post('/disable', authMiddleware, async (req, res) => {
    try {
      const { code } = req.body;
      if (!code) return res.status(400).json({ error: 'Current authenticator code required' });
      const userId = req.user?.id || req.customer?.id;

      const { data: row } = await supabase.from(table).select('totp_secret,totp_enabled').eq('id', userId).single();
      if (!row?.totp_enabled) return res.status(400).json({ error: '2FA is not enabled' });

      if (!verifyTOTP(row.totp_secret, code))
        return res.status(400).json({ error: 'Invalid code' });

      await supabase.from(table).update({ totp_enabled: false, totp_secret: null }).eq('id', userId);
      res.json({ ok: true, message: '2FA disabled' });
    } catch (e) {
      console.error('2FA disable error:', e);
      res.status(500).json({ error: 'Failed to disable 2FA' });
    }
  });

  // POST /status — check if 2FA is enabled for current user
  router.get('/status', authMiddleware, async (req, res) => {
    try {
      const userId = req.user?.id || req.customer?.id;
      const { data: row } = await supabase.from(table).select('totp_enabled').eq('id', userId).single();
      res.json({ enabled: row?.totp_enabled || false });
    } catch { res.status(500).json({ error: 'Server error' }); }
  });

  // POST /validate — second step: verify TOTP code using preAuthToken
  // cookieOpts present → admin (set httpOnly cookie)
  // cookieOpts null    → customer (return JWT in body)
  router.post('/validate', async (req, res) => {
    try {
      const { preAuthToken, code } = req.body;
      if (!preAuthToken || !code) return res.status(400).json({ error: 'preAuthToken and code required' });

      let decoded;
      try { decoded = verifyPreAuthToken(preAuthToken); }
      catch { return res.status(401).json({ error: 'Session expired — please login again' }); }

      const { data: row } = await supabase.from(table).select('*').eq('id', decoded.id).single();
      if (!row) return res.status(401).json({ error: 'User not found' });
      if (!row.totp_enabled) return res.status(400).json({ error: '2FA not enabled for this account' });

      if (!verifyTOTP(row.totp_secret, code))
        return res.status(400).json({ error: 'Invalid code — try again' });

      // Issue full session
      if (cookieOpts && !cookieOpts.returnToken) {
        // Admin — httpOnly cookie only
        // Generate session token for single-session enforcement
        let sessionToken;
        if (issueSessionToken) sessionToken = await issueSessionToken(row.id);
        const payload = { id: row.id, username: row.username, name: row.name, role: row.role };
        if (sessionToken) payload.session_token = sessionToken;
        const token = jwt.sign(payload, JWT_SECRET(), { expiresIn: '7d' });
        res.cookie(cookieOpts.name, token, cookieOpts.opts);
        res.json({ user: { id: row.id, name: row.name, username: row.username, role: row.role } });
      } else {
        // Customer — httpOnly cookie + token in body (mobile backward compat)
        const token = jwt.sign(
          { id: row.id, email: row.email, name: row.name },
          JWT_SECRET(), { expiresIn: '30d' }
        );
        if (cookieOpts) res.cookie(cookieOpts.name, token, cookieOpts.opts);
        res.json({ customer: { id: row.id, name: row.name, email: row.email, phone: row.phone, address: row.address, city: row.city, state: row.state, pincode: row.pincode }, token });
      }
    } catch (e) {
      console.error('2FA validate error:', e);
      res.status(500).json({ error: 'Validation failed' });
    }
  });

  return { router, issuePreAuthToken, verifyTOTP };
};

module.exports.issuePreAuthToken = issuePreAuthToken;
