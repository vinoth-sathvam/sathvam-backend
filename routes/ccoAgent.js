/**
 * routes/ccoAgent.js
 * Chief Controller Officer — AI anomaly detection & compliance monitor.
 * Runs on every transaction >₹10K (real-time) and daily batch.
 * Sends email alerts. No approval gate — purely monitoring.
 */
const express  = require('express');
const router   = express.Router();
const supabase = require('../config/supabase');
const { auth, requireRole } = require('../middleware/auth');
const { sendEmail, emailHtml } = require('../utils/email');

const ALLOWED = requireRole('admin','ceo','manager','accountant');
const ALERT_THRESHOLD = 10000; // ₹10,000

// ─── CCO CHECKS ──────────────────────────────────────────────────────────────

/**
 * Real-time check called after a single transaction >₹10K is recorded.
 * @param {Object} txn  — a money_ledger row
 */
async function runCCOCheck(txn) {
  const findings = [];
  const amt      = parseFloat(txn.amount) || 0;

  // 1. Duplicate detection — same party, same direction, ±10% amount, within 7 days
  if (txn.party) {
    const sevenAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const { data: dups } = await supabase
      .from('money_ledger')
      .select('id,txn_date,amount,party,narration,reference_no')
      .eq('direction',  txn.direction)
      .ilike('party',   txn.party)
      .gte('txn_date',  sevenAgo)
      .neq('id',        txn.id || 0);

    const similar = (dups || []).filter(d => {
      const da = parseFloat(d.amount) || 0;
      return da > 0 && Math.abs(da - amt) / amt < 0.10;
    });

    if (similar.length > 0) {
      findings.push({
        severity:    'high',
        category:    'duplicate',
        title:       `Possible duplicate — ${txn.direction === 'out' ? 'payment to' : 'receipt from'} ${txn.party}`,
        description: `₹${amt.toLocaleString('en-IN')} ${txn.direction === 'out' ? 'paid to' : 'received from'} "${txn.party}". Similar ₹${parseFloat(similar[0].amount).toLocaleString('en-IN')} found on ${similar[0].txn_date}. Verify this is not a duplicate entry.`,
        txn_ref:     txn.reference_no || '',
        amount:      amt,
      });
    }
  }

  // 2. Cash limit — Sec 269ST: cash receipt/payment >₹2L is illegal
  if ((txn.payment_mode || '') === 'cash' && amt > 200000) {
    findings.push({
      severity:    'critical',
      category:    'cash_limit',
      title:       `Sec 269ST violation — cash ${txn.direction === 'in' ? 'receipt' : 'payment'} >₹2L`,
      description: `Cash ${txn.direction === 'in' ? 'receipt' : 'payment'} of ₹${amt.toLocaleString('en-IN')} to/from "${txn.party || 'party'}" violates Sec 269ST of Income Tax Act. Penalty: 100% of transaction amount. Switch to bank transfer immediately.`,
      txn_ref:     txn.reference_no || '',
      amount:      amt,
    });
  }

  // 3. Round-number red flag — amounts exactly divisible by ₹1L (suspicious for fake entries)
  if (amt >= 100000 && amt % 100000 === 0) {
    findings.push({
      severity:    'medium',
      category:    'round_number',
      title:       `Round-number transaction — ₹${(amt / 100000).toFixed(0)}L — verify authenticity`,
      description: `₹${amt.toLocaleString('en-IN')} is an exact round number. Such entries are a common internal audit flag. Ensure supporting invoice/voucher is attached.`,
      txn_ref:     txn.reference_no || '',
      amount:      amt,
    });
  }

  // 4. Missing narration
  if (!txn.narration || txn.narration.trim().length < 5) {
    findings.push({
      severity:    'low',
      category:    'missing_narration',
      title:       `No narration — ₹${amt.toLocaleString('en-IN')} ${txn.direction} needs description`,
      description: `Transaction of ₹${amt.toLocaleString('en-IN')} has no narration. All transactions >₹10K must have a clear purpose for audit trail. Update the narration.`,
      txn_ref:     txn.reference_no || '',
      amount:      amt,
    });
  }

  // 5. First-time / unknown party (for large outflows)
  if (txn.direction === 'out' && txn.party && amt >= 25000) {
    const { data: prev } = await supabase
      .from('money_ledger')
      .select('id')
      .eq('direction', 'out')
      .ilike('party', txn.party)
      .neq('id', txn.id || 0)
      .limit(1);

    if (!prev || prev.length === 0) {
      findings.push({
        severity:    'medium',
        category:    'new_party',
        title:       `First payment to "${txn.party}" — ₹${amt.toLocaleString('en-IN')}`,
        description: `This is the first recorded payment to "${txn.party}". For new vendors/parties receiving >₹25K, ensure PAN is collected and vendor is verified before payment.`,
        txn_ref:     txn.reference_no || '',
        amount:      amt,
      });
    }
  }

  // Save findings
  if (findings.length > 0) {
    await supabase.from('cco_findings').insert(
      findings.map(f => ({ ...f, found_at: new Date().toISOString(), email_sent: true }))
    );
    await sendCCOAlertEmail(txn, findings);
  } else {
    // Send clean-bill email for large transactions even when no issues
    await sendCCOCleanEmail(txn);
  }
}

