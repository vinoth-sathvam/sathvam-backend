/**
 * Sathvam WhatsApp Bot — Full State Machine
 *
 * A complete menu-driven bot with 4 flows:
 *   1️⃣  Shop & Order  → categories → products → cart → checkout → payment
 *   2️⃣  My Orders     → lists last 5 orders for this phone number
 *   3️⃣  Track Package → ask order no → fetch tracking info
 *   4️⃣  Talk to Team  → notify admin + send support message
 *
 * Session stored in Supabase `settings`:
 *   key   = wa_bot_session_<phone>
 *   value = { step, categories, current_cat, cart, orders, customer_name,
 *             address, payment_link_id, payment_link_url, created_at, updated_at }
 *
 * Steps:
 *   main_menu | cat_menu | cat_browse | tracking
 *   address_name | address_text | payment_pending
 *
 * Triggers (always active, restart bot):
 *   hi hello hey start menu home 0 help வணக்கம் ஹலோ
 *   order buy shop ஆர்டர்  (jump straight to shop)
 *
 * Exports:
 *   handleBotMessage(phone, text, subscriberName) → { reply, done }
 *   handlePaymentLinkPaid(paymentLinkId, razorpayPaymentId)
 */

'use strict';

const fs               = require('fs');
const crypto           = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { sendText, toChatId, sendButtons, sendListMessage } = require('../lib/greenapi');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const GREENAPI_BASE = 'https://api.green-api.com';
const PNG_GEN_URL   = process.env.DOCKER_ENV === 'true'
  ? 'http://host.docker.internal:8765/generate'
  : 'http://localhost:8765/generate';

// ── Category meta ─────────────────────────────────────────────────────────────

const CAT_DISPLAY = {
  oils:         'Cold-Pressed Oils',
  oil:          'Cold-Pressed Oils',
  spices:       'Spice Powders',
  spice:        'Spice Powders',
  soap:         'Natural Soaps',
  soaps:        'Natural Soaps',
  ghee:         'Pure Ghee',
  dryfruits:    'Dry Fruits & Nuts',
  'dry fruits': 'Dry Fruits & Nuts',
  honey:        'Natural Honey',
  pickles:      'Pickles & Chutneys',
  rice:         'Specialty Rice',
  flour:        'Natural Flours',
  sugar:        'Natural Sweeteners',
  dal:          'Dals & Lentils',
  dals:         'Dals & Lentils',
  grain:        'Grains & Cereals',
  grains:       'Grains & Cereals',
  household:    'Household Items',
  other:        'Other Products',
};

const CAT_EMOJI = {
  oils: '🫙', oil: '🫙',
  spices: '🌶', spice: '🌶',
  soap: '🧼', soaps: '🧼',
  ghee: '🍯',
  dryfruits: '🥜', 'dry fruits': '🥜',
  honey: '🍯', pickles: '🥒', rice: '🌾',
  flour: '🌿', sugar: '🍃',
  dal: '🫘', dals: '🫘',
  grain: '🌾', grains: '🌾',
  household: '🏠',
  other: '🌟',
};

