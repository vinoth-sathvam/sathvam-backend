const cron       = require('node-cron');
const nodemailer = require('nodemailer');
const supabase   = require('./supabase');
const { sendText: gaSendText, isAutomationDisabled } = require('../lib/greenapi');

const mailer = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// ── Shared helpers ─────────────────────────────────────────────────────────────

async function sendWhatsApp(phone, message) {
  try { await gaSendText(phone, message); } catch (e) { console.error('WhatsApp send failed:', e.message); }
}

// Get all active managers + admins with email/phone
async function getManagerContacts() {
  const { data } = await supabase.from('users').select('name,email,phone,role').in('role',['admin','manager']).eq('active',true);
  return (data||[]).filter(u => u.email || u.phone);
}

// ── Daily task checker ─────────────────────────────────────────────────────────

async function checkDailyTasks() {
  const today = new Date().toISOString().slice(0,10);

  const [expRes, batchRes, attRes] = await Promise.all([
    supabase.from('company_expenses').select('id').eq('date', today).is('deleted_at', null).limit(1),
    supabase.from('batches').select('id').eq('date', today).limit(1),
    supabase.from('attendance').select('id').eq('date', today).limit(1),
  ]);

  return {
    date:              today,
    expenses_logged:   (expRes.data||[]).length > 0,
    batch_logged:      (batchRes.data||[]).length > 0,
    attendance_marked: (attRes.data||[]).length > 0,
  };
}

// ── Reminder email HTML ────────────────────────────────────────────────────────

function buildReminderEmail({ name, pending, time }) {
  const items = pending.map(p => `<li style="margin:4px 0">${p}</li>`).join('');
  return `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto">
  <div style="background:#1a5c2a;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
    <h2 style="margin:0;font-size:16px">Sathvam — ${time} Reminder</h2>
  </div>
  <div style="border:1px solid #ddd;border-top:none;padding:20px;border-radius:0 0 8px 8px">
    <p style="margin:0 0 12px;color:#374151">Hi ${name||'Manager'},</p>
    <p style="margin:0 0 8px;color:#374151">The following tasks are <strong>pending for today</strong>:</p>
    <ul style="margin:0 0 16px;color:#dc2626;font-weight:600">${items}</ul>
    <p style="margin:0;font-size:12px;color:#9ca3af">Please log in to <a href="https://admin.sathvam.in">admin.sathvam.in</a> and update them.</p>
  </div>
</div>`;
}

// ── Send reminders to all managers ────────────────────────────────────────────

async function sendReminders(pending, timeLabel) {
  if (!pending.length) return;
  const contacts = await getManagerContacts();
  const waMsg = `Sathvam ${timeLabel} Reminder\n\nPending tasks today:\n${pending.map(p=>`• ${p}`).join('\n')}\n\nPlease update: https://admin.sathvam.in`;

  for (const u of contacts) {
    // Email
    if (u.email && process.env.SMTP_USER && process.env.SMTP_PASS) {
      try {
        await mailer.sendMail({
          from:    process.env.SMTP_FROM || 'Sathvam <noreply@sathvam.in>',
          to:      u.email,
          subject: `Sathvam ${timeLabel} Reminder — Action Needed`,
          html:    buildReminderEmail({ name: u.name, pending, time: timeLabel }),
        });
      } catch (e) { console.error('Reminder email failed:', u.email, e.message); }
    }
    // WhatsApp
    if (u.phone) {
      await sendWhatsApp(u.phone, waMsg);
    }
  }

  // Also check MANAGER_PHONES env (comma-separated) for WA only
  const envPhones = (process.env.MANAGER_PHONES||'').split(',').map(p=>p.trim()).filter(Boolean);
  for (const phone of envPhones) {
    await sendWhatsApp(phone, waMsg);
  }
}

// ── Weekly report ──────────────────────────────────────────────────────────────

