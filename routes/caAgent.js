const express  = require('express');
const router   = express.Router();
const { auth } = require('../middleware/auth');
const supabase  = require('../config/supabase');
const { exec }  = require('child_process');
const path      = require('path');

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

// POST /api/ca-agent/run — trigger a manual run
router.post('/run', auth, roleGuard, async (req, res) => {
  try {
    const scriptPath = path.join(__dirname, '../scripts/ca-agent.js');
    // Fire and forget — agent runs in background
    exec(`node ${scriptPath} >> /var/log/sathvam-ca-agent.log 2>&1`, (err) => {
      if (err) console.error('[CA Agent] manual run error:', err.message);
    });
    res.json({ ok: true, message: 'CA Agent started — check findings in ~30 seconds' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
