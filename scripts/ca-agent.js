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
 *   Expenses    — large single expenses, month-over-month spike, commodity cost anomalies
 *   Revenue     — revenue drop, zero-sales weekdays, revenue leakage, B2B order profitability
 *   Compliance  — TDS/PF/ESI/GST deadlines, advance tax, e-invoice threshold, overdue items
 *   DoubleEntry — paid sales without matching bank credits
 *   Inventory   — stock ledger vs finished goods divergence
 *   CashFlow    — 30/60/90 day cash flow projection
 *   AP (extra)  — unpaid procurements without linked vendor bills
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const supabase  = require('../config/supabase');
const Anthropic        = require('@anthropic-ai/sdk');
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

  // Sales >₹10K — check large sales via bank_transactions credit entries as proxy for GST tracking
  // (sales table does not have a gst_amount column)
  const { data: largeSales } = await supabase
    .from('sales')
    .select('id,order_no,final_amount,date,status,payment_method')
    .gte('date', ago30)
    .gt('final_amount', 10000)
    .in('status', ['delivered','dispatched'])
    .limit(20);

  if (largeSales && largeSales.length > 0) {
    const total = largeSales.reduce((s, x) => s + (x.final_amount || 0), 0);
    findings.push(finding('GST', 'info',
      `${largeSales.length} sales >₹10K in last 30 days — verify GST invoicing`,
      `Total: ₹${round2(total).toLocaleString('en-IN')}. Ensure GST invoices issued for all B2B/B2C sales above ₹200 (CBIC notification). Missing output GST = demand + 100% penalty.`,
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
    .select('id,category,amount,vendor_name,date')
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
    supabase.from('sales').select('final_amount').in('status', ['delivered','dispatched']).gte('date', ago365),
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
    .select('supplier,ordered_qty,ordered_price_per_kg,date')
    .gte('date', fyStart)
    .limit(1000);

  if (procurements && procurements.length > 0) {
    const byVendor = {};
    for (const p of procurements) {
      const amt = round2((parseFloat(p.ordered_qty)||0)*(parseFloat(p.ordered_price_per_kg)||0));
      byVendor[p.supplier] = (byVendor[p.supplier] || 0) + amt;
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

  // Check sales paid in cash (payment_method = 'cash')
  const { data: cashSales } = await supabase
    .from('sales')
    .select('id,order_no,customer_name,final_amount,date,payment_method')
    .gte('date', since30)
    .eq('payment_method', 'cash')
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
    .select('id,date,vendor_name,amount,category,description,payment_mode')
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
      const key = `${e.date}__${e.vendor_name || 'Unknown'}`;
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
    .select('id,date,vendor_name,amount,category,payment_mode')
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
    .select('id,date,category,amount,vendor_name,description')
    .gte('date', since30)
    .gt('amount', 5000)
    .is('deleted_at', null)
    .limit(500);

  if (allExpenses) {
    const roundEntries = allExpenses.filter(e => ROUND_AMOUNTS.includes(parseFloat(e.amount)));
    if (roundEntries.length >= 5) {
      findings.push(finding('BooksQuality', 'medium',
        `${roundEntries.length} expenses with suspiciously round amounts in last 30 days`,
        `Examples: ${roundEntries.slice(0, 3).map(e => `₹${e.amount} (${e.category}, ${e.vendor_name || 'no vendor'})`).join('; ')}. Round-number entries suggest estimates or fabricated expenses. Auditors flag these — ensure all have supporting invoices/receipts.`,
        null
      ));
    }

    // Large expenses without vendor name
    const noVendor = allExpenses.filter(e => !e.vendor_name && parseFloat(e.amount) > 10000);
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
      const key = `${e.date}__${e.vendor_name}__${e.amount}`;
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

  // Payroll not processed after 25th — check via employees count as proxy
  if (dayOfMonth >= 25) {
    const { data: empCount } = await supabase.from('employees').select('id').eq('status','active').limit(1);
    if (empCount && empCount.length > 0) {
      findings.push(finding('Payroll', 'high',
        `Verify payroll for ${currentMonth} processed before month-end`,
        `${dayOfMonth}th of month. Ensure salaries are processed and disbursed to avoid Sec 43B disallowance. For a Private Limited Company, timely salary payment is also mandatory under Companies Act 2013.`,
        null
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
    findings.push(finding('Payroll', 'critical',
      'Statutory Bonus (Bonus Act) — verify payment before November 30',
      'Minimum bonus = 8.33% of annual salary (subject to ₹7,000/month basis cap). Must be paid within 8 months of FY end (March 31). Criminal liability for non-payment under Section 28 of Bonus Act.',
      null
    ));
  }

  return findings;
}

async function checkExpenses() {
  const findings = [];
  const today    = new Date();
  const since7d  = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  const { data: expenses } = await supabase
    .from('company_expenses')
    .select('id,date,category,amount,description,vendor_name')
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
          `Date: ${e.date}. Vendor: ${e.vendor_name || '—'}. Verify authorisation and that invoice/receipt is on file.`,
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
    supabase.from('sales').select('final_amount').in('status',['delivered','dispatched']).gte('date', thisMonthStart),
    supabase.from('webstore_orders').select('total').in('status', ['confirmed', 'packed', 'shipped', 'delivered']).gte('date', thisMonthStart),
    supabase.from('sales').select('final_amount').in('status',['delivered','dispatched']).gte('date', lastMonthStart).lte('date', lastMonthEnd),
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
    .from('sales').select('date,final_amount').gte('date', since7d).in('status',['delivered','dispatched']);

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

  // ── Private Limited Company (Companies Act 2013) ──────────────────────────
  // AGM — must be held within 6 months of FY end (September 30)
  if (month === 9 && dayOfMonth >= 15) {
    findings.push(finding('Compliance', month >= 9 && dayOfMonth >= 25 ? 'critical' : 'high',
      'AGM (Annual General Meeting) due by September 30 — Companies Act Sec 96',
      'Private Ltd must hold AGM within 6 months of FY end (March 31), i.e., by September 30. Penalty for non-compliance: ₹1 lakh on company + ₹1 lakh on every officer in default. At AGM: approve audited accounts, declare dividend, appoint/reappoint auditors.',
      null
    ));
  }

  // ROC annual filings post-AGM
  if (month === 10) {
    findings.push(finding('Compliance', 'high',
      'AOC-4 (Financial Statements) due within 30 days of AGM — MCA21',
      'File audited Balance Sheet and P&L with ROC via MCA21 portal. Form AOC-4 (or AOC-4 XBRL for larger companies). Penalty for late filing: ₹100/day, no upper limit.',
      null
    ));
    findings.push(finding('Compliance', 'high',
      'MGT-7A (Annual Return) due within 60 days of AGM — MCA21',
      'Annual Return for Private Limited Company (small company form MGT-7A). Contains details of shareholders, directors, shares. Late filing: ₹100/day penalty.',
      null
    ));
  }

  // Director KYC — September 30 every year
  if (month === 9 && dayOfMonth >= 1 && dayOfMonth <= 30) {
    findings.push(finding('Compliance', 'medium',
      'DIR-3 KYC (Director KYC) — due September 30',
      'Every director with DIN must file DIR-3 KYC (or web-based DIR-3 KYC) by September 30 each year. Failure deactivates DIN — director cannot sign documents or file returns until KYC filed with ₹5,000 penalty.',
      null
    ));
  }

  // Board meetings — min 4 per year, gap ≤120 days
  if (month % 3 === 0 && dayOfMonth >= 25) { // end of each quarter
    findings.push(finding('Compliance', 'info',
      'Quarterly reminder: Board Meeting required (Companies Act Sec 173)',
      'Private Ltd must hold minimum 4 board meetings per year with no gap exceeding 120 days. Record proper minutes and resolutions. Non-compliance: ₹25,000 per officer in default.',
      null
    ));
  }

  // Statutory Auditor — must be appointed at AGM, for max 5 consecutive years
  if (month === 4 && dayOfMonth <= 30) {
    findings.push(finding('Compliance', 'info',
      'Verify Statutory Auditor appointment (Companies Act Sec 139)',
      'Confirm auditor is appointed for FY 2025-26 at AGM or board meeting. Auditor\'s term: 5 consecutive years max for a firm. ROC Form ADT-1 must be filed within 15 days of appointment.',
      null
    ));
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: DOUBLE ENTRY RECONCILIATION — sales vs bank credits
// ─────────────────────────────────────────────────────────────────────────────

async function checkDoubleEntry() {
  const findings = [];
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const { data: paidSales } = await supabase
    .from('sales')
    .select('id,order_no,final_amount,date,customer_name')
    .eq('status', 'paid')
    .gte('date', since30)
    .limit(200);

  if (!paidSales || paidSales.length === 0) return findings;

  const { data: bankCredits } = await supabase
    .from('bank_transactions')
    .select('id,date,amount,description')
    .eq('type', 'credit')
    .gte('date', since30)
    .limit(500);

  const credits = bankCredits || [];

  const unmatched = [];
  for (const sale of paidSales) {
    const saleAmt = parseFloat(sale.final_amount || 0);
    const saleDate = new Date(sale.date);
    const hasMatch = credits.some(c => {
      const creditAmt = parseFloat(c.amount || 0);
      const creditDate = new Date(c.date);
      const amtMatch = Math.abs(creditAmt - saleAmt) / saleAmt <= 0.05;
      const daysDiff = Math.abs(creditDate - saleDate) / 86400000;
      return amtMatch && daysDiff <= 7;
    });
    if (!hasMatch) unmatched.push(sale);
  }

  if (unmatched.length > 0) {
    const total = unmatched.reduce((s, x) => s + parseFloat(x.final_amount || 0), 0);
    findings.push(finding('DoubleEntry', 'high',
      `${unmatched.length} paid sales with no corresponding bank credit in last 30 days`,
      `Total: ₹${round2(total).toLocaleString('en-IN')}. Orders: ${unmatched.slice(0, 3).map(s => s.order_no || s.id).join(', ')}. These sales are marked "paid" but no matching bank deposit found (±5% amount, ±7 days). Verify payment receipts and reconcile.`,
      round2(total)
    ));
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: INVENTORY VALUATION — stock_ledger vs finished_goods divergence
// ─────────────────────────────────────────────────────────────────────────────

async function checkInventoryValuation() {
  const findings = [];

  const [ledgerRes, fgRes] = await Promise.all([
    supabase.from('stock_ledger').select('product_id,product_name,type,qty').limit(2000),
    supabase.from('finished_goods').select('product_id,product_name,type,qty').limit(2000),
  ]);

  const ledgerData = ledgerRes.data || [];
  const fgData = fgRes.data || [];

  // Aggregate stock_ledger by product_id
  const ledgerNet = {};
  for (const r of ledgerData) {
    if (!r.product_id) continue;
    if (!ledgerNet[r.product_id]) ledgerNet[r.product_id] = { name: r.product_name, qty: 0 };
    const q = parseFloat(r.qty || 0);
    ledgerNet[r.product_id].qty += (r.type === 'IN' ? q : -q);
  }

  // Aggregate finished_goods by product_id
  const fgNet = {};
  for (const r of fgData) {
    if (!r.product_id) continue;
    if (!fgNet[r.product_id]) fgNet[r.product_id] = { name: r.product_name, qty: 0 };
    const q = parseFloat(r.qty || 0);
    fgNet[r.product_id].qty += (r.type === 'IN' ? q : -q);
  }

  const divergent = [];
  for (const pid of Object.keys(ledgerNet)) {
    const lQty = ledgerNet[pid].qty;
    const fQty = (fgNet[pid] || { qty: 0 }).qty;
    if (lQty === 0 && fQty === 0) continue;
    const base = Math.max(Math.abs(lQty), Math.abs(fQty));
    if (base > 0 && Math.abs(lQty - fQty) / base > 0.10) {
      divergent.push({ name: ledgerNet[pid].name || pid, ledger: round2(lQty), fg: round2(fQty) });
    }
  }

  if (divergent.length > 0) {
    findings.push(finding('Inventory', 'high',
      `${divergent.length} products with >10% stock divergence between ledger and finished goods`,
      `Examples: ${divergent.slice(0, 3).map(d => `${d.name}: ledger=${d.ledger}, FG=${d.fg}`).join('; ')}. Stock ledger and finished goods records must agree. Investigate missing IN/OUT entries, unrecorded sales, or data entry errors.`,
      null
    ));
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: PROCUREMENT PAYMENT MATCH — unpaid procurements without vendor bills
// ─────────────────────────────────────────────────────────────────────────────

async function checkProcurementPaymentMatch() {
  const findings = [];
  const ago30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const { data: unpaidProc } = await supabase
    .from('procurements')
    .select('id,date,supplier,commodity_name,ordered_qty,ordered_price_per_kg,payment_status')
    .neq('payment_status', 'paid')
    .lt('date', ago30)
    .limit(200);

  if (!unpaidProc || unpaidProc.length === 0) return findings;

  const { data: vendorBills } = await supabase
    .from('vendor_bills')
    .select('id,vendor_name,amount,bill_date,payable_id')
    .is('deleted_at', null)
    .limit(500);

  const billPayableIds = new Set((vendorBills || []).map(b => b.payable_id).filter(Boolean));
  const billVendors = new Set((vendorBills || []).map(b => (b.vendor_name || '').toLowerCase()));

  const unlinked = unpaidProc.filter(p => {
    if (billPayableIds.has(p.id)) return false;
    // Also check by vendor name match as fallback
    if (billVendors.has((p.supplier || '').toLowerCase())) return false;
    return true;
  });

  if (unlinked.length > 0) {
    const total = unlinked.reduce((s, p) => s + round2((parseFloat(p.ordered_qty)||0) * (parseFloat(p.ordered_price_per_kg)||0)), 0);
    findings.push(finding('AP', 'medium',
      `${unlinked.length} unpaid procurements >30 days old with no linked vendor bill`,
      `Total estimated: ₹${round2(total).toLocaleString('en-IN')}. Suppliers: ${[...new Set(unlinked.map(p => p.supplier))].slice(0, 3).join(', ')}. Create vendor bills for these procurements to maintain proper AP tracking and ensure payments are scheduled.`,
      round2(total)
    ));
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: REVENUE LEAKAGE — delivered orders without payment
// ─────────────────────────────────────────────────────────────────────────────

async function checkRevenueLeakage() {
  const findings = [];
  const today = new Date();
  const ago15 = new Date(Date.now() - 15 * 86400000).toISOString().slice(0, 10);

  // B2B orders delivered >15 days but not paid
  const { data: b2bDelivered } = await supabase
    .from('b2b_orders')
    .select('id,order_no,customer_name,total_value,created_at,stage')
    .eq('stage', 'delivered')
    .lt('created_at', ago15)
    .limit(100);

  if (b2bDelivered && b2bDelivered.length > 0) {
    const total = b2bDelivered.reduce((s, o) => s + parseFloat(o.total_value || 0), 0);
    const oldest = Math.max(...b2bDelivered.map(o => Math.floor((today - new Date(o.created_at)) / 86400000)));
    findings.push(finding('Revenue', 'high',
      `${b2bDelivered.length} B2B orders delivered >15 days without payment recorded`,
      `Total: ₹${round2(total).toLocaleString('en-IN')}. Oldest: ${oldest} days. Customers: ${[...new Set(b2bDelivered.map(o => o.customer_name))].slice(0, 3).join(', ')}. Revenue leakage risk — follow up on collections immediately.`,
      round2(total)
    ));
  }

  // Webstore orders delivered but payment not paid
  const { data: wsUnpaid } = await supabase
    .from('webstore_orders')
    .select('id,order_no,total,date,status,payment_status')
    .eq('status', 'delivered')
    .neq('payment_status', 'paid')
    .lt('date', ago15)
    .limit(50);

  if (wsUnpaid && wsUnpaid.length > 0) {
    const total = wsUnpaid.reduce((s, o) => s + parseFloat(o.total || 0), 0);
    findings.push(finding('Revenue', 'high',
      `${wsUnpaid.length} webstore orders delivered but payment not marked as paid`,
      `Total: ₹${round2(total).toLocaleString('en-IN')}. These may be COD orders not collected or payment recording missed. Verify and update payment status.`,
      round2(total)
    ));
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: COST ANOMALIES — commodity price spikes vs 3-month average
// ─────────────────────────────────────────────────────────────────────────────

async function checkCostAnomalies() {
  const findings = [];
  const ago30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const ago90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

  const { data: recent } = await supabase
    .from('procurements')
    .select('commodity_name,ordered_qty,ordered_price_per_kg,date')
    .gte('date', ago30)
    .limit(500);

  const { data: historical } = await supabase
    .from('procurements')
    .select('commodity_name,ordered_qty,ordered_price_per_kg,date')
    .gte('date', ago90)
    .lt('date', ago30)
    .limit(1000);

  if (!recent || recent.length === 0 || !historical || historical.length === 0) return findings;

  // 3-month avg by commodity (weighted by qty)
  const histAvg = {};
  for (const p of historical) {
    const qty = parseFloat(p.ordered_qty || 0);
    const rate = parseFloat(p.ordered_price_per_kg || 0);
    if (qty <= 0 || rate <= 0) continue;
    if (!histAvg[p.commodity_name]) histAvg[p.commodity_name] = { totalCost: 0, totalQty: 0 };
    histAvg[p.commodity_name].totalCost += qty * rate;
    histAvg[p.commodity_name].totalQty += qty;
  }

  // Current 30-day avg by commodity
  const currAvg = {};
  for (const p of recent) {
    const qty = parseFloat(p.ordered_qty || 0);
    const rate = parseFloat(p.ordered_price_per_kg || 0);
    if (qty <= 0 || rate <= 0) continue;
    if (!currAvg[p.commodity_name]) currAvg[p.commodity_name] = { totalCost: 0, totalQty: 0 };
    currAvg[p.commodity_name].totalCost += qty * rate;
    currAvg[p.commodity_name].totalQty += qty;
  }

  for (const [commodity, curr] of Object.entries(currAvg)) {
    const hist = histAvg[commodity];
    if (!hist || hist.totalQty === 0) continue;
    const currRate = curr.totalCost / curr.totalQty;
    const histRate = hist.totalCost / hist.totalQty;
    if (currRate > histRate * 1.20) {
      const pctUp = round2(((currRate - histRate) / histRate) * 100);
      findings.push(finding('Expenses', 'medium',
        `${commodity} procurement cost up ${pctUp}% vs 3-month average`,
        `Current avg: ₹${round2(currRate).toLocaleString('en-IN')}/kg vs 3-month avg: ₹${round2(histRate).toLocaleString('en-IN')}/kg. Investigate market conditions, negotiate better rates, or consider alternate suppliers.`,
        round2(curr.totalCost)
      ));
    }
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: CASH FLOW PROJECTION — 30/60/90 day runway
// ─────────────────────────────────────────────────────────────────────────────

async function checkCashFlowProjection() {
  const findings = [];
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const d30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const d60 = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const d90 = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);

  // Current cash
  const { data: accounts } = await supabase
    .from('bank_accounts')
    .select('current_balance')
    .eq('is_active', true);
  const cashBalance = (accounts || []).reduce((s, a) => s + parseFloat(a.current_balance || 0), 0);

  // Employee count for salary estimate
  const { data: employees } = await supabase
    .from('employees')
    .select('id,monthly_salary')
    .eq('status', 'active');
  const monthlySalary = (employees || []).reduce((s, e) => s + parseFloat(e.monthly_salary || 0), 0);

  // Recurring expenses estimate (last 3 months average)
  const ago90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const { data: recentExp } = await supabase
    .from('company_expenses')
    .select('amount')
    .gte('date', ago90)
    .is('deleted_at', null);
  const avgMonthlyExpenses = round2((recentExp || []).reduce((s, e) => s + parseFloat(e.amount || 0), 0) / 3);

  // Vendor bills due in 30/60/90 days
  const { data: upcomingBills } = await supabase
    .from('vendor_bills')
    .select('amount,gst_amount,paid_amount,due_date')
    .in('status', ['unpaid', 'partial', 'overdue'])
    .is('deleted_at', null)
    .lte('due_date', d90)
    .limit(300);

  const billsDue = { d30: 0, d60: 0, d90: 0 };
  for (const b of (upcomingBills || [])) {
    const outstanding = round2((parseFloat(b.amount||0) + parseFloat(b.gst_amount||0)) - parseFloat(b.paid_amount||0));
    if (b.due_date <= d30) billsDue.d30 += outstanding;
    else if (b.due_date <= d60) billsDue.d60 += outstanding;
    else billsDue.d90 += outstanding;
  }

  const proj30 = round2(cashBalance - monthlySalary - avgMonthlyExpenses - billsDue.d30);
  const proj60 = round2(proj30 - monthlySalary - avgMonthlyExpenses - billsDue.d60);
  const proj90 = round2(proj60 - monthlySalary - avgMonthlyExpenses - billsDue.d90);

  if (proj30 < 0) {
    findings.push(finding('CashFlow', 'critical',
      `30-day cash flow projection is NEGATIVE: ₹${round2(proj30).toLocaleString('en-IN')}`,
      `Current cash: ₹${round2(cashBalance).toLocaleString('en-IN')}. Outflows (30d): salary ₹${round2(monthlySalary).toLocaleString('en-IN')} + expenses ₹${round2(avgMonthlyExpenses).toLocaleString('en-IN')} + bills ₹${round2(billsDue.d30).toLocaleString('en-IN')}. Immediate action: accelerate AR collections, negotiate AP deferrals, or arrange credit facility.`,
      round2(Math.abs(proj30))
    ));
  } else if (proj60 < 0) {
    findings.push(finding('CashFlow', 'high',
      `60-day cash flow projection turns negative: ₹${round2(proj60).toLocaleString('en-IN')}`,
      `Current cash: ₹${round2(cashBalance).toLocaleString('en-IN')}. 30-day balance: ₹${round2(proj30).toLocaleString('en-IN')}. Plan ahead to cover shortfall — accelerate collections or defer non-critical expenses.`,
      round2(Math.abs(proj60))
    ));
  } else if (proj90 < 0) {
    findings.push(finding('CashFlow', 'medium',
      `90-day cash flow projection turns negative: ₹${round2(proj90).toLocaleString('en-IN')}`,
      `Current cash: ₹${round2(cashBalance).toLocaleString('en-IN')}. Monitor closely — consider building reserves or reducing discretionary spending.`,
      round2(Math.abs(proj90))
    ));
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: B2B ORDER PROFITABILITY — margin analysis on active orders
// ─────────────────────────────────────────────────────────────────────────────

async function checkB2BOrderProfitability() {
  const findings = [];

  const { data: activeOrders } = await supabase
    .from('b2b_orders')
    .select('id,order_no,customer_name,total_value,items,stage')
    .not('stage', 'in', '("cancelled","delivered","invoice_paid")')
    .limit(50);

  if (!activeOrders || activeOrders.length === 0) return findings;

  // Get project expenses
  const { data: projExpenses } = await supabase
    .from('project_expenses')
    .select('project_id,amount,category')
    .limit(500);

  // Get procurements linked to B2B orders
  const { data: b2bProcs } = await supabase
    .from('procurements')
    .select('b2b_order_id,ordered_qty,ordered_price_per_kg')
    .limit(500);

  const expByProject = {};
  for (const e of (projExpenses || [])) {
    if (!e.project_id) continue;
    expByProject[e.project_id] = (expByProject[e.project_id] || 0) + parseFloat(e.amount || 0);
  }

  const procByOrder = {};
  for (const p of (b2bProcs || [])) {
    if (!p.b2b_order_id) continue;
    const amt = round2((parseFloat(p.ordered_qty)||0) * (parseFloat(p.ordered_price_per_kg)||0));
    procByOrder[p.b2b_order_id] = (procByOrder[p.b2b_order_id] || 0) + amt;
  }

  for (const order of activeOrders) {
    const revenue = parseFloat(order.total_value || 0);
    if (revenue <= 0) continue;

    const expenses = (expByProject[order.id] || 0) + (procByOrder[order.id] || 0);
    if (expenses <= 0) continue; // No cost data to compare

    const margin = round2(((revenue - expenses) / revenue) * 100);

    if (margin < 0) {
      findings.push(finding('Revenue', 'critical',
        `B2B order ${order.order_no} has NEGATIVE margin: ${margin}%`,
        `Customer: ${order.customer_name}. Revenue: ₹${round2(revenue).toLocaleString('en-IN')}, Costs: ₹${round2(expenses).toLocaleString('en-IN')}. Loss: ₹${round2(expenses - revenue).toLocaleString('en-IN')}. Review pricing and cost structure immediately.`,
        round2(expenses - revenue)
      ));
    } else if (margin < 10) {
      findings.push(finding('Revenue', 'medium',
        `B2B order ${order.order_no} has thin margin: ${margin}%`,
        `Customer: ${order.customer_name}. Revenue: ₹${round2(revenue).toLocaleString('en-IN')}, Costs: ₹${round2(expenses).toLocaleString('en-IN')}. Profit: ₹${round2(revenue - expenses).toLocaleString('en-IN')}. Consider renegotiating pricing for future orders.`,
        round2(revenue - expenses)
      ));
    }
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: TAX COMPLIANCE GAPS — missing GST on large transactions
// ─────────────────────────────────────────────────────────────────────────────

async function checkTaxComplianceGaps() {
  const findings = [];
  const ago30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  // Vendor bills >₹10K with no GST — possible missed ITC
  const { data: noGstBills } = await supabase
    .from('vendor_bills')
    .select('id,vendor_name,amount,bill_date,category')
    .gt('amount', 10000)
    .is('deleted_at', null)
    .gte('bill_date', ago30)
    .limit(100);

  const zeroGstBills = (noGstBills || []).filter(b =>
    !b.gst_amount || parseFloat(b.gst_amount) === 0
  );

  if (zeroGstBills.length > 0) {
    const total = zeroGstBills.reduce((s, b) => s + parseFloat(b.amount || 0), 0);
    findings.push(finding('GST', 'medium',
      `${zeroGstBills.length} vendor bills >₹10K with zero GST recorded`,
      `Total: ₹${round2(total).toLocaleString('en-IN')}. Vendors: ${[...new Set(zeroGstBills.map(b => b.vendor_name))].slice(0, 3).join(', ')}. If these vendors are GST-registered, you may be missing ITC claims. Verify if GST was charged and update bill records.`,
      round2(total)
    ));
  }

  // Procurements >₹5K with no GST
  const { data: noGstProc } = await supabase
    .from('procurements')
    .select('id,supplier,commodity_name,ordered_qty,ordered_price_per_kg,gst,date')
    .gte('date', ago30)
    .limit(200);

  const zeroGstProc = (noGstProc || []).filter(p =>
    round2((parseFloat(p.ordered_qty)||0) * (parseFloat(p.ordered_price_per_kg)||0)) > 5000 &&
    (!p.gst || parseFloat(p.gst) === 0)
  );

  if (zeroGstProc.length > 0) {
    const total = zeroGstProc.reduce((s, p) => s + round2((parseFloat(p.ordered_qty)||0) * (parseFloat(p.ordered_price_per_kg)||0)), 0);
    findings.push(finding('GST', 'medium',
      `${zeroGstProc.length} procurements >₹5K with no GST recorded`,
      `Total: ₹${round2(total).toLocaleString('en-IN')}. Commodities: ${[...new Set(zeroGstProc.map(p => p.commodity_name))].slice(0, 3).join(', ')}. If from registered dealers, GST must be captured for ITC claims. If from farmers/unregistered, verify RCM applicability.`,
      round2(total)
    ));
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: SALARY-ATTENDANCE RECONCILIATION — payroll vs attendance vs expenses
// ─────────────────────────────────────────────────────────────────────────────

async function checkSalaryAttendanceReconciliation() {
  const findings = [];
  const today = new Date();
  const currentMonth = today.toISOString().slice(0, 7); // YYYY-MM
  const monthStart = `${currentMonth}-01`;
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().slice(0, 10);

  // Active employees with salary
  const { data: employees } = await supabase
    .from('employees')
    .select('id,name,monthly_salary')
    .eq('status', 'active');

  if (!employees || employees.length === 0) return findings;

  const expectedSalary = employees.reduce((s, e) => s + parseFloat(e.monthly_salary || 0), 0);

  // Attendance for current month
  const { data: attendance } = await supabase
    .from('attendance')
    .select('employee_id,status')
    .gte('date', monthStart)
    .lte('date', monthEnd);

  if (attendance && attendance.length > 0) {
    const presentByEmp = {};
    for (const a of attendance) {
      if (a.status === 'present') {
        presentByEmp[a.employee_id] = (presentByEmp[a.employee_id] || 0) + 1;
      } else if (a.status === 'half-day') {
        presentByEmp[a.employee_id] = (presentByEmp[a.employee_id] || 0) + 0.5;
      }
    }
    const workingDays = today.getDate(); // approximate
    const lowAttendance = employees.filter(e => {
      const present = presentByEmp[e.id] || 0;
      return workingDays > 5 && present < workingDays * 0.5;
    });
    if (lowAttendance.length > 0 && expectedSalary > 0) {
      findings.push(finding('Payroll', 'medium',
        `${lowAttendance.length} employees with <50% attendance this month — verify salary deductions`,
        `Employees: ${lowAttendance.slice(0, 3).map(e => e.name).join(', ')}. Ensure proportional salary deduction or leave deduction is applied. Full salary for low attendance inflates payroll costs.`,
        null
      ));
    }
  }

  // Salary expenses recorded this month
  const { data: salaryExpenses } = await supabase
    .from('company_expenses')
    .select('amount')
    .ilike('category', '%salary%')
    .gte('date', monthStart)
    .lte('date', monthEnd)
    .is('deleted_at', null);

  const actualSalaryExp = (salaryExpenses || []).reduce((s, e) => s + parseFloat(e.amount || 0), 0);

  if (actualSalaryExp > 0 && expectedSalary > 0) {
    const diff = Math.abs(actualSalaryExp - expectedSalary) / expectedSalary;
    if (diff > 0.05) {
      findings.push(finding('Payroll', 'medium',
        `Salary expense ₹${round2(actualSalaryExp).toLocaleString('en-IN')} diverges from expected ₹${round2(expectedSalary).toLocaleString('en-IN')} by ${round2(diff * 100)}%`,
        `Expected: employee salaries total ₹${round2(expectedSalary).toLocaleString('en-IN')}/month. Recorded salary expenses: ₹${round2(actualSalaryExp).toLocaleString('en-IN')}. Investigate — could be missing expense entries, underpayments, or bonus/arrears not categorized correctly.`,
        round2(Math.abs(actualSalaryExp - expectedSalary))
      ));
    }
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: DUPLICATE TRANSACTIONS — expenses and bank transactions
// ─────────────────────────────────────────────────────────────────────────────

async function checkDuplicateTransactions() {
  const findings = [];
  const since60 = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);

  // Duplicate company expenses
  const { data: expenses } = await supabase
    .from('company_expenses')
    .select('id,date,amount,vendor_name,description,category')
    .gte('date', since60)
    .is('deleted_at', null)
    .order('date', { ascending: false })
    .limit(500);

  if (expenses && expenses.length > 0) {
    const groups = {};
    for (const e of expenses) {
      const key = `${e.date}__${round2(e.amount)}__${(e.vendor_name || e.description || '').toLowerCase().slice(0, 30)}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(e);
    }
    const dupes = Object.values(groups).filter(g => g.length > 1);
    if (dupes.length > 0) {
      const total = dupes.reduce((s, g) => s + parseFloat(g[0].amount || 0) * (g.length - 1), 0);
      findings.push(finding('BooksQuality', 'high',
        `${dupes.length} possible duplicate expense entries in last 60 days`,
        `Potential overstatement: ₹${round2(total).toLocaleString('en-IN')}. Examples: ${dupes.slice(0, 2).map(g => `₹${g[0].amount} ${g[0].vendor_name || g[0].category} on ${g[0].date} (${g.length}x)`).join('; ')}. Verify and remove duplicates to avoid inflated expenses.`,
        round2(total)
      ));
    }
  }

  // Duplicate bank transactions
  const { data: bankTxns } = await supabase
    .from('bank_transactions')
    .select('id,date,amount,description,type')
    .gte('date', since60)
    .order('date', { ascending: false })
    .limit(500);

  if (bankTxns && bankTxns.length > 0) {
    const groups = {};
    for (const t of bankTxns) {
      const key = `${t.date}__${round2(t.amount)}__${t.type}__${(t.description || '').toLowerCase().slice(0, 30)}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    }
    const dupes = Object.values(groups).filter(g => g.length > 1);
    if (dupes.length > 0) {
      const total = dupes.reduce((s, g) => s + parseFloat(g[0].amount || 0) * (g.length - 1), 0);
      findings.push(finding('BooksQuality', 'high',
        `${dupes.length} possible duplicate bank transactions in last 60 days`,
        `Total duplicate amount: ₹${round2(total).toLocaleString('en-IN')}. Examples: ${dupes.slice(0, 2).map(g => `₹${g[0].amount} "${g[0].description || 'no desc'}" on ${g[0].date} (${g.length}x)`).join('; ')}. Verify with bank statement and remove duplicate entries.`,
        round2(total)
      ));
    }
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
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are a senior Chartered Accountant (FCA) reviewing the financial health and tax compliance of Sathvam Natural Products Private Limited — a cold-pressed oil manufacturing Private Limited Company registered in Karur, Tamil Nadu, India. The company is incorporated under Companies Act 2013, GST-registered, subject to TDS provisions, employs staff under EPF/ESI, and must comply with MCA ROC filings (AOC-4, MGT-7A, DIR-3 KYC, board meetings) as per Indian law.

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
// WHATSAPP ALERT (via Green API)
// ─────────────────────────────────────────────────────────────────────────────

const { sendText: gaSendText, isAutomationDisabled } = require('../lib/greenapi');

async function sendWhatsApp(phone, message) {
  try {
    await gaSendText(phone, message);
    console.log('WhatsApp alert sent to', phone);
  } catch (e) {
    console.error('WhatsApp send failed:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  // Check automation toggle
  if (await isAutomationDisabled('ca_agent_alert')) { console.log('CA Agent disabled via toggle'); return; }

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
      supabase.from('sales').select('final_amount').in('status',['delivered','dispatched']).gte('date', ago30),
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
    checkDoubleEntry().catch(e => { console.error('DoubleEntry check failed:', e.message); return []; }),
    checkInventoryValuation().catch(e => { console.error('InventoryValuation check failed:', e.message); return []; }),
    checkProcurementPaymentMatch().catch(e => { console.error('ProcurementPaymentMatch check failed:', e.message); return []; }),
    checkRevenueLeakage().catch(e => { console.error('RevenueLeakage check failed:', e.message); return []; }),
    checkCostAnomalies().catch(e => { console.error('CostAnomalies check failed:', e.message); return []; }),
    checkCashFlowProjection().catch(e => { console.error('CashFlowProjection check failed:', e.message); return []; }),
    checkB2BOrderProfitability().catch(e => { console.error('B2BOrderProfitability check failed:', e.message); return []; }),
    checkTaxComplianceGaps().catch(e => { console.error('TaxComplianceGaps check failed:', e.message); return []; }),
    checkSalaryAttendanceReconciliation().catch(e => { console.error('SalaryAttendance check failed:', e.message); return []; }),
    checkDuplicateTransactions().catch(e => { console.error('DuplicateTransactions check failed:', e.message); return []; }),
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

main().then(() => process.exit(0)).catch(e => {
  console.error('CA Agent fatal error:', e);
  process.exit(1);
});
