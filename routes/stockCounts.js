const express  = require('express');
const router   = express.Router();
const supabase = require('../config/supabase');
const { auth, requireRole } = require('../middleware/auth');

// GET /api/stock-counts — list sessions
router.get('/', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('stock_count_sessions')
      .select('id,count_date,status,notes,created_by,closed_at,created_at')
      .order('count_date', { ascending: false })
      .limit(50);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/stock-counts/:id — session with items
router.get('/:id', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('stock_count_sessions')
      .select('*, stock_count_items(*)')
      .eq('id', req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/stock-counts — create session with items snapshot
router.post('/', auth, requireRole('admin', 'manager', 'ceo'), async (req, res) => {
  try {
    const { date, notes, items } = req.body;
    const { data: session, error } = await supabase
      .from('stock_count_sessions')
      .insert({
        count_date: date || new Date().toISOString().slice(0, 10),
        status: 'open',
        notes: notes || null,
        created_by: req.user?.name || req.user?.username || 'Admin',
      })
      .select()
      .single();
    if (error) return res.status(400).json({ error: error.message });

    if (items && items.length) {
      await supabase.from('stock_count_items').insert(
        items.map(it => ({
          session_id: session.id,
          product_name: it.product_name,
          system_qty: parseFloat(it.system_qty || 0),
          counted_qty: null,
          unit: it.unit || 'pcs',
        }))
      );
    }
    res.status(201).json(session);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/stock-counts/:id — save counted quantities + optional status update
router.patch('/:id', auth, requireRole('admin', 'manager', 'ceo'), async (req, res) => {
  try {
    const { status, notes, items } = req.body;

    if (items && items.length) {
      for (const it of items) {
        await supabase.from('stock_count_items')
          .update({ counted_qty: it.counted_qty != null ? parseFloat(it.counted_qty) : null })
          .eq('id', it.id);
      }
    }

    const updates = { updated_at: new Date().toISOString() };
    if (status !== undefined) updates.status = status;
    if (notes  !== undefined) updates.notes  = notes;
    if (status === 'closed')  updates.closed_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('stock_count_sessions')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/stock-counts/:id/apply — write variance entries to finished_goods
router.post('/:id/apply', auth, requireRole('admin', 'manager', 'ceo'), async (req, res) => {
  try {
    const { data: items } = await supabase
      .from('stock_count_items')
      .select('*')
      .eq('session_id', req.params.id);

    const today = new Date().toISOString().slice(0, 10);
    const shortId = req.params.id.slice(0, 8);
    let applied = 0;

    for (const it of items || []) {
      if (it.counted_qty == null) continue;
      const variance = parseFloat(it.counted_qty) - parseFloat(it.system_qty || 0);
      if (variance === 0) continue;

      await supabase.from('finished_goods').insert({
        product_name: it.product_name,
        category: 'adjustment',
        unit: it.unit || 'pcs',
        qty: Math.abs(variance),
        type: variance > 0 ? 'in' : 'out',
        date: today,
        notes: `Stock count adjustment (ref ${shortId})`,
        batch_ref: '',
      });
      applied++;
    }

    await supabase.from('stock_count_sessions')
      .update({ status: 'applied', closed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', req.params.id);

    res.json({ applied });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
