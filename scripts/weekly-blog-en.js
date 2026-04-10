#!/usr/bin/env node
/**
 * Sathvam Weekly English Blog Writer
 * Runs every Monday 9:30 AM IST (04:00 UTC) via systemd timer
 * Picks a rotating keyword, writes article via Claude, publishes to Supabase
 */
require('dotenv').config({ path: '/home/ubuntu/sathvam-backend/.env' });
const supabase = require('../config/supabase');

const KEYWORDS = [
  { keyword:'benefits of cold pressed groundnut oil',         title:'Top 7 Benefits of Cold Pressed Groundnut Oil You Should Know',              category:'oils'    },
  { keyword:'wood pressed sesame oil benefits',               title:'Why Wood Pressed Sesame Oil is Better Than Refined Oil',                    category:'oils'    },
  { keyword:'cold pressed coconut oil benefits',              title:'Pure Cold Pressed Coconut Oil: Benefits, Uses & How to Choose',             category:'oils'    },
  { keyword:'finger millet ragi benefits',                    title:'Ragi (Finger Millet): The Calcium King That Beats Rice & Wheat',            category:'millets' },
  { keyword:'foxtail millet benefits for diabetes',           title:'Foxtail Millet for Diabetics: Low GI Grain That Controls Blood Sugar',      category:'millets' },
  { keyword:'pearl millet kambam benefits',                   title:'Pearl Millet (Kambam): The High Protein Grain Every Indian Should Eat',     category:'millets' },
  { keyword:'how to identify pure cold pressed oil',          title:'How to Identify Pure Cold Pressed Oil vs Adulterated Oil at Home',          category:'health'  },
  { keyword:'natural turmeric powder benefits',               title:'Natural Turmeric Powder vs Commercial: Why the Difference Matters',         category:'spices'  },
  { keyword:'jaggery vs sugar health benefits',               title:'Jaggery vs Sugar: 8 Reasons to Switch to Natural Jaggery Today',           category:'health'  },
  { keyword:'cold pressed oil for cooking India',             title:'Which Cold Pressed Oil is Best for Indian Cooking? Complete Guide',         category:'oils'    },
  { keyword:'organic sambar powder recipe',                   title:'Authentic Sambar Powder: Why Homestyle Blends Beat Commercial Brands',      category:'spices'  },
  { keyword:'millet recipes for weight loss',                 title:'5 Easy Millet Recipes for Weight Loss That Actually Taste Good',            category:'recipes' },
  { keyword:'hexane free oil what does it mean',              title:'Hexane Free Oil: What It Means and Why You Should Care',                   category:'health'  },
  { keyword:'cold pressed mustard oil benefits',              title:'Cold Pressed Mustard Oil: Traditional Benefits and Modern Uses',            category:'oils'    },
  { keyword:'factory direct natural products India',          title:'Why Buying Factory Direct Natural Products Saves Money and Quality',        category:'health'  },
  { keyword:'neem oil for organic farming',                   title:'Neem Oil for Organic Farming: How to Use It and Why It Works',             category:'farming' },
  { keyword:'ragi porridge for babies',                       title:'Ragi Porridge for Babies: Benefits, Age Guide & Easy Recipe',              category:'recipes' },
  { keyword:'best cooking oil for heart health India',        title:'Best Cooking Oils for Heart Health: An Honest Guide for Indian Kitchens',  category:'health'  },
  { keyword:'cold pressed oil shelf life storage',            title:'How to Store Cold Pressed Oil: Shelf Life & Freshness Guide',              category:'oils'    },
  { keyword:'Indian traditional cooking oils history',        title:'The History of Traditional Indian Cooking Oils and Why They\'re Coming Back',category:'health' },
  { keyword:'kodo millet benefits cooking',                   title:'Kodo Millet: How to Cook It and Why Your Body Will Thank You',             category:'millets' },
  { keyword:'barnyard millet kuthiraivali fasting',           title:'Barnyard Millet: The Perfect Fasting Grain with Exceptional Nutrition',    category:'millets' },
  { keyword:'castor oil hair growth ayurveda',                title:'Castor Oil for Hair Growth: The Ayurvedic Secret That Actually Works',     category:'health'  },
  { keyword:'horse gram benefits diabetes weight loss',       title:'Horse Gram: The Ancient Dal That Fights Diabetes and Aids Weight Loss',    category:'health'  },
  { keyword:'black rice karupu kavuni benefits',              title:'Black Rice (Karupu Kavuni): The Antioxidant-Rich Royal Grain of Tamil Nadu',category:'health'  },
  { keyword:'palm jaggery vs cane jaggery benefits',         title:'Palm Jaggery vs Cane Jaggery: Which Is Healthier for Your Family?',        category:'health'  },
  { keyword:'fenugreek seeds benefits blood sugar hair',      title:'Fenugreek Seeds: The Kitchen Spice That Controls Blood Sugar and Regrows Hair',category:'health'},
  { keyword:'cold pressed walnut oil brain health',           title:'Walnut Oil for Brain Health: Why This Cold Pressed Oil Is Worth It',       category:'oils'    },
  { keyword:'moong dal benefits easy digestion',              title:'Moong Dal: The Most Digestible Dal with Maximum Health Benefits',          category:'health'  },
  { keyword:'deepam oil pooja lamp benefits',                 title:'Deepam Oil for Pooja: Why Pure Sesame Oil Makes a Difference at Home',     category:'oils'    },
];

