/**
 * Sathvam Automation Service
 * Run as a separate PM2 process: pm2 start scripts/automation-service.js --name sathvam-automation
 *
 * Handles scheduled automations independently of the main Express API:
 *   - Daily 9 PM IST  : Sales summary email
 *   - Daily 6 PM IST  : Low stock alert (packing materials + finished goods)
 *   - Daily 10 AM IST : Overdue vendor payment reminders
 *   - Monthly 1st     : P&L snapshot email
 *   - Monthly last day: Auto-generate payroll drafts
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const cron     = require('node-cron');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const mailer = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const FROM = process.env.SMTP_FROM || 'Sathvam <noreply@sathvam.in>';

// ── Helpers ────────────────────────────────────────────────────────────────────

async function getAdminEmails(roles = ['admin', 'ceo']) {
  const { data } = await supabase.from('users').select('email').in('role', roles).eq('active', true);
  return [...new Set((data || []).map(u => u.email).filter(Boolean))];
}

async function getManagerEmails() {
  const { data } = await supabase.from('users').select('email').in('role', ['admin', 'ceo', 'manager']).eq('active', true);
  return [...new Set((data || []).map(u => u.email).filter(Boolean))];
}

async function sendMail(to, subject, html) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  if (!to.length) return;
  await mailer.sendMail({ from: FROM, to: to.join(','), subject, html });
}

// ── 1. Daily Sales Summary — 9 PM IST (3:30 PM UTC) ──────────────────────────

cron.schedule('30 15 * * *', async () => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const [todayOrders, todayWebstore, pendingDispatch] = await Promise.all([
      supabase.from('sales').select('order_no,customer_name,final_amount,channel,status').eq('date', today),
      supabase.from('webstore_orders').select('order_no,total,status,customer').gte('date', today),
      supabase.from('webstore_orders').select('order_no,total,customer').in('status', ['confirmed', 'packed']),
    ]);

    const salesRev   = (todayOrders.data   || []).reduce((s, r) => s + (r.final_amount || 0), 0);
    const webRev     = (todayWebstore.data || []).reduce((s, r) => s + (r.total || 0), 0);
    const totalRev   = salesRev + webRev;
    const orderCount = (todayOrders.data || []).length + (todayWebstore.data || []).length;
    const pendCount  = (pendingDispatch.data || []).length;

    const salesRows = (todayOrders.data || []).map(o =>
      `<tr><td style="padding:4px 10px">${o.order_no}</td><td style="padding:4px 10px">${o.customer_name || '—'}</td><td style="padding:4px 10px;text-align:right">₹${(o.final_amount || 0).toLocaleString('en-IN')}</td><td style="padding:4px 10px">${o.channel || '—'}</td></tr>`
    ).join('');

    const html = `<div style="font-family:sans-serif;max-width:580px;margin:0 auto">
      <div style="background:#1a5c2a;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
        <h2 style="margin:0;font-size:16px">📊 Daily Sales Summary — ${today}</h2>
      </div>
      <div style="border:1px solid #ddd;border-top:none;padding:20px;border-radius:0 0 8px 8px">
        <div style="display:flex;gap:12px;margin-bottom:18px;flex-wrap:wrap">
          <div style="flex:1;min-width:120px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px;text-align:center">
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase">Total Revenue</div>
            <div style="font-size:24px;font-weight:800;color:#1a5c2a">₹${Math.round(totalRev).toLocaleString('en-IN')}</div>
          </div>
          <div style="flex:1;min-width:120px;background:#ecfeff;border:1px solid #a5f3fc;border-radius:8px;padding:12px;text-align:center">
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase">Orders Today</div>
            <div style="font-size:24px;font-weight:800;color:#0891b2">${orderCount}</div>
          </div>
          <div style="flex:1;min-width:120px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px;text-align:center">
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase">Pending Dispatch</div>
            <div style="font-size:24px;font-weight:800;color:#d97706">${pendCount}</div>
          </div>
        </div>
        ${salesRows ? `<h4 style="margin:0 0 8px;color:#374151">Today's Orders</h4>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:#f9fafb"><th style="padding:5px 10px;text-align:left">Order</th><th style="padding:5px 10px;text-align:left">Customer</th><th style="padding:5px 10px;text-align:right">Amount</th><th style="padding:5px 10px">Channel</th></tr></thead>
          <tbody>${salesRows}</tbody>
        </table>` : '<p style="color:#6b7280;font-size:13px">No sales orders today.</p>'}
        ${pendCount > 0 ? `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px;margin-top:14px;font-size:13px;color:#92400e"><strong>⚠️ ${pendCount} order${pendCount !== 1 ? 's' : ''} pending dispatch</strong> — please pack and ship.</div>` : ''}
        <p style="font-size:11px;color:#9ca3af;margin-top:16px;text-align:center">Sathvam Natural Products · Auto Daily Summary</p>
      </div>
    </div>`;

    const to = await getAdminEmails();
    await sendMail(to, `Sathvam Daily Summary — ${today} | ₹${Math.round(totalRev).toLocaleString('en-IN')} | ${orderCount} orders`, html);
    console.log(`[${today}] Daily sales summary sent — ₹${Math.round(totalRev)}, ${orderCount} orders`);
  } catch (e) { console.error('[AUTO] Daily sales summary failed:', e.message); }
});

// ── 2. Low Stock Alert — 6 PM IST (12:30 PM UTC) ─────────────────────────────

cron.schedule('30 12 * * *', async () => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const [packRes, fgRes] = await Promise.all([
      supabase.from('packing_materials').select('name,current_stock,min_stock,category').eq('active', true),
      supabase.from('finished_goods').select('product_name,qty,type'),
    ]);

    // Packing materials below min_stock
    const lowPack = (packRes.data || [])
      .filter(m => (m.current_stock || 0) < (m.min_stock || 50))
      .sort((a, b) => (a.current_stock || 0) - (b.current_stock || 0));

    // Finished goods balance
    const fgBalance = {};
    for (const r of (fgRes.data || [])) {
      if (!fgBalance[r.product_name]) fgBalance[r.product_name] = 0;
      fgBalance[r.product_name] += r.type === 'out' ? -(parseFloat(r.qty) || 0) : (parseFloat(r.qty) || 0);
    }
    const lowFG = Object.entries(fgBalance)
      .filter(([, bal]) => bal < 10)
      .map(([name, bal]) => ({ name, balance: Math.max(0, Math.round(bal)) }))
      .sort((a, b) => a.balance - b.balance);

    if (!lowPack.length && !lowFG.length) {
      console.log(`[${today}] Low stock check: all OK`);
      return;
    }

    const packRows = lowPack.map(m =>
      `<tr><td style="padding:4px 10px">${m.name}</td><td style="padding:4px 10px;text-align:center;color:${(m.current_stock || 0) === 0 ? '#dc2626' : '#d97706'};font-weight:700">${m.current_stock || 0}</td><td style="padding:4px 10px;text-align:center;color:#6b7280">${m.min_stock || 50}</td></tr>`
    ).join('');
    const fgRows = lowFG.map(f =>
      `<tr><td style="padding:4px 10px">${f.name}</td><td style="padding:4px 10px;text-align:center;color:${f.balance === 0 ? '#dc2626' : '#d97706'};font-weight:700">${f.balance} pcs</td></tr>`
    ).join('');

    const html = `<div style="font-family:sans-serif;max-width:580px;margin:0 auto">
      <div style="background:#dc2626;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
        <h2 style="margin:0;font-size:16px">⚠️ Low Stock Alert — ${today}</h2>
      </div>
      <div style="border:1px solid #ddd;border-top:none;padding:20px;border-radius:0 0 8px 8px">
        ${packRows ? `<h4 style="color:#374151;margin:0 0 8px">📦 Packing Materials (${lowPack.length} items)</h4>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:18px">
          <thead><tr style="background:#fef2f2"><th style="padding:5px 10px;text-align:left">Item</th><th style="padding:5px 10px">Stock</th><th style="padding:5px 10px">Min</th></tr></thead>
          <tbody>${packRows}</tbody>
        </table>` : ''}
        ${fgRows ? `<h4 style="color:#374151;margin:0 0 8px">🏷️ Finished Goods (${lowFG.length} products)</h4>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:#fef2f2"><th style="padding:5px 10px;text-align:left">Product</th><th style="padding:5px 10px">Balance</th></tr></thead>
          <tbody>${fgRows}</tbody>
        </table>` : ''}
        <p style="font-size:11px;color:#9ca3af;margin-top:16px;text-align:center">Please reorder immediately · admin.sathvam.in</p>
      </div>
    </div>`;

    const to = await getManagerEmails();
    await sendMail(to, `⚠️ Low Stock Alert — ${lowPack.length} packing + ${lowFG.length} finished goods`, html);
    console.log(`[${today}] Low stock alert sent: ${lowPack.length} packing, ${lowFG.length} FG`);
  } catch (e) { console.error('[AUTO] Low stock alert failed:', e.message); }
});

// ── 3. Overdue Vendor Payments — 10 AM IST (4:30 AM UTC) ─────────────────────

cron.schedule('30 4 * * *', async () => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data: bills } = await supabase
      .from('vendor_bills')
      .select('id,vendor_name,bill_no,amount,due_date,paid_amount')
      .in('status', ['unpaid', 'partial'])
      .lt('due_date', today)
      .not('due_date', 'is', null)
      .order('due_date');

    if (!(bills || []).length) {
      console.log(`[${today}] Overdue AP check: no overdue bills`);
      return;
    }

    const rows = bills.map(b => {
      const outstanding = (b.amount || 0) - (b.paid_amount || 0);
      const overdueDays = Math.floor((Date.now() - new Date(b.due_date).getTime()) / 86400000);
      return `<tr><td style="padding:5px 10px">${b.vendor_name}</td><td style="padding:5px 10px">${b.bill_no || '—'}</td><td style="padding:5px 10px;text-align:right">₹${outstanding.toLocaleString('en-IN')}</td><td style="padding:5px 10px;color:#dc2626;font-weight:700">${overdueDays}d overdue</td></tr>`;
    }).join('');

    const total = bills.reduce((s, b) => s + ((b.amount || 0) - (b.paid_amount || 0)), 0);

    const html = `<div style="font-family:sans-serif;max-width:580px;margin:0 auto">
      <div style="background:#7c3aed;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
        <h2 style="margin:0;font-size:16px">💳 Overdue Payments — ${bills.length} bills | ₹${Math.round(total).toLocaleString('en-IN')}</h2>
      </div>
      <div style="border:1px solid #ddd;border-top:none;padding:20px;border-radius:0 0 8px 8px">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:#f5f3ff"><th style="padding:5px 10px;text-align:left">Vendor</th><th style="padding:5px 10px;text-align:left">Bill No</th><th style="padding:5px 10px;text-align:right">Outstanding</th><th style="padding:5px 10px">Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="font-size:11px;color:#9ca3af;margin-top:16px;text-align:center">Please process payments · admin.sathvam.in → Finance → AP</p>
      </div>
    </div>`;

    const to = await getManagerEmails();
    await sendMail(to, `💳 ${bills.length} Overdue Bill${bills.length !== 1 ? 's' : ''} — ₹${Math.round(total).toLocaleString('en-IN')} pending`, html);
    console.log(`[${today}] Overdue payment reminder sent: ${bills.length} bills, ₹${Math.round(total)}`);
  } catch (e) { console.error('[AUTO] Overdue payment reminder failed:', e.message); }
});

// ── 4. Monthly P&L Snapshot — 1st of each month, 8 AM IST (2:30 AM UTC) ─────

cron.schedule('30 2 1 * *', async () => {
  try {
    const now       = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const mStart    = lastMonth.toISOString().slice(0, 7) + '-01';
    const mEnd      = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);
    const mLabel    = lastMonth.toLocaleString('en-IN', { month: 'long', year: 'numeric' });

    const [salesRes, webRes, expRes, procRes] = await Promise.all([
      supabase.from('sales').select('final_amount,gst_amount').gte('date', mStart).lte('date', mEnd),
      supabase.from('webstore_orders').select('total,gst').gte('date', mStart).lte('date', mEnd).not('status', 'eq', 'cancelled'),
      supabase.from('company_expenses').select('category,amount').gte('date', mStart).lte('date', mEnd).is('deleted_at', null),
      supabase.from('procurements').select('ordered_qty,rate').gte('date', mStart).lte('date', mEnd),
    ]);

    const salesRev   = (salesRes.data || []).reduce((s, r) => s + (r.final_amount || 0), 0);
    const webRev     = (webRes.data   || []).reduce((s, r) => s + (r.total || 0), 0);
    const totalRev   = salesRev + webRev;
    const totalGST   = (salesRes.data || []).reduce((s, r) => s + (r.gst_amount || 0), 0)
                     + (webRes.data   || []).reduce((s, r) => s + (r.gst || 0), 0);
    const expenses   = (expRes.data  || []).reduce((s, r) => s + parseFloat(r.amount || 0), 0);
    const rawMatCost = (procRes.data || []).reduce((s, r) => s + (parseFloat(r.ordered_qty || 0) * parseFloat(r.rate || 0)), 0);
    const netProfit  = totalRev - expenses - rawMatCost;

    const expByCat = {};
    for (const r of expRes.data || []) expByCat[r.category] = (expByCat[r.category] || 0) + parseFloat(r.amount || 0);
    const expRows = Object.entries(expByCat).sort((a, b) => b[1] - a[1])
      .map(([cat, amt]) => `<tr><td style="padding:4px 10px">${cat}</td><td style="padding:4px 10px;text-align:right">₹${Math.round(amt).toLocaleString('en-IN')}</td></tr>`).join('');

    const html = `<div style="font-family:sans-serif;max-width:580px;margin:0 auto">
      <div style="background:#1a5c2a;color:#fff;padding:18px 22px;border-radius:8px 8px 0 0">
        <h2 style="margin:0">📊 Monthly P&L — ${mLabel}</h2>
      </div>
      <div style="border:1px solid #ddd;border-top:none;padding:20px;border-radius:0 0 8px 8px">
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:18px">
          <tr style="background:#f0fdf4"><td style="padding:8px 12px;font-weight:700">Total Revenue</td><td style="padding:8px 12px;text-align:right;font-weight:800;color:#1a5c2a;font-size:18px">₹${Math.round(totalRev).toLocaleString('en-IN')}</td></tr>
          <tr><td style="padding:6px 12px;color:#6b7280">  ↳ In-store Sales</td><td style="padding:6px 12px;text-align:right">₹${Math.round(salesRev).toLocaleString('en-IN')}</td></tr>
          <tr><td style="padding:6px 12px;color:#6b7280">  ↳ Webstore Orders</td><td style="padding:6px 12px;text-align:right">₹${Math.round(webRev).toLocaleString('en-IN')}</td></tr>
          <tr style="background:#fef2f2"><td style="padding:8px 12px;font-weight:700">Raw Material Cost</td><td style="padding:8px 12px;text-align:right;color:#dc2626">₹${Math.round(rawMatCost).toLocaleString('en-IN')}</td></tr>
          <tr style="background:#fef2f2"><td style="padding:8px 12px;font-weight:700">Operating Expenses</td><td style="padding:8px 12px;text-align:right;color:#dc2626">₹${Math.round(expenses).toLocaleString('en-IN')}</td></tr>
          <tr style="background:#f0fdf4"><td style="padding:8px 12px;font-weight:700">GST Collected</td><td style="padding:8px 12px;text-align:right;color:#0891b2">₹${Math.round(totalGST).toLocaleString('en-IN')}</td></tr>
          <tr style="background:${netProfit >= 0 ? '#f0fdf4' : '#fef2f2'};border-top:2px solid #e5e7eb">
            <td style="padding:10px 12px;font-weight:800;font-size:15px">Net Profit</td>
            <td style="padding:10px 12px;text-align:right;font-weight:800;font-size:18px;color:${netProfit >= 0 ? '#1a5c2a' : '#dc2626'}">₹${Math.round(netProfit).toLocaleString('en-IN')}</td>
          </tr>
        </table>
        ${expRows ? `<h4 style="margin:0 0 6px;color:#374151">Expense Breakdown</h4>
        <table style="width:100%;border-collapse:collapse;font-size:13px"><tbody>${expRows}</tbody></table>` : ''}
        <p style="font-size:11px;color:#9ca3af;margin-top:16px;text-align:center">Sathvam Natural Products · Monthly P&L · Auto-generated</p>
      </div>
    </div>`;

    const to = await getAdminEmails();
    await sendMail(to, `Sathvam P&L — ${mLabel} | Revenue ₹${Math.round(totalRev).toLocaleString('en-IN')} | Profit ₹${Math.round(netProfit).toLocaleString('en-IN')}`, html);
    console.log(`[AUTO] Monthly P&L sent for ${mLabel}`);
  } catch (e) { console.error('[AUTO] Monthly P&L failed:', e.message); }
});

// ── 5. Monthly Payroll Auto-Generation — last day of month, 6 PM IST (12:30 PM UTC) ──

cron.schedule('30 12 28-31 * *', async () => {
  try {
    const now      = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    if (tomorrow.getDate() !== 1) return; // only run on actual last day of month

    const month = now.toISOString().slice(0, 7); // YYYY-MM
    const today = now.toISOString().slice(0, 10);

    // Skip if payroll already generated for this month
    const { data: existing } = await supabase.from('payroll').select('id').eq('month', month).limit(1);
    if ((existing || []).length > 0) {
      console.log(`[AUTO] Payroll already exists for ${month} — skipping`);
      return;
    }

    const { data: employees } = await supabase
      .from('employees').select('id,name,designation,basic_salary,allowances').eq('active', true);
    if (!(employees || []).length) return;

    const mStart = month + '-01';
    const { data: attendance } = await supabase
      .from('attendance').select('employee_id,status').gte('date', mStart).lte('date', today);

    const attMap = {};
    for (const a of (attendance || [])) {
      if (!attMap[a.employee_id]) attMap[a.employee_id] = { present: 0, absent: 0, half: 0, leave: 0 };
      if (a.status === 'present')  attMap[a.employee_id].present++;
      if (a.status === 'absent')   attMap[a.employee_id].absent++;
      if (a.status === 'half-day') attMap[a.employee_id].half++;
      if (a.status === 'leave')    attMap[a.employee_id].leave++;
    }

    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

    const payslips = employees.map(emp => {
      const att          = attMap[emp.id] || { present: 0, absent: 0, half: 0, leave: 0 };
      const effectiveDays = att.present + att.half * 0.5 + att.leave;
      const dailyRate    = (parseFloat(emp.basic_salary) || 0) / daysInMonth;
      const earned       = Math.round(dailyRate * effectiveDays * 100) / 100;
      const allowances   = parseFloat(emp.allowances) || 0;
      const gross        = earned + allowances;
      return {
        employee_id:   emp.id,
        employee_name: emp.name,
        designation:   emp.designation || '',
        month,
        basic_salary:  parseFloat(emp.basic_salary) || 0,
        allowances,
        present_days:  att.present,
        absent_days:   att.absent,
        half_days:     att.half,
        leave_days:    att.leave,
        earned_basic:  earned,
        gross_salary:  gross,
        deductions:    0,
        net_salary:    gross,
        status:        'draft',
        generated_at:  new Date().toISOString(),
        generated_by:  'system',
      };
    });

    const { error } = await supabase.from('payroll').insert(payslips);
    if (error) { console.error('[AUTO] Payroll insert failed:', error.message); return; }

    console.log(`[AUTO] Payroll auto-generated for ${month}: ${payslips.length} employees`);

    // Notify HR/admin
    const to = await getAdminEmails(['admin', 'hr']);
    await sendMail(
      to,
      `✅ Payroll Auto-Generated — ${month} (${payslips.length} employees, draft)`,
      `<div style="font-family:sans-serif;max-width:500px">
        <div style="background:#7c3aed;color:#fff;padding:14px 18px;border-radius:8px 8px 0 0"><h3 style="margin:0">Payroll Auto-Generated — ${month}</h3></div>
        <div style="border:1px solid #ddd;border-top:none;padding:18px;border-radius:0 0 8px 8px">
          <p>Payslips for <strong>${payslips.length} employees</strong> have been auto-generated as <em>draft</em> for <strong>${month}</strong>.</p>
          <p>Please review attendance, apply any deductions, and approve in the Payroll tab.</p>
          <a href="https://admin.sathvam.in" style="background:#7c3aed;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;display:inline-block">Review Payroll →</a>
        </div>
      </div>`
    );
  } catch (e) { console.error('[AUTO] Monthly payroll generation failed:', e.message); }
});

// ── 6. AI Abandoned Cart Recovery — every 2 hours, 8 AM–9 PM IST ─────────────
//
// 3-touch follow-up sequence per cart:
//   Touch 1: 1–6 h after abandonment  → Friendly "you left something" reminder
//   Touch 2: 22–28 h after abandonment → Offer with 10% discount
//   Touch 3: 68–76 h after abandonment → Final nudge before cart expires
//
// Sends: Email always, WhatsApp if WA_PHONE_NUMBER_ID + WA_ACCESS_TOKEN are set
// Uses:  Claude AI for message generation (falls back to template on error)
// State: Tracked in Supabase settings table (key = 'cart_followup_state')

const Anthropic = require('@anthropic-ai/sdk');
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

async function sendWhatsAppMsg(phone, message) {
  const phoneId = process.env.WA_PHONE_NUMBER_ID?.trim();
  const token   = process.env.WA_ACCESS_TOKEN?.trim();
  if (!phoneId || !token) return false;
  const normalized = phone.replace(/\D/g, '');
  const to = normalized.length === 10 ? '91' + normalized : normalized;
  try {
    const r = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: message } }),
    });
    const j = await r.json();
    if (j.error) { console.error('[CART-WA] Error:', j.error.message); return false; }
    return true;
  } catch (e) { console.error('[CART-WA] Failed:', e.message); return false; }
}

// Generate AI message using Claude; falls back to template on any error
// discountPct is only used for touch 2 (admin-approved discount)
async function generateCartMessage(cart, touch, discountPct = 0) {
  const name  = cart.customer_name || cart.name || 'there';
  const first = name.split(' ')[0];
  const items = (cart.items || []).map(i => `${i.name || 'item'} ×${i.qty || 1}`).join(', ');
  const total = (cart.items || []).reduce((s, i) => s + (parseFloat(i.price || 0) * (i.qty || 1)), 0);
  const totalStr = total > 0 ? `₹${Math.round(total).toLocaleString('en-IN')}` : '';

  const offerLine = discountPct > 0
    ? `\n\nSpecial offer: Use code SAVE${discountPct} for ${discountPct}% off — valid 24 hrs only.`
    : '';

  // Templates as fallback
  const templates = {
    1: {
      wa: `Hi ${first}! 🌿 You left something in your Sathvam cart:\n${items}${totalStr ? `\nTotal: ${totalStr}` : ''}\n\nYour cart is saved — complete your order anytime at sathvam.in 😊\nFree shipping above ₹499!`,
      subject: `Your Sathvam cart is waiting 🛒`,
    },
    2: {
      wa: `Hi ${first}! Still thinking about your Sathvam order? 🫙\n${items}${offerLine}\n\nOrder now: sathvam.in 🌿`,
      subject: discountPct > 0 ? `${discountPct}% off your cart — Sathvam Natural Products 🎁` : `Still interested? Your Sathvam cart is waiting 🌿`,
    },
    3: {
      wa: `Hi ${first}! Last reminder — your Sathvam cart with ${items} is about to expire.\n\nPure cold-pressed oils, delivered fresh. Order today: sathvam.in 🌿`,
      subject: `Final reminder — your Sathvam cart 🛒`,
    },
  };

  if (!anthropic) return { ...templates[touch], email: null };

  const touchContext = {
    1: 'a friendly first reminder that they left items in their cart. Warm, helpful tone. Mention free shipping above ₹499.',
    2: discountPct > 0
      ? `a second follow-up with a ${discountPct}% discount offer using code SAVE${discountPct}. Create urgency — valid 24 hours only.`
      : 'a second follow-up asking if they need help or have any questions. Warm and helpful. No discount.',
    3: 'a final gentle reminder before their cart expires. Brief and warm. No pressure.',
  };

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `You are writing a cart recovery message for Sathvam Natural Products (cold-pressed oils, sathvam.in).
Customer: ${name}
Cart items: ${items}${totalStr ? `\nCart value: ${totalStr}` : ''}
Touch number: ${touch} — write ${touchContext[touch]}

Write TWO versions:
1. WhatsApp (max 3 lines, emoji OK, casual, include sathvam.in link)
2. Email subject line (max 60 chars, no emoji)

Format exactly:
WA: <whatsapp message>
SUBJECT: <email subject>`,
      }],
    });

    const text = msg.content[0]?.text || '';
    const waMatch  = text.match(/WA:\s*([\s\S]*?)(?=SUBJECT:|$)/i);
    const subMatch = text.match(/SUBJECT:\s*(.+)/i);
    return {
      wa:      waMatch  ? waMatch[1].trim()  : templates[touch].wa,
      subject: subMatch ? subMatch[1].trim() : templates[touch].subject,
      email:   null, // email body built separately
    };
  } catch (e) {
    console.error('[CART-AI] Message generation failed:', e.message);
    return { ...templates[touch], email: null };
  }
}

function buildCartEmailHtml(cart, touch, waMsg, discountPct = 0) {
  const name  = cart.customer_name || cart.name || 'there';
  const first = name.split(' ')[0];
  const items = cart.items || [];
  const total = items.reduce((s, i) => s + (parseFloat(i.price || 0) * (i.qty || 1)), 0);

  const itemRows = items.map(i =>
    `<tr><td style="padding:7px 12px;border-bottom:1px solid #f3f4f6">${i.name || 'Product'}</td>
     <td style="padding:7px 12px;text-align:center;border-bottom:1px solid #f3f4f6">×${i.qty || 1}</td>
     <td style="padding:7px 12px;text-align:right;border-bottom:1px solid #f3f4f6;font-weight:700">₹${Math.round((parseFloat(i.price || 0)) * (i.qty || 1)).toLocaleString('en-IN')}</td>
     </tr>`
  ).join('');

  const offerBanner = (touch === 2 && discountPct > 0)
    ? `<div style="background:#fffbeb;border:2px dashed #d97706;border-radius:10px;padding:14px;text-align:center;margin:18px 0">
        <div style="font-size:18px;font-weight:900;color:#d97706">🎁 ${discountPct}% OFF — Code: SAVE${discountPct}</div>
        <div style="font-size:12px;color:#92400e;margin-top:4px">Valid for the next 24 hours only</div>
      </div>` : '';

  const touchIntro = {
    1: `Your fresh, cold-pressed goodness is just one click away! We saved your cart so you can pick up right where you left off. 🌿`,
    2: discountPct > 0
      ? `We really don't want you to miss out on our pure cold-pressed oils! As a special offer, here's <strong>${discountPct}% off</strong> your order — just use code <strong>SAVE${discountPct}</strong> at checkout.`
      : `We noticed you're still thinking about your order — can we help? Our team is happy to answer any questions. Just reply to this email or call us at +91 70921 77092. 🌿`,
    3: `This is our last reminder — your cart is about to expire. We'd hate for you to miss out on our pure, cold-pressed oils delivered fresh to your door.`,
  };

  return `<div style="font-family:sans-serif;max-width:540px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
  <div style="background:linear-gradient(135deg,#2d1a0e,#1a5c2a);color:#fff;padding:22px 28px">
    <div style="font-size:20px;font-weight:800;margin-bottom:4px">🛒 Your cart is waiting, ${first}!</div>
    <div style="font-size:13px;opacity:.85">Sathvam Natural Products — Pure. Cold-pressed.</div>
  </div>
  <div style="padding:22px 28px">
    <p style="color:#374151;font-size:15px;margin-top:0">${touchIntro[touch] || touchIntro[1]}</p>
    ${offerBanner}
    ${itemRows ? `<table style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:8px;overflow:hidden;margin:16px 0">
      <thead><tr style="background:#f3f4f6">
        <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280">ITEM</th>
        <th style="padding:8px 12px;text-align:center;font-size:12px;color:#6b7280">QTY</th>
        <th style="padding:8px 12px;text-align:right;font-size:12px;color:#6b7280">AMOUNT</th>
      </tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
    ${total > 0 ? `<p style="text-align:right;font-size:16px;font-weight:800;color:#1f2937;margin:0">Total: ₹${Math.round(total).toLocaleString('en-IN')}</p>` : ''}` : ''}
    <div style="text-align:center;margin:24px 0">
      <a href="https://sathvam.in" style="background:linear-gradient(135deg,#2d1a0e,#1a5c2a);color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-size:16px;font-weight:700;display:inline-block">Complete My Order →</a>
    </div>
    <p style="color:#9ca3af;font-size:12px;text-align:center;margin:0">Questions? Call <strong>+91 70921 77092</strong> · Free shipping above ₹499<br>Sathvam Natural Products, Karur, Tamil Nadu</p>
  </div>
</div>`;
}

async function runCartFollowUps() {
  // Only run during business hours (8 AM – 9 PM IST = 2:30 AM – 3:30 PM UTC)
  const utcHour = new Date().getUTCHours();
  if (utcHour < 2 || utcHour > 15) return;

  try {
    // Load all non-recovered carts with contact info
    const { data: carts } = await supabase
      .from('abandoned_carts')
      .select('*')
      .eq('recovered', false)
      .order('updated_at', { ascending: true })
      .limit(200);

    if (!(carts || []).length) return;

    // Load follow-up state from settings
    const { data: stateRow } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'cart_followup_state')
      .single();
    const state = stateRow?.value || {}; // { [sessionId]: { count, last_at } }

    const now = Date.now();
    let updated = false;

    for (const cart of carts) {
      const sid   = cart.session_id;
      const email = cart.email || cart.customer_email;
      const phone = cart.customer_phone || cart.phone;
      if (!email && !phone) continue; // no contact info — skip

      const ageHours    = (now - new Date(cart.updated_at).getTime()) / 3600000;
      const cartState   = state[sid] || { count: 0, last_at: null };
      const hoursSinceLast = cartState.last_at
        ? (now - new Date(cartState.last_at).getTime()) / 3600000
        : Infinity;

      // Determine which touch to send
      let touch = null;
      if (cartState.count === 0 && ageHours >= 1 && ageHours <= 6) {
        touch = 1;
      } else if (cartState.count === 1 && ageHours >= 22 && ageHours <= 28 && hoursSinceLast >= 18) {
        touch = 2; // discount touch — needs approval
      } else if (cartState.count === 2 && ageHours >= 68 && ageHours <= 76 && hoursSinceLast >= 40) {
        touch = 3;
      }

      if (!touch) continue;

      // ── Touch 2 requires admin approval before sending ──────────────────────
      if (touch === 2) {
        if (cartState.approval_queued) continue; // already waiting, don't re-queue

        const cartTotal = (cart.items || []).reduce((s, i) => s + (parseFloat(i.price || 0) * (i.qty || 1)), 0);

        // Load existing approvals queue
        const { data: aqRow } = await supabase.from('settings').select('value').eq('key', 'cart_discount_approvals').single();
        const queue = aqRow?.value || [];
        // Avoid duplicates
        if (!queue.find(a => a.session_id === sid && a.status === 'pending')) {
          queue.push({
            id:                   `${sid}_t2_${Date.now()}`,
            session_id:           sid,
            cart,
            cart_total:           Math.round(cartTotal),
            suggested_discount_pct: 10,
            queued_at:            new Date().toISOString(),
            status:               'pending',
          });
          await supabase.from('settings').upsert({ key: 'cart_discount_approvals', value: queue, updated_at: new Date().toISOString() });
          console.log(`[CART-T2] Queued for approval: ${sid} (cart ₹${Math.round(cartTotal)})`);
        }

        state[sid] = { ...cartState, approval_queued: true };
        updated = true;
        continue; // don't send — wait for admin approval
      }

      // ── Touch 1 & 3: auto-send (no discount involved) ──────────────────────
      const { wa: waMsg, subject } = await generateCartMessage(cart, touch);
      const htmlBody = buildCartEmailHtml(cart, touch, waMsg);
      let sent = false;

      if (phone) {
        const waSent = await sendWhatsAppMsg(phone, waMsg);
        if (waSent) { sent = true; console.log(`[CART-WA] Touch ${touch} sent to ${phone} (${sid})`); }
      }
      if (email && process.env.SMTP_USER && process.env.SMTP_PASS) {
        try {
          await mailer.sendMail({ from: FROM, to: email, subject, html: htmlBody });
          sent = true;
          console.log(`[CART-EMAIL] Touch ${touch} sent to ${email} (${sid})`);
        } catch (e) { console.error('[CART-EMAIL] Failed:', e.message); }
      }

      if (sent) {
        state[sid] = { count: touch, last_at: new Date().toISOString() };
        updated = true;
      }

      await new Promise(r => setTimeout(r, 500));
    }

    // Persist updated follow-up state
    if (updated) {
      await supabase.from('settings').upsert({
        key: 'cart_followup_state',
        value: state,
        updated_at: new Date().toISOString(),
      });
    }
  } catch (e) { console.error('[CART-FOLLOWUP] Error:', e.message); }
}

// Run every 2 hours (at :00 — 0,2,4,6,...h UTC)
cron.schedule('0 */2 * * *', () => {
  console.log('[CART-FOLLOWUP] Running abandoned cart follow-up check…');
  runCartFollowUps();
});

