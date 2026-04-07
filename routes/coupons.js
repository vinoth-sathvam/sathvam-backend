const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');

// GET /api/coupons — list coupons (admin)
router.get('/', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('coupons')
      .select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/coupons — create coupon (admin)
router.post('/', auth, async (req, res) => {
  try {
    const { code, type, value, min_order, max_uses, expires_at, description } = req.body;
    if (!code || !type || !value) return res.status(400).json({ error: 'code, type, value required' });
    const { data, error } = await supabase.from('coupons')
      .insert({ code: code.toUpperCase(), type, value, min_order: min_order || 0, max_uses: max_uses || null, uses_count: 0, expires_at: expires_at || null, description: description || '', active: true })
      .select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/coupons/:id — update coupon (admin)
router.patch('/:id', auth, async (req, res) => {
  try {
    const allowed = ['code','type','value','min_order','max_uses','expires_at','description','active'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    const { data, error } = await supabase.from('coupons')
      .update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/coupons/:id
router.delete('/:id', auth, async (req, res) => {
  const { error } = await supabase.from('coupons').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// POST /api/coupons/validate — public endpoint for webstore checkout
router.post('/validate', async (req, res) => {
  try {
    const { code, cart_total } = req.body;
    if (!code) return res.status(400).json({ error: 'Code required' });
    const { data: coupon, error } = await supabase.from('coupons')
      .select('*').eq('code', code.toUpperCase().trim()).eq('active', true).maybeSingle();
    if (error || !coupon) return res.status(404).json({ error: 'Invalid or expired coupon' });
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) return res.status(400).json({ error: 'Coupon has expired' });
    if (coupon.max_uses && coupon.uses_count >= coupon.max_uses) return res.status(400).json({ error: 'Coupon usage limit reached' });
    if (cart_total && coupon.min_order && cart_total < coupon.min_order) return res.status(400).json({ error: `Minimum order ₹${coupon.min_order} required` });
    // Calculate discount
    let discount = 0;
    if (coupon.type === 'percent') discount = Math.round((cart_total || 0) * coupon.value / 100);
    else discount = coupon.value;
    res.json({ valid: true, coupon, discount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/coupons/:id/redeem — record redemption
router.post('/:id/redeem', async (req, res) => {
  try {
    const { order_id, order_number, discount_applied } = req.body;
    await supabase.from('coupon_redemptions')
      .insert({ coupon_id: parseInt(req.params.id), order_id, order_number: order_number || '', discount_applied: discount_applied || 0 });
    await supabase.from('coupons').update({ uses_count: supabase.rpc ? undefined : undefined }).eq('id', req.params.id);
    // Increment uses_count
    const { data: c } = await supabase.from('coupons').select('uses_count').eq('id', req.params.id).single();
    await supabase.from('coupons').update({ uses_count: (c?.uses_count || 0) + 1 }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
