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
    res.status(201).json({ ...data, total_amount: round2((data.amount||0)+(data.gst_amount||0)), balance: round2((data.amount||0)+(data.gst_amount||0)), payments:[] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/payables/:id', auth, async (req, res) => {
  try {
    const fields = ['vendor_name','vendor_gst','bill_no','bill_date','due_date','amount','gst_amount','category','notes'];
    const updates = {};
    for (const f of fields) if (req.body[f] !== undefined) updates[f] = f === 'amount' || f === 'gst_amount' ? round2(req.body[f]) : req.body[f];
    updates.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from('vendor_bills').update(updates).eq('id', req.params.id).is('deleted_at',null).select().single();
    if (error) return res.status(400).json({ error: error.message });
    await refreshBillStatus(req.params.id);
    const upd = await supabase.from('vendor_bills').select('*').eq('id', req.params.id).single();
    res.json({ ...upd.data, total_amount: round2((upd.data.amount||0)+(upd.data.gst_amount||0)), balance: round2((upd.data.amount||0)+(upd.data.gst_amount||0)-(upd.data.paid_amount||0)) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/payables/:id', auth, async (req, res) => {
  try {
    await supabase.from('vendor_bills').update({ deleted_at: new Date().toISOString() }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/payables/:id/payments', auth, async (req, res) => {
  try {
    const billId = parseInt(req.params.id);
    const { date, amount, mode, reference, bank_account_id, notes } = req.body;
    const amt = round2(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

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

    res.status(201).json({ ...entry, lines: jLines });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/journal/:id', auth, async (req, res) => {
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

module.exports = router;