// ── Failed Payment Follow-Up ───────────────────────────────────────────────────
// Checkout sessions where customer entered details but payment didn't complete.
// Source: store_analytics rows with key prefix _cs_ that have customer_name/phone
//         but no recovered flag and no matching webstore order.
// Strategy:
//   T1 (30m–4h)   — Friendly "did something go wrong?" with payment retry link
//   T2 (4h–24h)   — Trust-building + retry + offer to help (phone/whatsapp)
// No discount involved — pure re-engagement.

async function generateFailedPaymentMessage(session) {
  const name  = session.customer_name || 'there';
  const first = name.split(' ')[0];
  const items = (session.items || []).map(i => i.name || i.product_name).filter(Boolean);
  const itemsList = items.length ? items.join(', ') : 'your items';
  const total = session.cart_total ? `₹${Math.round(session.cart_total)}` : 'your order';

  const templates = [
    {
      touch: 1,
      wa: `Hi ${first}! 👋 We noticed your payment for ${total} (${itemsList}) didn't go through. It happens — please try again: https://sathvam.in/cart\n\nNeed help? Reply here or call us! 🙏`,
      subject: `Your Sathvam order of ${total} — payment didn't go through`,
    },
    {
      touch: 2,
      wa: `Hi ${first}, this is a gentle reminder from Sathvam about your order (${itemsList} — ${total}). If you faced any issue, our team is happy to help complete your order over phone or WhatsApp. We process with care 🌿\n\nRetry: https://sathvam.in/cart`,
      subject: `Complete your Sathvam order — we're here to help`,
    },
  ];

  if (!anthropic) return templates[0]; // fallback if no API key

  try {
    const prompt = `You are a friendly customer support assistant for Sathvam, a premium cold-pressed oil brand.
A customer named ${first} tried to place an order for ${itemsList} worth ${total} but their payment failed.
Write a warm, empathetic WhatsApp message (under 180 chars after the greeting) to encourage them to retry.
Touch level: ${session._touch === 2 ? '2 — second follow-up, offer phone assistance' : '1 — first follow-up, friendly and brief'}.
Return JSON: { "wa": "...", "subject": "..." }`;

    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = resp.content[0]?.text?.trim() || '';
    const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}');
    if (json.wa && json.subject) return json;
  } catch (e) { console.error('[FAILED-PAY] AI error:', e.message); }

  return templates[session._touch === 2 ? 1 : 0];
}

