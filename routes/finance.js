const express  = require('express');
const router   = express.Router();
const { auth } = require('../middleware/auth');
const supabase  = require('../config/supabase');

// Zoho helper — gracefully unavailable if env vars not set
let zoho = null;
try { zoho = require('../config/zoho').zoho; } catch(e) {}
const ZOHO_ORG = () => process.env.ZOHO_ORG_ID;

const round2 = n => Math.round((parseFloat(n) || 0) * 100) / 100;

// ── Update vendor_bill status after payment change ────────────────────────────
async function refreshBillStatus(billId) {
  const { data: bill } = await supabase.from('vendor_bills').select('amount,gst_amount,paid_amount').eq('id', billId).single();
  if (!bill) return;
  const total = round2((bill.amount || 0) + (bill.gst_amount || 0));
  const paid  = round2(bill.paid_amount || 0);
  const today = new Date().toISOString().slice(0, 10);
  const { data: billFull } = await supabase.from('vendor_bills').select('due_date').eq('id', billId).single();
  let status = 'unpaid';
  if (paid >= total) status = 'paid';
  else if (paid > 0) status = 'partial';
  else if (billFull?.due_date && billFull.due_date < today) status = 'overdue';
  await supabase.from('vendor_bills').update({ status }).eq('id', billId);
  return status;
}

// ── Adjust bank account balance ───────────────────────────────────────────────
async function adjustBalance(accountId, delta) {
  if (!accountId) return;
  const { data: acc } = await supabase.from('bank_accounts').select('current_balance').eq('id', accountId).single();
  if (!acc) return;
  await supabase.from('bank_accounts').update({ current_balance: round2((acc.current_balance || 0) + delta) }).eq('id', accountId);
}

