const express = require('express');
const router  = express.Router();
const gtts    = require('node-gtts');
const { auth } = require('../middleware/auth');

// POST /api/tts  { text, lang }  → MP3 audio stream
router.post('/', auth, (req, res) => {
  const { text, lang = 'en' } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });

  const allowedLangs = ['en', 'ta'];
  const safeLang = allowedLangs.includes(lang) ? lang : 'en';

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-cache');

  try {
    gtts(safeLang, true).stream(text.trim()).pipe(res); // slow=true for more natural pacing
  } catch (e) {
    console.error('TTS error:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'TTS failed' });
  }
});

module.exports = router;
