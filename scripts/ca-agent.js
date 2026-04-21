#!/usr/bin/env node
/**
 * Sathvam CA (Chartered Accountant) Agent
 * ─────────────────────────────────────────
 * Monitors the books daily as per Indian accounting standards & tax law.
 * Designed to be run at 9 AM IST via systemd timer or triggered manually via API.
 *
 * Usage:
 *   node /home/ubuntu/sathvam-backend/scripts/ca-agent.js
 *
 * Checks performed:
 *   AR          — overdue receivables, high-value unpaid invoices, AR aging
 *   AP          — overdue payables, bills due this week, partial payments stalled
 *   Bank        — low cash, negative balances, large debits, UNRECONCILED transactions
 *   GST         — filing reminders, sales without GST, ITC not claimed on AP, RCM flag
 *   TDS         — threshold detection (194C/194J/194I/194Q), overdue TDS payment
 *   CashLimits  — Sec 269ST (cash receipt >₹2L), Sec 40A(3) (cash expense >₹10K)
 *   Sec43B      — unpaid TDS/PF/ESI → disallowed deduction risk
 *   BooksQuality— round-number expenses, missing vendor/narration, unexplained entries
 *   Payroll     — pending payroll, bonus act compliance, Professional Tax (Tamil Nadu)
 *   Expenses    — large single expenses, month-over-month spike
 *   Revenue     — revenue drop, zero-sales weekdays
 *   Compliance  — TDS/PF/ESI/GST deadlines, advance tax, e-invoice threshold, overdue items
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { createClient } = require('@supabase/supabase-js');
const Anthropic        = require('@anthropic-ai/sdk');

const supabase  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY);
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const ADMIN_PHONE = process.env.ADMIN_WHATSAPP_PHONE || process.env.WA_ADMIN_PHONE;
const round2      = n => Math.round((parseFloat(n) || 0) * 100) / 100;

// Current Indian financial year: April 1 to March 31
function currentFYStart() {
  const now = new Date();
  const yr  = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${yr}-04-01`;
}

function finding(category, severity, title, detail, amount = null) {
  return { category, severity, title, detail, amount };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXISTING CHECKS (AR / AP / Bank / GST / Payroll / Expenses / Revenue)
// ─────────────────────────────────────────────────────────────────────────────

async function checkAR() {
  const findings = [];
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  const { data: b2b } = await supabase
    .from('b2b_orders')
    .select('id,order_no,customer_name,total_value,created_at')
    .not('stage', 'in', '("delivered","cancelled","invoice_paid")')
    .order('created_at', { ascending: true })
    .limit(200);

  const overdueB2B = (b2b || []).filter(o =>
    Math.floor((today - new Date(o.created_at)) / 86400000) > 30
  );
  if (overdueB2B.length > 0) {
    const total  = overdueB2B.reduce((s, o) => s + (o.total_value || 0), 0);
    const oldest = Math.max(...overdueB2B.map(o => Math.floor((today - new Date(o.created_at)) / 86400000)));
    findings.push(finding('AR', overdueB2B.length >= 5 ? 'high' : 'medium',
      `${overdueB2B.length} B2B orders overdue >30 days`,
      `Total outstanding: ₹${round2(total).toLocaleString('en-IN')}. Oldest: ${oldest} days. Customers: ${[...new Set(overdueB2B.map(o => o.customer_name))].slice(0, 3).join(', ')}`,
      round2(total)
    ));
  }

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

  const { data: ws } = await supabase
    .from('webstore_orders')
    .select('id,order_no,total,date,status')
    .in('status', ['confirmed', 'processing'])
    .order('date', { ascending: true })
    .limit(100);

  const staleWS = (ws || []).filter(o =>
    Math.floor((today - new Date(o.date)) / 86400000) > 5
  );
  if (staleWS.length > 3) {
    const total = staleWS.reduce((s, o) => s + (o.total || 0), 0);
    findings.push(finding('AR', 'medium',
      `${staleWS.length} webstore orders not shipped >5 days`,
      `Total: ₹${round2(total).toLocaleString('en-IN')}. Risk of customer disputes and negative reviews.`,
      round2(total)
    ));
  }

  return findings;
}

async function checkAP() {
  const findings = [];
  const today    = new Date();
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

  const overdue = billList.filter(b => b.status === 'overdue' || (b.due_date && b.due_date < todayStr));
  if (overdue.length > 0) {
    const total = overdue.reduce((s, b) => s + round2((b.amount || 0) + (b.gst_amount || 0) - (b.paid_amount || 0)), 0);
    findings.push(finding('AP', overdue.length >= 3 ? 'critical' : 'high',
      `${overdue.length} vendor bills overdue`,
      `Total: ₹${round2(total).toLocaleString('en-IN')}. Vendors: ${[...new Set(overdue.map(b => b.vendor_name))].slice(0, 3).join(', ')}. Delayed payments damage supplier credit and may trigger legal action.`,
      round2(total)
    ));
  }

  const dueThisWeek = billList.filter(b => b.due_date && b.due_date >= todayStr && b.due_date <= weekLater);
  if (dueThisWeek.length > 0) {
    const total = dueThisWeek.reduce((s, b) => s + round2((b.amount || 0) + (b.gst_amount || 0) - (b.paid_amount || 0)), 0);
    findings.push(finding('AP', 'medium',
      `${dueThisWeek.length} bills due within 7 days`,
      `Total: ₹${round2(total).toLocaleString('en-IN')}. Schedule payments now to avoid late fees.`,
      round2(total)
    ));
  }

  const stalledPartial = billList.filter(b =>
    b.status === 'partial' && Math.floor((today - new Date(b.bill_date)) / 86400000) > 30
  );
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

  const accList   = accounts || [];
  const totalCash = accList.reduce((s, a) => s + (a.current_balance || 0), 0);

  if (totalCash < 50000) {
    findings.push(finding('Bank', 'critical',
      `Very low cash balance: ₹${round2(totalCash).toLocaleString('en-IN')}`,
      `Total across ${accList.length} account(s). Immediate action needed — risk of payment failures, bounced cheques, and penalty charges.`,
      round2(totalCash)
    ));
  } else if (totalCash < 200000) {
    findings.push(finding('Bank', 'high',
      `Low cash balance: ₹${round2(totalCash).toLocaleString('en-IN')}`,
      `Total across ${accList.length} account(s). Consider accelerating collections or using credit facility.`,
      round2(totalCash)
    ));
  }

  const negative = accList.filter(a => (a.current_balance || 0) < 0);
  for (const acc of negative) {
    findings.push(finding('Bank', 'critical',
      `Negative balance in account: ${acc.name}`,
      `Balance: ₹${round2(acc.current_balance).toLocaleString('en-IN')}. Indicates unrecorded debit, data entry error, or unauthorised withdrawal.`,
      acc.current_balance
    ));
  }

  // ── Bank reconciliation: unreconciled transactions >7 days old ──────────────
  const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const { data: unreconciled } = await supabase
    .from('bank_transactions')
    .select('id,date,type,amount,description,bank_account_id')
    .eq('reconciled', false)
    .lt('date', since)
    .order('date', { ascending: true })
    .limit(100);

  if (unreconciled && unreconciled.length > 0) {
    const total = unreconciled.reduce((s, t) => s + parseFloat(t.amount || 0), 0);
    const oldest = unreconciled[0].date;
    findings.push(finding('Bank', 'high',
      `${unreconciled.length} bank transactions unreconciled for >7 days`,
      `Total unreconciled: ₹${round2(total).toLocaleString('en-IN')}. Oldest entry: ${oldest}. Unreconciled books are a serious audit risk — reconcile weekly at minimum.`,
      round2(total)
    ));
  }

  // Large single debits last 7 days
  const { data: largeDebits } = await supabase
    .from('bank_transactions')
    .select('id,date,type,amount,description')
    .eq('type', 'debit')
    .gte('date', since)
    .gt('amount', 50000)
    .order('amount', { ascending: false })
    .limit(5);

  if (largeDebits && largeDebits.length > 0) {
    const total = largeDebits.reduce((s, t) => s + (t.amount || 0), 0);
    findings.push(finding('Bank', 'medium',
      `${largeDebits.length} large debit transactions (>₹50K) in last 7 days`,
      `Total: ₹${round2(total).toLocaleString('en-IN')}. Largest: "${largeDebits[0].description || 'No description'}" — ₹${round2(largeDebits[0].amount).toLocaleString('en-IN')}. Verify all are authorised.`,
      round2(total)
    ));
  }

  return findings;
}

async function checkGST() {
  const findings = [];
  const today      = new Date();
  const dayOfMonth = today.getDate();
  const ago30      = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const fyStart    = currentFYStart();

  // Filing reminders
  if (dayOfMonth >= 8 && dayOfMonth <= 11) {
    findings.push(finding('GST', 'high',
      'GSTR-1 filing due by 11th of this month',
      'Upload all B2B (GSTIN-wise) and B2C invoices for last month to GSTIN portal. Missing invoices block buyer\'s ITC claim and can attract notice u/s 61.',
      null
    ));
  }
  if (dayOfMonth >= 17 && dayOfMonth <= 20) {
    findings.push(finding('GST', 'critical',
      'GSTR-3B filing due by 20th of this month',
      'Monthly self-assessment GST return. Late filing: interest @18% p.a. + ₹50/day late fee (₹20/day for NIL return). Do not miss.',
      null
    ));
  }

  // Sales >₹10K without GST
  const { data: salesNoGST } = await supabase
    .from('sales')
    .select('id,invoice_no,final_amount,gst_amount,date')
    .gte('date', ago30)
    .gt('final_amount', 10000)
    .or('gst_amount.is.null,gst_amount.eq.0')
    .limit(20);

  if (salesNoGST && salesNoGST.length > 0) {
    const total = salesNoGST.reduce((s, x) => s + (x.final_amount || 0), 0);
    findings.push(finding('GST', 'medium',
      `${salesNoGST.length} sales >₹10K with no GST in last 30 days`,
      `Total: ₹${round2(total).toLocaleString('en-IN')}. Verify if these are exempt supplies (e.g. export, nil-rated) or GST was missed. Unreported output tax = demand + 100% penalty.`,
      round2(total)
    ));
  }

  // ITC not claimed: vendor bills with GST amount but no ITC recorded
  // Proxy: vendor bills with gst_amount > 0 that are overdue/unpaid (ITC can only be claimed after payment within 180 days)
  const { data: itcRisk } = await supabase
    .from('vendor_bills')
    .select('id,vendor_name,amount,gst_amount,bill_date,status')
    .in('status', ['unpaid', 'partial', 'overdue'])
    .gt('gst_amount', 0)
    .lt('bill_date', new Date(Date.now() - 150 * 86400000).toISOString().slice(0, 10)) // >150 days old
    .is('deleted_at', null)
    .limit(20);

  if (itcRisk && itcRisk.length > 0) {
    const totalGST = itcRisk.reduce((s, b) => s + parseFloat(b.gst_amount || 0), 0);
    findings.push(finding('GST', 'high',
      `ITC reversal risk: ${itcRisk.length} unpaid bills >150 days old`,
      `Total GST (ITC at risk): ₹${round2(totalGST).toLocaleString('en-IN')}. Rule 37 of CGST Rules: ITC must be reversed if vendor invoice unpaid within 180 days. Pay or reverse ITC immediately.`,
      round2(totalGST)
    ));
  }

  // RCM flag: expenses in categories that attract Reverse Charge Mechanism
  const RCM_CATEGORIES = ['Freight', 'Transport', 'Logistics', 'GTA', 'Legal', 'Advocate', 'Sponsorship', 'Import'];
  const { data: rcmExpenses } = await supabase
    .from('company_expenses')
    .select('id,category,amount,vendor,date')
    .in('category', RCM_CATEGORIES)
    .gte('date', ago30)
    .gt('amount', 5000)
    .is('deleted_at', null)
    .limit(20);

  if (rcmExpenses && rcmExpenses.length > 0) {
    const total = rcmExpenses.reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    findings.push(finding('GST', 'medium',
      `${rcmExpenses.length} expenses in RCM categories — verify GST self-assessment`,
      `Categories: ${[...new Set(rcmExpenses.map(e => e.category))].join(', ')}. Total: ₹${round2(total).toLocaleString('en-IN')}. GTA freight, legal fees, etc. attract RCM — you must pay GST directly to govt and then claim ITC.`,
      round2(total)
    ));
  }

  // E-invoice threshold check: estimate annual turnover from last 12 months
  const ago365 = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const [sales12, ws12] = await Promise.all([
    supabase.from('sales').select('final_amount').eq('status', 'paid').gte('date', ago365),
    supabase.from('webstore_orders').select('total').in('status', ['confirmed', 'packed', 'shipped', 'delivered']).gte('date', ago365),
  ]);
  const annualTurnover = round2(
    (sales12.data || []).reduce((s, x) => s + parseFloat(x.final_amount || 0), 0) +
    (ws12.data || []).reduce((s, x) => s + parseFloat(x.total || 0), 0)
  );
  if (annualTurnover >= 45000000) { // ₹4.5 crore (warn before ₹5cr threshold)
    findings.push(finding('GST', 'critical',
      `Approaching e-invoice mandatory threshold — annual turnover ~₹${(annualTurnover / 10000000).toFixed(1)} crore`,
      'E-invoicing is mandatory for businesses with turnover >₹5 crore. You must generate IRN (Invoice Reference Number) for every B2B invoice via IRP portal. Penalty: ₹10,000 per invoice.',
      annualTurnover
    ));
  } else if (annualTurnover >= 30000000) { // ₹3 crore
    findings.push(finding('GST', 'medium',
      `Annual turnover ~₹${(annualTurnover / 10000000).toFixed(1)} crore — monitor e-invoice threshold`,
      'E-invoicing becomes mandatory above ₹5 crore turnover. Start preparing systems — IRP integration, IRN generation, QR code on invoices.',
      annualTurnover
    ));
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: TDS THRESHOLD DETECTION (Section 194C / 194J / 194I / 194Q)
// ─────────────────────────────────────────────────────────────────────────────

async function checkTDS() {
  const findings = [];
  const fyStart  = currentFYStart();
  const today    = new Date().toISOString().slice(0, 10);

  // ── 194C: Contractor/sub-contractor payments ──────────────────────────────
  // Single payment >₹30,000 OR cumulative FY >₹1,00,000 → TDS @2% (1% for individuals)
  const CONTRACTOR_CATS = ['Contractor', 'Labour', 'Repair', 'Maintenance', 'Carriage', 'Transport', 'Freight', 'Printing', 'Packaging Work', 'Civil Work', 'Electrical', 'AMC'];

  const { data: contractorBills } = await supabase
    .from('vendor_bills')
    .select('id,vendor_name,amount,bill_date,category')
    .in('category', CONTRACTOR_CATS)
    .gte('bill_date', fyStart)
    .is('deleted_at', null)
    .limit(500);

  if (contractorBills && contractorBills.length > 0) {
    // Group by vendor
    const byVendor = {};
    for (const b of contractorBills) {
      byVendor[b.vendor_name] = (byVendor[b.vendor_name] || 0) + parseFloat(b.amount || 0);
    }
    // Single payment check
    const largeSingle = contractorBills.filter(b => parseFloat(b.amount || 0) > 30000);
    for (const b of largeSingle.slice(0, 3)) {
      findings.push(finding('TDS', 'high',
        `Sec 194C: Single contractor payment ₹${round2(b.amount).toLocaleString('en-IN')} to ${b.vendor_name}`,
        `Date: ${b.bill_date}. Category: ${b.category}. Single payment >₹30,000 requires TDS @2% (₹${round2(b.amount * 0.02).toLocaleString('en-IN')}). Deduct TDS before payment or face 30% disallowance.`,
        round2(b.amount)
      ));
    }
    // Cumulative FY check
    const cumOverLimit = Object.entries(byVendor).filter(([, total]) => total > 100000);
    for (const [vendor, total] of cumOverLimit.slice(0, 3)) {
      findings.push(finding('TDS', 'high',
        `Sec 194C: Cumulative FY payments to ${vendor} = ₹${round2(total).toLocaleString('en-IN')}`,
        `Exceeds ₹1,00,000 FY threshold. TDS @2% required on all payments to this contractor this year. Outstanding TDS: ~₹${round2(total * 0.02).toLocaleString('en-IN')}. Late deduction: interest @1% per month.`,
        round2(total)
      ));
    }
  }

  // ── 194J: Professional / Technical fees ──────────────────────────────────
  // >₹30,000 per vendor per FY → TDS @10%
  const PROF_CATS = ['Professional Fees', 'Consultancy', 'Legal Fees', 'Audit Fees', 'Technical', 'Software', 'Advisory', 'CA Fees', 'Architect'];

  const { data: profBills } = await supabase
    .from('vendor_bills')
    .select('id,vendor_name,amount,bill_date,category')
    .in('category', PROF_CATS)
    .gte('bill_date', fyStart)
    .is('deleted_at', null)
    .limit(200);

  if (profBills && profBills.length > 0) {
    const byVendor = {};
    for (const b of profBills) {
      byVendor[b.vendor_name] = (byVendor[b.vendor_name] || 0) + parseFloat(b.amount || 0);
    }
    for (const [vendor, total] of Object.entries(byVendor).filter(([, t]) => t > 30000).slice(0, 3)) {
      findings.push(finding('TDS', 'high',
        `Sec 194J: Professional fee to ${vendor} = ₹${round2(total).toLocaleString('en-IN')} (FY total)`,
        `Exceeds ₹30,000 threshold. TDS @10% required: ₹${round2(total * 0.10).toLocaleString('en-IN')}. Applies to CA, lawyer, consultant, technical service fees. Must deduct at source.`,
        round2(total)
      ));
    }
  }

  // ── 194I: Rent payments ───────────────────────────────────────────────────
  // Rent >₹2,40,000 per FY → TDS @10% (land/building) or 2% (plant/machinery)
  const RENT_CATS = ['Rent', 'Office Rent', 'Godown Rent', 'Warehouse Rent', 'Lease'];

  const { data: rentBills } = await supabase
    .from('vendor_bills')
    .select('id,vendor_name,amount,bill_date,category')
    .in('category', RENT_CATS)
    .gte('bill_date', fyStart)
    .is('deleted_at', null)
    .limit(100);

  if (rentBills && rentBills.length > 0) {
    const byVendor = {};
    for (const b of rentBills) {
      byVendor[b.vendor_name] = (byVendor[b.vendor_name] || 0) + parseFloat(b.amount || 0);
    }
    for (const [vendor, total] of Object.entries(byVendor).filter(([, t]) => t > 240000).slice(0, 3)) {
      findings.push(finding('TDS', 'high',
        `Sec 194I: Rent to ${vendor} = ₹${round2(total).toLocaleString('en-IN')} (FY total)`,
        `Exceeds ₹2,40,000 threshold. TDS @10% on rent of land/building: ₹${round2(total * 0.10).toLocaleString('en-IN')}. Must deduct TDS before payment. Landlord must have PAN on record.`,
        round2(total)
      ));
    }
    // Early warning: >₹15K/month (approaching ₹2.4L annually)
    const monthlyRent = Object.entries(byVendor).filter(([, t]) => {
      const months = Math.max(1, Math.floor((new Date() - new Date(fyStart)) / (30 * 86400000)));
      return t / months > 15000 && t <= 240000;
    });
    for (const [vendor, total] of monthlyRent.slice(0, 2)) {
      findings.push(finding('TDS', 'medium',
        `Sec 194I watch: Rent to ${vendor} may cross ₹2.4L threshold this FY`,
        `FY total so far: ₹${round2(total).toLocaleString('en-IN')}. Start deducting TDS from the month threshold is breached.`,
        round2(total)
      ));
    }
  }

  // ── 194Q: Purchases from single vendor >₹50L in FY ───────────────────────
  // Buyer must deduct TDS @0.1% on purchase amount exceeding ₹50L
  const { data: procurements } = await supabase
    .from('procurements')
    .select('vendor,total_amount,date')
    .gte('date', fyStart)
    .limit(1000);

  if (procurements && procurements.length > 0) {
    const byVendor = {};
    for (const p of procurements) {
      byVendor[p.vendor] = (byVendor[p.vendor] || 0) + parseFloat(p.total_amount || 0);
    }
    for (const [vendor, total] of Object.entries(byVendor).filter(([, t]) => t > 5000000).slice(0, 3)) {
      findings.push(finding('TDS', 'critical',
        `Sec 194Q: Purchases from ${vendor} = ₹${round2(total).toLocaleString('en-IN')} — TDS required`,
        `Exceeded ₹50L FY purchase threshold. Must deduct TDS @0.1% on amount above ₹50L: ~₹${round2((total - 5000000) * 0.001).toLocaleString('en-IN')}. File 26Q quarterly. Note: 194Q and 206C(1H) don't apply simultaneously — whoever deducts first prevails.`,
        round2(total)
      ));
    }
    // Warning at ₹40L (approaching threshold)
    for (const [vendor, total] of Object.entries(byVendor).filter(([, t]) => t > 4000000 && t <= 5000000).slice(0, 2)) {
      findings.push(finding('TDS', 'medium',
        `Sec 194Q watch: Purchases from ${vendor} at ₹${round2(total).toLocaleString('en-IN')} — nearing ₹50L`,
        `When purchases cross ₹50L this FY, TDS @0.1% must be deducted on the excess amount.`,
        round2(total)
      ));
    }
  }

  // ── TDS return filing reminders (Form 26Q quarterly) ─────────────────────
  // Q1: Apr-Jun → file by Jul 31 | Q2: Jul-Sep → Oct 31 | Q3: Oct-Dec → Jan 31 | Q4: Jan-Mar → May 31
  const month      = today.slice(5, 7);
  const dayOfMonth = parseInt(today.slice(8, 10));
  const tdsDeadlines = [
    { months: ['07'], day: 31, quarter: 'Q1 (Apr–Jun)', form: '26Q/24Q' },
    { months: ['10'], day: 31, quarter: 'Q2 (Jul–Sep)', form: '26Q/24Q' },
    { months: ['01'], day: 31, quarter: 'Q3 (Oct–Dec)', form: '26Q/24Q' },
    { months: ['05'], day: 31, quarter: 'Q4 (Jan–Mar)', form: '26Q/24Q' },
  ];
  for (const d of tdsDeadlines) {
    if (d.months.includes(month) && dayOfMonth >= 20) {
      findings.push(finding('TDS', 'high',
        `TDS return ${d.form} for ${d.quarter} due by ${month}/${d.day}`,
        `File TDS return with TRACES. Delay: ₹200/day late fee u/s 234E. Incorrect return: ₹10,000–₹1,00,000 penalty. Ensure all deductee PANs are correct.`,
        null
      ));
    }
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: CASH LIMITS — Section 269ST & Section 40A(3)
// ─────────────────────────────────────────────────────────────────────────────

async function checkCashLimits() {
  const findings = [];
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  // ── Section 269ST: Cash receipts >₹2L from single person in one day/transaction ──
  // Check webstore_orders paid in cash
  const { data: cashOrders } = await supabase
    .from('webstore_orders')
    .select('id,order_no,customer,total,date,payment_status')
    .gte('date', since30)
    .gt('total', 200000)
    .limit(20);

  // Check sales paid in cash (payment_mode = 'cash')
  const { data: cashSales } = await supabase
    .from('sales')
    .select('id,order_no,customer_name,final_amount,date,payment_mode')
    .gte('date', since30)
    .eq('payment_mode', 'cash')
    .gt('final_amount', 200000)
    .limit(20);

  if (cashSales && cashSales.length > 0) {
    for (const s of cashSales.slice(0, 3)) {
      findings.push(finding('CashLimits', 'critical',
        `Sec 269ST VIOLATION: Cash receipt ₹${round2(s.final_amount).toLocaleString('en-IN')} from ${s.customer_name}`,
        `Date: ${s.date}. Order: ${s.order_no}. Cash receipt >₹2,00,000 from single person is ILLEGAL. Penalty = 100% of amount received (₹${round2(s.final_amount).toLocaleString('en-IN')}). Must accept only via banking channels immediately.`,
        round2(s.final_amount)
      ));
    }
  }

  // ── Section 40A(3): Cash expenses >₹10,000 per day per vendor ────────────
  // Any cash payment to single vendor >₹10,000 in a day → 100% disallowance
  const { data: cashExpenses } = await supabase
    .from('company_expenses')
    .select('id,date,vendor,amount,category,description,payment_mode')
    .gte('date', since30)
    .gt('amount', 10000)
    .is('deleted_at', null)
    .limit(200);

  if (cashExpenses) {
    // Filter cash payments
    const cashOnly = cashExpenses.filter(e =>
      ['cash', 'Cash', 'CASH', 'petty cash', 'Petty Cash'].includes(e.payment_mode || '')
    );

    // Group by date+vendor
    const grouped = {};
    for (const e of cashOnly) {
      const key = `${e.date}__${e.vendor || 'Unknown'}`;
      grouped[key] = (grouped[key] || 0) + parseFloat(e.amount || 0);
    }
    const violations = Object.entries(grouped).filter(([, total]) => total > 10000);
    if (violations.length > 0) {
      const totalDisallowed = violations.reduce((s, [, t]) => s + t, 0);
      const samples = violations.slice(0, 3).map(([key, total]) => {
        const [date, vendor] = key.split('__');
        return `${vendor} on ${date}: ₹${round2(total).toLocaleString('en-IN')}`;
      }).join('; ');
      findings.push(finding('CashLimits', 'critical',
        `Sec 40A(3): ${violations.length} cash expense(s) >₹10K per vendor per day`,
        `Total at risk of 100% disallowance: ₹${round2(totalDisallowed).toLocaleString('en-IN')}. Details: ${samples}. These will be added back to income during IT assessment. Pay vendors by RTGS/NEFT/cheque instead.`,
        round2(totalDisallowed)
      ));
    }
  }

  // ── Alert on large cash expenses even without payment_mode data ──────────
  const { data: largeExpenses } = await supabase
    .from('company_expenses')
    .select('id,date,vendor,amount,category,payment_mode')
    .gte('date', since30)
    .gt('amount', 10000)
    .is('payment_mode', null) // payment mode not recorded
    .is('deleted_at', null)
    .limit(20);

  if (largeExpenses && largeExpenses.length > 0) {
    const total = largeExpenses.reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    findings.push(finding('CashLimits', 'medium',
      `${largeExpenses.length} expenses >₹10K with payment mode not recorded`,
      `Total: ₹${round2(total).toLocaleString('en-IN')}. If any were paid in cash, Sec 40A(3) disallowance risk applies. Update payment mode for all expense entries.`,
      round2(total)
    ));
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: SECTION 43B — UNPAID STATUTORY DUES (disallowance risk)
// ─────────────────────────────────────────────────────────────────────────────

async function checkSection43B() {
  const findings = [];
  const today       = new Date();
  const dayOfMonth  = today.getDate();
  const month       = today.getMonth() + 1; // 1-12
  const todayStr    = today.toISOString().slice(0, 10);

  // Section 43B: TDS, PF, ESI, Bonus, Leave Encashment — if not paid by due date (or ITR filing date for bonus),
  // the expense is disallowed in the year of accrual and only allowed in year of actual payment.

  // ── Unpaid TDS: If TDS deducted but not deposited by 7th of next month ────
  // We check if day is >8 (7th has passed) and flag
  if (dayOfMonth > 8) {
    findings.push(finding('Sec43B', 'high',
      'Verify TDS deposited by 7th to avoid Sec 43B disallowance',
      `Today is ${dayOfMonth}${dayOfMonth===1?'st':dayOfMonth===2?'nd':dayOfMonth===3?'rd':'th'}. TDS deducted last month must be deposited by 7th. Unpaid TDS = disallowed deduction u/s 43B — adds back to taxable income.`,
      null
    ));
  }

  // ── PF/ESI not paid by 15th ───────────────────────────────────────────────
  if (dayOfMonth > 15) {
    findings.push(finding('Sec43B', 'high',
      'Verify PF/ESI deposited by 15th to avoid Sec 43B disallowance',
      `PF/ESI due 15th of each month. Late deposit: interest @12% p.a. + ₹5 per day penalty (PF) or @12% (ESI). Also, employee contributions become employer income if not deposited. This is a Sec 43B disallowance AND a criminal liability.`,
      null
    ));
  }

  // ── Statutory bonus: financial year end March 31, must pay within 8 months ─
  // So by November 30 of the same calendar year
  if (month === 11 && dayOfMonth >= 20) {
    findings.push(finding('Sec43B', 'critical',
      'Statutory bonus (Bonus Act) payment deadline: November 30',
      'Bonus Act requires paying minimum bonus (8.33% of salary, max ₹7,000/month basis) within 8 months of FY end (March 31). Deadline is November 30. Unpaid bonus is a Sec 43B disallowance AND attracts prosecution under Bonus Act.',
      null
    ));
  } else if (month === 11 && dayOfMonth >= 1) {
    findings.push(finding('Sec43B', 'high',
      'Statutory bonus deadline approaching: November 30',
      'Minimum bonus (8.33% of annual salary, capped at ₹7,000/month basis) must be paid by November 30. Check if bonuses have been processed in payroll.',
      null
    ));
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: BOOKS QUALITY CHECKS
// ─────────────────────────────────────────────────────────────────────────────

async function checkBooksQuality() {
  const findings = [];
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  // ── Round-number expenses: potential fraud / estimated entries ────────────
  // Exact round numbers like ₹5000, ₹10000, ₹25000, ₹50000 are a red flag
  const ROUND_AMOUNTS = [5000, 10000, 15000, 20000, 25000, 50000, 75000, 100000];
  const { data: allExpenses } = await supabase
    .from('company_expenses')
    .select('id,date,category,amount,vendor,description')
    .gte('date', since30)
    .gt('amount', 5000)
    .is('deleted_at', null)
    .limit(500);

  if (allExpenses) {
    const roundEntries = allExpenses.filter(e => ROUND_AMOUNTS.includes(parseFloat(e.amount)));
    if (roundEntries.length >= 5) {
      findings.push(finding('BooksQuality', 'medium',
        `${roundEntries.length} expenses with suspiciously round amounts in last 30 days`,
        `Examples: ${roundEntries.slice(0, 3).map(e => `₹${e.amount} (${e.category}, ${e.vendor || 'no vendor'})`).join('; ')}. Round-number entries suggest estimates or fabricated expenses. Auditors flag these — ensure all have supporting invoices/receipts.`,
        null
      ));
    }

    // Large expenses without vendor name
    const noVendor = allExpenses.filter(e => !e.vendor && parseFloat(e.amount) > 10000);
    if (noVendor.length > 0) {
      const total = noVendor.reduce((s, e) => s + parseFloat(e.amount || 0), 0);
      findings.push(finding('BooksQuality', 'medium',
        `${noVendor.length} expenses >₹10K without vendor name`,
        `Total: ₹${round2(total).toLocaleString('en-IN')}. Missing vendor = missing audit trail. Tax officers can disallow expenses without proper vendor details. Add vendor name, PAN for all significant payments.`,
        round2(total)
      ));
    }

    // Large expenses without description/narration
    const noDesc = allExpenses.filter(e => !e.description && parseFloat(e.amount) > 15000);
    if (noDesc.length > 0) {
      findings.push(finding('BooksQuality', 'low',
        `${noDesc.length} expenses >₹15K missing description/narration`,
        `Good accounting practice: every entry must have a narration explaining the nature. Missing narrations make reconciliation and audit difficult. Add descriptions for all entries.`,
        null
      ));
    }
  }

  // ── Duplicate entries: same amount + same vendor + same date ─────────────
  if (allExpenses) {
    const seen = {};
    const duplicates = [];
    for (const e of allExpenses) {
      const key = `${e.date}__${e.vendor}__${e.amount}`;
      if (seen[key]) duplicates.push(e);
      else seen[key] = true;
    }
    if (duplicates.length > 0) {
      findings.push(finding('BooksQuality', 'high',
        `${duplicates.length} possible duplicate expense entries detected`,
        `Same vendor + date + amount combinations found. Examples: ${duplicates.slice(0, 2).map(e => `₹${e.amount} to ${e.vendor || 'Unknown'} on ${e.date}`).join('; ')}. Verify these are not double-booked.`,
        null
      ));
    }
  }

  // ── Journal entries without narration ────────────────────────────────────
  const { data: journalEntries } = await supabase
    .from('journal_entries')
    .select('id,date,description')
    .gte('date', since30)
    .is('description', null)
    .limit(10);

  if (journalEntries && journalEntries.length > 0) {
    findings.push(finding('BooksQuality', 'low',
      `${journalEntries.length} journal entries without narration in last 30 days`,
      'Every journal entry must have a narration per accounting standards. Missing narrations fail audit scrutiny and make year-end review difficult.',
      null
    ));
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// ENHANCED: PAYROLL (with Bonus Act + Professional Tax)
// ─────────────────────────────────────────────────────────────────────────────

async function checkPayroll() {
  const findings = [];
  const today      = new Date();
  const currentMonth = today.toISOString().slice(0, 7);
  const dayOfMonth   = today.getDate();
  const month        = today.getMonth() + 1;

  // Payroll not processed after 25th
  if (dayOfMonth >= 25) {
    const { data: payroll } = await supabase
      .from('payroll')
      .select('id,month,total_amount,status')
      .eq('month', currentMonth)
      .limit(1);

    if (!payroll || payroll.length === 0) {
      findings.push(finding('Payroll', 'high',
        `Payroll for ${currentMonth} not yet processed`,
        `${dayOfMonth}th of month. Process salary before month-end to avoid Sec 43B disallowance on salary expense.`,
        null
      ));
    } else if (payroll[0].status === 'draft') {
      findings.push(finding('Payroll', 'medium',
        `Payroll ${currentMonth} in draft — not approved or disbursed`,
        'Approve and disburse salaries before month end.',
        payroll[0].total_amount
      ));
    }
  }

  // ── Professional Tax — Tamil Nadu ─────────────────────────────────────────
  // Employer must deduct PT from employees: ₹2,500/year per employee (₹1,250 per half-year)
  // Half-year 1: April–September → pay by September 30
  // Half-year 2: October–March → pay by March 31
  if (month === 9 && dayOfMonth >= 20) {
    findings.push(finding('Payroll', 'high',
      'Professional Tax (PT) — Tamil Nadu: H1 payment due September 30',
      'Deduct ₹1,250 from each employee\'s salary for April–September and remit to Tamil Nadu Commercial Taxes Department. Late payment: penalty + 2% per month interest. Employer penalty if not deducted.',
      null
    ));
  } else if (month === 3 && dayOfMonth >= 20) {
    findings.push(finding('Payroll', 'high',
      'Professional Tax (PT) — Tamil Nadu: H2 payment due March 31',
      'Deduct ₹1,250 from each employee\'s salary for October–March and remit to Tamil Nadu Commercial Taxes Department.',
      null
    ));
  }

  // ── Statutory Bonus Act ───────────────────────────────────────────────────
  if (month === 11) {
    const { data: bonusPayroll } = await supabase
      .from('payroll')
      .select('id,month,bonus_amount')
      .gte('month', new Date().getFullYear() + '-04')
      .not('bonus_amount', 'is', null)
      .gt('bonus_amount', 0)
      .limit(1);

    if (!bonusPayroll || bonusPayroll.length === 0) {
      findings.push(finding('Payroll', 'critical',
        'Statutory Bonus (Bonus Act) not yet paid — deadline November 30',
        'Minimum bonus = 8.33% of annual salary (subject to ₹7,000/month basis cap). Must be paid within 8 months of financial year end (March 31). Criminal liability for non-payment under Section 28 of Bonus Act.',
        null
      ));
    }
  }

  return findings;
}

async function checkExpenses() {
  const findings = [];
  const today    = new Date();
  const since7d  = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

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
          `Date: ${e.date}. Vendor: ${e.vendor || '—'}. Approved by: ${e.approved_by || 'not specified'}. Verify authorisation and that invoice/receipt is on file.`,
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

  const thisMonthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1).toISOString().slice(0, 10);
  const lastMonthEnd   = new Date(today.getFullYear(), today.getMonth(), 0).toISOString().slice(0, 10);

  const [thisMonth, lastMonth] = await Promise.all([
    supabase.from('company_expenses').select('amount').gte('date', thisMonthStart).lte('date', today.toISOString().slice(0, 10)).is('deleted_at', null),
    supabase.from('company_expenses').select('amount').gte('date', lastMonthStart).lte('date', lastMonthEnd).is('deleted_at', null),
  ]);

  const thisTotal   = (thisMonth.data || []).reduce((s, e) => s + parseFloat(e.amount || 0), 0);
  const lastTotal   = (lastMonth.data || []).reduce((s, e) => s + parseFloat(e.amount || 0), 0);
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const proratedLast = lastTotal * (today.getDate() / daysInMonth);

  if (proratedLast > 0 && thisTotal > proratedLast * 1.5) {
    findings.push(finding('Expenses', 'medium',
      'Expenses running 50%+ above last month pace',
      `This month: ₹${round2(thisTotal).toLocaleString('en-IN')} vs pro-rated last month: ₹${round2(proratedLast).toLocaleString('en-IN')}. Investigate reason for spike.`,
      round2(thisTotal - proratedLast)
    ));
  }

  return findings;
}

async function checkRevenue() {
  const findings  = [];
  const today     = new Date();
  const thisMonthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1).toISOString().slice(0, 10);
  const lastMonthEnd   = new Date(today.getFullYear(), today.getMonth(), 0).toISOString().slice(0, 10);
  const daysInMonth    = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();

  const [salesThis, wsThis, salesLast, wsLast] = await Promise.all([
    supabase.from('sales').select('final_amount').eq('status', 'paid').gte('date', thisMonthStart),
    supabase.from('webstore_orders').select('total').in('status', ['confirmed', 'packed', 'shipped', 'delivered']).gte('date', thisMonthStart),
    supabase.from('sales').select('final_amount').eq('status', 'paid').gte('date', lastMonthStart).lte('date', lastMonthEnd),
    supabase.from('webstore_orders').select('total').in('status', ['confirmed', 'packed', 'shipped', 'delivered']).gte('date', lastMonthStart).lte('date', lastMonthEnd),
  ]);

  const revThis = round2(
    (salesThis.data || []).reduce((s, x) => s + parseFloat(x.final_amount || 0), 0) +
    (wsThis.data   || []).reduce((s, x) => s + parseFloat(x.total || 0), 0)
  );
  const revLast = round2(
    (salesLast.data || []).reduce((s, x) => s + parseFloat(x.final_amount || 0), 0) +
    (wsLast.data   || []).reduce((s, x) => s + parseFloat(x.total || 0), 0)
  );
  const proratedLast = round2(revLast * (today.getDate() / daysInMonth));

  if (proratedLast > 10000 && revThis < proratedLast * 0.7) {
    findings.push(finding('Revenue', 'high',
      'Revenue significantly below last month pace',
      `This month: ₹${revThis.toLocaleString('en-IN')} vs pro-rated last month: ₹${proratedLast.toLocaleString('en-IN')} (${Math.round((revThis / proratedLast) * 100)}%). Investigate drop.`,
      round2(proratedLast - revThis)
    ));
  }

  const since7d = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const { data: dailySales } = await supabase
    .from('sales').select('date,final_amount').gte('date', since7d).eq('status', 'paid');

  const salesByDay = {};
  for (const s of dailySales || []) {
    salesByDay[s.date] = (salesByDay[s.date] || 0) + parseFloat(s.final_amount || 0);
  }
  const zeroDays = [];
  for (let i = 1; i <= 7; i++) {
    const d   = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
    const dow = new Date(d).getDay();
    if (dow === 0 || dow === 6) continue;
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
  const findings   = [];
  const today      = new Date();
  const dayOfMonth = today.getDate();
  const month      = today.getMonth() + 1;

  // TDS payment by 7th
  if (dayOfMonth >= 4 && dayOfMonth <= 7) {
    findings.push(finding('Compliance', 'high',
      'TDS deposit due by 7th — pay via challan ITNS 281',
      'Deposit TDS deducted in the previous month. Delay: interest @1.5%/month from date of deduction + potential prosecution u/s 276B. Pay via income tax portal using challan ITNS 281.',
      null
    ));
  }

  // PF/ESI by 15th
  if (dayOfMonth >= 12 && dayOfMonth <= 15) {
    findings.push(finding('Compliance', 'high',
      'PF/ESI contributions due by 15th',
      'EPF: 12% employee + 12% employer on basic+DA. ESI: 0.75% employee + 3.25% employer on gross (if wages ≤₹21,000). Late deposit: damages + interest. File ECR (Electronic Challan cum Return) on UAN portal.',
      null
    ));
  }

  // Advance tax quarters
  const advanceTax = [
    { m: 6,  d: 15, pct: '15%',  q: 'Q1' },
    { m: 9,  d: 15, pct: '45%',  q: 'Q2' },
    { m: 12, d: 15, pct: '75%',  q: 'Q3' },
    { m: 3,  d: 15, pct: '100%', q: 'Q4' },
  ];
  for (const t of advanceTax) {
    if (month === t.m && dayOfMonth >= 10 && dayOfMonth <= t.d) {
      findings.push(finding('Compliance', 'medium',
        `Advance tax ${t.q} due by ${t.m}/${t.d} — ${t.pct} of estimated tax`,
        `Pay via challan ITNS 280. Shortfall attracts interest u/s 234C @1%/month. Estimate based on projected annual profit. If previous year tax >₹10,000, advance tax is mandatory.`,
        null
      ));
    }
  }

  // GSTR-9 annual return (Dec 31 deadline for previous FY)
  if (month === 12 && dayOfMonth >= 15) {
    findings.push(finding('Compliance', 'high',
      'GSTR-9 annual return due December 31',
      'Consolidated annual GST return for previous financial year. Late fee: ₹200/day (₹100 CGST + ₹100 SGST). Reconcile GSTR-1, 3B and books before filing.',
      null
    ));
  }

  // Income Tax return for business (October 31 for tax audit cases, July 31 otherwise)
  if (month === 7 && dayOfMonth >= 20) {
    findings.push(finding('Compliance', 'medium',
      'ITR filing deadline: July 31 (non-audit) / October 31 (audit)',
      'If turnover >₹1 crore (goods) or >₹50 lakh (services), tax audit u/s 44AB required. Audit report must be filed before ITR. Late filing: ₹5,000 penalty u/s 234F.',
      null
    ));
  }
  if (month === 10 && dayOfMonth >= 20) {
    findings.push(finding('Compliance', 'high',
      'Tax audit ITR filing deadline: October 31',
      'If books are subject to tax audit (turnover >threshold), ITR must be filed by Oct 31. Late filing: belated return, ₹5,000 penalty, no carry-forward of business losses.',
      null
    ));
  }

  // Overdue compliance items in DB
  const { data: items } = await supabase
    .from('compliance_items')
    .select('id,name,due_date,status,category')
    .lt('due_date', today.toISOString().slice(0, 10))
    .neq('status', 'completed')
    .limit(10);

  if (items && items.length > 0) {
    findings.push(finding('Compliance', 'critical',
      `${items.length} overdue compliance items in system`,
      `Items: ${items.slice(0, 3).map(i => `${i.name} (due ${i.due_date})`).join('; ')}. Overdue compliance attracts penalties and notices from regulators.`,
      null
    ));
  }

  // FSSAI / trade licence / Shops Act — annual renewal reminder in April
  if (month === 4 && dayOfMonth <= 15) {
    findings.push(finding('Compliance', 'medium',
      'Annual licence renewal reminder: FSSAI, Trade Licence, Shops & Establishment Act',
      'New financial year started April 1. Check renewal dates for FSSAI food safety licence, local trade licence, Tamil Nadu Shops and Establishment registration, and factory licence if applicable.',
      null
    ));
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLAUDE AI ANALYSIS
// ─────────────────────────────────────────────────────────────────────────────

async function analyzeWithClaude(allFindings, dashboardData) {
  if (!anthropic) return 'Claude analysis skipped — ANTHROPIC_API_KEY not set.';
  try {
    const findingsSummary = allFindings.map(f =>
      `[${f.severity.toUpperCase()}] ${f.category}: ${f.title}\n  → ${f.detail}${f.amount ? ` (₹${f.amount.toLocaleString('en-IN')})` : ''}`
    ).join('\n');

    const msg = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `You are a senior Chartered Accountant (FCA) reviewing the financial health and tax compliance of Sathvam Natural Products — a cold-pressed oil manufacturing company registered in Karur, Tamil Nadu, India. The company is GST-registered, subject to TDS provisions, employs staff under EPF/ESI, and operates under Indian tax law.

Financial snapshot (today):
- Cash Balance: ₹${(dashboardData.cash_balance || 0).toLocaleString('en-IN')}
- AR Outstanding: ₹${(dashboardData.ar_total || 0).toLocaleString('en-IN')}
- AP Overdue: ₹${(dashboardData.ap_overdue || 0).toLocaleString('en-IN')}
- Revenue (last 30 days): ₹${(dashboardData.revenue_30d || 0).toLocaleString('en-IN')}

Automated findings (${allFindings.length} total):
${findingsSummary || 'No issues found — books appear clean.'}

As the CA, provide your professional opinion in plain text (no markdown, no bullet symbols):

1. FINANCIAL HEALTH (2 sentences): Overall posture, cash adequacy, P&L trajectory
2. TAX RISK (2 sentences): Most serious compliance exposure today — cite specific sections
3. IMMEDIATE ACTIONS (top 3, numbered): What management must do TODAY to avoid penalty/interest
4. ONE QUESTION: The single most important question you would ask the owner to clarify the books

Be direct. Use Indian CA language. Cite specific IT/GST sections where relevant.`,
      }],
    });
    return msg.content[0]?.text || 'No response from Claude.';
  } catch (e) {
    return `CA analysis unavailable: ${e.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP ALERT
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const runId = new Date().toISOString().replace(/\.\d{3}Z$/, '');
  console.log(`\n[${runId}] Sathvam CA Agent starting...`);

  // Dashboard context
  let dashboardData = {};
  try {
    const today = new Date().toISOString().slice(0, 10);
    const ago30 = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
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
      revenue_30d:  (sales30.data || []).reduce((s, x) => s + (x.final_amount || 0), 0) +
                    (ws30.data   || []).reduce((s, x) => s + (x.total || 0), 0),
    };
  } catch (e) {
    console.error('Dashboard fetch failed:', e.message);
  }

  // Run all checks in parallel
  console.log('Running financial checks...');
  const results = await Promise.all([
    checkAR().catch(e         => { console.error('AR check failed:', e.message); return []; }),
    checkAP().catch(e         => { console.error('AP check failed:', e.message); return []; }),
    checkBank().catch(e       => { console.error('Bank check failed:', e.message); return []; }),
    checkGST().catch(e        => { console.error('GST check failed:', e.message); return []; }),
    checkTDS().catch(e        => { console.error('TDS check failed:', e.message); return []; }),
    checkCashLimits().catch(e => { console.error('CashLimits check failed:', e.message); return []; }),
    checkSection43B().catch(e => { console.error('Sec43B check failed:', e.message); return []; }),
    checkBooksQuality().catch(e=>{ console.error('BooksQuality check failed:', e.message); return []; }),
    checkPayroll().catch(e    => { console.error('Payroll check failed:', e.message); return []; }),
    checkExpenses().catch(e   => { console.error('Expenses check failed:', e.message); return []; }),
    checkRevenue().catch(e    => { console.error('Revenue check failed:', e.message); return []; }),
    checkCompliance().catch(e => { console.error('Compliance check failed:', e.message); return []; }),
  ]);

  const allFindings = results.flat();

  const nCrit = allFindings.filter(f => f.severity === 'critical').length;
  const nHigh = allFindings.filter(f => f.severity === 'high').length;
  console.log(`Found ${allFindings.length} issues (${nCrit} critical, ${nHigh} high)`);

  // Claude analysis
  console.log('Requesting CA analysis from Claude...');
  const aiAnalysis = await analyzeWithClaude(allFindings, dashboardData);

  // Save to DB
  if (allFindings.length > 0) {
    const rows = allFindings.map(f => ({ ...f, run_id: runId, ai_analysis: null }));
    rows[0].ai_analysis = aiAnalysis;
    const { error } = await supabase.from('ca_agent_findings').insert(rows);
    if (error) console.error('DB insert failed:', error.message);
    else console.log(`Saved ${rows.length} findings to DB`);
  } else {
    await supabase.from('ca_agent_findings').insert([{
      run_id: runId, category: 'General', severity: 'info',
      title: 'All clear — no issues found',
      detail: 'Automated CA review found no financial anomalies or compliance risks today.',
      ai_analysis: aiAnalysis,
    }]);
  }

  // WhatsApp alert for critical/high
  const urgent = allFindings.filter(f => f.severity === 'critical' || f.severity === 'high');
  if (urgent.length > 0 && ADMIN_PHONE) {
    const dateStr = new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
    const lines   = urgent.slice(0, 5).map(f => `[${f.severity.toUpperCase()}] ${f.title}`).join('\n');
    const snippet = aiAnalysis.startsWith('CA analysis unavailable') ? '' : '\n\n' + aiAnalysis.slice(0, 250) + '...';
    const msg = `Sathvam CA Agent — ${dateStr}\n\n${urgent.length} urgent issues:\n${lines}${snippet}\n\nCheck Finance -> CA Agent tab.`;
    await sendWhatsApp(ADMIN_PHONE, msg);
  }

  console.log(`\n[${new Date().toISOString()}] CA Agent complete.\n`);
  console.log('--- CA Analysis ---\n' + aiAnalysis + '\n--- END ---\n');
}

main().catch(e => {
  console.error('CA Agent fatal error:', e);
  process.exit(1);
});
