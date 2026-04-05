const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');
const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const { data: user, error } = await supabase.from('users').select('*').eq('username', username).eq('active', true).single();
    if (error || !user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign(
      { id: user.id, username: user.username, name: user.name, role: user.role },
      process.env.JWT_SECRET, { expiresIn: '7d' }
    );
    res.json({ token, user: { id: user.id, name: user.name, username: user.username, role: user.role } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/setup', async (req, res) => {
  try {
    const { data: existing } = await supabase.from('users').select('id').limit(1);
    if (existing?.length > 0) return res.status(400).json({ error: 'Setup already complete' });
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 12);
    const { data, error } = await supabase.from('users').insert({
      username: process.env.ADMIN_USERNAME || 'admin',
      name: process.env.ADMIN_NAME || 'Admin User',
      password: hash, role: 'admin', active: true
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Admin created!', username: data.username });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/me', auth, async (req, res) => {
  const { data, error } = await supabase.from('users').select('id,name,username,role,email').eq('id', req.user.id).single();
  if (error) return res.status(404).json({ error: 'User not found' });
  res.json(data);
});

router.post('/b2b-login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: cust, error } = await supabase.from('b2b_customers').select('*').eq('email', email).eq('active', true).single();
    if (error || !cust) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, cust.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign(
      { id: cust.id, email: cust.email, name: cust.contact_name, company: cust.company_name, type: 'b2b' },
      process.env.JWT_SECRET, { expiresIn: '7d' }
    );
    res.json({ token, customer: { id: cust.id, companyName: cust.company_name, contactName: cust.contact_name, email: cust.email } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
