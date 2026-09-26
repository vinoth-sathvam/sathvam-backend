const express = require('express');
const router = express.Router();
const { auth, requireRole } = require('../middleware/auth');
const supabase = require('../config/supabase');
const { isConfigured, iciciAPI, clearToken } = require('../config/icici');
const { insertLedger } = require('../utils/ledger');

// ── Helper: check configured or return setup_required ──
const ensureConfigured = (req, res, next) => {
  if (!isConfigured()) {
    return res.json({
      setup_required: true,
      message: 'ICICI API not configured. Add ICICI_CLIENT_ID and ICICI_CLIENT_SECRET to .env file.',
      setup_steps: [
        'Visit developer.icicibank.com and sign up',
        'Apply for API access with your Corporate Account',
        'Get Client ID, Client Secret, and API Key',
        'Add credentials to .env file on the server',
        'Restart the backend container'
      ]
    });
  }
  next();
};

// ═══════════════════════════════════════════════════════════════
// CONNECTION STATUS
// ═══════════════════════════════════════════════════════════════

// GET /api/icici/status — Check connection status
router.get('/status', auth, async (req, res) => {
  try {
    const configured = isConfigured();
    const { data: lastSync } = await supabase.from('settings').select('value').eq('key', 'icici_last_sync').single().catch(() => ({ data: null }));

    res.json({
      configured,
      account: configured ? (process.env.ICICI_CORP_ACCOUNT || '').replace(/.(?=.{4})/g, '*') : null,
      ifsc: configured ? (process.env.ICICI_CORP_IFSC || '') : null,
      last_sync: lastSync?.value?.timestamp || null,
      last_sync_result: lastSync?.value?.result || null,
    });
  } catch (e) {
    res.json({ configured: false, error: e.message });
  }
});

// POST /api/icici/test — Test API connection
router.post('/test', auth, requireRole('admin', 'ceo'), async (req, res) => {
  if (!isConfigured()) return res.json({ ok: false, setup_required: true, message: 'ICICI API not configured' });
  try {
    const result = await iciciAPI('GET', '/ci/balanceInquiry', null, {
      accountNo: process.env.ICICI_CORP_ACCOUNT,
    });
    res.json({ ok: true, message: 'Connected successfully', data: result });
  } catch (e) {
    clearToken();
    res.json({ ok: false, message: `Connection failed: ${e.response?.data?.message || e.message}` });
  }
});

// ═══════════════════════════════════════════════════════════════
// ACCOUNT BALANCE
// ═══════════════════════════════════════════════════════════════

// GET /api/icici/balance — Real-time balance
router.get('/balance', auth, ensureConfigured, async (req, res) => {
  try {
    const result = await iciciAPI('GET', '/ci/balanceInquiry', null, {
      accountNo: process.env.ICICI_CORP_ACCOUNT,
    });

    const balance = parseFloat(result?.effectiveBalance || result?.accountBalance || result?.balance || 0);
    const available = parseFloat(result?.effectiveBalance || result?.availableBalance || balance);

    // Optionally update local bank_accounts record
    if (req.query.update_local === 'true') {
      await supabase.from('bank_accounts')
        .update({ current_balance: balance })
        .ilike('account_no', `%${(process.env.ICICI_CORP_ACCOUNT || '').slice(-4)}`)
        .eq('is_active', true);
    }

    res.json({
      account_no: (process.env.ICICI_CORP_ACCOUNT || '').replace(/.(?=.{4})/g, '*'),
      balance,
      available_balance: available,
      currency: 'INR',
      as_of: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: `Balance fetch failed: ${e.response?.data?.message || e.message}` });
  }
});

// ═══════════════════════════════════════════════════════════════
// BANK STATEMENT
// ═══════════════════════════════════════════════════════════════

// GET /api/icici/statement — Fetch statement from ICICI
router.get('/statement', auth, ensureConfigured, async (req, res) => {
  try {
    const from = req.query.from_date || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to_date || new Date().toISOString().slice(0, 10);

    const result = await iciciAPI('GET', '/ci/accountStatement', null, {
      accountNo: process.env.ICICI_CORP_ACCOUNT,
      fromDate: from.replace(/-/g, '/'), // ICICI expects DD/MM/YYYY or YYYY/MM/DD
      toDate: to.replace(/-/g, '/'),
    });

    // Parse ICICI response into standard format
    const transactions = (result?.transactions || result?.records || []).map(t => ({
      date: t.transactionDate || t.valueDate || t.date,
      description: t.narration || t.description || t.remarks || '',
      reference: t.referenceNo || t.chequeNo || t.utrNo || '',
      debit: parseFloat(t.debitAmount || t.debit || 0),
      credit: parseFloat(t.creditAmount || t.credit || 0),
      balance: parseFloat(t.balance || t.closingBalance || 0),
      type: parseFloat(t.debitAmount || t.debit || 0) > 0 ? 'debit' : 'credit',
      amount: parseFloat(t.debitAmount || t.debit || 0) > 0
        ? parseFloat(t.debitAmount || t.debit)
        : parseFloat(t.creditAmount || t.credit || 0),
    }));

    res.json({ transactions, from, to, count: transactions.length });
  } catch (e) {
    res.status(500).json({ error: `Statement fetch failed: ${e.response?.data?.message || e.message}` });
  }
});

