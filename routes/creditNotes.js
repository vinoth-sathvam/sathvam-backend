const express  = require('express');
const router   = express.Router();
const supabase  = require('../config/supabase');
const { auth, requireRole } = require('../middleware/auth');

// Generate next CN number  e.g. CN-2026-0042
async function nextCnNumber() {
  const year = new Date().getFullYear();
  const { count } = await supabase
    .from('credit_notes')
    .select('id', { count: 'exact', head: true })
    .like('cn_number', `CN-${year}-%`);
  const seq = (count || 0) + 1;
  return `CN-${year}-${String(seq).padStart(4, '0')}`;
}

// GET /api/credit-notes  — list
router.get('/', auth, async (req, res) => {
  try {
    const { status, limit = 200, search } = req.query;
    let q = supabase.from('credit_notes').select('*').order('date', { ascending: false }).limit(parseInt(limit));
    if (status && status !== 'all') q = q.eq('status', status);
    if (search) q = q.or(`cn_number.ilike.%${search}%,customer_name.ilike.%${search}%,order_ref.ilike.%${search}%`);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/credit-notes/stats
router.get('/stats', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('credit_notes').select('status,total');
    const stats = { draft: 0, issued: 0, adjusted: 0, void: 0, total_amount: 0 };
    for (const r of data || []) {
      stats[r.status] = (stats[r.status] || 0) + 1;
      if (r.status !== 'void') stats.total_amount += parseFloat(r.total || 0);
    }
    res.json(stats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/credit-notes/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('credit_notes').select('*').eq('id', req.params.id).single();
    if (error || !data) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/credit-notes  — create
router.post('/', auth, requireRole('admin', 'manager', 'ceo'), async (req, res) => {
  try {
    const b = req.body;
    const cn_number = b.cnNumber || await nextCnNumber();
    const items = b.items || [];
    const subtotal = items.reduce((s, it) => s + parseFloat(it.amount || 0), 0);
    const gst_amount = items.reduce((s, it) => s + parseFloat(it.amount || 0) * parseFloat(it.gst_pct || 0) / 100, 0);
    const total = subtotal + gst_amount;

    const { data, error } = await supabase.from('credit_notes').insert({
      cn_number,
      date:           b.date || new Date().toISOString().slice(0, 10),
      order_ref:      b.orderRef || null,
      order_id:       b.orderId  || null,
      customer_name:  b.customerName,
      customer_phone: b.customerPhone || null,
      customer_email: b.customerEmail || null,
      gstin:          b.gstin || null,
      reason:         b.reason || 'other',
      items,
      subtotal,
      gst_amount,
      total,
      status:         b.status || 'draft',
      notes:          b.notes || null,
      created_by:     req.user?.name || req.user?.username || 'Admin',
    }).select().single();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/credit-notes/:id  — update status / notes
router.patch('/:id', auth, requireRole('admin', 'manager', 'ceo'), async (req, res) => {
  try {
    const b = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (b.status  !== undefined) updates.status  = b.status;
    if (b.notes   !== undefined) updates.notes   = b.notes;
    if (b.items   !== undefined) {
      updates.items      = b.items;
      updates.subtotal   = b.items.reduce((s, it) => s + parseFloat(it.amount || 0), 0);
      updates.gst_amount = b.items.reduce((s, it) => s + parseFloat(it.amount || 0) * parseFloat(it.gst_pct || 0) / 100, 0);
      updates.total      = updates.subtotal + updates.gst_amount;
    }
    const { data, error } = await supabase.from('credit_notes').update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/credit-notes/:id  — void only (admin)
router.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    const { error } = await supabase.from('credit_notes').update({ status: 'void', updated_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ message: 'Credit note voided' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
