#!/usr/bin/env node
/**
 * Payment Schedule Alert — daily WhatsApp report
 * Shows upcoming vendor payments, expected income, and projected balance.
 * Alerts if balance will go negative after scheduled payments.
 *
 * Timer: sathvam-payment-schedule.timer — daily 8 AM IST (02:30 UTC)
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const supabase = require('../config/supabase');
const { sendText: gaSendText, isAutomationDisabled } = require('../lib/greenapi');

const ADMIN_PHONES = [process.env.WA_ADMIN_PHONE1, process.env.WA_ADMIN_PHONE2].filter(Boolean);
const round2 = n => Math.round((parseFloat(n) || 0) * 100) / 100;
const fmt = n => '₹' + Math.round(n).toLocaleString('en-IN');

async function main() {
  if (await isAutomationDisabled('payment_schedule_alert')) {
    console.log('Payment schedule alert disabled via toggle');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const in7d = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const in14d = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);

  // 1. Current bank balance
  const { data: accounts } = await supabase
    .from('bank_accounts').select('name,current_balance').eq('is_active', true);
  const totalBalance = (accounts || []).reduce((s, a) => s + (parseFloat(a.current_balance) || 0), 0);

  // 2. Unpaid vendor bills due in next 14 days
  const { data: dueBills } = await supabase
    .from('vendor_bills')
    .select('id,vendor_name,bill_no,amount,gst_amount,paid_amount,due_date,status')
    .neq('status', 'paid')
    .lte('due_date', in14d)
    .order('due_date', { ascending: true })
    .limit(50);

  // 3. Unpaid procurements (payment_status != 'paid')
  const { data: unpaidProcs } = await supabase
    .from('procurements')
    .select('id,supplier,commodity_name,ordered_qty,ordered_price_per_kg,gst,logistics_cost,date,payment_status,purchase_order_id')
    .in('status', ['stocked', 'cleaned', 'received'])
    .not('payment_status', 'eq', 'paid')
    .order('date', { ascending: true })
    .limit(200);

  // Group unpaid procurements by vendor
  const unpaidByVendor = {};
  (unpaidProcs || []).forEach(p => {
    const vendor = p.supplier || 'Unknown';
    if (!unpaidByVendor[vendor]) unpaidByVendor[vendor] = { total: 0, count: 0, oldest: p.date };
    const qty = parseFloat(p.ordered_qty) || 0;
    const rate = parseFloat(p.ordered_price_per_kg) || 0;
    const gst = parseFloat(p.gst) || 0;
    const logistics = parseFloat(p.logistics_cost) || 0;
    const amt = qty * rate + gst + logistics;
    unpaidByVendor[vendor].total += amt;
    unpaidByVendor[vendor].count++;
    if (p.date < unpaidByVendor[vendor].oldest) unpaidByVendor[vendor].oldest = p.date;
  });

  // 4. Expected income — pending webstore orders (paid but not delivered)
  const { data: pendingOrders } = await supabase
    .from('webstore_orders')
    .select('total,status,payment_status')
    .in('status', ['new', 'confirmed', 'packed', 'shipped'])
    .eq('payment_status', 'paid')
    .limit(500);
  const pendingOrderValue = (pendingOrders || []).reduce((s, o) => s + (parseFloat(o.total) || 0), 0);

  // 5. Pending B2B payments expected
  const { data: b2bPending } = await supabase
    .from('b2b_orders')
    .select('order_no,customer_name,total_value,stage')
    .not('stage', 'in', '("cancelled","invoice_paid")');
  const b2bPendingValue = (b2bPending || []).reduce((s, o) => s + (parseFloat(o.total_value) || 0), 0);

  // 6. Recurring monthly costs (salaries, insurance, software)
  // Estimate from last month's bank data
  const lastMonth = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const { data: lastMonthDebits } = await supabase
    .from('bank_transactions')
    .select('amount,category')
    .eq('type', 'debit')
    .gte('date', lastMonth)
    .in('category', ['Salary', 'Insurance', 'Software', 'Utilities']);
  const recurringMonthly = (lastMonthDebits || []).reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);

  // 7. Recent large debits (last 7 days) for context
  const ago7d = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const { data: recentLarge } = await supabase
    .from('bank_transactions')
    .select('amount,description,date,category')
    .eq('type', 'debit')
    .gte('date', ago7d)
    .gt('amount', 10000)
    .order('amount', { ascending: false })
    .limit(10);

  // === BUILD ALERT MESSAGE ===
  const lines = [];
  lines.push('💰 *Daily Cash Flow Alert*');
  lines.push(`📅 ${today}\n`);

  // Balance
  const balanceEmoji = totalBalance < 50000 ? '🔴' : totalBalance < 200000 ? '🟡' : '🟢';
  lines.push(`${balanceEmoji} *Bank Balance: ${fmt(totalBalance)}*`);
  (accounts || []).forEach(a => {
    lines.push(`  ${a.name}: ${fmt(a.current_balance)}`);
  });

  // Upcoming vendor bills
  const billsDue7d = (dueBills || []).filter(b => b.due_date <= in7d);
  const billsDue14d = (dueBills || []).filter(b => b.due_date > in7d);
  const totalDue7d = billsDue7d.reduce((s, b) => s + (parseFloat(b.amount) || 0) + (parseFloat(b.gst_amount) || 0) - (parseFloat(b.paid_amount) || 0), 0);
  const totalDue14d = billsDue14d.reduce((s, b) => s + (parseFloat(b.amount) || 0) + (parseFloat(b.gst_amount) || 0) - (parseFloat(b.paid_amount) || 0), 0);

  if (billsDue7d.length > 0) {
    lines.push(`\n📋 *Bills Due This Week: ${fmt(totalDue7d)}*`);
    billsDue7d.slice(0, 5).forEach(b => {
      const due = round2((parseFloat(b.amount) || 0) + (parseFloat(b.gst_amount) || 0) - (parseFloat(b.paid_amount) || 0));
      lines.push(`  • ${b.vendor_name}: ${fmt(due)} (due ${b.due_date})`);
    });
  }
  if (billsDue14d.length > 0) {
    lines.push(`\n📋 *Bills Due Next Week: ${fmt(totalDue14d)}*`);
    billsDue14d.slice(0, 3).forEach(b => {
      const due = round2((parseFloat(b.amount) || 0) + (parseFloat(b.gst_amount) || 0) - (parseFloat(b.paid_amount) || 0));
      lines.push(`  • ${b.vendor_name}: ${fmt(due)} (due ${b.due_date})`);
    });
  }

  // Unpaid procurements
  const unpaidVendors = Object.entries(unpaidByVendor).sort((a, b) => b[1].total - a[1].total);
  const totalUnpaidProc = unpaidVendors.reduce((s, [, v]) => s + v.total, 0);
  if (totalUnpaidProc > 0) {
    lines.push(`\n⚠️ *Unpaid Procurement: ${fmt(totalUnpaidProc)}*`);
    unpaidVendors.slice(0, 5).forEach(([vendor, d]) => {
      const ageDays = Math.floor((Date.now() - new Date(d.oldest).getTime()) / 864e5);
      lines.push(`  • ${vendor}: ${fmt(d.total)} (${d.count} POs, ${ageDays}d old)`);
    });
  }

  // Projected balance
  const totalUpcomingOut = totalDue7d + totalDue14d + recurringMonthly;
  const projected = totalBalance - totalUpcomingOut;
  lines.push(`\n🔮 *14-Day Projection*`);
  lines.push(`  Current: ${fmt(totalBalance)}`);
  lines.push(`  − Bills due: ${fmt(totalDue7d + totalDue14d)}`);
  lines.push(`  − Recurring (salary/sw/ins): ~${fmt(recurringMonthly)}`);
  lines.push(`  = *Projected: ${fmt(projected)}*`);

  if (projected < 0) {
    lines.push(`\n🚨 *CASH SHORTAGE ALERT*`);
    lines.push(`Balance will go NEGATIVE by ${fmt(Math.abs(projected))}`);
    lines.push(`Action needed: defer vendor payments or arrange funds`);
  } else if (projected < 50000) {
    lines.push(`\n⚠️ *LOW CASH WARNING*`);
    lines.push(`Projected balance dangerously low. Defer non-urgent payments.`);
  }

  // Expected income
  if (b2bPendingValue > 0 || pendingOrderValue > 0) {
    lines.push(`\n📥 *Expected Income*`);
    if (b2bPendingValue > 0) lines.push(`  B2B pending: ${fmt(b2bPendingValue)}`);
    if (pendingOrderValue > 0) lines.push(`  Webstore (paid, not delivered): ${fmt(pendingOrderValue)}`);
  }

  // Recent large debits
  if (recentLarge?.length) {
    lines.push(`\n📤 *Large Outflows (7 days)*`);
    recentLarge.slice(0, 5).forEach(t => {
      lines.push(`  • ${fmt(t.amount)} ${t.date} — ${(t.description || t.category || '').slice(0, 35)}`);
    });
  }

  const message = lines.join('\n');
  console.log(message);

  // Send WhatsApp
  for (const phone of ADMIN_PHONES) {
    try {
      await gaSendText(phone, message, { priority: true });
      console.log('\nWhatsApp sent to', phone);
    } catch (e) {
      console.error('WA send failed:', e.message);
    }
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