// POST /api/icici/statement/sync — Auto-sync: fetch + insert
router.post('/statement/sync', auth, requireRole('admin', 'ceo', 'manager'), ensureConfigured, async (req, res) => {
  try {
    const from = req.body.from_date || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const to = req.body.to_date || new Date().toISOString().slice(0, 10);

    // Fetch from ICICI
    const result = await iciciAPI('GET', '/ci/accountStatement', null, {
      accountNo: process.env.ICICI_CORP_ACCOUNT,
      fromDate: from.replace(/-/g, '/'),
      toDate: to.replace(/-/g, '/'),
    });

    const transactions = (result?.transactions || result?.records || []).map(t => ({
      date: t.transactionDate || t.valueDate || t.date,
      description: t.narration || t.description || '',
      reference: t.referenceNo || t.chequeNo || t.utrNo || '',
      type: parseFloat(t.debitAmount || t.debit || 0) > 0 ? 'debit' : 'credit',
      amount: parseFloat(t.debitAmount || t.debit || 0) > 0
        ? parseFloat(t.debitAmount || t.debit)
        : parseFloat(t.creditAmount || t.credit || 0),
      balance: parseFloat(t.balance || 0),
    }));

    // Find the ICICI bank account in our DB
    const { data: accounts } = await supabase.from('bank_accounts')
      .select('id')
      .ilike('bank_name', '%icici%')
      .eq('is_active', true)
      .limit(1);
    const bankAccountId = accounts?.[0]?.id || req.body.bank_account_id;

    if (!bankAccountId) {
      return res.status(400).json({ error: 'No ICICI bank account found in system. Add one in Finance → Bank & Cash first.' });
    }

    // Get existing transactions for dedup
    const { data: existing } = await supabase.from('bank_transactions')
      .select('date, type, amount')
      .eq('bank_account_id', bankAccountId)
      .gte('date', from)
      .lte('date', to);

    // Count occurrences of each date+type+amount combo for proper dedup
    // (handles multiple legitimate transactions with same date+type+amount)
    const existingCounts = {};
    for (const e of (existing || [])) {
      const key = `${e.date}_${e.type}_${parseFloat(e.amount).toFixed(2)}`;
      existingCounts[key] = (existingCounts[key] || 0) + 1;
    }

    let inserted = 0, skipped = 0;
    const inputCounts = {};
    for (const t of transactions) {
      const key = `${t.date}_${t.type}_${parseFloat(t.amount).toFixed(2)}`;
      inputCounts[key] = (inputCounts[key] || 0) + 1;
      // Skip if DB already has enough of this combo
      if (inputCounts[key] <= (existingCounts[key] || 0)) { skipped++; continue; }

      await supabase.from('bank_transactions').insert({
        bank_account_id: bankAccountId,
        date: t.date,
        type: t.type,
        amount: t.amount,
        description: t.description,
        reference: t.reference,
        category: t.type === 'credit' ? 'Sales Revenue' : 'Other',
        reconciled: false,
        created_by: req.user?.email || 'icici-sync',
      });

      // Update balance
      const delta = t.type === 'credit' ? t.amount : -t.amount;
      await supabase.rpc('adjust_bank_balance', { p_account_id: bankAccountId, p_delta: delta }).catch(() => {
        // Fallback if RPC doesn't exist
        supabase.from('bank_accounts').select('current_balance').eq('id', bankAccountId).single()
          .then(({ data: acc }) => {
            if (acc) supabase.from('bank_accounts').update({ current_balance: parseFloat(acc.current_balance || 0) + delta }).eq('id', bankAccountId);
          });
      });

      inserted++;
    }

    // Save sync metadata
    await supabase.from('settings').upsert({
      key: 'icici_last_sync',
      value: { timestamp: new Date().toISOString(), from, to, inserted, skipped, total: transactions.length },
      updated_at: new Date().toISOString(),
    });

    res.json({ ok: true, inserted, skipped, total: transactions.length, from, to });
  } catch (e) {
    res.status(500).json({ error: `Sync failed: ${e.response?.data?.message || e.message}` });
  }
});

