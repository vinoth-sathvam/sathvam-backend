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

  // Cash in bank
  const { data: banks } = await supabase.from('bank_accounts').select('current_balance,name').eq('is_active', true);
  snap.bankCash = (banks || []).reduce((s, b) => s + (parseFloat(b.current_balance) || 0), 0);
  snap.bankAccounts = (banks || []).map(b => ({ name: b.name, balance: parseFloat(b.current_balance) || 0 }));

  // Petty cash
  const { data: pc } = await supabase.from('petty_cash_log').select('direction,amount');
  snap.pettyCash = (pc || []).reduce((s, r) =>
    s + (r.direction === 'in' ? parseFloat(r.amount) : -parseFloat(r.amount)), 0);

  snap.totalCash = snap.bankCash + snap.pettyCash;

  // This month revenue (money_ledger)
  const { data: thisRev } = await supabase.from('money_ledger')
    .select('amount').eq('direction','in').gte('txn_date', monthStart);
  snap.revenueThisMonth = (thisRev || []).reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);

  // Last month revenue
  const { data: lastRev } = await supabase.from('money_ledger')
    .select('amount').eq('direction','in').gte('txn_date', lastStart).lte('txn_date', lastEnd);
  snap.revenueLastMonth = (lastRev || []).reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  snap.revenueGrowth    = snap.revenueLastMonth > 0
    ? ((snap.revenueThisMonth - snap.revenueLastMonth) / snap.revenueLastMonth * 100).toFixed(1)
    : null;

  // This month expenses
  const { data: thisExp } = await supabase.from('money_ledger')
    .select('amount,subcategory').eq('direction','out').gte('txn_date', monthStart);
  snap.expensesThisMonth = (thisExp || []).reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  snap.netPnl = snap.revenueThisMonth - snap.expensesThisMonth;

  // Expense by category
  const expByCat = {};
  for (const r of (thisExp || [])) {
    const k = r.subcategory || 'other';
    expByCat[k] = (expByCat[k] || 0) + (parseFloat(r.amount) || 0);
  }
  snap.expenseByCategory = Object.entries(expByCat)
    .sort((a,b) => b[1]-a[1]).slice(0, 5)
    .map(([cat, amt]) => ({ cat, amt }));

  // Overdue receivables — B2B orders not yet paid (stage not delivered/payment_received)
  const openStages = ['shipped','sailing','in_transit','arrived_at_port','customs_clearance','invoice_sent','overdue'];
  const { data: b2bOv } = await supabase.from('b2b_orders')
    .select('order_no,customer_name,total_value,created_at,stage')
    .in('stage', openStages)
    .order('created_at', { ascending: true })
    .limit(8);
  snap.overdueAR = (b2bOv || []).map(r => {
    const age = Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000);
    return { party: r.customer_name, amount: parseFloat(r.total_value) || 0, daysOld: age, ref: r.order_no };
  });
  snap.totalAR = snap.overdueAR.reduce((s, r) => s + r.amount, 0);

  // Upcoming payables — vendor bills due in next 30 days
  const { data: bills } = await supabase.from('vendor_bills')
    .select('vendor_name,amount,due_date,bill_no')
    .eq('status', 'unpaid')
    .gte('due_date', today)
    .lte('due_date', next30)
    .order('due_date', { ascending: true })
    .limit(8);
  snap.upcomingAP = (bills || []).map(b => ({
    party:  b.vendor_name, amount: parseFloat(b.amount) || 0,
    dueDate: b.due_date, ref: b.bill_no,
  }));
  snap.totalAP = snap.upcomingAP.reduce((s, r) => s + r.amount, 0);

  // 30-day cash flow forecast
  const { data: inflow30 } = await supabase.from('money_ledger')
    .select('amount').eq('direction','in').gte('txn_date', today).lte('txn_date', next30);
  const confirmedIn = (inflow30 || []).reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const avgMonthlyExp = snap.expensesThisMonth; // use this month as proxy
  snap.forecast = {
    startCash:      snap.totalCash,
    confirmedIn,
    estimatedOut:   avgMonthlyExp + snap.totalAP,
    projectedEnd:   snap.totalCash + confirmedIn - (avgMonthlyExp + snap.totalAP),
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
- Revenue: ₹${snap.revenueThisMonth.toLocaleString('en-IN')} (${snap.revenueGrowth !== null ? (snap.revenueGrowth > 0 ? '+' : '') + snap.revenueGrowth + '% vs last month' : 'no prior data'})
- Expenses: ₹${snap.expensesThisMonth.toLocaleString('en-IN')}
- Net P&L: ₹${snap.netPnl.toLocaleString('en-IN')} (${snap.netPnl >= 0 ? 'PROFIT' : 'LOSS'})

TOP EXPENSE CATEGORIES
${snap.expenseByCategory.map(e => `- ${e.cat}: ₹${e.amt.toLocaleString('en-IN')}`).join('\n') || '- No data'}

OVERDUE RECEIVABLES (₹${snap.totalAR.toLocaleString('en-IN')} total)
${snap.overdueAR.slice(0,5).map(r => `- ${r.party}: ₹${r.amount.toLocaleString('en-IN')} (${r.daysOld} days old)`).join('\n') || '- None outstanding'}

PAYABLES DUE NEXT 30 DAYS (₹${snap.totalAP.toLocaleString('en-IN')} total)
${snap.upcomingAP.slice(0,5).map(p => `- ${p.party}: ₹${p.amount.toLocaleString('en-IN')} by ${p.dueDate}`).join('\n') || '- None due'}

30-DAY CASH FORECAST
- Starting cash: ₹${snap.forecast.startCash.toLocaleString('en-IN')}
- Estimated outflows: ₹${snap.forecast.estimatedOut.toLocaleString('en-IN')}
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
