const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');

// GET /api/delivery — list delivery runs
router.get('/', auth, async (req, res) => {
  try {
    const { status, date, limit = 100 } = req.query;
    let q = supabase.from('delivery_runs')
      .select('*, delivery_run_items(*)').order('delivery_date', { ascending: false }).limit(parseInt(limit));
    if (status) q = q.eq('status', status);
    if (date) q = q.eq('delivery_date', date);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/delivery — create delivery run
router.post('/', auth, async (req, res) => {
  try {
    const { delivery_date, driver_name, driver_phone, vehicle_number, orders } = req.body;
    if (!delivery_date || !orders?.length) return res.status(400).json({ error: 'Missing fields' });
    const { data: run, error: runErr } = await supabase.from('delivery_runs')
      .insert({ delivery_date, driver_name: driver_name || '', driver_phone: driver_phone || '', vehicle_number: vehicle_number || '', total_orders: orders.length, status: 'pending' })
      .select().single();
    if (runErr) return res.status(400).json({ error: runErr.message });
    const items = orders.map((o, i) => ({
      run_id: run.id,
      order_id: o.order_id,
      order_number: o.order_number || '',
      customer_name: o.customer_name || '',
      customer_address: o.customer_address || '',
      customer_phone: o.customer_phone || '',
      sequence: i + 1,
      status: 'pending',
    }));
    const { error: itemErr } = await supabase.from('delivery_run_items').insert(items);
    if (itemErr) return res.status(400).json({ error: itemErr.message });
    res.json(run);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/delivery/:id — update run status
router.patch('/:id', auth, async (req, res) => {
  try {
    const { status, notes } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (status) updates.status = status;
    if (notes !== undefined) updates.notes = notes;
    if (status === 'completed') updates.completed_at = new Date().toISOString();
    const { data, error } = await supabase.from('delivery_runs')
      .update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/delivery/item/:id — update single delivery item
router.patch('/item/:id', auth, async (req, res) => {
  try {
    const { status, notes, delivered_at } = req.body;
    const updates = {};
    if (status) updates.status = status;
    if (notes !== undefined) updates.notes = notes;
    if (status === 'delivered') updates.delivered_at = delivered_at || new Date().toISOString();
    const { data, error } = await supabase.from('delivery_run_items')
      .update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/delivery/pending-orders — orders ready to dispatch
router.get('/pending-orders', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('webstore_orders')
      .select('id,order_number,customer_name,customer_phone,shipping_address,total_amount,status')
      .in('status', ['paid', 'processing'])
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