// ═══════════════════════════════════════════════════════════════
// VENDOR PAYMENT (NEFT/RTGS/IMPS)
// ═══════════════════════════════════════════════════════════════

// POST /api/icici/pay — Initiate payment
router.post('/pay', auth, requireRole('admin', 'ceo'), ensureConfigured, async (req, res) => {
  try {
    const { beneficiary_name, account_no, ifsc, amount, mode, narration, reference } = req.body;
    if (!beneficiary_name || !account_no || !ifsc || !amount) {
      return res.status(400).json({ error: 'beneficiary_name, account_no, ifsc, amount required' });
    }

    const amt = parseFloat(amount);
    // Auto-select mode if not specified
    const payMode = mode || (amt >= 200000 ? 'RTGS' : 'NEFT');

    const payload = {
      debitAccountNo: process.env.ICICI_CORP_ACCOUNT,
      creditAccountNo: account_no,
      creditIFSC: ifsc,
      transferAmount: amt.toFixed(2),
      beneficiaryName: beneficiary_name,
      transferMode: payMode, // NEFT, RTGS, IMPS, FT
      remarks: narration || `Payment to ${beneficiary_name}`,
      uniqueRequestNo: `SAT${Date.now()}`,
    };

    const result = await iciciAPI('POST', '/ci/compositePayment', payload);

    // Log transaction locally
    const { data: accounts } = await supabase.from('bank_accounts')
      .select('id').ilike('bank_name', '%icici%').eq('is_active', true).limit(1);

    if (accounts?.[0]) {
      await supabase.from('bank_transactions').insert({
        bank_account_id: accounts[0].id,
        date: new Date().toISOString().slice(0, 10),
        type: 'debit',
        amount: amt,
        description: `${payMode} to ${beneficiary_name} | A/C: ${account_no}`,
        reference: result?.UTRNumber || result?.transactionRef || reference || '',
        category: 'Vendor Payment',
        reconciled: true,
        created_by: req.user?.email || '',
      });
    }

    // Log to money_ledger
    insertLedger({
      txn_date: new Date().toISOString().slice(0, 10),
      direction: 'out',
      amount: amt,
      category: 'vendor_payment',
      subcategory: payMode.toLowerCase(),
      party: beneficiary_name,
      party_type: 'vendor',
      payment_mode: payMode.toLowerCase(),
      narration: narration || `${payMode} payment to ${beneficiary_name}`,
      reference_no: result?.UTRNumber || '',
      source_table: 'icici_payment',
      created_by: req.user?.name || req.user?.email || '',
    }).catch(() => {});

    res.json({
      ok: true,
      transaction_ref: result?.transactionRef || result?.requestId || payload.uniqueRequestNo,
      utr_number: result?.UTRNumber || null,
      status: result?.status || 'initiated',
      mode: payMode,
      amount: amt,
      beneficiary: beneficiary_name,
    });
  } catch (e) {
    res.status(500).json({ error: `Payment failed: ${e.response?.data?.message || e.message}` });
  }
});

