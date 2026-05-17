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

// POST /api/messages/typing — broadcast typing indicator (ephemeral, 5 s TTL)
router.post('/typing', auth, async (req, res) => {
  try {
    const myName = req.user.name || req.user.username;
    const { toUserId } = req.body;
    if (!toUserId) return res.status(400).json({ error: 'toUserId required' });
    const key = `chat_typing_${toUserId}`;
    const { data: row } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
    const list = Array.isArray(row?.value)
      ? row.value.filter(e => e.name !== myName && Date.now() - e.ts < 6000)
      : [];
    list.push({ name: myName, ts: Date.now() });
    await supabase.from('settings').upsert({ key, value: list, updated_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/messages/typing/:userId — check if a user is typing to me
router.get('/typing/:userId', auth, async (req, res) => {
  try {
    const key = `chat_typing_${req.user.id}`;
    const { data: row } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
    const { data: other } = await supabase.from('users').select('name').eq('id', req.params.userId).single();
    if (!other) return res.json({ typing: false });
    const now = Date.now();
    const typing = (Array.isArray(row?.value) ? row.value : [])
      .some(e => e.name === other.name && now - e.ts < 6000);
    res.json({ typing });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/messages — send a message (supports DM via to_user_id or role-based via to_role)
router.post('/', auth, async (req, res) => {
  try {
    const { name, role } = req.user;
    const { to_user_id, to_role, to_user, message, thread_id, reply_to_id } = req.body;
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
        thread_id:   thread_id || crypto.randomUUID(),
        from_user:   name || role,
        from_role:   role,
        to_user:     resolvedToUser,
        to_role:     resolvedToRole,
        message:     message.trim(),
        reply_to_id: reply_to_id || null,
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/messages/:id — delete a single message (sender or admin only)
router.delete('/:id', auth, async (req, res) => {
  try {
    const myName = req.user.name || req.user.username;
    const isAdmin = ADMIN_ROLES.includes(req.user.role);
    // Fetch message first to check ownership
    const { data: msg, error: fe } = await supabase
      .from('internal_messages').select('id,from_user').eq('id', req.params.id).single();
    if (fe || !msg) return res.status(404).json({ error: 'Message not found' });
    if (!isAdmin && msg.from_user !== myName)
      return res.status(403).json({ error: 'Can only delete your own messages' });
    const { error } = await supabase.from('internal_messages').delete().eq('id', req.params.id);
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/messages/dm/:otherUserId/clear — delete all messages in a DM conversation
router.delete('/dm/:otherUserId/clear', auth, async (req, res) => {
  try {
    const myName = req.user.name || req.user.username;
    const { data: other } = await supabase
      .from('users').select('name').eq('id', req.params.otherUserId).single();
    if (!other) return res.status(404).json({ error: 'User not found' });
    // Fetch IDs of messages in this conversation
    const { data: msgs } = await supabase
      .from('internal_messages').select('id,from_user,to_user').limit(500);
    const ids = (msgs || [])
      .filter(m =>
        (m.from_user === myName && m.to_user === other.name) ||
        (m.from_user === other.name && m.to_user === myName)
      ).map(m => m.id);
    if (ids.length > 0) {
      await supabase.from('internal_messages').delete().in('id', ids);
    }
    res.json({ ok: true, deleted: ids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/messages/:id — edit message text (sender only, within 5 min)
router.patch('/:id', auth, async (req, res) => {
  try {
    const myName = req.user.name || req.user.username;
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'message required' });
    const { data: msg } = await supabase.from('internal_messages')
      .select('id,from_user,created_at').eq('id', req.params.id).single();
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.from_user !== myName) return res.status(403).json({ error: 'Can only edit your own messages' });
    if (Date.now() - new Date(msg.created_at).getTime() > 5 * 60 * 1000)
      return res.status(400).json({ error: 'Can only edit within 5 minutes of sending' });
    const { data, error } = await supabase.from('internal_messages')
      .update({ message: message.trim(), edited_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/messages/:id/react — toggle emoji reaction
router.post('/:id/react', auth, async (req, res) => {
  try {
    const myName = req.user.name || req.user.username;
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ error: 'emoji required' });
    const { data: msg } = await supabase.from('internal_messages')
      .select('id,reactions').eq('id', req.params.id).single();
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    const reactions = { ...(msg.reactions || {}) };
    if (!reactions[emoji]) reactions[emoji] = [];
    const idx = reactions[emoji].indexOf(myName);
    if (idx > -1) reactions[emoji].splice(idx, 1);
    else reactions[emoji].push(myName);
    if (reactions[emoji].length === 0) delete reactions[emoji];
    const { data, error } = await supabase.from('internal_messages')
      .update({ reactions }).eq('id', req.params.id).select().single();
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
