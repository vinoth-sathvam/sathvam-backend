const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const supabase = require('../config/supabase');
const { auth, requireRole } = require('../middleware/auth');

const RZP_BASE = 'https://api.razorpay.com/v1';

function rzpAuth() {
  const key    = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  return 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
}

function rzpAcct() { return process.env.RAZORPAY_X_ACCOUNT_NUMBER; }

async function rzpPost(path, body, withIdempotency = false) {
  const headers = { 'Authorization': rzpAuth(), 'Content-Type': 'application/json' };
  if (withIdempotency) headers['X-Payout-Idempotency'] = crypto.randomUUID();
  const res = await fetch(RZP_BASE + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return res.json();
}

async function rzpGet(path) {
  const res = await fetch(RZP_BASE + path, { headers: { 'Authorization': rzpAuth() } });
  return res.json();
}

async function createContact(name, email, phone, type) {
  const body = { name, type };
  if (email) body.email   = email;
  if (phone) body.contact = phone;
  return rzpPost('/contacts', body);
}

async function createFundAccount(contactId, bankName, accountNo, ifsc, upiId) {
  if (upiId) {
    return rzpPost('/fund_accounts', {
      contact_id:   contactId,
      account_type: 'vpa',
      vpa:          { address: upiId },
    });
  }
  return rzpPost('/fund_accounts', {
    contact_id:   contactId,
    account_type: 'bank_account',
    bank_account: {
      name:           bankName || 'Account Holder',
      ifsc:           (ifsc || '').toUpperCase(),
      account_number: accountNo,
    },
  });
}

// ── GET /api/payouts/history ──────────────────────────────────────────────────
router.get('/history', auth, async (req, res) => {
  if (!rzpAcct()) return res.status(400).json({ error: 'RAZORPAY_X_ACCOUNT_NUMBER not configured' });
  const data = await rzpGet(`/payouts?account_number=${encodeURIComponent(rzpAcct())}&count=50`);
  if (data.error) return res.status(400).json({ error: data.error.description || 'Failed' });
  res.json(data.items || []);
});

// ── POST /api/payouts/vendor-bill ─────────────────────────────────────────────
router.post('/vendor-bill', auth, requireRole('admin', 'manager'), async (req, res) => {
  const { vendor_id, bill_id, amount, mode = 'NEFT', notes } = req.body;
  if (!vendor_id || !amount) return res.status(400).json({ error: 'vendor_id and amount required' });
  if (!rzpAcct()) return res.status(400).json({ error: 'RAZORPAY_X_ACCOUNT_NUMBER not configured' });

  const { data: vendor } = await supabase.from('vendors').select('*').eq('id', vendor_id).single();
  if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
  if (!vendor.bank_account && !vendor.upi_id) {
    return res.status(400).json({ error: 'Vendor has no bank account or UPI ID — update vendor details first' });
  }

  const contact = await createContact(vendor.display_name, vendor.email, vendor.mobile, 'vendor');
  if (contact.error) return res.status(400).json({ error: contact.error.description });

  const fa = await createFundAccount(
    contact.id,
    vendor.bank_name || vendor.display_name,
    vendor.bank_account,
    vendor.bank_ifsc,
    vendor.upi_id,
  );
  if (fa.error) return res.status(400).json({ error: fa.error.description });

  const payout = await rzpPost('/payouts', {
    account_number:       rzpAcct(),
    fund_account_id:      fa.id,
    amount:               Math.round(parseFloat(amount) * 100),
    currency:             'INR',
    mode:                 vendor.upi_id ? 'UPI' : mode,
    purpose:              'vendor_payment',
    narration:            notes || `Payment to ${vendor.display_name}`,
    queue_if_low_balance: false,
  }, true);

  if (payout.error) return res.status(400).json({ error: payout.error.description });

  // Record payment against bill
  if (bill_id) {
    await supabase.from('bill_payments').insert({
      bill_id, date: new Date().toISOString().slice(0, 10),
      amount: parseFloat(amount), mode: 'razorpay_payout',
      reference: payout.id,
      notes: `RazorpayX — ${payout.id}`,
      created_by: req.user.name || req.user.username,
    });
    const { data: bill } = await supabase.from('vendor_bills').select('*').eq('id', bill_id).single();
    if (bill) {
      const paid = (parseFloat(bill.paid_amount) || 0) + parseFloat(amount);
      await supabase.from('vendor_bills').update({
        paid_amount: paid,
        status: paid >= parseFloat(bill.amount) ? 'paid' : 'partial',
      }).eq('id', bill_id);
    }
  }

  res.json({ success: true, payout_id: payout.id, status: payout.status });
});

// ── POST /api/payouts/salary ──────────────────────────────────────────────────
router.post('/salary', auth, requireRole('admin', 'hr'), async (req, res) => {
  const { employee_id, amount, month, notes } = req.body;
  if (!employee_id || !amount) return res.status(400).json({ error: 'employee_id and amount required' });
  if (!rzpAcct()) return res.status(400).json({ error: 'RAZORPAY_X_ACCOUNT_NUMBER not configured' });

  const { data: emp } = await supabase.from('employees').select('*').eq('id', employee_id).single();
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  if (!emp.bank_account && !emp.upi_id) {
    return res.status(400).json({ error: 'Employee has no bank account or UPI ID — update employee details first' });
  }

  const contact = await createContact(emp.name, emp.email, emp.phone, 'employee');
  if (contact.error) return res.status(400).json({ error: contact.error.description });

  const fa = await createFundAccount(
    contact.id,
    emp.bank_name || emp.name,
    emp.bank_account,
    emp.bank_ifsc,
    emp.upi_id,
  );
  if (fa.error) return res.status(400).json({ error: fa.error.description });

  const payout = await rzpPost('/payouts', {
    account_number:       rzpAcct(),
    fund_account_id:      fa.id,
    amount:               Math.round(parseFloat(amount) * 100),
    currency:             'INR',
    mode:                 emp.upi_id ? 'UPI' : 'NEFT',
    purpose:              'salary',
    narration:            notes || `Salary — ${emp.name}${month ? ` — ${month}` : ''}`,
    queue_if_low_balance: false,
  }, true);

  if (payout.error) return res.status(400).json({ error: payout.error.description });
  res.json({ success: true, payout_id: payout.id, status: payout.status });
});

// ── POST /api/payouts/refund ──────────────────────────────────────────────────
router.post('/refund', auth, async (req, res) => {
  const { customer_name, account_number, ifsc, bank_name, upi_id, amount, order_id, notes } = req.body;
  if (!amount) return res.status(400).json({ error: 'amount required' });
  if (!upi_id && (!account_number || !ifsc)) return res.status(400).json({ error: 'Provide UPI ID or bank account + IFSC' });
  if (!rzpAcct()) return res.status(400).json({ error: 'RAZORPAY_X_ACCOUNT_NUMBER not configured' });

  const contact = await createContact(customer_name || 'Customer', null, null, 'customer');
  if (contact.error) return res.status(400).json({ error: contact.error.description });

  const fa = await createFundAccount(contact.id, bank_name || customer_name, account_number, ifsc, upi_id);
  if (fa.error) return res.status(400).json({ error: fa.error.description });

  const payout = await rzpPost('/payouts', {
    account_number:       rzpAcct(),
    fund_account_id:      fa.id,
    amount:               Math.round(parseFloat(amount) * 100),
    currency:             'INR',
    mode:                 upi_id ? 'UPI' : 'IMPS',
    purpose:              'refund',
    narration:            notes || `Refund — ${order_id || 'Order'}`,
    queue_if_low_balance: false,
  }, true);

  if (payout.error) return res.status(400).json({ error: payout.error.description });
  res.json({ success: true, payout_id: payout.id, status: payout.status });
});

// ── POST /api/payouts/adhoc ───────────────────────────────────────────────────
router.post('/adhoc', auth, requireRole('admin'), async (req, res) => {
  const { name, account_number, ifsc, bank_name, upi_id, amount, mode = 'NEFT', purpose = 'payout', notes } = req.body;
  if (!amount) return res.status(400).json({ error: 'amount required' });
  if (!upi_id && (!account_number || !ifsc)) return res.status(400).json({ error: 'Provide UPI ID or bank account + IFSC' });
  if (!rzpAcct()) return res.status(400).json({ error: 'RAZORPAY_X_ACCOUNT_NUMBER not configured' });

  const contact = await createContact(name || 'Transfer', null, null, 'self');
  if (contact.error) return res.status(400).json({ error: contact.error.description });

  const fa = await createFundAccount(contact.id, bank_name || name, account_number, ifsc, upi_id);
  if (fa.error) return res.status(400).json({ error: fa.error.description });

  const payout = await rzpPost('/payouts', {
    account_number:       rzpAcct(),
    fund_account_id:      fa.id,
    amount:               Math.round(parseFloat(amount) * 100),
    currency:             'INR',
    mode:                 upi_id ? 'UPI' : mode,
    purpose,
    narration:            notes || `Transfer to ${name}`,
    queue_if_low_balance: false,
  }, true);

  if (payout.error) return res.status(400).json({ error: payout.error.description });
  res.json({ success: true, payout_id: payout.id, status: payout.status });
});

module.exports = router;
