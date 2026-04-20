const express    = require('express');
const supabase   = require('../config/supabase');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');
const make2FA    = require('./twoFactor');
const { encrypt, decrypt, hmac, encryptCustomer, decryptCustomer } = require('../config/crypto');
const router     = express.Router();

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('FATAL: JWT_SECRET not set'); process.exit(1); }

// Cookie options for customer JWT (httpOnly — XSS-safe)
const CUST_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
};
function setCustCookie(res, token) {
  res.cookie('sathvam_cust', token, CUST_COOKIE_OPTS);
}

// Auth middleware — reads httpOnly cookie first, falls back to Bearer header (mobile apps)
const custAuth = (req, res, next) => {
  const token = req.cookies?.sathvam_cust || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try { req.customer = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Session expired. Please login again.' }); }
};

// POST /api/customer/signup
router.post('/signup', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
    if (password && password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const normEmail = email.toLowerCase().trim();
    const eHash = hmac(normEmail);
    // Use HMAC hash for duplicate check (email column is encrypted after migration)
    const { data: existing } = await supabase.from('customers').select('id').eq('email_hash', eHash).maybeSingle();
    if (existing) return res.status(400).json({ error: 'Email already registered. Please login.' });
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    const { data: cust, error } = await supabase.from('customers')
      .insert({
        name:          encrypt(name.trim()),
        email:         encrypt(normEmail),
        email_hash:    eHash,
        phone:         phone ? encrypt(phone) : null,
        password_hash: passwordHash,
      })
      .select('id,name,email,phone,address,city,state,pincode').single();
    if (error) return res.status(400).json({ error: error.message });
    const plain = decryptCustomer(cust);
    const token = jwt.sign({ id: plain.id, email: normEmail, name: plain.name }, JWT_SECRET, { expiresIn: '30d' });
    setCustCookie(res, token);
    res.json({ customer: plain, token });

    // Fire-and-forget admin notification
    setImmediate(async () => {
      try {
        const adminEmail = process.env.SMTP_USER;
        if (!adminEmail) return;
        const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
        await mailer.sendMail({
          from: process.env.SMTP_FROM || `Sathvam <${adminEmail}>`,
          to: adminEmail,
          subject: `🆕 New Customer Signup — ${plain.name}`,
          html: `
<div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;">
  <div style="background:linear-gradient(135deg,#1f2937,#374151);padding:20px 24px;">
    <h2 style="color:#fff;margin:0;font-size:18px;">🆕 New Customer Signed Up</h2>
    <div style="color:#9ca3af;font-size:12px;margin-top:4px;">${now}</div>
  </div>
  <div style="padding:24px;">
    <table style="font-size:14px;width:100%;border-collapse:collapse;">
      <tr><td style="padding:6px 0;color:#6b7280;width:80px;">Name</td><td style="font-weight:700;color:#111827;">${plain.name}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Email</td><td style="color:#1d4ed8;">${normEmail}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Phone</td><td style="color:#111827;">${plain.phone||'—'}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Source</td><td style="color:#111827;">Email signup</td></tr>
    </table>
    <a href="https://admin.sathvam.in" style="display:inline-block;margin-top:18px;background:#1f2937;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:700;">View in Admin →</a>
  </div>
</div>`,
        });
      } catch (e) { console.error('New customer admin notify failed:', e.message); }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/customer/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const normEmail = email.toLowerCase().trim();
    const eHash = hmac(normEmail);

    // Primary lookup: by HMAC hash (encrypted rows)
    let { data: cust } = await supabase.from('customers').select('*').eq('email_hash', eHash).maybeSingle();

    // Fallback: plaintext lookup for rows that haven't been migrated yet
    if (!cust) {
      const { data: plain } = await supabase.from('customers').select('*').eq('email', normEmail).maybeSingle();
      if (plain) {
        cust = plain;
        // Lazy-migrate: encrypt this row so future logins use the hash path
        setImmediate(() => migrateCustomerRow(cust.id, cust));
      }
    }

    if (!cust) return res.status(400).json({ error: 'No account found with this email. Please sign up.' });

    if (cust.password_hash && password) {
      const valid = await bcrypt.compare(password, cust.password_hash);
      if (!valid) return res.status(400).json({ error: 'Incorrect password' });
    }

    // 2FA — if enabled, return pre-auth token instead of full JWT
    if (cust.totp_enabled) {
      const { issuePreAuthToken } = require('./twoFactor');
      const preAuthToken = issuePreAuthToken({ id: cust.id });
      return res.json({ requiresTOTP: true, preAuthToken });
    }

    const plain = decryptCustomer(cust);
    const token = jwt.sign({ id: plain.id, email: normEmail, name: plain.name }, JWT_SECRET, { expiresIn: '30d' });
    setCustCookie(res, token);
    res.json({ customer: { id: plain.id, name: plain.name, email: normEmail, phone: plain.phone, address: plain.address, city: plain.city, state: plain.state, pincode: plain.pincode }, token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lazy-migrate: encrypt a pre-existing plaintext customer row in the background.
async function migrateCustomerRow(id, existing) {
  try {
    const plainEmail = existing.email || '';
    if (!plainEmail || plainEmail.startsWith('ENC:')) return; // already encrypted or empty
    const updates = {
      name:       encrypt(existing.name  || ''),
      email:      encrypt(plainEmail),
      email_hash: hmac(plainEmail.toLowerCase().trim()),
      phone:      existing.phone   ? encrypt(existing.phone)   : null,
      address:    existing.address ? encrypt(existing.address) : null,
      city:       existing.city    ? encrypt(existing.city)    : null,
      state:      existing.state   ? encrypt(existing.state)   : null,
      pincode:    existing.pincode ? encrypt(existing.pincode) : null,
    };
    await supabase.from('customers').update(updates).eq('id', id);
  } catch (e) {
    console.error('Lazy customer migration failed for', id, e.message);
  }
}

// Helper — find or create customer by email+name (used by OAuth)
async function oauthFindOrCreate(email, name, avatarUrl) {
  const normEmail = email.toLowerCase().trim();
  const eHash = hmac(normEmail);

  // Try encrypted lookup first
  let { data: existing } = await supabase.from('customers')
    .select('id,name,email,phone,address,city,state,pincode,totp_enabled,totp_secret,email_hash')
    .eq('email_hash', eHash).maybeSingle();

  // Fallback to plaintext (pre-migration rows)
  if (!existing) {
    const { data: plain } = await supabase.from('customers')
      .select('id,name,email,phone,address,city,state,pincode,totp_enabled,totp_secret,email_hash')
      .eq('email', normEmail).maybeSingle();
    if (plain) {
      existing = plain;
      setImmediate(() => migrateCustomerRow(plain.id, plain));
    }
  }

  if (existing) return existing;

  // Create new customer with encrypted PII
  const { data: created, error } = await supabase.from('customers')
    .insert({
      name:       encrypt(name),
      email:      encrypt(normEmail),
      email_hash: eHash,
      avatar_url: avatarUrl || null,
    })
    .select('id,name,email,phone,address,city,state,pincode,totp_enabled,totp_secret,email_hash').single();
  if (error) throw new Error(error.message);

  // Notify admin of new OAuth signup (fire-and-forget)
  setImmediate(async () => {
    try {
      const adminEmail = process.env.SMTP_USER;
      if (!adminEmail) return;
      const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
      await mailer.sendMail({
        from: process.env.SMTP_FROM || `Sathvam <${adminEmail}>`,
        to: adminEmail,
        subject: `🆕 New Customer Signup — ${name}`,
        html: `
<div style="font-family:sans-serif;max-width:500px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;">
  <div style="background:linear-gradient(135deg,#1f2937,#374151);padding:20px 24px;">
    <h2 style="color:#fff;margin:0;font-size:18px;">🆕 New Customer Signed Up</h2>
    <div style="color:#9ca3af;font-size:12px;margin-top:4px;">${now}</div>
  </div>
  <div style="padding:24px;">
    <table style="font-size:14px;width:100%;border-collapse:collapse;">
      <tr><td style="padding:6px 0;color:#6b7280;width:80px;">Name</td><td style="font-weight:700;color:#111827;">${name}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Email</td><td style="color:#1d4ed8;">${normEmail}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Source</td><td style="color:#111827;">Google / Facebook OAuth</td></tr>
    </table>
    <a href="https://admin.sathvam.in" style="display:inline-block;margin-top:18px;background:#1f2937;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:700;">View in Admin →</a>
  </div>
</div>`,
      });
    } catch (e) { console.error('New OAuth customer admin notify failed:', e.message); }
  });

  return created;
}

// Helper — check 2FA and return pre-auth token or full JWT
function oauthRespond(res, cust) {
  const plain = decryptCustomer(cust);
  if (cust.totp_enabled) {
    const { issuePreAuthToken } = require('./twoFactor');
    const preAuthToken = issuePreAuthToken({ id: cust.id });
    return res.json({ requiresTOTP: true, preAuthToken });
  }
  // Use normalised email from HMAC path (plain.email is already decrypted)
  const normEmail = (plain.email || '').toLowerCase().trim();
  const token = jwt.sign({ id: plain.id, email: normEmail, name: plain.name }, JWT_SECRET, { expiresIn: '30d' });
  setCustCookie(res, token);
  res.json({ customer: { id: plain.id, name: plain.name, email: normEmail, phone: plain.phone, address: plain.address, city: plain.city, state: plain.state, pincode: plain.pincode }, token });
}

// POST /api/customer/oauth/google
router.post('/oauth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Missing credential' });
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return res.status(503).json({ error: 'Google OAuth not configured' });
    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    const payload = ticket.getPayload();
    const cust = await oauthFindOrCreate(payload.email, payload.name, payload.picture);
    // Re-fetch with totp_enabled to enforce 2FA
    const { data: full } = await supabase.from('customers').select('*').eq('id', cust.id).single();
    oauthRespond(res, full || cust);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /api/customer/oauth/facebook
router.post('/oauth/facebook', async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) return res.status(400).json({ error: 'Missing accessToken' });
    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    if (!appId || !appSecret) return res.status(503).json({ error: 'Facebook OAuth not configured' });
    // Verify token with Facebook
    const verifyUrl = `https://graph.facebook.com/debug_token?input_token=${accessToken}&access_token=${appId}|${appSecret}`;
    const verifyRes = await fetch(verifyUrl);
    const verifyData = await verifyRes.json();
    if (!verifyData.data?.is_valid) return res.status(400).json({ error: 'Invalid Facebook token' });
    // Get user info
    const userRes = await fetch(`https://graph.facebook.com/me?fields=id,name,email,picture&access_token=${accessToken}`);
    const fbUser = await userRes.json();
    if (!fbUser.email) return res.status(400).json({ error: 'Facebook account has no email. Please use email signup instead.' });
    const cust = await oauthFindOrCreate(fbUser.email, fbUser.name, fbUser.picture?.data?.url);
    // Re-fetch with totp_enabled to enforce 2FA
    const { data: full } = await supabase.from('customers').select('*').eq('id', cust.id).single();
    oauthRespond(res, full || cust);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /api/customer/me
router.get('/me', custAuth, async (req, res) => {
  const { data } = await supabase.from('customers').select('id,name,email,phone,address,city,state,pincode,birthday').eq('id', req.customer.id).single();
  res.json(data ? decryptCustomer(data) : {});
});

// GET /api/customer/orders
router.get('/orders', custAuth, async (req, res) => {
  try {
    const eHash = hmac(req.customer.email);
    const { data } = await supabase.from('webstore_orders')
      .select('*')
      .eq('customer_email_hash', eHash)
      .order('created_at', { ascending: false });
    // Decrypt customer JSONB in each order before returning
    const { decryptCustomer: dc } = require('../config/crypto');
    const orders = (data || []).map(o => ({
      ...o,
      customer: o.customer ? dc(o.customer) : o.customer,
    }));
    res.json(orders);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/customer/update
router.post('/update', custAuth, async (req, res) => {
  try {
    const { name, phone, address, city, state, pincode, birthday } = req.body;
    const updates = {};
    if (name)    updates.name    = encrypt(name.trim());
    if (phone)   updates.phone   = encrypt(phone);
    if (address) updates.address = encrypt(address);
    if (city)    updates.city    = encrypt(city);
    if (state)   updates.state   = encrypt(state);
    if (pincode) updates.pincode = encrypt(pincode);
    if (birthday) updates.birthday = birthday; // stored as YYYY-MM-DD, not PII
    const { data, error } = await supabase.from('customers').update(updates).eq('id', req.customer.id).select('id,name,email,phone,address,city,state,pincode,birthday').single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ customer: decryptCustomer(data) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/customer/cart — fetch saved cart for logged-in customer
router.get('/cart', custAuth, async (req, res) => {
  try {
    const sessionId = 'cust_' + req.customer.id;
    const { data } = await supabase.from('abandoned_carts').select('items').eq('session_id', sessionId).maybeSingle();
    res.json({ items: data?.items || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/customer/cart — save cart for logged-in customer
router.post('/cart', custAuth, async (req, res) => {
  try {
    const { items } = req.body;
    const sessionId = 'cust_' + req.customer.id;
    if (!items || items.length === 0) {
      await supabase.from('abandoned_carts').delete().eq('session_id', sessionId);
    } else {
      await supabase.from('abandoned_carts').upsert(
        { session_id: sessionId, items, updated_at: new Date().toISOString() },
        { onConflict: 'session_id' }
      );
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/customer/wishlist — fetch saved wishlist for logged-in customer
router.get('/wishlist', custAuth, async (req, res) => {
  try {
    const key = 'cust_wishlist_' + req.customer.id;
    const { data } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
    res.json({ items: data?.value || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/customer/wishlist — save wishlist for logged-in customer
router.post('/wishlist', custAuth, async (req, res) => {
  try {
    const { items } = req.body;
    const key = 'cust_wishlist_' + req.customer.id;
    await supabase.from('settings').upsert({ key, value: items || [] }, { onConflict: 'key' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── LOYALTY POINTS ─────────────────────────────────────────────────────────

// GET /api/customer/loyalty — get points balance
router.get('/loyalty', custAuth, async (req, res) => {
  try {
    const key = `cust_loyalty_${req.customer.id}`;
    const { data } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
    const loyalty = data?.value || { points: 0, history: [] };
    res.json(loyalty);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/customer/loyalty/earn — earn points after order (called from frontend)
router.post('/loyalty/earn', custAuth, async (req, res) => {
  try {
    const { order_total, order_no } = req.body;
    if (!order_total || !order_no) return res.status(400).json({ error: 'order_total and order_no required' });
    const key = `cust_loyalty_${req.customer.id}`;
    const { data } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
    const loyalty = data?.value || { points: 0, history: [] };
    const earned = Math.floor(order_total / 100); // 1 point per ₹100
    loyalty.points = (loyalty.points || 0) + earned;
    loyalty.history = [{ type: 'earn', points: earned, order_no, date: new Date().toISOString().slice(0, 10) }, ...(loyalty.history || [])].slice(0, 50);
    await supabase.from('settings').upsert({ key, value: loyalty }, { onConflict: 'key' });
    res.json({ ok: true, earned, total: loyalty.points });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/customer/loyalty/redeem — redeem points at checkout
router.post('/loyalty/redeem', custAuth, async (req, res) => {
  try {
    const { points, order_no } = req.body;
    if (!points || points <= 0) return res.status(400).json({ error: 'points required' });
    const key = `cust_loyalty_${req.customer.id}`;
    const { data } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
    const loyalty = data?.value || { points: 0, history: [] };
    if ((loyalty.points || 0) < points) return res.status(400).json({ error: 'Insufficient points' });
    const discount = Math.floor(points / 2); // 2 points = ₹1 discount
    loyalty.points = (loyalty.points || 0) - points;
    loyalty.history = [{ type: 'redeem', points: -points, discount, order_no, date: new Date().toISOString().slice(0, 10) }, ...(loyalty.history || [])].slice(0, 50);
    await supabase.from('settings').upsert({ key, value: loyalty }, { onConflict: 'key' });
    res.json({ ok: true, discount, remaining: loyalty.points });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── REFERRAL PROGRAM ───────────────────────────────────────────────────────

// GET /api/customer/referral — get or generate referral code
router.get('/referral', custAuth, async (req, res) => {
  try {
    const key = `cust_referral_${req.customer.id}`;
    const { data } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
    if (data?.value) return res.json(data.value);
    // Generate unique code
    const code = 'SAT' + req.customer.name.split(' ')[0].toUpperCase().slice(0, 5) + Math.random().toString(36).slice(2, 6).toUpperCase();
    const referral = { code, referred_count: 0, discount_earned: 0, created_at: new Date().toISOString() };
    await supabase.from('settings').upsert({ key, value: referral }, { onConflict: 'key' });
    // Also index by code for lookup
    await supabase.from('settings').upsert({ key: `ref_code_${code}`, value: { customer_id: req.customer.id, customer_name: req.customer.name } }, { onConflict: 'key' });
    res.json(referral);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/customer/referral/validate — validate a referral code at signup (public, no auth)
router.post('/referral/validate', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'code required' });
    const { data } = await supabase.from('settings').select('value').eq('key', `ref_code_${code.toUpperCase()}`).maybeSingle();
    if (!data?.value) return res.status(404).json({ error: 'Invalid referral code' });
    res.json({ valid: true, discount: 100, code: code.toUpperCase() }); // ₹100 discount for using referral
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/customer/cart-reminder — send cart abandonment email to logged-in customer
router.post('/cart-reminder', custAuth, async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !items.length) return res.json({ ok: true });
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return res.json({ ok: true });

    // Fetch fresh customer record to get email and name
    const { data: custRaw } = await supabase.from('customers')
      .select('name,email').eq('id', req.customer.id).maybeSingle();
    if (!custRaw?.email) return res.json({ ok: true });
    const cust = decryptCustomer(custRaw);

    const firstName = (cust.name || 'there').split(' ')[0];
    const rows = items.map(i =>
      `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6">${i.name}</td>
        <td style="padding:8px 12px;text-align:center;border-bottom:1px solid #f3f4f6">${i.qty}</td>
        <td style="padding:8px 12px;text-align:right;border-bottom:1px solid #f3f4f6;font-weight:700">₹${((i.qty||1)*(i.price||0)).toLocaleString('en-IN')}</td>
      </tr>`
    ).join('');
    const total = items.reduce((s, i) => s + (i.qty||1)*(i.price||0), 0);

    const html = `
<div style="font-family:sans-serif;max-width:540px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
  <div style="background:linear-gradient(135deg,#2d1a0e,#5c3317);color:#fff;padding:24px 28px">
    <div style="font-size:22px;font-weight:800;margin-bottom:4px">🛒 You left something behind!</div>
    <div style="font-size:14px;opacity:0.85">Hi ${firstName}, your cart is waiting for you at Sathvam Natural Products</div>
  </div>
  <div style="padding:24px 28px">
    <p style="color:#374151;font-size:15px;margin-top:0">We noticed you added items to your cart but haven't completed your order. Your fresh, cold-pressed goodness is just a click away! 🌿</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f9fafb;border-radius:8px;overflow:hidden">
      <thead>
        <tr style="background:#f3f4f6">
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280">ITEM</th>
          <th style="padding:8px 12px;text-align:center;font-size:12px;color:#6b7280">QTY</th>
          <th style="padding:8px 12px;text-align:right;font-size:12px;color:#6b7280">AMOUNT</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="text-align:right;font-size:16px;font-weight:800;color:#1f2937">Total: ₹${total.toLocaleString('en-IN')}</p>
    <div style="text-align:center;margin:24px 0">
      <a href="https://sathvam.in" style="background:linear-gradient(135deg,#2d1a0e,#5c3317);color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-size:16px;font-weight:700;display:inline-block">Complete My Order →</a>
    </div>
    <p style="color:#9ca3af;font-size:12px;text-align:center">Questions? Reply to this email or call us at +91 70921 77092.<br>Sathvam Natural Products — Pure. Natural. Cold-pressed.</p>
  </div>
</div>`;

    await mailer.sendMail({
      from: process.env.SMTP_FROM || 'Sathvam Natural Products <noreply@sathvam.in>',
      replyTo: process.env.SMTP_REPLY_TO || 'sales@sathvam.in',
      to: cust.email,
      subject: `${firstName}, your cart is waiting 🛒 — Sathvam Natural Products`,
      html,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('cart-reminder email:', err.message);
    res.json({ ok: true }); // always 200 — frontend doesn't need to know
  }
});

// POST /api/customer/logout — clear httpOnly cookie
router.post('/logout', (req, res) => {
  res.clearCookie('sathvam_cust', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' });
  res.json({ ok: true });
});

// 2FA routes — /api/customer/2fa/* (cookie + token returned for mobile backward compat)
const { router: twoFARouter } = make2FA(supabase, 'customers', custAuth, {
  name: 'sathvam_cust',
  opts: CUST_COOKIE_OPTS,
  returnToken: true,
});
router.use('/2fa', twoFARouter);

// GET /api/customer/admin/list — admin: list all registered customers
const { auth } = require('../middleware/auth');
router.get('/admin/list', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('id, name, email, phone, city, state, pincode, created_at, totp_enabled')
      .order('created_at', { ascending: false });
    if (error) throw error;
    const decrypted = (data || []).map(c => decryptCustomer(c));
    res.json(decrypted);
  } catch (err) {
    console.error('admin/list customers:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
