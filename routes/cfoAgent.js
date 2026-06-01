/**
 * routes/cfoAgent.js
 * Chief Financial Officer AI Agent.
 * Runs daily at 8 AM IST — pulls financial snapshot, asks Claude for analysis,
 * emails a concise CFO briefing. No approval gates. Pure intelligence.
 */
const express    = require('express');
const router     = express.Router();
const supabase   = require('../config/supabase');
const Anthropic  = require('@anthropic-ai/sdk');
const { auth, requireRole } = require('../middleware/auth');
const { sendEmail, emailHtml } = require('../utils/email');

const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const ALLOWED = requireRole('admin','ceo','manager','accountant');

// ─── DATA SNAPSHOT ────────────────────────────────────────────────────────────

async function buildSnapshot() {
  const today      = new Date().toISOString().slice(0, 10);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const lastStart  = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).toISOString().slice(0, 10);
  const lastEnd    = new Date(new Date().getFullYear(), new Date().getMonth(), 0).toISOString().slice(0, 10);
  const next30     = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const snap       = {};

  // ── Cash position ─────────────────────────────────────────────────────────
  const { data: banks } = await supabase.from('bank_accounts').select('current_balance,name').eq('is_active', true);
  snap.bankCash     = (banks || []).reduce((s, b) => s + (parseFloat(b.current_balance) || 0), 0);
  snap.bankAccounts = (banks || []).map(b => ({ name: b.name, balance: parseFloat(b.current_balance) || 0 }));

  const { data: pc } = await supabase.from('petty_cash_log').select('direction,amount');
  snap.pettyCash = (pc || []).reduce((s, r) =>
    s + (r.direction === 'in' ? parseFloat(r.amount) : -parseFloat(r.amount)), 0);
  snap.totalCash = snap.bankCash + snap.pettyCash;

  // ── Revenue — query source tables directly ────────────────────────────────
  const { data: posSales } = await supabase.from('sales')
    .select('final_amount').in('status', ['delivered','dispatched']).gte('date', monthStart);
  const posRevThisMonth = (posSales || []).reduce((s, r) => s + (parseFloat(r.final_amount) || 0), 0);

  const { data: posSalesLast } = await supabase.from('sales')
    .select('final_amount').in('status', ['delivered','dispatched']).gte('date', lastStart).lte('date', lastEnd);
  const posRevLastMonth = (posSalesLast || []).reduce((s, r) => s + (parseFloat(r.final_amount) || 0), 0);

  const { data: wsOrders } = await supabase.from('webstore_orders')
    .select('total').eq('payment_status', 'paid').gte('date', monthStart);
  const wsRevThisMonth = (wsOrders || []).reduce((s, r) => s + (parseFloat(r.total) || 0), 0);

  const { data: wsOrdersLast } = await supabase.from('webstore_orders')
    .select('total').eq('payment_status', 'paid').gte('date', lastStart).lte('date', lastEnd);
  const wsRevLastMonth = (wsOrdersLast || []).reduce((s, r) => s + (parseFloat(r.total) || 0), 0);

  const b2bPaidStages = ['delivered','payment_received','invoice_sent'];
  const { data: b2bPaid } = await supabase.from('b2b_orders')
    .select('total_value').in('stage', b2bPaidStages).gte('created_at', monthStart + 'T00:00:00');
  const b2bRevThisMonth = (b2bPaid || []).reduce((s, r) => s + (parseFloat(r.total_value) || 0), 0);

  const { data: b2bPaidLast } = await supabase.from('b2b_orders')
    .select('total_value').in('stage', b2bPaidStages)
    .gte('created_at', lastStart + 'T00:00:00').lte('created_at', lastEnd + 'T23:59:59');
  const b2bRevLastMonth = (b2bPaidLast || []).reduce((s, r) => s + (parseFloat(r.total_value) || 0), 0);

  snap.revenueThisMonth = posRevThisMonth + wsRevThisMonth + b2bRevThisMonth;
  snap.revenueLastMonth = posRevLastMonth + wsRevLastMonth + b2bRevLastMonth;
  snap.revenueBreakdown = [
    { channel: 'POS Sales',       amount: posRevThisMonth, count: (posSales || []).length },
    { channel: 'Webstore',        amount: wsRevThisMonth,  count: (wsOrders || []).length },
    { channel: 'B2B / Wholesale', amount: b2bRevThisMonth, count: (b2bPaid || []).length },
  ].filter(c => c.amount > 0);
  snap.revenueGrowth = snap.revenueLastMonth > 0
    ? ((snap.revenueThisMonth - snap.revenueLastMonth) / snap.revenueLastMonth * 100).toFixed(1)
    : null;

  // ── Expenses — query source tables directly ───────────────────────────────
  const { data: exps } = await supabase.from('company_expenses')
    .select('amount,category').is('deleted_at', null).gte('date', monthStart);
  snap.expensesThisMonth = (exps || []).reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);

  const expByCat = {};
  for (const r of (exps || [])) {
    const k = r.category || 'Other';
    expByCat[k] = (expByCat[k] || 0) + (parseFloat(r.amount) || 0);
  }
  snap.expenseByCategory = Object.entries(expByCat)
    .sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([cat, amt]) => ({ cat, amt }));

  const { data: sals } = await supabase.from('salary_payments')
    .select('amount').gte('payment_date', monthStart);
  snap.salaryThisMonth = (sals || []).reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);

  snap.totalExpensesThisMonth = snap.expensesThisMonth + snap.salaryThisMonth;
  snap.netPnl = snap.revenueThisMonth - snap.totalExpensesThisMonth;

  // ── AR: B2B open receivables ───────────────────────────────────────────────
  const openStages = ['shipped','sailing','in_transit','arrived_at_port','customs_clearance','invoice_sent','overdue'];
  const { data: b2bOv } = await supabase.from('b2b_orders')
    .select('order_no,customer_name,total_value,created_at,stage')
    .in('stage', openStages).order('created_at', { ascending: true }).limit(10);
  snap.overdueAR = (b2bOv || []).map(r => {
    const age = Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000);
    return { party: r.customer_name, amount: parseFloat(r.total_value) || 0, daysOld: age, ref: r.order_no };
  });
  snap.totalAR = snap.overdueAR.reduce((s, r) => s + r.amount, 0);

  // Pending webstore dispatches (paid, not yet shipped)
  const { data: wsPending } = await supabase.from('webstore_orders')
    .select('order_no,total,status').in('status', ['new','confirmed','packed']).eq('payment_status', 'paid').limit(10);
  snap.pendingDispatch = (wsPending || []).map(r => ({ ref: r.order_no, amount: parseFloat(r.total) || 0, status: r.status }));

  // ── AP: vendor bills due next 30 days ─────────────────────────────────────
  const { data: bills } = await supabase.from('vendor_bills')
    .select('vendor_name,amount,due_date,bill_no').eq('status', 'unpaid')
    .gte('due_date', today).lte('due_date', next30).order('due_date', { ascending: true }).limit(10);
  snap.upcomingAP = (bills || []).map(b => ({
    party: b.vendor_name, amount: parseFloat(b.amount) || 0, dueDate: b.due_date, ref: b.bill_no,
  }));
  snap.totalAP = snap.upcomingAP.reduce((s, r) => s + r.amount, 0);

  // Pending procurement orders (not yet paid to suppliers)
  const { data: pendProcs } = await supabase.from('procurements')
    .select('supplier,ordered_qty,ordered_price_per_kg,date')
    .eq('status', 'ordered').order('date', { ascending: false }).limit(10);
  snap.pendingProcPayments = (pendProcs || [])
    .map(p => ({
      party: p.supplier,
      amount: (parseFloat(p.ordered_qty) || 0) * (parseFloat(p.ordered_price_per_kg) || 0),
      date: p.date,
    })).filter(p => p.amount > 0);
  snap.totalPendingProcurement = snap.pendingProcPayments.reduce((s, r) => s + r.amount, 0);

  // ── Cash forecast (rest of month) ─────────────────────────────────────────
  const daysElapsed     = new Date(today).getDate();
  const daysInMonth     = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const daysLeft        = daysInMonth - daysElapsed;
  const dailyRevRate    = daysElapsed > 0 ? snap.revenueThisMonth / daysElapsed : 0;
  snap.forecast = {
    startCash:        snap.totalCash,
    projectedRevenue: Math.round(dailyRevRate * daysLeft),
    estimatedOut:     snap.totalAP + snap.totalPendingProcurement,
    projectedEnd:     snap.totalCash + Math.round(dailyRevRate * daysLeft) - snap.totalAP - snap.totalPendingProcurement,
  };
  snap.forecastStatus = snap.forecast.projectedEnd > 200000 ? 'healthy'
                      : snap.forecast.projectedEnd > 0      ? 'tight'
                      : 'shortage';

  snap.date      = today;
  snap.monthName = new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  return snap;
}

