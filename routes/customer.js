const express  = require('express');
const supabase  = require('../config/supabase');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const make2FA   = require('./twoFactor');
const router    = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('FATAL: JWT_SECRET not set'); process.exit(1); }

const custAuth = (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try { req.customer = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Session expired. Please login again.' }); }
};

// POST /api/customer/signup
router.post('/signup', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
    const { data: existing } = await supabase.from('customers').select('id').eq('email', email.toLowerCase().trim()).maybeSingle();
    if (existing) return res.status(400).json({ error: 'Email already registered. Please login.' });
    const hash = password ? await bcrypt.hash(password, 10) : null;
    const { data: cust, error } = await supabase.from('customers')
      .insert({ name: name.trim(), email: email.toLowerCase().trim(), phone: phone||null, password_hash: hash })
      .select('id,name,email,phone,address,city,state,pincode').single();
    if (error) return res.status(400).json({ error: error.message });
    const token = jwt.sign({ id: cust.id, email: cust.email, name: cust.name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ customer: cust, token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/customer/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const { data: cust } = await supabase.from('customers').select('*').eq('email', email.toLowerCase().trim()).maybeSingle();
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

    const token = jwt.sign({ id: cust.id, email: cust.email, name: cust.name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ customer: { id: cust.id, name: cust.name, email: cust.email, phone: cust.phone, address: cust.address, city: cust.city, state: cust.state, pincode: cust.pincode }, token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Helper — find or create customer by email+name (used by OAuth)
async function oauthFindOrCreate(email, name, avatarUrl) {
  const { data: existing } = await supabase.from('customers').select('id,name,email,phone,address,city,state,pincode').eq('email', email).maybeSingle();
  if (existing) return existing;
  const { data: created, error } = await supabase.from('customers')
    .insert({ name, email, avatar_url: avatarUrl || null })
    .select('id,name,email,phone,address,city,state,pincode').single();
  if (error) throw new Error(error.message);
  return created;
}

// Helper — check 2FA and return pre-auth token or full JWT
function oauthRespond(res, cust) {
  if (cust.totp_enabled) {
    const { issuePreAuthToken } = require('./twoFactor');
    const preAuthToken = issuePreAuthToken({ id: cust.id });
    return res.json({ requiresTOTP: true, preAuthToken });
  }
  const token = jwt.sign({ id: cust.id, email: cust.email, name: cust.name }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ customer: { id: cust.id, name: cust.name, email: cust.email, phone: cust.phone, address: cust.address, city: cust.city, state: cust.state, pincode: cust.pincode }, token });
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
  const { data } = await supabase.from('customers').select('id,name,email,phone,address,city,state,pincode').eq('id', req.customer.id).single();
  res.json(data || {});
});

// GET /api/customer/orders
router.get('/orders', custAuth, async (req, res) => {
  try {
    const { data } = await supabase.from('webstore_orders')
      .select('*')
      .filter('customer->>email', 'eq', req.customer.email)
      .order('created_at', { ascending: false });
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/customer/update
router.post('/update', custAuth, async (req, res) => {
  try {
    const { name, phone, address, city, state, pincode } = req.body;
    const updates = {};
    if (name)    updates.name    = name.trim();
    if (phone)   updates.phone   = phone;
    if (address) updates.address = address;
    if (city)    updates.city    = city;
    if (state)   updates.state   = state;
    if (pincode) updates.pincode = pincode;
    const { data, error } = await supabase.from('customers').update(updates).eq('id', req.customer.id).select('id,name,email,phone,address,city,state,pincode').single();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ customer: data });
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
    res.json({ valid: true, discount: 50, code: code.toUpperCase() }); // ₹50 discount for using referral
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2FA routes — /api/customer/2fa/*
const { router: twoFARouter } = make2FA(supabase, 'customers', custAuth, null);
router.use('/2fa', twoFARouter);

module.exports = router;
