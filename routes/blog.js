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

module.exports = router;
