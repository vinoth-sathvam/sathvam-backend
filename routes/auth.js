const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');
const make2FA = require('./twoFactor');
const router = express.Router();

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const { data: user, error } = await supabase.from('users').select('*').eq('username', username).eq('active', true).single();
    if (error || !user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // 2FA — if enabled, return a short-lived pre-auth token instead of full session
    if (user.totp_enabled) {
      const { issuePreAuthToken } = require('./twoFactor');
      const preAuthToken = issuePreAuthToken({ id: user.id });
      return res.json({ requiresTOTP: true, preAuthToken });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, name: user.name, role: user.role },
      process.env.JWT_SECRET, { expiresIn: '7d' }
    );
    res.cookie('sathvam_admin', token, COOKIE_OPTS);
    res.json({ user: { id: user.id, name: user.name, username: user.username, role: user.role } });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.post('/logout', (req, res) => {
  res.clearCookie('sathvam_admin', { httpOnly: true, secure: COOKIE_OPTS.secure, sameSite: 'strict' });
  res.clearCookie('sathvam_b2b',   { httpOnly: true, secure: COOKIE_OPTS.secure, sameSite: 'strict' });
  res.json({ message: 'Logged out' });
});

// Setup endpoint permanently disabled — admin account already exists
router.post('/setup', (req, res) => res.status(410).json({ error: 'Gone' }));

// 2FA routes — /api/auth/2fa/*
const { router: twoFARouter } = make2FA(supabase, 'users', auth, {
  name: 'sathvam_admin',
  opts: COOKIE_OPTS,
});
router.use('/2fa', twoFARouter);

router.get('/me', auth, async (req, res) => {
  const { data, error } = await supabase.from('users').select('id,name,username,role,email').eq('id', req.user.id).single();
  if (error) return res.status(404).json({ error: 'User not found' });
  res.json(data);
});

router.post('/b2b-login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email address' });
    const { data: cust, error } = await supabase.from('b2b_customers').select('*').eq('email', email.toLowerCase()).eq('active', true).single();
    if (error || !cust) return res.status(401).json({ error: 'Invalid credentials' });
    if (!cust.password) return res.status(401).json({ error: 'Password not set. Please sign up again to receive a setup link.' });
    const valid = await bcrypt.compare(password, cust.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign(
      { id: cust.id, email: cust.email, companyName: cust.company_name, contactName: cust.contact_name, type: 'b2b_customer' },
      process.env.JWT_SECRET, { expiresIn: '7d' }
    );
    res.cookie('sathvam_b2b', token, COOKIE_OPTS);
    res.json({ customer: { id: cust.id, companyName: cust.company_name, contactName: cust.contact_name, email: cust.email, country: cust.country, currency: cust.currency, address: cust.address, phone: cust.phone } });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
