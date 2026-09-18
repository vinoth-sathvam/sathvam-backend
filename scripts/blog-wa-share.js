#!/usr/bin/env node
/**
 * Blog WhatsApp Drip Share — ONE message per run
 *
 * Sends ONE blog post to ONE customer per execution.
 * Timer runs every 15 minutes (9 AM – 9 PM IST) = max 48 sends/day.
 * Looks exactly like a human sending messages — zero ban risk.
 *
 * Anti-ban strategy:
 *   - Only 1 message per run (timer fires every 15 min)
 *   - Personalized messages (customer first name)
 *   - 5 rotating message templates (random pick per send)
 *   - Unique index prevents re-sending same blog to same phone
 *   - Only sends during business hours (9 AM – 9 PM IST)
 *
 * Schedule: every 15 min (9 AM–9 PM IST) via systemd timer
 * Manual:   node scripts/blog-wa-share.js [--dry-run]
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const supabase      = require('../config/supabase');
const { sendText, isAutomationDisabled } = require('../lib/greenapi');
const { decryptCustomer } = require('../config/crypto');

const BLOG_URL_BASE = 'https://sathvam.in/blog/';
const ADMIN_APPROVAL_PHONE = '918144803555';  // send preview here first for approval

function normPhone(p) {
  const d = (p || '').replace(/\D/g, '');
  if (d.length === 10) return '91' + d;
  if (d.length >= 11 && d.startsWith('91')) return d;
  return null;
}

// ── 5 rotating message templates (EN) ──
const TEMPLATES_EN = [
  (name, title, url) =>
    `🌿 Hi ${name}! We just published a new article you might enjoy:\n\n` +
    `*${title}*\n\n` +
    `👉 Read here: ${url}\n\n` +
    `_— Team Sathvam_`,

  (name, title, url) =>
    `Hello ${name} 😊\n\n` +
    `New on the Sathvam blog:\n` +
    `📖 *${title}*\n\n` +
    `${url}\n\n` +
    `Hope you find it useful! Reply if you have questions 🙏`,

  (name, title, url) =>
    `Hey ${name}! 🧴\n\n` +
    `We wrote something new for you:\n\n` +
    `*${title}*\n\n` +
    `Read the full article 👇\n${url}\n\n` +
    `Stay healthy, stay natural! 💚`,

  (name, title, url) =>
    `Namaste ${name}! 🙏\n\n` +
    `Our latest blog post is live:\n` +
    `*${title}*\n\n` +
    `${url}\n\n` +
    `Do share with friends & family if you like it! 🌻`,

  (name, title, url) =>
    `${name}, good morning! ☀️\n\n` +
    `Fresh from the Sathvam blog:\n` +
    `*${title}*\n\n` +
    `📝 ${url}\n\n` +
    `Your health is our priority! 🌿`,
];

// ── 5 rotating message templates (Tamil) ──
const TEMPLATES_TA = [
  (name, title, url) =>
    `🌿 வணக்கம் ${name}! புதிய கட்டுரை:\n\n` +
    `*${title}*\n\n` +
    `👉 படிக்க: ${url}\n\n` +
    `_— சத்வம் குழு_`,

  (name, title, url) =>
    `${name} 😊\n\n` +
    `சத்வம் வலைப்பூவில் புதியது:\n` +
    `📖 *${title}*\n\n` +
    `${url}\n\n` +
    `உங்களுக்கு பயனுள்ளதாக இருக்கும் 🙏`,

  (name, title, url) =>
    `அன்புள்ள ${name}! 🧴\n\n` +
    `புதிய கட்டுரை:\n\n` +
    `*${title}*\n\n` +
    `முழுமையாக படிக்க 👇\n${url}\n\n` +
    `ஆரோக்கியமாக இருங்கள்! 💚`,

  (name, title, url) =>
    `நமஸ்தே ${name}! 🙏\n\n` +
    `எங்கள் புதிய வலைப்பூ:\n` +
    `*${title}*\n\n` +
    `${url}\n\n` +
    `நண்பர்களுடன் பகிருங்கள்! 🌻`,

  (name, title, url) =>
    `${name}, காலை வணக்கம்! ☀️\n\n` +
    `சத்வம் வலைப்பூவில்:\n` +
    `*${title}*\n\n` +
    `📝 ${url}\n\n` +
    `உங்கள் ஆரோக்கியமே எங்கள் முன்னுரிமை! 🌿`,
];

async function getCustomerPhones() {
  const phoneMap = new Map(); // phone → { name, customer_id }

  // 1. From customers table (registered users with phone)
  const { data: customers } = await supabase.from('customers').select('id, name, email, phone');
  if (customers) {
    for (const c of customers) {
      const dec = decryptCustomer(c);
      const phone = normPhone(dec.phone);
      if (phone && !phoneMap.has(phone)) {
        phoneMap.set(phone, { name: dec.name || 'Friend', customer_id: c.id });
      }
    }
  }

  // 2. From webstore_orders (guests who ordered but may not have account)
  const { data: orders } = await supabase
    .from('webstore_orders')
    .select('customer')
    .eq('status', 'delivered')
    .order('created_at', { ascending: false })
    .limit(500);

  if (orders) {
    for (const o of orders) {
      const cust = decryptCustomer(typeof o.customer === 'string' ? JSON.parse(o.customer) : (o.customer || {}));
      const phone = normPhone(cust.phone);
      if (phone && !phoneMap.has(phone)) {
        phoneMap.set(phone, { name: cust.name || 'Friend', customer_id: null });
      }
    }
  }

  return phoneMap;
}

async function getUnsharedBlogs() {
  // Get published blogs from last 14 days that haven't been fully shared yet
  const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000).toISOString();

  const { data: blogs, error } = await supabase
    .from('blog_posts')
    .select('id, title, slug, category, published_at')
    .eq('published', true)
    .gte('published_at', fourteenDaysAgo)
    .order('published_at', { ascending: true }); // oldest first (finish one blog before next)

  if (error) { console.error('Blog fetch error:', error.message); return []; }
  return blogs || [];
}

async function getAlreadySentPhones(blogId) {
  const { data } = await supabase
    .from('blog_wa_sends')
    .select('customer_phone')
    .eq('blog_id', blogId)
    .eq('status', 'sent');

  return new Set((data || []).map(r => r.customer_phone));
}

async function run() {
  if (await isAutomationDisabled('blog_wa_share')) {
    console.log('[blog-wa-share] Disabled via toggle');
    return;
  }

  const args   = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  // Only send during 9 AM – 9 PM IST (UTC+5:30)
  const nowUTC = new Date();
  const istHour = (nowUTC.getUTCHours() + 5 + (nowUTC.getUTCMinutes() + 30 >= 60 ? 1 : 0)) % 24;
  if (!dryRun && (istHour < 9 || istHour >= 21)) {
    console.log(`[blog-wa-share] Outside business hours (IST ${istHour}:xx). Skipping.`);
    return;
  }

  console.log(`[blog-wa-share] ${new Date().toISOString()}${dryRun ? ' (DRY RUN)' : ''}`);

  // 1. Get new blogs to share
  const blogs = await getUnsharedBlogs();
  if (!blogs.length) {
    console.log('[blog-wa-share] No new blogs to share');
    return;
  }

  // 1b. Check admin approval for each blog — new blogs need preview + approval first
  const { data: approvalRow } = await supabase.from('settings').select('value').eq('key', 'blog_wa_approvals').single();
  const approvals = approvalRow?.value || {}; // { blogId: 'approved' | 'pending' }

  for (const blog of blogs) {
    if (!approvals[blog.id]) {
      // New blog — send preview to admin for approval
      const isTamil = blog.slug?.startsWith('ta-') || blog.slug?.includes('-ta-') || blog.slug?.endsWith('-ta') || blog.category === 'tamil';
      const blogUrl = BLOG_URL_BASE + encodeURIComponent(blog.slug);
      const previewMsg =
        `📋 *Blog WA Share — Approval Needed*\n\n` +
        `New blog ready to share with customers:\n\n` +
        `*${blog.title}*\n` +
        `Language: ${isTamil ? 'Tamil' : 'English'}\n` +
        `Link: ${blogUrl}\n\n` +
        `To approve, go to Admin → Marketing → 📝 Blog WhatsApp → click "✅ Approve" for this blog.\n\n` +
        `_Customers will NOT receive this until you approve._`;

      if (!dryRun) {
        try { await sendText(ADMIN_APPROVAL_PHONE, previewMsg); } catch (e) { /* silent */ }
        approvals[blog.id] = 'pending';
        await supabase.from('settings').upsert({ key: 'blog_wa_approvals', value: approvals, updated_at: new Date().toISOString() });
        console.log(`[blog-wa-share] Preview sent to admin for "${blog.title.slice(0, 50)}". Waiting for approval.`);
      } else {
        console.log(`[DRY RUN] Would send preview to admin for "${blog.title.slice(0, 50)}"`);
      }
      continue;
    }
    if (approvals[blog.id] === 'pending') {
      console.log(`[blog-wa-share] "${blog.title.slice(0, 50)}" — waiting for admin approval`);
      continue;
    }
    // 'approved' — proceed
  }

  // Filter to only approved blogs
  const approvedBlogs = blogs.filter(b => approvals[b.id] === 'approved');
  if (!approvedBlogs.length) {
    console.log('[blog-wa-share] No approved blogs to share. Waiting for admin approval.');
    return;
  }

  // 2. Get all customer phones
  const phoneMap = await getCustomerPhones();
  if (!phoneMap.size) { console.log('[blog-wa-share] No customers found'); return; }

  // 3. Round-robin: pick the blog with FEWEST sends so EN and TA progress together
  const blogCandidates = [];
  for (const blog of approvedBlogs) {
    const alreadySent = await getAlreadySentPhones(blog.id);
    // Find ONE customer who hasn't received this blog yet
    let target = null;
    for (const [phone, info] of phoneMap) {
      if (!alreadySent.has(phone)) {
        target = { phone, ...info };
        break;
      }
    }
    if (!target) {
      console.log(`[blog-wa-share] "${blog.title.slice(0, 50)}" — all ${phoneMap.size} customers done`);
      continue;
    }
    blogCandidates.push({ blog, alreadySent, target });
  }

  if (!blogCandidates.length) {
    console.log('[blog-wa-share] All blogs fully delivered to all customers');
    return;
  }

  // Pick the blog with fewest sends (least progress) — ensures EN and TA advance equally
  blogCandidates.sort((a, b) => a.alreadySent.size - b.alreadySent.size);
  const { blog, alreadySent, target } = blogCandidates[0];

  {
    const isTamil = blog.slug?.startsWith('ta-') || blog.slug?.includes('-ta-') || blog.slug?.endsWith('-ta') || blog.category === 'tamil';
    const templates = isTamil ? TEMPLATES_TA : TEMPLATES_EN;
    const blogUrl = BLOG_URL_BASE + encodeURIComponent(blog.slug);
    const lang = isTamil ? 'ta' : 'en';

    const remaining = phoneMap.size - alreadySent.size - 1;
    const firstName = (target.name || 'Friend').split(' ')[0];
    // Random template pick (varies each run)
    const tpl = templates[Math.floor(Math.random() * templates.length)];
    const message = tpl(firstName, blog.title, blogUrl);

    console.log(`[blog-wa-share] Blog: "${blog.title.slice(0, 50)}" (${lang.toUpperCase()}) → ${target.phone} (${firstName}) [${remaining} left]`);

    if (dryRun) {
      console.log(`[DRY RUN] Would send to ${target.phone}`);
      return;
    }

    // Send the ONE message
    let status = 'sent';
    let errorMsg = null;
    try {
      const ok = await sendText(target.phone, message);
      if (ok) {
        console.log(`[SENT] ${target.phone} (${firstName})`);
      } else {
        status = 'failed';
        errorMsg = 'sendText returned false';
        console.log(`[FAIL] ${target.phone}`);
      }
    } catch (e) {
      status = 'failed';
      errorMsg = e.message;
      console.error(`[ERROR] ${target.phone}: ${e.message}`);
    }

    // Record in DB
    try {
      await supabase.from('blog_wa_sends').upsert({
        blog_id: blog.id,
        blog_title: blog.title,
        blog_lang: lang,
        customer_id: target.customer_id,
        customer_phone: target.phone,
        customer_name: firstName,
        status,
        error_msg: errorMsg,
        sent_at: new Date().toISOString(),
        run_id: 'drip',
      }, { onConflict: 'blog_id,customer_phone' });
    } catch (dbErr) {
      console.error(`[DB ERROR]:`, dbErr.message);
    }

    // Done — only ONE message per run
    return;
  }
}

run().catch(e => { console.error(e); process.exit(1); });
