/**
 * kuralCard.js
 * Generates a beautiful PNG image card for Thirukkural WhatsApp broadcast.
 * Uses Puppeteer (bundled Chrome) + Noto Serif Tamil (system font).
 *
 * Output: /tmp/thirukural_YYYY-MM-DD.png  (2x retina, 800×580px)
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

// Embed Tamil font as base64 so puppeteer doesn't need file:// access
const TAMIL_FONT_B64 = fs.readFileSync(
  '/usr/share/fonts/truetype/noto/NotoSerifTamil-Regular.ttf'
).toString('base64');

function cardPath(date) {
  return `/tmp/thirukural_${date}.png`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildHTML(kural) {
  // Tamil text may have \n separating the two lines
  const tamilHtml = kural.tamil
    .split('\n')
    .map(l => escapeHtml(l.trim()))
    .join('<br>');

  return `<!DOCTYPE html>
<html lang="ta">
<head>
  <meta charset="UTF-8">
  <style>
    @font-face {
      font-family: 'NotoSerifTamil';
      src: url('data:font/truetype;base64,${TAMIL_FONT_B64}') format('truetype');
    }
    * { margin:0; padding:0; box-sizing:border-box; }

    body {
      width: 800px;
      height: 580px;
      overflow: hidden;
      font-family: Georgia, serif;
      background: linear-gradient(135deg, #082b1e 0%, #064e3b 45%, #065f46 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
    }

    /* decorative blobs */
    .blob1 { position:absolute; width:400px; height:400px; border-radius:50%;
      background:rgba(255,255,255,0.025); top:-160px; left:-120px; }
    .blob2 { position:absolute; width:500px; height:500px; border-radius:50%;
      background:rgba(255,255,255,0.02); bottom:-200px; right:-150px; }

    /* top/bottom shimmer lines */
    .shimmer-top { position:absolute; top:0; left:0; right:0; height:3px;
      background:linear-gradient(90deg,transparent,rgba(255,255,255,0.3),transparent); }
    .shimmer-bot { position:absolute; bottom:0; left:0; right:0; height:3px;
      background:linear-gradient(90deg,transparent,rgba(255,255,255,0.25),transparent); }

    .card {
      position: relative;
      z-index: 10;
      text-align: center;
      padding: 44px 72px;
      width: 100%;
    }

    /* kural number badge */
    .badge {
      display: inline-block;
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.22);
      color: rgba(255,255,255,0.82);
      border-radius: 24px;
      padding: 8px 24px;
      font-family: 'Noto Sans', sans-serif;
      font-size: 13px;
      letter-spacing: 2px;
      margin-bottom: 36px;
    }

    /* Tamil lines */
    .tamil {
      font-family: 'NotoSerifTamil', 'Noto Serif Tamil', 'Noto Sans Tamil', serif;
      font-size: 27px;
      color: #ffffff;
      line-height: 1.85;
      margin-bottom: 30px;
      text-shadow: 0 2px 12px rgba(0,0,0,0.3);
    }

    /* decorative divider */
    .divider {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
      margin-bottom: 30px;
    }
    .divider-line { height: 1px; width: 130px; background: rgba(255,255,255,0.22); }
    .divider-dot  { width: 7px; height: 7px; border-radius: 50%; background: rgba(255,255,255,0.38); }

    /* English translation */
    .english {
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 17.5px;
      color: rgba(255,255,255,0.83);
      font-style: italic;
      line-height: 1.78;
      max-width: 610px;
      margin: 0 auto 38px;
    }

    /* branding */
    .brand-sep { height:1px; background:rgba(255,255,255,0.11); width:65%; margin:0 auto 18px; }
    .brand {
      font-family: 'Noto Sans', sans-serif;
      color: rgba(255,255,255,0.50);
      font-size: 12px;
      letter-spacing: 4px;
      text-transform: uppercase;
    }
  </style>
</head>
<body>
  <div class="blob1"></div>
  <div class="blob2"></div>
  <div class="shimmer-top"></div>
  <div class="shimmer-bot"></div>

  <div class="card">
    <div class="badge">🌅 &nbsp; திருக்குறள் #${kural.num} &nbsp; 🌅</div>
    <div class="tamil">${tamilHtml}</div>
    <div class="divider">
      <div class="divider-line"></div>
      <div class="divider-dot"></div>
      <div class="divider-line"></div>
    </div>
    <div class="english">&ldquo;${escapeHtml(kural.english)}&rdquo;</div>
    <div class="brand-sep"></div>
    <div class="brand">🌿 &nbsp; Sathvam Natural Products &nbsp; 🌿</div>
  </div>
</body>
</html>`;
}

/**
 * Generate PNG card for a kural.
 * Caches one file per day in /tmp/. Re-generates if called with the same date.
 *
 * @param {object} kural  - { num, tamil, english }
 * @param {boolean} force - Force re-generation even if cached
 * @returns {string} Absolute path to the generated PNG
 */
async function generateKuralCard(kural, force = false) {
  const today  = new Date().toISOString().slice(0, 10);
  const outPath = cardPath(today);

  if (!force && fs.existsSync(outPath)) return outPath;

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--font-render-hinting=none',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 580, deviceScaleFactor: 2 });
    await page.setContent(buildHTML(kural), { waitUntil: 'networkidle0' });
    await page.screenshot({
      path: outPath,
      type: 'png',
      clip: { x: 0, y: 0, width: 800, height: 580 },
    });
    return outPath;
  } finally {
    await browser.close();
  }
}

/** Compact WA caption that accompanies the image (Tamil text + minimal branding) */
function kuralCaption(kural) {
  return (
    `🌅 *காலை வணக்கம்! Good Morning!* ☀️\n\n` +
    `📖 *திருக்குறள் #${kural.num}*\n\n` +
    `_${kural.tamil}_\n\n` +
    `🌿 *Sathvam Natural Products*\n` +
    `_sathvam.in_`
  );
}

module.exports = { generateKuralCard, kuralCaption, cardPath };