function catDisplay(id) {
  const k = (id || '').toLowerCase();
  return CAT_DISPLAY[k] || id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function catEmoji(id) {
  return CAT_EMOJI[(id || '').toLowerCase()] || '🛒';
}

// ── Order status ──────────────────────────────────────────────────────────────

const STATUS_LABEL = {
  new: '🆕 New', confirmed: '✅ Confirmed', packed: '📦 Packed',
  shipped: '🚚 Shipped', delivered: '🎉 Delivered', cancelled: '❌ Cancelled',
  paid: '💳 Paid',
};

// ── Session helpers ───────────────────────────────────────────────────────────

const SESSION_KEY    = phone => `wa_bot_session_${phone}`;
const SESSION_TTL_MS = 60 * 60 * 1000; // 60 minutes

async function loadSession(phone) {
  try {
    const { data } = await supabase
      .from('settings').select('value').eq('key', SESSION_KEY(phone)).single();
    if (!data?.value) return null;
    const sess = data.value;
    const updatedAt = sess.updated_at || sess.created_at;
    if (updatedAt && Date.now() - new Date(updatedAt).getTime() > SESSION_TTL_MS) {
      await clearSession(phone);
      return null;
    }
    return sess;
  } catch { return null; }
}

async function saveSession(phone, session) {
  const now   = new Date().toISOString();
  const value = { ...session, updated_at: now, created_at: session.created_at || now };
  await supabase.from('settings').upsert({ key: SESSION_KEY(phone), value });
  return value;
}

async function clearSession(phone) {
  try { await supabase.from('settings').delete().eq('key', SESSION_KEY(phone)); } catch { /* ok */ }
}

// Also clear legacy key from old version
async function clearLegacySession(phone) {
  try { await supabase.from('settings').delete().eq('key', `wa_order_session_${phone}`); } catch { /* ok */ }
}

// ── Database helpers ──────────────────────────────────────────────────────────

/** Look up registered customer by phone — returns { name, address, city, state, pincode } or null */
async function getRegisteredCustomer(phone) {
  const digits = (phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length < 10) return null;
  try {
    // Match last 10 digits — stored phone may have country code or not
    const { data } = await supabase
      .from('customers')
      .select('name,address,city,state,pincode')
      .or(`phone.ilike.%${digits},phone.eq.${digits}`)
      .limit(1)
      .maybeSingle();
    if (!data) return null;
    // Only useful if they have a saved address
    if (!data.address) return null;
    return data;
  } catch { return null; }
}

async function getOrdersByPhone(phone) {
  const digits = (phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length < 10) return [];
  try {
    const { data } = await supabase
      .from('webstore_orders')
      .select('order_no,status,total,date,customer,tracking_no,courier,channel')
      .ilike('customer->>phone', `%${digits}`)
      .order('date', { ascending: false })
      .limit(5);
    return data || [];
  } catch { return []; }
}

async function lookupOrderNo(rawNo, phone) {
  try {
    const { data } = await supabase
      .from('webstore_orders')
      .select('order_no,status,total,date,customer,tracking_no,courier')
      .ilike('order_no', rawNo.trim())
      .maybeSingle();
    if (!data) return null;
    // Security: verify phone matches
    const orderDigits = (data.customer?.phone || '').replace(/\D/g, '').slice(-10);
    const inputDigits = (phone || '').replace(/\D/g, '').slice(-10);
    if (orderDigits && inputDigits && orderDigits !== inputDigits) return null;
    return data;
  } catch { return null; }
}

function formatOrderCard(o, idx) {
  const status = STATUS_LABEL[o.status] || o.status;
  const date   = o.date || (o.created_at ? new Date(o.created_at).toLocaleDateString('en-IN') : '');
  const track  = o.tracking_no ? `\n   🚚 ${o.courier || ''} · ${o.tracking_no}` : '';
  const prefix = idx != null ? `${idx}. ` : '';
  return `${prefix}📦 *${o.order_no}*\n   ${status} · ${date} · ₹${Number(o.total).toLocaleString('en-IN')}${track}`;
}

// ── Product loaders ───────────────────────────────────────────────────────────

async function loadCategories() {
  const { data, error } = await supabase
    .from('products')
    .select('cat, website_price, price')
    .eq('active', true)
    .neq('cat', 'raw');

  if (error) throw new Error(`Category load failed: ${error.message}`);

  const counts = {};
  for (const p of (data || [])) {
    if ((p.website_price || p.price || 0) <= 0) continue;
    const c = (p.cat || 'other').toLowerCase();
    counts[c] = (counts[c] || 0) + 1;
  }

  const PRIORITY = ['oils', 'oil', 'spices', 'spice', 'ghee', 'soap', 'soaps'];
  return Object.entries(counts)
    .filter(([, cnt]) => cnt > 0)
    .sort(([a], [b]) => {
      const ai = PRIORITY.indexOf(a), bi = PRIORITY.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    })
    .map(([id, count], i) => ({
      index: i + 1, id,
      name:  catDisplay(id),
      emoji: catEmoji(id),
      count,
    }));
}

async function loadProductsByCategory(catId) {
  const { data, error } = await supabase
    .from('products')
    .select('id,name,cat,pack_size,pack_unit,unit,website_price,price,active,sales_count,created_at')
    .eq('active', true)
    .ilike('cat', catId)
    .order('name');

  if (error) throw new Error(`Product load failed: ${error.message}`);

  const filtered  = (data || []).filter(p => (p.website_price || p.price || 0) > 0);
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  // Mark top sellers: top 2 by sales_count (if available), else top 2 by price
  const sorted    = [...filtered].sort((a, b) =>
    (b.sales_count || b.website_price || b.price || 0) - (a.sales_count || a.website_price || a.price || 0)
  );
  const topIds    = new Set(sorted.slice(0, 2).map(p => p.id));

  return filtered.map((p, i) => ({
    id:         p.id,
    name:       p.name,
    price:      p.website_price || p.price,
    packStr:    p.pack_size ? `${p.pack_size}${p.pack_unit || p.unit || ''}` : (p.unit || ''),
    index:      i + 1,
    bestseller: topIds.has(p.id),
    isNew:      p.created_at && new Date(p.created_at).getTime() > thirtyDaysAgo,
  }));
}

// ── Cart helpers ──────────────────────────────────────────────────────────────

function cartTotal(cart) {
  return (cart || []).reduce((s, i) => s + i.price * i.qty, 0);
}

/** Visual shipping progress bar — 10 blocks */
function shippingBar(subtotal) {
  const FREE = 2500;
  if (subtotal >= FREE) return `🚚 ✨ *Free Shipping Unlocked!* 🎉`;
  const filled = Math.round(Math.min(subtotal / FREE, 1) * 10);
  const bar    = '▓'.repeat(filled) + '░'.repeat(10 - filled);
  return `🚚 \`[${bar}]\` _${inr(FREE - subtotal)} to free delivery_`;
}

/** Monospace-aligned receipt rows */
function receiptRow(label, value, bold = false) {
  const pad = 22 - label.length;
  const val = bold ? `*${value}*` : value;
  return `\`${label}${' '.repeat(Math.max(1, pad))}${value}\`` + (bold ? '' : '');
}

function cartBlock(cart, numbered = false) {
  if (!cart?.length) return '_Cart is empty_';
  const subtotal = cartTotal(cart);
  const shipping = subtotal >= 2500 ? 0 : 60;
  const lines    = cart.map((item, i) => {
    const pack   = item.packStr ? ` _${item.packStr}_` : '';
    const prefix = numbered ? `*${i + 1}.*` : '•';
    return `${prefix} ${item.name}${pack}  ×${item.qty}  *${inr(item.price * item.qty)}*`;
  }).join('\n');
  const shippingVal = shipping === 0 ? 'FREE 🎉' : inr(shipping);
  return (
    `${lines}\n` +
    `${LINE}\n` +
    `\`Subtotal        ${inr(subtotal).padStart(8)}\`\n` +
    `\`Shipping        ${shippingVal.padStart(8)}\`\n` +
    `\`${'─'.repeat(24)}\`\n` +
    `\`TOTAL           ${inr(subtotal + shipping).padStart(8)}\``
  );
}

function miniCart(cart) {
  if (!cart?.length) return '';
  const count = cart.reduce((s, i) => s + i.qty, 0);
  return `\n\n🛒 _${count} item${count !== 1 ? 's' : ''} in cart · ${inr(cartTotal(cart))}_`;
}

// ── Product search ────────────────────────────────────────────────────────────

async function searchProducts(query) {
  const q = (query || '').trim();
  if (q.length < 2) return [];
  const { data } = await supabase
    .from('products')
    .select('id,name,cat,pack_size,pack_unit,unit,website_price,price,active,sales_count')
    .eq('active', true)
    .neq('cat', 'raw')
    .ilike('name', `%${q}%`)
    .order('name')
    .limit(10);
  const filtered = (data || []).filter(p => (p.website_price || p.price || 0) > 0);
  const topIds   = new Set(
    [...filtered].sort((a, b) => (b.sales_count || 0) - (a.sales_count || 0)).slice(0, 2).map(p => p.id)
  );
  return filtered.map((p, i) => ({
    id:         p.id,
    name:       p.name,
    cat:        p.cat,
    price:      p.website_price || p.price,
    packStr:    p.pack_size ? `${p.pack_size}${p.pack_unit || p.unit || ''}` : (p.unit || ''),
    index:      i + 1,
    bestseller: topIds.has(p.id),
  }));
}

async function handleSearchStep(phone, query, session) {
  const results = await searchProducts(query);
  if (!results.length) {
    return {
      reply:
        `🔍 No products found for _"${query}"_\n\n` +
        `Try a shorter keyword, like _oil_, _soap_, _ghee_\n\n` +
        `${LINE}\nReply *1* to browse categories · *0* menu`,
      done: false,
    };
  }

  // Store search results as a temporary cat_browse-like state
  const catLike = { id: '__search__', name: `Search: "${query}"`, emoji: '🔍', products: results };
  await saveSession(phone, { ...session, step: 'cat_browse', current_cat: catLike });

  const lines = results.map(p => {
    const pack  = p.packStr ? ` _${p.packStr}_` : '';
    const badge = p.isNew ? ' ✨' : p.bestseller ? ' 🔥' : '';
    const cat   = catDisplay(p.cat);
    return `${cn(p.index)} ${p.name}${pack}${badge}  —  *${inr(p.price)}*  _[${cat}]_`;
  }).join('\n');

  return {
    reply:
      `🔍 *Results for "${query}"*\n${THICK}\n\n` +
      `${lines}\n\n` +
      `${LINE}\n` +
      `Send *number* to add  _(e.g. *2* or *2 3* for qty 2)_\n` +
      `*MENU* · *CART* · *DONE*` +
      miniCart(session.cart),
    done: false,
  };
}

// ── Input parser ──────────────────────────────────────────────────────────────

function parseSelections(text) {
  const t = text.trim().toLowerCase()
    .replace(/^add\s+/i, '').replace(/\bqty\b/gi, '').replace(/\s+/g, ' ').trim();

  const results = [];
  const parts   = t.split(',').map(s => s.trim()).filter(Boolean);

  for (const part of parts) {
    const m = part.match(/^(\d+)\s*[:\s]\s*(\d+)$/);
    if (m) { results.push({ index: parseInt(m[1], 10), qty: parseInt(m[2], 10) }); continue; }
    const single = part.match(/^(\d+)$/);
    if (single) { results.push({ index: parseInt(single[1], 10), qty: 1 }); }
  }

  if (results.length === 0 && parts.length === 1) {
    const nums = parts[0].match(/\d+/g);
    if (nums && nums.length >= 2 && nums.length % 2 === 0) {
      for (let i = 0; i < nums.length; i += 2)
        results.push({ index: parseInt(nums[i], 10), qty: parseInt(nums[i + 1], 10) });
    }
  }

  return results.length > 0 ? results : null;
}

// ── Razorpay payment link ─────────────────────────────────────────────────────

async function createRazorpayPaymentLink({ total, customerName, phone, notes }) {
  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error('Razorpay credentials not configured');

  const authHeader = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const expireBy   = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
  const digits     = (phone || '').replace(/\D/g, '');
  const contact    = digits.length === 10 ? `91${digits}` : digits;

  const body = {
    amount:          Math.round(total * 100),
    currency:        'INR',
    description:     'Sathvam Order via WhatsApp',
    customer:        { name: customerName, contact },
    notify:          { sms: false, email: false },
    reminder_enable: false,
    expire_by:       expireBy,
    notes:           { wa_phone: phone, source: 'whatsapp_order', ...notes },
  };

  const res  = await fetch('https://api.razorpay.com/v1/payment_links', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${authHeader}` },
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.id) throw new Error(`Razorpay error: ${JSON.stringify(data)}`);
  return { id: data.id, url: data.short_url || data.id };
}

// ── Order number generator ────────────────────────────────────────────────────

async function generateWaOrderNo() {
  const ist     = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const dateStr = ist.toISOString().slice(0, 10).replace(/-/g, '');
  const today   = ist.toISOString().slice(0, 10);
  const { count } = await supabase
    .from('webstore_orders')
    .select('id', { count: 'exact', head: true })
    .eq('channel', 'whatsapp').eq('date', today);
  return `SAT-${dateStr}-${String((count || 0) + 1).padStart(4, '0')}`;
}

// ── PNG confirmation sender ───────────────────────────────────────────────────

async function sendOrderConfirmationPng(phone, orderData) {
  try {
    const genRes  = await fetch(PNG_GEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'order', data: orderData }),
      signal: AbortSignal.timeout(60_000),
    });
    const genJson = await genRes.json();
    if (!genJson.ok) throw new Error(genJson.error || 'PNG generation failed');

    const instanceId = process.env.GREENAPI_INSTANCE_ID;
    const token      = process.env.GREENAPI_API_TOKEN;
    const chatId     = toChatId(phone);
    if (!chatId) throw new Error(`Invalid phone: ${phone}`);

    const form = new FormData();
    form.append('chatId',  chatId);
    form.append('caption', `🌿 *SATHVAM* | Order #${orderData.order_no}\n✅ *Order Confirmed!*\n\nThank you! We'll process your order shortly.\n\n👉 https://www.sathvam.in/orders\n\nReply anytime — Team Sathvam 🙏`);
    form.append('file', new Blob([fs.readFileSync(genJson.path)], { type: 'image/png' }), 'Sathvam_Order.png');

    const up = await fetch(
      `${GREENAPI_BASE}/waInstance${instanceId}/sendFileByUpload/${token}`,
      { method: 'POST', body: form },
    );
    const upData = await up.json();
    if (!upData.idMessage) throw new Error(`Green API error: ${JSON.stringify(upData)}`);
    return true;
  } catch (e) {
    console.error('[wa-bot] PNG send error:', e.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── BOT MESSAGES ──────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

const LINE  = '· · · · · · · · · · · · · · · ·';
const THICK = '━━━━━━━━━━━━━━━━━━━━━━━';
const STEPS = ['🟩⬜⬜', '🟩🟩⬜', '🟩🟩🟩'];

// Unicode circled numbers — render natively in WhatsApp as styled glyphs
const CIRCLE_NUM = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩','⑪','⑫','⑬','⑭','⑮'];
function cn(n) { return CIRCLE_NUM[(n - 1)] || `${n}.`; }

// Unicode mathematical sans-serif bold — renders as bold styled text in WhatsApp
// S A T H V A M  →  𝗦 𝗔 𝗧 𝗛 𝗩 𝗔 𝗠
const BRAND = '𝗦𝗔𝗧𝗛𝗩𝗔𝗠';

/** IST-aware greeting based on current hour */
function istGreeting(name) {
  const h     = new Date(Date.now() + 5.5 * 60 * 60 * 1000).getUTCHours();
  const part  = h >= 5  && h < 12 ? ['🌅', 'morning']
              : h >= 12 && h < 17 ? ['☀️',  'afternoon']
              : h >= 17 && h < 21 ? ['🌆', 'evening']
              :                     ['🌙', 'evening'];
  const first = name ? name.split(' ')[0] : null;
  return first ? `${part[0]} Good ${part[1]}, *${first}*!` : `${part[0]} Good ${part[1]}!`;
}

/** Order status step-by-step timeline */
const TIMELINE_STEPS = ['confirmed', 'packed', 'shipped', 'delivered'];
function orderTimeline(status) {
  const cur = TIMELINE_STEPS.indexOf(status);
  if (cur === -1) return '';              // cancelled / other — skip timeline
  return TIMELINE_STEPS.map((s, i) => {
    if (i < cur)  return `✅ _${STATUS_LABEL[s] || s}_`;
    if (i === cur) return `▶️ *${STATUS_LABEL[s] || s}* ◀ _now_`;
    return `⬜ ${STATUS_LABEL[s] || s}`;
  }).join('\n');
}

function inr(n) { return `₹${Number(n).toLocaleString('en-IN')}`; }

function mainMenuText(cart, name, lastOrder) {
  const isReturn      = !!lastOrder;
  const greet         = istGreeting(name);
  const welcomeLine   = isReturn ? `${greet} Welcome back! 👋` : `${greet} Welcome! 👋`;
  const lastOrderLine = lastOrder
    ? `\n_Last order: *${lastOrder.order_no}* · ${STATUS_LABEL[lastOrder.status] || lastOrder.status}_`
    : '';
  const cartBadge = (cart && cart.length)
    ? `\n\n🛒 _You have ${inr(cartTotal(cart))} worth of items in your cart_\n_Type *CART* to view_`
    : '';
  return (
    `\`╔══════════════════════════╗\`\n` +
    `\`║     S A T H V A M        ║\`\n` +
    `\`║  Way to a Healthier Life ║\`\n` +
    `\`╚══════════════════════════╝\`\n\n` +
    `${welcomeLine}${lastOrderLine}\n` +
    `How can I help you today?${cartBadge}\n\n` +
    `${THICK}\n` +
    `　${cn(1)} 🛒  Shop & Order\n` +
    `　${cn(2)} 📦  My Orders\n` +
    `　${cn(3)} 🚚  Track Package\n` +
    `　${cn(4)} 💬  Talk to Us\n` +
    `${THICK}\n\n` +
    `_Reply with a number_`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── STEP HANDLERS ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/** Show main menu */
async function showMainMenu(phone, existingCart, name) {
  const cart = existingCart || [];
  // Fetch last order for returning-customer greeting (non-blocking, best effort)
  let lastOrder = null;
  try {
    const orders = await getOrdersByPhone(phone);
    lastOrder = orders[0] || null;
  } catch { /* ignore */ }
  await saveSession(phone, { step: 'main_menu', cart, subscriber_name: name });
  return { reply: mainMenuText(cart, name, lastOrder), done: false };
}

/** Handle main_menu step — user replies 1/2/3/4 */
async function handleMainMenuStep(phone, text, session) {
  const t = text.trim();

  if (/^[*]?1[*]?$/.test(t) || /^(shop|order|buy)$/i.test(t)) {
    return startShopping(phone, session);
  }

  if (/^[*]?2[*]?$/.test(t) || /^(orders?|my orders?)$/i.test(t)) {
    const orders = await getOrdersByPhone(phone);
    if (!orders.length) {
      return {
        reply:
          `📦 *My Orders*\n${THICK}\n\n` +
          `_No orders found for this number yet._\n\n` +
          `🛒 Start your first order!\n` +
          `Reply *1* to shop now\n` +
          `or visit 🌐 https://sathvam.in\n\n` +
          `${LINE}\n_Reply *0* for main menu_`,
        done: false,
      };
    }
    const orderText = orders.map((o, i) => formatOrderCard(o, i + 1)).join('\n\n');
    return {
      reply:
        `📦 *Your Orders*\n${THICK}\n\n` +
        `${orderText}\n\n` +
        `${LINE}\n` +
        `🚚 Reply *3* to track a package\n` +
        `🏠 Reply *0* for main menu`,
      done: false,
    };
  }

  if (/^[*]?3[*]?$/.test(t) || /^track$/i.test(t)) {
    await saveSession(phone, { ...session, step: 'tracking' });
    return {
      reply:
        `🚚 *Track Your Package*\n${THICK}\n\n` +
        `Please send your *order number* 👇\n\n` +
        `📌 _Example: SAT-20260612-0001_\n\n` +
        `${LINE}\n_Reply *0* to go back_`,
      done: false,
    };
  }

  if (/^[*]?4[*]?$/.test(t) || /^(support|help|talk|human|agent)$/i.test(t)) {
    const adminPhone = (process.env.WA_ADMIN_PHONE1 || process.env.WA_NOTIFY_TO || '').replace(/\D/g, '');
    if (adminPhone) {
      await sendText(adminPhone,
        `💬 *Support Request*\nPhone: ${phone}\nTime: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\nCustomer wants to speak with the team.`,
      ).catch(() => {});
    }
    await clearSession(phone);
    return {
      reply:
        `💬 *Support Request Received!*\n${THICK}\n\n` +
        `Thank you for reaching out! 🙏\n` +
        `Our team will contact you shortly.\n\n` +
        `${LINE}\n` +
        `📧 hello@sathvam.in\n` +
        `🌐 sathvam.in\n` +
        `${LINE}\n\n` +
        `_Reply *0* anytime to return to the menu._`,
      done: true,
    };
  }

  // Unrecognised — show menu again
  return { reply: mainMenuText(session.cart, session.subscriber_name), done: false };
}

/** Start the shopping flow — show category list */
async function startShopping(phone, session) {
  const categories = await loadCategories();
  if (!categories.length) {
    return { reply: `😔 No products available right now.\n\nVisit 🌐 https://sathvam.in 🙏`, done: true };
  }

  await saveSession(phone, { ...session, step: 'cat_menu', categories });

  const catLines = categories
    .map(c => `${c.emoji}  ${cn(c.index)}  ${c.name}  _· ${c.count} items_`)
    .join('\n');

  return {
    reply:
      `🛍 *Shop by Category*\n${THICK}\n\n` +
      `${catLines}\n\n` +
      `${LINE}\n_Reply with a category number_` +
      miniCart(session.cart),
    done: false,
  };
}

/** cat_menu step — user picks a category */
async function handleCatMenuStep(phone, text, session) {
  const t = text.trim();

  if (/^cart$/i.test(t)) return showCart(phone, text, session);
  if (/^(done|checkout)$/i.test(t)) return initiateCheckout(phone, session);

  const num = parseInt(t, 10);
  const cat = (session.categories || []).find(c => c.index === num);

  if (!cat) {
    // Try treating input as a product search query (min 2 chars, not a single digit)
    if (t.length >= 2 && !/^\d+$/.test(t)) {
      return handleSearchStep(phone, t, session);
    }
    const catLines = (session.categories || []).map(c => `${c.emoji}  ${cn(c.index)}  ${c.name}`).join('\n');
    return {
      reply:
        `❓ Choose a category number:\n\n${catLines}` +
        miniCart(session.cart) +
        `\n\nReply *DONE* to checkout · *0* for menu\n_Or type a product name to search_`,
      done: false,
    };
  }

  const products = await loadProductsByCategory(cat.id);
  if (!products.length) {
    const catLines = (session.categories || []).map(c => `${c.index}. ${c.emoji} ${c.name}`).join('\n');
    return { reply: `😔 No products in *${cat.name}* right now.\n\n${catLines}`, done: false };
  }

  await saveSession(phone, { ...session, step: 'cat_browse', current_cat: { id: cat.id, name: cat.name, emoji: cat.emoji, products } });

  const hasBadges = products.some(p => p.bestseller || p.isNew);
  const lines = products
    .map(p => {
      const pack  = p.packStr ? ` _${p.packStr}_` : '';
      const badge = p.isNew ? ' ✨' : p.bestseller ? ' 🔥' : '';
      return `${cn(p.index)} ${p.name}${pack}${badge}  —  *${inr(p.price)}*`;
    })
    .join('\n');

  const legend = hasBadges
    ? `🔥 _popular_  ✨ _new arrival_\n`
    : '';

  return {
    reply:
      `${cat.emoji} *${cat.name}*\n${THICK}\n\n` +
      `${lines}\n\n` +
      `${LINE}\n` +
      `${legend}` +
      `Send *number* to add  _(e.g. *5* or *5 2* for qty 2)_\n` +
      `*MENU* · *CART* · *DONE*` +
      miniCart(session.cart),
    done: false,
  };
}

/** cat_browse step — user adds items */
async function handleCatBrowseStep(phone, text, session) {
  const t = text.trim();

  if (/^(menu|back|categories)$/i.test(t)) {
    const catLines = (session.categories || []).map(c => `${c.emoji}  ${cn(c.index)}  *${c.name}* _(${c.count} items)_`).join('\n');
    await saveSession(phone, { ...session, step: 'cat_menu', current_cat: null });
    return {
      reply:
        `🛍 *Categories*\n${LINE}\n\n${catLines}` +
        miniCart(session.cart) +
        `\n\n${LINE}\n` +
        `Reply a number to browse · *DONE* checkout · *0* menu`,
      done: false,
    };
  }

  if (/^cart$/i.test(t)) return showCart(phone, text, session);
  if (/^(done|checkout|confirm)$/i.test(t)) return initiateCheckout(phone, session);

  const products   = session.current_cat?.products || [];
  const selections = parseSelections(text);

  if (!selections) {
    const cat = session.current_cat;
    return {
      reply:
        `❓ Send *item number + qty*\n_(e.g. *1* or *2 3*)_\n\n` +
        `*MENU* — Categories · *CART* · *DONE* — Checkout` +
        (cat ? `\n\n_Browsing: ${cat.emoji} ${cat.name}_` : ''),
      done: false,
    };
  }

  const updatedCart = [...(session.cart || [])];
  const added       = [];
  const updated     = [];

  for (const sel of selections) {
    const product = products.find(p => p.index === sel.index);
    if (!product) continue;
    const qty      = Math.max(1, Math.min(sel.qty, 99));
    const existing = updatedCart.find(c => c.id === product.id);
    const label    = `${product.name}${product.packStr ? ` (${product.packStr})` : ''}`;
    if (existing) {
      existing.qty = qty;
      updated.push(`${label} ×${qty}`);
    } else {
      updatedCart.push({ id: product.id, name: product.name, price: product.price, packStr: product.packStr, qty });
      added.push(`${label} ×${qty}`);
    }
  }

  if (!added.length && !updated.length) {
    return {
      reply: `❓ Item not found. Send a valid number from the list.\n*MENU* to browse other categories.`,
      done: false,
    };
  }

  await saveSession(phone, { ...session, cart: updatedCart });

  const subtotal  = cartTotal(updatedCart);
  const cartCount = updatedCart.reduce((s, i) => s + i.qty, 0);
  const cat       = session.current_cat;

  const addedLines   = added.map(a => `　✅ ${a}`).join('\n');
  const updatedLines = updated.map(a => `　♻️ Updated: ${a}`).join('\n');
  const changeLines  = [addedLines, updatedLines].filter(Boolean).join('\n');
  const headerVerb   = added.length && updated.length ? 'Cart Updated!'
                     : updated.length ? 'Quantity Updated!'
                     : 'Added to Cart!';

  return {
    reply:
      `✅ *${headerVerb}*\n` +
      `${changeLines}\n\n` +
      `${THICK}\n` +
      `🛒 *${cartCount} item${cartCount !== 1 ? 's' : ''}*  ·  Subtotal *${inr(subtotal)}*\n` +
      `${shippingBar(subtotal)}\n` +
      `${THICK}\n\n` +
      (cat ? `_Still browsing ${cat.emoji} ${cat.name} — send another number_\n\n` : '') +
      `*MENU* · *CART* · *DONE* checkout`,
    done: false,
  };
}

/** Show full cart */
async function showCart(phone, text, session) {
  const cart = session.cart || [];
  if (!cart.length) {
    return {
      reply:
        `🛒 *Your Cart is Empty*\n${THICK}\n\n` +
        `_Nothing added yet!_\n\n` +
        `Reply *1* to start shopping\n` +
        `Reply *0* for main menu`,
      done: false,
    };
  }
  return {
    reply:
      `🛒 *Your Cart*\n${THICK}\n\n` +
      `${cartBlock(cart, true)}\n\n` +
      `${LINE}\n` +
      `✅ *DONE* — Checkout\n` +
      `➕ *MENU* — Add more items\n` +
      `🗑 *REMOVE 1* — Remove item 1\n` +
      `🏠 *0* — Main menu`,
    done: false,
  };
}

/** Initiate checkout from any shopping step */
async function initiateCheckout(phone, session) {
  const cart = session.cart || [];
  if (!cart.length) {
    return { reply: `🛒 Cart is empty! Browse categories first.\nReply *MENU* to browse.`, done: false };
  }

  // Check if registered customer has a saved address
  const regCustomer = await getRegisteredCustomer(phone);
  if (regCustomer) {
    const { name, address, city, state, pincode } = regCustomer;
    const fullAddress = [address, city, state, pincode].filter(Boolean).join(', ');
    await saveSession(phone, {
      ...session,
      step: 'confirm_address',
      customer_name: name,
      saved_address: fullAddress,
    });
    return {
      reply:
        `🧾 *Your Order*\n${THICK}\n\n` +
        `${cartBlock(cart, true)}\n\n` +
        `${THICK}\n` +
        `${STEPS[0]}  _Checkout_\n` +
        `${LINE}\n\n` +
        `👤 *${name}*\n` +
        `📍 _${fullAddress}_\n\n` +
        `Is this address correct?\n` +
        `✅ Reply *YES* to confirm\n` +
        `✏️ Reply *CHANGE* to enter a new address`,
      done: false,
    };
  }

  await saveSession(phone, { ...session, step: 'address_name' });
  return {
    reply:
      `🧾 *Your Order*\n${THICK}\n\n` +
      `${cartBlock(cart, true)}\n\n` +
      `${THICK}\n` +
      `${STEPS[0]}  _Step 1 of 3: Your Name_\n` +
      `${LINE}\n\n` +
      `👤 Please reply with your *full name*:`,
    done: false,
  };
}

/** confirm_address step — registered customer confirms or changes their saved address */
async function handleConfirmAddressStep(phone, text, session) {
  const t = text.trim();

  if (/^(yes|y|ok|confirm|correct|✅)$/i.test(t)) {
    // Use saved address — go straight to payment
    return handleAddressTextStep(phone, session.saved_address, {
      ...session,
      step: 'address_text',
    });
  }

  if (/^(no|change|edit|new|update|✏️)$/i.test(t)) {
    // Clear saved address, restart from name
    await saveSession(phone, { ...session, step: 'address_name', saved_address: null, customer_name: null });
    const cart = session.cart || [];
    return {
      reply:
        `🧾 *Your Order*\n${THICK}\n\n` +
        `${cartBlock(cart, true)}\n\n` +
        `${THICK}\n` +
        `${STEPS[0]}  _Step 1 of 3: Your Name_\n` +
        `${LINE}\n\n` +
        `👤 Please reply with your *full name*:`,
      done: false,
    };
  }

  // Unrecognised — re-prompt
  return {
    reply:
      `👤 *${session.customer_name}*\n` +
      `📍 _${session.saved_address}_\n\n` +
      `Is this address correct?\n` +
      `✅ Reply *YES* to confirm\n` +
      `✏️ Reply *CHANGE* to enter a new address`,
    done: false,
  };
}

/** tracking step */
async function handleTrackingStep(phone, text, session) {
  const t = text.trim();
  const orderNoMatch = t.match(/\b(SAT-\d{8}-\d{4})\b/i);

  if (!orderNoMatch) {
    return {
      reply:
        `🔍 Please send a valid *order number*\n` +
        `_(Example: SAT-20260612-0001)_\n\n` +
        `Reply *2* to see all orders · *0* for menu`,
      done: false,
    };
  }

  const order = await lookupOrderNo(orderNoMatch[1], phone);
  if (!order) {
    return {
      reply:
        `❌ Order *${orderNoMatch[1]}* not found or doesn't match this number.\n\n` +
        `Reply *2* to see your orders · *0* for menu`,
      done: false,
    };
  }

  const statusLabel = STATUS_LABEL[order.status] || order.status;
  const date        = order.date || '';
  const timeline    = orderTimeline(order.status);
  const timelineBlock = timeline
    ? `\n${LINE}\n*Order Journey*\n${timeline}\n`
    : '';
  const trackBlock = order.tracking_no
    ? `\n${LINE}\n🚚 *Courier Tracking*\n_${order.courier || 'Courier'}_: *${order.tracking_no}*\n`
    : '';

  await clearSession(phone);
  return {
    reply:
      `📦 *${order.order_no}*\n${THICK}\n\n` +
      `\`Date   : ${date}\`\n` +
      `\`Total  : ${inr(Number(order.total))}\`\n` +
      `\`Status : ${statusLabel}\`` +
      `${timelineBlock}` +
      `${trackBlock}` +
      `\n${LINE}\n` +
      `🛒 Reply *1* to shop again\n` +
      `🏠 Reply *0* for main menu`,
    done: false,
  };
}

/** address_name step */
async function handleAddressNameStep(phone, text, session) {
  const name = text.trim();
  if (name.length < 2) {
    return { reply: `👤 Please reply with your *full name*:`, done: false };
  }
  await saveSession(phone, { ...session, step: 'address_text', customer_name: name });
  return {
    reply:
      `✅ *Hi ${name.split(' ')[0]}!*\n\n` +
      `${THICK}\n` +
      `${STEPS[1]}  _Step 2 of 3: Delivery Address_\n` +
      `${LINE}\n\n` +
      `📍 Send your *complete delivery address:*\n` +
      `_House no, Street, Area, City, State, PIN_\n\n` +
      `📌 Example:\n_12 MG Road, T Nagar\nChennai, Tamil Nadu 600017_`,
    done: false,
  };
}

/** address_text step */
async function handleAddressTextStep(phone, text, session) {
  const address = text.trim();
  if (address.length < 10) {
    return {
      reply: `📍 Please send your *complete delivery address*:\n_House no, Street, City, State, Pincode_`,
      done: false,
    };
  }

  const subtotal   = cartTotal(session.cart || []);
  const shipping   = subtotal >= 2500 ? 0 : 60;
  const grandTotal = subtotal + shipping;

  let paymentLink;
  try {
    paymentLink = await createRazorpayPaymentLink({
      total:        grandTotal,
      customerName: session.customer_name,
      phone,
      notes:        { address },
    });
  } catch (e) {
    console.error('[wa-bot] Payment link error:', e.message);
    return {
      reply: `❌ Something went wrong creating your payment link. Please try again or order at https://sathvam.in`,
      done:  true,
    };
  }

  await saveSession(phone, {
    ...session, step: 'payment_pending', address,
    payment_link_id:  paymentLink.id,
    payment_link_url: paymentLink.url,
  });

  return {
    reply:
      `${THICK}\n` +
      `${STEPS[2]}  _Step 3 of 3: Payment_\n` +
      `${THICK}\n\n` +
      `${cartBlock(session.cart, true)}\n\n` +
      `${LINE}\n` +
      `👤 *${session.customer_name}*\n` +
      `📍 _${address}_\n` +
      `${THICK}\n\n` +
      `╔══════════════════════╗\n` +
      `  💳 *TAP TO PAY NOW*\n` +
      `  👉 ${paymentLink.url}\n` +
      `╚══════════════════════╝\n\n` +
      `\`Amount Due: ${inr(grandTotal).padStart(10)}\`\n\n` +
      `⏰ _Link expires in 24 hours_\n` +
      `⚡ _Order confirmed instantly after payment_\n\n` +
      `_Reply *CANCEL* to cancel_`,
    done: false,
  };
}

/** payment_pending step */
async function handlePaymentPendingStep(phone, text, session) {
  if (/^(cancel)$/i.test(text.trim())) {
    await clearSession(phone);
    return { reply: `✅ Order cancelled.\n\nReply *0* to return to the main menu anytime 🙏`, done: true };
  }

  const subtotal   = cartTotal(session.cart || []);
  const shipping   = subtotal >= 2500 ? 0 : 60;
  const grandTotal = subtotal + shipping;

  return {
    reply:
      `⏳ *Payment Pending*\n${THICK}\n\n` +
      `\`Amount Due: ${inr(grandTotal).padStart(10)}\`\n\n` +
      `╔══════════════════════╗\n` +
      `  💳 *TAP TO PAY NOW*\n` +
      `  👉 ${session.payment_link_url || 'unavailable'}\n` +
      `╚══════════════════════╝\n\n` +
      `⚡ _Order confirmed instantly after payment_\n\n` +
      `Reply *CANCEL* to cancel`,
    done: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ── MAIN ENTRY POINT ──────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/**
 * handleBotMessage — called from botsailor webhook for every incoming WhatsApp message.
 *
 * Returns { reply: string|null, done: boolean }
 *   reply = null  → not handled, fall through to AI
 *   reply = string → send this reply, stop processing
 */
async function handleBotMessage(phone, text, subscriberName) {
  const t = (text || '').trim();
  const tU = t.toUpperCase();

  // ── Global triggers — always work regardless of session ──────────────────

  // Back to main menu
  if (/^(0|menu|home|start|main)$/i.test(t)) {
    const session = await loadSession(phone);
    return showMainMenu(phone, session?.cart, subscriberName || session?.subscriber_name);
  }

  // Greeting → main menu
  if (/^(hi|hello|hey|hii|helo|வணக்கம்|ஹலோ|namaste)$/i.test(t)) {
    const session = await loadSession(phone);
    return showMainMenu(phone, session?.cart, subscriberName || session?.subscriber_name);
  }

  // ORDER/BUY shortcut — jump straight to shopping
  if (/^(order|buy|shop|ஆர்டர்)$/i.test(t)) {
    const session = await loadSession(phone);
    return startShopping(phone, session || { cart: [] });
  }

  // CART from anywhere (if session exists)
  if (/^cart$/i.test(t)) {
    const session = await loadSession(phone);
    if (session) return showCart(phone, t, session);
  }

  // ABOUT / STORY — brand story in English + Tamil
  if (/^(about|story|who are you|sathvam\??)$/i.test(t)) {
    return {
      reply:
        `\`╔══════════════════════════╗\`\n` +
        `\`║     S A T H V A M        ║\`\n` +
        `\`║  Way to a Healthier Life ║\`\n` +
        `\`╚══════════════════════════╝\`\n\n` +

        `🌿 *Our Story*\n` +
        `_Pure. Natural. From Our Factory to Your Home._\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Founded in *Karur, Tamil Nadu* — we started Sathvam because we were tired of refined, chemical-laden oils that look pretty but taste of nothing. We went back to the wooden press, to stone-ground spices, to sun-dried millets. That's Sathvam. 🌿\n\n` +
        `*Our Philosophy*\n` +
        `No shortcuts. No chemicals. No compromises. We believe food should be as close to nature as possible — and we work every day to make that happen.\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +

        `🌿 *எங்கள் கதை*\n` +
        `_பாரம்பரிய இயற்கை வழியை மீட்டெடுக்கிறோம்_\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `கரூர், தமிழ்நாட்டில் தொடங்கப்பட்ட *சத்துவம்* — பதப்படுத்தப்பட்ட, ரசாயனம் நிறைந்த எண்ணெய்களிலிருந்து விலகி, *மரவட்டில் ஆட்டிய தூய எண்ணெய்*, *கல்லில் அரைத்த மசாலா*, *வெயிலில் உலர்த்திய தானியங்களுக்குத்* திரும்பினோம். அதுவே சத்துவம். 🌿\n\n` +
        `*எங்கள் தத்துவம்*\n` +
        `குறுக்கு வழிகள் இல்லை. ரசாயனங்கள் இல்லை. சமரசங்கள் இல்லை. உணவு இயற்கையோடு நெருங்கி இருக்க வேண்டும் என்று நம்புகிறோம்.\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🌐 sathvam.in\n` +
        `_Reply *0* for main menu_`,
      done: false,
    };
  }

  // SEARCH <query> — search products by name from anywhere
  const searchMatch = t.match(/^(?:search|find|s)\s+(.+)$/i);
  if (searchMatch) {
    const session = await loadSession(phone);
    return handleSearchStep(phone, searchMatch[1].trim(), session || { cart: [] });
  }

  // REMOVE <n> — remove item n from cart (works from any shopping step)
  const removeMatch = t.match(/^(?:remove|del|delete|rm)\s+(\d+)$/i);
  if (removeMatch) {
    const session = await loadSession(phone);
    if (session && session.cart && session.cart.length) {
      const idx  = parseInt(removeMatch[1], 10) - 1; // 1-based to 0-based
      const cart = session.cart || [];
      if (idx >= 0 && idx < cart.length) {
        const removed    = cart[idx];
        const updatedCart = cart.filter((_, i) => i !== idx);
        await saveSession(phone, { ...session, cart: updatedCart });
        const cartNote = updatedCart.length
          ? `\n\n${cartBlock(updatedCart, true)}\n\n${LINE}\n✅ *DONE* · *MENU* · *REMOVE n* · *0* menu`
          : `\n\n_Your cart is now empty._\nReply *MENU* to keep shopping.`;
        return {
          reply: `🗑 *Removed:* ${removed.name}${cartNote}`,
          done: false,
        };
      } else {
        return {
          reply: `❓ Item *${removeMatch[1]}* not found.\n\nType *CART* to see your cart with item numbers.`,
          done: false,
        };
      }
    }
  }

  // ── Load active session ──────────────────────────────────────────────────

  const session = await loadSession(phone);
  if (!session) {
    // No session — only respond to known keywords, else fall through to AI
    return { reply: null, done: false };
  }

  // ── Cancel from any step ─────────────────────────────────────────────────
  if (/^cancel$/i.test(t) && session.step !== 'payment_pending') {
    await clearSession(phone);
    return { reply: `✅ Cancelled.\n\nReply *0* for the main menu anytime 🙏`, done: true };
  }

  // ── Route by step ────────────────────────────────────────────────────────
  switch (session.step) {
    case 'main_menu':
      return handleMainMenuStep(phone, t, session);

    case 'cat_menu':
      return handleCatMenuStep(phone, t, session);

    case 'cat_browse':
      return handleCatBrowseStep(phone, t, session);

    case 'tracking':
      return handleTrackingStep(phone, t, session);

    case 'confirm_address':
      return handleConfirmAddressStep(phone, t, session);

    case 'address_name':
      if (/^cancel$/i.test(t)) {
        await clearSession(phone);
        return { reply: `✅ Order cancelled. Reply *0* for the main menu 🙏`, done: true };
      }
      return handleAddressNameStep(phone, t, session);

    case 'address_text':
      if (/^cancel$/i.test(t)) {
        await clearSession(phone);
        return { reply: `✅ Order cancelled. Reply *0* for the main menu 🙏`, done: true };
      }
      return handleAddressTextStep(phone, t, session);

    case 'payment_pending':
      return handlePaymentPendingStep(phone, t, session);

    // Legacy step from old version — restart
    case 'selecting':
      return startShopping(phone, session);

    default:
      await clearSession(phone);
      return { reply: null, done: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── PAYMENT WEBHOOK ───────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

/**
 * handlePaymentLinkPaid — called from payments.js when payment_link.paid fires.
 * Finds WA session by payment_link_id, creates order, sends PNG + texts, notifies admin.
 */
async function handlePaymentLinkPaid(paymentLinkId, razorpayPaymentId) {
  if (!paymentLinkId) return;

  // Search both new and legacy session keys
  const { data: sessions } = await supabase
    .from('settings')
    .select('key, value')
    .or('key.like.wa_bot_session_%,key.like.wa_order_session_%');

  const matchedRow = (sessions || []).find(r => r.value?.payment_link_id === paymentLinkId);
  if (!matchedRow) {
    console.log(`[wa-bot] No WA session for payment link ${paymentLinkId}`);
    return;
  }

  const phone   = matchedRow.key.replace(/wa_(bot|order)_session_/, '');
  const session = matchedRow.value;
  const cart    = session.cart || [];

  const orderNo   = await generateWaOrderNo();
  const subtotal  = cartTotal(cart);
  const gstAmount = Math.round(subtotal * 0.05 * 100) / 100;
  const shipping  = subtotal >= 2500 ? 0 : 60;
  const total     = subtotal + gstAmount + shipping;

  const ist     = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const dateStr = ist.toISOString().slice(0, 10);

  const customer = { name: session.customer_name || '', phone, address: session.address || '' };
  const items    = cart.map(item => ({
    product_id: item.id,
    name:       item.name,
    qty:        item.qty,
    unit:       item.packStr || '',
    price:      item.price,
    gst:        5,
  }));

  const { error: insertErr } = await supabase
    .from('webstore_orders')
    .insert({
      id:             crypto.randomUUID(),
      order_no:       orderNo,
      date:           dateStr,
      customer,
      items,
      subtotal,
      gst:            gstAmount,
      shipping,
      total,
      payment_id:     razorpayPaymentId,
      payment_status: 'paid',
      status:         'confirmed',
      channel:        'whatsapp',
      notes:          'WhatsApp Order',
    });

  if (insertErr) {
    console.error('[wa-bot] Order insert error:', insertErr.message);
    throw insertErr;
  }

  console.log(`[wa-bot] Order created: ${orderNo} for ${phone}`);

  // Send PNG confirmation
  await sendOrderConfirmationPng(phone, {
    name:       customer.name,
    order_no:   orderNo,
    status:     'confirmed',
    items:      cart.map(i => ({ product: `${i.name} ${i.packStr}`.trim(), qty: i.qty })),
    cart_value: total,
  });

  // Plain text fallback
  const cartSummary = cart.map(i => `• ${i.name}${i.packStr ? ` (${i.packStr})` : ''} ×${i.qty}`).join('\n');
  await sendText(phone,
    `✅ *Order Confirmed!* 🎉\n\n` +
    `Order: *${orderNo}*\n\n` +
    `${cartSummary}\n\n` +
    `💰 Total Paid: ₹${total.toLocaleString('en-IN')}\n` +
    `📍 Deliver to: ${customer.address}\n\n` +
    `We'll pack and ship your order soon!\n` +
    `Track at: https://sathvam.in/orders\n\n` +
    `Reply *0* for the main menu 🙏`,
  );

  // Admin notification
  const adminPhone = (process.env.WA_ADMIN_PHONE1 || process.env.WA_NOTIFY_TO || '').replace(/\D/g, '');
  if (adminPhone) {
    await sendText(adminPhone,
      `🛍 *New WhatsApp Order!*\n\n` +
      `Order: *${orderNo}*\n` +
      `Customer: ${customer.name} (${phone})\n` +
      `Address: ${customer.address}\n\n` +
      `${cartSummary}\n\n` +
      `💰 Total: ₹${total.toLocaleString('en-IN')}\n` +
      `Payment: ${razorpayPaymentId}`,
    );
  }

  await clearSession(phone);
  await clearLegacySession(phone);
}

module.exports = { handleBotMessage, handlePaymentLinkPaid };
