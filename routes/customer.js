const express  = require('express');
const supabase  = require('../config/supabase');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
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
    const token = jwt.sign({ id: cust.id, email: cust.email, name: cust.name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ customer: cust, token });
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
    const token = jwt.sign({ id: cust.id, email: cust.email, name: cust.name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ customer: cust, token });
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

module.exports = router;
