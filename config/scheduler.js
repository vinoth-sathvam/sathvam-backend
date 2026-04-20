const cron       = require('node-cron');
const nodemailer = require('nodemailer');
const supabase   = require('./supabase');

const mailer = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// ── Shared helpers ─────────────────────────────────────────────────────────────

async function sendWhatsApp(phone, message) {
  const phoneId = process.env.WA_PHONE_NUMBER_ID;
  const token   = process.env.WA_ACCESS_TOKEN;
  if (!phoneId || !token) return;
  try {
    await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ messaging_product:'whatsapp', to: phone, type:'text', text:{ body: message } }),
    });
  } catch (e) { console.error('WhatsApp send failed:', e.message); }
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

  const [thisWeek, lastWeek, monthSales, stockData, products, lowStockRes, weekExp] = await Promise.all([
    supabase.from('sales').select('final_amount,channel,status').gte('date', d7).lte('date', today),
    supabase.from('sales').select('final_amount').gte('date', d14).lt('date', d7),
    supabase.from('sales').select('final_amount').gte('date', monthStart).lte('date', today),
    supabase.from('stock_ledger').select('product_id,type,qty'),
    supabase.from('products').select('id,name').eq('active', true),
    supabase.from('sales').select('order_no,customer_name,final_amount').eq('status', 'pending').limit(10),
    supabase.from('company_expenses').select('category,amount').gte('date', d7).lte('date', today).is('deleted_at', null),
  ]);

  const twRev     = (thisWeek.data||[]).reduce((s,r) => s+(r.final_amount||0), 0);
  const lwRev     = (lastWeek.data||[]).reduce((s,r) => s+(r.final_amount||0), 0);
  const monRev    = (monthSales.data||[]).reduce((s,r) => s+(r.final_amount||0), 0);
  const weekExpTotal = (weekExp.data||[]).reduce((s,r) => s+parseFloat(r.amount||0), 0);
  const revChange = lwRev > 0 ? Math.round(((twRev-lwRev)/lwRev)*100) : 0;

  const byChannel = {};
  for (const r of thisWeek.data||[]) byChannel[r.channel] = (byChannel[r.channel]||0) + (r.final_amount||0);

  const stock = {};
  for (const row of stockData.data||[]) {
    if (!stock[row.product_id]) stock[row.product_id] = 0;
    stock[row.product_id] += row.type==='in' ? (+row.qty||0) : -(+row.qty||0);
  }
  const lowStock = (products.data||[]).filter(p => (stock[p.id]||0) < 10).map(p => p.name);

  // Expense breakdown this week
  const byCat = {};
  for (const r of weekExp.data||[]) byCat[r.category] = (byCat[r.category]||0) + parseFloat(r.amount||0);
  const expCatRows = Object.entries(byCat).sort((a,b)=>b[1]-a[1])
    .map(([cat,amt]) => `<tr><td style="padding:5px 10px">${cat}</td><td style="padding:5px 10px;text-align:right;font-weight:600">₹${Math.round(amt).toLocaleString('en-IN')}</td></tr>`).join('');

  const channelRows = Object.entries(byChannel)
    .map(([ch,rev]) => `<tr><td style="padding:6px 12px">${ch}</td><td style="padding:6px 12px;text-align:right">₹${Math.round(rev).toLocaleString('en-IN')}</td><td style="padding:6px 12px;text-align:center">${(thisWeek.data||[]).filter(r=>r.channel===ch).length}</td></tr>`).join('');

  const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
  <div style="background:#1a5c2a;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0">
    <h2 style="margin:0">Sathvam Weekly Report</h2>
    <p style="margin:4px 0 0;opacity:.8;font-size:13px">${d7} to ${today}</p>
  </div>
  <div style="border:1px solid #ddd;border-top:none;padding:20px 24px;border-radius:0 0 8px 8px">
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px">
      <div style="flex:1;min-width:120px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px">
        <div style="font-size:12px;color:#6b7280">This Week Revenue</div>
        <div style="font-size:22px;font-weight:700;color:#1a5c2a">₹${Math.round(twRev).toLocaleString('en-IN')}</div>
        <div style="font-size:12px;color:${revChange>=0?'#16a34a':'#dc2626'}">${revChange>=0?'▲':'▼'} ${Math.abs(revChange)}% vs last week</div>
      </div>
      <div style="flex:1;min-width:120px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px">
        <div style="font-size:12px;color:#6b7280">This Week Expenses</div>
        <div style="font-size:22px;font-weight:700;color:#dc2626">₹${Math.round(weekExpTotal).toLocaleString('en-IN')}</div>
      </div>
      <div style="flex:1;min-width:120px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px">
        <div style="font-size:12px;color:#6b7280">Month Revenue</div>
        <div style="font-size:22px;font-weight:700;color:#1a5c2a">₹${Math.round(monRev).toLocaleString('en-IN')}</div>
      </div>
    </div>

    <h3 style="margin:0 0 8px;font-size:14px;color:#374151">Sales by Channel</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px">
      <thead><tr style="background:#f9fafb"><th style="padding:6px 12px;text-align:left">Channel</th><th style="padding:6px 12px;text-align:right">Revenue</th><th style="padding:6px 12px;text-align:center">Orders</th></tr></thead>
      <tbody>${channelRows}</tbody>
    </table>

    ${expCatRows ? `
    <h3 style="margin:0 0 8px;font-size:14px;color:#374151">Expenses This Week</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px">
      <tbody>${expCatRows}</tbody>
      <tfoot><tr style="background:#fef2f2"><td style="padding:6px 10px;font-weight:700">Total</td><td style="padding:6px 10px;text-align:right;font-weight:700;color:#dc2626">₹${Math.round(weekExpTotal).toLocaleString('en-IN')}</td></tr></tfoot>
    </table>` : ''}

    ${lowStock.length > 0 ? `
    <div style="background:#fff1f2;border:1px solid #fecdd3;border-radius:8px;padding:12px;margin-bottom:16px">
      <strong style="color:#dc2626">Low Stock (${lowStock.length} products)</strong>
      <p style="margin:6px 0 0;font-size:13px;color:#7f1d1d">${lowStock.slice(0,10).join(', ')}${lowStock.length>10?` and ${lowStock.length-10} more`:''}</p>
    </div>` : ''}

    ${(lowStockRes.data||[]).length > 0 ? `
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px">
      <strong style="color:#92400e">Pending Orders (${(lowStockRes.data||[]).length})</strong>
      <ul style="margin:6px 0 0;padding-left:16px;font-size:13px;color:#78350f">
        ${(lowStockRes.data||[]).map(o=>`<li>${o.order_no} — ${o.customer_name} — ₹${(o.final_amount||0).toLocaleString('en-IN')}</li>`).join('')}
      </ul>
    </div>` : ''}

    <p style="margin:20px 0 0;font-size:12px;color:#9ca3af;text-align:center">Sathvam Natural Products · Karur, Tamil Nadu · Auto-generated weekly report</p>
  </div>