function buildFailedPaymentEmailHtml(session, msg) {
  const name  = session.customer_name || 'there';
  const first = name.split(' ')[0];
  const total = session.cart_total ? `₹${Math.round(session.cart_total)}` : 'your order';
  return `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">
<div style="text-align:center;margin-bottom:24px;">
  <img src="https://sathvam.in/logo.png" alt="Sathvam" style="height:48px;" onerror="this.style.display='none'">
  <h2 style="color:#d97706;">Your Payment Didn't Go Through</h2>
</div>
<p>Dear ${first},</p>
<p>We noticed your recent payment for <strong>${total}</strong> was unsuccessful. This can happen due to network issues, bank declines, or session timeouts — and it's completely fixable!</p>
<div style="text-align:center;margin:28px 0;">
  <a href="https://sathvam.in/cart" style="background:#d97706;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:bold;">
    🔄 Retry Payment
  </a>
</div>
<p style="color:#555;">Or call / WhatsApp us at <strong>+91-XXXXXXXXXX</strong> and we'll help you complete the order manually.</p>
<p style="color:#888;font-size:13px;">Best regards,<br>Team Sathvam 🌿</p>
</body></html>`;
}

async function runFailedPaymentFollowUps() {
  const utcHour = new Date().getUTCHours();
  if (utcHour < 2 || utcHour > 15) return; // 7:30 AM – 9 PM IST only

  try {
    // Load all checkout sessions
    const { data: csSessions } = await supabase.from('store_analytics').select('key,data').like('key', '_cs_%').order('id', { ascending: false }).limit(500);
    const sessions = (csSessions || []).filter(r => r.data?.customer_name || r.data?.customer_phone || r.data?.customer_email);

    // Load webstore orders to filter out converted sessions
    const { data: orders } = await supabase.from('webstore_orders').select('payment_id').not('payment_id', 'is', null);
    const paidPaymentIds = new Set((orders || []).map(o => o.payment_id));

    // Load follow-up state
    const { data: stateRow } = await supabase.from('settings').select('value').eq('key', 'failed_payment_state').maybeSingle();
    const state = stateRow?.value || {};
    let updated = false;

    const now = Date.now();

    for (const row of sessions) {
      const sid = row.key.replace('_cs_', '');
      const s   = row.data || {};

      // Skip if already recovered / has payment_id that matches an order
      if (s.recovered) continue;
      if (s.payment_id && paidPaymentIds.has(s.payment_id)) continue;

      const phone = s.customer_phone || s.phone;
      const email = s.customer_email || s.email;
      if (!phone && !email) continue;

      const createdAt = new Date(s.created_at || s.updated_at || 0).getTime();
      const ageMin = (now - createdAt) / 60000;

      // Must be at least 30 min old
      if (ageMin < 30) continue;
      // Skip if older than 48h — too stale
      if (ageMin > 48 * 60) continue;

      const fpState = state[sid] || { count: 0 };
      const lastAt  = fpState.last_at ? new Date(fpState.last_at).getTime() : 0;
      const sinceLastHr = (now - lastAt) / 3600000;

      // T1: 30m–4h old, not yet followed up
      const needsT1 = fpState.count === 0 && ageMin >= 30 && ageMin <= 240;
      // T2: 4h–24h old, T1 already done, 3h since last
      const needsT2 = fpState.count === 1 && ageMin >= 240 && sinceLastHr >= 3;

      if (!needsT1 && !needsT2) continue;

      const touch = needsT1 ? 1 : 2;
      const session = { ...s, session_id: sid, _touch: touch };

      const msg = await generateFailedPaymentMessage(session);
      const htmlBody = buildFailedPaymentEmailHtml(session, msg);
      let sent = false;

      if (phone) {
        const waSent = await sendWhatsAppMsg(phone, msg.wa);
        if (waSent) { sent = true; console.log(`[FAILED-PAY-WA] T${touch} sent to ${phone} (${sid})`); }
      }
      if (email && process.env.SMTP_USER) {
        try {
          await mailer.sendMail({ from: FROM, to: email, subject: msg.subject, html: htmlBody });
          sent = true;
          console.log(`[FAILED-PAY-EMAIL] T${touch} sent to ${email} (${sid})`);
        } catch (e) { console.error('[FAILED-PAY] Email error:', e.message); }
      }

      if (sent) {
        state[sid] = { count: touch, last_at: new Date().toISOString() };
        updated = true;
      }
    }

    if (updated) {
      await supabase.from('settings').upsert({ key: 'failed_payment_state', value: state, updated_at: new Date().toISOString() });
    }
  } catch (e) { console.error('[FAILED-PAY] Error:', e.message); }
}

