/**
 * kuralCard.js
 * Generates a beautiful PNG image card for Thirukkural WhatsApp broadcast.
 * Uses Puppeteer (bundled Chrome) + Noto Serif Tamil (system font via file://).
 *
 * Output: /tmp/thirukural_YYYY-MM-DD.png  (2x retina, 800×560px)
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');

// Logo embedded as base64 (loaded once at startup)
const LOGO_B64 = fs.readFileSync(
  '/home/ubuntu/sathvam-frontend/sathvam-vercel/public/icon-192.png'
).toString('base64');

const TAMIL_FONT_PATH = '/usr/share/fonts/truetype/noto/NotoSerifTamil-Regular.ttf';

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
  const tamilHtml = kural.tamil
    .split('\n')
    .map(l => escapeHtml(l.trim()))
    .join('<br>');

  // Use file:// for font — reliable when page itself is opened via file://
  return `<!DOCTYPE html>
<html lang="ta">
<head>
  <meta charset="UTF-8">
  <style>
    @font-face {
      font-family: 'NotoSerifTamil';
      src: url('file://${TAMIL_FONT_PATH}') format('truetype');
      font-display: block;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      width: 800px;
      height: 560px;
      overflow: hidden;
      background: linear-gradient(135deg, #082b1e 0%, #064e3b 50%, #065f46 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
    }

    /* decorative blobs */
    .blob1 { position:absolute; width:400px; height:400px; border-radius:50%; background:rgba(255,255,255,0.03); top:-160px; left:-120px; pointer-events:none; }
    .blob2 { position:absolute; width:500px; height:500px; border-radius:50%; background:rgba(255,255,255,0.02); bottom:-200px; right:-150px; pointer-events:none; }

    /* shimmer lines */
    .shimmer-top { position:absolute; top:0; left:0; right:0; height:3px; background:linear-gradient(90deg,transparent,rgba(255,255,255,0.35),transparent); }
    .shimmer-bot { position:absolute; bottom:0; left:0; right:0; height:3px; background:linear-gradient(90deg,transparent,rgba(255,255,255,0.25),transparent); }

    .card {
      position: relative;
      z-index: 10;
      text-align: center;
      padding: 36px 64px;
      width: 100%;
    }

    /* logo */
    .logo {
      width: 52px;
      height: 52px;
      border-radius: 50%;
      margin: 0 auto 16px;
      display: block;
      border: 2px solid rgba(255,255,255,0.25);
    }

    /* kural number badge */
    .badge {
      display: inline-block;
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.2);
      color: rgba(255,255,255,0.85);
      border-radius: 24px;
      padding: 7px 22px;
      font-family: sans-serif;
      font-size: 13px;
      letter-spacing: 2px;
      margin-bottom: 28px;
    }

    /* Tamil text */
    .tamil {
      font-family: 'NotoSerifTamil', serif;
      font-size: 26px;
      color: #ffffff;
      line-height: 1.9;
      margin-bottom: 24px;
    }

    /* divider */
    .divider {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      margin-bottom: 24px;
    }
    .divider-line { height: 1px; width: 120px; background: rgba(255,255,255,0.22); }
    .divider-dot  { width: 6px; height: 6px; border-radius: 50%; background: rgba(255,255,255,0.4); }

    /* English translation */
    .english {
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 17px;
      color: rgba(255,255,255,0.85);
      font-style: italic;
      line-height: 1.75;
      max-width: 600px;
      margin: 0 auto 30px;
    }

    /* branding */
    .brand-sep { height:1px; background:rgba(255,255,255,0.1); width:60%; margin:0 auto 16px; }
    .brand {
      font-family: sans-serif;
      color: rgba(255,255,255,0.55);
      font-size: 11px;
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
    <img class="logo" src="data:image/png;base64,${LOGO_B64}" alt="Sathvam Logo">
    <div class="badge">🌅 &nbsp; திருக்குறள் #${kural.num} &nbsp; 🌅</div>
    <div class="tamil">${tamilHtml}</div>
    <div class="divider">
      <div class="divider-line"></div>
      <div class="divider-dot"></div>
      <div class="divider-line"></div>
    </div>
    <div class="english">&ldquo;${escapeHtml(kural.english)}&rdquo;</div>
    <div class="brand-sep"></div>
    <div class="brand">Sathvam Natural Products &nbsp;·&nbsp; sathvam.in</div>
  </div>
</body>
</html>`;
}

/**
 * Generate PNG card for a kural.
 * Writes HTML to /tmp, opens via file:// so fonts load via file:// URL.
 * Waits for document.fonts.ready before screenshot.
 *
 * @param {object} kural  - { num, tamil, english }
 * @param {boolean} force - Force re-generation even if cached
 * @returns {string} Absolute path to the generated PNG
 */
async function generateKuralCard(kural, force = false) {
  const today   = new Date().toISOString().slice(0, 10);
  const outPath = cardPath(today);

  if (!force && fs.existsSync(outPath)) return outPath;

  // Write HTML to a temp file — file:// page can load file:// fonts
  const htmlPath = `/tmp/thirukural_card_${today}.html`;
  fs.writeFileSync(htmlPath, buildHTML(kural), 'utf8');

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--allow-file-access-from-files',   // allows file:// font URLs inside file:// page
      '--font-render-hinting=none',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 560, deviceScaleFactor: 2 });

    // Open via file:// so @font-face file:// src is allowed
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });

    // Wait for all fonts (including NotoSerifTamil) to fully load
    await page.evaluateHandle('document.fonts.ready');

    // Extra render settle time for complex Tamil shaping
    await new Promise(r => setTimeout(r, 600));

    await page.screenshot({
      path: outPath,
      type: 'png',
      clip: { x: 0, y: 0, width: 800, height: 560 },
    });

    return outPath;
  } finally {
    await browser.close();
    // Clean up temp HTML
    try { fs.unlinkSync(htmlPath); } catch (_) {}
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
