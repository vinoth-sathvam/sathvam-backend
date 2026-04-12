const express    = require('express');
const router     = express.Router();
const Anthropic  = require('@anthropic-ai/sdk');
const supabase   = require('../config/supabase');
const { auth, requireRole } = require('../middleware/auth');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const adminOnly = [auth, requireRole('admin','ceo','manager')];

// ── Fetch all data the agent needs ───────────────────────────────────────────
async function fetchMonitorData() {
  const today = new Date().toISOString().slice(0,10);

  const [b2bOrders, b2bCustomers, projects, wsOrders] = await Promise.all([
    supabase.from('b2b_orders')
      .select('id,order_no,customer_id,customer_name,stage,total_value,currency,notes,created_at,b2b_order_items(*),b2b_order_stages(*)')
      .order('created_at',{ascending:false}).limit(200),
    supabase.from('b2b_customers')
      .select('id,company_name,contact_name,email,country,currency,active').limit(200),
    supabase.from('projects')
      .select('id,project_name,buyer_name,buyer_country,status,pi_no,pi_date,bl_no,container_no,etd,mfg_invoice_no,merch_invoice_no,created_at')
      .order('created_at',{ascending:false}).limit(100),
    supabase.from('webstore_orders')
      .select('id,order_no,status,total,created_at,customer')
      .in('status',['new','confirmed']).order('created_at',{ascending:false}).limit(50),
  ]);

  // Fetch full project blobs for active projects
  const activeProjects = (projects.data||[]).filter(p=>p.status!=='completed'&&p.status!=='cancelled');
  let projectFulls = {};
  if (activeProjects.length) {
    const { data: metas } = await supabase.from('settings')
      .select('key,value').in('key', activeProjects.map(p=>`project_full_${p.id}`));
    (metas||[]).forEach(m=>{ projectFulls[m.key] = m.value; });
  }

  return {
    today,
    b2bOrders:    b2bOrders.data   || [],
    b2bCustomers: b2bCustomers.data|| [],
    projects:     (projects.data||[]).map(p=>({
      ...p,
      _full: projectFulls[`project_full_${p.id}`]||null
    })),
    wsOrders:     wsOrders.data    || [],
  };
}