// GET /api/icici/pay/status/:ref — Check payment status
router.get('/pay/status/:ref', auth, ensureConfigured, async (req, res) => {
  try {
    const result = await iciciAPI('GET', '/ci/transactionInquiry', null, {
      requestId: req.params.ref,
    });
    res.json({
      ref: req.params.ref,
      status: result?.status || result?.transactionStatus || 'unknown',
      utr: result?.UTRNumber || null,
      timestamp: result?.transactionDate || null,
      details: result,
    });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// POST /api/icici/pay/vendor-bill — Pay a specific vendor bill
router.post('/pay/vendor-bill', auth, requireRole('admin', 'ceo'), ensureConfigured, async (req, res) => {
  try {
    const { bill_id, mode } = req.body;
    if (!bill_id) return res.status(400).json({ error: 'bill_id required' });

    // Get bill details
    const { data: bill } = await supabase.from('vendor_bills').select('*').eq('id', bill_id).single();
    if (!bill) return res.status(404).json({ error: 'Bill not found' });

    const balance = parseFloat(bill.amount || 0) + parseFloat(bill.gst_amount || 0) - parseFloat(bill.paid_amount || 0);
    if (balance <= 0) return res.status(400).json({ error: 'Bill already fully paid' });

    // Find vendor bank details
    const { data: vendors } = await supabase.from('vendors')
      .select('display_name, bank_name, bank_account, bank_ifsc')
      .or(`display_name.ilike.%${bill.vendor_name}%,company_name.ilike.%${bill.vendor_name}%`)
      .eq('active', true)
      .limit(1);

    const vendor = vendors?.[0];
    if (!vendor?.bank_account || !vendor?.bank_ifsc) {
      return res.status(400).json({ error: `Vendor "${bill.vendor_name}" bank details not found. Update vendor profile with bank account and IFSC.` });
    }

    // Initiate payment (reuse /pay logic inline)
    const payMode = mode || (balance >= 200000 ? 'RTGS' : 'NEFT');
    const payload = {
      debitAccountNo: process.env.ICICI_CORP_ACCOUNT,
      creditAccountNo: vendor.bank_account,
      creditIFSC: vendor.bank_ifsc,
      transferAmount: balance.toFixed(2),
      beneficiaryName: vendor.display_name || bill.vendor_name,
      transferMode: payMode,
      remarks: `Bill ${bill.bill_no} payment`,
      uniqueRequestNo: `SAT-BILL-${bill_id}-${Date.now()}`,
    };

    const result = await iciciAPI('POST', '/ci/compositePayment', payload);

    // Update bill as paid
    const newPaid = parseFloat(bill.paid_amount || 0) + balance;
    const newStatus = newPaid >= (parseFloat(bill.amount || 0) + parseFloat(bill.gst_amount || 0)) ? 'paid' : 'partial';
    await supabase.from('vendor_bills').update({
      paid_amount: newPaid,
      status: newStatus,
    }).eq('id', bill_id);

    // Log transaction
    const { data: accounts } = await supabase.from('bank_accounts')
      .select('id').ilike('bank_name', '%icici%').eq('is_active', true).limit(1);
    if (accounts?.[0]) {
      await supabase.from('bank_transactions').insert({
        bank_account_id: accounts[0].id,
        date: new Date().toISOString().slice(0, 10),
        type: 'debit',
        amount: balance,
        description: `${payMode} — Bill ${bill.bill_no} to ${bill.vendor_name}`,
        reference: result?.UTRNumber || '',
        category: 'Vendor Payment',
        reconciled: true,
        created_by: req.user?.email || '',
      });
    }

    res.json({
      ok: true,
      bill_id,
      amount_paid: balance,
      mode: payMode,
      utr: result?.UTRNumber || null,
      status: result?.status || 'initiated',
      bill_status: newStatus,
    });
  } catch (e) {
    res.status(500).json({ error: `Bill payment failed: ${e.response?.data?.message || e.message}` });
  }
});

// ═══════════════════════════════════════════════════════════════
// UPI COLLECTION
// ═══════════════════════════════════════════════════════════════

// POST /api/icici/collect — Create UPI collect request
router.post('/collect', auth, ensureConfigured, async (req, res) => {
  try {
    const { amount, customer_vpa, description, order_id } = req.body;
    if (!amount || !customer_vpa) return res.status(400).json({ error: 'amount and customer_vpa required' });

    const result = await iciciAPI('POST', '/ci/upiCollect', {
      payerVPA: customer_vpa,
      amount: parseFloat(amount).toFixed(2),
      remarks: description || `Sathvam order ${order_id || ''}`,
      merchantTxnId: `SAT-UPI-${Date.now()}`,
    });

    res.json({
      ok: true,
      collect_ref: result?.merchantTxnId || result?.txnId,
      status: result?.status || 'initiated',
      expiry: result?.expiry || new Date(Date.now() + 300000).toISOString(), // 5 min default
    });
  } catch (e) {
    res.status(500).json({ error: `UPI collect failed: ${e.response?.data?.message || e.message}` });
  }
});

// GET /api/icici/collect/status/:ref — Check collection status
router.get('/collect/status/:ref', auth, ensureConfigured, async (req, res) => {
  try {
    const result = await iciciAPI('GET', '/ci/upiTransactionStatus', null, {
      merchantTxnId: req.params.ref,
    });
    res.json({
      ref: req.params.ref,
      status: result?.status || 'pending',
      utr: result?.bankTxnId || null,
      amount: result?.amount || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// RECENT PAYMENTS LOG
// ═══════════════════════════════════════════════════════════════

// GET /api/icici/payments — Recent ICICI payments from local log
router.get('/payments', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('bank_transactions')
      .select('*')
      .eq('type', 'debit')
      .ilike('description', '%NEFT%,%RTGS%,%IMPS%,%icici%')
      .order('date', { ascending: false })
      .limit(50);
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