const SYSTEM_PROMPT = `You are an expert content writer for Sathvam Natural Products — a factory-direct natural products brand in Karur, Tamil Nadu that makes cold-pressed oils, millets, organic spices, dals, ghee and natural sweeteners.

Write SEO-optimised blog articles that:
- Target the given keyword naturally (use it in title, first paragraph, 2-3 subheadings, conclusion)
- Are 700–900 words long
- Use Markdown headings (## and ###)
- Include practical, helpful information Indian readers care about
- Mention Sathvam's products naturally 2-3 times (not pushy)
- End with a call-to-action linking to www.sathvam.in
- Use simple, clear English with occasional Tamil product names
- Include 3–5 bullet-point lists for readability

## Sathvam Brand Pillars — weave into EVERY article naturally:
**Purity** — Sathvam means purity. Every product is single-ingredient, nothing added.
**Healthy** — Connect products to real health outcomes: better digestion, stronger bones, controlled blood sugar.
**Hygienic** — Factory follows strict food-safe hygiene standards.
**Quality Seeds** — Only the highest-quality seeds sourced directly from trusted farms.

Do NOT use "In conclusion" or "To summarize". Write like a knowledgeable friend.`;

function slugify(t) {
  return t.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80);
}

async function main() {
  console.log(`[${new Date().toISOString()}] Weekly English blog writer starting...`);

  const weekOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(),0,1)) / (7*24*60*60*1000));
  const pick = KEYWORDS[weekOfYear % KEYWORDS.length];
  const slug = slugify(pick.title);

  console.log(`Article: "${pick.title}"`);

  // Check if already exists
  const { data: existing } = await supabase.from('blog_posts').select('id').eq('slug', slug).single();
  if (existing) {
    console.log('Already published, skipping.');
    process.exit(0);
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Write a blog post titled: "${pick.title}"\nTarget keyword: "${pick.keyword}"\nCategory: ${pick.category}\n\nWrite the full article in Markdown now.` }],
    }),
  });
  if (!res.ok) throw new Error('API error: ' + await res.text());
  const content = (await res.json()).content?.find(b=>b.type==='text')?.text;
  if (!content) throw new Error('No content returned');

  const excerpt = content.replace(/[#*>\n`]/g,' ').replace(/\s+/g,' ').trim().slice(0,200);
  const { error } = await supabase.from('blog_posts').insert({
    title: pick.title, slug, excerpt, content,
    keywords: [pick.keyword], category: pick.category,
    author: 'Sathvam Team',
    read_time: Math.max(1, Math.ceil(content.split(' ').length / 200)),
    published: true,
    published_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);

  console.log(`✓ Published: https://www.sathvam.in/?view=post&slug=${slug}`);

  // Ping Google
  await fetch(`https://www.google.com/ping?sitemap=${encodeURIComponent('https://www.sathvam.in/sitemap.xml')}`).catch(()=>{});
  console.log(`[${new Date().toISOString()}] Done.`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