// ─── AI ANALYSIS ─────────────────────────────────────────────────────────────

async function generateCFOBriefing(snap) {
  const prompt = `You are the virtual Chief Financial Officer of Sathvam Natural Products Private Limited, a cold-pressed oil manufacturing company (Private Limited under Companies Act 2013).

Analyze this financial snapshot for ${snap.date} and provide a concise daily CFO briefing:

CASH POSITION
- Bank Cash: ₹${snap.bankCash.toLocaleString('en-IN')}
- Petty Cash: ₹${snap.pettyCash.toLocaleString('en-IN')}
- Total Cash: ₹${snap.totalCash.toLocaleString('en-IN')}

${snap.monthName.toUpperCase()} P&L
- Revenue: ₹${snap.revenueThisMonth.toLocaleString('en-IN')} (${snap.revenueGrowth !== null ? (snap.revenueGrowth > 0 ? '+' : '') + snap.revenueGrowth + '% vs last month' : 'first month of data'})
${(snap.revenueBreakdown||[]).map(c => `  · ${c.channel}: ₹${c.amount.toLocaleString('en-IN')} (${c.count} orders)`).join('\n')}
- Operating Expenses: ₹${snap.expensesThisMonth.toLocaleString('en-IN')}
- Salary/Payroll: ₹${(snap.salaryThisMonth||0).toLocaleString('en-IN')}
- Total Outflow: ₹${snap.totalExpensesThisMonth.toLocaleString('en-IN')}
- Net P&L: ₹${snap.netPnl.toLocaleString('en-IN')} (${snap.netPnl >= 0 ? 'PROFIT' : 'LOSS'})

TOP EXPENSE CATEGORIES
${snap.expenseByCategory.map(e => `- ${e.cat}: ₹${e.amt.toLocaleString('en-IN')}`).join('\n') || '- No expenses recorded this month'}

PENDING PROCUREMENT PAYMENTS (suppliers not yet paid)
${(snap.pendingProcPayments||[]).slice(0,5).map(p => `- ${p.party}: ₹${p.amount.toLocaleString('en-IN')}`).join('\n') || '- None'}
Total pending: ₹${(snap.totalPendingProcurement||0).toLocaleString('en-IN')}

OVERDUE RECEIVABLES / B2B (₹${snap.totalAR.toLocaleString('en-IN')} total)
${snap.overdueAR.slice(0,5).map(r => `- ${r.party}: ₹${r.amount.toLocaleString('en-IN')} (${r.daysOld} days old)`).join('\n') || '- None outstanding'}

PAYABLES DUE NEXT 30 DAYS (₹${snap.totalAP.toLocaleString('en-IN')} total)
${snap.upcomingAP.slice(0,5).map(p => `- ${p.party}: ₹${p.amount.toLocaleString('en-IN')} by ${p.dueDate}`).join('\n') || '- None due'}

REST-OF-MONTH CASH FORECAST
- Starting cash: ₹${snap.forecast.startCash.toLocaleString('en-IN')}
- Projected revenue (rest of month at current run rate): ₹${(snap.forecast.projectedRevenue||0).toLocaleString('en-IN')}
- Estimated outflows (bills + pending procurement): ₹${snap.forecast.estimatedOut.toLocaleString('en-IN')}
- Projected end balance: ₹${snap.forecast.projectedEnd.toLocaleString('en-IN')}
- Status: ${snap.forecastStatus.toUpperCase()}

Provide a structured CFO briefing with:
1. ONE executive summary paragraph (2-3 sentences, frank assessment)
2. TOP 3 ACTION ITEMS for today (specific, actionable, numbered)
3. CASH FLOW RISK (one sentence verdict)
4. ONE strategic observation (pattern, trend, or concern worth noting)

Keep it direct, factual and brief. No fluff. Format as clean HTML paragraphs with <strong> for key numbers.`;

  const resp = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages:   [{ role: 'user', content: prompt }],
  });

  return resp.content[0]?.text || 'Unable to generate briefing.';
}

