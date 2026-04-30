const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const cheerio  = require('cheerio');
const pdfParse = require('pdf-parse');
const { auth } = require('../middleware/auth');
const supabase  = require('../config/supabase');

// multer — memory storage, max 10MB, CSV / HTML / PDF
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const name = file.originalname.toLowerCase();
    const ok = /\.(csv|xls|xlsx|txt|html|htm|pdf)$/.test(name)
      || file.mimetype.includes('csv')
      || file.mimetype.includes('spreadsheet')
      || file.mimetype.includes('text')
      || file.mimetype === 'application/pdf'
      || file.mimetype.includes('html');
    cb(ok ? null : new Error('Only CSV, HTML or PDF files accepted'), ok);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────
function toNum(s) {
  if (!s) return 0;
  return parseFloat(String(s).replace(/,/g, '').replace(/[^\d.-]/g, '')) || 0;
}

// Accepts: DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, DD Mon YYYY, DD/MM/YY
function parseDate(s) {
  if (!s) return null;
  s = String(s).trim();

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // DD/MM/YYYY or DD-MM-YYYY
  const slashDash = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (slashDash) {
    let [, d, m, y] = slashDash;
    if (y.length === 2) y = '20' + y;
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }

  // DD Mon YYYY  (e.g.  01 Apr 2026)
  const MONTHS = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
  const longDate = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (longDate) {
    const [, d, mon, y] = longDate;
    const m = MONTHS[mon.toLowerCase().slice(0,3)];
    if (m) return `${y}-${m}-${d.padStart(2,'0')}`;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV parser  (handles ICICI / SBI / HDFC exports with optional metadata rows)
// ─────────────────────────────────────────────────────────────────────────────
function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  function splitLine(line) {
    const result = []; let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    result.push(cur.trim());
    return result.map(v => v.replace(/^"|"$/g, '').trim());
  }

  let openingBalance = null, closingBalance = null, headerIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i], low = raw.toLowerCase();
    if (low.includes('opening balance') || low.includes('opening bal')) {
      const cols = splitLine(raw);
      for (const c of cols) { const n = toNum(c); if (n > 0) { openingBalance = n; break; } }
    }
    if (low.includes('closing balance') || low.includes('closing bal')) {
      const cols = splitLine(raw);
      for (const c of cols) { const n = toNum(c); if (n > 0) { closingBalance = n; break; } }
    }
    if (low.includes('transaction date') || low.includes('txn date') || low.includes('value date')) {
      headerIdx = i; break;
    }
  }

  if (headerIdx === -1) throw new Error('CSV: Could not find column header row. Expected a row with "Transaction Date".');

  const headers = splitLine(lines[headerIdx]).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, '_'));
  function colIdx(...candidates) {
    for (const c of candidates) { const i = headers.findIndex(h => h.includes(c)); if (i !== -1) return i; }
    return -1;
  }

  const iDate   = colIdx('transaction_date','txn_date','date');
  const iDesc   = colIdx('description','narration','particulars','remarks');
  const iRef    = colIdx('ref_no','cheque_no','reference','ref','chq');
  const iDebit  = colIdx('debit','dr','withdrawal');
  const iCredit = colIdx('credit','cr','deposit');
  const iBal    = colIdx('balance');

  if (iDate === -1) throw new Error('CSV: Cannot find Transaction Date column.');

  const transactions = []; let derivedOpening = null, derivedClosing = null;

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.replace(/,/g,'').trim() === '') continue;
    const cols = splitLine(line);
    const date = parseDate(cols[iDate]);
    if (!date) continue;
    const description = (iDesc !== -1 ? cols[iDesc] : '') || '';
    const ref         = (iRef  !== -1 ? cols[iRef]  : '') || '';
    const debit  = iDebit  !== -1 ? toNum(cols[iDebit])  : 0;
    const credit = iCredit !== -1 ? toNum(cols[iCredit]) : 0;
    const bal    = iBal    !== -1 ? toNum(cols[iBal])    : null;
    if (debit === 0 && credit === 0) continue;
    const type   = credit > 0 ? 'credit' : 'debit';
    const amount = credit > 0 ? credit : debit;
    if (bal !== null) {
      if (derivedOpening === null) derivedOpening = type === 'credit' ? bal - amount : bal + amount;
      derivedClosing = bal;
    }
    transactions.push({ date, description, reference: ref, type, amount });
  }

  return { openingBalance: openingBalance ?? derivedOpening, closingBalance: closingBalance ?? derivedClosing, transactions };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML parser  (ICICI / most banks export as a <table>)
