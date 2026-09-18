/**
 * Blog routes — admin-only CRUD for SEO blog posts
 * POST   /api/blog          — create post (used by AI agent)
 * GET    /api/blog          — list all posts (admin)
 * PUT    /api/blog/:id      — update post
 * DELETE /api/blog/:id      — delete post
 */
const express  = require('express');
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');
const router   = express.Router();

// Helper: generate slug from title
function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

// POST /api/blog — create
router.post('/', auth, async (req, res) => {
  const { title, slug, excerpt, content, keywords, category, author, read_time, published, cover_image } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'title and content are required' });
  const finalSlug = slug || slugify(title);
  try {
    const { data, error } = await supabase.from('blog_posts').insert({
      title,
      slug: finalSlug,
      excerpt: excerpt || content.slice(0, 160).replace(/[#*>\n]/g, ' ').trim(),
      content,
      keywords: keywords || [],
      category: category || 'health',
      author:   author   || 'Sathvam Team',
      read_time: read_time || Math.max(1, Math.ceil(content.split(' ').length / 200)),
      cover_image: cover_image || null,
      published: published !== false,
      published_at: new Date().toISOString(),
    }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/blog — list all (admin)
router.get('/', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('blog_posts')
      .select('id,title,slug,category,author,published,published_at,read_time,created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/blog/:id — update
router.put('/:id', auth, async (req, res) => {
  const updates = { ...req.body, updated_at: new Date().toISOString() };
  delete updates.id;
  try {
    const { data, error } = await supabase.from('blog_posts').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/blog/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const { error } = await supabase.from('blog_posts').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Blog WhatsApp Share Report ──

// GET /api/blog/wa-report — summary of all blog WA campaigns
router.get('/wa-report', auth, async (req, res) => {
  try {
    // Get per-blog aggregated stats
    const { data: sends, error } = await supabase
      .from('blog_wa_sends')
      .select('blog_id, blog_title, blog_lang, status, sent_at');

    if (error) throw error;

    // Aggregate by blog
    const blogMap = {};
    for (const s of (sends || [])) {
      if (!blogMap[s.blog_id]) {
        blogMap[s.blog_id] = {
          blog_id: s.blog_id,
          blog_title: s.blog_title,
          blog_lang: s.blog_lang,
          sent: 0,
          failed: 0,
          last_sent: null,
        };
      }
      const b = blogMap[s.blog_id];
      if (s.status === 'sent') b.sent++;
      else b.failed++;
      if (!b.last_sent || s.sent_at > b.last_sent) b.last_sent = s.sent_at;
    }

    const blogs = Object.values(blogMap).sort((a, b) =>
      (b.last_sent || '').localeCompare(a.last_sent || '')
    );

    // Get run history
    const { data: runRow } = await supabase.from('settings').select('value').eq('key', 'blog_wa_runs').single();
    const runs = runRow?.value || [];

    // Get approval statuses
    const { data: approvalRow } = await supabase.from('settings').select('value').eq('key', 'blog_wa_approvals').single();
    const approvals = approvalRow?.value || {};

    // Total unique customers reached
    const uniquePhones = new Set((sends || []).filter(s => s.status === 'sent').map(s => s.customer_phone));

    res.json({
      blogs,
      runs: runs.slice(0, 10),
      approvals,
      totals: {
        blogs_shared: blogs.length,
        total_sent: (sends || []).filter(s => s.status === 'sent').length,
        total_failed: (sends || []).filter(s => s.status === 'failed').length,
        unique_customers: uniquePhones.size,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/blog/wa-report/:blogId — per-blog customer-level detail
router.get('/wa-report/:blogId', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('blog_wa_sends')
      .select('id, customer_name, customer_phone, status, error_msg, sent_at, run_id')
      .eq('blog_id', req.params.blogId)
      .order('sent_at', { ascending: false });

    if (error) throw error;

    // Mask phone for display (91XXXXXXXX12 → 91XXXX**XX12)
    const masked = (data || []).map(r => ({
      ...r,
      customer_phone_masked: r.customer_phone
        ? r.customer_phone.slice(0, 4) + '****' + r.customer_phone.slice(-4)
        : '',
    }));

    res.json(masked);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/blog/wa-approve/:blogId — admin approves a blog for WA sharing
router.post('/wa-approve/:blogId', auth, async (req, res) => {
  try {
    const { data: row } = await supabase.from('settings').select('value').eq('key', 'blog_wa_approvals').single();
    const approvals = row?.value || {};
    approvals[req.params.blogId] = 'approved';
    await supabase.from('settings').upsert({ key: 'blog_wa_approvals', value: approvals, updated_at: new Date().toISOString() });
    res.json({ success: true, message: 'Blog approved for WhatsApp sharing' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/blog/wa-trigger/all — manually trigger blog share (all new blogs)
router.post('/wa-trigger/all', auth, async (req, res) => {
  try {
    const { exec } = require('child_process');
    const scriptPath = require('path').resolve(__dirname, '../scripts/blog-wa-share.js');
    exec(`node ${scriptPath}`, { env: process.env }, (err, stdout, stderr) => {
      if (err) console.error('[blog-wa-trigger] Script error:', stderr);
      else console.log('[blog-wa-trigger]', stdout);
    });
    res.json({ success: true, message: 'Blog WA share triggered for all new blogs' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
