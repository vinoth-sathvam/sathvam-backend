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
 * Daily batch CCO scan — expense spikes, weekend entries, missing narrations in bulk.
 */
async function runCCODailyScan() {
  const today     = new Date().toISOString().slice(0, 10);
  const findings  = [];

  // A. Expense spike — category spend this month vs 3-month avg >40%
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const threeAgo   = new Date(new Date().setMonth(new Date().getMonth() - 3)).toISOString().slice(0, 10);

  const { data: thisMonthExp } = await supabase
    .from('money_ledger')
    .select('subcategory,amount')
    .eq('direction', 'out')
    .eq('category', 'expense')
    .gte('txn_date', monthStart);

  const { data: prevExp } = await supabase
    .from('money_ledger')
    .select('subcategory,amount')
    .eq('direction', 'out')
    .eq('category', 'expense')
    .gte('txn_date', threeAgo)
    .lt('txn_date', monthStart);

  const thisByCat = {}, prevByCat = {};
  for (const r of (thisMonthExp || [])) {
    thisByCat[r.subcategory] = (thisByCat[r.subcategory] || 0) + (parseFloat(r.amount) || 0);
  }
  for (const r of (prevExp || [])) {
    prevByCat[r.subcategory] = (prevByCat[r.subcategory] || 0) + (parseFloat(r.amount) || 0);
  }

  for (const [cat, thisAmt] of Object.entries(thisByCat)) {
    const avg3 = (prevByCat[cat] || 0) / 3;
    if (avg3 > 0 && thisAmt > avg3 * 1.4 && thisAmt > 5000) {
      const pct = Math.round((thisAmt / avg3 - 1) * 100);
      findings.push({
        severity:    'medium',
        category:    'expense_spike',
        title:       `Expense spike in "${cat}" — ${pct}% above 3-month avg`,
        description: `"${cat}" expenses this month: ₹${thisAmt.toLocaleString('en-IN')} vs 3-month avg of ₹${avg3.toLocaleString('en-IN')}. ${pct}% higher. Review if increase is justified.`,
        amount:      thisAmt,
      });
    }
  }

  // B. Cash payments >₹40A(3) threshold (₹10K per vendor per day) that weren't flagged real-time
  const { data: cashBig } = await supabase
    .from('money_ledger')
    .select('txn_date,party,amount,id,email_sent')
    .eq('payment_mode', 'cash')
    .eq('direction', 'out')
    .gte('amount', 10000)
    .gte('txn_date', monthStart);

  // Group by vendor+date
  const cashGroups = {};
  for (const r of (cashBig || [])) {
    const key = `${r.txn_date}_${r.party}`;
    if (!cashGroups[key]) cashGroups[key] = { date: r.txn_date, party: r.party, total: 0 };
    cashGroups[key].total += parseFloat(r.amount) || 0;
  }
  for (const g of Object.values(cashGroups)) {
    if (g.total > 10000) {
      findings.push({
        severity:    'high',
        category:    'sec_40a3',
        title:       `Sec 40A(3) risk — Cash ₹${g.total.toLocaleString('en-IN')} to "${g.party}" on ${g.date}`,
        description: `Total cash payments to "${g.party}" on ${g.date} = ₹${g.total.toLocaleString('en-IN')}, exceeding ₹10K limit under Sec 40A(3). These expenses may be disallowed in ITR.`,
        amount:      g.total,
      });
    }
  }

  // C. Large transactions without narration (catch anything missed in real-time)
  const { data: noNarr } = await supabase
    .from('money_ledger')
    .select('id,txn_date,amount,direction,party')
    .gte('amount', ALERT_THRESHOLD)
    .or('narration.is.null,narration.eq.')
    .gte('txn_date', monthStart);

  for (const r of (noNarr || [])) {
    findings.push({
      severity:    'low',
      category:    'missing_narration',
      title:       `No narration — ₹${parseFloat(r.amount).toLocaleString('en-IN')} on ${r.txn_date}`,
      description: `Transaction ID #${r.id} — ₹${parseFloat(r.amount).toLocaleString('en-IN')} ${r.direction} to/from "${r.party || 'unknown'}" has no narration.`,
      txn_ref:     String(r.id),
      amount:      parseFloat(r.amount),
    });
  }

  // Remove duplicates — check if same title was already saved today
  const { data: todayFindings } = await supabase
    .from('cco_findings')
    .select('title')
    .gte('found_at', today + 'T00:00:00Z');
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
