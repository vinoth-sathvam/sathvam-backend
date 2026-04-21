'use strict';
/**
 * Manager Daily Tasks
 * GET  /api/manager-daily/status — live completion status of all daily tasks
 * POST /api/manager-daily/chat   — bilingual AI assistant for daily guidance
 */

const express    = require('express');
const router     = express.Router();
const { createClient } = require('@supabase/supabase-js');
const Anthropic  = require('@anthropic-ai/sdk');
const { auth }   = require('../middleware/auth');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const claude   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Returns today's date in IST (YYYY-MM-DD)
function todayIST() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

// ── GET /api/manager-daily/status ──────────────────────────────────────────
router.get('/status', auth, async (req, res) => {
  const today = todayIST();

  const [att, bat, flour, procPend, ordNew, ordConf, qc, maint] = await Promise.allSettled([
    supabase.from('attendance').select('id', { count: 'exact', head: true }).eq('date', today),
    supabase.from('batches').select('id', { count: 'exact', head: true }).eq('date', today),
    supabase.from('flour_batches').select('id', { count: 'exact', head: true }).eq('date', today),
    supabase.from('procurements').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('webstore_orders').select('id', { count: 'exact', head: true }).eq('status', 'new'),
    supabase.from('webstore_orders').select('id', { count: 'exact', head: true }).eq('status', 'confirmed'),
    supabase.from('quality_tests').select('id', { count: 'exact', head: true }).gte('tested_at', today + 'T00:00:00'),
    supabase.from('machine_maintenance').select('id,machine_name,next_service_due').lte('next_service_due', today).order('next_service_due'),
  ]);

  const cnt  = r => (r.status === 'fulfilled' ? (r.value.count ?? 0) : 0);
  const rows = r => (r.status === 'fulfilled' ? (r.value.data ?? []) : []);

  res.json({
    today,
    tasks: {
      attendance:      { count: cnt(att),      done: cnt(att) > 0 },
      batches:         { count: cnt(bat),      done: cnt(bat) > 0 },
      flourBatches:    { count: cnt(flour),    done: cnt(flour) > 0 },
      pendingProcure:  { count: cnt(procPend), done: cnt(procPend) === 0 },
      newOrders:       { count: cnt(ordNew),   done: cnt(ordNew) === 0 },
      confirmedOrders: { count: cnt(ordConf),  done: cnt(ordConf) === 0 },
      qualityToday:    { count: cnt(qc),       done: cnt(qc) > 0 },
      maintenance:     { count: rows(maint).length, done: rows(maint).length === 0, items: rows(maint).slice(0,5) },
    },
  });
});

// ── POST /api/manager-daily/chat ───────────────────────────────────────────
router.post('/chat', auth, async (req, res) => {
  const { message = '', history = [], status } = req.body;

  const t = status?.tasks || {};
  const taskContext = status ? `
Today (${status.today}) task status:
- Attendance marked: ${t.attendance?.done ? `Yes (${t.attendance.count} records)` : 'NOT DONE'}
- Oil batches entered: ${t.batches?.done ? `Yes (${t.batches.count} batch${t.batches.count>1?'es':''})` : 'NOT DONE'}
- Flour batches entered: ${t.flourBatches?.done ? `Yes (${t.flourBatches.count})` : 'NOT DONE'}
- Pending procurement approvals: ${t.pendingProcure?.count ?? 0}
- New unconfirmed website orders: ${t.newOrders?.count ?? 0}
- Confirmed orders not yet packed: ${t.confirmedOrders?.count ?? 0}
- Quality checks done today: ${t.qualityToday?.done ? `Yes (${t.qualityToday.count})` : 'NOT DONE'}
- Overdue maintenance items: ${t.maintenance?.count ?? 0}${t.maintenance?.items?.length ? ' (' + t.maintenance.items.map(i=>i.machine_name).join(', ') + ')' : ''}
` : '';

  const system = `You are the daily factory operations assistant for Sathvam Natural Products, a cold-pressed oil factory in Karur, Tamil Nadu, India.
You help the factory manager (மேலாளர்) plan and complete their daily tasks efficiently.
${taskContext}
IMPORTANT RULES:
1. Always respond in BOTH English AND Tamil in this exact format:
**English:** [your response in English]

**தமிழ்:** [same response in Tamil]

2. Keep responses short, practical, and friendly.
3. When tasks are pending, tell the manager clearly what to do and where.
4. Use simple language — no jargon.
5. Be encouraging and supportive.`;

  try {
    const msgs = [
      ...history.slice(-8).map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: message },
    ];
    const resp = await claude.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 700,
      system,
      messages:   msgs,
    });
    res.json({ reply: resp.content[0].text });
  } catch (e) {
    console.error('[manager-daily/chat]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
