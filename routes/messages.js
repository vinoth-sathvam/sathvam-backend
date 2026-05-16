const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');

const ADMIN_ROLES = ['admin', 'ceo'];

// GET /api/messages/contacts — all active staff for direct messaging
router.get('/contacts', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id,name,role,active')
      .eq('active', true)
      .neq('id', req.user.id)
      .order('name');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/messages/unread-count — total unread DMs addressed to me by name
router.get('/unread-count', auth, async (req, res) => {
  try {
    const myName = req.user.name || req.user.username;
    const { count, error } = await supabase
      .from('internal_messages')
      .select('*', { count: 'exact', head: true })
      .eq('to_user', myName)
      .is('read_at', null);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ count: count || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/messages/dm/:otherUserId — DM conversation between me and another user
router.get('/dm/:otherUserId', auth, async (req, res) => {
  try {
    const myName = req.user.name || req.user.username;
    const { data: other, error: ue } = await supabase
      .from('users').select('name').eq('id', req.params.otherUserId).single();
    if (ue || !other) return res.status(404).json({ error: 'User not found' });

    const { data, error } = await supabase
      .from('internal_messages')
      .select('*')
      .order('created_at', { ascending: true })
      .limit(200);
    if (error) return res.status(500).json({ error: error.message });

    // Filter to exact DM pair in JS (avoids PostgREST nested AND/OR syntax issues)
    const msgs = (data || []).filter(m =>
      (m.from_user === myName && m.to_user === other.name) ||
      (m.from_user === other.name && m.to_user === myName)
    );
    res.json(msgs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/messages/dm/:otherUserId/read — mark all messages from this user to me as read
router.post('/dm/:otherUserId/read', auth, async (req, res) => {
  try {
    const myName = req.user.name || req.user.username;
    const { data: other } = await supabase
      .from('users').select('name').eq('id', req.params.otherUserId).single();
    if (!other) return res.json({ ok: true });

    await supabase
      .from('internal_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('from_user', other.name)
      .eq('to_user', myName)
      .is('read_at', null);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/messages — fetch messages relevant to current user (role-based, legacy)
router.get('/', auth, async (req, res) => {
  try {
    const { role } = req.user;
    let q = supabase.from('internal_messages').select('*').order('created_at', { ascending: true }).limit(500);

    if (ADMIN_ROLES.includes(role)) {
      // Admin/CEO: see all messages
    } else {
      q = q.or(`to_role.eq.${role},from_role.eq.${role}`);
    }

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/messages — send a message (supports DM via to_user_id or role-based via to_role)
router.post('/', auth, async (req, res) => {
  try {
    const { name, role } = req.user;
    const { to_user_id, to_role, to_user, message, thread_id } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'message is required' });

    let resolvedToUser = to_user || null;
    let resolvedToRole = to_role || null;

    // DM: resolve recipient name and role from their user ID
    if (to_user_id) {
      const { data: target } = await supabase.from('users').select('name,role').eq('id', to_user_id).single();
      if (target) { resolvedToUser = target.name; resolvedToRole = target.role; }
    }

    if (!resolvedToRole) return res.status(400).json({ error: 'to_role or to_user_id is required' });

    const { data, error } = await supabase
      .from('internal_messages')
      .insert({
        thread_id: thread_id || crypto.randomUUID(),
        from_user: name || role,
        from_role: role,
        to_user:   resolvedToUser,
        to_role:   resolvedToRole,
        message:   message.trim(),
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/messages/:id/read — mark a single message as read
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
