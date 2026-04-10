#!/usr/bin/env node
/**
 * Sathvam Weekly SEO Blog Writer
 * Runs every Monday at 9:30 AM IST via cron: 0 4 * * 1
 * cron: 0 4 * * 1 node /home/ubuntu/sathvam-backend/scripts/weekly-blog.js >> /var/log/sathvam-blog.log 2>&1
 *
 * Picks a keyword → calls Claude to write 700-word SEO article → publishes to blog
 */

require('dotenv').config({ path: '/home/ubuntu/sathvam-backend/.env' });
const { executeTool, TOOLS } = require('../routes/adminChat');

// Rotating keyword list — covers high-volume searches for Sathvam products
const KEYWORDS = [
  { keyword: 'benefits of cold pressed groundnut oil',       title: 'Top 7 Benefits of Cold Pressed Groundnut Oil You Should Know',           category: 'oils'    },
  { keyword: 'wood pressed sesame oil benefits',              title: 'Why Wood Pressed Sesame Oil is Better Than Refined Oil',                  category: 'oils'    },
  { keyword: 'cold pressed coconut oil benefits',             title: 'Pure Cold Pressed Coconut Oil: Benefits, Uses & How to Choose',          category: 'oils'    },
  { keyword: 'finger millet ragi benefits',                   title: 'Ragi (Finger Millet): The Calcium King That Beats Rice & Wheat',         category: 'millets' },
  { keyword: 'foxtail millet benefits for diabetes',          title: 'Foxtail Millet for Diabetics: Low GI Grain That Controls Blood Sugar',   category: 'millets' },
  { keyword: 'pearl millet kambam benefits',                  title: 'Pearl Millet (Kambam): The High Protein Grain Every Indian Should Eat',  category: 'millets' },
  { keyword: 'how to identify pure cold pressed oil',         title: 'How to Identify Pure Cold Pressed Oil vs Adulterated Oil at Home',       category: 'health'  },
  { keyword: 'natural turmeric powder benefits',              title: 'Natural Turmeric Powder vs Commercial: Why the Difference Matters',      category: 'spices'  },
  { keyword: 'jaggery vs sugar health benefits',              title: 'Jaggery vs Sugar: 8 Reasons to Switch to Natural Jaggery Today',        category: 'health'  },
  { keyword: 'cold pressed oil for cooking India',            title: 'Which Cold Pressed Oil is Best for Indian Cooking? Complete Guide',      category: 'oils'    },
  { keyword: 'organic sambar powder recipe',                  title: 'Authentic Sambar Powder: Why Homestyle Blends Beat Commercial Brands',   category: 'spices'  },
  { keyword: 'millet recipes for weight loss',                title: '5 Easy Millet Recipes for Weight Loss That Actually Taste Good',         category: 'recipes' },
  { keyword: 'hexane free oil what does it mean',             title: 'Hexane Free Oil: What It Means and Why You Should Care',                 category: 'health'  },
  { keyword: 'cold pressed mustard oil benefits',             title: 'Cold Pressed Mustard Oil: Traditional Benefits and Modern Uses',         category: 'oils'    },
  { keyword: 'factory direct natural products India',         title: 'Why Buying Factory Direct Natural Products Saves Money and Quality',     category: 'health'  },
  { keyword: 'neem oil for organic farming',                  title: 'Neem Oil for Organic Farming: How to Use It and Why It Works',          category: 'farming' },
  { keyword: 'ragi porridge for babies',                      title: 'Ragi Porridge for Babies: Benefits, Age Guide & Easy Recipe',           category: 'recipes' },
  { keyword: 'best cooking oil for heart health India',       title: 'Best Cooking Oils for Heart Health: An Honest Guide for Indian Kitchens',category: 'health'  },
  { keyword: 'cold pressed oil shelf life storage',           title: 'How to Store Cold Pressed Oil: Shelf Life & Freshness Guide',           category: 'oils'    },
  { keyword: 'Indian traditional cooking oils history',       title: 'The History of Traditional Indian Cooking Oils and Why They\'re Coming Back', category: 'health' },
];