/**
 * Daily batch CCO scan — queries source tables directly, not money_ledger.
 */
async function runCCODailyScan() {
  const today      = new Date().toISOString().slice(0, 10);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const threeAgo   = new Date(new Date().getFullYear(), new Date().getMonth() - 3, 1).toISOString().slice(0, 10);
  const findings   = [];

  // ── A. Expense spike — category this month vs 3-month avg >40% ──────────
  const { data: thisMonthExp } = await supabase
    .from('company_expenses').select('category,amount').is('deleted_at', null).gte('date', monthStart);
  const { data: prevExp } = await supabase
    .from('company_expenses').select('category,amount').is('deleted_at', null)
    .gte('date', threeAgo).lt('date', monthStart);

  const thisByCat = {}, prevByCat = {};
  for (const r of (thisMonthExp || [])) {
    thisByCat[r.category] = (thisByCat[r.category] || 0) + (parseFloat(r.amount) || 0);
  }
  for (const r of (prevExp || [])) {
    prevByCat[r.category] = (prevByCat[r.category] || 0) + (parseFloat(r.amount) || 0);
  }
  for (const [cat, thisAmt] of Object.entries(thisByCat)) {
    const avg3 = (prevByCat[cat] || 0) / 3;
    if (avg3 > 0 && thisAmt > avg3 * 1.4 && thisAmt > 5000) {
      const pct = Math.round((thisAmt / avg3 - 1) * 100);
      findings.push({
        severity:    'medium',
        category:    'expense_spike',
        title:       `Expense spike in "${cat}" — ${pct}% above 3-month avg`,
        description: `"${cat}" expenses this month: ₹${thisAmt.toLocaleString('en-IN')} vs 3-month avg ₹${avg3.toLocaleString('en-IN')} (+${pct}%). Review if justified.`,
        amount:      thisAmt,
      });
    }
  }

  // ── B. Sec 40A(3) — cash expenses >₹10K per vendor per day ─────────────
  const { data: cashExp } = await supabase
    .from('company_expenses').select('date,vendor_name,amount')
    .is('deleted_at', null).eq('payment_mode', 'cash').gte('amount', 10000).gte('date', monthStart);

  const cashGroups = {};
  for (const r of (cashExp || [])) {
    const key = `${r.date}_${r.vendor_name || 'unknown'}`;
    if (!cashGroups[key]) cashGroups[key] = { date: r.date, party: r.vendor_name || 'unknown', total: 0 };
    cashGroups[key].total += parseFloat(r.amount) || 0;
  }
  for (const g of Object.values(cashGroups)) {
    if (g.total > 10000) {
      findings.push({
        severity:    'high',
        category:    'sec_40a3',
        title:       `Sec 40A(3) risk — Cash ₹${g.total.toLocaleString('en-IN')} to "${g.party}" on ${g.date}`,
        description: `Cash payments to "${g.party}" on ${g.date} total ₹${g.total.toLocaleString('en-IN')}, exceeding ₹10K Sec 40A(3) limit. May be disallowed in ITR.`,
        amount:      g.total,
      });
    }
  }

  // ── C. Sec 269ST — cash expense >₹2L ────────────────────────────────────
  const { data: bigCash } = await supabase
    .from('company_expenses').select('date,vendor_name,amount')
    .is('deleted_at', null).eq('payment_mode', 'cash').gte('amount', 200000).gte('date', monthStart);
  for (const r of (bigCash || [])) {
    findings.push({
      severity:    'critical',
      category:    'cash_limit',
      title:       `Sec 269ST violation — Cash ₹${parseFloat(r.amount).toLocaleString('en-IN')} to "${r.vendor_name || 'party'}"`,
      description: `Cash expense of ₹${parseFloat(r.amount).toLocaleString('en-IN')} on ${r.date} violates Sec 269ST (max ₹2L cash). Penalty: 100% of amount. Switch to bank transfer.`,
      amount:      parseFloat(r.amount),
    });
  }

  // ── D. Expenses with missing/vague description (amount >₹5K) ────────────
  const { data: noDesc } = await supabase
    .from('company_expenses').select('id,date,amount,category,vendor_name,description')
    .is('deleted_at', null).gte('amount', 5000).gte('date', monthStart);
  for (const r of (noDesc || [])) {
    if ((r.description || '').trim().length < 5) {
      findings.push({
        severity:    'low',
        category:    'missing_narration',
        title:       `Missing description — ₹${parseFloat(r.amount).toLocaleString('en-IN')} expense on ${r.date}`,
        description: `Expense #${r.id} (${r.category}, vendor: ${r.vendor_name || 'none'}) has no description. All expenses >₹5K need a clear purpose for audit trail.`,
        txn_ref:     String(r.id),
        amount:      parseFloat(r.amount),
      });
    }
  }

  // ── E. Duplicate expenses — same vendor, same amount, within 7 days ─────
  const { data: allExps } = await supabase
    .from('company_expenses').select('id,date,amount,vendor_name')
    .is('deleted_at', null).gte('date', monthStart);
  const expSeen = {};
  for (const r of (allExps || [])) {
    const key = `${r.vendor_name || ''}_${Math.round(parseFloat(r.amount))}`;
    if (!expSeen[key]) { expSeen[key] = r; continue; }
    const prev = expSeen[key];
    const daysDiff = Math.abs(new Date(r.date) - new Date(prev.date)) / 86400000;
    if (daysDiff <= 7) {
      findings.push({
        severity:    'high',
        category:    'duplicate',
        title:       `Possible duplicate — ₹${parseFloat(r.amount).toLocaleString('en-IN')} to "${r.vendor_name || 'vendor'}" twice in ${Math.round(daysDiff)} days`,
        description: `Expenses #${prev.id} (${prev.date}) and #${r.id} (${r.date}) have the same amount ₹${parseFloat(r.amount).toLocaleString('en-IN')} to the same vendor. Verify not a duplicate.`,
        txn_ref:     `#${prev.id} & #${r.id}`,
        amount:      parseFloat(r.amount),
      });
      delete expSeen[key];
    } else {
      expSeen[key] = r;
    }
  }

  // ── F. Round-number large expenses (potential fake entries) ──────────────
  const { data: roundExps } = await supabase
    .from('company_expenses').select('id,date,amount,category,vendor_name')
    .is('deleted_at', null).gte('amount', 100000).gte('date', monthStart);
  for (const r of (roundExps || [])) {
    const amt = parseFloat(r.amount);
    if (amt % 100000 === 0) {
      findings.push({
        severity:    'medium',
        category:    'round_number',
        title:       `Round-number expense ₹${(amt/100000).toFixed(0)}L — verify invoice`,
        description: `₹${amt.toLocaleString('en-IN')} ${r.category} expense on ${r.date} to "${r.vendor_name || 'unknown'}" is exact round figure — common audit flag. Ensure original invoice is attached.`,
        txn_ref:     String(r.id),
        amount:      amt,
      });
    }
  }

  // ── G. Large procurement orders without supplier name ────────────────────
  const { data: procs } = await supabase
    .from('procurements').select('id,date,ordered_qty,ordered_price_per_kg,supplier').gte('date', monthStart);
  for (const p of (procs || [])) {
    const amt = (parseFloat(p.ordered_qty) || 0) * (parseFloat(p.ordered_price_per_kg) || 0);
    if (amt > 25000 && !p.supplier) {
      findings.push({
        severity:    'medium',
        category:    'new_party',
        title:       `Procurement ₹${amt.toLocaleString('en-IN')} on ${p.date} — no vendor recorded`,
        description: `PO #${p.id} worth ₹${amt.toLocaleString('en-IN')} has no supplier recorded. Vendor name and PAN required for procurement >₹25K.`,
        txn_ref:     String(p.id),
        amount:      amt,
      });
    }
  }

  // ── H. Paid webstore orders stuck >5 days without dispatch ───────────────
  const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  const { data: stuckOrders } = await supabase
    .from('webstore_orders').select('order_no,total,date')
    .in('status', ['new','confirmed']).eq('payment_status', 'paid').lte('date', fiveDaysAgo).limit(10);
  if ((stuckOrders || []).length > 0) {
    const total = stuckOrders.reduce((s, r) => s + (parseFloat(r.total) || 0), 0);
    findings.push({
      severity:    'high',
      category:    'operational',
      title:       `${stuckOrders.length} paid order(s) not dispatched for >5 days`,
      description: `Orders: ${stuckOrders.map(o => o.order_no).join(', ')}. Total ₹${total.toLocaleString('en-IN')}. Customer satisfaction risk — check dispatch queue.`,
      amount:      total,
    });
  }

  // ── Deduplicate vs today's already-saved findings ────────────────────────
  const { data: todayFindings } = await supabase
    .from('cco_findings').select('title').gte('found_at', today + 'T00:00:00Z');
  const existingTitles = new Set((todayFindings || []).map(f => f.title));
  const newFindings = findings.filter(f => !existingTitles.has(f.title));

  if (newFindings.length > 0) {
    await supabase.from('cco_findings').insert(
      newFindings.map(f => ({ ...f, found_at: new Date().toISOString(), email_sent: true }))
    );
    await sendCCODailyReport(newFindings);
  }

  return { scanned: true, findings: newFindings.length };
}

