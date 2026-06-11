const express = require('express');
const multer  = require('multer');
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10 MB max

const BUCKET = 'product-images';
const DOC_BUCKET = 'documents';

// Ensure the bucket exists (idempotent)
async function ensureBucket() {
  const { data: buckets } = await supabase.storage.listBuckets();
  if (!buckets?.find(b => b.name === BUCKET)) {
    await supabase.storage.createBucket(BUCKET, { public: true, allowedMimeTypes: ['image/*'], fileSizeLimit: 5242880 });
  }
  if (!buckets?.find(b => b.name === DOC_BUCKET)) {
    await supabase.storage.createBucket(DOC_BUCKET, { public: true, allowedMimeTypes: ['image/*', 'application/pdf'], fileSizeLimit: 10485760 });
  }
}

const SAFE_MIME = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

// POST /api/upload/product-image
// Auth required. Accepts multipart: field "image" (file)
// Returns { url: "https://..." }
router.post('/product-image', auth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });

    const ext = SAFE_MIME[req.file.mimetype];
    if (!ext) return res.status(400).json({ error: 'Invalid file type. Allowed: jpg, png, webp, gif' });

    await ensureBucket();

    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(name, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

    if (error) { console.error('Storage upload error:', error); return res.status(500).json({ error: 'Upload failed' }); }

    const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(name);
    res.json({ url: publicUrl });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// POST /api/upload/document
// Accepts image/* or application/pdf. Used for bill attachments.
const DOC_MIME = { 'image/jpeg':'jpg','image/jpg':'jpg','image/png':'png','image/webp':'webp','application/pdf':'pdf' };
router.post('/document', auth, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large. Maximum size is 10 MB.' });
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const ext = DOC_MIME[req.file.mimetype];
    if (!ext) return res.status(400).json({ error: 'Invalid file type. Allowed: jpg, png, webp, pdf' });
    await ensureBucket();
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const { error } = await supabase.storage.from(DOC_BUCKET).upload(name, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (error) { console.error('Doc upload error:', error); return res.status(500).json({ error: 'Upload failed' }); }
    const { data: { publicUrl } } = supabase.storage.from(DOC_BUCKET).getPublicUrl(name);
    res.json({ url: publicUrl });
  } catch(err) {
    console.error('Doc upload exception:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

module.exports = router;
