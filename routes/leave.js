const express      = require('express');
const router       = express.Router();
const supabase     = require('../config/supabase');
const { auth }     = require('../middleware/auth');
const nodemailer   = require('nodemailer');

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function notifyLeave(leave, event) {
  if (!process.env.SMTP_USER) return;
  try {
    if (event === 'new') {
      // Notify managers of new leave request
      const { data: managers } = await supabase.from('users')
        .select('email,name').in('role', ['admin','manager']).eq('active', true);
      const to = (managers || []).map(m => m.email).filter(Boolean);
      if (!to.length) return;
      await mailer.sendMail({
        from: process.env.SMTP_FROM || 'Sathvam <noreply@sathvam.in>',
        to: to.join(','),
        subject: `Leave Request — ${leave.employee_name} (${leave.leave_type}, ${leave.days} day${leave.days !== 1 ? 's' : ''})`,
        html: `<div style="font-family:sans-serif;max-width:500px">
          <div style="background:#1a5c2a;color:#fff;padding:14px 18px;border-radius:8px 8px 0 0"><h3 style="margin:0">New Leave Request</h3></div>
          <div style="border:1px solid #ddd;border-top:none;padding:18px;border-radius:0 0 8px 8px">
            <p><strong>Employee:</strong> ${leave.employee_name}</p>
            <p><strong>Type:</strong> ${leave.leave_type}</p>
            <p><strong>From:</strong> ${leave.from_date} &nbsp;<strong>To:</strong> ${leave.to_date} (${leave.days} day${leave.days !== 1 ? 's' : ''})</p>
            <p><strong>Reason:</strong> ${leave.reason || '—'}</p>
            <a href="https://admin.sathvam.in" style="background:#1a5c2a;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;display:inline-block;margin-top:8px">Approve / Reject →</a>
          </div>
        </div>`,
      });
    } else if (event === 'approved' || event === 'rejected') {
      // Notify the employee's manager and look up employee email
      const { data: emp } = await supabase.from('employees')
        .select('email,name').eq('id', leave.employee_id).single();
      const empEmail = emp?.email;
      if (!empEmail) return;
      const color  = event === 'approved' ? '#16a34a' : '#dc2626';
      const label  = event === 'approved' ? '✅ Approved' : '❌ Rejected';
      await mailer.sendMail({
        from: process.env.SMTP_FROM || 'Sathvam <noreply@sathvam.in>',
        to:   empEmail,
        subject: `Leave ${label} — ${leave.from_date} to ${leave.to_date}`,
        html: `<div style="font-family:sans-serif;max-width:500px">
          <div style="background:${color};color:#fff;padding:14px 18px;border-radius:8px 8px 0 0"><h3 style="margin:0">Leave ${label}</h3></div>
          <div style="border:1px solid #ddd;border-top:none;padding:18px;border-radius:0 0 8px 8px">
            <p>Your <strong>${leave.leave_type}</strong> leave from <strong>${leave.from_date}</strong> to <strong>${leave.to_date}</strong> (${leave.days} day${leave.days !== 1 ? 's' : ''}) has been <strong>${event}</strong>.</p>
            ${leave.notes ? `<p><strong>Note:</strong> ${leave.notes}</p>` : ''}
          </div>
        </div>`,
      });
    }
  } catch (e) { console.error('[LEAVE] Notify error:', e.message); }
}

// GET /api/leave — list requests
router.get('/', auth, async (req, res) => {
  try {
    const { status, employee_id, limit = 100 } = req.query;
    let q = supabase.from('leave_requests')
      .select('*').order('created_at', { ascending: false }).limit(parseInt(limit));
    if (status) q = q.eq('status', status);
    if (employee_id) q = q.eq('employee_id', employee_id);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/leave — create request
router.post('/', auth, async (req, res) => {
  try {
    const { employee_id, employee_name, leave_type, from_date, to_date, reason } = req.body;
    if (!employee_id || !from_date || !to_date) return res.status(400).json({ error: 'Missing fields' });
    const days = Math.ceil((new Date(to_date) - new Date(from_date)) / 86400000) + 1;
    const { data, error } = await supabase.from('leave_requests')
      .insert({ employee_id, employee_name, leave_type: leave_type || 'casual', from_date, to_date, days, reason: reason || '', status: 'pending' })
      .select().single();
    if (error) return res.status(400).json({ error: error.message });
    setImmediate(() => notifyLeave(data, 'new'));
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/leave/:id — approve/reject
router.patch('/:id', auth, async (req, res) => {
  try {
    const { status, notes } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (status) updates.status = status;
    if (notes !== undefined) updates.notes = notes;
    const { data, error } = await supabase.from('leave_requests')
      .update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    if (status === 'approved' || status === 'rejected') {
      setImmediate(() => notifyLeave(data, status));
    }
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/leave/:id
router.delete('/:id', auth, async (req, res) => {
  const { error } = await supabase.from('leave_requests').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// GET /api/leave/summary — leave counts per employee
router.get('/summary', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('leave_requests')
      .select('employee_id,employee_name,leave_type,days,status')
      .eq('status', 'approved');
    if (error) return res.status(500).json({ error: error.message });
    const summary = {};
    for (const r of data || []) {
      if (!summary[r.employee_id]) summary[r.employee_id] = { employee_name: r.employee_name, casual: 0, sick: 0, earned: 0, other: 0, total: 0 };
      const t = r.leave_type || 'other';
      summary[r.employee_id][t] = (summary[r.employee_id][t] || 0) + r.days;
      summary[r.employee_id].total += r.days;
    }
    res.json(Object.values(summary));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