// ─── EMAIL HELPERS ────────────────────────────────────────────────────────────

async function sendCCOAlertEmail(txn, findings) {
  const amt      = parseFloat(txn.amount) || 0;
  const sevColor = { critical: '#dc2626', high: '#c2410c', medium: '#a16207', low: '#16a34a' };

  const rows = findings.map(f => `
    <tr>
      <td><span class="badge ${f.severity}">${f.severity.toUpperCase()}</span></td>
      <td><strong>${f.title}</strong><br><span style="color:#64748b;font-size:12px">${f.description}</span></td>
    </tr>`).join('');

  const dirIcon = txn.direction === 'in' ? '🟢' : '🔴';
  const body = `
    <div class="section">
      <h3>Transaction Detected</h3>
      <table>
        <tr><th>Field</th><th>Value</th></tr>
        <tr><td>Direction</td><td>${dirIcon} <strong>${txn.direction.toUpperCase()}</strong></td></tr>
        <tr><td>Amount</td><td><strong>₹${amt.toLocaleString('en-IN')}</strong></td></tr>
        <tr><td>Date</td><td>${txn.txn_date}</td></tr>
        <tr><td>Category</td><td>${txn.category} / ${txn.subcategory || '—'}</td></tr>
        <tr><td>Party</td><td>${txn.party || '—'}</td></tr>
        <tr><td>Mode</td><td>${txn.payment_mode || '—'}</td></tr>
        <tr><td>Narration</td><td>${txn.narration || '—'}</td></tr>
        <tr><td>Reference</td><td>${txn.reference_no || '—'}</td></tr>
      </table>
    </div>
    <div class="section">
      <h3>CCO Findings — ${findings.length} issue(s) found</h3>
      <table><tr><th>Severity</th><th>Finding</th></tr>${rows}</table>
    </div>`;

  const severity = findings.some(f => f.severity === 'critical') ? '🚨 CRITICAL'
                 : findings.some(f => f.severity === 'high')     ? '⚠️ HIGH'
                 : '⚡ ALERT';

  await sendEmail(
    `${severity} — CCO Alert: ₹${amt.toLocaleString('en-IN')} ${txn.direction} · ${new Date().toLocaleDateString('en-IN')}`,
    emailHtml('CCO Transaction Alert', body)
  );
}

