const express  = require('express');
const router   = express.Router();
const { auth } = require('../middleware/auth');
const supabase  = require('../config/supabase');

// monitor-api runs on the host — backend is in Docker, cannot exec scripts directly
const MONITOR_API = 'http://host.docker.internal:9191';

// Only admin/CEO/accountant can access
const allowedRoles = ['admin', 'ceo', 'accountant', 'manager'];
function roleGuard(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const role = (req.user.role || '').toLowerCase();
  if (!allowedRoles.includes(role)) return res.status(403).json({ error: 'Access denied' });
  next();
}

// GET /api/ca-agent/findings — list findings with filters
router.get('/findings', auth, roleGuard, async (req, res) => {
  try {
    const { severity, category, resolved, run_id, limit = 100 } = req.query;

    let q = supabase.from('ca_agent_findings').select('*').order('created_at', { ascending: false }).limit(parseInt(limit) || 100);

    if (severity)  q = q.eq('severity', severity);
    if (category)  q = q.eq('category', category);
    if (run_id)    q = q.eq('run_id', run_id);
    if (resolved !== undefined) q = q.eq('resolved', resolved === 'true');

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    // Summary counts for unresolved
    const unresolved = (data || []).filter(f => !f.resolved);
    const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of unresolved) if (f.severity in counts) counts[f.severity]++;

    res.json({ findings: data || [], counts, total: (data || []).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ca-agent/runs — list distinct run_ids with summary
router.get('/runs', auth, roleGuard, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ca_agent_findings')
      .select('run_id,created_at,severity')
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) return res.status(500).json({ error: error.message });

    // Group by run_id
    const runsMap = {};
    for (const f of (data || [])) {
      if (!runsMap[f.run_id]) {
        runsMap[f.run_id] = { run_id: f.run_id, created_at: f.created_at, counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, total: 0 };
      }
      if (f.severity in runsMap[f.run_id].counts) runsMap[f.run_id].counts[f.severity]++;
      runsMap[f.run_id].total++;
    }

    const runs = Object.values(runsMap).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 30);
    res.json({ runs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/ca-agent/findings/:id/resolve — mark as resolved
router.patch('/findings/:id/resolve', auth, roleGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const { resolved = true } = req.body;
    const { error } = await supabase
      .from('ca_agent_findings')
      .update({
        resolved,
        resolved_by: resolved ? (req.user?.email || req.user?.name || 'Unknown') : null,
        resolved_at: resolved ? new Date().toISOString() : null,
      })
      .eq('id', id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ca-agent/report — comprehensive CA financial report
// ─────────────────────────────────────────────────────────────────────────────
router.get('/report', auth, roleGuard, async (req, res) => {
  try {
    const today        = new Date();
    const todayStr     = today.toISOString().slice(0, 10);
    const fyStart      = (() => { const yr = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear()-1; return `${yr}-04-01`; })();
    const monthStart   = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
    const lastMStart   = new Date(today.getFullYear(), today.getMonth()-1, 1).toISOString().slice(0, 10);
    const lastMEnd     = new Date(today.getFullYear(), today.getMonth(), 0).toISOString().slice(0, 10);
    const ago30        = new Date(Date.now() - 30*86400000).toISOString().slice(0, 10);
    const ago90        = new Date(Date.now() - 90*86400000).toISOString().slice(0, 10);
    const round2       = n => Math.round((parseFloat(n)||0)*100)/100;

    // Revenue-eligible sales statuses (delivered/dispatched = fulfilled; pending with amount_paid = cash collected)
    const REV_STATUSES = ['delivered','dispatched'];

    const [
      bankAccs, bankTxns, bills, b2bOrders, wsOrders,
      sales, wsRevenue, expenses, expensesLast,
      procurements, findingsLatest,
      salesLast, wsRevLast, salesFY,
    ] = await Promise.all([
      supabase.from('bank_accounts').select('id,name,type,current_balance,account_number,bank_name').eq('is_active',true),
      supabase.from('bank_transactions').select('id,date,type,amount,description,category,reconciled,bank_account_id').gte('date', ago90).order('date',{ascending:false}).limit(500),
      supabase.from('vendor_bills').select('id,bill_no,vendor_name,amount,gst_amount,paid_amount,due_date,bill_date,status,category').is('deleted_at',null).in('status',['unpaid','partial','overdue']).order('due_date',{ascending:true}).limit(300),
      supabase.from('b2b_orders').select('id,order_no,customer_name,total_value,created_at,stage').not('stage','in','("delivered","cancelled","invoice_paid")').order('created_at',{ascending:true}).limit(300),
      supabase.from('webstore_orders').select('id,order_no,customer,total,date,status').in('status',['confirmed','processing']).order('date',{ascending:true}).limit(200),
      supabase.from('sales').select('id,order_no,customer_name,final_amount,date,status,payment_method').in('status',REV_STATUSES).gte('date',monthStart),
      supabase.from('webstore_orders').select('id,total,date').in('status',['confirmed','packed','shipped','delivered']).gte('date',monthStart),
      supabase.from('company_expenses').select('id,date,category,amount,vendor_name,description,payment_mode').gte('date',monthStart).is('deleted_at',null).order('amount',{ascending:false}).limit(200),
      supabase.from('company_expenses').select('amount,category').gte('date',lastMStart).lte('date',lastMEnd).is('deleted_at',null),
      supabase.from('procurements').select('supplier,ordered_qty,ordered_price_per_kg,date,commodity_name,gst').gte('date',fyStart).limit(1000),
      supabase.from('ca_agent_findings').select('id,severity,category,title,detail,amount,resolved,created_at,run_id').eq('resolved',false).order('created_at',{ascending:false}).limit(50),
      supabase.from('sales').select('final_amount').in('status',REV_STATUSES).gte('date',lastMStart).lte('date',lastMEnd),
      supabase.from('webstore_orders').select('total').in('status',['confirmed','packed','shipped','delivered']).gte('date',lastMStart).lte('date',lastMEnd),
      supabase.from('sales').select('final_amount,date').in('status',REV_STATUSES).gte('date',fyStart),
    ]);

    // ── Snapshot ───────────────────────────────────────────────────────────
    const cashBalance   = (bankAccs.data||[]).reduce((s,a)=>s+(a.current_balance||0),0);
    // Revenue = fulfilled orders (delivered/dispatched) + webstore fulfilled
    const revThisMonth  = round2((sales.data||[]).reduce((s,x)=>s+parseFloat(x.final_amount||0),0)+(wsRevenue.data||[]).reduce((s,x)=>s+parseFloat(x.total||0),0));
    const revLastMonth  = round2((salesLast.data||[]).reduce((s,x)=>s+parseFloat(x.final_amount||0),0)+(wsRevLast.data||[]).reduce((s,x)=>s+parseFloat(x.total||0),0));
    const expThisMonth  = round2((expenses.data||[]).reduce((s,e)=>s+parseFloat(e.amount||0),0));
    const expLastMonth  = round2((expensesLast.data||[]).reduce((s,e)=>s+parseFloat(e.amount||0),0));
    const billList      = bills.data||[];
    const apTotal       = round2(billList.reduce((s,b)=>s+round2((b.amount||0)+(b.gst_amount||0)-(b.paid_amount||0)),0));
    const apOverdue     = round2(billList.filter(b=>b.due_date&&b.due_date<todayStr).reduce((s,b)=>s+round2((b.amount||0)+(b.gst_amount||0)-(b.paid_amount||0)),0));
    const arTotal       = round2((b2bOrders.data||[]).reduce((s,o)=>s+(o.total_value||0),0)+(wsOrders.data||[]).reduce((s,o)=>s+(o.total||0),0));

    // ── AR Aging ───────────────────────────────────────────────────────────
    const arAging = { '0-30':0, '31-60':0, '61-90':0, '90+':0 };
    const arDetail = [];
    for (const o of (b2bOrders.data||[])) {
      const days = Math.floor((today - new Date(o.created_at))/86400000);
      const bucket = days<=30?'0-30':days<=60?'31-60':days<=90?'61-90':'90+';
      arAging[bucket] = round2(arAging[bucket]+(o.total_value||0));
      arDetail.push({ ref:o.order_no, customer:o.customer_name, amount:round2(o.total_value||0), days, bucket, date:o.created_at?.slice(0,10), source:'B2B' });
    }
    for (const o of (wsOrders.data||[])) {
      const days = Math.floor((today - new Date(o.date))/86400000);
      const bucket = days<=30?'0-30':days<=60?'31-60':days<=90?'61-90':'90+';
      arAging[bucket] = round2(arAging[bucket]+(o.total||0));
      const custName = typeof o.customer==='object' ? (o.customer?.name||'Guest') : 'Guest';
      arDetail.push({ ref:o.order_no, customer:custName, amount:round2(o.total||0), days, bucket, date:o.date, source:'Webstore' });
    }
    arDetail.sort((a,b)=>b.days-a.days);

    // ── AP Aging ───────────────────────────────────────────────────────────
    const apAging = { current:0, '0-30':0, '31-60':0, '61-90':0, '90+':0 };
    const apDetail = billList.map(b => {
      const outstanding  = round2((b.amount||0)+(b.gst_amount||0)-(b.paid_amount||0));
      const daysOverdue  = b.due_date ? Math.max(0, Math.floor((today-new Date(b.due_date))/86400000)) : 0;
      const bucket       = daysOverdue===0?'current':daysOverdue<=30?'0-30':daysOverdue<=60?'31-60':daysOverdue<=90?'61-90':'90+';
      apAging[bucket]    = round2(apAging[bucket]+outstanding);
      return { ref:b.bill_no||'—', vendor:b.vendor_name, amount:outstanding, due_date:b.due_date, days_overdue:daysOverdue, bucket, category:b.category||'—', status:b.status };
    });
    apDetail.sort((a,b)=>b.days_overdue-a.days_overdue);

    // ── Bank reconciliation ────────────────────────────────────────────────
    const txnList       = bankTxns.data||[];
    const unreconciled  = txnList.filter(t=>!t.reconciled&&t.date<new Date(Date.now()-7*86400000).toISOString().slice(0,10));
    const unreconAmount = round2(unreconciled.reduce((s,t)=>s+parseFloat(t.amount||0),0));
    const bankDetail    = (bankAccs.data||[]).map(acc => {
      const accTxns  = txnList.filter(t=>t.bank_account_id===acc.id);
      const unrecon  = accTxns.filter(t=>!t.reconciled&&t.date<new Date(Date.now()-7*86400000).toISOString().slice(0,10));
      return { ...acc, unreconciled_count:unrecon.length, unreconciled_amount:round2(unrecon.reduce((s,t)=>s+parseFloat(t.amount||0),0)) };
    });

    // ── GST summary ────────────────────────────────────────────────────────
    // sales table has no gst_amount; estimate output GST from bank_transactions credits tagged Sales Revenue
    const salesRevBT  = (bankTxns.data||[]).filter(t=>t.type==='credit'&&t.date>=monthStart);
    const salesGST    = round2(salesRevBT.reduce((s,t)=>s+round2(parseFloat(t.amount||0)*18/118),0));
    const purchGST    = round2((procurements.data||[]).filter(p=>p.date>=monthStart).reduce((s,p)=>{
      const gstPct = parseFloat(p.gst||0);
      const amt = round2((parseFloat(p.ordered_qty)||0)*(parseFloat(p.ordered_price_per_kg)||0));
      return s+round2(amt*gstPct/100);
    },0));
    const netGST      = round2(salesGST - purchGST);

    // ── TDS liability (FY vendor-wise by category) ─────────────────────────
    const CONTRACTOR_CATS = ['Contractor','Labour','Repair','Maintenance','Carriage','Transport','Freight','Printing','Packaging Work','Civil Work','Electrical','AMC'];
    const PROF_CATS       = ['Professional Fees','Consultancy','Legal Fees','Audit Fees','Technical','Software','Advisory','CA Fees'];
    const RENT_CATS       = ['Rent','Office Rent','Godown Rent','Warehouse Rent','Lease'];
    const { data: fyBills } = await supabase.from('vendor_bills').select('vendor_name,amount,category,bill_date').gte('bill_date',fyStart).is('deleted_at',null).limit(2000);
    const tdsRows = [];
    const accum = (rows, cats, section, threshold, rate, label) => {
      const byVendor = {};
      for (const b of (rows||[]).filter(b=>cats.includes(b.category))) {
        byVendor[b.vendor_name] = round2((byVendor[b.vendor_name]||0)+parseFloat(b.amount||0));
      }
      for (const [vendor,total] of Object.entries(byVendor)) {
        const tds_due = total > threshold ? round2((total-threshold)*rate) : 0;
        tdsRows.push({ section, label, vendor, fy_total:round2(total), threshold, rate_pct:Math.round(rate*100)+'%', tds_due, exceeded:total>threshold });
      }
    };
    accum(fyBills, CONTRACTOR_CATS, '194C','Contractor/Labour',30000, 0.02, 'Contractor');
    accum(fyBills, PROF_CATS,       '194J','Professional Fees',30000, 0.10, 'Professional');
    accum(fyBills, RENT_CATS,       '194I','Rent',             240000,0.10, 'Rent');
    // 194Q: purchases from single vendor >₹50L
    const procByVendor = {};
    for (const p of (procurements.data||[])) {
      const amt = round2((parseFloat(p.ordered_qty)||0)*(parseFloat(p.ordered_price_per_kg)||0));
      procByVendor[p.supplier]=(procByVendor[p.supplier]||0)+amt;
    }
    for (const [vendor,total] of Object.entries(procByVendor)) {
      if (total > 1000000) { // show vendors >₹10L as watch
        const tds_due = total>5000000 ? round2((total-5000000)*0.001) : 0;
        tdsRows.push({ section:'194Q', label:'Purchase (Buyer TDS)', vendor, fy_total:round2(total), threshold:5000000, rate_pct:'0.1%', tds_due, exceeded:total>5000000 });
      }
    }
    tdsRows.sort((a,b)=>b.fy_total-a.fy_total);

    // ── Expense breakdown this month ────────────────────────────────────────
    const expByCat = {};
    for (const e of (expenses.data||[])) expByCat[e.category]=(expByCat[e.category]||0)+parseFloat(e.amount||0);
    const expBreakdown = Object.entries(expByCat).map(([cat,amt])=>({cat,amount:round2(amt)})).sort((a,b)=>b.amount-a.amount);

    // ── Revenue by day (last 30 days sparkline data) ────────────────────────
    const revenueByDay = {};
    for (const s of (salesFY.data||[])) {
      if (s.date >= ago30) revenueByDay[s.date] = round2((revenueByDay[s.date]||0)+parseFloat(s.final_amount||0));
    }
    const revDailyArr = [];
    for (let i=29; i>=0; i--) {
      const d = new Date(Date.now()-i*86400000).toISOString().slice(0,10);
      revDailyArr.push({ date:d, amount:revenueByDay[d]||0 });
    }

    // ── Compliance calendar ────────────────────────────────────────────────
    const month = today.getMonth()+1;
    const dom   = today.getDate();
    const complianceCalendar = [];
    const addCal = (name, dueDay, dueMonth, dueYear, section, action) => {
      const dueDate = `${dueYear}-${String(dueMonth).padStart(2,'0')}-${String(dueDay).padStart(2,'0')}`;
      const daysLeft = Math.floor((new Date(dueDate)-today)/86400000);
      const status   = daysLeft < 0 ? 'overdue' : daysLeft <= 5 ? 'urgent' : daysLeft <= 15 ? 'due-soon' : 'ok';
      complianceCalendar.push({ name, due_date:dueDate, days_left:daysLeft, status, section, action });
    };
    const yr = today.getFullYear();
    const nm = month===12?1:month+1; const ny = month===12?yr+1:yr;
    addCal('TDS Payment (Challan ITNS 281)', 7, nm, ny, 'Sec 200/201', 'Pay via Income Tax portal');
    addCal('PF/ESI Deposit (ECR)', 15, nm, ny, 'EPF/ESI Act', 'File ECR on UAN portal');
    addCal('GSTR-1 Filing', 11, nm, ny, 'GST Sec 37', 'Upload all invoices to GSTN portal');
    addCal('GSTR-3B Filing', 20, nm, ny, 'GST Sec 39', 'File self-assessed monthly return');
    if (month<=6)  addCal('Advance Tax Q1 (15%)', 15, 6, yr, 'Sec 234C', 'Pay via Challan ITNS 280');
    if (month<=9)  addCal('Advance Tax Q2 (45%)', 15, 9, yr, 'Sec 234C', 'Pay via Challan ITNS 280');
    if (month<=12) addCal('Advance Tax Q3 (75%)', 15, 12, yr, 'Sec 234C', 'Pay via Challan ITNS 280');
    addCal('Advance Tax Q4 (100%)', 15, 3, month<=3?yr:yr+1, 'Sec 234C', 'Pay via Challan ITNS 280');
    addCal('TDS Return Q (Form 26Q)', month<=7?31:month<=10?31:31, month<=7?7:month<=10?10:month<=1?1:5, month<=7?yr:month<=10?yr:month<=1?yr:yr+1, 'Sec 206', 'File on TRACES portal');
    addCal('GSTR-9 Annual Return', 31, 12, yr, 'GST Sec 44', 'Annual consolidated GST return');
    if (month>=4&&month<=11) addCal('Statutory Bonus (Bonus Act)', 30, 11, yr, 'Bonus Act Sec 19', 'Pay min 8.33% of annual salary');
    if (month>=4&&month<=9)  addCal('PT (Tamil Nadu) H1', 30, 9, yr, 'TN PT Act', 'Remit ₹1,250/employee to CT Dept');
    // ── Private Limited Company (Companies Act 2013) ───────────────────────
    addCal('MGT-7A Annual Return (Pvt Ltd)', 60, month<=9?9:month<=12?12:3, month<=9?yr:month<=12?yr:yr+1, 'Companies Act Sec 92', 'File within 60 days of AGM — MCA21 portal');
    addCal('AOC-4 Financial Statements', 30, month<=10?10:month<=1?1:4, month<=10?yr:month<=1?yr+1:yr+1, 'Companies Act Sec 137', 'File within 30 days of AGM — attach audited B/S & P&L');
    addCal('AGM (Annual General Meeting)', 30, 9, yr, 'Companies Act Sec 96', 'Hold AGM within 6 months of FY end (by 30 Sep)');
    addCal('Board Meeting — Q1', 30, 7, yr, 'Companies Act Sec 173', 'Min 4 board meetings/year; gap ≤120 days');
    addCal('Board Meeting — Q2', 30, 10, yr, 'Companies Act Sec 173', 'Min 4 board meetings/year; gap ≤120 days');
    addCal('DIR-3 KYC (Director KYC)', 30, 9, yr, 'Companies Act Rule 12A', 'Every director must file DIR-3 KYC by 30 Sep');
    addCal('INC-20A (if not filed)', 30, 4, yr+1, 'Companies Act Sec 10A', 'Commencement of Business declaration — one-time if not done');
    complianceCalendar.sort((a,b)=>a.days_left-b.days_left);

    res.json({
      generated_at: todayStr,
      snapshot: { cash_balance:round2(cashBalance), ar_total:arTotal, ap_total:apTotal, ap_overdue:apOverdue, rev_this_month:revThisMonth, rev_last_month:revLastMonth, exp_this_month:expThisMonth, exp_last_month:expLastMonth, net_this_month:round2(revThisMonth-expThisMonth) },
      ar_aging: { buckets:arAging, detail:arDetail, total:arTotal },
      ap_aging: { buckets:apAging, detail:apDetail, total:apTotal },
      bank: { accounts:bankDetail, total_cash:round2(cashBalance), unreconciled_count:unreconciled.length, unreconciled_amount:unreconAmount, recent_txns:txnList.slice(0,20) },
      gst: { output_tax:salesGST, input_tax:purchGST, net_payable:netGST, period:monthStart.slice(0,7) },
      tds: { rows:tdsRows, total_tds_due:round2(tdsRows.reduce((s,r)=>s+r.tds_due,0)) },
      expenses: { total:expThisMonth, last_month:expLastMonth, breakdown:expBreakdown, recent:(expenses.data||[]).slice(0,15) },
      revenue: { this_month:revThisMonth, last_month:revLastMonth, growth_pct:revLastMonth>0?round2((revThisMonth-revLastMonth)/revLastMonth*100):null, daily:revDailyArr },
      payroll: null,
      compliance_calendar: complianceCalendar,
      findings: (findingsLatest.data||[]),
      findings_counts: (() => { const c={critical:0,high:0,medium:0,low:0,info:0}; for(const f of findingsLatest.data||[]) if(f.severity in c) c[f.severity]++; return c; })(),
    });
  } catch (e) {
    console.error('[CA Report]', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/ca-agent/run — trigger a manual run via monitor-api on the host
// (backend runs in Docker; ca-agent.js needs host node + node_modules)
router.post('/run', auth, roleGuard, async (req, res) => {
  try {
    const r = await fetch(`${MONITOR_API}/ca-agent-run`, { method: 'POST' });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: `Could not reach monitor-api: ${e.message}` });
  }
});

module.exports = router;