// ─────────────────────────────────────────────────────────────────────────────
function parseHtml(html) {
  const $ = cheerio.load(html);
  let openingBalance = null, closingBalance = null;

  // Try to find opening / closing balance from any text node
  $('*').each((_, el) => {
    const text = $(el).text().toLowerCase();
    if (text.includes('opening balance') || text.includes('opening bal')) {
      const nums = $(el).text().match(/[\d,]+\.\d{2}/g);
      if (nums) openingBalance = toNum(nums[nums.length - 1]);
    }
    if (text.includes('closing balance') || text.includes('closing bal')) {
      const nums = $(el).text().match(/[\d,]+\.\d{2}/g);
      if (nums) closingBalance = toNum(nums[nums.length - 1]);
    }
  });

  const transactions = []; let derivedOpening = null, derivedClosing = null;

  // Find the transaction table: look for a <tr> whose cells contain "date", "debit", "credit"
  let headerRow = null, table = null;
  $('table').each((_, tbl) => {
    $(tbl).find('tr').each((_, row) => {
      const cells = $(row).find('th,td').map((__, c) => $(c).text().toLowerCase().trim()).get();
      const hasDate   = cells.some(c => c.includes('date'));
      const hasAmount = cells.some(c => c.includes('debit') || c.includes('credit') || c.includes('amount') || c.includes('withdrawal') || c.includes('deposit'));
      if (hasDate && hasAmount) { headerRow = cells; table = tbl; return false; }
    });
    if (headerRow) return false;
  });

  if (!headerRow || !table) throw new Error('HTML: Could not find transaction table. Make sure the file is a bank statement HTML export.');

  function colIdx(...candidates) {
    for (const c of candidates) { const i = headerRow.findIndex(h => h.includes(c)); if (i !== -1) return i; }
    return -1;
  }

  const iDate   = colIdx('transaction date','txn date','date','value date');
  const iDesc   = colIdx('description','narration','particulars','remarks');
  const iRef    = colIdx('ref','cheque','reference','chq');
  const iDebit  = colIdx('debit','dr','withdrawal');
  const iCredit = colIdx('credit','cr','deposit');
  const iBal    = colIdx('balance');

  let skipHeader = true;
  $(table).find('tr').each((_, row) => {
    if (skipHeader) { skipHeader = false; return; } // skip the header row itself
    const cells = $(row).find('td').map((__, c) => $(c).text().trim()).get();
    if (cells.length < 3) return;
    const date = iDate !== -1 ? parseDate(cells[iDate]) : null;
    if (!date) return;
    const description = (iDesc !== -1 ? cells[iDesc] : '') || '';
    const ref         = (iRef  !== -1 ? cells[iRef]  : '') || '';
    const debit  = iDebit  !== -1 ? toNum(cells[iDebit])  : 0;
    const credit = iCredit !== -1 ? toNum(cells[iCredit]) : 0;
    const bal    = iBal    !== -1 ? toNum(cells[iBal])    : null;
    if (debit === 0 && credit === 0) return;
    const type   = credit > 0 ? 'credit' : 'debit';
    const amount = credit > 0 ? credit : debit;
    if (bal !== null) {
      if (derivedOpening === null) derivedOpening = type === 'credit' ? bal - amount : bal + amount;
      derivedClosing = bal;
    }
    transactions.push({ date, description, reference: ref, type, amount });
  });

  return { openingBalance: openingBalance ?? derivedOpening, closingBalance: closingBalance ?? derivedClosing, transactions };
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF parser  (extracts text then applies line-based heuristic)
// ICICI PDF statement layout (per page):
//   Date        Narration/Description      Ref No   Debit   Credit   Balance
// Lines are extracted as a flat text blob — we look for lines that start with
// a date pattern and contain numeric amounts.
// ─────────────────────────────────────────────────────────────────────────────
async function parsePdf(buffer) {
  const data = await pdfParse(buffer, { max: 0 });
  const raw  = data.text;

  let openingBalance = null, closingBalance = null;

  // Scan for opening / closing balance keywords in the full text
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const low = line.toLowerCase();
    if (low.includes('opening balance') || low.includes('opening bal')) {
      const nums = line.match(/[\d,]+\.\d{2}/g);
      if (nums) openingBalance = toNum(nums[nums.length - 1]);
    }
    if (low.includes('closing balance') || low.includes('closing bal')) {
      const nums = line.match(/[\d,]+\.\d{2}/g);
      if (nums) closingBalance = toNum(nums[nums.length - 1]);
    }
  }

  const transactions = []; let derivedOpening = null, derivedClosing = null;

  // Date pattern at start of a token: DD/MM/YYYY or DD-MM-YYYY or DD/MM/YY
  const DATE_RE = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/;

  // Each transaction line in an ICICI PDF looks like (whitespace-separated tokens):
  //   01/04/2026  [narration tokens...]  [ref]  [debit]  [credit]  [balance]
  // or split across two lines. Strategy: look for lines that BEGIN with a date
  // and contain 2+ numbers after it (debit/credit/balance).

  const NUM_RE = /^[\d,]+\.\d{2}$/;

  // Combine all lines into tokens grouped by lines
  for (let i = 0; i < lines.length; i++) {
    const tokens = lines[i].split(/\s+/);
    if (!DATE_RE.test(tokens[0])) continue;

    const date = parseDate(tokens[0]);
    if (!date) continue;

    // Collect the rest of this line plus possibly the next line(s)
    // until we find at least 2 numbers
    let combined = tokens.slice(1);
    let j = i + 1;
    while (combined.filter(t => NUM_RE.test(t)).length < 2 && j < lines.length && j < i + 4) {
      const nextTokens = lines[j].split(/\s+/);
      if (DATE_RE.test(nextTokens[0])) break; // next transaction
      combined = combined.concat(nextTokens);
      j++;
    }

    // Extract all numbers from combined
    const nums = combined.filter(t => NUM_RE.test(t)).map(toNum);
    if (nums.length < 2) continue;

    // Balance = last number, then work backwards for debit/credit
    const bal    = nums[nums.length - 1];
    // Second-to-last is either debit or credit
    // Third-to-last (if exists) is the other (sometimes only one of debit/credit is non-zero)
    let debit = 0, credit = 0;
    if (nums.length >= 3) {
      debit  = nums[nums.length - 3];
      credit = nums[nums.length - 2];
    } else {
      // Only one amount before balance — determine dr/cr from balance change
      debit  = nums[0];
      credit = 0;
    }

    // Description = all non-number tokens before the numbers
    const descTokens = [];
    for (const tok of combined) {
      if (NUM_RE.test(tok)) break;
      descTokens.push(tok);
    }
    const description = descTokens.join(' ').trim();

    // Reference: look for token matching ICICI ref pattern (S + 8+ digits) or similar
    const refToken = combined.find(t => /^[A-Z]\d{6,}$/.test(t) || /^[A-Z]{2,}\d{6,}$/.test(t));
    const ref = refToken || '';

    if (debit === 0 && credit === 0) continue;

    const type   = credit > 0 ? 'credit' : 'debit';
    const amount = credit > 0 ? credit : debit;

    if (derivedOpening === null) derivedOpening = type === 'credit' ? bal - amount : bal + amount;
    derivedClosing = bal;

    transactions.push({ date, description, reference: ref, type, amount });
    i = j - 1; // skip lines we consumed
  }

  return { openingBalance: openingBalance ?? derivedOpening, closingBalance: closingBalance ?? derivedClosing, transactions };
}

