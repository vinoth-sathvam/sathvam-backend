const express   = require('express');
const supabase  = require('../config/supabase');
const { auth }  = require('../middleware/auth');
const rateLimit = require('express-rate-limit');
const router    = express.Router();

const reviewLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: 'Too many review submissions. Please try again later.' },
  validate: { xForwardedForHeader: false },
});

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

// Admin: update order status + dispatch info
router.put('/:id', auth, async (req, res) => {
  const { status, notes, courier, awb_number, dispatch_date, delivered_date } = req.body;
  const updates = {};
  if (status         !== undefined) updates.status         = status;
  if (notes          !== undefined) updates.notes          = notes;
  if (courier        !== undefined) updates.courier        = courier;
  if (awb_number     !== undefined) updates.awb_number     = awb_number;
  if (dispatch_date  !== undefined) updates.dispatch_date  = dispatch_date;
  if (delivered_date !== undefined) updates.delivered_date = delivered_date;
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

// ── Product Reviews ──────────────────────────────────────────────────────────

// GET /api/webstore-orders/reviews — list all reviews (admin)
router.get('/reviews', auth, async (req, res) => {
  try {
    const { product_id, status, limit = 200 } = req.query;
    let q = supabase.from('product_reviews')
      .select('*').order('created_at', { ascending: false }).limit(parseInt(limit));
    if (product_id) q = q.eq('product_id', product_id);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/webstore-orders/reviews/public/:product_id — public approved reviews
router.get('/reviews/public/:product_id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('product_reviews')
      .select('id,reviewer_name,rating,title,body,created_at')
      .eq('product_id', req.params.product_id)
      .eq('status', 'approved')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/webstore-orders/reviews — submit review (public, rate limited)
router.post('/reviews', reviewLimiter, async (req, res) => {
  try {
    const { product_id, product_name, order_id, reviewer_name, reviewer_email, rating, title, body } = req.body;
    if (!product_id || !rating || !reviewer_name) return res.status(400).json({ error: 'product_id, rating, reviewer_name required' });
    if (reviewer_name.length > 100) return res.status(400).json({ error: 'Name too long' });
    if (title && title.length > 200) return res.status(400).json({ error: 'Title too long' });
    if (body && body.length > 2000) return res.status(400).json({ error: 'Review too long' });
    const { data, error } = await supabase.from('product_reviews')
      .insert({ product_id, product_name: product_name || '', order_id: order_id || null, reviewer_name, reviewer_email: reviewer_email || '', rating: Math.min(5, Math.max(1, parseInt(rating))), title: title || '', body: body || '', status: 'pending' })
      .select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/webstore-orders/reviews/:id — approve/reject (admin)
router.patch('/reviews/:id', auth, async (req, res) => {
  try {
    const { status, admin_reply } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (status !== undefined) updates.status = status;
    if (admin_reply !== undefined) updates.admin_reply = admin_reply;
    const { data, error } = await supabase.from('product_reviews')
      .update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Customer CRM ─────────────────────────────────────────────────────────────

// GET /api/webstore-orders/crm — customer list with order stats
router.get('/crm', auth, async (req, res) => {
  try {
    const { data: orders, error } = await supabase.from('webstore_orders')
      .select('customer_name,customer_phone,customer_email,total_amount,status,created_at')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    const customers = {};
    for (const o of orders || []) {
      const key = o.customer_phone || o.customer_email || o.customer_name;
      if (!key) continue;
      if (!customers[key]) {
        customers[key] = { name: o.customer_name, phone: o.customer_phone, email: o.customer_email, orders: 0, total_spent: 0, first_order: o.created_at, last_order: o.created_at };
      }
      customers[key].orders++;
      if (o.status !== 'cancelled') customers[key].total_spent += (o.total_amount || 0);
      if (o.created_at > customers[key].last_order) customers[key].last_order = o.created_at;
      if (o.created_at < customers[key].first_order) customers[key].first_order = o.created_at;
    }
    const list = Object.values(customers).sort((a, b) => b.total_spent - a.total_spent);
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