// Run failed payment follow-ups every 30 minutes
cron.schedule('*/30 * * * *', () => {
  runFailedPaymentFollowUps();
});

// ── Credit / Outstanding Payment Follow-Up ─────────────────────────────────────
// Retail sales where paymentMethod = 'credit' and amountPaid < finalAmount.
// Strategy:
//   T1: 3 days after sale — friendly reminder
//   T2: 7 days after sale — firmer + ask for partial payment
//   T3: 15 days after sale — final notice (admin alerted)
// State stored in settings: credit_followup_state

async function runCreditFollowUps() {
  try {
    const { data: salesRows } = await supabase
      .from('sales')
      .select('id,order_no,customer_name,phone,customer_phone,final_amount,total_amount,amount_paid,payment_method,date,channel,status')
      .eq('payment_method', 'credit')
      .neq('channel', 'return')
      .neq('status', 'cancelled')
      .order('date', { ascending: false })
      .limit(200);

    if (!salesRows?.length) return;

    const { data: stateRow } = await supabase.from('settings').select('value').eq('key', 'credit_followup_state').maybeSingle();
    const state = stateRow?.value || {};
    let updated = false;

    const now = Date.now();

    for (const sale of salesRows) {
      const finalAmt = parseFloat(sale.final_amount || sale.total_amount || 0);
      const paidAmt  = parseFloat(sale.amount_paid || 0);
      if (paidAmt >= finalAmt) continue; // fully paid

      const balance = finalAmt - paidAmt;
      const phone = (sale.customer_phone || sale.phone || '').replace(/\D/g, '');
      if (!phone || phone.length < 10) continue; // no contact

      const saleDate = new Date(sale.date).getTime();
      const ageDays  = Math.floor((now - saleDate) / 86400000);

      const cs = state[sale.id] || { count: 0 };
      const lastAt   = cs.last_at ? new Date(cs.last_at).getTime() : 0;
      const sinceLastDays = (now - lastAt) / 86400000;

      const needsT1 = cs.count === 0 && ageDays >= 3;
      const needsT2 = cs.count === 1 && ageDays >= 7 && sinceLastDays >= 2;
      const needsT3 = cs.count === 2 && ageDays >= 15 && sinceLastDays >= 2;

      if (!needsT1 && !needsT2 && !needsT3) continue;

      const touch = needsT1 ? 1 : needsT2 ? 2 : 3;
      const name  = sale.customer_name || 'valued customer';
      const first = name.split(' ')[0];
      const orderNo = sale.order_no || `#${sale.id}`;

      const msgs = {
        1: `Hi ${first}! 🙏 This is a friendly reminder from Sathvam. Your order ${orderNo} has an outstanding balance of ₹${Math.round(balance).toLocaleString('en-IN')}. Please arrange payment at your earliest convenience. Thank you!`,
        2: `Hi ${first}, following up on your Sathvam order ${orderNo} — balance of ₹${Math.round(balance).toLocaleString('en-IN')} is pending for ${ageDays} days. If it's convenient, even a partial payment helps. Please let us know if there's an issue. 🌿`,
        3: `Hi ${first}, final reminder for Sathvam order ${orderNo} — ₹${Math.round(balance).toLocaleString('en-IN')} outstanding for ${ageDays} days. Please make payment urgently. Contact us if you need to discuss. +91 70921 77092`,
      };

      const waSent = await sendWhatsAppMsg(phone, msgs[touch]);

      if (waSent) {
        console.log(`[CREDIT-FOLLOWUP] T${touch} sent to ${phone} for order ${orderNo} (balance ₹${Math.round(balance)})`);
      }

      // For T3: also alert admin via email
      if (touch === 3) {
        const adminEmails = await getAdminEmails();
        if (adminEmails.length) {
          await sendMail(adminEmails, `⚠️ Credit overdue: ${orderNo} — ₹${Math.round(balance)} for ${ageDays} days`,
            `<p>${name} (${phone}) has an outstanding balance of <strong>₹${Math.round(balance).toLocaleString('en-IN')}</strong> on order <strong>${orderNo}</strong> for <strong>${ageDays} days</strong>. Please take action.</p>`
          );
        }
      }

      state[sale.id] = { count: touch, last_at: new Date().toISOString(), phone, balance: Math.round(balance) };
      updated = true;
    }

    if (updated) {
      await supabase.from('settings').upsert({ key: 'credit_followup_state', value: state, updated_at: new Date().toISOString() });
    }
  } catch (e) { console.error('[CREDIT-FOLLOWUP] Error:', e.message); }
}

