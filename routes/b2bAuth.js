const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const supabase = require('../config/supabase');
const router = express.Router();

if (!process.env.MAGIC_LINK_SECRET) { console.error('FATAL: MAGIC_LINK_SECRET not set'); process.exit(1); }
const MAGIC_SECRET = process.env.MAGIC_LINK_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.sathvam.in';
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const B2B_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

// ── Email transporter ─────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendMagicLink(email, companyName, token) {
  const portalBase = process.env.PORTAL_URL || `${FRONTEND_URL}/portal`;
  const link = `${portalBase}?b2btoken=${token}`;
  await transporter.sendMail({
    from: process.env.SMTP_FROM || 'Sathvam Exports <noreply@sathvam.in>',
    to: email,
    subject: 'Your Sathvam B2B Portal Access Link',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#2d1a0e,#5c3317);padding:28px 32px">
          <div style="color:#f5a800;font-size:22px;font-weight:900;letter-spacing:2px">SATHVAM</div>
          <div style="color:rgba(255,255,255,0.7);font-size:12px;margin-top:4px">B2B International Portal</div>
        </div>
        <div style="padding:32px">
          <div style="font-size:16px;font-weight:700;color:#1f2937;margin-bottom:8px">Hello${companyName ? ', ' + companyName : ''}!</div>
          <div style="font-size:14px;color:#6b7280;margin-bottom:24px;line-height:1.6">
            Click the button below to securely access your B2B portal. This link expires in <strong>30 minutes</strong> and can only be used once.
          </div>
          <a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#2d1a0e,#5c3317);color:#fff;text-decoration:none;padding:14px 32px;border-radius:9px;font-weight:700;font-size:15px">
            🔐 Access B2B Portal
          </a>
          <div style="margin-top:24px;font-size:12px;color:#9ca3af;line-height:1.6">
            If you didn't request this link, you can safely ignore this email.<br/>
            <strong>Do not share this link</strong> — it provides direct access to your account.
          </div>
        </div>
        <div style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af">
          Sathvam Natural Products · export@sathvam.in · +91 70921 77092
        </div>
      </div>
    `,
  });
}

// ── POST /b2b/auth/signup ─────────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { companyName, contactName, email, phone, country, address, currency } = req.body;
    if (!companyName || !email) return res.status(400).json({ error: 'Company name and email are required' });
    if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email address' });

    const { data: existing } = await supabase.from('b2b_customers').select('id,company_name,active').eq('email', email.toLowerCase()).single();
    if (existing) {
      const token = jwt.sign({ email: email.toLowerCase(), type: 'b2b_magic' }, MAGIC_SECRET, { expiresIn: '30m' });
      await sendMagicLink(email, existing.company_name || companyName, token);
      return res.json({ message: 'Account already exists. A login link has been sent to your email.' });
    }

    const { data: cust, error } = await supabase.from('b2b_customers').insert({
      company_name: companyName,
      contact_name: contactName || '',
      email: email.toLowerCase(),
      phone: phone || '',
      country: country || '',
      address: address || '',
      currency: currency || 'INR',
      active: false,
      registered_date: new Date().toISOString().slice(0, 10),
    }).select('id,company_name').single();

    if (error) return res.status(400).json({ error: 'Registration failed. Please try again.' });

    const token = jwt.sign({ email: email.toLowerCase(), type: 'b2b_magic' }, MAGIC_SECRET, { expiresIn: '30m' });
    await sendMagicLink(email, companyName, token);

    res.status(201).json({ message: 'Account created! Check your email for the access link.' });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'Failed to send email. Please contact export@sathvam.in' });
  }
});

// ── POST /b2b/auth/request-link ───────────────────────────────────────────────
router.post('/request-link', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email address' });

    const { data: cust } = await supabase.from('b2b_customers').select('id,company_name,active').eq('email', email.toLowerCase()).single();
    if (!cust) return res.status(404).json({ error: 'No account found for this email. Please sign up first.' });
    if (!cust.active) return res.status(403).json({ error: 'Your account is pending approval. Please contact export@sathvam.in' });

    const token = jwt.sign({ email: email.toLowerCase(), type: 'b2b_magic' }, MAGIC_SECRET, { expiresIn: '30m' });
    await sendMagicLink(email, cust.company_name, token);

    res.json({ message: 'Login link sent! Check your email.' });
  } catch (err) {
    console.error('Request link error:', err.message);
    res.status(500).json({ error: 'Failed to send email. Please contact export@sathvam.in' });
  }
});

// ── GET /b2b/auth/verify ──────────────────────────────────────────────────────
// Verify magic link token; if no password set yet, prompt to set one
router.get('/verify', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token missing' });

    let payload;
    try {
      payload = jwt.verify(token, MAGIC_SECRET);
    } catch {
      return res.status(401).json({ error: 'Link expired or invalid. Please request a new one.' });
    }

    if (payload.type !== 'b2b_magic') return res.status(401).json({ error: 'Invalid token type' });

    const { data: cust, error } = await supabase
      .from('b2b_customers')
      .select('id,company_name,contact_name,email,country,currency,address,phone,active,password')
      .eq('email', payload.email)
      .single();

    if (error || !cust) return res.status(404).json({ error: 'Account not found' });
    if (!cust.active) return res.status(403).json({ error: 'Your account is pending approval. Please contact export@sathvam.in' });

    const customerData = {
      id: cust.id,
      companyName: cust.company_name,
      contactName: cust.contact_name,
      email: cust.email,
      country: cust.country,
      currency: cust.currency,
      address: cust.address,
      phone: cust.phone,
    };

    // No password set — return a short-lived token to set password
    if (!cust.password) {
      const setPwToken = jwt.sign(
        { id: cust.id, email: cust.email, type: 'b2b_set_password' },
        process.env.JWT_SECRET,
        { expiresIn: '15m' }
      );
      return res.json({ needsPassword: true, token: setPwToken, customer: customerData });
    }

    // Password already set — set session cookie
    const sessionToken = jwt.sign(
      { id: cust.id, email: cust.email, companyName: cust.company_name, contactName: cust.contact_name, type: 'b2b_customer' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.cookie('sathvam_b2b', sessionToken, B2B_COOKIE_OPTS);
    res.json({ customer: customerData });
  } catch (err) {
    console.error('Verify error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /b2b/auth/set-password ───────────────────────────────────────────────
// Set password after first-time magic link verification
router.post('/set-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Session expired. Please click the magic link again.' });
    }

    if (payload.type !== 'b2b_set_password') return res.status(401).json({ error: 'Invalid token' });

    const hash = await bcrypt.hash(password, 12);

    const { data: cust, error } = await supabase
      .from('b2b_customers')
      .update({ password: hash })
      .eq('id', payload.id)
      .select('id,company_name,contact_name,email,country,currency,address,phone')
      .single();

    if (error || !cust) return res.status(500).json({ error: 'Failed to set password' });

    const sessionToken = jwt.sign(
      { id: cust.id, email: cust.email, companyName: cust.company_name, contactName: cust.contact_name, type: 'b2b_customer' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.cookie('sathvam_b2b', sessionToken, B2B_COOKIE_OPTS);
    res.json({ customer: {
      id: cust.id,
      companyName: cust.company_name,
      contactName: cust.contact_name,
      email: cust.email,
      country: cust.country,
      currency: cust.currency,
      address: cust.address,
      phone: cust.phone,
    }});
  } catch (err) {
    console.error('Set password error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
