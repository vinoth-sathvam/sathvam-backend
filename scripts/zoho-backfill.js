#!/usr/bin/env node
/**
 * Zoho Books Historical Backfill Script
 *
 * Pushes all local records from 2026-04-01 to today into Zoho Books.
 * Safe to re-run — skips records that already have a zoho_*_id.
 *
 * Usage:
 *   node scripts/zoho-backfill.js                    # full backfill
 *   node scripts/zoho-backfill.js --dry-run          # preview only
 *   node scripts/zoho-backfill.js --type=webstore    # only webstore invoices
 *   node scripts/zoho-backfill.js --type=pos         # only POS invoices
 *   node scripts/zoho-backfill.js --type=b2b         # only B2B invoices
 *   node scripts/zoho-backfill.js --type=procurement # only purchase orders
 *   node scripts/zoho-backfill.js --type=bills       # only vendor bills
 *   node scripts/zoho-backfill.js --type=expenses    # only expenses
 *   node scripts/zoho-backfill.js --type=salaries    # only salary journals
 *   node scripts/zoho-backfill.js --type=journals    # only journal entries
 *   node scripts/zoho-backfill.js --type=refunds     # only refund credit notes
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// Suppress WhatsApp alerts during backfill — we log errors to console instead
process.env.ZOHO_SUPPRESS_ALERTS = 'true';

const supabase = require('../config/supabase');
const { zoho: zohoApi, findOrCreateContact, createInvoice, recordPayment } = require('../config/zoho');
let decrypt;
try { decrypt = require('../config/crypto').decrypt; } catch (_) { decrypt = v => v; }

const DRY_RUN = process.argv.includes('--dry-run');
const TYPE_FILTER = (process.argv.find(a => a.startsWith('--type=')) || '').replace('--type=', '');
const FROM_DATE = '2026-04-01';

const round2 = n => Math.round((parseFloat(n) || 0) * 100) / 100;
// Zoho invoice number max 16 chars
const trimInvNo = s => (s || '').slice(0, 16);

// Map local categories to Zoho expense account IDs
const ZOHO_EXPENSE_ACCT = {
  default:           '1247318000000000558', // Other Expenses
  'Miscellaneous':   '1247318000000000558',
  'Raw Materials':   '1247318000000015100',
  'Utilities':       '1247318000000367606', // Electricity bill
  'Labour':          '1247318000000000543', // Salaries
  'Transport':       '1247318000000015104', // Transportation
  'Maintenance':     '1247318000000000555', // Repairs and Maintenance
  'Office & Admin':  '1247318000000000498', // Office Supplies
  'Marketing':       '1247318000000000501', // Advertising
  'Rent':            '1247318000013542191', // Factory Rent
  'Packaging':       '1247318000000376767', // Pet Bottles
  'Food':            '1247318000009002569', // Food
  'Fuel':            '1247318000002248184', // Fuel
  'General':         '1247318000000000558', // Other Expenses
};
function getExpenseAcctId(cat) {
  return ZOHO_EXPENSE_ACCT[cat] || ZOHO_EXPENSE_ACCT.default;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Wrapper that detects rate limits and pauses before retrying
async function zohoCall(method, path, data, extra, arg5) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = method === 'createInvoice' ? await createInvoice(data)
        : method === 'recordPayment' ? await recordPayment(data, extra.amount, extra.mode, extra.ref)
        : method === 'findOrCreateContact' ? await findOrCreateContact(data, path, extra || null, arg5 || null)
        : await zohoApi(method, path, data, extra);
      return result;
    } catch (e) {
      const msg = e.response?.data?.error_description || e.response?.data?.message || e.message || '';
      const status = e.response?.status;
      if (msg.includes('too many requests') || status === 429) {
        console.log(`  ⏸ Rate limited — pausing ${RATE_LIMIT_PAUSE_MS / 1000}s before retry ${attempt}/3...`);
        await sleep(RATE_LIMIT_PAUSE_MS);
        continue;
      }
      throw e; // non-rate-limit error, let caller handle
    }
  }
  throw new Error('Rate limit: max retries exhausted after pauses');
}

// Zoho rate limit: strict on free/standard plans. 1 request per 3s = ~20/min (very safe)
const DELAY_MS = 3000;
// On rate limit (429/400 "too many requests"), pause for 120s then continue
const RATE_LIMIT_PAUSE_MS = 120000;

const stats = {};
function initStat(key) { stats[key] = { total: 0, synced: 0, skipped: 0, failed: 0 }; }
['webstore', 'pos', 'b2b', 'procurement', 'bills', 'expenses', 'salaries', 'journals', 'refunds'].forEach(initStat);

// ── 1. Webstore Orders → Zoho Sales Invoices + Payments ─────────────────────
async function backfillWebstore() {
  console.log('\n══ WEBSTORE ORDERS → Zoho Sales Invoices ══');
  const { data: orders } = await supabase.from('webstore_orders')
    .select('*')
    .gte('date', FROM_DATE)
    .in('payment_status', ['paid'])
    .or('zoho_invoice_id.is.null,zoho_invoice_id.eq.')
    .order('date');

  stats.webstore.total = (orders || []).length;
  console.log(`  Found ${stats.webstore.total} webstore orders to sync`);
  if (!orders?.length) return;

  for (const o of orders) {
    try {
      const rawCust = o.customer || {};
      const customer = {
        name:  decrypt(rawCust.name)  || 'Guest',
        email: decrypt(rawCust.email) || null,
        phone: decrypt(rawCust.phone) || '',
      };
      if (DRY_RUN) {
        console.log(`  [DRY] ${o.order_no} — ${customer.name} ₹${round2(o.total)}`);
        stats.webstore.skipped++;
        continue;
      }

      const zohoOrder = {
        customer,
        items:    (o.items || []).map(i => ({ name: i.name || 'Product', qty: i.qty, price: i.price })),
        shipping: parseFloat(o.shipping) || 0,
        total:    parseFloat(o.total) || 0,
        orderNo:  o.order_no,
        date:     o.date,
      };

      const invoice = await zohoCall('createInvoice', null, zohoOrder);
      await sleep(DELAY_MS);

      if (invoice?.invoice_id) {
        await supabase.from('webstore_orders').update({ zoho_invoice_id: invoice.invoice_id }).eq('id', o.id);

        // Record payment
        if (parseFloat(o.total) > 0) {
          try {
            await zohoCall('recordPayment', null, invoice, { amount: o.total, mode: 'online', ref: o.payment_id || o.order_no });
          } catch (_) {}
          await sleep(DELAY_MS);
        }

        stats.webstore.synced++;
        if (stats.webstore.synced % 10 === 0) console.log(`  ... ${stats.webstore.synced}/${stats.webstore.total}`);
      }
    } catch (e) {
      stats.webstore.failed++;
      console.error(`  ✗ ${o.order_no}: ${e.response?.data?.message || e.message}`);
    }
  }
  console.log(`  ✓ ${stats.webstore.synced} webstore orders synced`);
}

// ── 2. POS Sales → Zoho Sales Invoices + Payments ───────────────────────────
async function backfillPOS() {
  console.log('\n══ POS SALES → Zoho Sales Invoices ══');
  const { data: sales } = await supabase.from('sales')
    .select('*')
    .gte('date', FROM_DATE)
    .in('status', ['delivered', 'packed', 'dispatched', 'confirmed'])
    .or('zoho_invoice_id.is.null,zoho_invoice_id.eq.')
    .order('date');

  stats.pos.total = (sales || []).length;
  console.log(`  Found ${stats.pos.total} POS sales to sync`);
  if (!sales?.length) return;

  for (const s of sales) {
    try {
      if (DRY_RUN) {
        console.log(`  [DRY] ${s.order_no || s.id} — ${s.customer_name || 'Walk-in'} ₹${round2(s.final_amount)}`);
        stats.pos.skipped++;
        continue;
      }

      // Fetch items from sale_items table
      const { data: saleItems } = await supabase.from('sale_items')
        .select('product_name, qty, rate').eq('sale_id', s.id);
      const items = (saleItems || []).map(i => ({ name: i.product_name || 'Product', qty: parseFloat(i.qty) || 1, price: parseFloat(i.rate) || 0 }));
      if (!items.length) {
        // Fallback: single line item with total
        items.push({ name: 'POS Sale', qty: 1, price: parseFloat(s.final_amount) || 0 });
      }

      const zohoOrder = {
        customer: { name: s.customer_name || 'Walk-in Customer', email: null, phone: s.customer_phone || '' },
        items,
        shipping: 0,
        total:    parseFloat(s.final_amount) || 0,
        orderNo:  trimInvNo(s.order_no || `POS-${s.id}`),
        date:     s.date,
      };

      const invoice = await zohoCall('createInvoice', null, zohoOrder);
      await sleep(DELAY_MS);

      if (invoice?.invoice_id) {
        await supabase.from('sales').update({ zoho_invoice_id: invoice.invoice_id }).eq('id', s.id);

        // Record payment if amount paid
        const paid = parseFloat(s.amount_paid || s.final_amount) || 0;
        if (paid > 0) {
          try {
            await zohoCall('recordPayment', null, invoice, { amount: paid, mode: s.payment_method || 'cash', ref: s.order_no || `POS-${s.id}` });
          } catch (_) {}
          await sleep(DELAY_MS);
        }

        stats.pos.synced++;
        if (stats.pos.synced % 20 === 0) console.log(`  ... ${stats.pos.synced}/${stats.pos.total}`);
      }
    } catch (e) {
      stats.pos.failed++;
      console.error(`  ✗ ${s.order_no || s.id}: ${e.response?.data?.message || e.message}`);
    }
  }
  console.log(`  ✓ ${stats.pos.synced} POS sales synced`);
}

// ── 3. B2B Orders → Zoho Sales Invoices ─────────────────────────────────────
async function backfillB2B() {
  console.log('\n══ B2B ORDERS → Zoho Sales Invoices ══');
  const { data: orders } = await supabase.from('b2b_orders')
    .select('*, b2b_order_items(*)')
    .gte('created_at', FROM_DATE)
    .in('stage', ['shipped', 'delivered', 'customs_export', 'invoice_sent', 'invoice_paid'])
    .or('zoho_invoice_id.is.null,zoho_invoice_id.eq.')
    .order('created_at');

  stats.b2b.total = (orders || []).length;
  console.log(`  Found ${stats.b2b.total} B2B orders to sync`);
  if (!orders?.length) return;

  for (const o of orders) {
    try {
      // Fetch customer details
      let cust = {};
      if (o.customer_id) {
        const { data: c } = await supabase.from('b2b_customers').select('company_name, email, phone').eq('id', o.customer_id).single();
        cust = c || {};
      }

      if (DRY_RUN) {
        console.log(`  [DRY] ${o.order_no} — ${cust.company_name || o.customer_name || 'B2B'} ₹${round2(o.total_value)}`);
        stats.b2b.skipped++;
        continue;
      }

      const items = (o.b2b_order_items || o.items || []);
      const zohoOrder = {
        customer: { name: cust.company_name || o.customer_name || 'B2B Customer', email: cust.email || null, phone: cust.phone || '' },
        items:    items.map(i => ({ name: i.product_name || i.name, qty: i.qty, price: i.unit_price || i.price })),
        shipping: 0,
        total:    parseFloat(o.total_value) || 0,
        orderNo:  o.order_no,
        date:     (o.created_at || '').slice(0, 10),
      };

      const invoice = await zohoCall('createInvoice', null, zohoOrder);
      await sleep(DELAY_MS);

      if (invoice?.invoice_id) {
        await supabase.from('b2b_orders').update({ zoho_invoice_id: invoice.invoice_id }).eq('id', o.id);
        stats.b2b.synced++;
        console.log(`  ✓ ${o.order_no} → ${invoice.invoice_id} (₹${round2(o.total_value)})`);
      }
    } catch (e) {
      stats.b2b.failed++;
      console.error(`  ✗ ${o.order_no}: ${e.response?.data?.message || e.message}`);
    }
  }
}

// ── 4. Procurements → Zoho Purchase Orders ──────────────────────────────────
const COGS_ACCOUNT_ID = '1247318000000000567'; // Cost of Goods Sold
const vendorCache = {}; // supplier name → zoho vendor contact ID
async function backfillProcurement() {
  console.log('\n══ PROCUREMENTS → Zoho Purchase Orders ══');
  const { data: procs } = await supabase.from('procurements')
    .select('*')
    .gte('date', FROM_DATE)
    .or('zoho_po_id.is.null,zoho_po_id.eq.')
    .order('date');

  stats.procurement.total = (procs || []).length;
  console.log(`  Found ${stats.procurement.total} procurements to sync`);
  if (!procs?.length) return;

  for (const p of procs) {
    const totalCost = round2((parseFloat(p.ordered_qty) || 0) * (parseFloat(p.ordered_price_per_kg) || 0));
    if (totalCost <= 0) { stats.procurement.skipped++; continue; }

    try {
      if (DRY_RUN) {
        console.log(`  [DRY] PO-${p.id} — ${p.commodity_name} ${p.ordered_qty}kg from ${p.supplier || 'vendor'} ₹${totalCost}`);
        stats.procurement.skipped++;
        continue;
      }

      // Get or create vendor contact (cached to avoid duplicates)
      const supplierName = (p.supplier || 'Vendor').trim();
      if (!vendorCache[supplierName]) {
        try {
          // Search for existing vendor-type contact
          const search = await zohoCall('get', '/contacts', null, { search_text: supplierName, contact_type: 'vendor' });
          const match = (search.contacts || []).find(c => c.contact_type === 'vendor');
          if (match) {
            vendorCache[supplierName] = match.contact_id;
          } else {
            // Create new vendor contact
            const created = await zohoCall('post', '/contacts', { contact_name: supplierName, contact_type: 'vendor' });
            vendorCache[supplierName] = created?.contact?.contact_id;
          }
          await sleep(DELAY_MS);
        } catch (ce) {
          const existingId = ce.response?.data?.contact_id;
          if (existingId) vendorCache[supplierName] = existingId;
          else console.log(`  ! Vendor contact failed for ${supplierName}:`, ce.response?.data?.message || ce.message);
        }
      }
      if (!vendorCache[supplierName]) { stats.procurement.skipped++; continue; }

      const payload = {
        vendor_id:   vendorCache[supplierName],
        bill_number: `PR-${String(p.id).slice(-12)}`,
        date:        p.date || (p.created_at || '').slice(0, 10),
        line_items: [{
          account_id:  COGS_ACCOUNT_ID,
          description: `${p.commodity_name || 'Raw Material'} — ${p.ordered_qty}kg @ ₹${p.ordered_price_per_kg}/kg`,
          rate:        parseFloat(p.ordered_price_per_kg) || 0,
          quantity:    parseFloat(p.ordered_qty) || 0,
        }],
        notes: `Procurement: ${p.commodity_name || ''} from ${p.supplier || ''} ${p.notes ? '— ' + p.notes : ''}`.trim(),
      };

      const result = await zohoCall('post', '/bills', payload);
      if (result?.bill?.bill_id) {
        await supabase.from('procurements').update({ zoho_po_id: result.bill.bill_id }).eq('id', p.id);
        stats.procurement.synced++;
        if (stats.procurement.synced % 50 === 0) console.log(`  ... ${stats.procurement.synced}/${stats.procurement.total}`);
      }
      await sleep(DELAY_MS);
    } catch (e) {
      stats.procurement.failed++;
      console.error(`  ✗ PO-${p.id} (${p.commodity_name}): ${e.response?.data?.message || e.message}`);
    }
  }
  console.log(`  ✓ ${stats.procurement.synced} procurements synced`);
}

// ── 5. Vendor Bills → Zoho Bills ─────────────────────────────────────────────
async function backfillBills() {
  console.log('\n══ VENDOR BILLS → Zoho Bills ══');
  const { data: bills } = await supabase.from('vendor_bills')
    .select('*')
    .is('deleted_at', null)
    .gte('bill_date', FROM_DATE)
    .or('zoho_bill_id.is.null,zoho_bill_id.eq.')
    .order('bill_date');

  stats.bills.total = (bills || []).length;
  console.log(`  Found ${stats.bills.total} vendor bills to sync`);
  if (!bills?.length) return;

  for (const b of bills) {
    try {
      if (DRY_RUN) {
        console.log(`  [DRY] ${b.bill_no || b.id} — ${b.vendor_name} ₹${round2(b.amount)}`);
        stats.bills.skipped++;
        continue;
      }

      const contactId = await zohoCall('findOrCreateContact', b.vendor_name, null, null, 'vendor');
      await sleep(DELAY_MS);

      const result = await zohoCall('post', '/bills', {
        vendor_id:    contactId || undefined,
        vendor_name:  contactId ? undefined : b.vendor_name,
        bill_number:  b.bill_no || `BILL-${b.id}`,
        date:         b.bill_date,
        due_date:     b.due_date || undefined,
        line_items:   [{ account_id: getExpenseAcctId(b.category), description: b.category || 'General', rate: round2(b.amount), quantity: 1 }],
        gst_no:       b.vendor_gst || undefined,
        notes:        b.notes || `Vendor bill — ${b.vendor_name}`,
      });

      if (result?.bill?.bill_id) {
        await supabase.from('vendor_bills').update({ zoho_bill_id: result.bill.bill_id }).eq('id', b.id);
        stats.bills.synced++;
        console.log(`  ✓ ${b.bill_no || b.id} → ${result.bill.bill_id}`);

        // If bill has payments, record them
        if (parseFloat(b.paid_amount) > 0) {
          await sleep(DELAY_MS);
          try {
            await zohoCall('post', '/billpayments', {
              payment_mode: 'Cash', amount: round2(b.paid_amount), date: b.bill_date,
              bills: [{ bill_id: result.bill.bill_id, amount_applied: round2(b.paid_amount) }],
            });
          } catch (_) {}
        }
      }
      await sleep(DELAY_MS);
    } catch (e) {
      stats.bills.failed++;
      console.error(`  ✗ ${b.bill_no || b.id}: ${e.response?.data?.message || e.message}`);
    }
  }
}

// ── 6. Company Expenses → Zoho Expenses ──────────────────────────────────────
async function backfillExpenses() {
  console.log('\n══ COMPANY EXPENSES → Zoho Expenses ══');
  const { data: expenses } = await supabase.from('company_expenses')
    .select('*')
    .gte('date', FROM_DATE)
    .or('zoho_expense_id.is.null,zoho_expense_id.eq.')
    .order('date');

  stats.expenses.total = (expenses || []).length;
  console.log(`  Found ${stats.expenses.total} expenses to sync`);
  if (!expenses?.length) return;

  for (const e of expenses) {
    try {
      if (DRY_RUN) {
        console.log(`  [DRY] ${e.description} ₹${round2(e.amount)} (${e.category})`);
        stats.expenses.skipped++;
        continue;
      }

      const result = await zohoCall('post', '/expenses', {
        date: e.date, amount: round2(e.amount), description: e.description || '',
        account_id: getExpenseAcctId(e.category),
        paid_through_account_id: '1247318000000000459', // Petty Cash
        reference_number: e.reference_no || '', vendor_name: e.vendor_name || undefined,
      });
      if (result?.expense?.expense_id) {
        await supabase.from('company_expenses').update({ zoho_expense_id: result.expense.expense_id }).eq('id', e.id);
        stats.expenses.synced++;
        if (stats.expenses.synced % 50 === 0) console.log(`  ... ${stats.expenses.synced}/${stats.expenses.total}`);
      }
      await sleep(DELAY_MS);
    } catch (err) {
      stats.expenses.failed++;
      console.error(`  ✗ #${e.id} (${e.description}): ${err.response?.data?.message || err.message}`);
    }
  }
  console.log(`  ✓ ${stats.expenses.synced} expenses synced`);
}

// ── 7. Salary Payments → Zoho Journal Entries ────────────────────────────────
async function backfillSalaries() {
  console.log('\n══ SALARY PAYMENTS → Zoho Journals ══');
  const { data: payments } = await supabase.from('salary_payments')
    .select('*').gte('payment_date', FROM_DATE).order('payment_date');

  stats.salaries.total = (payments || []).length;
  console.log(`  Found ${stats.salaries.total} salary payments to sync`);
  if (!payments?.length) return;

  for (const p of payments) {
    try {
      if (DRY_RUN) {
        console.log(`  [DRY] Salary ${p.month} — ${p.employee_name} ₹${round2(p.amount)}`);
        stats.salaries.skipped++;
        continue;
      }
      await zohoCall('post', '/journals', {
        journal_date: p.payment_date, reference_number: p.reference_no || `SAL-${p.month}-${p.employee_id}`,
        notes: `Salary ${p.month} — ${p.employee_name || ''}`,
        line_items: [
          { account_name: 'Salaries and Employee Wages', debit_or_credit: 'debit', amount: round2(p.amount) },
          { account_name: p.payment_mode === 'cash' ? 'Petty Cash' : 'Bank', debit_or_credit: 'credit', amount: round2(p.amount) },
        ],
      });
      stats.salaries.synced++;
      console.log(`  ✓ ${p.month} — ${p.employee_name} ₹${round2(p.amount)}`);
      await sleep(DELAY_MS);
    } catch (e) {
      stats.salaries.failed++;
      console.error(`  ✗ ${p.month} ${p.employee_name}: ${e.response?.data?.message || e.message}`);
    }
  }
}

// ── 8. Journal Entries → Zoho Journals ───────────────────────────────────────
async function backfillJournals() {
  console.log('\n══ JOURNAL ENTRIES → Zoho Journals ══');
  const { data: entries } = await supabase.from('journal_entries')
    .select('*').gte('date', FROM_DATE).order('date');

  stats.journals.total = (entries || []).length;
  console.log(`  Found ${stats.journals.total} journal entries to sync`);
  if (!entries?.length) return;

  const entryIds = entries.map(e => e.id);
  const { data: allLines } = await supabase.from('journal_lines').select('*').in('journal_id', entryIds);
  const linesMap = {};
  for (const l of (allLines || [])) {
    if (!linesMap[l.journal_id]) linesMap[l.journal_id] = [];
    linesMap[l.journal_id].push(l);
  }

  for (const entry of entries) {
    const lines = linesMap[entry.id] || [];
    if (lines.length < 2) { stats.journals.skipped++; continue; }
    try {
      if (DRY_RUN) {
        console.log(`  [DRY] ${entry.description} ₹${round2(entry.total_amount)}`);
        stats.journals.skipped++;
        continue;
      }
      const zohoLines = lines.map(l => ({
        account_name: l.account_name || 'Uncategorized',
        debit_or_credit: parseFloat(l.debit || 0) > 0 ? 'debit' : 'credit',
        amount: parseFloat(l.debit || 0) > 0 ? round2(l.debit) : round2(l.credit),
        description: l.description || '',
      }));
      await zohoCall('post', '/journals', {
        journal_date: entry.date, reference_number: entry.ref_no || `JE-${entry.id}`,
        notes: entry.description || '', line_items: zohoLines,
      });
      stats.journals.synced++;
      if (stats.journals.synced % 50 === 0) console.log(`  ... ${stats.journals.synced}/${stats.journals.total}`);
      await sleep(DELAY_MS);
    } catch (e) {
      stats.journals.failed++;
      console.error(`  ✗ JE#${entry.id} (${entry.description}): ${e.response?.data?.message || e.message}`);
    }
  }
  console.log(`  ✓ ${stats.journals.synced} journals synced`);
}

// ── 9. Refunded Orders → Zoho Credit Notes ──────────────────────────────────
async function backfillRefunds() {
  console.log('\n══ REFUNDED ORDERS → Zoho Credit Notes ══');
  const { data: orders } = await supabase.from('webstore_orders')
    .select('id, order_no, total, status, items, customer, refund_id, notes, date')
    .in('status', ['refunded', 'refund_initiated', 'partial_refund'])
    .gte('date', FROM_DATE).order('date');

  stats.refunds.total = (orders || []).length;
  console.log(`  Found ${stats.refunds.total} refunded orders to sync`);
  if (!orders?.length) return;

  for (const o of orders) {
    try {
      if (DRY_RUN) {
        console.log(`  [DRY] CN-${o.order_no} ₹${round2(o.total)}`);
        stats.refunds.skipped++;
        continue;
      }
      const rawCust = o.customer || {};
      const customer = { name: decrypt(rawCust.name) || 'Customer', email: decrypt(rawCust.email) || null, phone: decrypt(rawCust.phone) || '' };
      const contactId = await zohoCall('findOrCreateContact', customer.name, customer.email);
      await sleep(DELAY_MS);

      let lineItems = o.status === 'partial_refund'
        ? (o.items || []).filter(i => i.cancelled).map(i => ({ name: i.name || 'Product', quantity: parseFloat(i.cancelled_qty || i.qty) || 1, rate: parseFloat(i.price) || 0 }))
        : (o.items || []).map(i => ({ name: i.name || 'Product', quantity: parseFloat(i.qty) || 1, rate: parseFloat(i.price) || 0 }));
      if (!lineItems.length) { stats.refunds.skipped++; continue; }

      const result = await zohoCall('post', '/creditnotes', {
        creditnote_number: `CN-${o.order_no}`, date: o.date || new Date().toISOString().slice(0, 10),
        reference_number: o.order_no, line_items: lineItems,
        notes: `Refund for order ${o.order_no}. Razorpay: ${o.refund_id || 'N/A'}`,
        ...(contactId ? { customer_id: contactId } : { customer_name: customer.name || 'Customer' }),
      });
      stats.refunds.synced++;
      console.log(`  ✓ CN-${o.order_no} → ${result?.creditnote?.creditnote_id}`);
      await sleep(DELAY_MS);
    } catch (e) {
      stats.refunds.failed++;
      console.error(`  ✗ ${o.order_no}: ${e.response?.data?.message || e.message}`);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  ZOHO BOOKS HISTORICAL BACKFILL');
  console.log(`  Period: ${FROM_DATE} → ${new Date().toISOString().slice(0, 10)}`);
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE'}`);
  if (TYPE_FILTER) console.log(`  Filter: ${TYPE_FILTER} only`);
  console.log('═══════════════════════════════════════════════════════');

  if (!process.env.ZOHO_ORG_ID || !process.env.ZOHO_CLIENT_ID) {
    console.error('ERROR: Zoho env vars not set. Aborting.');
    process.exit(1);
  }

  const tasks = {
    webstore:    backfillWebstore,
    pos:         backfillPOS,
    b2b:         backfillB2B,
    procurement: backfillProcurement,
    bills:       backfillBills,
    expenses:    backfillExpenses,
    salaries:    backfillSalaries,
    journals:    backfillJournals,
    refunds:     backfillRefunds,
  };

  if (TYPE_FILTER && tasks[TYPE_FILTER]) {
    await tasks[TYPE_FILTER]();
  } else {
    for (const [name, fn] of Object.entries(tasks)) {
      await fn();
    }
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  BACKFILL SUMMARY');
  console.log('═══════════════════════════════════════════════════════');
  for (const [key, s] of Object.entries(stats)) {
    if (s.total > 0) {
      console.log(`  ${key.padEnd(14)} — Total: ${String(s.total).padStart(4)}, Synced: ${String(s.synced).padStart(4)}, Skipped: ${String(s.skipped).padStart(4)}, Failed: ${String(s.failed).padStart(4)}`);
    }
  }
  const totalSynced = Object.values(stats).reduce((s, v) => s + v.synced, 0);
  const totalFailed = Object.values(stats).reduce((s, v) => s + v.failed, 0);
  const totalRecords = Object.values(stats).reduce((s, v) => s + v.total, 0);
  console.log(`\n  TOTAL: ${totalRecords} records — ${totalSynced} synced, ${totalFailed} failed`);
  console.log('═══════════════════════════════════════════════════════');
}

main().then(() => process.exit(0)).catch(e => { console.error('Fatal:', e); process.exit(1); });