const SYSTEM_PROMPT = `You are an expert content writer for Sathvam Natural Products — a factory-direct natural products brand in Karur, Tamil Nadu that makes cold-pressed oils, millets, and organic spices.

Write SEO-optimised blog articles that:
- Target the given keyword naturally (use it in title, first paragraph, 2-3 subheadings, conclusion)
- Are 700–900 words long
- Use Markdown headings (## and ###)
- Include practical, helpful information Indian readers care about
- Mention Sathvam's products naturally 2-3 times (not pushy)
- End with a call-to-action linking to www.sathvam.in
- Use simple, clear English with occasional Tamil product names
- Include 3–5 bullet-point lists for readability

## Sathvam Brand Pillars — weave these naturally into EVERY article:

**Purity** — Sathvam means purity. Every product is single-ingredient, nothing added. Use phrases like "uncompromised purity", "pure from source to bottle", "purity you can smell and taste".

**Healthy** — Everything Sathvam makes is designed to support a healthier life. Connect products to real health outcomes: better digestion, stronger bones, controlled blood sugar, heart health. Use phrases like "nourish your family", "real nutrition", "the healthy choice our grandmothers made".

**Hygienic** — Sathvam's factory follows strict food-safe hygiene standards. Products are cleaned, sorted, and processed in a hygienic environment. Use phrases like "hygienically processed", "food-safe facility", "clean from farm to bottle", "no contamination risk".

**Quality Seeds for Grinding** — Sathvam sources only the highest-quality seeds, grains, and raw materials directly from trusted farms. The cold-pressing process starts with premium seeds — because the quality of the final oil depends entirely on the quality of the seed. Use phrases like "hand-picked quality seeds", "premium seeds for grinding", "quality starts at the source", "only the best seeds go into our press".

Always make these 4 pillars feel natural and authentic — not like marketing copy. Write like a farmer-expert explaining why they care.

Do NOT use phrases like "In conclusion" or "To summarize". Write like a knowledgeable friend giving real advice.`;

async function runBlogAgent(keyword, title, category) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('No ANTHROPIC_API_KEY in env');

  const userPrompt = `Write a blog post titled: "${title}"
Target keyword: "${keyword}"
Category: ${category}

Write the full article in Markdown now. Then I will publish it.`;

  // Step 1: Ask Claude to write the article
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) throw new Error('Anthropic API error: ' + await res.text());
  const data = await res.json();
  const content = data.content?.find(b => b.type === 'text')?.text;
  if (!content) throw new Error('No content generated');

  // Step 2: Publish via executeTool
  const result = await executeTool('write_seo_blog_post', { keyword, title, category, content });
  return result;
}

async function sendWhatsApp(message) {
  const phoneId = process.env.WA_PHONE_NUMBER_ID;
  const token   = process.env.WA_ACCESS_TOKEN;
  const phone   = process.env.ADMIN_WHATSAPP_PHONE || process.env.WA_ADMIN_PHONE;
  if (!phoneId || !token || !phone) { console.log('WhatsApp not configured — skipping'); return; }
  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: message } }),
  });
  const d = await res.json();
  if (d.error) console.error('WhatsApp error:', d.error);
  else console.log('WhatsApp notification sent');
}

async function main() {
  console.log(`\n[${new Date().toISOString()}] Sathvam Weekly Blog Writer starting...`);

  // Pick keyword based on week number (rotates through list)
  const weekOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 1)) / (7 * 24 * 60 * 60 * 1000));
  const pick = KEYWORDS[weekOfYear % KEYWORDS.length];

  console.log(`Writing article: "${pick.title}"`);
  console.log(`Keyword: "${pick.keyword}"`);

  try {
    const result = await runBlogAgent(pick.keyword, pick.title, pick.category);

    if (result.success) {
      console.log(`Published! URL: ${result.url}`);
      await sendWhatsApp(
        `📝 New SEO Blog Published!\n\n` +
        `Title: ${pick.title}\n` +
        `Keyword: ${pick.keyword}\n` +
        `URL: ${result.url}\n\n` +
        `This article will start appearing in Google search results within 2-4 weeks.`
      );
    } else {
      console.error('Publish failed:', result);
    }

    console.log(`[${new Date().toISOString()}] Weekly blog complete.`);
  } catch (e) {
    console.error('Weekly blog failed:', e.message);
    process.exit(1);
  }
}

main();
