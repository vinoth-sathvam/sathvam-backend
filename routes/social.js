const express  = require('express');
const router   = express.Router();
const supabase = require('../config/supabase');

// ── Auth middleware (reuse JWT from core) ─────────────────────────────────────
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;
const auth = (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Session expired' }); }
};

// ── AI Caption generator ──────────────────────────────────────────────────────
async function generateCaption(product) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const prompt = `Create an engaging social media post caption for this product from Sathvam Natural Products.

Product: ${product.name}
Price: ₹${product.website_price || product.price}
Category: ${product.cat}
Pack size: ${product.pack_size || ''}${product.pack_unit || product.unit || ''}
GST: ${product.gst || 0}%

Write a captivating caption (3-5 lines) that:
- Highlights the natural/chemical-free benefits
- Mentions the factory-direct price advantage
- Includes 5-8 relevant hashtags at the end
- Mix of English and Tamil (1 Tamil line is fine)
- Has a call to action (order on www.sathvam.in)
- Warm and authentic tone, not corporate
- No asterisks or markdown, plain text only`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await res.json();
    return data.content?.[0]?.text || null;
  } catch { return null; }
}

// ── GET /api/social/posts ─────────────────────────────────────────────────────
router.get('/posts', auth, async (req, res) => {
  const { data, error } = await supabase.from('social_posts')
    .select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── POST /api/social/posts/generate ──────────────────────────────────────────
router.post('/posts/generate', auth, async (req, res) => {
  const { product_id } = req.body;
  if (!product_id) return res.status(400).json({ error: 'product_id required' });
  const { data: product } = await supabase.from('products').select('*').eq('id', product_id).single();
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const caption = await generateCaption(product);
  if (!caption) return res.status(503).json({ error: 'Caption generation failed' });

  // Get product image if available
  const { data: imgs } = await supabase.from('product_images')
    .select('url').eq('product_id', product_id).order('position').limit(1);
  const image_url = imgs?.[0]?.url || null;

  const { data: post, error } = await supabase.from('social_posts').insert({
    product_id,
    product_name: product.name,
    caption,
    image_url,
    status: 'draft',
    platform: 'both',
    created_by: req.user.name || req.user.email,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(post);
});

// ── PUT /api/social/posts/:id ─────────────────────────────────────────────────
router.put('/posts/:id', auth, async (req, res) => {
  const { caption, status, platform, scheduled_for, image_url } = req.body;
  const updates = {};
  if (caption !== undefined) updates.caption = caption;
  if (status  !== undefined) updates.status  = status;
  if (platform !== undefined) updates.platform = platform;
  if (scheduled_for !== undefined) updates.scheduled_for = scheduled_for || null;
  if (image_url !== undefined) updates.image_url = image_url;
  const { data, error } = await supabase.from('social_posts')
    .update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── DELETE /api/social/posts/:id ──────────────────────────────────────────────
router.delete('/posts/:id', auth, async (req, res) => {
  await supabase.from('social_posts').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ── POST /api/social/posts/:id/publish ───────────────────────────────────────
router.post('/posts/:id/publish', auth, async (req, res) => {
  const { data: post } = await supabase.from('social_posts').select('*').eq('id', req.params.id).single();
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.status !== 'approved') return res.status(400).json({ error: 'Post must be approved before publishing' });

  const FB_PAGE_TOKEN   = process.env.FB_PAGE_ACCESS_TOKEN;
  const FB_PAGE_ID      = process.env.FB_PAGE_ID;
  const IG_ACCOUNT_ID   = process.env.IG_ACCOUNT_ID;

  const results = { facebook: null, instagram: null, errors: [] };

  // ── Facebook ──
  if ((post.platform === 'facebook' || post.platform === 'both') && FB_PAGE_TOKEN && FB_PAGE_ID) {
    try {
      const fbBody = { message: post.caption, access_token: FB_PAGE_TOKEN };
      if (post.image_url) fbBody.link = post.image_url;
      const fbRes = await fetch(`https://graph.facebook.com/v19.0/${FB_PAGE_ID}/feed`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fbBody),
      });
      const fbData = await fbRes.json();
      if (fbData.id) { results.facebook = fbData.id; }
      else results.errors.push('Facebook: ' + (fbData.error?.message || 'unknown error'));
    } catch (e) { results.errors.push('Facebook: ' + e.message); }
  }

  // ── Instagram (requires image) ──
  if ((post.platform === 'instagram' || post.platform === 'both') && FB_PAGE_TOKEN && IG_ACCOUNT_ID && post.image_url) {
    try {
      // Step 1: create media container
      const createRes = await fetch(`https://graph.facebook.com/v19.0/${IG_ACCOUNT_ID}/media`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_url: post.image_url, caption: post.caption, access_token: FB_PAGE_TOKEN }),
      });
      const createData = await createRes.json();
      if (createData.id) {
        // Step 2: publish
        const pubRes = await fetch(`https://graph.facebook.com/v19.0/${IG_ACCOUNT_ID}/media_publish`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ creation_id: createData.id, access_token: FB_PAGE_TOKEN }),
        });
        const pubData = await pubRes.json();
        if (pubData.id) results.instagram = pubData.id;
        else results.errors.push('Instagram publish: ' + (pubData.error?.message || 'unknown'));
      } else results.errors.push('Instagram container: ' + (createData.error?.message || 'unknown'));
    } catch (e) { results.errors.push('Instagram: ' + e.message); }
  } else if ((post.platform === 'instagram' || post.platform === 'both') && !post.image_url) {
    results.errors.push('Instagram requires an image');
  }

  // Update post status
  const newStatus = (results.facebook || results.instagram) ? 'published' : post.status;
  const updates = { status: newStatus, published_at: newStatus === 'published' ? new Date().toISOString() : null };
  if (results.facebook)  updates.fb_post_id = results.facebook;
  if (results.instagram) updates.ig_post_id = results.instagram;
  await supabase.from('social_posts').update(updates).eq('id', req.params.id);

  if (!FB_PAGE_TOKEN) return res.status(503).json({ error: 'Meta API not configured yet. Add FB_PAGE_ACCESS_TOKEN, FB_PAGE_ID, IG_ACCOUNT_ID to .env' });
  res.json({ ...results, status: newStatus });
});

// ── POST /api/social/posts/:id/regenerate ────────────────────────────────────
router.post('/posts/:id/regenerate', auth, async (req, res) => {
  const { data: post } = await supabase.from('social_posts').select('*').eq('id', req.params.id).single();
  if (!post) return res.status(404).json({ error: 'Post not found' });
  const { data: product } = await supabase.from('products').select('*').eq('id', post.product_id).single();
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const caption = await generateCaption(product);
  if (!caption) return res.status(503).json({ error: 'Caption generation failed' });
  const { data, error } = await supabase.from('social_posts')
    .update({ caption, status: 'draft' }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
