const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');

const ADMIN_ROLES = ['admin', 'ceo'];

// GET /api/messages — fetch messages relevant to current user
router.get('/', auth, async (req, res) => {
  try {
    const { role } = req.user;
    let q = supabase.from('internal_messages').select('*').order('created_at', { ascending: true }).limit(500);

    if (ADMIN_ROLES.includes(role)) {
      // Admin/CEO: see all messages (sent + received)
      // no additional filter
    } else {
      // Manager/HR: see messages addressed to their role + messages they sent
      q = q.or(`to_role.eq.${role},from_role.eq.${role}`);
    }

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/messages/unread-count — unread count for current user's role
router.get('/unread-count', auth, async (req, res) => {
  try {
    const { role } = req.user;
    const { count, error } = await supabase
      .from('internal_messages')
      .select('*', { count: 'exact', head: true })
      .eq('to_role', role)
      .is('read_at', null);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ count: count || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/messages — send a new message or reply in an existing thread
router.post('/', auth, async (req, res) => {
  try {
    const { name, role } = req.user;
    const { to_role, to_user, message, thread_id } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'message is required' });
    if (!to_role)          return res.status(400).json({ error: 'to_role is required' });

    const { data, error } = await supabase
      .from('internal_messages')
      .insert({
        thread_id: thread_id || crypto.randomUUID(),
        from_user: name || role,
        from_role: role,
        to_user:   to_user || null,
        to_role,
        message:   message.trim(),
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/messages/:id/read — mark a message as read
router.patch('/:id/read', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('internal_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .is('read_at', null)
      .select()
      .single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data || { ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