// ─── RUN CFO ─────────────────────────────────────────────────────────────────

async function runCFO() {
  const today = new Date().toISOString().slice(0, 10);

  // Check if already ran today
  const { data: existing } = await supabase.from('cfo_briefings').select('id').eq('run_date', today).single();
  if (existing) return { ok: true, skipped: true, reason: 'Already ran today' };

  const snap     = await buildSnapshot();
  const analysis = await generateCFOBriefing(snap);

  // Save to DB
  await supabase.from('cfo_briefings').upsert({
    run_date:   today,
    briefing:   analysis,
    data:       snap,
    email_sent: true,
    created_at: new Date().toISOString(),
  }, { onConflict: 'run_date' });

  // Send email
  await sendCFOEmail(snap, analysis);

  return { ok: true, snap, analysis };
}

async function sendCFOEmail(snap, analysis) {
  const fmt = n => `₹${(parseFloat(n) || 0).toLocaleString('en-IN')}`;
  const pnlColor = snap.netPnl >= 0 ? '#16a34a' : '#dc2626';
  const fColor   = snap.forecastStatus === 'healthy' ? '#16a34a'
                 : snap.forecastStatus === 'tight'   ? '#d97706' : '#dc2626';

  const kpis = `
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
      <tr>
        <td style="padding:12px;background:linear-gradient(135deg,#0a1f10,#0f2820);border-radius:8px;text-align:center;color:#fff;width:25%">
          <div style="font-size:11px;color:rgba(255,255,255,0.6)">TOTAL CASH</div>
          <div style="font-size:18px;font-weight:700;margin-top:4px">${fmt(snap.totalCash)}</div>
        </td>
        <td style="width:2%"></td>
        <td style="padding:12px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;text-align:center;width:25%">
          <div style="font-size:11px;color:#64748b">REVENUE MTD</div>
          <div style="font-size:18px;font-weight:700;color:#16a34a;margin-top:4px">${fmt(snap.revenueThisMonth)}</div>
          ${snap.revenueGrowth !== null ? `<div style="font-size:11px;color:#64748b">${snap.revenueGrowth > 0 ? '↑' : '↓'} ${Math.abs(snap.revenueGrowth)}% vs last month</div>` : ''}
        </td>
        <td style="width:2%"></td>
        <td style="padding:12px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;text-align:center;width:25%">
          <div style="font-size:11px;color:#64748b">EXPENSES MTD</div>
          <div style="font-size:18px;font-weight:700;color:#dc2626;margin-top:4px">${fmt(snap.expensesThisMonth)}</div>
        </td>
        <td style="width:2%"></td>
        <td style="padding:12px;border:1px solid #e2e8f0;border-radius:8px;text-align:center;width:25%">
          <div style="font-size:11px;color:#64748b">NET P&L</div>
          <div style="font-size:18px;font-weight:700;color:${pnlColor};margin-top:4px">${fmt(snap.netPnl)}</div>
        </td>
      </tr>
    </table>`;

  const arTable = snap.overdueAR.length > 0 ? `
    <div class="section">
      <h3>Overdue Receivables — Collect These First</h3>
      <table>
        <tr><th>Customer</th><th>Amount</th><th>Age</th></tr>
        ${snap.overdueAR.map(r => `<tr><td>${r.party}</td><td>₹${r.amount.toLocaleString('en-IN')}</td><td>${r.daysOld} days</td></tr>`).join('')}
        <tr style="font-weight:700"><td>TOTAL</td><td colspan="2">₹${snap.totalAR.toLocaleString('en-IN')}</td></tr>
      </table>
    </div>` : '';

  const apTable = snap.upcomingAP.length > 0 ? `
    <div class="section">
      <h3>Payables Due Next 30 Days</h3>
      <table>
        <tr><th>Vendor</th><th>Amount</th><th>Due Date</th></tr>
        ${snap.upcomingAP.map(p => `<tr><td>${p.party}</td><td>₹${p.amount.toLocaleString('en-IN')}</td><td>${p.dueDate}</td></tr>`).join('')}
        <tr style="font-weight:700"><td>TOTAL</td><td colspan="2">₹${snap.totalAP.toLocaleString('en-IN')}</td></tr>
      </table>
    </div>` : '';

  const forecast = `
    <div class="section">
      <h3>30-Day Cash Forecast</h3>
      <table>
        <tr><td>Starting Cash</td><td>${fmt(snap.forecast.startCash)}</td></tr>
        <tr><td>Estimated Outflows</td><td style="color:#dc2626">−${fmt(snap.forecast.estimatedOut)}</td></tr>
        <tr style="font-weight:700"><td>Projected End Balance</td><td style="color:${fColor}">${fmt(snap.forecast.projectedEnd)}</td></tr>
        <tr><td>Forecast Status</td><td><span class="badge ${snap.forecastStatus === 'healthy' ? 'low' : snap.forecastStatus === 'tight' ? 'medium' : 'critical'}">${snap.forecastStatus.toUpperCase()}</span></td></tr>
      </table>
    </div>`;

  const aiSection = `
    <div class="section">
      <h3>CFO Analysis & Recommendations</h3>
      <div style="background:#f8fafc;border-left:3px solid #0a1f10;padding:16px;border-radius:0 8px 8px 0;font-size:13px;line-height:1.7">
        ${analysis}
      </div>
    </div>`;

  const body = kpis + arTable + apTable + forecast + aiSection;

  await sendEmail(
    `📊 CFO Daily Briefing — ${new Date().toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long' })}`,
    emailHtml('CFO Daily Briefing', body)
  );
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

/** GET /api/cfo/briefing  — latest briefing */
router.get('/briefing', auth, ALLOWED, async (req, res) => {
  const { data, error } = await supabase
    .from('cfo_briefings')
    .select('*')
    .order('run_date', { ascending: false })
    .limit(1)
    .single();
  if (error && error.code !== 'PGRST116') return res.status(400).json({ error: error.message });
  res.json(data || null);
});

/** GET /api/cfo/briefings  — history list */
router.get('/briefings', auth, ALLOWED, async (req, res) => {
  const { data, error } = await supabase
    .from('cfo_briefings')
    .select('id,run_date,email_sent,created_at')
    .order('run_date', { ascending: false })
    .limit(30);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

/** GET /api/cfo/snapshot  — live financial snapshot (no AI) */
router.get('/snapshot', auth, ALLOWED, async (req, res) => {
  try {
    const snap = await buildSnapshot();
    res.json(snap);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/cfo/run  — trigger CFO manually (forces re-run even if ran today) */
router.post('/run', auth, requireRole('admin','ceo'), async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    // Delete today's existing briefing to allow re-run
    await supabase.from('cfo_briefings').delete().eq('run_date', today);
    const result = await runCFO();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.runCFO = runCFO;