// ── Audit log helper ──────────────────────────────────────────────────────────
async function auditLog(entityType, entityId, action, changedBy, changes) {
  try {
    await supabase.from('finance_audit_log').insert({
      entity_type: entityType, entity_id: String(entityId),
      action, changed_by: changedBy || '', changes: changes || {},
    });
  } catch(e) { /* non-fatal */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/dashboard', auth, async (req, res) => {
  try {
    const today  = new Date().toISOString().slice(0, 10);
    const ago30  = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const week   = new Date(Date.now() + 7  * 864e5).toISOString().slice(0, 10);

    const [bills, bankAccs, sales30, ws30, b2bPending] = await Promise.all([
      supabase.from('vendor_bills').select('amount,gst_amount,paid_amount,due_date,status').is('deleted_at', null),
      supabase.from('bank_accounts').select('name,current_balance,type').eq('is_active', true),
      supabase.from('sales').select('final_amount').eq('status','paid').gte('date', ago30),
      supabase.from('webstore_orders').select('total').in('status',['confirmed','shipped','delivered']).gte('date', ago30),
      supabase.from('b2b_orders').select('total_value,stage').not('stage','in','("delivered","cancelled")'),
    ]);

    const billList  = bills.data || [];
    const apTotal   = billList.filter(b => b.status !== 'paid').reduce((s,b) => s + round2((b.amount||0)+(b.gst_amount||0)) - (b.paid_amount||0), 0);
    const apOverdue = billList.filter(b => b.status !== 'paid' && b.due_date && b.due_date < today).reduce((s,b) => s + round2((b.amount||0)+(b.gst_amount||0)) - (b.paid_amount||0), 0);
    const apDueWeek = billList.filter(b => b.status !== 'paid' && b.due_date && b.due_date >= today && b.due_date <= week).length;
    const cashBal   = (bankAccs.data || []).reduce((s,a) => s + (a.current_balance || 0), 0);
    const rev30     = (sales30.data||[]).reduce((s,x)=>s+(x.final_amount||0),0)
                    + (ws30.data||[]).reduce((s,x)=>s+(x.total||0),0);
    const arTotal   = (b2bPending.data||[]).reduce((s,x)=>s+(x.total_value||0),0);

    res.json({ ap_total:round2(apTotal), ap_overdue:round2(apOverdue), ap_due_this_week:apDueWeek, cash_balance:round2(cashBal), ar_total:round2(arTotal), revenue_30d:round2(rev30), bank_accounts: bankAccs.data||[] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// RECEIVABLES (AR)
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/receivables', auth, async (req, res) => {
  try {
    const today  = new Date().toISOString().slice(0, 10);
    const source = req.query.source || 'all';
    const status = req.query.status || 'unpaid';

    let invoices = [];

    // ── Local B2B orders ─────────────────────────────────────────────────────
    if (source === 'all' || source === 'b2b') {
      const { data: b2b } = await supabase.from('b2b_orders').select('id,order_no,customer_name,created_at,total_value,stage').not('stage','in','("delivered","cancelled","invoice_paid")').order('created_at', { ascending:false }).limit(200);
      for (const o of (b2b || [])) {
        invoices.push({
          id: `b2b-${o.id}`, source:'b2b', invoice_no: o.order_no,
          customer_name: o.customer_name || '',
          date: (o.created_at||'').slice(0,10), due_date: null,
          amount: o.total_value || 0, paid_amount: 0,
          balance: o.total_value || 0, status: 'unpaid',
          ref_id: o.id,
        });
      }
    }

    // ── Local Webstore orders ────────────────────────────────────────────────
    if (source === 'all' || source === 'webstore') {
      const { data: ws } = await supabase.from('webstore_orders').select('id,order_no,customer,date,total,status').in('status',['confirmed','processing']).order('date',{ascending:false}).limit(200);
      for (const o of (ws || [])) {
        invoices.push({
          id: `ws-${o.id}`, source:'webstore', invoice_no: o.order_no,
          customer_name: (o.customer?.name) || '',
          date: o.date, due_date: null,
          amount: o.total || 0, paid_amount: 0,
          balance: o.total || 0, status: 'unpaid',
          ref_id: o.id,
        });
      }
    }

    // ── Zoho invoices ────────────────────────────────────────────────────────
    if ((source === 'all' || source === 'zoho') && zoho) {
      try {
        const params = { organization_id: ZOHO_ORG(), status: status === 'all' ? undefined : 'unpaid', per_page: 200, sort_column:'date', sort_order:'D' };
        const data = await zoho('get', '/invoices', null, params);
        for (const inv of (data.invoices || [])) {
          const st = inv.status === 'overdue' ? 'overdue' : inv.status === 'paid' ? 'paid' : inv.balance_due > 0 && inv.balance_due < inv.total ? 'partial' : 'unpaid';
          invoices.push({
            id: `zoho-${inv.invoice_id}`, source:'zoho', invoice_no: inv.invoice_number,
            customer_name: inv.customer_name || '',
            date: inv.date, due_date: inv.due_date,
            amount: parseFloat(inv.total) || 0,
            paid_amount: round2((parseFloat(inv.total)||0) - (parseFloat(inv.balance_due)||0)),
            balance: parseFloat(inv.balance_due) || 0,
            status: st, ref_id: inv.invoice_id,
          });
        }
      } catch(ze) { console.warn('Zoho AR fetch failed:', ze.message); }
    }

    // ── Overdue fix ──────────────────────────────────────────────────────────
    invoices = invoices.map(i => {
      if (i.status === 'unpaid' && i.due_date && i.due_date < today) return { ...i, status:'overdue' };
      return i;
    });

    // ── Filter by status ─────────────────────────────────────────────────────
    if (status !== 'all') invoices = invoices.filter(i => i.status === status);

    const total_outstanding = invoices.filter(i=>i.status!=='paid').reduce((s,i)=>s+i.balance,0);
    res.json({ invoices, total_outstanding: round2(total_outstanding), count: invoices.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Record payment against a receivable (B2B order or webstore)
router.post('/receivables/:id/record-payment', auth, async (req, res) => {
  try {
    const { amount, date, mode, reference, bank_account_id, notes } = req.body;
    const id = req.params.id;
    const amt = round2(amount);

    if (id.startsWith('b2b-')) {
      const orderId = id.replace('b2b-', '');
      await supabase.from('b2b_orders').update({ stage:'invoice_paid', notes: `Payment: ₹${amt} on ${date} via ${mode}. ${notes||''}` }).eq('id', orderId);
    } else if (id.startsWith('ws-')) {
      const orderId = id.replace('ws-', '');
      await supabase.from('webstore_orders').update({ status:'delivered', notes:`Payment: ₹${amt} on ${date} via ${mode}. ${notes||''}` }).eq('id', orderId);
    }

    // Log bank credit
    if (bank_account_id) {
      await supabase.from('bank_transactions').insert({ bank_account_id, date: date||new Date().toISOString().slice(0,10), type:'credit', amount:amt, description:`AR payment - ${id}`, reference: reference||'', category:'Receivable', created_by: req.user?.email||'' });
      await adjustBalance(bank_account_id, amt);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAYABLES (AP)
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/payables', auth, async (req, res) => {
  try {
    const today  = new Date().toISOString().slice(0, 10);
    const status = req.query.status || 'all';
    const start  = req.query.start;
    const end    = req.query.end;

    let q = supabase.from('vendor_bills').select('*').is('deleted_at', null).order('bill_date', { ascending:false }).limit(500);
    if (status !== 'all') q = q.eq('status', status);
    if (start) q = q.gte('bill_date', start);
    if (end)   q = q.lte('bill_date', end);
    const { data: bills, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    // Auto-mark overdue
    const ids = (bills||[]).filter(b => b.status === 'unpaid' && b.due_date && b.due_date < today).map(b=>b.id);
    if (ids.length) await supabase.from('vendor_bills').update({ status:'overdue' }).in('id', ids);

    // Fetch payments for each bill
    const { data: payments } = await supabase.from('bill_payments').select('*').in('bill_id', (bills||[]).map(b=>b.id)).order('date');

    const payMap = {};
    for (const p of (payments||[])) {
      if (!payMap[p.bill_id]) payMap[p.bill_id] = [];
      payMap[p.bill_id].push(p);
    }

    const result = (bills||[]).map(b => ({
      ...b,
      total_amount: round2((b.amount||0) + (b.gst_amount||0)),
      balance: round2((b.amount||0) + (b.gst_amount||0) - (b.paid_amount||0)),
      payments: payMap[b.id] || [],
    }));

    const total_payable  = result.filter(b=>b.status!=='paid').reduce((s,b)=>s+b.balance,0);
    const overdue_count  = result.filter(b=>b.status==='overdue').length;
    res.json({ bills: result, total_payable: round2(total_payable), overdue_count, count: result.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/payables', auth, async (req, res) => {
  try {
    const { vendor_name, vendor_gst, bill_no, bill_date, due_date, amount, gst_amount, category, notes } = req.body;
    if (!vendor_name || !bill_date) return res.status(400).json({ error: 'vendor_name and bill_date required' });
    const { data, error } = await supabase.from('vendor_bills').insert({
      vendor_name, vendor_gst: vendor_gst||'', bill_no: bill_no||'',
      bill_date, due_date: due_date||null,
      amount: round2(amount||0), gst_amount: round2(gst_amount||0),
      category: category||'General', notes: notes||'',
      status: 'unpaid', paid_amount: 0,
      created_by: req.user?.email||'',
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    auditLog('vendor_bill', data.id, 'create', req.user?.email, data);
    res.status(201).json({ ...data, total_amount: round2((data.amount||0)+(data.gst_amount||0)), balance: round2((data.amount||0)+(data.gst_amount||0)), payments:[] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/payables/:id', auth, async (req, res) => {
  try {
    const fields = ['vendor_name','vendor_gst','bill_no','bill_date','due_date','amount','gst_amount','category','notes','attachment_url'];
    const updates = {};
    for (const f of fields) if (req.body[f] !== undefined) updates[f] = f === 'amount' || f === 'gst_amount' ? round2(req.body[f]) : req.body[f];
    updates.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('vendor_bills').update(updates).eq('id', req.params.id).is('deleted_at',null).select().single();
    if (error) return res.status(400).json({ error: error.message });
    await refreshBillStatus(req.params.id);
    const upd = await supabase.from('vendor_bills').select('*').eq('id', req.params.id).single();
    auditLog('vendor_bill', req.params.id, 'update', req.user?.email, updates);
    res.json({ ...upd.data, total_amount: round2((upd.data.amount||0)+(upd.data.gst_amount||0)), balance: round2((upd.data.amount||0)+(upd.data.gst_amount||0)-(upd.data.paid_amount||0)) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/payables/:id', auth, async (req, res) => {
  try {
    await supabase.from('vendor_bills').update({ deleted_at: new Date().toISOString() }).eq('id', req.params.id);
    auditLog('vendor_bill', req.params.id, 'delete', req.user?.email, {});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/payables/:id/payments', auth, async (req, res) => {
  try {
    const billId = parseInt(req.params.id);
    const { date, amount, mode, reference, bank_account_id, notes } = req.body;
    const amt = round2(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

    // Approval gate: bills > ₹10,000 need manager approval
    const { data: billCheck } = await supabase.from('vendor_bills').select('amount,gst_amount,approval_status').eq('id', billId).single();
    const billTotal = round2((billCheck?.amount||0)+(billCheck?.gst_amount||0));
    if (billTotal > 10000 && billCheck?.approval_status !== 'approved' && billCheck?.approval_status !== 'auto') {
      return res.status(403).json({ error: 'Bill above ₹10,000 requires manager approval before payment', requires_approval: true, bill_id: billId });
    }

    // Insert payment
    const { data: pmt, error: pe } = await supabase.from('bill_payments').insert({
      bill_id: billId, date: date || new Date().toISOString().slice(0,10),
      amount: amt, mode: mode||'bank_transfer', reference: reference||'',
      bank_account_id: bank_account_id || null, notes: notes||'',
      created_by: req.user?.email||'',
    }).select().single();
    if (pe) return res.status(400).json({ error: pe.message });

    // Update bill paid_amount
    const { data: bill } = await supabase.from('vendor_bills').select('paid_amount').eq('id', billId).single();
    const newPaid = round2((bill?.paid_amount||0) + amt);
    await supabase.from('vendor_bills').update({ paid_amount: newPaid, updated_at: new Date().toISOString() }).eq('id', billId);
    const newStatus = await refreshBillStatus(billId);

    // Bank debit
    if (bank_account_id) {
      const { data: bAcc } = await supabase.from('bank_accounts').select('name').eq('id', bank_account_id).single();
      await supabase.from('bank_transactions').insert({
        bank_account_id, date: date||new Date().toISOString().slice(0,10),
        type:'debit', amount: amt,
        description: `Bill payment - vendor bill #${billId}`,
        reference: reference||'', category:'Vendor Payment',
        created_by: req.user?.email||'',
      });
      await adjustBalance(bank_account_id, -amt);
    }
    auditLog('vendor_bill', billId, 'payment', req.user?.email, { amount: amt, mode: mode||'bank_transfer' });
    res.json({ ok: true, payment: pmt, bill_status: newStatus, paid_amount: newPaid });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/payables/:id/payments', auth, async (req, res) => {
  const { data, error } = await supabase.from('bill_payments').select('*').eq('bill_id', req.params.id).order('date');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ═══════════════════════════════════════════════════════════════════════════════
// BANK ACCOUNTS + TRANSACTIONS
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/bank/accounts', auth, async (req, res) => {
  const { data, error } = await supabase.from('bank_accounts').select('*').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/bank/accounts', auth, async (req, res) => {
  try {
    const { name, bank_name, account_no, ifsc, type, opening_balance } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const ob = round2(opening_balance || 0);
    const { data, error } = await supabase.from('bank_accounts').insert({ name, bank_name:bank_name||'', account_no:account_no||'', ifsc:ifsc||'', type:type||'current', opening_balance:ob, current_balance:ob, is_active:true }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/bank/accounts/:id', auth, async (req, res) => {
  try {
    const fields = ['name','bank_name','account_no','ifsc','type','is_active'];
    const updates = {};
    for (const f of fields) if (req.body[f] !== undefined) updates[f] = req.body[f];
    const { data, error } = await supabase.from('bank_accounts').update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/bank/transactions', auth, async (req, res) => {
  try {
    const { account_id, start, end, type, limit=200, offset=0 } = req.query;
    let q = supabase.from('bank_transactions').select('*').order('date',{ascending:false}).order('created_at',{ascending:false}).limit(parseInt(limit)).range(parseInt(offset), parseInt(offset)+parseInt(limit)-1);
    if (account_id) q = q.eq('bank_account_id', account_id);
    if (start) q = q.gte('date', start);
    if (end)   q = q.lte('date', end);
    if (type && type !== 'all') q = q.eq('type', type);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    const txns = data || [];
    const total_credit = txns.filter(t=>t.type==='credit').reduce((s,t)=>s+t.amount,0);
    const total_debit  = txns.filter(t=>t.type==='debit').reduce((s,t)=>s+t.amount,0);
    res.json({ transactions: txns, total_credit:round2(total_credit), total_debit:round2(total_debit), count:txns.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/bank/transactions', auth, async (req, res) => {
  try {
    const { bank_account_id, date, type, amount, description, reference, category } = req.body;
    if (!bank_account_id || !type || !amount) return res.status(400).json({ error: 'bank_account_id, type, amount required' });
    const amt = round2(amount);
    const { data, error } = await supabase.from('bank_transactions').insert({ bank_account_id, date: date||new Date().toISOString().slice(0,10), type, amount:amt, description:description||'', reference:reference||'', category:category||'', created_by:req.user?.email||'' }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    await adjustBalance(bank_account_id, type === 'credit' ? amt : -amt);
    res.status(201).json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/bank/transactions/:id/reconcile', auth, async (req, res) => {
  const { data, error } = await supabase.from('bank_transactions').update({ reconciled: req.body.reconciled ?? true }).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

router.delete('/bank/transactions/:id', auth, async (req, res) => {
  try {
    const { data: txn } = await supabase.from('bank_transactions').select('*').eq('id', req.params.id).single();
    if (!txn) return res.status(404).json({ error: 'Not found' });
    await supabase.from('bank_transactions').delete().eq('id', req.params.id);
    // Reverse balance impact
    await adjustBalance(txn.bank_account_id, txn.type === 'credit' ? -txn.amount : txn.amount);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GST REPORT
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/gst', auth, async (req, res) => {
  try {
    const year  = parseInt(req.query.year)  || new Date().getFullYear();
    const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
    const start = `${year}-${String(month).padStart(2,'0')}-01`;
    const nextM = month === 12 ? `${year+1}-01-01` : `${year}-${String(month+1).padStart(2,'0')}-01`;
    const end   = new Date(new Date(nextM) - 1).toISOString().slice(0,10);

    const [salesR, wsR, b2bR, procR, billsR] = await Promise.all([
      supabase.from('sales').select('final_amount,total_amount').eq('status','paid').gte('date',start).lte('date',end),
      supabase.from('webstore_orders').select('subtotal,gst,total').in('status',['confirmed','shipped','delivered']).gte('date',start).lte('date',end),
      supabase.from('b2b_orders').select('total_value').in('stage',['shipped','delivered','invoice_sent','invoice_paid']).gte('created_at',start+'T00:00:00').lte('created_at',end+'T23:59:59'),
      supabase.from('procurements').select('ordered_qty,ordered_price_per_kg,gst').in('status',['received','stocked','cleaned']).gte('order_date',start).lte('order_date',end),
      supabase.from('vendor_bills').select('amount,gst_amount').is('deleted_at',null).neq('status','cancelled').gte('bill_date',start).lte('bill_date',end),
    ]);

    // Output tax
    const salesList  = salesR.data || [];
    const wsList     = wsR.data || [];
    const b2bList    = b2bR.data || [];
    const salesTax   = salesList.reduce((s,x) => { const taxable = x.total_amount||x.final_amount||0; return { taxable: s.taxable+taxable, gst: s.gst+(taxable*0.05) }; }, {taxable:0,gst:0}); // approx 5%
    const wsTax      = wsList.reduce((s,x)   => ({ taxable: s.taxable+(x.subtotal||0), gst: s.gst+(x.gst||0) }), {taxable:0,gst:0});
    const b2bTax     = b2bList.reduce((s,x)  => { const tv = x.total_value||0; return { taxable: s.taxable+tv, gst: s.gst+(tv*0.05) }; }, {taxable:0,gst:0});

    // Input tax
    const procList   = procR.data || [];
    const billsList  = billsR.data || [];
    const procTax    = procList.reduce((s,x) => { const base = (x.ordered_qty||0)*(x.ordered_price_per_kg||0); const rate = (x.gst||0)/100; return { taxable: s.taxable+base, gst: s.gst+(base*rate) }; }, {taxable:0,gst:0});
    const billsTax   = billsList.reduce((s,x) => ({ taxable: s.taxable+(x.amount||0), gst: s.gst+(x.gst_amount||0) }), {taxable:0,gst:0});

    const out_total   = { taxable: round2(salesTax.taxable+wsTax.taxable+b2bTax.taxable), gst: round2(salesTax.gst+wsTax.gst+b2bTax.gst) };
    const in_total    = { taxable: round2(procTax.taxable+billsTax.taxable), gst: round2(procTax.gst+billsTax.gst) };
    const net_payable = round2(out_total.gst - in_total.gst);

    res.json({
      period: { year, month, start, end },
      output_tax: { sales:{taxable:round2(salesTax.taxable),gst:round2(salesTax.gst),count:salesList.length}, webstore:{taxable:round2(wsTax.taxable),gst:round2(wsTax.gst),count:wsList.length}, b2b:{taxable:round2(b2bTax.taxable),gst:round2(b2bTax.gst),count:b2bList.length}, total:out_total },
      input_tax: { procurement:{taxable:round2(procTax.taxable),gst:round2(procTax.gst),count:procList.length}, vendor_bills:{taxable:round2(billsTax.taxable),gst:round2(billsTax.gst),count:billsList.length}, total:in_total },
      net_gst_payable: net_payable,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// JOURNAL ENTRIES
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/journal', auth, async (req, res) => {
  try {
    const { start, end, limit=100, offset=0 } = req.query;
    let q = supabase.from('journal_entries').select('*').order('date',{ascending:false}).order('created_at',{ascending:false}).limit(parseInt(limit));
    if (start) q = q.gte('date', start);
    if (end)   q = q.lte('date', end);
    const { data: entries, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    const ids = (entries||[]).map(e=>e.id);
    const { data: lines } = ids.length ? await supabase.from('journal_lines').select('*').in('journal_id', ids).order('id') : { data:[] };
    const linesMap = {};
    for (const l of (lines||[])) {
      if (!linesMap[l.journal_id]) linesMap[l.journal_id] = [];
      linesMap[l.journal_id].push(l);
    }
    res.json({ entries: (entries||[]).map(e => ({ ...e, lines: linesMap[e.id]||[] })), count: (entries||[]).length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/journal', auth, async (req, res) => {
  try {
    const { date, ref_no, description, lines } = req.body;
    if (!date || !description || !Array.isArray(lines) || lines.length < 2) return res.status(400).json({ error: 'date, description and at least 2 lines required' });
    const totalDebit  = lines.reduce((s,l) => s + round2(l.debit||0), 0);
    const totalCredit = lines.reduce((s,l) => s + round2(l.credit||0), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.01) return res.status(400).json({ error: `Debits (${totalDebit}) must equal Credits (${totalCredit})` });

    const { data: entry, error: ee } = await supabase.from('journal_entries').insert({ date, ref_no:ref_no||'', description, total_amount:totalDebit, created_by:req.user?.email||'' }).select().single();
    if (ee) return res.status(400).json({ error: ee.message });

    const { data: jLines, error: le } = await supabase.from('journal_lines').insert(lines.map(l => ({ journal_id:entry.id, account_code:l.account_code||'', account_name:l.account_name||'', debit:round2(l.debit||0), credit:round2(l.credit||0), description:l.description||'' }))).select();
    if (le) return res.status(400).json({ error: le.message });

    auditLog('journal_entry', entry.id, 'create', req.user?.email, { description, total_amount: totalDebit });
    res.status(201).json({ ...entry, lines: jLines });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/journal/:id', auth, async (req, res) => {
  auditLog('journal_entry', req.params.id, 'delete', req.user?.email, {});
  const { error } = await supabase.from('journal_entries').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ZOHO SYNC
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/zoho/status', auth, async (req, res) => {
  const connected = !!(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET && process.env.ZOHO_REFRESH_TOKEN && process.env.ZOHO_ORG_ID);
  res.json({ zoho_connected: connected });
});

router.get('/zoho/invoices', auth, async (req, res) => {
  if (!zoho) return res.status(503).json({ error: 'Zoho not configured' });
  try {
    const page = parseInt(req.query.page) || 1;
    const status = req.query.status || 'unpaid';
    const params = { organization_id: ZOHO_ORG(), page, per_page:100, sort_column:'date', sort_order:'D' };
    if (status !== 'all') params.status = status;
    const data = await zoho('get', '/invoices', null, params);
    const invoices = (data.invoices || []).map(inv => ({
      zoho_invoice_id: inv.invoice_id, invoice_no: inv.invoice_number,
      customer_name: inv.customer_name, date: inv.date, due_date: inv.due_date,
      total: parseFloat(inv.total)||0, balance: parseFloat(inv.balance_due)||0,
      status: inv.status,
    }));
    res.json({ invoices, count: invoices.length, has_more: data.page_context?.has_more_page || false });
  } catch(e) {
    const msg = e.response?.data?.message || e.message;
    res.status(500).json({ error: 'Zoho error: ' + msg });
  }
});

router.post('/zoho/sync-bills', auth, async (req, res) => {
  if (!zoho) return res.status(503).json({ error: 'Zoho not configured' });
  try {
    let page = 1, inserted = 0, updated = 0;
    while (true) {
      const data = await zoho('get', '/bills', null, { organization_id: ZOHO_ORG(), page, per_page:100, sort_column:'date', sort_order:'D' });
      const bills = data.bills || [];
      if (!bills.length) break;
      for (const b of bills) {
        const rec = {
          vendor_name: b.vendor_name || b.company_name || '',
          bill_no: b.bill_number || '',
          bill_date: b.date,
          due_date: b.due_date || null,
          amount: round2(parseFloat(b.sub_total)||0),
          gst_amount: round2((parseFloat(b.total)||0) - (parseFloat(b.sub_total)||0)),
          category: 'Zoho Import',
          status: b.status === 'paid' ? 'paid' : b.balance_due > 0 && b.balance_due < b.total ? 'partial' : 'unpaid',
          paid_amount: round2((parseFloat(b.total)||0) - (parseFloat(b.balance_due)||0)),
          zoho_bill_id: b.bill_id,
        };
        const { data: existing } = await supabase.from('vendor_bills').select('id').eq('zoho_bill_id', b.bill_id).maybeSingle();
        if (existing) {
          await supabase.from('vendor_bills').update({ ...rec, updated_at: new Date().toISOString() }).eq('id', existing.id);
          updated++;
        } else {
          await supabase.from('vendor_bills').insert({ ...rec, created_by:'zoho-sync' });
          inserted++;
        }
      }
      if (!data.page_context?.has_more_page) break;
      page++;
      if (page > 10) break; // safety cap
    }
    res.json({ ok:true, inserted, updated, synced: inserted+updated });
  } catch(e) {
    const msg = e.response?.data?.message || e.message;
    res.status(500).json({ error: 'Zoho error: ' + msg });
  }
});

router.get('/zoho/chart-of-accounts', auth, async (req, res) => {
  if (!zoho) return res.status(503).json({ error: 'Zoho not configured' });
  try {
    const data = await zoho('get', '/chartofaccounts', null, { organization_id: ZOHO_ORG() });
    const accounts = (data.chartofaccounts || []).map(a => ({
      account_id: a.account_id, account_name: a.account_name,
      account_type: a.account_type, current_balance: parseFloat(a.current_balance)||0,
    }));
    res.json({ accounts });
  } catch(e) {
    const msg = e.response?.data?.message || e.message;
    res.status(500).json({ error: 'Zoho error: ' + msg });
  }
});

// ── Zoho GST Filing Endpoints ──────────────────────────────────────────────────
const ZOHO_MONTHS = ['','January','February','March','April','May','June','July','August','September','October','November','December'];

router.get('/zoho/gst/status', auth, async (req, res) => {
  if (!zoho) return res.status(503).json({ error: 'Zoho not configured' });
  try {
    const year  = parseInt(req.query.year)  || new Date().getFullYear();
    const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
    const from_date = `${year}-${String(month).padStart(2,'0')}-01`;
    const nextM = month === 12 ? `${year+1}-01-01` : `${year}-${String(month+1).padStart(2,'0')}-01`;
    const to_date = new Date(new Date(nextM) - 1).toISOString().slice(0,10);

    const [gstr1R, gstr3bR] = await Promise.all([
      zoho('get', '/gstreturn', null, { organization_id: process.env.ZOHO_ORG_ID, return_type: 'gstr1', from_date, to_date }).catch(() => null),
      zoho('get', '/gstreturn', null, { organization_id: process.env.ZOHO_ORG_ID, return_type: 'gstr3b', from_date, to_date }).catch(() => null),
    ]);

    const gstr1 = (gstr1R?.gst_returns || [])[0] || null;
    const gstr3b = (gstr3bR?.gst_returns || [])[0] || null;

    res.json({
      period: { year, month, from_date, to_date },
      gstr1: gstr1 ? { id: gstr1.return_id, status: gstr1.status, filed_date: gstr1.filed_date || null } : { status: 'not_created' },
      gstr3b: gstr3b ? { id: gstr3b.return_id, status: gstr3b.status, filed_date: gstr3b.filed_date || null } : { status: 'not_created' },
    });
  } catch(e) {
    const msg = e.response?.data?.message || e.message;
    res.status(500).json({ error: 'Zoho error: ' + msg });
  }
});

router.post('/zoho/gst/push-gstr1', auth, async (req, res) => {
  if (!zoho) return res.status(503).json({ error: 'Zoho not configured' });
  try {
    const { year, month } = req.body;
    const y = parseInt(year) || new Date().getFullYear();
    const m = parseInt(month) || (new Date().getMonth() + 1);
    const start = `${y}-${String(m).padStart(2,'0')}-01`;
    const nextM = m === 12 ? `${y+1}-01-01` : `${y}-${String(m+1).padStart(2,'0')}-01`;
    const end = new Date(new Date(nextM) - 1).toISOString().slice(0,10);

    // 1. Fetch all sales channels from our DB
    const [salesR, wsR, b2bR] = await Promise.all([
      supabase.from('sales').select('order_no,date,customer_name,final_amount,total_amount,items').eq('status','paid').gte('date',start).lte('date',end),
      supabase.from('webstore_orders').select('order_no,date,customer,subtotal,gst,total,items').in('status',['confirmed','shipped','delivered']).gte('date',start).lte('date',end),
      supabase.from('b2b_orders').select('order_no,created_at,customer_name,total_value,items').in('stage',['shipped','delivered','invoice_sent','invoice_paid']).gte('created_at',start+'T00:00:00').lte('created_at',end+'T23:59:59'),
    ]);

    // 2. Build summary of B2C outward supplies (local sales)
    const b2cSupplies = [];
    for (const s of (salesR.data || [])) {
      const taxable = parseFloat(s.final_amount || s.total_amount) || 0;
      b2cSupplies.push({ type: 'POS', date: s.date, invoice_no: s.order_no, customer: s.customer_name || 'Walk-in', taxable, cgst: round2(taxable*0.025), sgst: round2(taxable*0.025), igst: 0 });
    }
    for (const w of (wsR.data || [])) {
      const taxable = parseFloat(w.subtotal) || 0;
      const gst = parseFloat(w.gst) || 0;
      b2cSupplies.push({ type: 'Webstore', date: w.date, invoice_no: w.order_no, customer: w.customer?.name || 'Online', taxable, cgst: round2(gst/2), sgst: round2(gst/2), igst: 0 });
    }

    // 3. B2B supplies (zero-rated / interstate)
    const b2bSupplies = [];
    for (const b of (b2bR.data || [])) {
      const taxable = parseFloat(b.total_value) || 0;
      b2bSupplies.push({ type: 'B2B', date: b.created_at?.slice(0,10), invoice_no: b.order_no, customer: b.customer_name, taxable, cgst: 0, sgst: 0, igst: round2(taxable*0.05) });
    }

    // 4. Push summary to Zoho Books as a note/journal — Zoho auto-computes GSTR-1 from invoices already synced
    //    We create a GST adjustment note if needed and return the computed summary
    const totalB2CTaxable = round2(b2cSupplies.reduce((s,x) => s + x.taxable, 0));
    const totalB2CGst     = round2(b2cSupplies.reduce((s,x) => s + x.cgst + x.sgst + x.igst, 0));
    const totalB2BTaxable = round2(b2bSupplies.reduce((s,x) => s + x.taxable, 0));
    const totalB2BGst     = round2(b2bSupplies.reduce((s,x) => s + x.igst, 0));

    // 5. Try to get/create the GSTR-1 return in Zoho
    let zohoGstr1 = null;
    try {
      const gstReturns = await zoho('get', '/gstreturn', null, { organization_id: process.env.ZOHO_ORG_ID, return_type: 'gstr1', from_date: start, to_date: end });
      zohoGstr1 = (gstReturns?.gst_returns || [])[0] || null;
    } catch(e) { /* may not exist yet */ }

    auditLog('gst_return', `gstr1-${y}-${m}`, 'push', req.user?.email, { b2c_count: b2cSupplies.length, b2b_count: b2bSupplies.length });

    res.json({
      ok: true,
      period: { year: y, month: m, month_name: ZOHO_MONTHS[m], start, end },
      b2c: { count: b2cSupplies.length, taxable: totalB2CTaxable, gst: totalB2CGst },
      b2b: { count: b2bSupplies.length, taxable: totalB2BTaxable, gst: totalB2BGst },
      zoho_status: zohoGstr1 ? zohoGstr1.status : 'pending_sync',
      zoho_return_id: zohoGstr1?.return_id || null,
      message: zohoGstr1
        ? `GSTR-1 for ${ZOHO_MONTHS[m]} ${y} is in Zoho Books (status: ${zohoGstr1.status}). Review and file from Zoho Books dashboard.`
        : `Summary computed for ${ZOHO_MONTHS[m]} ${y}. Ensure invoices are synced to Zoho Books, then file GSTR-1 from Zoho Books → GST Returns.`,
      supplies: [...b2cSupplies.slice(0,20), ...b2bSupplies.slice(0,10)],
    });
  } catch(e) {
    const msg = e.response?.data?.message || e.message;
    res.status(500).json({ error: 'Zoho error: ' + msg });
  }
});

router.post('/zoho/gst/push-gstr3b', auth, async (req, res) => {
  if (!zoho) return res.status(503).json({ error: 'Zoho not configured' });
  try {
    const { year, month } = req.body;
    const y = parseInt(year) || new Date().getFullYear();
    const m = parseInt(month) || (new Date().getMonth() + 1);
    const start = `${y}-${String(m).padStart(2,'0')}-01`;
    const nextM = m === 12 ? `${y+1}-01-01` : `${y}-${String(m+1).padStart(2,'0')}-01`;
    const end = new Date(new Date(nextM) - 1).toISOString().slice(0,10);

    // Fetch all data needed for GSTR-3B
    const [salesR, wsR, b2bR, procR, billsR] = await Promise.all([
      supabase.from('sales').select('final_amount,total_amount').eq('status','paid').gte('date',start).lte('date',end),
      supabase.from('webstore_orders').select('subtotal,gst').in('status',['confirmed','shipped','delivered']).gte('date',start).lte('date',end),
      supabase.from('b2b_orders').select('total_value').in('stage',['shipped','delivered','invoice_sent','invoice_paid']).gte('created_at',start+'T00:00:00').lte('created_at',end+'T23:59:59'),
      supabase.from('procurements').select('ordered_qty,ordered_price_per_kg,gst').in('status',['received','stocked','cleaned']).gte('order_date',start).lte('order_date',end),
      supabase.from('vendor_bills').select('amount,gst_amount').is('deleted_at',null).neq('status','cancelled').gte('bill_date',start).lte('bill_date',end),
    ]);

    const salesTaxable = (salesR.data||[]).reduce((s,x)=>s+(parseFloat(x.final_amount||x.total_amount)||0),0);
    const wsTaxable    = (wsR.data||[]).reduce((s,x)=>s+(parseFloat(x.subtotal)||0),0);
    const wsGst        = (wsR.data||[]).reduce((s,x)=>s+(parseFloat(x.gst)||0),0);
    const b2bTaxable   = (b2bR.data||[]).reduce((s,x)=>s+(parseFloat(x.total_value)||0),0);

    const outTaxable = round2(salesTaxable + wsTaxable + b2bTaxable);
    const outGst     = round2(salesTaxable * 0.05 + wsGst + b2bTaxable * 0.05);
    const outCgst    = round2(outGst / 2);
    const outSgst    = round2(outGst / 2);

    const procTaxable = (procR.data||[]).reduce((s,x)=>s+(x.ordered_qty||0)*(x.ordered_price_per_kg||0),0);
    const procGst     = (procR.data||[]).reduce((s,x)=>{ const base=(x.ordered_qty||0)*(x.ordered_price_per_kg||0); return s+base*(x.gst||0)/100; },0);
    const billsTaxable = (billsR.data||[]).reduce((s,x)=>s+(x.amount||0),0);
    const billsGst     = (billsR.data||[]).reduce((s,x)=>s+(x.gst_amount||0),0);

    const itcGst  = round2(procGst + billsGst);
    const itcCgst = round2(itcGst / 2);
    const itcSgst = round2(itcGst / 2);
    const netPayable = round2(outGst - itcGst);

    // Try to get existing GSTR-3B from Zoho
    let zohoGstr3b = null;
    try {
      const gstReturns = await zoho('get', '/gstreturn', null, { organization_id: process.env.ZOHO_ORG_ID, return_type: 'gstr3b', from_date: start, to_date: end });
      zohoGstr3b = (gstReturns?.gst_returns || [])[0] || null;
    } catch(e) { /* may not exist yet */ }

    auditLog('gst_return', `gstr3b-${y}-${m}`, 'push', req.user?.email, { out_gst: outGst, itc_gst: itcGst, net_payable: netPayable });

    res.json({
      ok: true,
      period: { year: y, month: m, month_name: ZOHO_MONTHS[m], start, end },
      table_3_1: { taxable: outTaxable, cgst: outCgst, sgst: outSgst, igst: 0, total_gst: outGst },
      table_4: { taxable: round2(procTaxable + billsTaxable), cgst: itcCgst, sgst: itcSgst, igst: 0, total_itc: itcGst },
      net_payable: netPayable,
      zoho_status: zohoGstr3b ? zohoGstr3b.status : 'pending_sync',
      zoho_return_id: zohoGstr3b?.return_id || null,
      message: zohoGstr3b
        ? `GSTR-3B for ${ZOHO_MONTHS[m]} ${y} is in Zoho Books (status: ${zohoGstr3b.status}). Review and file from Zoho Books dashboard.`
        : `GSTR-3B summary computed for ${ZOHO_MONTHS[m]} ${y}. Open Zoho Books → GST Returns → GSTR-3B to review and file with GSTN.`,
    });
  } catch(e) {
    const msg = e.response?.data?.message || e.message;
    res.status(500).json({ error: 'Zoho error: ' + msg });
  }
});

// ── GET /api/finance/inventory-value — total closing stock value across all categories ──
router.get('/inventory-value', auth, async (req, res) => {
  try {
    // 1. Packing materials: current_stock × avg_cost (or unit_price as fallback)
    const { data: packMats } = await supabase
      .from('packing_materials').select('name, current_stock, avg_cost, unit_price').eq('active', true);
    const packItems = (packMats || []).map(m => ({
      name: m.name,
      qty:  parseFloat(m.current_stock) || 0,
      rate: parseFloat(m.avg_cost) || parseFloat(m.unit_price) || 0,
      value: (parseFloat(m.current_stock)||0) * (parseFloat(m.avg_cost)||parseFloat(m.unit_price)||0),
      category: 'Packing Materials',
    })).filter(m => m.qty > 0);
    const packValue = packItems.reduce((s, m) => s + m.value, 0);

    // 2. Raw materials: current_stock × last procurement rate per commodity
    const { data: rawMats } = await supabase
      .from('raw_materials').select('id, name, category, current_stock').eq('active', true);

    const { data: procs } = await supabase.from('procurements')
      .select('commodity_name, ordered_price_per_kg, rate')
      .in('status', ['received', 'stocked', 'cleaned'])
      .order('created_at', { ascending: false });

    const rateMap = {};
    for (const p of (procs || [])) {
      const name = (p.commodity_name || '').toLowerCase().trim();
      const rate = parseFloat(p.ordered_price_per_kg || p.rate) || 0;
      if (name && rate > 0 && !rateMap[name]) rateMap[name] = rate;
    }

    const rawItems = (rawMats || []).map(m => {
      const qty  = parseFloat(m.current_stock) || 0;
      const key  = (m.name || '').toLowerCase().trim();
      const rate = rateMap[key]
        || Object.entries(rateMap).find(([k]) => k.includes(key.split(' ')[0]) || key.includes(k.split(' ')[0]))?.[1]
        || 0;
      return { name: m.name, category: 'Raw Materials', qty, rate, value: qty * rate };
    }).filter(m => m.qty > 0);
    const rawValue = rawItems.reduce((s, m) => s + m.value, 0);

    // 3. Finished goods: running balance × ~40% of selling price as cost estimate
    const { data: fgMovements } = await supabase.from('finished_goods').select('product_name, qty, type');
    const { data: products }    = await supabase.from('products').select('name, price, website_price, retail_price');

    const fgBalance = {};
    for (const r of (fgMovements || [])) {
      if (!fgBalance[r.product_name]) fgBalance[r.product_name] = 0;
      fgBalance[r.product_name] += r.type === 'out' ? -parseFloat(r.qty) : parseFloat(r.qty);
    }
    const prodPriceMap = {};
    for (const p of (products || [])) {
      prodPriceMap[p.name] = parseFloat(p.price || p.website_price || p.retail_price) || 0;
    }

    const fgItems = Object.entries(fgBalance).map(([name, balance]) => {
      const qty      = Math.max(0, balance);
      const costRate = (prodPriceMap[name] || 0) * 0.4; // ~40% cost ratio estimate
      return { name, category: 'Finished Goods', qty, rate: Math.round(costRate), value: qty * costRate };
    }).filter(m => m.qty > 0 && m.value > 0);
    const fgValue = fgItems.reduce((s, m) => s + m.value, 0);

    res.json({
      total: Math.round(packValue + rawValue + fgValue),
      packing_materials: { value: Math.round(packValue), items: packItems },
      raw_materials:     { value: Math.round(rawValue),  items: rawItems },
      finished_goods:    { value: Math.round(fgValue),   items: fgItems },
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// P&L STATEMENT
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/pnl', auth, async (req, res) => {
  try {
    const year  = parseInt(req.query.year)  || new Date().getFullYear();
    const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
    const start = `${year}-${String(month).padStart(2,'0')}-01`;
    const end   = new Date(year, month, 0).toISOString().slice(0,10);

    const [salesR, wsR, b2bR, procR, billsR, expR, payrollR] = await Promise.all([
      supabase.from('sales').select('final_amount,total_amount,items').eq('status','paid').gte('date',start).lte('date',end),
      supabase.from('webstore_orders').select('subtotal,gst,total').in('status',['confirmed','shipped','delivered']).gte('date',start).lte('date',end),
      supabase.from('b2b_orders').select('total_value').in('stage',['shipped','delivered','invoice_sent','invoice_paid']).gte('created_at',start+'T00:00:00').lte('created_at',end+'T23:59:59'),
      supabase.from('procurements').select('ordered_qty,ordered_price_per_kg,gst').in('status',['received','stocked','cleaned']).gte('order_date',start).lte('order_date',end),
      supabase.from('vendor_bills').select('amount,gst_amount,category').is('deleted_at',null).neq('status','cancelled').gte('bill_date',start).lte('bill_date',end),
      supabase.from('expenses').select('amount,category').gte('date',start).lte('date',end),
      supabase.from('payroll_records').select('net_salary').gte('month',start).lte('month',end),
    ]);

    const salesRev  = (salesR.data||[]).reduce((s,x)=>s+(parseFloat(x.final_amount||x.total_amount)||0),0);
    const wsRev     = (wsR.data||[]).reduce((s,x)=>s+(parseFloat(x.subtotal)||0),0);
    const b2bRev    = (b2bR.data||[]).reduce((s,x)=>s+(parseFloat(x.total_value)||0),0);
    const totalRev  = round2(salesRev + wsRev + b2bRev);

    const procCost  = (procR.data||[]).reduce((s,x)=>s+(parseFloat(x.ordered_qty||0)*parseFloat(x.ordered_price_per_kg||0)),0);
    const grossProfit = round2(totalRev - procCost);

    // Operating expenses by category
    const opexMap = {};
    for (const b of (billsR.data||[])) { const c=b.category||'General'; opexMap[c]=(opexMap[c]||0)+round2((b.amount||0)+(b.gst_amount||0)); }
    for (const e of (expR.data||[]))   { const c=e.category||'General'; opexMap[c]=(opexMap[c]||0)+round2(e.amount||0); }
    const payrollTotal = (payrollR.data||[]).reduce((s,x)=>s+(parseFloat(x.net_salary)||0),0);
    if (payrollTotal > 0) opexMap['Salaries & Wages'] = round2((opexMap['Salaries & Wages']||0) + payrollTotal);
    const totalOpex = round2(Object.values(opexMap).reduce((s,v)=>s+v,0));
    const netProfit = round2(grossProfit - totalOpex);

    res.json({
      period: { year, month, start, end },
      revenue: { retail_sales: round2(salesRev), webstore: round2(wsRev), b2b: round2(b2bRev), total: totalRev },
      cogs: { raw_materials: round2(procCost), total: round2(procCost) },
      gross_profit: grossProfit,
      gross_margin_pct: totalRev > 0 ? round2((grossProfit/totalRev)*100) : 0,
      opex: opexMap,
      total_opex: totalOpex,
      net_profit: netProfit,
      net_margin_pct: totalRev > 0 ? round2((netProfit/totalRev)*100) : 0,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENT APPROVALS
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/payables/pending-approvals', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('vendor_bills')
      .select('*').eq('approval_status','pending').is('deleted_at',null).order('created_at',{ascending:false});
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/payables/:id/approve', auth, async (req, res) => {
  try {
    const { approved, notes } = req.body;
    const status = approved ? 'approved' : 'rejected';
    const { error } = await supabase.from('vendor_bills').update({
      approval_status: status, approved_by: req.user?.name || req.user?.email || '',
      approval_notes: notes || '', updated_at: new Date().toISOString(),
    }).eq('id', req.params.id);
    if (error) return res.status(400).json({ error: error.message });
    auditLog('vendor_bill', req.params.id, `approval_${status}`, req.user?.email, { notes });
    res.json({ ok: true, approval_status: status });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/payables/:id/request-approval', auth, async (req, res) => {
  try {
    const { error } = await supabase.from('vendor_bills').update({
      approval_status: 'pending', updated_at: new Date().toISOString(),
    }).eq('id', req.params.id);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TDS PAYMENTS
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/tds/payments', auth, async (req, res) => {
  try {
    const { fy_start } = req.query;
    let q = supabase.from('tds_payments').select('*').order('date',{ascending:false});
    if (fy_start) q = q.gte('date', fy_start);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/tds/payments', auth, async (req, res) => {
  try {
    const { vendor_name, amount, period, section, bank_account_id, date, reference } = req.body;
    if (!vendor_name || !amount || !date) return res.status(400).json({ error: 'vendor_name, amount and date required' });
    const amt = round2(amount);
    const { data, error } = await supabase.from('tds_payments').insert({
      vendor_name, amount: amt, period: period||'', section: section||'194C',
      bank_account_id: bank_account_id||null, date, reference: reference||'',
      created_by: req.user?.email||'',
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    if (bank_account_id) {
      await supabase.from('bank_transactions').insert({
        bank_account_id, date, type:'debit', amount: amt,
        description: `TDS payment — ${vendor_name} (${section||'194C'})`,
        reference: reference||'', category:'TDS Payment', created_by: req.user?.email||'',
      });
      await adjustBalance(bank_account_id, -amt);
    }
    res.status(201).json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIT LOG
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/audit-log', auth, async (req, res) => {
  try {
    const { entity_type, limit=100, offset=0 } = req.query;
    let q = supabase.from('finance_audit_log').select('*').order('created_at',{ascending:false}).limit(parseInt(limit)).range(parseInt(offset), parseInt(offset)+parseInt(limit)-1);
    if (entity_type) q = q.eq('entity_type', entity_type);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CHART OF ACCOUNTS
// ═══════════════════════════════════════════════════════════════════════════════
const DEFAULT_COA = [
  // Assets
  { code:'1000', name:'Cash in Hand',          type:'Asset',     subtype:'Current Asset',  normal:'debit' },
  { code:'1010', name:'Petty Cash',             type:'Asset',     subtype:'Current Asset',  normal:'debit' },
  { code:'1100', name:'Bank - Current Account', type:'Asset',     subtype:'Current Asset',  normal:'debit' },
  { code:'1110', name:'Bank - Savings Account', type:'Asset',     subtype:'Current Asset',  normal:'debit' },
  { code:'1200', name:'Accounts Receivable',    type:'Asset',     subtype:'Current Asset',  normal:'debit' },
  { code:'1300', name:'Inventory - Raw Materials',    type:'Asset', subtype:'Current Asset', normal:'debit' },
  { code:'1310', name:'Inventory - Finished Goods',   type:'Asset', subtype:'Current Asset', normal:'debit' },
  { code:'1320', name:'Inventory - Packing Materials',type:'Asset', subtype:'Current Asset', normal:'debit' },
  { code:'1400', name:'Prepaid Expenses',       type:'Asset',     subtype:'Current Asset',  normal:'debit' },
  { code:'1500', name:'Plant & Machinery',      type:'Asset',     subtype:'Fixed Asset',    normal:'debit' },
  { code:'1510', name:'Furniture & Fixtures',   type:'Asset',     subtype:'Fixed Asset',    normal:'debit' },
  { code:'1520', name:'Vehicles',               type:'Asset',     subtype:'Fixed Asset',    normal:'debit' },
  { code:'1590', name:'Accumulated Depreciation',type:'Asset',    subtype:'Contra Asset',   normal:'credit' },
  // Liabilities
  { code:'2000', name:'Accounts Payable',       type:'Liability', subtype:'Current Liability', normal:'credit' },
  { code:'2100', name:'GST Payable',            type:'Liability', subtype:'Current Liability', normal:'credit' },
  { code:'2110', name:'TDS Payable',            type:'Liability', subtype:'Current Liability', normal:'credit' },
  { code:'2200', name:'Salary Payable',         type:'Liability', subtype:'Current Liability', normal:'credit' },
  { code:'2300', name:'Short-term Loan',        type:'Liability', subtype:'Current Liability', normal:'credit' },
  { code:'2400', name:'Long-term Loan',         type:'Liability', subtype:'Long-term Liability', normal:'credit' },
  { code:'2500', name:'Deferred Revenue',       type:'Liability', subtype:'Current Liability', normal:'credit' },
  // Equity
  { code:'3000', name:'Share Capital',          type:'Equity',    subtype:'Equity',         normal:'credit' },
  { code:'3100', name:'Retained Earnings',      type:'Equity',    subtype:'Equity',         normal:'credit' },
  { code:'3200', name:'Owner\'s Drawings',      type:'Equity',    subtype:'Equity',         normal:'debit'  },
  // Revenue
  { code:'4000', name:'Sales Revenue - Retail', type:'Revenue',   subtype:'Operating Revenue', normal:'credit' },
  { code:'4010', name:'Sales Revenue - Webstore',type:'Revenue',  subtype:'Operating Revenue', normal:'credit' },
  { code:'4020', name:'Sales Revenue - B2B',    type:'Revenue',   subtype:'Operating Revenue', normal:'credit' },
  { code:'4100', name:'Other Income',           type:'Revenue',   subtype:'Other Income',   normal:'credit' },
  // COGS
  { code:'5000', name:'Raw Material Cost',      type:'Expense',   subtype:'COGS',           normal:'debit' },
  { code:'5100', name:'Direct Labour',          type:'Expense',   subtype:'COGS',           normal:'debit' },
  { code:'5200', name:'Manufacturing Overhead', type:'Expense',   subtype:'COGS',           normal:'debit' },
  // Operating Expenses
  { code:'6000', name:'Salaries & Wages',       type:'Expense',   subtype:'Operating Expense', normal:'debit' },
  { code:'6100', name:'Rent',                   type:'Expense',   subtype:'Operating Expense', normal:'debit' },
  { code:'6200', name:'Utilities',              type:'Expense',   subtype:'Operating Expense', normal:'debit' },
  { code:'6300', name:'Transport & Logistics',  type:'Expense',   subtype:'Operating Expense', normal:'debit' },
  { code:'6400', name:'Marketing & Advertising',type:'Expense',   subtype:'Operating Expense', normal:'debit' },
  { code:'6500', name:'Office & Admin',         type:'Expense',   subtype:'Operating Expense', normal:'debit' },
  { code:'6600', name:'Maintenance & Repairs',  type:'Expense',   subtype:'Operating Expense', normal:'debit' },
  { code:'6700', name:'Packaging Materials',    type:'Expense',   subtype:'Operating Expense', normal:'debit' },
  { code:'6800', name:'Depreciation Expense',   type:'Expense',   subtype:'Operating Expense', normal:'debit' },
  { code:'6900', name:'Interest Expense',       type:'Expense',   subtype:'Finance Cost',   normal:'debit' },
  { code:'7000', name:'Taxes & Duties',         type:'Expense',   subtype:'Operating Expense', normal:'debit' },
  { code:'7100', name:'Miscellaneous Expense',  type:'Expense',   subtype:'Operating Expense', normal:'debit' },
];

router.get('/coa', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('chart_of_accounts').select('*').order('code');
    if (!data || data.length === 0) {
      // Seed defaults
      const { data: seeded } = await supabase.from('chart_of_accounts').insert(DEFAULT_COA).select();
      return res.json(seeded || DEFAULT_COA);
    }
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/coa', auth, async (req, res) => {
  try {
    const { code, name, type, subtype, normal } = req.body;
    if (!code || !name || !type) return res.status(400).json({ error: 'code, name, type required' });
    const { data, error } = await supabase.from('chart_of_accounts').insert({ code, name, type, subtype: subtype||type, normal: normal||'debit' }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/coa/:id', auth, async (req, res) => {
  try {
    const { name, subtype, normal, active } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (subtype !== undefined) updates.subtype = subtype;
    if (normal !== undefined) updates.normal = normal;
    if (active !== undefined) updates.active = active;
    const { data, error } = await supabase.from('chart_of_accounts').update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRIAL BALANCE
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/trial-balance', auth, async (req, res) => {
  try {
    const { as_of } = req.query;
    const cutoff = as_of || new Date().toISOString().slice(0, 10);

    // Get journal entry IDs up to cutoff date
    const { data: jeRows } = await supabase.from('journal_entries').select('id').lte('date', cutoff);
    const jeIds = (jeRows||[]).map(r=>r.id);
    if (!jeIds.length) return res.json({ as_of: cutoff, rows: [], totalDebit: 0, totalCredit: 0, balanced: true });

    // Aggregate journal line debits/credits per account code
    const { data: lines } = await supabase.from('journal_lines').select('account_code,account_name,debit,credit').in('journal_id', jeIds);

    const accounts = {};
    for (const l of lines || []) {
      const k = l.account_code || l.account_name || '?';
      if (!accounts[k]) accounts[k] = { code: l.account_code, name: l.account_name, debit: 0, credit: 0 };
      accounts[k].debit  += round2(l.debit  || 0);
      accounts[k].credit += round2(l.credit || 0);
    }

    const rows = Object.values(accounts).map(a => ({
      ...a,
      net: round2(a.debit - a.credit),
    })).sort((a,b) => (a.code||'').localeCompare(b.code||''));

    const totalDebit  = round2(rows.reduce((s,r) => s + r.debit, 0));
    const totalCredit = round2(rows.reduce((s,r) => s + r.credit, 0));

    res.json({ as_of: cutoff, rows, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BALANCE SHEET (synthesised from GL + operational data)
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/balance-sheet', auth, async (req, res) => {
  try {
    const { as_of } = req.query;
    const cutoff = as_of || new Date().toISOString().slice(0, 10);
    const yearStart = cutoff.slice(0,4) + '-04-01'; // Indian FY starts April

    const [bankRes, arB2b, arWebstore, apRes, invRes, salaryRes, loanRes, expensesRes, revenueRes, cogRes] = await Promise.all([
      // Cash & Bank
      supabase.from('bank_accounts').select('name,current_balance').eq('is_active', true),
      // AR — B2B outstanding
      supabase.from('b2b_orders').select('total_value,stage').not('stage','eq','delivered').lte('created_at', cutoff + 'T23:59:59Z'),
      // AR — Webstore unpaid/confirmed
      supabase.from('webstore_orders').select('total').in('status',['confirmed','packed','shipped']).lte('date', cutoff),
      // AP — Vendor bills unpaid
      supabase.from('vendor_bills').select('amount,gst_amount,paid_amount').in('status',['unpaid','partial','overdue']).is('deleted_at',null).lte('bill_date', cutoff),
      // Inventory value
      supabase.from('settings').select('value').eq('key','inventory_valuation_snapshot').maybeSingle(),
      // Salary payable (unpaid payroll current month)
      supabase.from('payroll').select('net_salary,status').eq('status','pending').gte('month', cutoff.slice(0,7) + '-01').lte('month', cutoff),
      // Loans (table may not exist yet — gracefully ignore)
      supabase.from('loans').select('outstanding_balance,type').eq('active', true).then(r=>r).catch(()=>({data:[]})),
      // Expenses YTD
      supabase.from('company_expenses').select('amount,category').gte('date', yearStart).lte('date', cutoff).is('deleted_at',null),
      // Revenue YTD
      supabase.from('sales').select('final_amount,channel').gte('date', yearStart).lte('date', cutoff).eq('status','delivered'),
      // COGS — procurement cost YTD
      supabase.from('procurements').select('total_amount').gte('order_date', yearStart).lte('order_date', cutoff).eq('status','processed'),
    ]);

    const cashTotal = round2((bankRes.data||[]).reduce((s,b) => s + parseFloat(b.current_balance||0), 0));
    const arB2bTotal = round2((arB2b.data||[]).reduce((s,o) => s + parseFloat(o.total_value||0), 0));
    const arWebTotal = round2((arWebstore.data||[]).reduce((s,o) => s + parseFloat(o.total||0), 0));
    const apTotal   = round2((apRes.data||[]).reduce((s,b) => s + round2((b.amount||0) + (b.gst_amount||0) - (b.paid_amount||0)), 0));
    const invValue  = invRes.data?.value?.total || 0;
    const salaryPayable = round2((salaryRes.data||[]).reduce((s,p) => s + parseFloat(p.net_salary||0), 0));
    const shortTermLoans = round2((loanRes.data||[]).filter(l=>l.type==='short-term').reduce((s,l)=>s+parseFloat(l.outstanding_balance||0),0));
    const longTermLoans  = round2((loanRes.data||[]).filter(l=>l.type==='long-term').reduce((s,l)=>s+parseFloat(l.outstanding_balance||0),0));

    // Fixed assets (table may not exist yet)
    let faRows = [];
    try { const r = await supabase.from('fixed_assets').select('purchase_cost,accumulated_depreciation').eq('active', true).lte('purchase_date', cutoff); faRows = r.data||[]; } catch(e) {}
    const faGross = round2((faRows||[]).reduce((s,a)=>s+parseFloat(a.purchase_cost||0),0));
    const faAccumDep = round2((faRows||[]).reduce((s,a)=>s+parseFloat(a.accumulated_depreciation||0),0));
    const faNet   = round2(faGross - faAccumDep);

    const revenueYTD = round2((revenueRes.data||[]).reduce((s,r)=>s+parseFloat(r.final_amount||0),0));
    const cogsYTD    = round2((cogRes.data||[]).reduce((s,p)=>s+parseFloat(p.total_amount||0),0));
    const expYTD     = round2((expensesRes.data||[]).reduce((s,e)=>s+parseFloat(e.amount||0),0));
    const netProfitYTD = round2(revenueYTD - cogsYTD - expYTD);

    const totalCurrentAssets  = round2(cashTotal + arB2bTotal + arWebTotal + invValue);
    const totalFixedAssets     = faNet;
    const totalAssets          = round2(totalCurrentAssets + totalFixedAssets);
    const totalCurrentLiab     = round2(apTotal + salaryPayable + shortTermLoans);
    const totalLongTermLiab    = longTermLoans;
    const retainedEarnings     = netProfitYTD;
    const totalEquity          = retainedEarnings; // simplified (no share capital tracking yet)
    const totalLiabAndEquity   = round2(totalCurrentLiab + totalLongTermLiab + totalEquity);

    res.json({
      as_of: cutoff,
      assets: {
        current: {
          cash:           cashTotal,
          accounts_receivable_b2b: arB2bTotal,
          accounts_receivable_web: arWebTotal,
          inventory:      invValue,
          total:          totalCurrentAssets,
        },
        fixed: {
          gross:          faGross,
          accum_dep:      faAccumDep,
          net:            faNet,
          total:          totalFixedAssets,
        },
        total: totalAssets,
      },
      liabilities: {
        current: {
          accounts_payable: apTotal,
          salary_payable:   salaryPayable,
          short_term_loans: shortTermLoans,
          total:            totalCurrentLiab,
        },
        long_term: {
          loans: longTermLoans,
          total: totalLongTermLiab,
        },
        total: round2(totalCurrentLiab + totalLongTermLiab),
      },
      equity: {
        retained_earnings_ytd: retainedEarnings,
        total: totalEquity,
      },
      total_liabilities_and_equity: totalLiabAndEquity,
      balanced: Math.abs(totalAssets - totalLiabAndEquity) < 100,
      revenue_ytd: revenueYTD,
      cogs_ytd:    cogsYTD,
      expenses_ytd: expYTD,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// FIXED ASSETS & DEPRECIATION
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/fixed-assets', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('fixed_assets').select('*').order('purchase_date', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/fixed-assets', auth, async (req, res) => {
  try {
    const { name, category, purchase_date, purchase_cost, useful_life_years, method, salvage_value, notes } = req.body;
    if (!name || !purchase_date || !purchase_cost) return res.status(400).json({ error: 'name, purchase_date, purchase_cost required' });
    const cost = round2(purchase_cost);
    const salvage = round2(salvage_value || 0);
    const life = parseInt(useful_life_years) || 5;
    const annualDep = method === 'wdv'
      ? round2(cost * 0.2) // 20% WDV (Written Down Value — common in India)
      : round2((cost - salvage) / life); // Straight Line
    const { data, error } = await supabase.from('fixed_assets').insert({
      name, category: category||'Equipment', purchase_date, purchase_cost: cost,
      salvage_value: salvage, useful_life_years: life, method: method||'slm',
      annual_depreciation: annualDep, accumulated_depreciation: 0, book_value: cost,
      active: true, notes: notes||'',
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/fixed-assets/:id', auth, async (req, res) => {
  try {
    const allowed = ['name','category','notes','active','disposal_date','disposal_value'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    if (req.body.disposal_date) {
      updates.active = false;
      updates.disposal_value = round2(req.body.disposal_value || 0);
    }
    const { data, error } = await supabase.from('fixed_assets').update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /fixed-assets/run-depreciation — runs monthly depreciation for all active assets
router.post('/fixed-assets/run-depreciation', auth, async (req, res) => {
  try {
    const { month } = req.body; // 'YYYY-MM'
    if (!month) return res.status(400).json({ error: 'month required (YYYY-MM)' });
    const { data: assets } = await supabase.from('fixed_assets').select('*').eq('active', true);
    if (!assets?.length) return res.json({ processed: 0 });

    const results = [];
    for (const asset of assets) {
      if (asset.accumulated_depreciation >= (asset.purchase_cost - (asset.salvage_value||0))) continue;
      const monthly = round2(asset.annual_depreciation / 12);
      const maxMore = round2((asset.purchase_cost - (asset.salvage_value||0)) - asset.accumulated_depreciation);
      const depAmt  = Math.min(monthly, maxMore);
      const newAccum = round2((asset.accumulated_depreciation||0) + depAmt);
      const newBook  = round2(asset.purchase_cost - newAccum);

      await supabase.from('fixed_assets').update({ accumulated_depreciation: newAccum, book_value: newBook }).eq('id', asset.id);

      // Create journal entry for depreciation
      const { data: je } = await supabase.from('journal_entries').insert({
        date: month + '-01', ref_no: `DEP-${month}-${asset.id.slice(0,6)}`,
        description: `Depreciation — ${asset.name} (${month})`,
        total_amount: depAmt, created_by: req.user?.email||'system',
      }).select().single();

      if (je?.id) {
        await supabase.from('journal_lines').insert([
          { journal_id: je.id, account_code:'6800', account_name:'Depreciation Expense', debit: depAmt, credit: 0 },
          { journal_id: je.id, account_code:'1590', account_name:'Accumulated Depreciation', debit: 0, credit: depAmt },
        ]);
      }
      results.push({ asset: asset.name, amount: depAmt });
    }
    res.json({ processed: results.length, entries: results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// LOAN MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/loans', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('loans').select('*').order('disbursement_date', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/loans', auth, async (req, res) => {
  try {
    const { name, lender, type, principal, interest_rate, tenure_months, disbursement_date, emi, bank_account_id, notes } = req.body;
    if (!name || !principal || !disbursement_date) return res.status(400).json({ error: 'name, principal, disbursement_date required' });
    const p = round2(principal);
    const r = parseFloat(interest_rate || 0);
    const n = parseInt(tenure_months || 12);
    // Calculate EMI if not provided: EMI = P × r/12 × (1+r/12)^n / ((1+r/12)^n - 1)
    let calcEmi = emi ? round2(emi) : 0;
    if (!calcEmi && r > 0) {
      const monthlyR = r / 100 / 12;
      calcEmi = round2(p * monthlyR * Math.pow(1+monthlyR, n) / (Math.pow(1+monthlyR, n) - 1));
    } else if (!calcEmi) {
      calcEmi = round2(p / n);
    }
    const { data, error } = await supabase.from('loans').insert({
      name, lender: lender||'', type: type||'long-term', principal: p,
      interest_rate: r, tenure_months: n, emi: calcEmi,
      outstanding_balance: p, disbursement_date, bank_account_id: bank_account_id||null,
      active: true, notes: notes||'',
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/loans/:id', auth, async (req, res) => {
  try {
    const allowed = ['name','lender','notes','active'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    const { data, error } = await supabase.from('loans').update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/loans/:id/schedule', auth, async (req, res) => {
  try {
    const { data: loan } = await supabase.from('loans').select('*').eq('id', req.params.id).single();
    if (!loan) return res.status(404).json({ error: 'Loan not found' });
    const { data: payments } = await supabase.from('loan_payments').select('*').eq('loan_id', req.params.id).order('payment_date');

    const schedule = [];
    let balance = round2(loan.principal);
    const monthlyR = (loan.interest_rate / 100) / 12;
    const paidSet = new Set((payments||[]).map(p => p.period));

    let d = new Date(loan.disbursement_date);
    for (let i = 1; i <= loan.tenure_months; i++) {
      d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      const period = d.toISOString().slice(0,7);
      const interest = round2(balance * monthlyR);
      const principal_part = round2(Math.min(loan.emi - interest, balance));
      balance = round2(Math.max(0, balance - principal_part));
      schedule.push({
        installment: i, period, emi: loan.emi,
        principal_part, interest_part: interest, closing_balance: balance,
        paid: paidSet.has(period),
      });
      if (balance === 0) break;
    }
    res.json({ loan, schedule, payments: payments||[] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/loans/:id/payments', auth, async (req, res) => {
  try {
    const { period, principal_paid, interest_paid, date, bank_account_id, reference } = req.body;
    if (!period || !date) return res.status(400).json({ error: 'period, date required' });
    const pp = round2(principal_paid || 0);
    const ip = round2(interest_paid  || 0);
    const { data, error } = await supabase.from('loan_payments').insert({
      loan_id: req.params.id, period, principal_paid: pp, interest_paid: ip,
      total_paid: round2(pp+ip), payment_date: date, bank_account_id: bank_account_id||null,
      reference: reference||'', created_by: req.user?.email||'',
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    // Reduce outstanding balance
    const { data: loanCurrent } = await supabase.from('loans').select('outstanding_balance').eq('id', req.params.id).single();
    const newBalance = round2((loanCurrent?.outstanding_balance||0) - pp);
    await supabase.from('loans').update({ outstanding_balance: Math.max(0, newBalance) }).eq('id', req.params.id);
    // Bank transaction
    if (bank_account_id) {
      await supabase.from('bank_transactions').insert({ bank_account_id, date, type:'debit', amount: round2(pp+ip), description: `Loan EMI — ${period}`, category:'Loan Repayment', created_by: req.user?.email||'' });
      await adjustBalance(bank_account_id, -round2(pp+ip));
    }
    // Journal entry: Dr Loan A/C + Dr Interest Expense / Cr Bank
    const { data: je } = await supabase.from('journal_entries').insert({ date, ref_no:`LOAN-EMI-${period}`, description:`Loan EMI payment — ${period}`, total_amount: round2(pp+ip), created_by: req.user?.email||'' }).select().single();
    if (je?.id) {
      const lines = [{ journal_id: je.id, account_code:'2400', account_name:'Long-term Loan', debit: pp, credit: 0 }];
      if (ip > 0) lines.push({ journal_id: je.id, account_code:'6900', account_name:'Interest Expense', debit: ip, credit: 0 });
      lines.push({ journal_id: je.id, account_code:'1100', account_name:'Bank - Current Account', debit: 0, credit: round2(pp+ip) });
      await supabase.from('journal_lines').insert(lines);
    }
    res.status(201).json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BUDGET vs ACTUAL
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/budget', auth, async (req, res) => {
  try {
    const { fy } = req.query; // 'YYYY-YYYY' e.g. '2025-2026'
    let q = supabase.from('budget_lines').select('*').order('month').order('category');
    if (fy) {
      const [y1] = fy.split('-');
      q = q.gte('month', y1 + '-04-01').lte('month', (parseInt(y1)+1) + '-03-31');
    }
    const { data: budget } = await q;
    res.json(budget || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/budget', auth, async (req, res) => {
  try {
    const { month, category, budgeted_amount, notes } = req.body;
    if (!month || !category || budgeted_amount == null) return res.status(400).json({ error: 'month, category, budgeted_amount required' });
    const { data, error } = await supabase.from('budget_lines').upsert({
      month, category, budgeted_amount: round2(budgeted_amount), notes: notes||'',
      created_by: req.user?.email||'',
    }, { onConflict: 'month,category' }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/budget/variance', auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const dateFrom = from || new Date().toISOString().slice(0,7) + '-01';
    const dateTo   = to   || new Date().toISOString().slice(0,10);

    // Get budget lines for period
    const { data: budgetLines } = await supabase.from('budget_lines').select('*').gte('month', dateFrom.slice(0,7)).lte('month', dateTo.slice(0,7));

    // Get actual expenses by category
    const { data: actuals } = await supabase.from('company_expenses').select('category,amount').gte('date', dateFrom).lte('date', dateTo).is('deleted_at', null);
    // Also vendor bills (as operational costs)
    const { data: bills } = await supabase.from('vendor_bills').select('category,amount').gte('bill_date', dateFrom).lte('bill_date', dateTo).is('deleted_at', null);

    const actualByCategory = {};
    for (const e of actuals||[]) { actualByCategory[e.category] = round2((actualByCategory[e.category]||0) + parseFloat(e.amount||0)); }
    for (const b of bills||[])   { actualByCategory[b.category||'Vendor Bills'] = round2((actualByCategory[b.category||'Vendor Bills']||0) + parseFloat(b.amount||0)); }

    // Get actual revenue
    const { data: sales } = await supabase.from('sales').select('final_amount,channel').gte('date', dateFrom).lte('date', dateTo);
    const { data: wOrders } = await supabase.from('webstore_orders').select('total,channel').gte('date', dateFrom).lte('date', dateTo).in('status',['confirmed','packed','shipped','delivered']);
    const revenueActual = round2(
      (sales||[]).reduce((s,r)=>s+parseFloat(r.final_amount||0),0) +
      (wOrders||[]).reduce((s,r)=>s+parseFloat(r.total||0),0)
    );

    const rows = (budgetLines||[]).map(bl => {
      const actual = bl.category === 'Revenue' ? revenueActual : (actualByCategory[bl.category]||0);
      const variance = bl.category === 'Revenue'
        ? round2(actual - bl.budgeted_amount)        // positive = beat target
        : round2(bl.budgeted_amount - actual);        // positive = under budget (good)
      const pct = bl.budgeted_amount > 0 ? round2(variance / bl.budgeted_amount * 100) : null;
      return { ...bl, actual, variance, variance_pct: pct };
    });

    const totalBudget  = round2(rows.reduce((s,r)=>s+r.budgeted_amount,0));
    const totalActual  = round2(rows.reduce((s,r)=>s+r.actual,0));
    res.json({ rows, totalBudget, totalActual, revenue_actual: revenueActual });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DETAILED AR/AP AGING (customer & vendor breakdown)
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/ar-aging-detail', auth, async (req, res) => {
  try {
    const today = new Date();
    const { data: b2b } = await supabase.from('b2b_orders').select('id,order_no,customer_name,total_value,created_at').not('stage','eq','delivered');
    const { data: web } = await supabase.from('webstore_orders').select('id,order_no,customer,total,date').in('status',['confirmed','packed']);

    const rows = [];
    for (const o of b2b||[]) {
      const days = Math.floor((today - new Date(o.created_at)) / 86400000);
      rows.push({ id:o.id, ref:o.order_no, customer:o.customer_name, amount:round2(o.total_value||0), days, bucket: days<=30?'0-30':days<=60?'31-60':days<=90?'61-90':'90+', source:'B2B' });
    }
    for (const o of web||[]) {
      const days = Math.floor((today - new Date(o.date)) / 86400000);
      const cust = typeof o.customer === 'object' ? (o.customer?.name||'Guest') : 'Guest';
      rows.push({ id:o.id, ref:o.order_no, customer:cust, amount:round2(o.total||0), days, bucket: days<=30?'0-30':days<=60?'31-60':days<=90?'61-90':'90+', source:'Webstore' });
    }

    // Group by customer for summary
    const byCustomer = {};
    for (const r of rows) {
      if (!byCustomer[r.customer]) byCustomer[r.customer] = { customer: r.customer, total: 0, oldest: 0, invoices: 0 };
      byCustomer[r.customer].total   += r.amount;
      byCustomer[r.customer].oldest   = Math.max(byCustomer[r.customer].oldest, r.days);
      byCustomer[r.customer].invoices += 1;
    }

    const buckets = { '0-30':0, '31-60':0, '61-90':0, '90+':0 };
    for (const r of rows) buckets[r.bucket] = round2((buckets[r.bucket]||0) + r.amount);

    res.json({ rows: rows.sort((a,b)=>b.days-a.days), byCustomer: Object.values(byCustomer).sort((a,b)=>b.total-a.total), buckets, total: round2(rows.reduce((s,r)=>s+r.amount,0)) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/ap-aging-detail', auth, async (req, res) => {
  try {
    const today = new Date();
    const { data: bills } = await supabase.from('vendor_bills').select('id,bill_no,vendor_name,amount,gst_amount,paid_amount,due_date,bill_date,category').in('status',['unpaid','partial','overdue']).is('deleted_at',null);

    const rows = (bills||[]).map(b => {
      const outstanding = round2((b.amount||0) + (b.gst_amount||0) - (b.paid_amount||0));
      const daysOverdue = b.due_date ? Math.max(0, Math.floor((today - new Date(b.due_date)) / 86400000)) : 0;
      const daysOld     = Math.floor((today - new Date(b.bill_date)) / 86400000);
      return {
        id: b.id, ref: b.bill_no||'—', vendor: b.vendor_name, outstanding, due_date: b.due_date,
        days_overdue: daysOverdue, days_old: daysOld, category: b.category||'—',
        bucket: daysOverdue===0?'current':daysOverdue<=30?'0-30':daysOverdue<=60?'31-60':daysOverdue<=90?'61-90':'90+',
      };
    });

    const byVendor = {};
    for (const r of rows) {
      if (!byVendor[r.vendor]) byVendor[r.vendor] = { vendor: r.vendor, total: 0, oldest: 0, invoices: 0 };
      byVendor[r.vendor].total    += r.outstanding;
      byVendor[r.vendor].oldest    = Math.max(byVendor[r.vendor].oldest, r.days_overdue);
      byVendor[r.vendor].invoices += 1;
    }

    const buckets = { current:0, '0-30':0, '31-60':0, '61-90':0, '90+':0 };
    for (const r of rows) buckets[r.bucket] = round2((buckets[r.bucket]||0) + r.outstanding);

    res.json({ rows: rows.sort((a,b)=>b.days_overdue-a.days_overdue), byVendor: Object.values(byVendor).sort((a,b)=>b.total-a.total), buckets, total: round2(rows.reduce((s,r)=>s+r.outstanding,0)) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
