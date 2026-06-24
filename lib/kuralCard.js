/**
 * kuralCard.js
 * Generates a beautiful PNG image card for Thirukkural WhatsApp broadcast.
 * Uses Puppeteer (system Chromium in Docker) + Noto Serif Tamil font (bundled).
 *
 * Output: /tmp/thirukural_YYYY-MM-DD.png  (2x retina, 800×560px)
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

// Bundle font and logo from assets/ — works both on host and inside Docker
const ASSETS    = path.join(__dirname, '..', 'assets');
const FONT_B64  = fs.readFileSync(path.join(ASSETS, 'fonts', 'NotoSerifTamil-Regular.ttf')).toString('base64');
const LOGO_B64  = fs.readFileSync(path.join(ASSETS, 'icon-192.png')).toString('base64');

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

  return `<!DOCTYPE html>
<html lang="ta">
<head>
  <meta charset="UTF-8">
  <style>
    @font-face {
      font-family: 'NotoSerifTamil';
      src: url('data:font/ttf;base64,${FONT_B64}') format('truetype');
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

    .blob1 { position:absolute; width:400px; height:400px; border-radius:50%; background:rgba(255,255,255,0.03); top:-160px; left:-120px; }
    .blob2 { position:absolute; width:500px; height:500px; border-radius:50%; background:rgba(255,255,255,0.02); bottom:-200px; right:-150px; }
    .shimmer-top { position:absolute; top:0; left:0; right:0; height:3px; background:linear-gradient(90deg,transparent,rgba(255,255,255,0.35),transparent); }
    .shimmer-bot { position:absolute; bottom:0; left:0; right:0; height:3px; background:linear-gradient(90deg,transparent,rgba(255,255,255,0.25),transparent); }

    .card {
      position: relative;
      z-index: 10;
      text-align: center;
      padding: 36px 64px;
      width: 100%;
    }

    .logo {
      width: 54px;
      height: 54px;
      border-radius: 50%;
      margin: 0 auto 14px;
      display: block;
      border: 2px solid rgba(255,255,255,0.3);
    }

    .badge {
      display: inline-block;
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.22);
      color: rgba(255,255,255,0.88);
      border-radius: 24px;
      padding: 7px 22px;
      font-family: sans-serif;
      font-size: 13px;
      letter-spacing: 2px;
      margin-bottom: 26px;
    }

    .tamil {
      font-family: 'NotoSerifTamil', serif;
      font-size: 26px;
      color: #ffffff;
      line-height: 1.9;
      margin-bottom: 22px;
    }

    .divider {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      margin-bottom: 22px;
    }
    .divider-line { height: 1px; width: 120px; background: rgba(255,255,255,0.22); }
    .divider-dot  { width: 6px; height: 6px; border-radius: 50%; background: rgba(255,255,255,0.4); }

    .english {
      font-family: Georgia, 'Times New Roman', serif;
      font-size: 17px;
      color: rgba(255,255,255,0.85);
      font-style: italic;
      line-height: 1.75;
      max-width: 600px;
      margin: 0 auto 28px;
    }

    .brand-sep { height:1px; background:rgba(255,255,255,0.1); width:60%; margin:0 auto 14px; }
    .brand {
      font-family: sans-serif;
      color: rgba(255,255,255,0.5);
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
    <img class="logo" src="data:image/png;base64,${LOGO_B64}" alt="">
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

async function generateKuralCard(kural, force = false) {
  const today   = new Date().toISOString().slice(0, 10);
  const outPath = cardPath(today);

  if (!force && fs.existsSync(outPath)) return outPath;

  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH; // set to system chromium in Docker
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: execPath || undefined, // undefined = use bundled chromium on host
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--font-render-hinting=none',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 560, deviceScaleFactor: 2 });
    await page.setContent(buildHTML(kural), { waitUntil: 'networkidle0' });

    // Wait for all fonts (especially NotoSerifTamil) to finish loading
    await page.evaluateHandle('document.fonts.ready');

    // Allow extra time for complex Tamil glyph shaping to complete
    await new Promise(r => setTimeout(r, 800));

    await page.screenshot({
      path: outPath,
      type: 'png',
      clip: { x: 0, y: 0, width: 800, height: 560 },
    });

    return outPath;
  } finally {
    await browser.close();
  }
}

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