async function buildWeeklyReport() {
  const today      = new Date().toISOString().slice(0, 10);
  const d7         = new Date(Date.now() - 7  * 24*60*60*1000).toISOString().slice(0, 10);
  const d14        = new Date(Date.now() - 14 * 24*60*60*1000).toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01';
  const inr = n => '₹' + Math.round(parseFloat(n)||0).toLocaleString('en-IN');

  const [
    thisWeekSales, lastWeekSales, monthSales,
    thisWeekWso, lastWeekWso, monthWso,
    thisWeekB2b,
    stockData, products, pendingOrders, weekExp,
    bankAccs, procData,
  ] = await Promise.all([
    supabase.from('sales').select('final_amount,channel,status').gte('date', d7).lte('date', today).in('status',['delivered','dispatched','paid']),
    supabase.from('sales').select('final_amount').gte('date', d14).lt('date', d7).in('status',['delivered','dispatched','paid']),
    supabase.from('sales').select('final_amount').gte('date', monthStart).lte('date', today).in('status',['delivered','dispatched','paid']),
    supabase.from('webstore_orders').select('total').gte('date', d7).lte('date', today).in('status',['confirmed','shipped','delivered','paid']),
    supabase.from('webstore_orders').select('total').gte('date', d14).lt('date', d7).in('status',['confirmed','shipped','delivered','paid']),
    supabase.from('webstore_orders').select('total').gte('date', monthStart).lte('date', today).in('status',['confirmed','shipped','delivered','paid']),
    supabase.from('b2b_orders').select('total_value').gte('date', monthStart).lte('date', today).not('stage','eq','cancelled'),
    supabase.from('stock_ledger').select('product_id,type,qty'),
    supabase.from('products').select('id,name').eq('active', true),
    supabase.from('webstore_orders').select('order_no,customer,total').in('status',['confirmed','processing']).limit(10),
    supabase.from('company_expenses').select('category,amount').gte('date', d7).lte('date', today).is('deleted_at', null),
    supabase.from('bank_accounts').select('name,current_balance').eq('is_active', true),
    supabase.from('procurements').select('ordered_qty,ordered_price_per_kg,gst').gte('date', d7).lte('date', today).in('status',['received','stocked','cleaned']),
  ]);

  // Revenue
  const twSalesRev = (thisWeekSales.data||[]).reduce((s,r)=>s+parseFloat(r.final_amount||0),0);
  const twWsoRev   = (thisWeekWso.data||[]).reduce((s,r)=>s+parseFloat(r.total||0),0);
  const twRev      = twSalesRev + twWsoRev;
  const lwRev      = (lastWeekSales.data||[]).reduce((s,r)=>s+parseFloat(r.final_amount||0),0)
                   + (lastWeekWso.data||[]).reduce((s,r)=>s+parseFloat(r.total||0),0);
  const monSalesRev= (monthSales.data||[]).reduce((s,r)=>s+parseFloat(r.final_amount||0),0);
  const monWsoRev  = (monthWso.data||[]).reduce((s,r)=>s+parseFloat(r.total||0),0);
  const monB2bRev  = (thisWeekB2b.data||[]).reduce((s,r)=>s+parseFloat(r.total_value||0),0);
  const monRev     = monSalesRev + monWsoRev + monB2bRev;

  // Expenses & COGS
  const weekExpTotal = (weekExp.data||[]).reduce((s,r)=>s+parseFloat(r.amount||0),0);
  const weekProcCost = (procData.data||[]).reduce((s,r)=>{
    const qty=parseFloat(r.ordered_qty||0), rate=parseFloat(r.ordered_price_per_kg||0), gst=parseFloat(r.gst||0);
    return s + qty*rate*(1+gst/100);
  },0);
  const weekGrossProfit = twRev - weekProcCost;
  const weekNet = twRev - weekExpTotal - weekProcCost;

  // Gross margin
  const grossMarginPct = twRev > 0 ? Math.round(weekGrossProfit / twRev * 100) : 0;
  const netMarginPct   = twRev > 0 ? Math.round(weekNet / twRev * 100) : 0;

  const revChange = lwRev > 0 ? Math.round(((twRev-lwRev)/lwRev)*100) : 0;

  // Bank balance
  const cashBalance = (bankAccs.data||[]).reduce((s,a)=>s+(a.current_balance||0),0);

  // Stock
  const stock = {};
  for (const row of stockData.data||[]) {
    if (!stock[row.product_id]) stock[row.product_id] = 0;
    stock[row.product_id] += row.type==='IN' ? (+row.qty||0) : -(+row.qty||0);
  }
  const lowStock = (products.data||[]).filter(p => (stock[p.id]||0) < 10).map(p => p.name);

  // Channel breakdown (sales table only)
  const byChannel = {};
  for (const r of thisWeekSales.data||[]) byChannel[r.channel||'Direct'] = (byChannel[r.channel||'Direct']||0) + parseFloat(r.final_amount||0);
  byChannel['Webstore'] = (byChannel['Webstore']||0) + twWsoRev;

  const channelRows = Object.entries(byChannel)
    .map(([ch,rev]) => `<tr><td style="padding:6px 12px">${ch}</td><td style="padding:6px 12px;text-align:right;font-weight:600">${inr(rev)}</td></tr>`).join('');

  const expByCat = {};
  for (const r of weekExp.data||[]) expByCat[r.category] = (expByCat[r.category]||0) + parseFloat(r.amount||0);
  const expCatRows = Object.entries(expByCat).sort((a,b)=>b[1]-a[1])
    .map(([cat,amt]) => `<tr><td style="padding:5px 10px;color:#6b7280">${cat}</td><td style="padding:5px 10px;text-align:right;font-weight:600">${inr(amt)}</td></tr>`).join('');

  const html = `
<div style="font-family:sans-serif;max-width:640px;margin:0 auto">
  <div style="background:linear-gradient(135deg,#0f2820,#1a5c2a);color:#fff;padding:20px 24px;border-radius:8px 8px 0 0">
    <h2 style="margin:0;font-size:18px">📊 Sathvam Weekly P&amp;L Report</h2>
    <p style="margin:4px 0 0;opacity:.8;font-size:13px">${d7} → ${today} · Auto-generated every Monday 9 AM IST</p>
  </div>
  <div style="border:1px solid #ddd;border-top:none;padding:20px 24px;border-radius:0 0 8px 8px;background:#fff">

    <!-- KPI Cards -->
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px">
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:11px;color:#6b7280;margin-bottom:4px">THIS WEEK REVENUE</div>
        <div style="font-size:20px;font-weight:800;color:#15803d">${inr(twRev)}</div>
        <div style="font-size:11px;color:${revChange>=0?'#16a34a':'#dc2626'}">${revChange>=0?'▲':'▼'} ${Math.abs(revChange)}% vs last week</div>
      </div>
      <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:11px;color:#6b7280;margin-bottom:4px">GROSS PROFIT</div>
        <div style="font-size:20px;font-weight:800;color:${weekGrossProfit>=0?'#15803d':'#dc2626'}">${inr(weekGrossProfit)}</div>
        <div style="font-size:11px;color:#6b7280">${grossMarginPct}% margin</div>
      </div>
      <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:11px;color:#6b7280;margin-bottom:4px">CASH IN BANK</div>
        <div style="font-size:20px;font-weight:800;color:${cashBalance>=50000?'#15803d':cashBalance>=0?'#d97706':'#dc2626'}">${inr(cashBalance)}</div>
        <div style="font-size:11px;color:#6b7280">As of today</div>
      </div>
    </div>

    <!-- P&L Table -->
    <h3 style="margin:0 0 8px;font-size:14px;color:#374151;border-bottom:2px solid #e5e7eb;padding-bottom:6px">📈 Weekly P&amp;L Summary</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px">
      <tbody>
        <tr><td style="padding:6px 10px;color:#374151">Revenue (Sales + Webstore)</td><td style="padding:6px 10px;text-align:right;font-weight:600;color:#15803d">${inr(twRev)}</td></tr>
        <tr style="background:#fafafa"><td style="padding:6px 10px;color:#6b7280">  Raw Material Cost (COGS)</td><td style="padding:6px 10px;text-align:right;color:#dc2626">(${inr(weekProcCost)})</td></tr>
        <tr style="border-top:1px solid #e5e7eb"><td style="padding:6px 10px;font-weight:700">Gross Profit</td><td style="padding:6px 10px;text-align:right;font-weight:800;color:${weekGrossProfit>=0?'#15803d':'#dc2626'}">${inr(weekGrossProfit)} <span style="font-weight:400;font-size:11px">(${grossMarginPct}%)</span></td></tr>
        <tr style="background:#fafafa"><td style="padding:6px 10px;color:#6b7280">  Operating Expenses</td><td style="padding:6px 10px;text-align:right;color:#dc2626">(${inr(weekExpTotal)})</td></tr>
        <tr style="border-top:2px solid #374151"><td style="padding:8px 10px;font-weight:800;font-size:14px">Net Profit / (Loss)</td><td style="padding:8px 10px;text-align:right;font-weight:800;font-size:14px;color:${weekNet>=0?'#15803d':'#dc2626'}">${inr(weekNet)} <span style="font-weight:400;font-size:11px">(${netMarginPct}%)</span></td></tr>
      </tbody>
    </table>

    <!-- Month Revenue -->
    <div style="background:#f8fafc;border-radius:8px;padding:14px;margin-bottom:18px;font-size:13px">
      <strong>Month-to-Date Revenue (${today.slice(0,7)})</strong><br>
      <span style="color:#6b7280">Local Sales: </span><strong>${inr(monSalesRev)}</strong> &nbsp;|&nbsp;
      <span style="color:#6b7280">Webstore: </span><strong>${inr(monWsoRev)}</strong> &nbsp;|&nbsp;
      <span style="color:#6b7280">B2B: </span><strong>${inr(monB2bRev)}</strong><br>
      <span style="font-size:12px;color:#6b7280">Total MTD: </span><strong style="font-size:15px;color:#15803d">${inr(monRev)}</strong>
    </div>

    <!-- Channel breakdown -->
    ${channelRows ? `
    <h3 style="margin:0 0 8px;font-size:14px;color:#374151">Revenue by Channel</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
      <tbody>${channelRows}</tbody>
    </table>` : ''}

    <!-- Expenses -->
    ${expCatRows ? `
    <h3 style="margin:0 0 8px;font-size:14px;color:#374151">Expenses This Week</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
      <tbody>${expCatRows}</tbody>
      <tfoot><tr style="background:#fef2f2;font-weight:700"><td style="padding:6px 10px">Total</td><td style="padding:6px 10px;text-align:right;color:#dc2626">${inr(weekExpTotal)}</td></tr></tfoot>
    </table>` : ''}

    <!-- Low stock alert -->
    ${lowStock.length > 0 ? `
    <div style="background:#fff1f2;border:1px solid #fecdd3;border-radius:8px;padding:12px;margin-bottom:14px">
      <strong style="color:#dc2626">⚠️ Low Stock (${lowStock.length} products)</strong>
      <p style="margin:6px 0 0;font-size:12px;color:#7f1d1d">${lowStock.slice(0,10).join(', ')}${lowStock.length>10?` and ${lowStock.length-10} more`:''}</p>
    </div>` : ''}

    <!-- Pending orders -->
    ${(pendingOrders.data||[]).length > 0 ? `
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px;margin-bottom:14px">
      <strong style="color:#92400e">📦 Pending Webstore Orders (${(pendingOrders.data||[]).length})</strong>
      <ul style="margin:6px 0 0;padding-left:16px;font-size:12px;color:#78350f">
        ${(pendingOrders.data||[]).map(o=>`<li>${o.order_no} — ${typeof o.customer==='object'?(o.customer?.name||'Guest'):'Guest'} — ${inr(o.total)}</li>`).join('')}
      </ul>
    </div>` : ''}

    <div style="border-top:1px solid #e5e7eb;margin-top:16px;padding-top:12px;text-align:center">
      <a href="https://admin.sathvam.in" style="display:inline-block;background:#1a5c2a;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">View Full Dashboard →</a>
      <p style="margin:10px 0 0;font-size:11px;color:#9ca3af">Sathvam Natural Products · Karur, Tamil Nadu · Auto-generated Monday 9 AM IST</p>
    </div>
  </div>
</div>`;
  return html;
}

