const express = require('express');
const multer  = require('multer');
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5 MB max

const BUCKET = 'product-images';

// Ensure the bucket exists (idempotent)
async function ensureBucket() {
  const { data: buckets } = await supabase.storage.listBuckets();
  if (!buckets?.find(b => b.name === BUCKET)) {
    await supabase.storage.createBucket(BUCKET, { public: true, allowedMimeTypes: ['image/*'], fileSizeLimit: 5242880 });
  }
}

// POST /api/upload/product-image
// Auth required. Accepts multipart: field "image" (file)
// Returns { url: "https://..." }
router.post('/product-image', auth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });

    await ensureBucket();

    const ext  = req.file.originalname.split('.').pop().toLowerCase() || 'jpg';
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(name, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

    if (error) return res.status(500).json({ error: error.message });

    const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(name);
    res.json({ url: publicUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
