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
  const { name, phone, role, daily_rate, pay_type, monthly_salary } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const pt = pay_type === 'monthly' ? 'monthly' : 'daily';
  if (pt === 'daily'   && !daily_rate)    return res.status(400).json({ error: 'daily_rate is required for daily pay type' });
  if (pt === 'monthly' && !monthly_salary) return res.status(400).json({ error: 'monthly_salary is required for monthly pay type' });
  const { data, error } = await supabase.from('employees').insert({
    name: name.trim(),
    phone: phone || '',
    role: role || '',
    pay_type: pt,
    daily_rate:      pt === 'daily'   ? (parseFloat(daily_rate)    || 0) : 0,
    monthly_salary:  pt === 'monthly' ? (parseFloat(monthly_salary) || 0) : 0,
    active: true,
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/payroll/employees/:id
router.put('/employees/:id', auth, requireRole('admin','manager'), async (req, res) => {
  const { name, phone, role, daily_rate, monthly_salary, pay_type, active,
          email, bank_name, bank_account, bank_ifsc, upi_id } = req.body;
  const updates = {};
  if (name            != null) updates.name            = name.trim();
  if (phone           != null) updates.phone           = phone;
  if (role            != null) updates.role            = role;
  if (pay_type        != null) updates.pay_type        = pay_type;
  if (daily_rate      != null) updates.daily_rate      = parseFloat(daily_rate)    || 0;
  if (monthly_salary  != null) updates.monthly_salary  = parseFloat(monthly_salary) || 0;
  if (active          != null) updates.active          = active;
  if (email           != null) updates.email           = email;
  if (bank_name       != null) updates.bank_name       = bank_name;
  if (bank_account    != null) updates.bank_account    = bank_account;
  if (bank_ifsc       != null) updates.bank_ifsc       = bank_ifsc;
  if (upi_id          != null) updates.upi_id          = upi_id;
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
  const { data: emps, error: empErr } = await supabase.from('employees').select('id,name,role,daily_rate,monthly_salary,pay_type,active').order('name');
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

  // Standard working days (Mon–Sat = 26, adjust as needed; use daysInMonth as fallback)
  const WORKING_DAYS = 26;

  const rows = reportEmps.map(e => {
    const rec       = attByEmp[e.id] || { present: 0, absent: 0, half_day: 0 };
    const recorded  = rec.present + rec.absent + rec.half_day;
    const payType   = e.pay_type || 'daily';
    let salary, effectiveDailyRate;

    if (payType === 'monthly') {
      const monthlySal = parseFloat(e.monthly_salary) || 0;
      // Deduct proportionally for absent days (half_day = 0.5 day deduction)
      const perDay     = monthlySal / WORKING_DAYS;
      const deduction  = Math.round(((rec.absent + rec.half_day * 0.5) * perDay) * 100) / 100;
      salary           = Math.max(0, Math.round((monthlySal - deduction) * 100) / 100);
      effectiveDailyRate = perDay;
    } else {
      salary           = Math.round(((rec.present + rec.half_day * 0.5) * (parseFloat(e.daily_rate) || 0)) * 100) / 100;
      effectiveDailyRate = parseFloat(e.daily_rate) || 0;
    }

    return {
      employee_id:        e.id,
      name:               e.name,
      role:               e.role || '',
      pay_type:           payType,
      daily_rate:         parseFloat(e.daily_rate) || 0,
      monthly_salary:     parseFloat(e.monthly_salary) || 0,
      effective_daily:    Math.round(effectiveDailyRate * 100) / 100,
      days_present:       rec.present,
      days_half:          rec.half_day,
      days_absent:        rec.absent,
      days_recorded:      recorded,
      days_in_month:      daysInMonth,
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

// ── Work Log ──────────────────────────────────────────────────────────────────

// GET /api/payroll/work-log?date=YYYY-MM-DD
router.get('/work-log', auth, async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const [{ data: emps }, { data: logs }] = await Promise.all([
    supabase.from('employees').select('id,name,role,daily_rate,monthly_salary,pay_type').eq('active', true).order('name'),
    supabase.from('employee_work_log').select('*').eq('date', date),
  ]);
  const logMap = {};
  for (const l of logs || []) logMap[l.employee_id] = l;
  const result = (emps || []).map(e => ({
    ...e,
    tasks_completed: logMap[e.id]?.tasks_completed ?? null,
    target_tasks:    logMap[e.id]?.target_tasks    ?? e.default_target ?? 0,
    task_type:       logMap[e.id]?.task_type       ?? '',
    quality:         logMap[e.id]?.quality         ?? 'good',
    notes:           logMap[e.id]?.notes           ?? '',
    already_saved:   !!logMap[e.id],
  }));
  res.json({ date, employees: result });
});

// POST /api/payroll/work-log  — bulk upsert
router.post('/work-log', auth, requireRole('admin', 'manager'), async (req, res) => {
  const rows = req.body;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Expected array' });
  const valid = rows.filter(r => r.employee_id && r.date && r.tasks_completed != null);
  if (!valid.length) return res.status(400).json({ error: 'No valid records' });
  const { error } = await supabase.from('employee_work_log').upsert(
    valid.map(r => ({
      employee_id:     r.employee_id,
      date:            r.date,
      tasks_completed: parseInt(r.tasks_completed) || 0,
      target_tasks:    parseInt(r.target_tasks)    || 0,
      task_type:       r.task_type  || 'general',
      quality:         r.quality    || 'good',
      notes:           r.notes      || '',
      updated_at:      new Date().toISOString(),
    })),
    { onConflict: 'employee_id,date' }
  );
  if (error) return res.status(400).json({ error: error.message });

  // Also update default_target on employee if set
  for (const r of valid) {
    if (r.save_target && r.target_tasks) {
      await supabase.from('employees').update({ default_target: parseInt(r.target_tasks) }).eq('id', r.employee_id);
    }
  }

  res.json({ saved: valid.length });
});

// GET /api/payroll/work-log/report?year=YYYY&month=M
router.get('/work-log/report', auth, async (req, res) => {
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const start = `${year}-${String(month).padStart(2,'0')}-01`;
  const end   = new Date(year, month, 0).toISOString().slice(0, 10);

  const [{ data: emps }, { data: logs }, { data: att }] = await Promise.all([
    supabase.from('employees').select('id,name,role,daily_rate,monthly_salary,pay_type,default_target').eq('active', true).order('name'),
    supabase.from('employee_work_log').select('*').gte('date', start).lte('date', end),
    supabase.from('attendance').select('employee_id,status').gte('date', start).lte('date', end),
  ]);

  // Days present per employee from attendance
  const presentByEmp = {};
  for (const a of att || []) {
    if (!presentByEmp[a.employee_id]) presentByEmp[a.employee_id] = 0;
    if (a.status === 'present')  presentByEmp[a.employee_id] += 1;
    if (a.status === 'half_day') presentByEmp[a.employee_id] += 0.5;
  }

  // Aggregate work log per employee
  const logByEmp = {};
  for (const l of logs || []) {
    if (!logByEmp[l.employee_id]) logByEmp[l.employee_id] = { total_tasks: 0, total_target: 0, days_logged: 0, quality_counts: {} };
    logByEmp[l.employee_id].total_tasks  += parseInt(l.tasks_completed) || 0;
    logByEmp[l.employee_id].total_target += parseInt(l.target_tasks)    || 0;
    logByEmp[l.employee_id].days_logged  += 1;
    const q = l.quality || 'good';
    logByEmp[l.employee_id].quality_counts[q] = (logByEmp[l.employee_id].quality_counts[q] || 0) + 1;
  }

  const daysInMonth = new Date(year, month, 0).getDate();
  const WORKING_DAYS = 26;

  const rows = (emps || []).map(e => {
    const log         = logByEmp[e.id] || { total_tasks: 0, total_target: 0, days_logged: 0, quality_counts: {} };
    const daysPresent = presentByEmp[e.id] || 0;
    const isMonthly   = (e.pay_type || 'daily') === 'monthly';
    const salary      = isMonthly
      ? parseFloat(e.monthly_salary || 0)
      : parseFloat(e.daily_rate || 0) * daysPresent;
    const efficiency  = log.total_target > 0 ? Math.round((log.total_tasks / log.total_target) * 100) : null;
    const costPerTask = log.total_tasks > 0 ? Math.round((salary / log.total_tasks) * 100) / 100 : null;
    const topQuality  = Object.entries(log.quality_counts).sort((a,b)=>b[1]-a[1])[0]?.[0] || '—';
    return {
      employee_id:    e.id,
      name:           e.name,
      role:           e.role,
      pay_type:       e.pay_type || 'daily',
      salary:         Math.round(salary),
      days_present:   daysPresent,
      days_logged:    log.days_logged,
      total_tasks:    log.total_tasks,
      total_target:   log.total_target,
      efficiency,
      cost_per_task:  costPerTask,
      top_quality:    topQuality,
      default_target: e.default_target || 0,
    };
  });

  res.json({ year, month, days_in_month: daysInMonth, employees: rows });
});

module.exports = router;
