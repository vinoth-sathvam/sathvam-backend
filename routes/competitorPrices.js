const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-IN,en-GB;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Cache-Control': 'no-cache',
};

// Extract first Indian rupee price from a string or HTML
function extractPrice(text) {
  if (!text) return null;
  // Match ₹ or Rs or MRP followed by number
  const m = String(text).match(/(?:₹|Rs\.?|MRP:?\s*₹?)\s*(\d[\d,]*(?:\.\d{1,2})?)/i);
  if (m) return parseFloat(m[1].replace(/,/g, ''));
  // plain number-only fallback (e.g. in JSON fields)
  const n = String(text).match(/^(\d[\d,]*(?:\.\d{1,2})?)$/);
  if (n) return parseFloat(n[1].replace(/,/g, ''));
  return null;
}

// ── BigBasket ──────────────────────────────────────────────────────────────────
async function fetchBigBasket(productName) {
  try {
    const q = encodeURIComponent(productName);
    const url = `https://www.bigbasket.com/ps/?q=${q}&nc=as`;
    const res = await axios.get(url, { headers: HEADERS, timeout: 12000 });
    const html = res.data;

    // BigBasket embeds product data in __NEXT_DATA__
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (match) {
      const json = JSON.parse(match[1]);
      // Navigate to product list
      const tabs = json?.props?.pageProps?.listingData?.tabs;
      if (tabs) {
        for (const tab of tabs) {
          const prods = tab?.tabInfo?.productList?.list;
          if (prods && prods.length) {
            const first = prods[0];
            const sp = first?.absoluteUrl ? null : (first?.mrp || first?.sp || first?.price);
            if (sp) return parseFloat(sp);
          }
        }
      }
      // Try alternate path
      const products = json?.props?.pageProps?.products;
      if (products && products.length) {
        const p = products[0];
        const price = p?.sp || p?.mrp || p?.price;
        if (price) return parseFloat(price);
      }
    }

    // Fallback: parse HTML for price tags
    const $ = cheerio.load(html);
    const priceText = $('[class*="Price"], [class*="price"], [data-qa="product-price"]').first().text();
    return extractPrice(priceText);
  } catch (e) {
    return null;
  }
}

// ── Amazon India ──────────────────────────────────────────────────────────────
async function fetchAmazon(productName) {
  try {
    const q = encodeURIComponent(productName + ' cold pressed');
    const url = `https://www.amazon.in/s?k=${q}&rh=n%3A1351616031`;
    const res = await axios.get(url, {
      headers: {
        ...HEADERS,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 12000,
    });
    const $ = cheerio.load(res.data);
    // First price in search results
    const priceEl = $('[data-component-type="s-search-result"]').first()
      .find('.a-price .a-offscreen').first().text();
    return extractPrice(priceEl);
  } catch (e) {
    return null;
  }
}

// ── JioMart ───────────────────────────────────────────────────────────────────
async function fetchJioMart(productName) {
  try {
    const q = encodeURIComponent(productName);
    const url = `https://www.jiomart.com/search#q=${q}&t=text`;
    const res = await axios.get(url, { headers: HEADERS, timeout: 12000 });
    const $ = cheerio.load(res.data);
    const priceEl = $('[class*="final-price"], [class*="product-price"], .jm-header-font').first().text();
    if (priceEl) return extractPrice(priceEl);

    // Try JSON-LD
    const scriptContent = $('script[type="application/ld+json"]').first().html();
    if (scriptContent) {
      const json = JSON.parse(scriptContent);
      if (json?.offers?.price) return parseFloat(json.offers.price);
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ── Flipkart ──────────────────────────────────────────────────────────────────
async function fetchFlipkart(productName) {
  try {
    const q = encodeURIComponent(productName);
    const url = `https://www.flipkart.com/search?q=${q}&otracker=search`;
    const res = await axios.get(url, {
      headers: {
        ...HEADERS,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 12000,
    });
    const $ = cheerio.load(res.data);
    // Flipkart price classes vary — try common ones
    const priceEl = $('[class*="_30jeq3"], [class*="Nx9bqj"]').first().text();
    return extractPrice(priceEl);
  } catch (e) {
    return null;
  }
}

// ── DMart ─────────────────────────────────────────────────────────────────────
async function fetchDMart(productName) {
  try {
    const q = encodeURIComponent(productName);
    const url = `https://www.dmart.in/search?q=${q}`;
    const res = await axios.get(url, { headers: HEADERS, timeout: 12000 });
    const $ = cheerio.load(res.data);
    const priceEl = $('[class*="price"], [class*="Price"]').first().text();
    return extractPrice(priceEl);
  } catch (e) {
    return null;
  }
}

const SCRAPERS = {
  'amazon':    fetchAmazon,
  'bigbasket': fetchBigBasket,
  'jiomart':   fetchJioMart,
  'flipkart':  fetchFlipkart,
  'dmart':     fetchDMart,
};

function matchScraper(name) {
  const key = name.toLowerCase().replace(/\s+/g, '');
  for (const [k, fn] of Object.entries(SCRAPERS)) {
    if (key.includes(k)) return fn;
  }
  return null;
}

// POST /api/competitor-prices/fetch
// Body: { productName: string, competitors: string[] }
router.post('/fetch', auth, requireRole('admin', 'manager'), async (req, res) => {
  const { productName, competitors = [] } = req.body;
  if (!productName || !competitors.length) {
    return res.status(400).json({ error: 'productName and competitors required' });
  }

  const results = {};
  // Fetch in parallel with a per-site timeout
  await Promise.all(competitors.map(async (comp) => {
    const scraper = matchScraper(comp);
    if (!scraper) { results[comp] = null; return; }
    try {
      results[comp] = await scraper(productName);
    } catch {
      results[comp] = null;
    }
  }));

  res.json(results);
});

module.exports = router;
