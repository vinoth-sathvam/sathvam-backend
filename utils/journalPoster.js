/**
 * utils/journalPoster.js
 * Auto-posts double-entry journal entries from money_ledger data.
 * Called by insertLedger() so every business transaction creates a balanced journal entry.
 */
const supabase = require('../config/supabase');
const crypto   = require('crypto');

const round2 = v => Math.round((parseFloat(v) || 0) * 100) / 100;

// ── Expense subcategory → COA code mapping ──────────────────────────────────
const EXPENSE_MAP = {
  'raw materials':      '5000',
  'raw_material':       '5000',
  'utilities':          '6200',
  'labour':             '5100',
  'direct labour':      '5100',
  'transport':          '6300',
  'transport & logistics': '6300',
  'logistics':          '6300',
  'courier':            '6350',
  'shipping':           '6350',
  'maintenance':        '6600',
  'maintenance & repairs': '6600',
  'office & admin':     '6500',
  'office':             '6500',
  'admin':              '6500',
  'marketing':          '6400',
  'marketing & advertising': '6400',
  'rent':               '6100',
  'packaging':          '6700',
  'packaging materials': '6700',
  'packing':            '5300',
  'depreciation':       '6800',
  'interest':           '6900',
  'taxes':              '7000',
  'taxes & duties':     '7000',
  'miscellaneous':      '7100',
  'misc':               '7100',
  'salary':             '6000',
  'salaries':           '6000',
  'salaries & wages':   '6000',
  'manufacturing overhead': '5200',
};

/**
 * Determine the cash/bank account code based on payment mode.
 */
function cashAccount(paymentMode) {
  const mode = (paymentMode || '').toLowerCase();
  if (mode === 'cash') return { code: '1000', name: 'Cash in Hand' };
  return { code: '1100', name: 'Bank - Current Account' };
}

/**
 * Map a money_ledger record to journal debit/credit lines.
 * Returns an array of { account_code, account_name, debit, credit }.
 */
function mapToJournalLines(data) {
  const dir       = data.direction; // 'in' or 'out'
  const cat       = (data.category || '').toLowerCase();
  const subcat    = (data.subcategory || '').toLowerCase();
  const amount    = round2(data.amount);
  const gst       = round2(data.gst_amount || 0);
  const netAmount = round2(amount - gst);
  const cash      = cashAccount(data.payment_mode);
  const lines     = [];

  if (amount <= 0) return lines;

  if (dir === 'in') {
    // ── INCOME ──
    if (cat === 'sales') {
      // Determine revenue account based on subcategory/channel
      let revCode = '4000', revName = 'Sales Revenue - Retail';
      if (subcat.includes('webstore') || subcat.includes('website')) {
        revCode = '4010'; revName = 'Sales Revenue - Webstore';
      } else if (subcat.includes('b2b') || subcat.includes('export') || subcat.includes('wholesale')) {
        revCode = '4020'; revName = 'Sales Revenue - B2B';
      }

      // Debit: Bank/Cash for the full amount
      lines.push({ account_code: cash.code, account_name: cash.name, debit: amount, credit: 0 });

      if (gst > 0) {
        // Credit: Revenue (net of GST)
        lines.push({ account_code: revCode, account_name: revName, debit: 0, credit: netAmount });
        // Credit: GST Payable (split CGST/SGST equally for intra-state, default)
        const halfGst = round2(gst / 2);
        lines.push({ account_code: '2101', account_name: 'GST Payable (CGST)', debit: 0, credit: halfGst });
        lines.push({ account_code: '2102', account_name: 'GST Payable (SGST)', debit: 0, credit: round2(gst - halfGst) });
      } else {
        lines.push({ account_code: revCode, account_name: revName, debit: 0, credit: amount });
      }

    } else if (cat === 'b2b_ar' || cat === 'ar_payment' || subcat.includes('receivable')) {
      // AR payment received
      lines.push({ account_code: cash.code, account_name: cash.name, debit: amount, credit: 0 });
      lines.push({ account_code: '1200', account_name: 'Accounts Receivable', debit: 0, credit: amount });

    } else if (cat === 'cake_sale' || subcat.includes('cake') || subcat.includes('byproduct')) {
      lines.push({ account_code: cash.code, account_name: cash.name, debit: amount, credit: 0 });
      lines.push({ account_code: '4300', account_name: 'Cake & Byproduct Sales', debit: 0, credit: amount });

    } else {
      // Other income
      lines.push({ account_code: cash.code, account_name: cash.name, debit: amount, credit: 0 });
      lines.push({ account_code: '4100', account_name: 'Other Income', debit: 0, credit: amount });
    }

  } else if (dir === 'out') {
    // ── EXPENSES / OUTFLOWS ──

    if (cat === 'procurement' || cat === 'purchase' || subcat.includes('raw_material') || subcat.includes('raw material')) {
      // Procurement → Debit Inventory, Credit AP or Bank
      if (gst > 0) {
        lines.push({ account_code: '1300', account_name: 'Inventory - Raw Materials', debit: netAmount, credit: 0 });
        const halfGst = round2(gst / 2);
        lines.push({ account_code: '1210', account_name: 'GST Input Credit (CGST)', debit: halfGst, credit: 0 });
        lines.push({ account_code: '1211', account_name: 'GST Input Credit (SGST)', debit: round2(gst - halfGst), credit: 0 });
      } else {
        lines.push({ account_code: '1300', account_name: 'Inventory - Raw Materials', debit: amount, credit: 0 });
      }
      // Credit: AP if vendor bill, else Bank/Cash
      if ((data.party_type || '').toLowerCase() === 'vendor' && !subcat.includes('payment')) {
        lines.push({ account_code: '2000', account_name: 'Accounts Payable', debit: 0, credit: amount });
      } else {
        lines.push({ account_code: cash.code, account_name: cash.name, debit: 0, credit: amount });
      }

    } else if (cat === 'payroll' || cat === 'salary' || subcat.includes('salary')) {
      lines.push({ account_code: '6000', account_name: 'Salaries & Wages', debit: amount, credit: 0 });
      lines.push({ account_code: cash.code, account_name: cash.name, debit: 0, credit: amount });

    } else if (cat === 'vendor_bill' || cat === 'ap_payment' || subcat.includes('bill_payment') || subcat.includes('payable')) {
      // Vendor bill payment → Debit AP, Credit Bank
      lines.push({ account_code: '2000', account_name: 'Accounts Payable', debit: amount, credit: 0 });
      lines.push({ account_code: cash.code, account_name: cash.name, debit: 0, credit: amount });

    } else if (cat === 'gst' || subcat.includes('gst')) {
      // GST payment to government
      lines.push({ account_code: '2100', account_name: 'GST Payable', debit: amount, credit: 0 });
      lines.push({ account_code: cash.code, account_name: cash.name, debit: 0, credit: amount });

    } else if (cat === 'tds') {
      lines.push({ account_code: '2110', account_name: 'TDS Payable', debit: amount, credit: 0 });
      lines.push({ account_code: cash.code, account_name: cash.name, debit: 0, credit: amount });

    } else if (cat === 'loan' || subcat.includes('emi') || subcat.includes('loan')) {
      lines.push({ account_code: '2300', account_name: 'Short-term Loan', debit: amount, credit: 0 });
      lines.push({ account_code: cash.code, account_name: cash.name, debit: 0, credit: amount });

    } else if (cat === 'bank_transfer') {
      // Inter-bank transfer — skip journal (no P&L impact, just moves cash)
      return [];

    } else if (cat === 'petty_cash') {
      // Petty cash expense
      const expCode = EXPENSE_MAP[subcat] || '7100';
      const expName = subcat || 'Miscellaneous Expense';
      lines.push({ account_code: expCode, account_name: expName, debit: amount, credit: 0 });
      lines.push({ account_code: '1010', account_name: 'Petty Cash', debit: 0, credit: amount });

    } else {
      // General expense
      const expCode = EXPENSE_MAP[subcat] || EXPENSE_MAP[cat] || '7100';
      const coaName = Object.entries(EXPENSE_MAP).find(([,v]) => v === expCode)?.[0] || 'Miscellaneous Expense';

      if (gst > 0) {
        lines.push({ account_code: expCode, account_name: coaName, debit: netAmount, credit: 0 });
        const halfGst = round2(gst / 2);
        lines.push({ account_code: '1210', account_name: 'GST Input Credit (CGST)', debit: halfGst, credit: 0 });
        lines.push({ account_code: '1211', account_name: 'GST Input Credit (SGST)', debit: round2(gst - halfGst), credit: 0 });
      } else {
        lines.push({ account_code: expCode, account_name: coaName, debit: amount, credit: 0 });
      }
      lines.push({ account_code: cash.code, account_name: cash.name, debit: 0, credit: amount });
    }
  }

  return lines;
}

