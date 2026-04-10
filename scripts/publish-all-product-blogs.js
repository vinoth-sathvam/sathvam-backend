#!/usr/bin/env node
/**
 * Sathvam — Publish Product Blog Articles for ALL Products
 * Run once: node /home/ubuntu/sathvam-backend/scripts/publish-all-product-blogs.js
 * Writes one SEO article per unique product, skips duplicates.
 */

require('dotenv').config({ path: '/home/ubuntu/sathvam-backend/.env' });
const supabase = require('../config/supabase');

const ALL_PRODUCT_ARTICLES = [
  // ── OILS ──────────────────────────────────────────────────────────────────
  { keyword:'cold pressed groundnut oil benefits India',        title:'Cold Pressed Groundnut Oil: Benefits, Uses & Why It Beats Refined Oil',        category:'oils'    },
  { keyword:'cold pressed coconut oil benefits cooking',        title:'Pure Cold Pressed Coconut Oil: 8 Benefits Every Indian Kitchen Needs',         category:'oils'    },
  { keyword:'wood pressed mustard oil benefits',                title:'Wood Pressed Mustard Oil: Traditional Benefits and How to Use It Right',       category:'oils'    },
  { keyword:'neem oil uses benefits organic farming',           title:'Neem Oil: Nature\'s Most Powerful Natural Oil for Farming and Skin',           category:'oils'    },
  { keyword:'castor oil benefits hair skin ayurveda',           title:'Castor Oil Benefits for Hair, Skin and Health — The Ayurvedic Powerhouse',    category:'oils'    },
  { keyword:'deepam oil sesame lamp oil benefits',              title:'Deepam Oil: Why Pure Sesame Lamp Oil is Better for Your Pooja and Home',      category:'oils'    },
  { keyword:'herbal hair oil benefits natural ingredients',     title:'Herbal Hair Oil: How Natural Ingredients Transform Your Hair Health',          category:'oils'    },
  { keyword:'walnut oil benefits cooking nutrition',            title:'Walnut Oil Benefits: The Premium Cold Pressed Oil for Brain and Heart Health', category:'oils'    },

  // ── MILLETS ───────────────────────────────────────────────────────────────
  { keyword:'pearl millet kambam benefits nutrition',           title:'Pearl Millet (Kambam): The High-Protein Ancient Grain India Forgot',          category:'millets' },
  { keyword:'finger millet ragi benefits calcium',              title:'Ragi (Finger Millet): The Calcium King That Beats Dairy for Bone Health',     category:'millets' },
  { keyword:'kodo millet benefits diabetic friendly grain',     title:'Kodo Millet: The Forgotten Diabetic-Friendly Grain Making a Comeback',        category:'millets' },
  { keyword:'little millet samai benefits weight loss',         title:'Little Millet (Samai): Why This Tiny Grain Is a Big Deal for Weight Loss',   category:'millets' },
  { keyword:'barnyard millet kuthiraivali benefits',            title:'Barnyard Millet: Fasting Food or Superfood? The Truth About Kuthiraivali',   category:'millets' },
  { keyword:'sorghum jowar millet benefits India',              title:'Sorghum (Jowar): The Drought-Resistant Grain That\'s Good for Your Gut',     category:'millets' },

  // ── FLOURS & FLAKES ───────────────────────────────────────────────────────
  { keyword:'sprouted ragi flour benefits baby food',           title:'Sprouted Ragi Flour: Supercharged Nutrition for Babies and Adults Alike',     category:'millets' },
  { keyword:'ragi flakes breakfast benefits',                   title:'Ragi Flakes: The Healthy Breakfast Your Family Should Start Every Morning',   category:'recipes' },
  { keyword:'sorghum flour benefits gluten free cooking',       title:'Sorghum Flour: The Gluten-Free Flour Perfect for Indian Cooking',            category:'health'  },
  { keyword:'besan flour benefits nutrition chickpea flour',    title:'Besan (Chickpea Flour): High-Protein Flour for Healthier Indian Cooking',    category:'health'  },
  { keyword:'wheat flour whole grain benefits India',           title:'Whole Wheat Flour vs Maida: Why Choosing Right Flour Changes Everything',    category:'health'  },

  // ── GHEE & DAIRY ──────────────────────────────────────────────────────────
  { keyword:'hand churned ghee benefits traditional bilona',    title:'Hand Churned Bilona Ghee: Why Traditional Method Makes It Far Superior',     category:'health'  },
  { keyword:'country cow ghee benefits a2 milk',                title:'Country Cow Ghee vs Commercial Ghee: The A2 Milk Difference Explained',     category:'health'  },

  // ── SPICES & POWDERS ──────────────────────────────────────────────────────
  { keyword:'natural turmeric powder benefits curcumin',        title:'Natural Turmeric Powder vs Commercial: Why Curcumin Content Matters',        category:'spices'  },
  { keyword:'homemade chilli powder benefits natural',          title:'Natural Chilli Powder: Why Single-Origin Beats Commercial Blends Every Time',category:'spices'  },
  { keyword:'coriander powder benefits digestion cooking',      title:'Pure Coriander Powder: Benefits for Digestion and Authentic Indian Cooking', category:'spices'  },
  { keyword:'idly powder recipe benefits south indian',         title:'Authentic Idly Powder: The South Indian Condiment with Real Nutritional Value',category:'recipes'},
  { keyword:'navathaniya dosa mix benefits nine grains',        title:'Navathaniya Dosa Mix: Nine Grains, One Pan — Maximum Nutrition',            category:'recipes' },

  // ── DALS & PULSES ─────────────────────────────────────────────────────────
  { keyword:'toor dal benefits protein nutrition cooking',      title:'Toor Dal: India\'s Favourite Protein Source and How to Get Maximum Nutrition',category:'health' },
  { keyword:'moong dal benefits weight loss easy digest',       title:'Moong Dal: The Easiest-to-Digest Dal with Incredible Health Benefits',      category:'health'  },
  { keyword:'urad dal benefits bone health south Indian',       title:'Urad Dal: The Secret Behind South Indian Food\'s Incredible Nutritional Value',category:'health'},
  { keyword:'horse gram kulthi dal benefits diabetes',          title:'Horse Gram (Kulthi Dal): The Underrated Dal That Fights Diabetes and Stones',category:'health' },
  { keyword:'black chickpeas kala chana benefits iron',         title:'Black Chickpeas (Kala Chana): The Iron-Rich Legume for Energy and Strength', category:'health' },
  { keyword:'masoor dal red lentil benefits cooking',           title:'Masoor Dal Benefits: Why Red Lentils Should Be in Every Indian Kitchen',    category:'health'  },

  // ── NATURAL SWEETENERS ────────────────────────────────────────────────────
  { keyword:'jaggery benefits vs sugar health',                 title:'Jaggery vs Sugar: 10 Reasons to Switch to Natural Jaggery Right Now',       category:'health'  },
  { keyword:'nattu sakkarai natural sugar benefits Tamil Nadu', title:'Nattu Sakkarai (Country Sugar): The Traditional Sweetener with Real Minerals',category:'health'},
  { keyword:'palm sugar candy benefits panai vellam',           title:'Palm Sugar Candy (Panai Vellam): Ancient Sweetener with Modern Health Benefits',category:'health'},

  // ── SEEDS & NUTS ──────────────────────────────────────────────────────────
  { keyword:'groundnut peanut benefits protein snack',          title:'Groundnuts (Peanuts): The Affordable Superfood Packed with Protein',         category:'health'  },
  { keyword:'sunflower seeds benefits vitamin E snack',         title:'Sunflower Seeds: Small Seeds with Big Health Benefits for Indian Snackers',  category:'health'  },
  { keyword:'badam almond benefits brain memory India',         title:'Badam (Almonds): How Many to Eat Daily and Why They Boost Brain Health',     category:'health'  },
  { keyword:'fenugreek methi seeds benefits diabetes hair',     title:'Fenugreek Seeds: The Ancient Remedy for Blood Sugar, Hair and Digestion',   category:'health'  },
  { keyword:'fennel seeds saunf benefits digestion',            title:'Fennel Seeds (Saunf): Why Every Indian Meal Should End with These',         category:'health'  },
  { keyword:'cumin seeds jeera benefits weight loss digestion', title:'Cumin Seeds (Jeera): The Kitchen Spice That Transforms Your Metabolism',    category:'spices'  },
  { keyword:'coriander seeds benefits cholesterol',             title:'Coriander Seeds: The Anti-Cholesterol Spice Your Kitchen Is Missing',       category:'spices'  },
  { keyword:'mustard seeds benefits health Indian cooking',     title:'Mustard Seeds: Why the First Tempering Step in Indian Cooking Is So Important',category:'spices'},

  // ── RICE & GRAINS ─────────────────────────────────────────────────────────
  { keyword:'organic black rice karupu kavuni benefits',        title:'Karupu Kavuni (Black Rice): The Royal Grain with Extraordinary Antioxidants',category:'health' },
  { keyword:'thooyamalli rice benefits fragrant Indian rice',   title:'Thooyamalli Rice: Tamil Nadu\'s Fragrant Heritage Rice Worth Switching To', category:'health'  },
  { keyword:'organic idly rice benefits south Indian cooking',  title:'Organic Idly Rice: Why the Quality of Rice Makes or Breaks Your Idly',     category:'recipes' },

  // ── TAMARIND ──────────────────────────────────────────────────────────────
  { keyword:'tamarind benefits health digestion Indian cooking',title:'Tamarind: The Sour Superfood Behind the Best South Indian Dishes',          category:'health'  },

  // ── SPECIALTY PRODUCTS ────────────────────────────────────────────────────
  { keyword:'whole mung beans benefits green moong',            title:'Whole Mung Beans: The Sprout-Ready Superfood for Gut Health',               category:'health'  },
  { keyword:'soya beans benefits protein plant based India',    title:'Soya Beans: High-Protein Plant Food for Vegetarian Indian Diets',           category:'health'  },
  { keyword:'red rice flour benefits nutrition cooking',        title:'Red Rice Flour: The Nutrient-Dense Flour for Healthier Traditional Recipes',category:'health'  },
  { keyword:'roasted bengal gram chutney powder benefits',      title:'Roasted Bengal Gram: The High-Protein Snack Behind South Indian Chutneys',  category:'health'  },
];

