const express = require('express');
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');
const router = express.Router();

// Admin: list all webstore orders
router.get('/', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('webstore_orders')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(2000);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Admin: update order status
router.put('/:id', auth, async (req, res) => {
  const { status, notes } = req.body;
  const updates = {};
  if (status !== undefined) updates.status = status;
  if (notes !== undefined) updates.notes = notes;
  const { data, error } = await supabase
    .from('webstore_orders')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Bulk insert — used once to migrate existing localStorage data
router.post('/bulk', auth, async (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : [];
  if (rows.length === 0) return res.json({ synced: 0 });
  const ins = rows.map(o => ({
    id:       o.id,
    order_no: o.orderNo || o.order_no || '',
    date:     o.date || new Date().toISOString().slice(0, 10),
    customer: o.customer || {},
    items:    o.items || [],
    subtotal: parseFloat(o.subtotal) || 0,
    gst:      parseFloat(o.gst) || 0,
    shipping: parseFloat(o.shipping) || 0,
    total:    parseFloat(o.total) || 0,
    status:   o.status || 'confirmed',
    channel:  o.channel || 'website',
  }));
  const { data, error } = await supabase.from('webstore_orders').upsert(ins, { onConflict: 'id' }).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ synced: (data || []).length });
});

module.exports = router;