/**
 * Insert a double-entry journal entry from money_ledger data.
 * Idempotent: skips if ref_no already exists.
 */
async function insertJournal(data) {
  try {
    const amount = round2(data.amount);
    if (amount <= 0) return;

    const lines = mapToJournalLines(data);
    if (!lines.length) return; // no mapping (e.g. bank_transfer)

    // Validate balance
    const totalDebit  = round2(lines.reduce((s, l) => s + (l.debit || 0), 0));
    const totalCredit = round2(lines.reduce((s, l) => s + (l.credit || 0), 0));
    if (Math.abs(totalDebit - totalCredit) > 0.02) {
      console.error(`[JOURNAL] Unbalanced entry: Dr=${totalDebit} Cr=${totalCredit} for ${data.category}/${data.subcategory} ₹${amount}`);
      return;
    }

    // Build ref_no for idempotency
    const refNo = (data.source_table && data.source_id)
      ? `${data.source_table}-${data.source_id}`
      : `ML-${data.txn_date}-${crypto.randomBytes(4).toString('hex')}`;

    // Check for existing entry
    if (data.source_table && data.source_id) {
      const { data: existing } = await supabase.from('journal_entries')
        .select('id').eq('ref_no', refNo).maybeSingle();
      if (existing) return; // already posted
    }

    // Insert journal entry header
    const { data: je, error: jeErr } = await supabase.from('journal_entries').insert({
      date:         data.txn_date || new Date().toISOString().slice(0, 10),
      ref_no:       refNo,
      description:  data.narration || `${data.direction === 'in' ? 'Receipt' : 'Payment'}: ${data.category} - ${data.party || data.subcategory || ''}`.slice(0, 255),
      total_amount: totalDebit,
      created_by:   data.created_by || 'system',
    }).select('id').single();

    if (jeErr) {
      if (jeErr.message?.includes('duplicate') || jeErr.code === '23505') return; // idempotent
      throw jeErr;
    }

    // Insert journal lines
    const journalLines = lines.map(l => ({
      journal_id:   je.id,
      account_code: l.account_code,
      account_name: l.account_name,
      debit:        l.debit || 0,
      credit:       l.credit || 0,
      description:  data.narration || '',
    }));

    await supabase.from('journal_lines').insert(journalLines);

  } catch (e) {
    console.error('[JOURNAL] auto-post error:', e.message);
  }
}

module.exports = { insertJournal, mapToJournalLines };