const SYSTEM_PROMPT = `You are an expert content writer for Sathvam Natural Products — a factory-direct natural products brand in Karur, Tamil Nadu that makes cold-pressed oils, millets, organic spices, dals, ghee and natural sweeteners.

Write SEO-optimised blog articles that:
- Target the given keyword naturally (use it in title, first paragraph, 2-3 subheadings, conclusion)
- Are 700–900 words long
- Use Markdown headings (## and ###)
- Include practical, helpful information Indian readers care about
- Mention Sathvam's products naturally 2-3 times
- End with a call-to-action linking to www.sathvam.in
- Use simple, clear English with occasional Tamil product names
- Include 3–5 bullet-point lists for readability

## Sathvam Brand Pillars — weave into EVERY article naturally:

**Purity** — Sathvam means purity. Every product is single-ingredient, nothing added. Use phrases like "uncompromised purity", "pure from source to bottle", "purity you can taste".

**Healthy** — Connect products to real health outcomes: better digestion, stronger bones, controlled blood sugar, heart health. Use phrases like "nourish your family", "real nutrition", "the healthy choice our grandmothers made".

**Hygienic** — Sathvam's factory follows strict food-safe hygiene standards. Use phrases like "hygienically processed", "food-safe facility", "clean from farm to bottle".

**Quality Seeds for Grinding** — Sathvam sources only the highest-quality seeds and raw materials directly from trusted farms. For oil products especially: the quality of the final oil depends entirely on the quality of the seed. Use phrases like "hand-picked quality seeds", "premium seeds for grinding", "quality starts at the source".

Always make these pillars feel natural and authentic — not like marketing copy.
Do NOT use "In conclusion" or "To summarize". Write like a knowledgeable friend.`;