// ─────────────────────────────────────────────────────────────────────────────
// Master parser — routes to CSV / HTML / PDF based on file extension + content
// ─────────────────────────────────────────────────────────────────────────────
async function parseBankStatement(buffer, originalname, mimetype) {
  const name = (originalname || '').toLowerCase();
  const isPdf  = name.endsWith('.pdf') || mimetype === 'application/pdf';
  const isHtml = name.endsWith('.html') || name.endsWith('.htm') || mimetype.includes('html');

  if (isPdf)  return await parsePdf(buffer);
  if (isHtml) return parseHtml(buffer.toString('utf-8'));
  return parseCsv(buffer.toString('utf-8'));         // CSV / XLS / TXT
}

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

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ca-agent/reconcile
// Upload ICICI bank statement CSV → compare with bank_transactions in DB
// Multipart field: "statement" (CSV file)
// Query params:
//   bank_account_id (default 1)
//   import_missing  (true/false — auto-import missing txns into DB, default false)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/reconcile', auth, roleGuard, upload.single('statement'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded. Send a CSV as multipart field "statement".' });

    const bankAccountId  = parseInt(req.query.bank_account_id || req.body.bank_account_id || 1);
    const importMissing  = (req.query.import_missing || req.body.import_missing) === 'true';

    // Parse the uploaded file (CSV / HTML / PDF)
    let parsed;
    try {
      parsed = await parseBankStatement(req.file.buffer, req.file.originalname, req.file.mimetype || '');
    } catch (parseErr) {
      return res.status(422).json({ error: `Parse error: ${parseErr.message}` });
    }

    const { openingBalance, closingBalance, transactions: bankTxns } = parsed;

    if (!bankTxns.length) return res.status(422).json({ error: 'No transactions found in CSV. Check file format.' });

    // Determine date range from statement
    const dates = bankTxns.map(t => t.date).sort();
    const fromDate = dates[0];
    const toDate   = dates[dates.length - 1];

    // Fetch software transactions for the same period
    const { data: dbTxns, error: dbErr } = await supabase
      .from('bank_transactions')
      .select('id,date,type,amount,description,reference')
      .eq('bank_account_id', bankAccountId)
      .gte('date', fromDate)
      .lte('date', toDate)
      .order('date');

    if (dbErr) return res.status(500).json({ error: dbErr.message });

    const round2 = n => Math.round(parseFloat(n || 0) * 100) / 100;

    // Build a match key: date|type|amount (rounded to 2dp)
    function matchKey(t) { return `${t.date}|${t.type}|${round2(t.amount)}`; }
    // Also index by reference (ICICI ref like S12345678)
    function refKey(t) { return (t.reference || '').trim().toUpperCase(); }

    const dbByKey = new Map();
    const dbByRef = new Map();
    for (const t of (dbTxns || [])) {
      dbByKey.set(matchKey(t), t);
      if (t.reference) dbByRef.set(refKey(t), t);
    }

    const bankByKey = new Map();
    const bankByRef = new Map();
    for (const t of bankTxns) {
      bankByKey.set(matchKey(t), t);
      if (t.reference) bankByRef.set(refKey(t), t);
    }

    // Classify each bank transaction
    const matched          = [];
    const missingInSoftware = [];

    for (const bt of bankTxns) {
      const byRef = bt.reference ? dbByRef.get(refKey(bt)) : null;
      const byKey = dbByKey.get(matchKey(bt));
      if (byRef || byKey) {
        matched.push({ bank: bt, software: byRef || byKey });
      } else {
        missingInSoftware.push(bt);
      }
    }

    // Find transactions in software not matched to any bank entry
    const matchedDbIds = new Set(matched.map(m => m.software?.id).filter(Boolean));
    const extraInSoftware = (dbTxns || []).filter(t => !matchedDbIds.has(t.id));

    // Calculate balances
    const { data: bankAcc } = await supabase.from('bank_accounts').select('opening_balance,current_balance').eq('id', bankAccountId).single();

    const softwareCredits = (dbTxns || []).filter(t => t.type === 'credit').reduce((s, t) => s + round2(t.amount), 0);
    const softwareDebits  = (dbTxns || []).filter(t => t.type === 'debit').reduce((s, t) => s + round2(t.amount), 0);
    const softwareOpening = bankAcc?.opening_balance || 0;
    const softwareClosing = round2(softwareOpening + softwareCredits - softwareDebits);

    const bankBalance     = closingBalance ?? null;
    const balanceDiff     = bankBalance !== null ? round2(bankBalance - softwareClosing) : null;
    const isBalanced      = balanceDiff !== null && Math.abs(balanceDiff) < 0.02;

    // Auto-import missing transactions if requested
    let importResult = null;
    if (importMissing && missingInSoftware.length > 0) {
      const toInsert = missingInSoftware.map(t => ({
        bank_account_id: bankAccountId,
        date: t.date,
        type: t.type,
        amount: t.amount,
        description: t.description,
        reference: t.reference || null,
        category: null,
        reconciled: true,
        created_at: new Date().toISOString(),
      }));
      const { data: inserted, error: insErr } = await supabase.from('bank_transactions').insert(toInsert).select('id');
      if (insErr) {
        importResult = { error: insErr.message };
      } else {
        // Recalculate balance
        const newClosing = round2(softwareClosing + missingInSoftware.filter(t => t.type === 'credit').reduce((s, t) => s + round2(t.amount), 0) - missingInSoftware.filter(t => t.type === 'debit').reduce((s, t) => s + round2(t.amount), 0));
        await supabase.from('bank_accounts').update({ current_balance: newClosing }).eq('id', bankAccountId);
        importResult = { imported: inserted?.length || 0, new_balance: newClosing };
      }
    }

    res.json({
      period: { from: fromDate, to: toDate },
      bank: { opening: openingBalance, closing: bankBalance, transaction_count: bankTxns.length },
      software: { opening: softwareOpening, closing: softwareClosing, transaction_count: (dbTxns || []).length },
      reconciliation: {
        is_balanced: isBalanced,
        difference: balanceDiff,
        matched_count: matched.length,
        missing_in_software_count: missingInSoftware.length,
        extra_in_software_count: extraInSoftware.length,
      },
      missing_in_software: missingInSoftware,   // in bank, not in DB
      extra_in_software: extraInSoftware.map(t => ({ id: t.id, date: t.date, type: t.type, amount: t.amount, description: t.description, reference: t.reference })), // in DB, not in bank
      import_result: importResult,
    });
  } catch (e) {
    console.error('[Reconcile]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ca-agent/detect-recurring
// Scans all bank_transactions debits for:
//   1. Multi-month recurrence (same normalised description in 2+ months)
//   2. Keyword matching for known categories (EB, Rent, Internet, subscriptions)
//   3. MIN/ prefix = card-auto-debit (always recurring)
// Auto-updates recurring_expenses table with detected amounts.
// ─────────────────────────────────────────────────────────────────────────────

// Known keyword → category map (checked against full description)
const RECUR_KEYWORDS = [
  { re: /tneb|tangedco|bescom|msedcl|tnpdcl|electricity|tsspdcl|cesc|wbsedcl/i, category:'Utilities',      name:'Electricity Bill (EB)',    due_day:15 },
  { re: /bsnl|airtel\s*(broadband|fiber|home|wifi)|act\s*fiber|hathway|tikona|tata\s*play\s*fiber|jio\s*fiber|d2h|broadband|internet\s*bill/i, category:'Office & Admin', name:'Internet / Broadband', due_day:5 },
  { re: /rent|lease\s*rent|godown\s*rent|office\s*rent|shop\s*rent/i,            category:'Rent',           name:'Rent',                     due_day:1  },
  { re: /sqsp\s*works|squarespace\s*works/i,    category:'Marketing',   name:'Squarespace Website',      due_day:12 },
  { re: /sqsp\s*dom|squarespace\s*dom/i,        category:'Marketing',   name:'Squarespace Domain',       due_day:19 },
  { re: /anthropic/i,                           category:'Software',    name:'Anthropic / Claude AI',    due_day:7  },
  { re: /swiggy|swgy/i,                         category:'Marketing',   name:'Swiggy',                   due_day:12 },
  { re: /facebook|meta\s*ads|fb\s*ads/i,        category:'Marketing',   name:'Facebook Ads',             due_day:16 },
  { re: /google\s*ads|googleads/i,              category:'Marketing',   name:'Google Ads',               due_day:1  },
  { re: /amazon\s*(aws|web)/i,                  category:'Software',    name:'AWS / Amazon Cloud',       due_day:1  },
  { re: /mobile\s*alert|mob\s*alrt|sms\s*alert/i, category:'Office & Admin', name:'Mobile Alert / SMS Charges', due_day:9 },
  { re: /tata\s*sky|dish\s*tv|videocon\s*d2h/i, category:'Office & Admin', name:'DTH / Cable TV',       due_day:1  },
];

// Normalise a description into a grouping key
function normaliseDesc(desc) {
  return (desc || '')
    .replace(/\d{8,}/g, '#')          // remove long reference numbers
    .replace(/\d{2}\/\d{2}\/\d{4}/g, '') // remove dates
    .replace(/[~_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 35);
}

router.post('/detect-recurring', auth, roleGuard, async (req, res) => {
  try {
    const r2 = n => Math.round((parseFloat(n) || 0) * 100) / 100;

    // Fetch all debit transactions (last 12 months max)
    const since = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const { data: txns, error: txErr } = await supabase
      .from('bank_transactions')
      .select('date,amount,description,reference')
      .eq('type', 'debit')
      .gte('date', since)
      .order('date');

    if (txErr) return res.status(500).json({ error: txErr.message });

    const detected = []; // { name, category, due_day, amounts[], months[], avg, source }

    // ── Step 1: Keyword matching ─────────────────────────────────────────────
    for (const kw of RECUR_KEYWORDS) {
      const matches = (txns || []).filter(t => kw.re.test(t.description || ''));
      if (matches.length === 0) continue;
      const months  = [...new Set(matches.map(t => t.date?.slice(0, 7)))];
      const amounts = matches.map(t => parseFloat(t.amount));
      const avg     = r2(amounts.reduce((s, a) => s + a, 0) / amounts.length);
      detected.push({ name: kw.name, category: kw.category, due_day: kw.due_day, avg, months, txn_count: matches.length, source: 'keyword', sample_desc: matches[0].description?.slice(0, 60) });
    }

    // ── Step 2: MIN/ prefix = card auto-debit (always recurring) ────────────
    // Group by normalised description
    const minTxns = (txns || []).filter(t => /^(MIN|MSI)\//.test(t.description || ''));
    const minGroups = {};
    for (const t of minTxns) {
      const key = normaliseDesc(t.description);
      if (!minGroups[key]) minGroups[key] = [];
      minGroups[key].push(t);
    }
    for (const [key, group] of Object.entries(minGroups)) {
      // Skip if already picked up by keyword
      if (detected.some(d => group.some(g => d.sample_desc?.includes(g.description?.slice(0, 20))))) continue;
      const months  = [...new Set(group.map(t => t.date?.slice(0, 7)))];
      const amounts = group.map(t => parseFloat(t.amount));
      const avg     = r2(amounts.reduce((s, a) => s + a, 0) / amounts.length);
      const vendor  = (group[0].description || '').replace(/^(MIN|MSI)\//, '').split('/')[0].trim().slice(0, 30);
      detected.push({ name: vendor || key, category: 'Subscription', due_day: parseInt(group[0].date?.slice(8)) || 1, avg, months, txn_count: group.length, source: 'auto-debit', sample_desc: group[0].description?.slice(0, 60) });
    }

    // ── Step 3: Multi-month recurrence (same normalised desc in 2+ months) ──
    const allGroups = {};
    for (const t of (txns || [])) {
      const key = normaliseDesc(t.description);
      if (!allGroups[key]) allGroups[key] = [];
      allGroups[key].push(t);
    }
    for (const [key, group] of Object.entries(allGroups)) {
      const months = [...new Set(group.map(t => t.date?.slice(0, 7)))];
      if (months.length < 2) continue; // must appear in 2+ months
      // Skip if already detected
      if (detected.some(d => d.sample_desc && d.sample_desc.toLowerCase().includes(key.slice(0, 15)))) continue;
      const amounts = group.map(t => parseFloat(t.amount));
      const avg     = r2(amounts.reduce((s, a) => s + a, 0) / amounts.length);
      detected.push({ name: key.slice(0, 40), category: 'Recurring', due_day: 1, avg, months, txn_count: group.length, source: 'multi-month', sample_desc: group[0].description?.slice(0, 60) });
    }

    // ── Step 4: Auto-upsert into recurring_expenses table ───────────────────
    const { data: existing } = await supabase.from('recurring_expenses').select('id,name,amount');
    const existingMap = Object.fromEntries((existing || []).map(r => [r.name.toLowerCase(), r]));

    let updated = 0, inserted = 0;
    for (const d of detected) {
      if (d.avg <= 0) continue;
      const ex = existingMap[d.name.toLowerCase()];
      if (ex) {
        // Update amount if it was 0 or if it changed by >5%
        if (ex.amount === 0 || Math.abs(ex.amount - d.avg) / Math.max(ex.amount, 1) > 0.05) {
          await supabase.from('recurring_expenses').update({ amount: d.avg, updated_at: new Date().toISOString() }).eq('id', ex.id);
          updated++;
        }
      } else {
        await supabase.from('recurring_expenses').insert({ name: d.name, category: d.category, amount: d.avg, frequency: 'monthly', due_day: d.due_day, vendor: '', notes: `Auto-detected from bank transactions (${d.source})`, active: true, updated_at: new Date().toISOString() });
        inserted++;
      }
    }

    res.json({ detected, total_detected: detected.length, auto_updated: updated, auto_inserted: inserted, monthly_total: r2(detected.reduce((s, d) => s + d.avg, 0)) });
  } catch (e) {
    console.error('[detect-recurring]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ca-agent/cashflow
// Intelligent cash flow forecast:
//   • Current bank balance (live)
//   • Salary this month (auto-calculated from attendance × daily_rate)
//   • Recurring monthly commitments
//   • Average monthly operating expenses (last 3 months)
//   • Vendor bills due in next 30 days
//   • Net position + status verdict
// ─────────────────────────────────────────────────────────────────────────────
router.get('/cashflow', auth, roleGuard, async (req, res) => {
  try {
    const today     = new Date();
    const r2        = n => Math.round((parseFloat(n) || 0) * 100) / 100;
    const todayStr  = today.toISOString().slice(0, 10);

    // IST-aware current month
    const istNow    = new Date(today.getTime() + 5.5 * 3600000);
    const yr        = istNow.getUTCFullYear();
    const mo        = istNow.getUTCMonth(); // 0-based
    const monthStr  = `${yr}-${String(mo + 1).padStart(2, '0')}`;
    const monthStart= `${monthStr}-01`;
    const monthEnd  = new Date(yr, mo + 1, 0).toISOString().slice(0, 10);
    const next30    = new Date(today.getTime() + 30 * 86400000).toISOString().slice(0, 10);

    // Last 3 months for average
    const ago3m     = new Date(yr, mo - 3, 1).toISOString().slice(0, 10);

    // ── 0. Auto-detect recurring from bank transactions (runs silently) ──────
    try {
      const since = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
      const { data: txns } = await supabase.from('bank_transactions').select('date,amount,description').eq('type','debit').gte('date', since).order('date');
      const { data: existingRec } = await supabase.from('recurring_expenses').select('id,name,amount');
      const existingMap = Object.fromEntries((existingRec || []).map(r => [r.name.toLowerCase(), r]));

      for (const kw of RECUR_KEYWORDS) {
        const matches = (txns || []).filter(t => kw.re.test(t.description || ''));
        if (matches.length === 0) continue;
        const avg = Math.round(matches.reduce((s, t) => s + parseFloat(t.amount), 0) / matches.length * 100) / 100;
        if (avg <= 0) continue;
        const ex = existingMap[kw.name.toLowerCase()];
        if (ex) {
          if (ex.amount === 0 || Math.abs(ex.amount - avg) / Math.max(ex.amount, 1) > 0.05)
            await supabase.from('recurring_expenses').update({ amount: avg, updated_at: new Date().toISOString() }).eq('id', ex.id);
        } else {
          await supabase.from('recurring_expenses').insert({ name: kw.name, category: kw.category, amount: avg, frequency: 'monthly', due_day: kw.due_day, vendor: '', notes: 'Auto-detected from bank transactions', active: true, updated_at: new Date().toISOString() });
        }
      }

      // MIN/ auto-debits not already in recurring
      const minTxns = (txns || []).filter(t => /^(MIN|MSI)\//.test(t.description || ''));
      const minGroups = {};
      for (const t of minTxns) {
        const key = normaliseDesc(t.description);
        if (!minGroups[key]) minGroups[key] = [];
        minGroups[key].push(t);
      }
      for (const [, group] of Object.entries(minGroups)) {
        const vendor = (group[0].description || '').replace(/^(MIN|MSI)\//, '').split('/')[0].trim().slice(0, 30);
        if (!vendor) continue;
        if (existingMap[vendor.toLowerCase()]) continue; // already tracked
        // Only add if it's a known-type MIN charge (skip random UPI auto-debits)
        if (!RECUR_KEYWORDS.some(kw => kw.re.test(group[0].description || ''))) continue;
        const avg = Math.round(group.reduce((s, t) => s + parseFloat(t.amount), 0) / group.length * 100) / 100;
        if (avg > 0) await supabase.from('recurring_expenses').insert({ name: vendor, category: 'Subscription', amount: avg, frequency: 'monthly', due_day: parseInt(group[0].date?.slice(8)) || 1, notes: 'Auto-detected MIN/ auto-debit', active: true, updated_at: new Date().toISOString() });
      }
    } catch (_) { /* silent — don't break cashflow if detection fails */ }

    const [
      bankAccs, employees, attendance,
      expensesThis, expensesPast, recurringExp,
      billsAll,
    ] = await Promise.all([
      supabase.from('bank_accounts').select('id,name,current_balance').eq('is_active', true),
      supabase.from('employees').select('id,name,role,pay_type,daily_rate,monthly_salary').eq('active', true),
      supabase.from('attendance').select('employee_id,date,status').gte('date', monthStart).lte('date', monthEnd),
      supabase.from('company_expenses').select('category,amount,date').gte('date', monthStart).lte('date', monthEnd).is('deleted_at', null),
      supabase.from('company_expenses').select('category,amount,date').gte('date', ago3m).lt('date', monthStart).is('deleted_at', null),
      supabase.from('recurring_expenses').select('*').eq('active', true),
      supabase.from('vendor_bills').select('vendor_name,category,amount,gst_amount,paid_amount,due_date,status').in('status', ['unpaid', 'partial', 'overdue']),
    ]);

    // ── 1. Bank balance ──────────────────────────────────────────────────────
    const bankBalance = r2((bankAccs.data || []).reduce((s, a) => s + (a.current_balance || 0), 0));
    const bankAccList = (bankAccs.data || []).map(a => ({ name: a.name, balance: r2(a.current_balance || 0) }));

    // ── 2. Salary this month (from attendance) ───────────────────────────────
    const workDays = {};
    for (const a of (attendance.data || [])) {
      if (a.status === 'present')  workDays[a.employee_id] = (workDays[a.employee_id] || 0) + 1;
      if (a.status === 'half-day') workDays[a.employee_id] = (workDays[a.employee_id] || 0) + 0.5;
    }
    const salaryBreakdown = (employees.data || []).map(e => {
      const days   = workDays[e.id] || 0;
      const earned = e.pay_type === 'daily' ? r2(days * (e.daily_rate || 0)) : r2(e.monthly_salary || 0);
      return { id: e.id, name: e.name, role: e.role, pay_type: e.pay_type, days_worked: days, rate: e.pay_type === 'daily' ? e.daily_rate : e.monthly_salary, earned };
    });
    const totalSalary = r2(salaryBreakdown.reduce((s, e) => s + e.earned, 0));

    // ── 3. Recurring monthly commitments ────────────────────────────────────
    const recurringTotal = r2((recurringExp.data || []).reduce((s, r) => s + (r.amount || 0), 0));
    const recurringList  = (recurringExp.data || []).map(r => ({ name: r.name || r.description, amount: r2(r.amount), frequency: r.frequency || 'monthly' }));

    // ── 4. Average monthly operating expenses (last 3 months) ───────────────
    const pastByMonth = {};
    for (const e of (expensesPast.data || [])) {
      const m = e.date?.slice(0, 7);
      pastByMonth[m] = (pastByMonth[m] || 0) + parseFloat(e.amount || 0);
    }
    const pastMonths  = Object.values(pastByMonth);
    const avgMonthlyExp = pastMonths.length > 0 ? r2(pastMonths.reduce((s, v) => s + v, 0) / pastMonths.length) : 0;
    const thisMonthExp  = r2((expensesThis.data || []).reduce((s, e) => s + parseFloat(e.amount || 0), 0));

    // Category breakdown for this month
    const expByCat = {};
    for (const e of (expensesThis.data || [])) {
      expByCat[e.category] = r2((expByCat[e.category] || 0) + parseFloat(e.amount || 0));
    }

    // ── 5. Vendor bills due in next 30 days ──────────────────────────────────
    const billsDue30 = (billsAll.data || []).filter(b => b.due_date && b.due_date <= next30);
    const billsOverdue = (billsAll.data || []).filter(b => b.due_date && b.due_date < todayStr);
    const billsDueAmt  = r2(billsDue30.reduce((s, b) => s + Math.max(0, r2((b.amount || 0) + (b.gst_amount || 0) - (b.paid_amount || 0))), 0));
    const billsOverdueAmt = r2(billsOverdue.reduce((s, b) => s + Math.max(0, r2((b.amount || 0) + (b.gst_amount || 0) - (b.paid_amount || 0))), 0));

    // ── 6. Total projected outflows ──────────────────────────────────────────
    // Remaining operating expenses this month (avg - already spent)
    const remainingOpEx = r2(Math.max(0, avgMonthlyExp - thisMonthExp));

    const totalOutflow = r2(totalSalary + recurringTotal + remainingOpEx + billsDueAmt);

    // ── 7. Net position & status ─────────────────────────────────────────────
    const netPosition  = r2(bankBalance - totalOutflow);
    const salaryGap    = r2(bankBalance - totalSalary); // just salary vs bank
    let status, statusDetail;
    if (netPosition >= 50000) {
      status = 'healthy';
      statusDetail = `You have ₹${netPosition.toLocaleString('en-IN')} surplus after all upcoming obligations.`;
    } else if (netPosition >= 0) {
      status = 'tight';
      statusDetail = `Only ₹${netPosition.toLocaleString('en-IN')} left after all obligations — keep close watch.`;
    } else {
      status = 'shortage';
      statusDetail = `Cash short by ₹${Math.abs(netPosition).toLocaleString('en-IN')} to meet all obligations.`;
    }

    // Salary-specific alert
    const salaryStatus = salaryGap >= 0 ? 'ok' : 'shortage';
    const salaryAlert  = salaryGap < 0
      ? `⚠️ Bank balance (₹${bankBalance.toLocaleString('en-IN')}) is less than salary due (₹${totalSalary.toLocaleString('en-IN')}). Short by ₹${Math.abs(salaryGap).toLocaleString('en-IN')}.`
      : null;

    res.json({
      as_of: todayStr,
      month: monthStr,
      bank: { balance: bankBalance, accounts: bankAccList },
      salary: {
        total: totalSalary,
        status: salaryStatus,
        alert: salaryAlert,
        breakdown: salaryBreakdown,
        period: `${monthStart} to ${todayStr}`,
      },
      recurring: { total: recurringTotal, items: recurringList },
      operating_expenses: {
        this_month_spent: thisMonthExp,
        avg_monthly_3m: avgMonthlyExp,
        remaining_estimate: remainingOpEx,
        by_category: expByCat,
      },
      bills: {
        due_next_30_days: billsDueAmt,
        overdue: billsOverdueAmt,
        count: billsDue30.length,
        list: billsDue30.map(b => ({
          vendor: b.vendor_name,
          category: b.category,
          outstanding: r2((b.amount || 0) + (b.gst_amount || 0) - (b.paid_amount || 0)),
          due_date: b.due_date,
          status: b.status,
        })).sort((a, b) => a.due_date?.localeCompare(b.due_date)),
      },
      forecast: {
        total_outflow: totalOutflow,
        net_position: netPosition,
        status,
        status_detail: statusDetail,
        breakdown: {
          salary:    totalSalary,
          recurring: recurringTotal,
          operating: remainingOpEx,
          bills:     billsDueAmt,
        },
      },
    });
  } catch (e) {
    console.error('[Cashflow]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ca-agent/simple-dashboard
// Simple Finance Dashboard — one endpoint, all the numbers anyone needs:
//   Cash in bank · Cash in factory · Sales (local/website/B2B) · Expenses
//   Salary · Forecast · Bottom line
// POST /api/ca-agent/simple-dashboard  { cash_in_factory: number }  — update petty cash
// ─────────────────────────────────────────────────────────────────────────────
router.post('/simple-dashboard', auth, roleGuard, async (req, res) => {
  try {
    const { cash_in_factory } = req.body;
    if (cash_in_factory == null) return res.status(400).json({ error: 'cash_in_factory required' });
    const amount = parseFloat(cash_in_factory) || 0;
    const { error } = await supabase.from('settings').upsert({ key: 'cash_in_factory', value: { amount, updated_at: new Date().toISOString(), updated_by: req.user?.name || 'admin' }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, cash_in_factory: amount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/simple-dashboard', auth, roleGuard, async (req, res) => {
  try {
    const r2     = n => Math.round((parseFloat(n) || 0) * 100) / 100;
    const today  = new Date();
    const ist    = new Date(today.getTime() + 5.5 * 3600000);

    // Allow ?month=YYYY-MM override; default to IST current month
    let yr, mo;
    if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) {
      [yr, mo] = req.query.month.split('-').map(Number);
      mo = mo - 1; // 0-indexed
    } else {
      yr = ist.getUTCFullYear();
      mo = ist.getUTCMonth();
    }

    const mStr   = `${yr}-${String(mo+1).padStart(2,'0')}`;
    const mStart = `${mStr}-01`;
    const mEnd   = new Date(yr, mo+1, 0).toISOString().slice(0,10);
    const prevYr  = mo === 0 ? yr - 1 : yr;
    const prevMo  = mo === 0 ? 11 : mo - 1;
    const prevStart = `${prevYr}-${String(prevMo+1).padStart(2,'0')}-01`;
    const prevEnd   = new Date(prevYr, prevMo+1, 0).toISOString().slice(0,10);
    const next30 = new Date(today.getTime() + 30*86400000).toISOString().slice(0,10);

    const SALE_STATUSES = ['delivered','dispatched','paid'];
    const WEB_STATUSES  = ['confirmed','packed','shipped','delivered','dispatched','paid'];

    const [
      bankAccs, cifSetting,
      salesThis, salesPrev,
      webThis, webPrev,
      b2bThis,
      expThis, expPrev,
      employees, attendance,
      recurringExp,
      bills,
    ] = await Promise.all([
      supabase.from('bank_accounts').select('name,current_balance').eq('is_active', true),
      supabase.from('settings').select('value').eq('key','cash_in_factory').single(),
      supabase.from('sales').select('final_amount').gte('date',mStart).lte('date',mEnd).in('status',SALE_STATUSES),
      supabase.from('sales').select('final_amount').gte('date',prevStart).lte('date',prevEnd).in('status',SALE_STATUSES),
      supabase.from('webstore_orders').select('total').gte('date',mStart).lte('date',mEnd).in('status',WEB_STATUSES),
      supabase.from('webstore_orders').select('total').gte('date',prevStart).lte('date',prevEnd).in('status',WEB_STATUSES),
      supabase.from('bank_transactions').select('amount,description,date').eq('type','credit').gte('date',mStart).lte('date',mEnd).ilike('description','%TUTR%'), // foreign inward / B2B wire
      supabase.from('company_expenses').select('amount,category,date,description').gte('date',mStart).lte('date',mEnd).is('deleted_at',null),
      supabase.from('company_expenses').select('amount').gte('date',prevStart).lte('date',prevEnd).is('deleted_at',null),
      supabase.from('employees').select('id,name,role,pay_type,daily_rate,monthly_salary').eq('active',true),
      supabase.from('attendance').select('employee_id,status').gte('date',mStart).lte('date',mEnd),
      supabase.from('recurring_expenses').select('name,amount,due_day,category').eq('active',true),
      supabase.from('vendor_bills').select('amount,gst_amount,paid_amount,due_date,vendor_name').in('status',['unpaid','partial','overdue']).lte('due_date',next30),
    ]);

    // ── Cash ──────────────────────────────────────────────────────────────────
    const bankBalance = r2((bankAccs.data||[]).reduce((s,a)=>s+(a.current_balance||0),0));
    const cashInFactory = r2(cifSetting.data?.value?.amount || 0);
    const totalCash = r2(bankBalance + cashInFactory);

    // ── Sales ─────────────────────────────────────────────────────────────────
    const localSales   = r2((salesThis.data||[]).reduce((s,x)=>s+parseFloat(x.final_amount||0),0));
    const webSales     = r2((webThis.data||[]).reduce((s,x)=>s+parseFloat(x.total||0),0));
    // B2B: use bank credits tagged as foreign inward + b2b_orders total_value
    const b2bWire      = r2((b2bThis.data||[]).reduce((s,x)=>s+parseFloat(x.amount||0),0));
    const { data: b2bOrds } = await supabase.from('b2b_orders').select('total_value').gte('date', mStart).not('stage','eq','cancelled');
    const b2bOrdsVal   = r2((b2bOrds||[]).reduce((s,x)=>s+parseFloat(x.total_value||0),0));
    const b2bSales     = r2(Math.max(b2bWire, b2bOrdsVal));
    const totalSales   = r2(localSales + webSales + b2bSales);

    // Previous month sales for growth
    const prevLocalSales = r2((salesPrev.data||[]).reduce((s,x)=>s+parseFloat(x.final_amount||0),0));
    const prevWebSales   = r2((webPrev.data||[]).reduce((s,x)=>s+parseFloat(x.total||0),0));
    const prevTotalSales = r2(prevLocalSales + prevWebSales);
    const salesGrowth    = prevTotalSales > 0 ? r2((totalSales - prevTotalSales) / prevTotalSales * 100) : null;

    // ── Expenses ──────────────────────────────────────────────────────────────
    const actualExpenses = r2((expThis.data||[]).reduce((s,x)=>s+parseFloat(x.amount||0),0));
    const prevExpenses   = r2((expPrev.data||[]).reduce((s,x)=>s+parseFloat(x.amount||0),0));
    const expByCat       = {};
    for (const e of (expThis.data||[])) expByCat[e.category] = r2((expByCat[e.category]||0)+parseFloat(e.amount||0));

    // ── Salary (auto from attendance) ────────────────────────────────────────
    const workDays = {};
    for (const a of (attendance.data||[])) {
      if (a.status==='present')  workDays[a.employee_id] = (workDays[a.employee_id]||0)+1;
      if (a.status==='half-day') workDays[a.employee_id] = (workDays[a.employee_id]||0)+0.5;
    }
    const salaryBreakdown = (employees.data||[]).map(e => {
      const days   = workDays[e.id] || 0;
      const earned = e.pay_type==='daily' ? r2(days*(e.daily_rate||0)) : r2(e.monthly_salary||0);
      return { name: e.name, role: e.role, days, earned };
    });
    const totalSalary = r2(salaryBreakdown.reduce((s,e)=>s+e.earned,0));

    // ── Forecast / upcoming ───────────────────────────────────────────────────
    const recurringTotal = r2((recurringExp.data||[]).reduce((s,r)=>s+(r.amount||0),0));
    const billsDue30     = r2((bills.data||[]).reduce((s,b)=>s+Math.max(0,r2((b.amount||0)+(b.gst_amount||0)-(b.paid_amount||0))),0));
    const projectedTotal = r2(totalSalary + recurringTotal + actualExpenses + billsDue30);
    const netPosition    = r2(totalCash - projectedTotal);
    const profitLoss     = r2(totalSales - actualExpenses - totalSalary);

    const cashStatus = netPosition >= 50000 ? 'healthy' : netPosition >= 0 ? 'tight' : 'shortage';

    res.json({
      month: mStr, as_of: today.toISOString().slice(0,10),
      cash: { bank: bankBalance, factory: cashInFactory, total: totalCash },
      sales: {
        local: localSales, website: webSales, b2b: b2bSales, total: totalSales,
        prev_total: prevTotalSales, growth_pct: salesGrowth,
        local_count: (salesThis.data||[]).length,
        web_count: (webThis.data||[]).length,
      },
      expenses: {
        actual: actualExpenses, prev_month: prevExpenses, by_category: expByCat,
        salary: totalSalary, salary_breakdown: salaryBreakdown,
        recurring: recurringTotal,
        bills_due_30: billsDue30,
        projected_total: projectedTotal,
      },
      bottom_line: { profit_loss: profitLoss, net_cash_after_expenses: netPosition, status: cashStatus },
    });
  } catch (e) {
    console.error('[SimpleDashboard]', e);
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
