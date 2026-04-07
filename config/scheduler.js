const cron     = require('node-cron');
const nodemailer = require('nodemailer');
const supabase  = require('./supabase');

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function buildWeeklyReport() {
  const today     = new Date().toISOString().slice(0, 10);
  const d7        = new Date(Date.now() - 7  * 24*60*60*1000).toISOString().slice(0, 10);
  const d14       = new Date(Date.now() - 14 * 24*60*60*1000).toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01';

  const [thisWeek, lastWeek, monthSales, stockData, products, lowStockRes] = await Promise.all([
    supabase.from('sales').select('final_amount,channel,status').gte('date', d7).lte('date', today),
    supabase.from('sales').select('final_amount').gte('date', d14).lt('date', d7),
    supabase.from('sales').select('final_amount').gte('date', monthStart).lte('date', today),
    supabase.from('stock_ledger').select('product_id,type,qty'),
    supabase.from('products').select('id,name').eq('active', true),
    supabase.from('sales').select('order_no,customer_name,final_amount').eq('status', 'pending').limit(10),
  ]);

  const twRev   = (thisWeek.data||[]).reduce((s,r) => s+(r.final_amount||0), 0);
  const lwRev   = (lastWeek.data||[]).reduce((s,r) => s+(r.final_amount||0), 0);
  const monRev  = (monthSales.data||[]).reduce((s,r) => s+(r.final_amount||0), 0);
  const revChange = lwRev > 0 ? Math.round(((twRev-lwRev)/lwRev)*100) : 0;

  // Channel breakdown
  const byChannel = {};
  for (const r of thisWeek.data||[]) byChannel[r.channel] = (byChannel[r.channel]||0) + (r.final_amount||0);

  // Low stock
  const stock = {};
  for (const row of stockData.data||[]) {
    if (!stock[row.product_id]) stock[row.product_id] = 0;
    stock[row.product_id] += row.type==='in' ? (+row.qty||0) : -(+row.qty||0);
  }
  const lowStock = (products.data||[]).filter(p => (stock[p.id]||0) < 10).map(p => p.name);

  // By status
  const byStatus = {};
  for (const r of thisWeek.data||[]) byStatus[r.status] = (byStatus[r.status]||0)+1;

  const channelRows = Object.entries(byChannel).map(([ch,rev]) => `<tr><td style="padding:6px 12px">${ch}</td><td style="padding:6px 12px;text-align:right">₹${Math.round(rev).toLocaleString('en-IN')}</td><td style="padding:6px 12px;text-align:center">${(thisWeek.data||[]).filter(r=>r.channel===ch).length}</td></tr>`).join('');

  const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
  <div style="background:#1a5c2a;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0">
    <h2 style="margin:0">📊 Sathvam Weekly Report</h2>
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
        <div style="font-size:12px;color:#6b7280">This Week Orders</div>
        <div style="font-size:22px;font-weight:700;color:#1a5c2a">${(thisWeek.data||[]).length}</div>
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

    ${lowStock.length > 0 ? `
    <div style="background:#fff1f2;border:1px solid #fecdd3;border-radius:8px;padding:12px;margin-bottom:16px">
      <strong style="color:#dc2626">⚠️ Low Stock (${lowStock.length} products)</strong>
      <p style="margin:6px 0 0;font-size:13px;color:#7f1d1d">${lowStock.slice(0,10).join(', ')}${lowStock.length>10?` and ${lowStock.length-10} more`:''}</p>
    </div>` : ''}

    ${(lowStockRes.data||[]).length > 0 ? `
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px">
      <strong style="color:#92400e">🕐 Pending Orders (${(lowStockRes.data||[]).length})</strong>
      <ul style="margin:6px 0 0;padding-left:16px;font-size:13px;color:#78350f">
        ${(lowStockRes.data||[]).map(o=>`<li>${o.order_no} — ${o.customer_name} — ₹${(o.final_amount||0).toLocaleString('en-IN')}</li>`).join('')}
      </ul>
    </div>` : ''}

    <p style="margin:20px 0 0;font-size:12px;color:#9ca3af;text-align:center">Sathvam Natural Products · Karur, Tamil Nadu · Auto-generated weekly report</p>
  </div>
</div>`;
  return html;
}

function startScheduler() {
  // Every Monday at 8:00 AM IST (2:30 AM UTC)
  cron.schedule('30 2 * * 1', async () => {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;
    try {
      const html    = await buildWeeklyReport();
      const today   = new Date().toISOString().slice(0, 10);
      await mailer.sendMail({
        from:    process.env.SMTP_FROM || 'Sathvam <noreply@sathvam.in>',
        to:      'vinoth@sathvam.in',
        subject: `Sathvam Weekly Report — ${today}`,
        html,
      });
      console.log('Weekly report sent to vinoth@sathvam.in');
    } catch (e) {
      console.error('Weekly report failed:', e.message);
    }
  });

  console.log('Scheduler started — weekly report every Monday 8 AM IST');
}

module.exports = { startScheduler, buildWeeklyReport };
