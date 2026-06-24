/**
 * Flash Offer API
 * GET  /api/flash-offer/stats     — run history + cooldown count
 * POST /api/flash-offer/run       — manual trigger (admin only)
 * GET  /api/flash-offer/messages  — get message templates
 * PUT  /api/flash-offer/messages  — update message templates (admin only)
 */

const express = require('express');
const router  = express.Router();
const { spawn } = require('child_process');
const path    = require('path');
const { auth, requireRole } = require('../middleware/auth');
const supabase = require('../config/supabase');

function daysSince(d) {
  return !d ? 9999 : Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
}

// GET /api/flash-offer/stats
router.get('/stats', auth, async (req, res) => {
  try {
    const [histRow, coolRow] = await Promise.all([
      supabase.from('settings').select('value').eq('key', 'flash_offer_runs').single(),
      supabase.from('settings').select('value').eq('key', 'flash_offer_cooldowns').single(),
    ]);
    const runs      = Array.isArray(histRow.data?.value) ? histRow.data.value : [];
    const cooldowns = coolRow.data?.value || {};
    const inCooldown = Object.values(cooldowns).filter(d => daysSince(d) < 7).length;
    const today = new Date().toISOString().slice(0, 10);
    const sentToday = runs.find(r => r.date === today && !r.dryRun) || null;
    res.json({ runs: runs.slice(0, 30), inCooldown, sentToday, cooldownDays: 7 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/flash-offer/run
router.post('/run', auth, requireRole('admin'), async (req, res) => {
  try {
    const { window = 'eve', dry_run = false } = req.body;
    const scriptPath = path.resolve(__dirname, '../scripts/flash-offer.js');
    const args = [`--window=${window}`];
    if (dry_run) args.push('--dry-run');
    const child = spawn(process.execPath, [scriptPath, ...args], {
      detached: true, stdio: 'ignore', env: { ...process.env },
    });
    child.unref();
    res.json({ ok: true, message: `Flash offer broadcast started${dry_run ? ' (dry run)' : ''}`, window, pid: child.pid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