async function writeArticle(keyword, title, category) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Write a blog post titled: "${title}"\nTarget keyword: "${keyword}"\nCategory: ${category}\n\nWrite the full article in Markdown now.` }],
    }),
  });
  if (!res.ok) throw new Error('API error: ' + await res.text());
  const data = await res.json();
  return data.content?.find(b => b.type === 'text')?.text;
}

async function publishArticle(title, slug, excerpt, content, keywords, category) {
  const { data, error } = await supabase.from('blog_posts').insert({
    title, slug, excerpt,
    content,
    keywords,
    category,
    author: 'Sathvam Team',
    read_time: Math.max(1, Math.ceil(content.split(' ').length / 200)),
    published: true,
    published_at: new Date().toISOString(),
  }).select('id,slug').single();
  if (error) throw new Error(error.message);
  return data;
}

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

const fs   = require('fs');
const path = require('path');

const SITEMAP_PATH = '/home/ubuntu/sathvam-frontend/sathvam-vercel/public/sitemap.xml';
const BASE_URL     = 'https://www.sathvam.in';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Ping Google to recrawl the sitemap
async function pingGoogle() {
  const url = `https://www.google.com/ping?sitemap=${encodeURIComponent(BASE_URL + '/sitemap.xml')}`;
  try {
    const r = await fetch(url);
    console.log(`  [Google ping] Status: ${r.status}`);
  } catch (e) {
    console.log(`  [Google ping] Failed: ${e.message}`);
  }
}