// ── Build prompt for Claude ───────────────────────────────────────────────────
function buildPrompt(data) {
  const { today, b2bOrders, b2bCustomers, projects, wsOrders } = data;

  const ordersJson = b2bOrders.slice(0,50).map(o=>({
    order_no:      o.order_no,
    customer:      o.customer_name,
    stage:         o.stage,
    value:         `${o.currency} ${o.total_value}`,
    created:       o.created_at?.slice(0,10),
    days_old:      Math.floor((Date.now()-new Date(o.created_at))/86400000),
    items_count:   (o.b2b_order_items||[]).length,
    items_missing: (o.b2b_order_items||[]).filter(i=>!i.product_name||!i.quantity||parseFloat(i.quantity)===0).length,
    last_stage_update: o.b2b_order_stages?.length ?
      o.b2b_order_stages.sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))[0]?.created_at?.slice(0,10)
      : o.created_at?.slice(0,10),
    stages_recorded: (o.b2b_order_stages||[]).map(s=>s.stage),
    notes: o.notes||'',
  }));

  const projectsJson = projects.filter(p=>p.status!=='completed'&&p.status!=='cancelled').map(p=>({
    name:           p.project_name,
    buyer:          `${p.buyer_name} (${p.buyer_country})`,
    status:         p.status,
    pi_no:          p.pi_no||'MISSING',
    bl_no:          p.bl_no||'MISSING',
    container_no:   p.container_no||'MISSING',
    etd:            p.etd||'MISSING',
    etd_days_left:  p.etd ? Math.floor((new Date(p.etd)-Date.now())/86400000) : null,
    mfg_invoice:    p.mfg_invoice_no||'MISSING',
    merch_invoice:  p.merch_invoice_no||'MISSING',
    created:        p.created_at?.slice(0,10),
    days_old:       Math.floor((Date.now()-new Date(p.created_at))/86400000),
    expenses_count: (p._full?.expenses||[]).length,
    mfg_items:      (p._full?.mfg?.items||[]).length,
    merch_items:    (p._full?.merch?.items||[]).length,
    items_missing_hsn: (p._full?.mfg?.items||[]).filter(i=>!i.hsnCode).length +
                       (p._full?.merch?.items||[]).filter(i=>!i.hsnCode).length,
    items_missing_qty: (p._full?.mfg?.items||[]).filter(i=>!i.qty||parseFloat(i.qty)===0).length +
                       (p._full?.merch?.items||[]).filter(i=>!i.qty||parseFloat(i.qty)===0).length,
  }));

  const wsJson = wsOrders.map(o=>({
    order_no: o.order_no,
    status:   o.status,
    total:    o.total,
    days_old: Math.floor((Date.now()-new Date(o.created_at))/86400000),
  }));

  return `You are a strict business operations auditor for Sathvam Oils and Spices Pvt Ltd.
Today is ${today}. Analyze the following data and identify ALL issues, risks, and action items.

## B2B Export Orders (${ordersJson.length} orders):
${JSON.stringify(ordersJson, null, 2)}

## Export Projects (${projectsJson.length} active):
${JSON.stringify(projectsJson, null, 2)}

## Pending Webstore Orders (${wsJson.length}):
${JSON.stringify(wsJson, null, 2)}

## Rules to check:
### B2B Orders:
- Stage not updated in >5 days → HIGH alert
- Stage not updated in >2 days → MEDIUM alert  
- Order has 0 items → CRITICAL
- Order items missing product name or 0 qty → HIGH
- Order in 'order_placed' stage >3 days with no stage history → MEDIUM
- Order value is 0 → HIGH

### Projects:
- ETD within 7 days but BL number missing → CRITICAL
- ETD within 3 days but status not 'shipped' → CRITICAL
- ETD already passed and status not 'shipped'/'completed' → CRITICAL
- PI number missing → HIGH
- MFG or Merch invoice number missing for non-draft projects → HIGH
- Items missing HSN codes → MEDIUM
- Items missing quantities → HIGH
- No expenses recorded for project >7 days old → MEDIUM
- Draft project >14 days old → LOW (may have been forgotten)

### Webstore Orders:
- Order in 'new' status >1 day → HIGH (needs confirmation)
- Order in 'confirmed' status >3 days → MEDIUM (needs packing)

## Response format (strict JSON):
{
  "scan_time": "${new Date().toISOString()}",
  "summary": "1-2 sentence overall health summary",
  "score": <0-100, 100 = all good>,
  "issues": [
    {
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "category": "b2b_order|project|webstore",
      "reference": "order/project name or number",
      "issue": "concise description of the problem",
      "action": "specific action needed to fix it",
      "days_delayed": <number or null>
    }
  ],
  "all_clear": [
    "brief note on things that are fine"
  ]
}

Return ONLY valid JSON. No markdown, no explanation outside the JSON.`;
}

// ── Run the agent ─────────────────────────────────────────────────────────────
async function runAgent() {
  const data = await fetchMonitorData();
  const prompt = buildPrompt(data);

  const msg = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = msg.content[0]?.text?.trim() || '{}';
  // Strip markdown code fences if present
  const jsonStr = raw.replace(/^```json?\n?/,'').replace(/\n?```$/,'');
  const report = JSON.parse(jsonStr);

  // Save report to DB
  await supabase.from('settings').upsert({
    key: 'monitor_agent_report',
    value: { ...report, _fetched_at: new Date().toISOString() },
    updated_at: new Date(),
  });

  return report;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET latest saved report
router.get('/report', ...adminOnly, async (req, res) => {
  const { data, error } = await supabase.from('settings').select('value,updated_at').eq('key','monitor_agent_report').single();
  if (error || !data) return res.json({ issues:[], summary:'No report yet. Run a scan first.', score:null, _fetched_at:null });
  res.json({ ...data.value, _saved_at: data.updated_at });
});

// POST trigger a new scan
router.post('/run', ...adminOnly, async (req, res) => {
  try {
    const report = await runAgent();
    res.json(report);
  } catch(err) {
    console.error('Monitor agent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.runMonitorAgent = runAgent;