async function sendCCOCleanEmail(txn) {
  const amt  = parseFloat(txn.amount) || 0;
  const body = `
    <div class="section">
      <h3>Transaction Recorded — All Checks Passed ✅</h3>
      <table>
        <tr><th>Field</th><th>Value</th></tr>
        <tr><td>Direction</td><td>${txn.direction === 'in' ? '🟢 IN' : '🔴 OUT'}</td></tr>
        <tr><td>Amount</td><td>₹${amt.toLocaleString('en-IN')}</td></tr>
        <tr><td>Date</td><td>${txn.txn_date}</td></tr>
        <tr><td>Party</td><td>${txn.party || '—'}</td></tr>
        <tr><td>Category</td><td>${txn.category}</td></tr>
        <tr><td>Reference</td><td>${txn.reference_no || '—'}</td></tr>
      </table>
      <p style="color:#16a34a;margin-top:12px">✅ No duplicate &nbsp;·&nbsp; ✅ Cash limit OK &nbsp;·&nbsp; ✅ Policy compliant</p>
    </div>`;

  await sendEmail(
    `✅ CCO Clear — ₹${amt.toLocaleString('en-IN')} ${txn.direction} recorded · ${txn.txn_date}`,
    emailHtml('CCO Transaction Cleared', body)
  );
}

