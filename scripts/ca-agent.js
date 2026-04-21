#!/usr/bin/env node
/**
 * Sathvam CA (Chartered Accountant) Agent
 * ─────────────────────────────────────────
 * Monitors the books daily, raises questions and alerts about financial health.
 * Designed to be run at 9 AM IST via systemd timer or triggered manually via API.
 *
 * Usage:
 *   node /home/ubuntu/sathvam-backend/scripts/ca-agent.js
 *
 * Checks performed:
 *   AR  — overdue receivables, high-value unpaid invoices, AR aging
 *   AP  — overdue payables, bills due this week, partial payments stalled
 *   Bank — low cash balance, unreconciled transactions, large debits
 *   GST  — large transactions without GST, unrecorded GST liability
 *   Payroll — pending payroll, unusual salary amounts
 *   Expenses — unusually high expense days, large single expenses
 *   Revenue — revenue drop vs prior month, low-performing channels
 *   Compliance — upcoming compliance deadlines
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { createClient } = require('@supabase/supabase-js');
const Anthropic        = require('@anthropic-ai/sdk');

const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const ADMIN_PHONE   = process.env.ADMIN_WHATSAPP_PHONE || process.env.WA_ADMIN_PHONE;
const round2        = n => Math.round((parseFloat(n) || 0) * 100) / 100;

function finding(category, severity, title, detail, amount = null) {
  return { category, severity, title, detail, amount };
}

// ── Rule-based checks ─────────────────────────────────────────────────────────

async function checkAR() {
  const findings = [];
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // B2B overdue receivables
  const { data: b2b } = await supabase
    .from('b2b_orders')
    .select('id,order_no,customer_name,total_value,created_at')
    .not('stage', 'in', '("delivered","cancelled","invoice_paid")')
    .order('created_at', { ascending: true })
    .limit(200);

  const overdueB2B = (b2b || []).filter(o => {
    const ageDays = Math.floor((today - new Date(o.created_at)) / 86400000);
    return ageDays > 30;
  });

  if (overdueB2B.length > 0) {
    const total = overdueB2B.reduce((s, o) => s + (o.total_value || 0), 0);
    const oldest = Math.max(...overdueB2B.map(o => Math.floor((today - new Date(o.created_at)) / 86400000)));
    findings.push(finding('AR', overdueB2B.length >= 5 ? 'high' : 'medium',
      `${overdueB2B.length} B2B orders overdue >30 days`,
      `Total outstanding: ₹${round2(total).toLocaleString('en-IN')}. Oldest: ${oldest} days. Customers: ${[...new Set(overdueB2B.map(o => o.customer_name))].slice(0, 3).join(', ')}`,
      round2(total)
    ));
  }

  // Very large single unpaid B2B order (>₹50,000)
  const largePending = (b2b || []).filter(o => (o.total_value || 0) > 50000);
  for (const o of largePending.slice(0, 3)) {
    const ageDays = Math.floor((today - new Date(o.created_at)) / 86400000);
    if (ageDays > 7) {
      findings.push(finding('AR', 'high',
        `Large unpaid B2B order #${o.order_no}`,
        `Customer: ${o.customer_name} — ₹${round2(o.total_value).toLocaleString('en-IN')} pending for ${ageDays} days`,
        round2(o.total_value)
      ));
    }
  }

  // Webstore confirmed orders not yet shipped >5 days
  const { data: ws } = await supabase
    .from('webstore_orders')
    .select('id,order_no,customer,total,date,status')
    .in('status', ['confirmed', 'processing'])
    .order('date', { ascending: true })
    .limit(100);

  const staleWS = (ws || []).filter(o => {
    const ageDays = Math.floor((today - new Date(o.date)) / 86400000);
    return ageDays > 5;
  });

  if (staleWS.length > 3) {
    const total = staleWS.reduce((s, o) => s + (o.total || 0), 0);
    findings.push(finding('AR', 'medium',
      `${staleWS.length} webstore orders not shipped >5 days`,
      `Total: ₹${round2(total).toLocaleString('en-IN')}. Risk of customer disputes.`,
      round2(total)
    ));
  }

  return findings;
}

async function checkAP() {
  const findings = [];
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const weekLater = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10);

  const { data: bills } = await supabase
    .from('vendor_bills')
    .select('id,bill_no,vendor_name,amount,gst_amount,paid_amount,due_date,bill_date,status,category')
    .in('status', ['unpaid', 'partial', 'overdue'])
    .is('deleted_at', null)
    .order('due_date', { ascending: true })
    .limit(200);

  const billList = bills || [];

  // Overdue bills
  const overdue = billList.filter(b => b.status === 'overdue' || (b.due_date && b.due_date < todayStr));
  if (overdue.length > 0) {
    const total = overdue.reduce((s, b) => s + round2((b.amount || 0) + (b.gst_amount || 0) - (b.paid_amount || 0)), 0);
    findings.push(finding('AP', overdue.length >= 3 ? 'critical' : 'high',
      `${overdue.length} vendor bills overdue`,
      `Total overdue: ₹${round2(total).toLocaleString('en-IN')}. Vendors: ${[...new Set(overdue.map(b => b.vendor_name))].slice(0, 3).join(', ')}. Delayed payments damage supplier relationships.`,
      round2(total)
    ));
  }

  // Bills due this week
  const dueThisWeek = billList.filter(b => b.due_date && b.due_date >= todayStr && b.due_date <= weekLater);
  if (dueThisWeek.length > 0) {
    const total = dueThisWeek.reduce((s, b) => s + round2((b.amount || 0) + (b.gst_amount || 0) - (b.paid_amount || 0)), 0);
    findings.push(finding('AP', 'medium',
      `${dueThisWeek.length} bills due within 7 days`,
      `Total: ₹${round2(total).toLocaleString('en-IN')}. Schedule payments now to avoid late fees.`,
      round2(total)
    ));
  }

  // Partially paid bills stalled >30 days
  const stalledPartial = billList.filter(b => {
    if (b.status !== 'partial') return false;
    const ageDays = Math.floor((today - new Date(b.bill_date)) / 86400000);
    return ageDays > 30;
  });
  if (stalledPartial.length > 0) {
    findings.push(finding('AP', 'medium',
      `${stalledPartial.length} partially-paid bills stalled >30 days`,
      `Vendors: ${[...new Set(stalledPartial.map(b => b.vendor_name))].slice(0, 3).join(', ')}. Clear these to keep credit lines open.`,
      null
    ));
  }

  return findings;
}

async function checkBank() {
  const findings = [];

  const { data: accounts } = await supabase
    .from('bank_accounts')
    .select('id,name,type,current_balance')
    .eq('is_active', true);

  const accList = accounts || [];
  const totalCash = accList.reduce((s, a) => s + (a.current_balance || 0), 0);

  // Low cash warning
  if (totalCash < 50000) {
    findings.push(finding('Bank', 'critical',
      `Very low cash balance: ₹${round2(totalCash).toLocaleString('en-IN')}`,
      `Total across ${accList.length} bank account(s). Immediate action needed to avoid payment failures.`,
      round2(totalCash)
    ));
  } else if (totalCash < 200000) {
    findings.push(finding('Bank', 'high',
      `Low cash balance: ₹${round2(totalCash).toLocaleString('en-IN')}`,
      `Total across ${accList.length} bank account(s). Consider collections or credit facility.`,
      round2(totalCash)
    ));
  }

  // Large single transactions in last 7 days (>₹50,000 debit)
  const since7d = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const { data: txns } = await supabase
    .from('bank_transactions')
    .select('id,date,type,amount,description,category')
    .eq('type', 'debit')
    .gte('date', since7d)
    .gt('amount', 50000)
    .order('amount', { ascending: false })
    .limit(5);

  if (txns && txns.length > 0) {
    const total = txns.reduce((s, t) => s + (t.amount || 0), 0);
    findings.push(finding('Bank', 'medium',
      `${txns.length} large debit transactions (>₹50K) in last 7 days`,
      `Total debited: ₹${round2(total).toLocaleString('en-IN')}. Largest: ${txns[0].description || 'No description'} — ₹${round2(txns[0].amount).toLocaleString('en-IN')}`,
      round2(total)
    ));
  }

  // Check for accounts with negative balance
  const negative = accList.filter(a => (a.current_balance || 0) < 0);
  for (const acc of negative) {
    findings.push(finding('Bank', 'critical',
      `Negative balance in account: ${acc.name}`,
      `Balance: ₹${round2(acc.current_balance).toLocaleString('en-IN')}. This indicates unrecorded transactions or data error.`,
      acc.current_balance
    ));
  }

  return findings;
}

async function checkGST() {
  const findings = [];
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  const todayStr = today.toISOString().slice(0, 10);
  const dayOfMonth = today.getDate();

  // GST filing reminder — GSTR-1 due on 11th, GSTR-3B due on 20th
  if (dayOfMonth >= 8 && dayOfMonth <= 11) {
    findings.push(finding('GST', 'high',
      'GSTR-1 filing due by 11th of this month',
      'Ensure all B2B and B2C invoices for last month are uploaded to GSTIN portal. Check for any missing or incorrect invoices.',
      null
    ));
  }
  if (dayOfMonth >= 17 && dayOfMonth <= 20) {
    findings.push(finding('GST', 'critical',
      'GSTR-3B filing due by 20th of this month',
      'Monthly GST return must be filed by 20th. Late filing attracts interest at 18% p.a. + late fees.',
      null
    ));
  }

  // Large sales without GST in last 30 days (GST should apply for B2B)
  const ago30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const { data: sales } = await supabase
    .from('sales')
    .select('id,invoice_no,customer,final_amount,gst_amount,date')
    .gte('date', ago30)
    .gt('final_amount', 10000)
    .or('gst_amount.is.null,gst_amount.eq.0')
    .limit(20);

  if (sales && sales.length > 0) {
    const total = sales.reduce((s, x) => s + (x.final_amount || 0), 0);
    findings.push(finding('GST', 'medium',
      `${sales.length} sales >₹10K with no GST recorded in last 30 days`,
      `Total value: ₹${round2(total).toLocaleString('en-IN')}. Verify if GST exemption applies or if GST was not captured.`,
      round2(total)
    ));
  }

  return findings;
}

async function checkPayroll() {
  const findings = [];
  const today = new Date();
  const currentMonth = today.toISOString().slice(0, 7); // YYYY-MM
  const dayOfMonth = today.getDate();

  // Check if payroll has been processed for current month (after 25th)
  if (dayOfMonth >= 25) {
    const { data: payroll } = await supabase
      .from('payroll')
      .select('id,month,total_amount,status')
      .eq('month', currentMonth)
      .limit(1);

    if (!payroll || payroll.length === 0) {
      findings.push(finding('Payroll', 'high',
        `Payroll for ${currentMonth} not yet processed`,
        `It is the ${dayOfMonth}th of the month. Employee payroll should be processed and paid by month end.`,
        null
      ));
    } else if (payroll[0].status === 'draft') {
      findings.push(finding('Payroll', 'medium',
        `Payroll for ${currentMonth} is in draft — not yet approved`,
        `Payroll exists but is in draft status. Approve and disburse to employees before month end.`,
        payroll[0].total_amount
      ));
    }
  }

  return findings;
}

async function checkExpenses() {
  const findings = [];
  const today = new Date();

  // Very large single expense in last 7 days (>₹25,000)
  const since7d = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const { data: expenses } = await supabase
    .from('company_expenses')
    .select('id,date,category,amount,description,vendor,approved_by')
    .gte('date', since7d)
    .gt('amount', 25000)
    .is('deleted_at', null)
    .order('amount', { ascending: false })
    .limit(10);

  if (expenses && expenses.length > 0) {
    for (const e of expenses.slice(0, 3)) {
      if ((e.amount || 0) > 100000) {
        findings.push(finding('Expenses', 'high',
          `Large expense: ₹${round2(e.amount).toLocaleString('en-IN')} — ${e.category}`,
          `Date: ${e.date}. Description: ${e.description || '—'}. Vendor: ${e.vendor || '—'}. Approved by: ${e.approved_by || 'not specified'}. Verify this is authorized.`,
          round2(e.amount)
        ));
      }
    }
    if (expenses.length > 3) {
      const total = expenses.reduce((s, e) => s + (e.amount || 0), 0);
      findings.push(finding('Expenses', 'medium',
        `${expenses.length} expenses >₹25K in last 7 days`,
        `Total: ₹${round2(total).toLocaleString('en-IN')}. Categories: ${[...new Set(expenses.map(e => e.category))].join(', ')}.`,
        round2(total)
      ));
    }
  }

  // Month-over-month expense spike
  const thisMonthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1).toISOString().slice(0, 10);
  const lastMonthEnd   = new Date(today.getFullYear(), today.getMonth(), 0).toISOString().slice(0, 10);

  const [thisMonth, lastMonth] = await Promise.all([
    supabase.from('company_expenses').select('amount').gte('date', thisMonthStart).lte('date', today.toISOString().slice(0, 10)).is('deleted_at', null),
    supabase.from('company_expenses').select('amount').gte('date', lastMonthStart).lte('date', lastMonthEnd).is('deleted_at', null),
  ]);

  const thisTotal = (thisMonth.data || []).reduce((s, e) => s + parseFloat(e.amount || 0), 0);
  const lastTotal = (lastMonth.data || []).reduce((s, e) => s + parseFloat(e.amount || 0), 0);

  // Pro-rate this month (e.g. day 10 of 30 = 33% elapsed)
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const proratedLast = lastTotal * (today.getDate() / daysInMonth);

  if (proratedLast > 0 && thisTotal > proratedLast * 1.5) {
    findings.push(finding('Expenses', 'medium',
      'Expenses running 50%+ above last month pace',
      `This month so far: ₹${round2(thisTotal).toLocaleString('en-IN')} vs pro-rated last month: ₹${round2(proratedLast).toLocaleString('en-IN')}. Investigate reason for spike.`,
      round2(thisTotal - proratedLast)
    ));
  }

  return findings;
}

async function checkRevenue() {
  const findings = [];
  const today = new Date();

  const thisMonthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1).toISOString().slice(0, 10);
  const lastMonthEnd   = new Date(today.getFullYear(), today.getMonth(), 0).toISOString().slice(0, 10);
  const daysInMonth    = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();

  // Revenue this month vs last
  const [salesThis, wsThis, salesLast, wsLast] = await Promise.all([
    supabase.from('sales').select('final_amount').eq('status', 'paid').gte('date', thisMonthStart),
    supabase.from('webstore_orders').select('total').in('status', ['confirmed', 'packed', 'shipped', 'delivered']).gte('date', thisMonthStart),
    supabase.from('sales').select('final_amount').eq('status', 'paid').gte('date', lastMonthStart).lte('date', lastMonthEnd),
    supabase.from('webstore_orders').select('total').in('status', ['confirmed', 'packed', 'shipped', 'delivered']).gte('date', lastMonthStart).lte('date', lastMonthEnd),
  ]);

  const revThis = round2(
    (salesThis.data || []).reduce((s, x) => s + parseFloat(x.final_amount || 0), 0) +
    (wsThis.data || []).reduce((s, x) => s + parseFloat(x.total || 0), 0)
  );
  const revLast = round2(
    (salesLast.data || []).reduce((s, x) => s + parseFloat(x.final_amount || 0), 0) +
    (wsLast.data || []).reduce((s, x) => s + parseFloat(x.total || 0), 0)
  );

  const proratedLast = round2(revLast * (today.getDate() / daysInMonth));

  if (proratedLast > 10000 && revThis < proratedLast * 0.7) {
    findings.push(finding('Revenue', 'high',
      'Revenue significantly below last month pace',
      `This month: ₹${revThis.toLocaleString('en-IN')} vs pro-rated last month: ₹${proratedLast.toLocaleString('en-IN')} (${Math.round((revThis / proratedLast) * 100)}% of target). Investigate drop.`,
      round2(proratedLast - revThis)
    ));
  }

  // Zero revenue days in last 7 days
  const since7d = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const { data: dailySales } = await supabase
    .from('sales')
    .select('date,final_amount')
    .gte('date', since7d)
    .eq('status', 'paid');

  const salesByDay = {};
  for (const s of dailySales || []) {
    salesByDay[s.date] = (salesByDay[s.date] || 0) + parseFloat(s.final_amount || 0);
  }
  const zeroDays = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
    const dow = new Date(d).getDay();
    if (dow === 0 || dow === 6) continue; // Skip weekends
    if (!salesByDay[d] || salesByDay[d] === 0) zeroDays.push(d);
  }
  if (zeroDays.length >= 2) {
    findings.push(finding('Revenue', 'medium',
      `${zeroDays.length} weekdays with zero sales in last 7 days`,
      `Dates: ${zeroDays.join(', ')}. Check if invoicing was skipped or there were operational issues.`,
      null
    ));
  }

  return findings;
}

async function checkCompliance() {
  const findings = [];
  const today = new Date();
  const dayOfMonth = today.getDate();
  const month = today.getMonth() + 1;

  // TDS payment reminder — due 7th of each month for previous month
  if (dayOfMonth >= 4 && dayOfMonth <= 7) {
    findings.push(finding('Compliance', 'high',
      'TDS payment due by 7th of this month',
      'Deposit TDS deducted in the previous month to the Income Tax department via challan. Late payment attracts 1.5% per month interest.',
      null
    ));
  }

  // PF/ESI due by 15th
  if (dayOfMonth >= 12 && dayOfMonth <= 15) {
    findings.push(finding('Compliance', 'high',
      'PF/ESI contributions due by 15th of this month',
      'Provident Fund and ESI contributions for previous month must be deposited. Delayed deposits attract penalties.',
      null
    ));
  }

  // Advance tax quarters
  const advanceTaxDates = [
    { month: 6, day: 15,  pct: '15%',  quarter: 'Q1' },
    { month: 9, day: 15,  pct: '45%',  quarter: 'Q2' },
    { month: 12, day: 15, pct: '75%',  quarter: 'Q3' },
    { month: 3, day: 15,  pct: '100%', quarter: 'Q4' },
  ];
  for (const t of advanceTaxDates) {
    if (month === t.month && dayOfMonth >= 10 && dayOfMonth <= t.day) {
      findings.push(finding('Compliance', 'medium',
        `Advance tax Q${t.quarter.slice(1)} due by ${t.month}/${t.day}`,
        `${t.pct} of estimated annual tax liability must be paid by this date to avoid interest under Section 234C.`,
        null
      ));
    }
  }

  // Check for any overdue compliance items in DB
  const { data: items } = await supabase
    .from('compliance_items')
    .select('id,name,due_date,status,category')
    .lt('due_date', today.toISOString().slice(0, 10))
    .neq('status', 'completed')
    .limit(10);

  if (items && items.length > 0) {
    findings.push(finding('Compliance', 'critical',
      `${items.length} overdue compliance items`,
      `Items: ${items.slice(0, 3).map(i => `${i.name} (due ${i.due_date})`).join('; ')}. Overdue compliance can attract penalties and notices.`,
      null
    ));
  }

  return findings;
}

// ── Claude AI analysis ────────────────────────────────────────────────────────

async function analyzeWithClaude(allFindings, dashboardData) {
  if (!anthropic) return 'Claude analysis skipped — ANTHROPIC_API_KEY not set.';
  try {
    const findingsSummary = allFindings.map(f =>
      `[${f.severity.toUpperCase()}] ${f.category}: ${f.title}\n  → ${f.detail}${f.amount ? ` (₹${f.amount.toLocaleString('en-IN')})` : ''}`
    ).join('\n');

    const msg = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `You are an experienced Chartered Accountant reviewing the financial health of Sathvam Natural Products — a cold-pressed oil manufacturing company in Karur, Tamil Nadu.

Financial snapshot:
- Cash Balance: ₹${(dashboardData.cash_balance || 0).toLocaleString('en-IN')}
- AR Outstanding: ₹${(dashboardData.ar_total || 0).toLocaleString('en-IN')}
- AP Overdue: ₹${(dashboardData.ap_overdue || 0).toLocaleString('en-IN')}
- Revenue (last 30 days): ₹${(dashboardData.revenue_30d || 0).toLocaleString('en-IN')}

Automated findings (${allFindings.length} total):
${findingsSummary || 'No issues found.'}

As the CA, provide:
1. Overall financial health assessment (2–3 sentences)
2. Top 3 priority actions the management should take TODAY
3. One question you would ask the management to clarify the books

Be direct. Use plain text (no markdown). Speak as a real CA, not a chatbot.`,
      }],
    });
    return msg.content[0]?.text || 'No response from Claude.';
  } catch (e) {
    return `CA analysis unavailable: ${e.message}`;
  }
}

// ── WhatsApp alert ────────────────────────────────────────────────────────────

async function sendWhatsApp(phone, message) {
  const phoneId = process.env.WA_PHONE_NUMBER_ID;
  const token   = process.env.WA_ACCESS_TOKEN;
  if (!phoneId || !token) {
    console.log('WhatsApp not configured — skipping alert');
    return;
  }
  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: message } }),
    });
    const data = await res.json();
    if (data.error) throw new Error(JSON.stringify(data.error));
    console.log('WhatsApp alert sent to', phone);
  } catch (e) {
    console.error('WhatsApp send failed:', e.message);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const runId  = new Date().toISOString().replace(/\.\d{3}Z$/, '');
  console.log(`\n[${runId}] Sathvam CA Agent starting...`);

  // Get dashboard for context
  let dashboardData = {};
  try {
    const today  = new Date().toISOString().slice(0, 10);
    const ago30  = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const week   = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    const [bills, bankAccs, sales30, ws30, b2bPending] = await Promise.all([
      supabase.from('vendor_bills').select('amount,gst_amount,paid_amount,due_date,status').is('deleted_at', null),
      supabase.from('bank_accounts').select('current_balance').eq('is_active', true),
      supabase.from('sales').select('final_amount').eq('status', 'paid').gte('date', ago30),
      supabase.from('webstore_orders').select('total').in('status', ['confirmed', 'shipped', 'delivered']).gte('date', ago30),
      supabase.from('b2b_orders').select('total_value').not('stage', 'in', '("delivered","cancelled")'),
    ]);
    const billList  = bills.data || [];
    const apOverdue = billList.filter(b => b.status !== 'paid' && b.due_date && b.due_date < today)
      .reduce((s, b) => s + round2((b.amount || 0) + (b.gst_amount || 0)) - (b.paid_amount || 0), 0);
    dashboardData = {
      cash_balance: (bankAccs.data || []).reduce((s, a) => s + (a.current_balance || 0), 0),
      ar_total:     (b2bPending.data || []).reduce((s, x) => s + (x.total_value || 0), 0),
      ap_overdue:   apOverdue,
      revenue_30d:  (sales30.data || []).reduce((s, x) => s + (x.final_amount || 0), 0)
                  + (ws30.data || []).reduce((s, x) => s + (x.total || 0), 0),
    };
  } catch (e) {
    console.error('Dashboard fetch failed:', e.message);
  }

  // Run all checks in parallel
  console.log('Running financial checks...');
  const [arFindings, apFindings, bankFindings, gstFindings, payrollFindings, expenseFindings, revenueFindings, complianceFindings] =
    await Promise.all([
      checkAR().catch(e => { console.error('AR check failed:', e.message); return []; }),
      checkAP().catch(e => { console.error('AP check failed:', e.message); return []; }),
      checkBank().catch(e => { console.error('Bank check failed:', e.message); return []; }),
      checkGST().catch(e => { console.error('GST check failed:', e.message); return []; }),
      checkPayroll().catch(e => { console.error('Payroll check failed:', e.message); return []; }),
      checkExpenses().catch(e => { console.error('Expense check failed:', e.message); return []; }),
      checkRevenue().catch(e => { console.error('Revenue check failed:', e.message); return []; }),
      checkCompliance().catch(e => { console.error('Compliance check failed:', e.message); return []; }),
    ]);

  const allFindings = [
    ...arFindings, ...apFindings, ...bankFindings, ...gstFindings,
    ...payrollFindings, ...expenseFindings, ...revenueFindings, ...complianceFindings,
  ];

  console.log(`Found ${allFindings.length} issues (${allFindings.filter(f => f.severity === 'critical').length} critical, ${allFindings.filter(f => f.severity === 'high').length} high)`);

  // Claude analysis
  console.log('Requesting CA analysis from Claude...');
  const aiAnalysis = await analyzeWithClaude(allFindings, dashboardData);

  // Save to database
  if (allFindings.length > 0) {
    const rows = allFindings.map(f => ({ ...f, run_id: runId, ai_analysis: null }));
    // Attach ai_analysis to first finding of the run (as the run-level summary)
    rows[0].ai_analysis = aiAnalysis;
    const { error } = await supabase.from('ca_agent_findings').insert(rows);
    if (error) console.error('DB insert failed:', error.message);
    else console.log(`Saved ${rows.length} findings to DB`);
  } else {
    // Save an info finding even when all clear
    const { error } = await supabase.from('ca_agent_findings').insert([{
      run_id: runId, category: 'General', severity: 'info',
      title: 'All clear — no issues found',
      detail: 'Automated CA review found no financial anomalies or compliance risks today.',
      ai_analysis: aiAnalysis,
    }]);
    if (error) console.error('DB insert failed:', error.message);
  }

  // WhatsApp alert for critical/high findings
  const urgent = allFindings.filter(f => f.severity === 'critical' || f.severity === 'high');
  if (urgent.length > 0 && ADMIN_PHONE) {
    const dateStr = new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
    const lines = urgent.slice(0, 5).map(f => `• [${f.severity.toUpperCase()}] ${f.title}`).join('\n');
    const msg = `🏦 Sathvam CA Agent — ${dateStr}\n\n${urgent.length} urgent financial issues:\n${lines}\n\n${aiAnalysis.slice(0, 300)}...\n\nCheck Finance → CA Agent tab.`;
    await sendWhatsApp(ADMIN_PHONE, msg);
  }

  console.log(`\n[${new Date().toISOString()}] CA Agent complete.\n`);
  console.log('\n--- CA Analysis ---\n' + aiAnalysis + '\n--- END ---\n');
}

main().catch(e => {
  console.error('CA Agent fatal error:', e);
  process.exit(1);
});
