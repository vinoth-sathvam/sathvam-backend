const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');

// GET /api/compliance — list documents
router.get('/', auth, async (req, res) => {
  try {
    const { category, status, limit = 200 } = req.query;
    let q = supabase.from('compliance_documents')
      .select('*').order('expiry_date', { ascending: true }).limit(parseInt(limit));
    if (category) q = q.eq('category', category);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/compliance — add document
router.post('/', auth, async (req, res) => {
  try {
    const { title, category, document_number, issued_by, issue_date, expiry_date, file_url, notes } = req.body;
    if (!title || !category) return res.status(400).json({ error: 'title and category required' });
    // Auto-compute status
    let status = 'valid';
    if (expiry_date) {
      const daysLeft = Math.ceil((new Date(expiry_date) - new Date()) / 86400000);
      if (daysLeft < 0) status = 'expired';
      else if (daysLeft <= 30) status = 'expiring_soon';
    }
    const { data, error } = await supabase.from('compliance_documents')
      .insert({ title, category, document_number: document_number || '', issued_by: issued_by || '', issue_date: issue_date || null, expiry_date: expiry_date || null, file_url: file_url || '', notes: notes || '', status })
      .select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/compliance/:id — update document
router.patch('/:id', auth, async (req, res) => {
  try {
    const allowed = ['title','category','document_number','issued_by','issue_date','expiry_date','file_url','notes','status'];
    const updates = { updated_at: new Date().toISOString() };
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    // Recompute status if expiry changed
    if (updates.expiry_date) {
      const daysLeft = Math.ceil((new Date(updates.expiry_date) - new Date()) / 86400000);
      if (!updates.status) updates.status = daysLeft < 0 ? 'expired' : daysLeft <= 30 ? 'expiring_soon' : 'valid';
    }
    const { data, error } = await supabase.from('compliance_documents')
      .update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/compliance/:id
router.delete('/:id', auth, async (req, res) => {
  const { error } = await supabase.from('compliance_documents').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// GET /api/compliance/alerts — soon-to-expire or expired
router.get('/alerts', auth, async (req, res) => {
  try {
    const soon = new Date();
    soon.setDate(soon.getDate() + 60);
    const { data, error } = await supabase.from('compliance_documents')
      .select('id,title,category,expiry_date,status')
      .or(`status.eq.expired,status.eq.expiring_soon`)
      .order('expiry_date', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