// Rebuild sitemap.xml with all blog post URLs
async function updateSitemap(publishedSlugs) {
  const today = new Date().toISOString().slice(0, 10);

  const staticUrls = `
  <!-- Homepage -->
  <url>
    <loc>${BASE_URL}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
    <image:image>
      <image:loc>${BASE_URL}/logo.jpg</image:loc>
      <image:title>Sathvam Natural Products — Cold Pressed Oils &amp; Organic Millets</image:title>
    </image:image>
  </url>

  <!-- Products page -->
  <url>
    <loc>${BASE_URL}/?view=products</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>

  <!-- About page -->
  <url>
    <loc>${BASE_URL}/?view=about</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>

  <!-- Contact page -->
  <url>
    <loc>${BASE_URL}/?view=contact</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>

  <!-- Blog listing -->
  <url>
    <loc>${BASE_URL}/?view=blog</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>

  <!-- Key product categories -->
  <url>
    <loc>${BASE_URL}/?view=products&amp;cat=oil</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${BASE_URL}/?view=products&amp;cat=grain</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${BASE_URL}/?view=products&amp;cat=spice</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;

  const blogUrls = publishedSlugs.map(slug => `
  <url>
    <loc>${BASE_URL}/?view=post&amp;slug=${slug}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${staticUrls}
${blogUrls}
</urlset>`;

  fs.writeFileSync(SITEMAP_PATH, xml, 'utf8');
  console.log(`\n  [Sitemap] Updated with ${publishedSlugs.length} blog URLs → ${SITEMAP_PATH}`);
}

async function main() {
  console.log(`\n[${new Date().toISOString()}] Starting bulk product blog publisher...`);
  console.log(`Total articles to write: ${ALL_PRODUCT_ARTICLES.length}\n`);

  // Get existing slugs to skip duplicates
  const { data: existing } = await supabase.from('blog_posts').select('slug');
  const existingSlugs = new Set((existing || []).map(p => p.slug));
  const allPublishedSlugs = [...existingSlugs]; // track all slugs (old + new)

  let published = 0, skipped = 0, failed = 0;

  for (let i = 0; i < ALL_PRODUCT_ARTICLES.length; i++) {
    const { keyword, title, category } = ALL_PRODUCT_ARTICLES[i];
    const slug = slugify(title);

    if (existingSlugs.has(slug)) {
      console.log(`  [${i+1}/${ALL_PRODUCT_ARTICLES.length}] SKIP (exists): ${title}`);
      skipped++;
      continue;
    }

    console.log(`  [${i+1}/${ALL_PRODUCT_ARTICLES.length}] Writing: ${title}`);

    try {
      const content = await writeArticle(keyword, title, category);
      if (!content) throw new Error('No content returned');

      const excerpt = content.replace(/[#*>\n`]/g, ' ').replace(/\s+/g,' ').trim().slice(0, 200);
      await publishArticle(title, slug, excerpt, content, [keyword], category);

      console.log(`    ✓ Published: ${BASE_URL}/?view=post&slug=${slug}`);
      published++;
      existingSlugs.add(slug);
      allPublishedSlugs.push(slug);

      // Wait 3 seconds between API calls to avoid rate limiting
      if (i < ALL_PRODUCT_ARTICLES.length - 1) await sleep(3000);

    } catch (e) {
      console.error(`    ✗ Failed: ${e.message}`);
      failed++;
      await sleep(5000);
    }
  }

  console.log(`\n[${new Date().toISOString()}] Done!`);
  console.log(`Published: ${published} | Skipped: ${skipped} | Failed: ${failed}`);

  // Update sitemap with all blog URLs
  await updateSitemap(allPublishedSlugs);

  // Ping Google to recrawl
  console.log('\n  Pinging Google to recrawl sitemap...');
  await pingGoogle();

  console.log(`\nAll articles live at: ${BASE_URL} → Blog`);
  console.log('Next: run "npm run build && cp -r dist/* /var/www/sathvam/" to deploy updated sitemap.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
