const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { auth, requireRole } = require('../middleware/auth');
const supabase = require('../config/supabase');

// ── Zoho Payroll token (separate scope from Books) ────────────────────────────
const PAYROLL_BASE = 'https://payroll.zoho.in/api/v1';
let _payToken = null, _payExpiry = 0;

async function getPayrollToken() {
  if (_payToken && Date.now() < _payExpiry) return _payToken;
  const refreshToken = process.env.ZOHO_PAYROLL_REFRESH_TOKEN || process.env.ZOHO_REFRESH_TOKEN;
  const res = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
    params: {
      grant_type:    'refresh_token',
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: refreshToken,
    },
  });
  if (!res.data.access_token) throw new Error('Failed to get Zoho Payroll token: ' + JSON.stringify(res.data));
  _payToken  = res.data.access_token;
  _payExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return _payToken;
}

async function payrollGet(path, params = {}) {
  const token = await getPayrollToken();
  const orgId = process.env.ZOHO_PAYROLL_ORG_ID || process.env.ZOHO_ORG_ID;
  const res = await axios.get(`${PAYROLL_BASE}${path}`, {
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'X-com-zoho-payroll-organizationid': orgId,
    },
    params,
  });
  return res.data;
}

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
    supabase.from('attendance').select('employee_id,status,notes,time_in,time_out,change_reason,last_changed_at,last_changed_by').eq('date', date),
  ]);
  const attMap = {};
  for (const a of att || []) attMap[a.employee_id] = a;
  const result = (emps || []).map(e => ({
    ...e,
    status:           attMap[e.id]?.status           || null,
    notes:            attMap[e.id]?.notes            || '',
    time_in:          attMap[e.id]?.time_in          || null,
    time_out:         attMap[e.id]?.time_out         || null,
    change_reason:    attMap[e.id]?.change_reason    || '',
    last_changed_at:  attMap[e.id]?.last_changed_at  || null,
    last_changed_by:  attMap[e.id]?.last_changed_by  || '',
    already_saved:    !!attMap[e.id],
  }));
  res.json({ date, employees: result });
});

// POST /api/payroll/attendance  — bulk upsert for a day
router.post('/attendance', auth, requireRole('admin','manager'), async (req, res) => {
  const rows = req.body; // array of { employee_id, date, status, notes, time_in, time_out, change_reason, is_change }
  if (!Array.isArray(rows) || rows.length === 0)
    return res.status(400).json({ error: 'Expected array of attendance records' });

  const valid = rows.filter(r => r.employee_id && r.date && ['present','absent','half_day'].includes(r.status));
  if (valid.length === 0) return res.status(400).json({ error: 'No valid records' });

  // Enforce change_reason for modified records
  const missingReason = valid.filter(r => r.is_change && !r.change_reason?.trim());
  if (missingReason.length > 0)
    return res.status(400).json({ error: 'Change reason required for modified attendance records', missing: missingReason.map(r => r.employee_id) });

  const now = new Date().toISOString();
  const { error } = await supabase.from('attendance').upsert(
    valid.map(r => ({
      employee_id:      r.employee_id,
      date:             r.date,
      status:           r.status,
      notes:            r.notes || '',
      time_in:          r.time_in  || null,
      time_out:         r.time_out || null,
      change_reason:    r.is_change ? (r.change_reason || '') : '',
      last_changed_at:  r.is_change ? now : null,
      last_changed_by:  r.is_change ? (req.user?.name || req.user?.email || '') : '',
    })),
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

// ── GET /api/payroll/zoho-employees — list from Zoho Payroll (preview) ────────
router.get('/zoho-employees', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    const data = await payrollGet('/employees', { page: 1, per_page: 200 });
    const emps = (data.employees || data.data || []).map(e => ({
      zoho_id:     e.employee_id,
      name:        [e.first_name, e.last_name].filter(Boolean).join(' ') || e.display_name || e.name || '',
      phone:       e.mobile || e.phone || '',
      designation: e.designation || e.job_title || '',
      department:  e.department || '',
      email:       e.email || '',
      status:      e.employment_status || e.status || '',
    }));
    res.json({ employees: emps, count: emps.length });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    const code = err.response?.data?.code;
    if (code === 57 || msg?.includes('not authorized')) {
      return res.status(403).json({
        error: 'Zoho Payroll scope not granted',
        fix: 'Regenerate OAuth token with ZohoPayroll.employees.READ scope — see instructions in admin panel',
      });
    }
    res.status(500).json({ error: msg });
  }
});

// ── POST /api/payroll/zoho-sync — import employees from Zoho Payroll ──────────
router.post('/zoho-sync', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    let page = 1, allEmps = [];
    while (true) {
      const data = await payrollGet('/employees', { page, per_page: 200 });
      const batch = data.employees || data.data || [];
      if (batch.length === 0) break;
      allEmps = allEmps.concat(batch);
      if (!data.page_context?.has_more_page) break;
      page++;
    }

    let inserted = 0, updated = 0, skipped = 0;
    for (const e of allEmps) {
      const name = [e.first_name, e.last_name].filter(Boolean).join(' ') || e.display_name || e.name || '';
      if (!name) { skipped++; continue; }

      const phone       = e.mobile || e.phone || '';
      const designation = e.designation || e.job_title || '';

      // Check if already exists by name (case-insensitive)
      const { data: existing } = await supabase.from('employees').select('id').ilike('name', name).single();

      if (existing) {
        await supabase.from('employees').update({ phone: phone||undefined, role: designation||undefined }).eq('id', existing.id);
        updated++;
      } else {
        await supabase.from('employees').insert({ name, phone, role: designation, daily_rate: 0, active: true });
        inserted++;
      }
    }

    res.json({ ok: true, total: allEmps.length, inserted, updated, skipped,
      note: inserted > 0 ? 'Daily rates set to 0 — please update each employee\'s daily rate in the Employees tab.' : undefined });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    const code = err.response?.data?.code;
    if (code === 57 || msg?.includes('not authorized')) {
      return res.status(403).json({
        error: 'Zoho Payroll scope not granted',
        fix: 'Follow these steps to fix:\n1. Go to https://api-console.zoho.in/\n2. Open your OAuth client → Edit\n3. Add scope: ZohoPayroll.employees.READ\n4. Under "Self Client" tab, generate new code with both ZohoBooks.fullaccess.all and ZohoPayroll.employees.READ scopes\n5. Exchange for new refresh token and update ZOHO_PAYROLL_REFRESH_TOKEN in .env',
      });
    }
    res.status(500).json({ error: msg });
  }
});

module.exports = router;