// ── Scheduler ──────────────────────────────────────────────────────────────────

function startScheduler() {
  // ── Weekly report: Every Monday 9:00 AM IST (3:30 AM UTC) ─────────────────
  cron.schedule('30 3 * * 1', async () => {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;
    try {
      const html  = await buildWeeklyReport();
      const today = new Date().toISOString().slice(0, 10);
      // Send to all admins + CEO role users + configured address
      const { data: admins } = await supabase.from('users').select('email').in('role',['admin','ceo']).eq('active',true);
      const toList = [...new Set(['vinoth@sathvam.in', ...(admins||[]).map(u=>u.email).filter(Boolean)])];
      await mailer.sendMail({
        from:    process.env.SMTP_FROM || 'Sathvam <noreply@sathvam.in>',
        to:      toList.join(','),
        subject: `Sathvam Weekly Report — ${today}`,
        html,
      });
      console.log('Weekly report sent to:', toList.join(', '));
    } catch (e) { console.error('Weekly report failed:', e.message); }
  });

  // ── Morning reminder: 9:00 AM IST (3:30 AM UTC) — always send ─────────────
  cron.schedule('30 3 * * *', async () => {
    if (await isAutomationDisabled('manager_reminders')) return;
    const today = new Date().toISOString().slice(0,10);
    const pending = [
      'Set today\'s opening balance in Expenses tab',
      'Log all daily expenses as they occur',
      'Mark today\'s attendance in Payroll tab',
      'Log production batch if running today',
    ];
    await sendReminders(pending, 'Morning (9 AM)');
    console.log(`Morning reminder sent — ${today}`);
  });

  // ── Afternoon check: 1:30 PM IST (8:00 AM UTC) — only if tasks missing ────
  cron.schedule('0 8 * * *', async () => {
    if (await isAutomationDisabled('manager_reminders')) return;
    try {
      const tasks  = await checkDailyTasks();
      const pending = [];
      if (!tasks.expenses_logged)   pending.push('No expenses logged today — please record all transactions');
      if (!tasks.batch_logged)      pending.push('No production batch logged today');
      if (!tasks.attendance_marked) pending.push('Attendance not marked for today');
      if (pending.length > 0) {
        await sendReminders(pending, 'Afternoon Check (1:30 PM)');
        console.log('Afternoon reminder sent:', pending);
      }
    } catch (e) { console.error('Afternoon check failed:', e.message); }
  });

  // ── Evening summary: 7:00 PM IST (1:30 PM UTC) — status + nudge + sales WA ─
  cron.schedule('30 13 * * *', async () => {
    if (!await isAutomationDisabled('manager_reminders')) {
    try {
      const tasks  = await checkDailyTasks();
      const pending = [];
      if (!tasks.expenses_logged)   pending.push('Expenses not logged for today');
      if (!tasks.batch_logged)      pending.push('Production batch not logged');
      if (!tasks.attendance_marked) pending.push('Attendance not marked');

      if (pending.length > 0) {
        await sendReminders(pending, 'Evening Reminder (7 PM)');
        console.log('Evening reminder sent:', pending);
      } else {
        console.log('Evening check: all daily tasks completed — no reminder needed');
      }
    } catch (e) { console.error('Evening check failed:', e.message); }
    }

    // Send daily sales summary WA to admin phones
    if (!await isAutomationDisabled('daily_sales_summary')) try {
      const today = new Date().toISOString().slice(0, 10);
      const [wsoRes, salesRes] = await Promise.all([
        supabase.from('webstore_orders').select('total,status').eq('date', today),
        supabase.from('sales').select('final_amount,status').eq('date', today),
      ]);

      const wsoOrders  = wsoRes.data  || [];
      const saleOrders = salesRes.data || [];

      const totalOrders   = wsoOrders.length + saleOrders.length;
      const totalRevenue  = wsoOrders.reduce((s, r) => s + parseFloat(r.total || 0), 0)
                          + saleOrders.reduce((s, r) => s + parseFloat(r.final_amount || 0), 0);
      const pendingCount  = wsoOrders.filter(o => ['confirmed','processing','packed'].includes(o.status)).length;
      const deliveredCount= wsoOrders.filter(o => o.status === 'delivered').length;

      const dateLabel = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
      const summaryMsg =
        `📊 *Sathvam Daily Summary — ${dateLabel}*\n\n` +
        `🛒 Orders Today: ${totalOrders}\n` +
        `💰 Revenue: ₹${Math.round(totalRevenue).toLocaleString('en-IN')}\n` +
        `📦 Pending Orders: ${pendingCount}\n` +
        `✅ Delivered: ${deliveredCount}\n\n` +
        `_View full report: admin.sathvam.in_`;

      const adminPhones = [process.env.WA_ADMIN_PHONE1, process.env.WA_ADMIN_PHONE2, process.env.WA_NOTIFY_TO]
        .filter(Boolean).map(p => p.replace(/\D/g, ''));
      for (const p of adminPhones) {
        try { await gaSendText(p, summaryMsg); } catch (e) {}
      }
      console.log(`[SALES-SUMMARY] Daily WA summary sent — ${totalOrders} orders, ₹${Math.round(totalRevenue)}`);
    } catch (e) { console.error('[SALES-SUMMARY] Failed:', e.message); }
  });

  // ── AI Monitor Agent: 9:00 AM IST (3:30 AM UTC) daily ────────────────────
  cron.schedule('30 3 * * *', async () => {
    if (await isAutomationDisabled('manager_reminders')) return;
    try {
      // Lazy-require to avoid circular dependency at startup
      const monitorAgent = require('../routes/monitorAgent');
      // monitorAgent exports the router — use the runAgent via a direct import
      const { runMonitorAgent } = require('../routes/monitorAgent');
      if (typeof runMonitorAgent === 'function') {
        const report = await runMonitorAgent();
        const criticals = (report.issues||[]).filter(i=>i.severity==='CRITICAL').length;
        const highs     = (report.issues||[]).filter(i=>i.severity==='CRITICAL'||i.severity==='HIGH').length;
        if (highs > 0) {
          await sendReminders([
            `🤖 Monitor Agent found ${criticals} CRITICAL + ${highs} HIGH issues`,
            `Score: ${report.score}/100 — ${report.summary}`,
          ], 'Daily Monitor Agent Alert');
        }
        console.log(`Monitor agent ran — score: ${report.score}, issues: ${(report.issues||[]).length}`);
      }
    } catch(e) { console.error('Monitor agent scheduler error:', e.message); }
  });

  // ── Low Stock Alert: 8:00 AM IST (2:30 AM UTC) daily ─────────────────────
  cron.schedule('30 2 * * *', async () => {
    if (await isAutomationDisabled('low_stock_alert')) return;
    try {
      // Get finished goods stock levels
      const { data: products } = await supabase
        .from('products').select('id,name,sku').eq('active', true);
      if (!products?.length) return;

      const { data: stockData } = await supabase
        .from('stock_ledger').select('product_id,type,qty');
      const stock = {};
      (stockData || []).forEach(r => {
        if (!stock[r.product_id]) stock[r.product_id] = 0;
        stock[r.product_id] += r.type === 'IN' ? Number(r.qty) : -Number(r.qty);
      });

      const LOW_THRESHOLD = 20; // units
      const CRITICAL_THRESHOLD = 5;

      const critical = products.filter(p => (stock[p.id] || 0) <= CRITICAL_THRESHOLD);
      const low      = products.filter(p => (stock[p.id] || 0) > CRITICAL_THRESHOLD && (stock[p.id] || 0) <= LOW_THRESHOLD);

      if (critical.length === 0 && low.length === 0) return;

      const contacts = await getManagerContacts();
      if (!contacts.length) return;

      // Email alert
      const rows = [
        ...critical.map(p => `<tr><td style="padding:8px 12px;color:#1f2937;font-weight:700;">${p.name}</td><td style="padding:8px 12px;color:#dc2626;font-weight:800;">${stock[p.id] || 0} units</td><td style="padding:8px 12px;"><span style="background:#fee2e2;color:#dc2626;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:700;">CRITICAL</span></td></tr>`),
        ...low.map(p     => `<tr><td style="padding:8px 12px;color:#1f2937;">${p.name}</td><td style="padding:8px 12px;color:#d97706;font-weight:700;">${stock[p.id] || 0} units</td><td style="padding:8px 12px;"><span style="background:#fef3c7;color:#d97706;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:700;">LOW</span></td></tr>`),
      ].join('');

      const html = `
<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
  <div style="background:linear-gradient(135deg,${critical.length>0?'#7f1d1d,#991b1b':'#78350f,#92400e'});padding:18px 24px;">
    <h2 style="color:#fff;margin:0;font-size:17px;">${critical.length>0?'🔴 Critical':'⚠️ Low'} Stock Alert — ${new Date().toLocaleDateString('en-IN',{timeZone:'Asia/Kolkata'})}</h2>
    <div style="color:${critical.length>0?'#fca5a5':'#fcd34d'};font-size:12px;margin-top:4px;">${critical.length} critical · ${low.length} low stock products</div>
  </div>
  <div style="padding:20px 24px;">
    <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <thead><tr style="background:#f9fafb;"><th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;">Product</th><th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;">Stock</th><th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;">Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <a href="https://admin.sathvam.in" style="display:inline-block;margin-top:16px;background:#1f2937;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:700;">View Raw Stock →</a>
  </div>
</div>`;

      const toList = contacts.filter(c => c.email).map(c => c.email);
      if (toList.length > 0) {
        await mailer.sendMail({
          from:    process.env.SMTP_FROM || 'Sathvam <noreply@sathvam.in>',
          to:      toList.join(','),
          subject: `${critical.length > 0 ? '🔴 CRITICAL' : '⚠️ Low'} Stock Alert — ${critical.length + low.length} product(s) need restocking`,
          html,
        });
      }

      // WhatsApp alert for critical items
      if (critical.length > 0) {
        const msg = `🔴 *CRITICAL Stock Alert*\n\nThe following products are almost out of stock:\n\n${critical.map(p=>`• ${p.name}: *${stock[p.id]||0} units*`).join('\n')}\n\nPlease place procurement orders immediately.\n\nhttps://admin.sathvam.in`;
        for (const c of contacts.filter(x => x.phone)) await sendWhatsApp(c.phone, msg);
      }

      console.log(`Low-stock alert sent — ${critical.length} critical, ${low.length} low`);
    } catch (e) { console.error('Low stock alert failed:', e.message); }
  });

  // ── Birthday coupon: 9:00 AM IST (3:30 AM UTC) daily ─────────────────────
  cron.schedule('30 3 * * *', async () => {
    if (await isAutomationDisabled('birthday_greeting')) return;
    try {
      const { decrypt } = require('../config/crypto');
      const today = new Date();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');
      const monthDay = `${mm}-${dd}`; // compare LIKE %-MM-DD

      // Find customers whose birthday matches today (stored as YYYY-MM-DD)
      const { data: bCustomers } = await supabase.from('customers')
        .select('id,name,email,phone,birthday')
        .like('birthday', `%-${monthDay}`);

      if (!bCustomers?.length) return;

      const sendBirthdayWA = async (phone, msg) => {
        try { await gaSendText(phone, msg); } catch(e) { console.error('Birthday WA failed:', e.message); }
      };

      for (const c of bCustomers) {
        try {
          const name  = decrypt(c.name)  || 'Valued Customer';
          const email = decrypt(c.email) || '';
          const phone = (decrypt(c.phone) || '').replace(/\D/g, '');
          const firstName = name.split(' ')[0];

          // Generate unique birthday coupon code: BDAY<customerIdPrefix>
          const couponCode = `BDAY${c.id.replace(/-/g,'').slice(0,6).toUpperCase()}`;
          const expiresAt  = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7).toISOString().slice(0,10);

          // Upsert coupon in coupons table
          await supabase.from('coupons').upsert({
            code:        couponCode,
            type:        'percent',
            value:       10,
            min_order:   0,
            max_uses:    1,
            uses_count:  0,
            expires_at:  expiresAt,
            active:      true,
            description: `Birthday coupon for customer ${c.id}`,
          }, { onConflict: 'code', ignoreDuplicates: false });

          const waMsg =
            `🎂 *Happy Birthday, ${firstName}!*\n\n` +
            `சத்துவம் குடும்பத்தின் சார்பில் உங்களுக்கு பிறந்தநாள் வாழ்த்துக்கள்! 🌿\n` +
            `_Wishing you a wonderful birthday from the Sathvam family!_\n\n` +
            `🎁 உங்கள் சிறப்பு பிறந்தநாள் பரிசு:\n` +
            `*${couponCode}* — 10% off your next order!\n` +
            `_(Valid for 7 days — expires ${expiresAt})_\n\n` +
            `🛒 Shop now: *sathvam.in*\n` +
            `❓ Help: +91 70923 77092`;

          if (phone) {
            await sendBirthdayWA(phone, waMsg);
            console.log(`[BIRTHDAY] Coupon ${couponCode} sent via WA to ${phone.slice(0,4)}****`);
          }
          if (email && process.env.SMTP_USER) {
            await mailer.sendMail({
              from:    process.env.SMTP_FROM || 'Sathvam <noreply@sathvam.in>',
              to:      email,
              subject: `🎂 Happy Birthday ${firstName}! Your special gift inside`,
              html:    `<div style="font-family:sans-serif;max-width:520px;margin:0 auto">
                <div style="background:#1a5c2a;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0;text-align:center">
                  <div style="font-size:40px">🎂</div>
                  <h2 style="margin:8px 0">Happy Birthday, ${firstName}!</h2>
                </div>
                <div style="border:1px solid #ddd;border-top:none;padding:24px;border-radius:0 0 8px 8px;text-align:center">
                  <p style="color:#374151;font-size:15px">சத்துவம் குடும்பத்தின் சார்பில் உங்களுக்கு பிறந்தநாள் வாழ்த்துக்கள்!</p>
                  <p style="color:#374151;font-size:15px">Wishing you a wonderful birthday from the Sathvam family! 🌿</p>
                  <div style="background:#f0fdf4;border:2px dashed #16a34a;border-radius:12px;padding:20px;margin:20px 0">
                    <p style="margin:0 0 8px;color:#374151;font-size:14px">Your Birthday Gift</p>
                    <div style="font-size:28px;font-weight:bold;color:#16a34a;letter-spacing:4px">${couponCode}</div>
                    <p style="margin:8px 0 0;color:#6b7280;font-size:13px">10% off your next order · Valid until ${expiresAt}</p>
                  </div>
                  <a href="https://sathvam.in" style="display:inline-block;background:#1a5c2a;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:15px">Shop Now →</a>
                </div>
              </div>`,
            });
            console.log(`[BIRTHDAY] Coupon email sent to ${email.slice(0,3)}***`);
          }
        } catch(ce) { console.error(`[BIRTHDAY] Failed for customer ${c.id}:`, ce.message); }
      }
      console.log(`[BIRTHDAY] Processed ${bCustomers.length} birthday(s) for ${mm}-${dd}`);
    } catch(e) { console.error('[BIRTHDAY] Cron failed:', e.message); }
  });

  // ── Weekly Health Tip: Every Sunday 7:00 AM IST (1:30 AM UTC) ─────────────
  const HEALTH_TIPS = [
    '🫒 *Groundnut Oil Health Tip*\nCold-pressed groundnut oil retains Vitamin E and healthy fats. Use for high-heat cooking. Rich in resveratrol — heart-healthy! 🫀',
    '🌿 *Sesame Oil Tip*\nTil (sesame) oil has lignans that support liver health and bone density. Ideal for tadka & traditional cooking.',
    '🧡 *Turmeric Tip*\nHaldi contains curcumin — a powerful anti-inflammatory. Add a pinch of black pepper to boost absorption by 2000%! 🌶️',
    '🌰 *Cold-Pressed Oil Tip*\nCold pressing retains all natural antioxidants. Heated/refined oils lose up to 70% of nutrients during processing.',
    '💪 *Sesame Oil Massage*\nWarm sesame oil massage (Abhyanga) improves circulation, reduces stress, and strengthens bones. Try it on weekends!',
    '🌾 *Ragi (Finger Millet) Tip*\nRagi is the richest plant source of calcium — great for kids and seniors. Sprouted ragi has even more bioavailability.',
    '🫀 *Groundnut (Peanut) Tip*\nPeanuts have as much protein as meat! Great for muscle building. Choose un-roasted, natural varieties for max benefit.',
    '🧘 *Oil Pulling Tip*\nSwish 1 tablespoon of sesame or coconut oil in your mouth for 10-15 min. Ancient Ayurvedic practice for oral health!',
  ];

  cron.schedule('30 1 * * 0', async () => {
    if (await isAutomationDisabled('health_tips')) return;
    try {
      const { decrypt } = require('../config/crypto');
      const tipIndex = Math.floor(new Date().getDate() / 7) % HEALTH_TIPS.length;
      const tip = HEALTH_TIPS[tipIndex];

      // Fetch all customers whose phone is not null
      const { data: customers } = await supabase.from('customers').select('id,phone');
      if (!customers?.length) return;

      let sent = 0, skipped = 0;
      for (const cust of customers) {
        try {
          // Check opt-out
          const phone = (decrypt(cust.phone) || '').replace(/\D/g, '');
          if (!phone || phone.length < 10) { skipped++; continue; }
          const fullPhone = phone.length === 10 ? `91${phone}` : phone;
          const { data: optout } = await supabase.from('settings')
            .select('value').eq('key', `wa_optout_${fullPhone}`).maybeSingle();
          if (optout?.value?.opted_out) { skipped++; continue; }

          await gaSendText(fullPhone, `🌿 *Sathvam Health Tip of the Week*\n\n${tip}\n\n_From Sathvam Natural Products — sathvam.in_`);
          sent++;
          // Rate-limit: small delay between sends
          await new Promise(r => setTimeout(r, 500));
        } catch (e) { skipped++; }
      }
      console.log(`[HEALTH-TIP] Sent to ${sent} customers, skipped ${skipped}`);
    } catch (e) { console.error('[HEALTH-TIP] Cron failed:', e.message); }
  });

  // ── Win-Back Campaign: Daily 10:00 AM IST (4:30 AM UTC) ──────────────────
  cron.schedule('30 4 * * *', async () => {
    if (await isAutomationDisabled('re_engagement')) return;
    try {
      const { decrypt } = require('../config/crypto');
      const cutoffDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const today      = new Date().toISOString().slice(0, 10);

      // Get customers whose last order was 60+ days ago (only process a batch of 20 per day)
      const { data: oldOrders } = await supabase
        .from('webstore_orders')
        .select('customer_email_hash, date')
        .lte('date', cutoffDate)
        .order('date', { ascending: false })
        .limit(200);

      if (!oldOrders?.length) return;

      // Group by customer_email_hash — get latest order date
      const latestByHash = {};
      for (const o of oldOrders) {
        if (!o.customer_email_hash) continue;
        if (!latestByHash[o.customer_email_hash] || o.date > latestByHash[o.customer_email_hash]) {
          latestByHash[o.customer_email_hash] = o.date;
        }
      }

      // Filter those with NO order after cutoffDate
      const { data: recentOrders } = await supabase
        .from('webstore_orders')
        .select('customer_email_hash')
        .gt('date', cutoffDate)
        .lte('date', today);
      const recentHashes = new Set((recentOrders || []).map(o => o.customer_email_hash).filter(Boolean));
      const lostHashes = Object.keys(latestByHash).filter(h => !recentHashes.has(h)).slice(0, 20);

      if (!lostHashes.length) return;

      let sent = 0;
      for (const emailHash of lostHashes) {
        try {
          // Find customer by email hash
          const { data: cust } = await supabase
            .from('customers')
            .select('id,name,phone')
            .eq('email_hash', emailHash)
            .maybeSingle();
          if (!cust) continue;

          const phone = (decrypt(cust.phone) || '').replace(/\D/g, '');
          if (!phone || phone.length < 10) continue;
          const fullPhone = phone.length === 10 ? `91${phone}` : phone;

          // Check opt-out
          const { data: optout } = await supabase.from('settings')
            .select('value').eq('key', `wa_optout_${fullPhone}`).maybeSingle();
          if (optout?.value?.opted_out) continue;

          // Check if win-back already sent recently
          const wbKey = `wa_winback_${cust.id}`;
          const { data: lastWb } = await supabase.from('settings')
            .select('value').eq('key', wbKey).maybeSingle();
          if (lastWb?.value?.sent_at) {
            const daysSince = (Date.now() - new Date(lastWb.value.sent_at).getTime()) / (24*60*60*1000);
            if (daysSince < 30) continue; // Don't re-send within 30 days
          }

          // Create 10% win-back coupon
          const name = (decrypt(cust.name) || '').split(' ')[0] || 'Customer';
          const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
          const couponCode = `BACK${rand}`;
          const expiresAt  = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

          await supabase.from('coupons').insert({
            code: couponCode, type: 'percent', value: 10, min_order: 0,
            max_uses: 1, uses_count: 0, expires_at: expiresAt,
            active: true, description: `winback:${cust.id}`,
          });

          const msg =
            `🌿 *நலமா? We Miss You, ${name}!*\n\n` +
            `_It's been a while since your last Sathvam order._\n\n` +
            `உங்களுக்காக ஒரு சிறப்பு தள்ளுபடி:\n` +
            `*${couponCode}* — 10% OFF your next order!\n` +
            `_(Valid until ${expiresAt})_\n\n` +
            `🛒 Shop now: https://sathvam.in\n` +
            `📞 +91 70923 77092`;

          await gaSendText(fullPhone, msg);
          await supabase.from('settings').upsert({ key: wbKey, value: { sent_at: new Date().toISOString(), coupon: couponCode } });
          sent++;
          await new Promise(r => setTimeout(r, 1000));
        } catch (e) { console.error('[WINBACK] Customer error:', e.message); }
      }
      console.log(`[WINBACK] Win-back campaign sent to ${sent} customers`);
    } catch (e) { console.error('[WINBACK] Cron failed:', e.message); }
  });

  // ── B2B Payment Reminder: Daily 9:00 AM IST (3:30 AM UTC) ────────────────
  cron.schedule('35 3 * * *', async () => {
    if (await isAutomationDisabled('b2b_payment_reminder')) return;
    try {
      // Get B2B orders that are shipped or lc_opened with payment_terms set
      const { data: b2bOrders } = await supabase
        .from('b2b_orders')
        .select('id,order_no,date,total_value,stage,b2b_customer_id')
        .in('stage', ['shipped', 'lc_opened']);

      if (!b2bOrders?.length) return;

      // Get payment terms for each customer
      const customerIds = [...new Set(b2bOrders.map(o => o.b2b_customer_id).filter(Boolean))];
      const { data: b2bCustomers } = await supabase
        .from('b2b_customers')
        .select('id,company_name,payment_terms')
        .in('id', customerIds);

      const custMap = {};
      for (const c of b2bCustomers || []) custMap[c.id] = c;

      const overdue = [];
      const today   = new Date();

      for (const order of b2bOrders) {
        const cust = custMap[order.b2b_customer_id];
        if (!cust) continue;
        const paymentTermsDays = parseInt(cust.payment_terms) || 30;
        const orderDate   = new Date(order.date);
        const dueDate     = new Date(orderDate.getTime() + paymentTermsDays * 24 * 60 * 60 * 1000);
        const daysOverdue = Math.floor((today - dueDate) / (24 * 60 * 60 * 1000));

        if (daysOverdue >= 0) {
          overdue.push({
            orderNo:     order.order_no,
            company:     cust.company_name,
            total:       order.total_value,
            daysOverdue,
            dueDate:     dueDate.toISOString().slice(0, 10),
          });
        }
      }

      if (!overdue.length) return;

      const inr = n => '₹' + Math.round(parseFloat(n) || 0).toLocaleString('en-IN');
      const lines = overdue.map(o =>
        `  • ${o.orderNo} — ${o.company} — ${inr(o.total)} — *${o.daysOverdue}d overdue*`
      ).join('\n');

      const msg =
        `🏢 *B2B Payment Reminder*\n\n` +
        `The following B2B orders have payments due or overdue:\n\n` +
        `${lines}\n\n` +
        `⚡ Total overdue: ${overdue.length} order(s)\n` +
        `_Check: admin.sathvam.in → B2B Orders_`;

      const adminPhones = [process.env.WA_ADMIN_PHONE1, process.env.WA_NOTIFY_TO]
        .filter(Boolean).map(p => p.replace(/\D/g, ''));
      for (const p of adminPhones) {
        try { await gaSendText(p, msg); } catch (e) {}
      }
      console.log(`[B2B-PAYMENT] Reminder sent — ${overdue.length} overdue orders`);
    } catch (e) { console.error('[B2B-PAYMENT] Cron failed:', e.message); }
  });

  // ── Scheduled WA Broadcast Processor — every 5 minutes ──────────────────
  cron.schedule('*/5 * * * *', async () => {
    if (await isAutomationDisabled('scheduled_broadcasts')) return;
    try {
      const { data } = await supabase.from('settings').select('value').eq('key', 'wa_schedules').maybeSingle();
      const schedules = data?.value || [];
      const now = new Date();
      const pending = schedules.filter(s => s.status === 'pending' && new Date(s.scheduledAt) <= now);
      if (!pending.length) return;

      const { decrypt } = require('../config/crypto');
      const { sendFile: gaSendFile } = require('../lib/greenapi');

      for (const sched of pending) {
        try {
          // Fetch all non-opted-out phones
          const { data: rawCustomers } = await supabase.from('customers').select('id,phone').not('phone', 'is', null).limit(5000);
          const { data: optouts } = await supabase.from('settings').select('key').like('key', 'wa_optout_%');
          const optoutSet = new Set((optouts || []).map(o => o.key));

          const phones = (rawCustomers || []).map(c => {
            const ph = (decrypt(c.phone) || '').replace(/\D/g, '');
            return ph.length >= 10 && !optoutSet.has(`wa_optout_${ph}`) ? (ph.length === 10 ? '91' + ph : ph) : null;
          }).filter(Boolean);

          let sent = 0, failed = 0;
          for (const phone of phones) {
            try {
              const ok = sched.imageUrl
                ? await gaSendFile(phone, sched.imageUrl, 'sathvam.jpg', sched.message)
                : await gaSendText(phone, sched.message);
              if (ok) sent++; else failed++;
            } catch (e) { failed++; }
            await new Promise(r => setTimeout(r, 500));
          }

          // Mark as sent
          const updatedSchedules = schedules.map(s =>
            s.id === sched.id ? { ...s, status: 'sent', sentAt: new Date().toISOString(), sent, failed } : s
          );
          await supabase.from('settings').upsert({
            key: 'wa_schedules',
            value: updatedSchedules,
            updated_at: new Date().toISOString(),
          });
          console.log(`[SCHEDULER] Scheduled broadcast "${sched.name}" sent: ${sent} OK, ${failed} failed`);
        } catch (e) {
          console.error('[SCHEDULER] Broadcast execution failed:', sched.id, e.message);
        }
      }
    } catch (e) {
      console.error('[SCHEDULER] Schedule processor error:', e.message);
    }
  });

  console.log('Scheduler started — weekly report Mon 8 AM, daily reminders 9 AM / 1:30 PM / 7 PM IST, monitor agent 9 AM IST, low-stock 8 AM IST, birthday coupons 9 AM IST, health tips Sun 7 AM IST, win-back 10 AM IST, B2B payment reminder 9 AM IST, WA scheduled broadcasts every 5 min');
}

module.exports = { startScheduler, buildWeeklyReport, checkDailyTasks, sendReminders };
