const express = require('express');
const router  = express.Router();
const { auth, requireRole } = require('../middleware/auth');
const supabase = require('../config/supabase');

// ── Employees ─────────────────────────────────────────────────────────────────

// GET /api/payroll/employees
router.get('/employees', auth, async (req, res) => {
  let q = supabase.from('employees').select('*').order('name');
  if (req.query.include_inactive !== 'true') q = q.eq('active', true);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST /api/payroll/employees
router.post('/employees', auth, requireRole('admin','manager'), async (req, res) => {
  const { name, phone, role, daily_rate } = req.body;
  if (!name || !daily_rate) return res.status(400).json({ error: 'name and daily_rate are required' });
  const { data, error } = await supabase.from('employees').insert({
    name: name.trim(),
    phone: phone || '',
    role: role || '',
    daily_rate: parseFloat(daily_rate) || 0,
    active: true,
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/payroll/employees/:id
router.put('/employees/:id', auth, requireRole('admin','manager'), async (req, res) => {
  const { name, phone, role, daily_rate, active } = req.body;
  const updates = {};
  if (name       != null) updates.name       = name.trim();
  if (phone      != null) updates.phone      = phone;
  if (role       != null) updates.role       = role;
  if (daily_rate != null) updates.daily_rate = parseFloat(daily_rate) || 0;
  if (active     != null) updates.active     = active;
  const { data, error } = await supabase.from('employees').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// DELETE /api/payroll/employees/:id  (soft delete)
router.delete('/employees/:id', auth, requireRole('admin'), async (req, res) => {
  const { error } = await supabase.from('employees').update({ active: false }).eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// ── Attendance ────────────────────────────────────────────────────────────────

// GET /api/payroll/attendance?date=YYYY-MM-DD
router.get('/attendance', auth, async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const [{ data: emps }, { data: att }] = await Promise.all([
    supabase.from('employees').select('id,name,role,daily_rate').eq('active', true).order('name'),
    supabase.from('attendance').select('employee_id,status,notes').eq('date', date),
  ]);
  const attMap = {};
  for (const a of att || []) attMap[a.employee_id] = { status: a.status, notes: a.notes || '' };
  // Return employees merged with their attendance status for this date
  const result = (emps || []).map(e => ({
    ...e,
    status: attMap[e.id]?.status || null,
    notes:  attMap[e.id]?.notes  || '',
  }));
  res.json({ date, employees: result });
});

// POST /api/payroll/attendance  — bulk upsert for a day
router.post('/attendance', auth, requireRole('admin','manager'), async (req, res) => {
  const rows = req.body; // array of { employee_id, date, status, notes }
  if (!Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ error: 'Expected array of attendance records' });

  const valid = rows.filter(r => r.employee_id && r.date && ['present','absent','half_day'].includes(r.status));
  if (valid.length === 0) return res.status(400).json({ error: 'No valid records' });

  const { error } = await supabase.from('attendance').upsert(
    valid.map(r => ({ employee_id: r.employee_id, date: r.date, status: r.status, notes: r.notes || '' })),
    { onConflict: 'employee_id,date' }
  );
  if (error) return res.status(400).json({ error: error.message });
  res.json({ saved: valid.length });
});

// ── Monthly Report ────────────────────────────────────────────────────────────

// GET /api/payroll/report?year=2026&month=4
router.get('/report', auth, async (req, res) => {
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const month = parseInt(req.query.month) || (new Date().getMonth() + 1);

  const start = `${year}-${String(month).padStart(2,'0')}-01`;
  const end   = new Date(year, month, 0).toISOString().slice(0, 10); // last day of month
  const daysInMonth = new Date(year, month, 0).getDate();

  // Fetch all employees (including inactive — they may have records this month)
  const { data: emps, error: empErr } = await supabase.from('employees').select('id,name,role,daily_rate,active').order('name');
  if (empErr) return res.status(500).json({ error: empErr.message });

  // Fetch all attendance records for the month
  const { data: att, error: attErr } = await supabase.from('attendance').select('employee_id,date,status').gte('date', start).lte('date', end);
  if (attErr) return res.status(500).json({ error: attErr.message });

  // Aggregate per employee
  const attByEmp = {};
  for (const a of att || []) {
    if (!attByEmp[a.employee_id]) attByEmp[a.employee_id] = { present: 0, absent: 0, half_day: 0 };
    if (a.status === 'present')  attByEmp[a.employee_id].present++;
    if (a.status === 'absent')   attByEmp[a.employee_id].absent++;
    if (a.status === 'half_day') attByEmp[a.employee_id].half_day++;
  }

  // Build report rows — include employees with records even if now inactive
  const empIdsWithRecords = new Set(Object.keys(attByEmp).map(Number));
  const reportEmps = (emps || []).filter(e => e.active || empIdsWithRecords.has(e.id));

  const rows = reportEmps.map(e => {
    const rec       = attByEmp[e.id] || { present: 0, absent: 0, half_day: 0 };
    const recorded  = rec.present + rec.absent + rec.half_day;
    const salary    = Math.round(((rec.present + rec.half_day * 0.5) * e.daily_rate) * 100) / 100;
    return {
      employee_id:  e.id,
      name:         e.name,
      role:         e.role || '',
      daily_rate:   e.daily_rate,
      days_present: rec.present,
      days_half:    rec.half_day,
      days_absent:  rec.absent,
      days_recorded: recorded,
      days_in_month: daysInMonth,
      salary,
    };
  });

  const totals = {
    total_salary:  Math.round(rows.reduce((s, r) => s + r.salary, 0) * 100) / 100,
    total_present: rows.reduce((s, r) => s + r.days_present, 0),
    total_absent:  rows.reduce((s, r) => s + r.days_absent, 0),
    total_half:    rows.reduce((s, r) => s + r.days_half, 0),
  };

  res.json({ year, month, start, end, days_in_month: daysInMonth, employees: rows, totals });
});

module.exports = router;