</div>`;
  return html;
}

// ── Scheduler ──────────────────────────────────────────────────────────────────

function startScheduler() {
  // ── Weekly report: Every Monday 8:00 AM IST (2:30 AM UTC) ─────────────────
  cron.schedule('30 2 * * 1', async () => {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;
    try {
      const html  = await buildWeeklyReport();
      const today = new Date().toISOString().slice(0, 10);
      // Send to all admins + configured address
      const { data: admins } = await supabase.from('users').select('email').eq('role','admin').eq('active',true);
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

  // ── Evening summary: 7:00 PM IST (1:30 PM UTC) — status + nudge ──────────
  cron.schedule('30 13 * * *', async () => {
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
  });

  // ── AI Monitor Agent: 9:00 AM IST (3:30 AM UTC) daily ────────────────────
  cron.schedule('30 3 * * *', async () => {
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
        const token   = process.env.BOTSAILOR_API_TOKEN;
        const phoneId = process.env.BOTSAILOR_PHONE_NUMBER_ID || process.env.WA_PHONE_NUMBER_ID;
        if (!token || !phoneId) return;
        try {
          await fetch('https://botsailor.com/api/v1/whatsapp/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ apiToken: token, phone_number_id: phoneId, phone_number: phone, message: msg }).toString(),
          });
        } catch(e) { console.error('Birthday WA failed:', e.message); }
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
            `❓ Help: +91 70921 77092`;

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

  console.log('Scheduler started — weekly report Mon 8 AM, daily reminders 9 AM / 1:30 PM / 7 PM IST, monitor agent 9 AM IST, low-stock 8 AM IST, birthday coupons 9 AM IST');
}

module.exports = { startScheduler, buildWeeklyReport, checkDailyTasks, sendReminders };