async function sendCCODailyReport(findings) {
  const bySeverity = { critical: [], high: [], medium: [], low: [] };
  for (const f of findings) bySeverity[f.severity]?.push(f);

  const section = (sev, items) => {
    if (!items.length) return '';
    const rows = items.map(f => `
      <tr>
        <td><span class="badge ${sev}">${sev.toUpperCase()}</span></td>
        <td><strong>${f.title}</strong>${f.amount ? ` — ₹${f.amount.toLocaleString('en-IN')}` : ''}<br>
        <span style="color:#64748b;font-size:12px">${f.description}</span></td>
      </tr>`).join('');
    return `<tr><th colspan="2" style="background:#f8fafc">${sev.toUpperCase()} (${items.length})</th></tr>${rows}`;
  };

  const body = `
    <div class="section">
      <h3>Daily CCO Scan — ${findings.length} finding(s) · ${new Date().toLocaleDateString('en-IN')}</h3>
      <table>
        <tr><th>Severity</th><th>Finding</th></tr>
        ${section('critical', bySeverity.critical)}
        ${section('high',     bySeverity.high)}
        ${section('medium',   bySeverity.medium)}
        ${section('low',      bySeverity.low)}
      </table>
    </div>
    <p style="font-size:12px;color:#64748b">Login to admin panel → Finance → CCO to resolve findings.</p>`;

  const worstSev = bySeverity.critical.length ? '🚨' : bySeverity.high.length ? '⚠️' : '📋';
  await sendEmail(
    `${worstSev} Daily CCO Report — ${findings.length} findings · ${new Date().toLocaleDateString('en-IN')}`,
    emailHtml('CCO Daily Report', body)
  );
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

/** GET /api/cco/findings */
router.get('/findings', auth, ALLOWED, async (req, res) => {
  const { severity, category, resolved, from, to, page = 1, limit = 50 } = req.query;
  let q = supabase.from('cco_findings').select('*', { count: 'exact' });
  if (severity) q = q.eq('severity', severity);
  if (category) q = q.eq('category', category);
  if (resolved !== undefined) q = q.eq('resolved', resolved === 'true');
  if (from) q = q.gte('found_at', from);
  if (to)   q = q.lte('found_at', to + 'T23:59:59Z');
  const offset = (parseInt(page) - 1) * parseInt(limit);
  q = q.order('found_at', { ascending: false }).range(offset, offset + parseInt(limit) - 1);
  const { data, error, count } = await q;
  if (error) return res.status(400).json({ error: error.message });

  // Summary counts
  const { data: all } = await supabase.from('cco_findings').select('severity,resolved');
  const summary = { total: 0, open: 0, critical: 0, high: 0, medium: 0, low: 0 };
  for (const r of (all || [])) {
    summary.total++;
    if (!r.resolved) { summary.open++; summary[r.severity] = (summary[r.severity] || 0) + 1; }
  }

  res.json({ data, count, summary });
});

/** POST /api/cco/run  — trigger daily scan manually */
router.post('/run', auth, requireRole('admin','ceo'), async (req, res) => {
  try {
    const result = await runCCODailyScan();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** PATCH /api/cco/findings/:id/resolve */
router.patch('/findings/:id/resolve', auth, ALLOWED, async (req, res) => {
  const { resolved = true } = req.body;
  const { data, error } = await supabase
    .from('cco_findings')
    .update({ resolved: Boolean(resolved), resolved_at: resolved ? new Date().toISOString() : null })
    .eq('id', parseInt(req.params.id))
    .select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

module.exports = router;
module.exports.runCCOCheck      = runCCOCheck;
module.exports.runCCODailyScan  = runCCODailyScan;
