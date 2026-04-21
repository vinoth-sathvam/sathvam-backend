'use strict';
/**
 * Deployment notification routes.
 *
 * POST /api/deploy-notify        — called by GitHub Actions after each deploy
 *                                  Saves deployment record to settings table.
 * GET  /api/deploy-notify/latest — called by admin panel to check for new deploys
 *
 * Auth for POST: x-service-key header (DEPLOY_NOTIFY_KEY in .env)
 * Auth for GET:  admin JWT cookie (any role)
 */

const express   = require('express');
const router    = express.Router();
const { createClient } = require('@supabase/supabase-js');
const auth      = require('../middleware/auth');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SERVICE_KEY  = process.env.DEPLOY_NOTIFY_KEY;
const HISTORY_KEY  = 'deployment_history';
const MAX_HISTORY  = 20;

function serviceAuth(req, res, next) {
  if (!SERVICE_KEY || req.headers['x-service-key'] !== SERVICE_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── POST /api/deploy-notify ─────────────────────────────────────────────────
router.post('/', serviceAuth, async (req, res) => {
  const {
    repo    = 'sathvam-frontend',
    branch  = 'main',
    commit  = '',
    message = '',
    author  = '',
    status  = 'success',
  } = req.body;

  const record = {
    id:        Date.now(),
    repo,
    branch,
    commit:    commit.slice(0, 7),
    message:   (message || '').split('\n')[0].slice(0, 200),
    author,
    status,
    deployed_at: new Date().toISOString(),
  };

  try {
    // Load existing history
    const { data: existing } = await supabase
      .from('settings')
      .select('value')
      .eq('key', HISTORY_KEY)
      .single();

    const history = Array.isArray(existing?.value) ? existing.value : [];
    const updated = [record, ...history].slice(0, MAX_HISTORY);

    await supabase.from('settings').upsert(
      { key: HISTORY_KEY, value: updated },
      { onConflict: 'key' }
    );

    console.log(`[deploy-notify] ${status === 'success' ? '✅' : '❌'} ${repo}@${record.commit} by ${author}`);
    res.json({ ok: true, record });
  } catch (e) {
    console.error('[deploy-notify] DB error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/deploy-notify/latest ──────────────────────────────────────────
router.get('/latest', auth, async (req, res) => {
  try {
    const { data } = await supabase
      .from('settings')
      .select('value')
      .eq('key', HISTORY_KEY)
      .single();

    const history = Array.isArray(data?.value) ? data.value : [];
    res.json({ deployments: history });
  } catch (e) {
    res.json({ deployments: [] });
  }
});

module.exports = router;
