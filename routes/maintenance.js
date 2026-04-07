const express = require('express');
const router  = express.Router();
const { auth, requireRole } = require('../middleware/auth');
const supabase = require('../config/supabase');

const DEFAULT_MACHINES = [
  { machine_name: 'Oil Press #1',     machine_type: 'oil_press' },
  { machine_name: 'Oil Press #2',     machine_type: 'oil_press' },
  { machine_name: 'Flour Mill #1',    machine_type: 'flour_mill' },
  { machine_name: 'Packaging Machine',machine_type: 'packaging' },
  { machine_name: 'Generator',        machine_type: 'other' },
];

// GET all records
router.get('/', auth, async (req, res) => {
  const { upcoming } = req.query;
  let q = supabase.from('machine_maintenance').select('*').order('date', { ascending: false });
  if (upcoming === 'true') {
    const in30 = new Date(); in30.setDate(in30.getDate() + 30);
    q = supabase.from('machine_maintenance').select('*')
      .lte('next_due_date', in30.toISOString().slice(0,10))
      .not('next_due_date', 'is', null)
      .order('next_due_date', { ascending: true });
  }
  const { data, error } = await q.limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET summary — last maintenance + next due per machine
router.get('/summary', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('machine_maintenance')
    .select('*')
    .order('date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const machines = {};
  for (const r of (data || [])) {
    if (!machines[r.machine_name]) machines[r.machine_name] = { machine_name: r.machine_name, machine_type: r.machine_type, last_date: r.date, next_due_date: r.next_due_date, status: r.status, total_cost: 0, count: 0 };
    machines[r.machine_name].total_cost += parseFloat(r.cost || 0);
    machines[r.machine_name].count++;
  }
  res.json(Object.values(machines));
});

// POST create
router.post('/', auth, requireRole('admin','manager'), async (req, res) => {
  const { machine_name, machine_type, maintenance_type, date, next_due_date, cost, vendor_name, description, status } = req.body;
  if (!machine_name || !date) return res.status(400).json({ error: 'machine_name and date required' });
  const { data, error } = await supabase.from('machine_maintenance').insert({
    machine_name: machine_name.trim(),
    machine_type: machine_type || 'other',
    maintenance_type: maintenance_type || 'preventive',
    date,
    next_due_date: next_due_date || null,
    cost: parseFloat(cost) || 0,
    vendor_name: vendor_name || '',
    description: description || '',
    status: status || 'done',
    created_by: req.user?.name || req.user?.email || '',
    created_at: new Date().toISOString(),
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PUT update
router.put('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  const fields = ['machine_name','machine_type','maintenance_type','date','next_due_date','cost','vendor_name','description','status'];
  const u = {};
  fields.forEach(f => { if (req.body[f] != null) u[f] = req.body[f]; });
  if (u.cost != null) u.cost = parseFloat(u.cost);
  const { data, error } = await supabase.from('machine_maintenance').update(u).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE
router.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  await supabase.from('machine_maintenance').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