// Credit follow-up: run daily at 11 AM IST (5:30 AM UTC)
cron.schedule('30 5 * * *', () => {
  console.log('[CREDIT-FOLLOWUP] Running credit payment follow-up check…');
  runCreditFollowUps();
});

// EOD closing reminder: 5:15 PM IST daily (11:45 AM UTC)
cron.schedule('45 11 * * *', async () => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data: regData } = await supabase.from('settings').select('value').eq('key', 'pos_cash_register').maybeSingle();
    const register = regData?.value || {};
    const todayEntry = register[today] || {};
    if (todayEntry.closingBalance !== undefined) return; // already closed

    const { data: users } = await supabase.from('users').select('phone,name').in('role', ['admin', 'manager']).eq('active', true);
    if (!users?.length) return;

    const msg = `🔔 *Sathvam — EOD Reminder*\n\nHello! Factory closing time is approaching (5:30 PM).\n\n*Please complete End of Day cash closing* in the POS:\n1. Count cash in drawer\n2. Enter denomination-wise or total\n3. Submit handover (bank deposit / owner / carry forward)\n\nOpen Admin → Sales → 💰 EOD button\n\nThank you!`;
    for (const u of users) {
      if (u.phone) await sendWhatsAppMsg(u.phone.replace(/\D/g, ''), msg).catch(() => {});
    }
    console.log('[EOD-REMINDER] Sent 5:15 PM closing reminders to', users.length, 'users');
  } catch (e) { console.error('[EOD-REMINDER] Error:', e.message); }
});

// Export for use by backend manual trigger
module.exports.runCartFollowUps = runCartFollowUps;
module.exports.runFailedPaymentFollowUps = runFailedPaymentFollowUps;
module.exports.generateCartMessage = generateCartMessage;
module.exports.buildCartEmailHtml = buildCartEmailHtml;
module.exports.sendWhatsAppMsg = sendWhatsAppMsg;

// ── Startup ────────────────────────────────────────────────────────────────────

console.log('[sathvam-automation] Service started');
console.log('  Schedule:');
console.log('  • Daily 9 PM IST   — Sales summary email');
console.log('  • Daily 6 PM IST   — Low stock alert');
console.log('  • Daily 10 AM IST  — Overdue vendor payment reminder');
console.log('  • Monthly 1st      — P&L snapshot email');
console.log('  • Monthly last day — Payroll auto-generation');
console.log('  • Every 2 hours    — AI abandoned cart follow-up (3-touch sequence)');
console.log('  • Daily 5:15 PM IST — EOD cash closing reminder to admin/managers');
