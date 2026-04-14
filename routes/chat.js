const express   = require('express');
const router    = express.Router();
const supabase  = require('../config/supabase');
const rateLimit = require('express-rate-limit');

// Strict rate limit: 20 messages per 10 minutes per IP
const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages. Please wait a few minutes.' },
  validate: { xForwardedForHeader: false },
});

// ── Fetch live products + prices + stock from DB ──────────────────────────────
async function getLiveContext() {
  try {
    const [{ data: products }, { data: stockData }, { data: enabledSettings }] = await Promise.all([
      supabase.from('products')
        .select('id,name,cat,unit,pack_size,pack_unit,gst,website_price,price,active,health_benefits,certifications,description')
        .eq('active', true)
        .order('name'),
      supabase.from('stock_ledger').select('product_id,type,qty'),
      supabase.from('settings').select('value').eq('key', 'website_enabled_products').single(),
    ]);

    // Compute stock per product
    const stock = {};
    for (const row of stockData || []) {
      const id = row.product_id;
      if (!stock[id]) stock[id] = 0;
      stock[id] += row.type === 'in' ? (+row.qty || 0) : -(+row.qty || 0);
    }
    for (const id of Object.keys(stock)) if (stock[id] < 0) stock[id] = 0;

    // Filter website-enabled products
    const rawEnabled = enabledSettings?.value;
    const enabledArr = Array.isArray(rawEnabled) ? rawEnabled : (Array.isArray(rawEnabled?.value) ? rawEnabled.value : []);
    const enabledSet = new Set(enabledArr);
    const websiteProds = (products || []).filter(p =>
      p.cat !== 'raw' && (enabledSet.size === 0 || enabledSet.has(p.id)) && (p.website_price || p.price) > 0
    );

    // Build product lines for prompt
    const lines = websiteProds.map(p => {
      const price = p.website_price || p.price;
      const packStr = p.pack_size ? `${p.pack_size}${p.pack_unit || p.unit}` : p.unit;
      const qty = stock[p.id] ?? 0;
      const stockStr = qty > 10 ? 'In Stock' : qty > 0 ? `Only ${qty} left` : 'Out of Stock';
      const benefits = Array.isArray(p.health_benefits) && p.health_benefits.length ? ` | Benefits: ${p.health_benefits.slice(0,3).join(', ')}` : '';
      const certs = Array.isArray(p.certifications) && p.certifications.length ? ` | ${p.certifications.join('/')}` : '';
      return `  - ${p.name} | ${packStr} | ₹${price} (+${p.gst||0}% GST) | ${stockStr}${benefits}${certs}`;
    });

    return lines.join('\n');
  } catch (e) {
    console.error('getLiveContext error:', e.message);
    return '  (product data temporarily unavailable)';
  }
}

// ── Save lead to DB ───────────────────────────────────────────────────────────
async function saveLead(name, phone, email) {
  try {
    await supabase.from('chat_leads').insert({ name, phone, email: email || null, created_at: new Date().toISOString() });
  } catch (e) {
    // Table may not exist yet — log and continue
    console.warn('chat_leads save skipped:', e.message);
  }
}

// ── Order lookup ──────────────────────────────────────────────────────────────
async function lookupOrder(orderNo, phone) {
  try {
    const { data, error } = await supabase
      .from('webstore_orders')
      .select('id,order_no,status,delivered_date,items,customer,created_at')
      .ilike('order_no', orderNo.trim())
      .maybeSingle();
    if (error || !data) return null;
    const orderPhone = (data.customer?.phone || '').replace(/\D/g,'');
    const inputPhone = phone.trim().replace(/\D/g,'');
    if (inputPhone.length >= 10 && !orderPhone.endsWith(inputPhone.slice(-10))) return null;
    return data;
  } catch (e) { console.error('lookupOrder error:', e.message); return null; }
}

// ── Fetch active coupons ──────────────────────────────────────────────────────
async function getActiveCoupons() {
  try {
    const now = new Date().toISOString();
    const { data } = await supabase
      .from('coupons')
      .select('code,type,value,min_order,description,expires_at')
      .eq('active', true)
      .limit(5);
    return (data || []).filter(c => !c.expires_at || new Date(c.expires_at) > new Date());
  } catch (e) { return []; }
}

// ── Save stock alert ──────────────────────────────────────────────────────────
async function saveStockAlert(phone, productName, name) {
  try {
    await supabase.from('stock_alerts').insert({
      phone, product_name: productName, customer_name: name || '',
      created_at: new Date().toISOString(),
    });
  } catch (e) { console.warn('stock_alerts save skipped:', e.message); }
}

// ── Extract order number from messages ───────────────────────────────────────
function extractOrderNo(messages) {
  const text = messages.filter(m => m.role === 'user').map(m => m.content).join(' ');
  const m = text.match(/\b([A-Z]{2,6}-\d{3,})\b/i) || text.match(/\b(ORD\d+|SALE\d+|WS\d+|SW\d+)\b/i);
  return m ? m[1].toUpperCase() : null;
}

// ── Extract phone from messages ───────────────────────────────────────────────
function extractPhone(messages, lead) {
  if (lead?.phone) return lead.phone;
  const text = messages.filter(m => m.role === 'user').map(m => m.content).join(' ');
  const m = text.match(/(?:\+91[\s-]?)?([6-9]\d{9})\b/);
  return m ? m[1] : null;
}

// ── Detect intents ────────────────────────────────────────────────────────────
function detectCouponIntent(messages) {
  const t = (messages.slice(-2).map(m => m.content).join(' ')).toLowerCase();
  return /offer|discount|coupon|promo|code|deal|cashback|save/.test(t);
}
function detectB2BIntent(messages) {
  const t = messages.map(m => m.content).join(' ');
  return /\b(bulk|wholesale|distributor|reseller|b2b|business order|\d{2,}\s*(kg|l|litre|liter|units|bottles|pcs))\b/i.test(t);
}
function detectOOSInterest(messages) {
  const bots = messages.filter(m => m.role === 'assistant');
  const lastBot = bots.slice(-1)[0]?.content || '';
  const lastUser = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
  return /out of stock|not available|unavailable/i.test(lastBot) &&
         /notify|alert|inform|when.*available|back.*stock|still want|interested/i.test(lastUser);
}
function detectOrderIntent(messages) {
  const t = messages.map(m => m.content).join(' ');
  return /track|where.*order|order.*status|delivery.*status|when.*deliver|dispatch|shipped|out for delivery|my order/i.test(t);
}

// ── Sensitive data detection — block BEFORE sending to AI ────────────────────
const SENSITIVE_PATTERNS = [
  { re: /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/, label: 'card number' },
  { re: /\bcvv\b|\bcvc\b|\bsecurity\s*code\b/i,            label: 'CVV/security code' },
  { re: /\b\d{3,4}\s*(?:is\s+my\s+)?(cvv|cvc|pin)\b/i,   label: 'CVV/PIN' },
  { re: /\botp\b.*\d{4,8}|\d{4,8}.*\botp\b/i,             label: 'OTP' },
  { re: /\bnet\s*banking\s*(id|password|login|user)/i,     label: 'NetBanking credentials' },
  { re: /\b(account\s*no|acc\s*no|account\s*number)\s*:?\s*\d{9,18}\b/i, label: 'bank account number' },
  { re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/,                       label: 'IFSC code' },
  { re: /\bmy\s+(password|pin)\s+(is|:)\s*\S+/i,           label: 'password/PIN' },
];

function detectSensitiveData(text) {
  for (const { re, label } of SENSITIVE_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

// ── Issue keyword detection ───────────────────────────────────────────────────
const ISSUE_PATTERNS = [
  /can'?t\s+(order|checkout|buy|add|place|pay|complete)/i,
  /not\s+working|doesn'?t\s+work|won'?t\s+work/i,
  /payment\s*(failed|error|problem|issue|not\s+going)/i,
  /checkout\s*(error|problem|issue|not\s+working|failed)/i,
  /order\s*(error|problem|issue|failed|not\s+placed)/i,
  /error|something\s+went\s+wrong/i,
  /page\s*(not\s+loading|blank|broken|white)/i,
  /பிரச்சனை|வேலை\s*செய்யவில்லை|ஆர்டர்\s*போகவில்லை/i,
];
function detectIssue(msgs) {
  const userText = msgs.filter(m => m.role === 'user').map(m => m.content).join(' ');
  for (const p of ISSUE_PATTERNS) if (p.test(userText)) return p.source.slice(0, 80);
  return null;
}

// ── Pincode helpers ───────────────────────────────────────────────────────────
function extractPincode(messages) {
  const text = messages.filter(m => m.role === 'user').map(m => m.content).join(' ');
  const m = text.match(/\b([1-9]\d{5})\b/);
  return m ? m[1] : null;
}
function detectPincodeIntent(messages) {
  const t = messages.slice(-3).map(m => m.content).join(' ').toLowerCase();
  return /deliver|ship.*to|pincode|pin code|available.*area|serviceable|my.*area|reach/.test(t) && /\d{6}/.test(t);
}

// ── Save / update chat session ────────────────────────────────────────────────
async function saveSession(sessionId, lead, messages, hasIssue, issueType) {
  try {
    const { data: existing } = await supabase.from('chat_sessions').select('id,has_issue').eq('session_id', sessionId).maybeSingle();
    const payload = {
      session_id: sessionId,
      lead_name:  lead?.name  || '',
      lead_phone: lead?.phone || '',
      lead_email: lead?.email || '',
      messages,
      has_issue:  hasIssue,
      issue_type: issueType || '',
      updated_at: new Date().toISOString(),
    };
    if (existing) {
      await supabase.from('chat_sessions').update(payload).eq('session_id', sessionId);
      return { isNew: false, wasIssue: existing.has_issue };
    } else {
      await supabase.from('chat_sessions').insert({ ...payload, status: 'open' });
      return { isNew: true, wasIssue: false };
    }
  } catch (e) { console.warn('chat_sessions save skipped:', e.message); return { isNew: false, wasIssue: false }; }
}

// ── Send issue alert email ────────────────────────────────────────────────────
async function sendIssueAlert(lead, messages, issueType) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  try {
    const nodemailer = require('nodemailer');
    const mailer = nodemailer.createTransport({ host: process.env.SMTP_HOST||'smtp.gmail.com', port: parseInt(process.env.SMTP_PORT||'587'), secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
    const chatHtml = messages.slice(-6).map(m => `<tr><td style="padding:6px 10px;color:${m.role==='user'?'#1f2937':'#6b7280'};font-weight:${m.role==='user'?600:400}">${m.role==='user'?'👤 Customer':'🤖 Bot'}</td><td style="padding:6px 10px">${String(m.content).replace(/</g,'&lt;')}</td></tr>`).join('');
    await mailer.sendMail({
      from: process.env.SMTP_FROM || 'Sathvam <noreply@sathvam.in>',
      to: 'vinoth@sathvam.in',
      subject: `⚠️ Customer issue detected — ${lead?.name || 'Unknown'} (${lead?.phone || '—'})`,
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <div style="background:#dc2626;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0">
          <h2 style="margin:0">⚠️ Customer Ordering Issue</h2>
        </div>
        <div style="border:1px solid #fca5a5;border-top:none;padding:20px 24px;border-radius:0 0 8px 8px">
          <p><strong>Customer:</strong> ${lead?.name||'Not provided'}<br>
          <strong>Phone:</strong> ${lead?.phone||'—'}<br>
          <strong>Issue detected:</strong> <span style="color:#dc2626">${issueType||'ordering problem'}</span></p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px">
            <tr style="background:#f5f5f5"><th style="padding:6px 10px;text-align:left">From</th><th style="padding:6px 10px;text-align:left">Message</th></tr>
            ${chatHtml}
          </table>
          <p style="margin-top:16px;color:#6b7280;font-size:12px">View full conversation in admin → Webstore → Customer Chats</p>
        </div>
      </div>`,
    });
  } catch (e) { console.warn('Issue alert email failed:', e.message); }
}

// ── Build cart / page / pincode context strings ───────────────────────────────
function buildCartContext(cart) {
  if (!Array.isArray(cart) || !cart.length) return '';
  const total = cart.reduce((s, i) => s + (parseFloat(i.price)||0)*(i.qty||1), 0);
  const lines = cart.map(i => `  - ${i.name} × ${i.qty||1} = ₹${Math.round((i.price||0)*(i.qty||1))}`).join('\n');
  const delivery = total >= 2500 ? '✅ Qualifies for FREE delivery!' : `💡 ₹${Math.round(2500-total)} more = FREE delivery!`;
  return `\nCUSTOMER'S CART (${cart.length} item${cart.length>1?'s':''}, ₹${Math.round(total)}):\n${lines}\n  ${delivery}`;
}

function buildPageContext(prod) {
  if (!prod) return '';
  const price = prod.websitePrice || prod.website_price || prod.price || 0;
  const pack = prod.packSize ? `${prod.packSize}${prod.packUnit||prod.pack_unit||''}` : (prod.pack_unit||prod.unit||'');
  const hb = Array.isArray(prod.healthBenefits||prod.health_benefits) ? (prod.healthBenefits||prod.health_benefits).slice(0,3).join(', ') : '';
  const certs = Array.isArray(prod.certifications) && prod.certifications.length ? ` | ${prod.certifications.join('/')}` : '';
  return `\nCUSTOMER IS VIEWING: ${prod.name}${pack?' ('+pack+')':''} — ₹${price}${certs}${hb?' | Benefits: '+hb:''}`;
}

function buildPincodeContext(messages) {
  if (!detectPincodeIntent(messages)) return '';
  const pin = extractPincode(messages);
  if (!pin) return '';
  const prefix = parseInt(pin.slice(0,2));
  const tnPrefix = [60,61,62,63,64].includes(prefix);
  return `\nDELIVERY INFO for pincode ${pin}: Sathvam ships pan-India via courier. ${tnPrefix ? 'Tamil Nadu — 1-2 business days.' : '3-5 business days.'} Free delivery on orders above ₹2500.`;
}

// ── POST /api/chat ────────────────────────────────────────────────────────────
router.post('/', chatLimiter, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Service unavailable' });

  const { messages, lead, sessionId, cart, currentProduct } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'No messages provided' });
  }

  // ── Hard block: sensitive data in last user message ─────────────────────────
  const lastUserText = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
  const sensitiveType = detectSensitiveData(lastUserText);
  if (sensitiveType) {
    return res.json({
      reply: `🔒 Please never share ${sensitiveType} here — chat is not a secure channel for payment details!\n\nFor your safety, all payments are handled securely through our checkout page (Razorpay bank-grade encryption). Go to sathvam.in → Shop → Add to cart → Checkout to pay safely.\n\nIf you need help placing the order, WhatsApp us at +91 70921 77092 and we will assist you.`,
      showWhatsApp: true,
      showB2B: false,
      prefillText: 'Hi Sathvam, I need help placing an order',
      orderFound: false,
      securityWarning: true,
    });
  }

  // Save lead on first message
  if (lead?.name && lead?.phone) {
    await saveLead(lead.name, lead.phone, lead.email);
  }

  // Build system prompt with live data
  const productContext = await getLiveContext();
  const cartContext    = buildCartContext(cart);
  const pageContext    = buildPageContext(currentProduct);
  const pincodeCtx    = buildPincodeContext(messages);

  // ── Build order context ────────────────────────────────────────────────────
  let orderContext = '';
  const isOrderIntent = detectOrderIntent(messages);
  if (isOrderIntent) {
    const orderNo = extractOrderNo(messages);
    const phone   = extractPhone(messages, lead);
    if (orderNo && phone) {
      const order = await lookupOrder(orderNo, phone);
      if (order) {
        const items = (order.items || []).map(i => `${i.qty}x ${i.productName||i.name}`).join(', ');
        orderContext = `\nORDER FOUND:
Order No: ${order.order_no}
Status: ${order.status?.toUpperCase()}
Items: ${items}
${order.delivered_date ? 'Delivered on: ' + order.delivered_date : ''}
${order.created_at ? 'Ordered on: ' + new Date(order.created_at).toLocaleDateString('en-IN') : ''}`;
      } else if (orderNo) {
        orderContext = `\nORDER LOOKUP: Order "${orderNo}" not found or phone doesn't match.`;
      }
    }
  }

  // ── Build coupon context ───────────────────────────────────────────────────
  let couponContext = '';
  if (detectCouponIntent(messages)) {
    const coupons = await getActiveCoupons();
    if (coupons.length > 0) {
      couponContext = 'ACTIVE OFFERS:\n' + coupons.map(c => {
        const disc = c.type === 'percent' ? `${c.value}% off` : `₹${c.value} off`;
        const min  = c.min_order > 0 ? ` on orders above ₹${c.min_order}` : '';
        const desc = c.description ? ` (${c.description})` : '';
        return `→ Code: ${c.code} — ${disc}${min}${desc}`;
      }).join('\n');
    } else {
      couponContext = 'No active coupon codes right now. Check back soon or follow us on Instagram @sathvam.in for offers!';
    }
  }

  const systemPrompt = `You are Sathvam's friendly AI sales assistant on www.sathvam.in.
Sathvam Natural Products — factory-direct from Karur, Tamil Nadu. Cold pressed oils, millets, spices. 100% natural, zero chemicals.
Be warm, concise, action-focused. Max 4 lines per reply. If customer writes in Tamil, reply ONLY in Tamil.

FORMATTING — plain text chat only, no markdown:
- No **, no *, no #, no tables, no dashes. Use → for lists.

━━━━ LIVE PRODUCTS (name | pack | price | stock | benefits) ━━━━
${productContext}
${orderContext}
${couponContext}
${cartContext}
${pageContext}
${pincodeCtx}

━━━━ SECURITY — ABSOLUTE RULES (never break these) ━━━━
NEVER ask for or accept in chat:
→ Card number, CVV, expiry date, OTP
→ UPI PIN, NetBanking password or login
→ Bank account number, IFSC code
→ Any payment credentials of any kind
→ Full home address (city/state is OK for delivery info only)

If a customer tries to share payment details: immediately stop them with a safety warning and redirect to the secure checkout page. Example: "Please never share card/payment details here — for your safety, complete payment securely on sathvam.in/checkout which uses Razorpay bank-grade encryption."

━━━━ WHEN CUSTOMER WANTS TO BUY / ORDER ━━━━
1. Confirm product & price from the live list ("Groundnut Oil 1L is ₹X + 5% GST — in stock!")
2. Direct ONLY to these two safe channels:
   → Website checkout: sathvam.in → Shop → Add to cart → Checkout (secure, 2 mins)
   → WhatsApp: +91 70921 77092 (team will send a safe payment link)
NEVER collect order details, address, or payment in this chat. Checkout page handles everything securely.

━━━━ WHEN CUSTOMER ASKS TO TRACK ORDER ━━━━
${orderContext ? '' : 'Ask for their order number (e.g. ORD-001) and the phone number used while ordering.'}
If they say they don't have an order number, tell them to check the confirmation SMS/email or call +91 70921 77092.

━━━━ HEALTH RECOMMENDATIONS ━━━━
Use this when customers ask "what's good for [condition]":
- Heart health / cholesterol → Groundnut Oil (rich in monounsaturated fats, Vitamin E)
- Joint pain / inflammation → Sesame Oil (sesamol, anti-inflammatory)
- Immunity / thyroid → Coconut Oil (lauric acid, MCTs)
- Diabetes / blood sugar → Finger Millet (ragi), Foxtail Millet, Little Millet
- Bone health / calcium → Finger Millet (highest calcium of all millets)
- Weight loss / digestion → Millets (high fibre), Jaggery (replaces refined sugar)
- Iron deficiency / anaemia → Jaggery, Finger Millet
- Skin / hair → Sesame Oil, Coconut Oil, Castor Oil
- Cooking (high heat) → Groundnut Oil or Coconut Oil (high smoke point)

━━━━ POPULAR COMBOS (suggest when relevant) ━━━━
- "Oil Trio" → Groundnut 1L + Sesame 500ml + Coconut 1L (crosses ₹2500 = free delivery!)
- "Millet Pack" → Finger Millet + Foxtail Millet + Little Millet (all 500g)
- "Kitchen Starter" → Groundnut Oil 1L + Turmeric 100g + Sambar Powder 200g
- "Diabetic Friendly" → Finger Millet + Foxtail Millet + Coconut Oil
Mention free delivery if combo crosses ₹2500.

━━━━ BULK / B2B ━━━━
If customer asks for bulk (10+ litres / 5+ kg / wholesale / business), say:
"For bulk orders, WhatsApp us at +91 70921 77092 or email sales@sathvam.in — we offer special pricing for businesses and distributors!"

━━━━ OFFERS / COUPONS ━━━━
${couponContext || 'Tell customers to check the website for latest offers, or ask the team on WhatsApp.'}

━━━━ DELIVERY & PAYMENT ━━━━
- Free delivery above ₹2500 (combine products to qualify!)
- Pay via UPI, cards, net banking (Razorpay)
- Delivered in 3–5 business days; same-day dispatch for orders before 2 PM

━━━━ CONTACT ━━━━
- WhatsApp/Phone: +91 70921 77092 (Mon–Sat 9 AM–6 PM)
- Email: sales@sathvam.in

RETURNS: 7 days if product damaged or wrong.
NEVER make up prices or stock. If unsure, say "Check +91 70921 77092 for latest info."`;

  const recentMessages = messages.slice(-10).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content).slice(0, 1000),
  }));

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 650,
        system: systemPrompt,
        messages: recentMessages,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic API error:', err);
      return res.status(502).json({ error: 'AI service error' });
    }

    const data = await response.json();
    const reply = data.content?.[0]?.text ?? "Sorry, I couldn't generate a response.";

    // Intent flags for frontend
    const lastUserMsg = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    const buyingIntent = /\b(order|buy|purchase|want|need|get|add to cart|place order|book)\b/i.test(lastUserMsg);
    const wantsHuman   = /whatsapp|speak to|talk to|human|agent|\+91 70921/i.test(reply);
    const showWhatsApp = buyingIntent || wantsHuman;
    const showB2B      = detectB2BIntent(messages);

    // Build pre-filled WhatsApp text
    let prefillText = 'Hi Sathvam, I need help with my order';
    if (buyingIntent) {
      const prodMatch = lastUserMsg.match(/(?:order|buy|purchase|want|need)\s+(.{3,40})/i);
      if (prodMatch) prefillText = `Hi Sathvam, I want to order ${prodMatch[1].trim()}`;
    }

    // Back-in-stock alert save
    const allMessages = [...messages, { role: 'assistant', content: reply }];
    if (detectOOSInterest(allMessages) && lead?.phone) {
      const productMatch = allMessages.slice(-4).find(m =>
        m.role === 'assistant' && /out of stock|not available/i.test(m.content)
      );
      if (productMatch) {
        const pMatch = productMatch.content.match(/([A-Z][a-z]+(?:\s+[A-Z]?[a-z]+)*(?:\s+\d+[A-Za-z]+)?)/);
        if (pMatch) saveStockAlert(lead.phone, pMatch[1], lead.name).catch(() => {});
      }
    }

    // Save session + detect issues (non-blocking)
    if (sessionId) {
      setImmediate(async () => {
        try {
          const issueType = detectIssue(allMessages);
          const hasIssue  = !!(issueType || wantsHuman);
          const { isNew, wasIssue } = await saveSession(sessionId, lead, allMessages, hasIssue, issueType || (wantsHuman ? 'requested human agent' : ''));
          // Send email alert only once per session when issue first detected
          if (hasIssue && !wasIssue) {
            await sendIssueAlert(lead, allMessages, issueType || 'requested human agent');
          }
        } catch(e) { console.warn('Session save error:', e.message); }
      });
    }

    res.json({ reply, showWhatsApp, showB2B, prefillText, orderFound: !!orderContext && isOrderIntent });
  } catch (err) {
    console.error('Chat route error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── POST /api/chat/stream — SSE streaming response ────────────────────────────
router.post('/stream', chatLimiter, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Service unavailable' });

  const { messages, lead, sessionId, cart, currentProduct } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'No messages provided' });
  }

  // Block sensitive data
  const lastUserText = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
  const sensitiveType = detectSensitiveData(lastUserText);
  if (sensitiveType) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const msg = `🔒 Please never share ${sensitiveType} here — this chat is not secure for payment details!\n\nComplete payment safely on sathvam.in checkout (Razorpay bank-grade encryption).\n\nFor help, WhatsApp +91 70921 77092.`;
    res.write(`data: ${JSON.stringify({ type: 'delta', text: msg })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done', showWhatsApp: true, showB2B: false, prefillText: 'Hi Sathvam, I need help placing an order', securityWarning: true })}\n\n`);
    res.end();
    return;
  }

  if (lead?.name && lead?.phone) saveLead(lead.name, lead.phone, lead.email).catch(() => {});

  const productContext = await getLiveContext();
  const cartContext    = buildCartContext(cart);
  const pageContext    = buildPageContext(currentProduct);
  const pincodeCtx    = buildPincodeContext(messages);

  let orderContext = '';
  const isOrderIntent = detectOrderIntent(messages);
  if (isOrderIntent) {
    const orderNo = extractOrderNo(messages);
    const phone   = extractPhone(messages, lead);
    if (orderNo && phone) {
      const order = await lookupOrder(orderNo, phone);
      if (order) {
        const items = (order.items || []).map(i => `${i.qty}x ${i.productName||i.name}`).join(', ');
        orderContext = `\nORDER FOUND:\nOrder No: ${order.order_no}\nStatus: ${order.status?.toUpperCase()}\nItems: ${items}\n${order.delivered_date ? 'Delivered on: ' + order.delivered_date : ''}`;
      } else if (orderNo) {
        orderContext = `\nORDER LOOKUP: Order "${orderNo}" not found or phone doesn't match.`;
      }
    }
  }

  let couponContext = '';
  if (detectCouponIntent(messages)) {
    const coupons = await getActiveCoupons();
    if (coupons.length > 0) {
      couponContext = 'ACTIVE OFFERS:\n' + coupons.map(c => {
        const disc = c.type === 'percent' ? `${c.value}% off` : `₹${c.value} off`;
        const min  = c.min_order > 0 ? ` on orders above ₹${c.min_order}` : '';
        return `→ Code: ${c.code} — ${disc}${min}${c.description ? ' (' + c.description + ')' : ''}`;
      }).join('\n');
    } else {
      couponContext = 'No active coupon codes right now. Follow @sathvam.in on Instagram for latest offers!';
    }
  }

  const systemPrompt = `You are Sathvam's friendly AI sales assistant on www.sathvam.in.
Sathvam Natural Products — factory-direct from Karur, Tamil Nadu. Cold pressed oils, millets, spices. 100% natural, zero chemicals.
Be warm, concise, action-focused. Max 4 lines per reply. If customer writes in Tamil, reply ONLY in Tamil.

FORMATTING — plain text chat only, no markdown:
- No **, no *, no #, no tables, no dashes. Use → for lists.

━━━━ LIVE PRODUCTS (name | pack | price | stock | benefits) ━━━━
${productContext}
${orderContext}
${couponContext}
${cartContext}
${pageContext}
${pincodeCtx}

━━━━ SECURITY — ABSOLUTE RULES (never break these) ━━━━
NEVER ask for or accept: card number, CVV, OTP, UPI PIN, NetBanking password, bank account/IFSC, any payment credentials.
If customer tries to share payment details: warn them immediately and redirect to secure checkout.

━━━━ WHEN CUSTOMER WANTS TO BUY / ORDER ━━━━
1. Confirm product & price from the live list
2. Direct ONLY to: Website checkout (sathvam.in → Shop → Cart → Checkout) OR WhatsApp +91 70921 77092
NEVER collect order details, address, or payment in this chat.

━━━━ WHEN CUSTOMER ASKS TO TRACK ORDER ━━━━
${orderContext ? '' : 'Ask for order number (e.g. SAT-20260408-0001) and phone number used while ordering.'}
If no order number, tell them to check confirmation SMS/email or call +91 70921 77092.

━━━━ HEALTH RECOMMENDATIONS ━━━━
- Heart health / cholesterol → Groundnut Oil (monounsaturated fats, Vitamin E)
- Joint pain / inflammation → Sesame Oil (sesamol, anti-inflammatory)
- Immunity / thyroid → Coconut Oil (lauric acid, MCTs)
- Diabetes / blood sugar → Finger Millet, Foxtail Millet, Little Millet
- Bone health / calcium → Finger Millet (highest calcium of all millets)
- Weight loss / digestion → Millets (high fibre), Jaggery (replaces refined sugar)
- Iron deficiency → Jaggery, Finger Millet
- Skin / hair → Sesame Oil, Coconut Oil, Castor Oil
- Cooking (high heat) → Groundnut Oil or Coconut Oil (high smoke point)

━━━━ POPULAR COMBOS ━━━━
- "Oil Trio" → Groundnut 1L + Sesame 500ml + Coconut 1L (crosses ₹2500 = free delivery!)
- "Millet Pack" → Finger Millet + Foxtail Millet + Little Millet (all 500g)
- "Kitchen Starter" → Groundnut Oil 1L + Turmeric 100g + Sambar Powder 200g
- "Diabetic Friendly" → Finger Millet + Foxtail Millet + Coconut Oil

━━━━ BULK / B2B ━━━━
For bulk (10+ litres / 5+ kg / wholesale): "WhatsApp +91 70921 77092 or email sales@sathvam.in for special business pricing!"

━━━━ OFFERS / COUPONS ━━━━
${couponContext || 'Check the website for latest offers, or ask on WhatsApp.'}

━━━━ DELIVERY & PAYMENT ━━━━
- Free delivery above ₹2500 (combine products to qualify!)
- Pay via UPI, cards, net banking (Razorpay) — 100% secure
- Delivered in 3–5 business days; same-day dispatch for orders before 2 PM
- Ships pan-India via courier

━━━━ CONTACT ━━━━
WhatsApp/Phone: +91 70921 77092 (Mon–Sat 9 AM–6 PM) | Email: sales@sathvam.in

RETURNS: 7 days if product damaged or wrong item received.
NEVER make up prices or stock. If unsure, say "Check +91 70921 77092 for latest info."`;

  const recentMessages = messages.slice(-10).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content).slice(0, 1000),
  }));

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 650,
        stream: true,
        system: systemPrompt,
        messages: recentMessages,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic stream error:', err);
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'AI service error. Please try again.' })}\n\n`);
      res.end();
      return;
    }

    let fullReply = '';
    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        try {
          const ev = JSON.parse(raw);
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            const text = ev.delta.text;
            fullReply += text;
            res.write(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`);
          }
        } catch {}
      }
    }

    // Compute intent flags
    const lastUserMsg  = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
    const buyingIntent = /\b(order|buy|purchase|want|need|get|add to cart|place order|book)\b/i.test(lastUserMsg);
    const wantsHuman   = /whatsapp|speak to|talk to|human|agent/i.test(fullReply);
    const showB2B      = detectB2BIntent(messages);
    const userMsgCount = messages.filter(m => m.role === 'user').length;
    const showWhatsApp = buyingIntent || wantsHuman || userMsgCount >= 6;
    let prefillText = 'Hi Sathvam, I need help';
    if (buyingIntent) {
      const pm = lastUserMsg.match(/(?:order|buy|purchase|want|need)\s+(.{3,40})/i);
      if (pm) prefillText = `Hi Sathvam, I want to order ${pm[1].trim()}`;
    }

    res.write(`data: ${JSON.stringify({ type: 'done', showWhatsApp, showB2B, prefillText })}\n\n`);
    res.end();

    // Save session + issue detection (non-blocking)
    if (sessionId) {
      const allMessages = [...messages, { role: 'assistant', content: fullReply }];
      setImmediate(async () => {
        try {
          const issueType = detectIssue(allMessages);
          const hasIssue  = !!(issueType || wantsHuman);
          const { wasIssue } = await saveSession(sessionId, lead, allMessages, hasIssue, issueType || (wantsHuman ? 'requested human agent' : ''));
          if (hasIssue && !wasIssue) await sendIssueAlert(lead, allMessages, issueType || 'requested human agent');
        } catch (e) { console.warn('Stream session save error:', e.message); }
      });
    }
  } catch (err) {
    console.error('Chat stream route error:', err.message);
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Connection error. Please try again or call +91 70921 77092.' })}\n\n`);
      res.end();
    } catch {}
  }
});

// ── GET /api/chat/sessions — admin view ──────────────────────────────────────
const { auth } = require('../middleware/auth');
router.get('/sessions', auth, async (req, res) => {
  try {
    const { status, has_issue, limit = 100 } = req.query;
    let q = supabase.from('chat_sessions').select('id,session_id,lead_name,lead_phone,lead_email,has_issue,issue_type,status,notes,created_at,updated_at').order('updated_at', { ascending: false }).limit(parseInt(limit));
    if (status) q = q.eq('status', status);
    if (has_issue === 'true') q = q.eq('has_issue', true);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/chat/sessions/:id — full conversation ───────────────────────────
router.get('/sessions/:id', auth, async (req, res) => {
  const { data, error } = await supabase.from('chat_sessions').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

// ── POST /api/chat/sessions/:id/retry-email — send payment retry email to customer
router.post('/sessions/:id/retry-email', auth, async (req, res) => {
  try {
    const { data: session, error } = await supabase.from('chat_sessions').select('*').eq('id', req.params.id).single();
    if (error || !session) return res.status(404).json({ error: 'Session not found' });

    const { customNote, overrideEmail } = req.body;
    const email = overrideEmail?.trim() || session.lead_email;
    if (!email) return res.status(400).json({ error: 'No email address provided' });
    const name = session.lead_name || 'Valued Customer';

    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return res.status(503).json({ error: 'Email not configured' });
    const nodemailer = require('nodemailer');
    const mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const noteHtml = customNote ? `<p style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;color:#92400e;margin:16px 0">${customNote.replace(/</g,'&lt;')}</p>` : '';

    await mailer.sendMail({
      from: process.env.SMTP_FROM || 'Sathvam Natural Products <noreply@sathvam.in>',
      replyTo: process.env.SMTP_REPLY_TO || 'sales@sathvam.in',
      to: email,
      subject: `We noticed you had trouble ordering — we're here to help! 🌿`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
  <div style="background:linear-gradient(135deg,#1a5c2a,#2d7a3a);color:#fff;padding:24px 28px;border-radius:12px 12px 0 0;text-align:center">
    <div style="font-size:36px;margin-bottom:8px">🌿</div>
    <h2 style="margin:0;font-size:20px">Sathvam Natural Products</h2>
    <div style="opacity:.85;font-size:13px;margin-top:4px">Pure. Natural. Cold-pressed.</div>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:24px 28px;border-radius:0 0 12px 12px;background:#fff">
    <p style="color:#1f2937;font-size:15px;margin-top:0">Hi <strong>${name}</strong>,</p>
    <p style="color:#374151;font-size:14px;line-height:1.6">We noticed you reached out to us recently and may have had some trouble completing your order. We're sorry for the inconvenience — and we'd love to make it right!</p>
    ${noteHtml}
    <p style="color:#374151;font-size:14px;line-height:1.6">Your cart is ready and waiting. Just click the button below to head back and complete your order — it only takes a minute:</p>
    <div style="text-align:center;margin:24px 0">
      <a href="https://sathvam.in" style="display:inline-block;background:linear-gradient(135deg,#1a5c2a,#2d7a3a);color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-size:16px;font-weight:700">
        Complete My Order →
      </a>
    </div>
    <div style="background:#f9fafb;border-radius:8px;padding:14px 16px;margin:16px 0">
      <div style="font-weight:700;color:#1f2937;margin-bottom:8px;font-size:13px">💳 Payment options available:</div>
      <div style="font-size:13px;color:#4b5563;line-height:1.8">→ UPI (Google Pay, PhonePe, Paytm)<br>→ Debit / Credit Card<br>→ Net Banking<br>→ Wallets</div>
    </div>
    <p style="color:#374151;font-size:14px;line-height:1.6">If you continue to face any issues, please don't hesitate to reach out — we're happy to help you place the order directly over WhatsApp!</p>
    <div style="text-align:center;margin:20px 0">
      <a href="https://wa.me/917092177092?text=Hi%20Sathvam%2C%20I%20need%20help%20placing%20my%20order" style="display:inline-block;background:#25D366;color:#fff;text-decoration:none;padding:11px 28px;border-radius:8px;font-size:14px;font-weight:700">
        💬 WhatsApp Us
      </a>
    </div>
    <p style="color:#9ca3af;font-size:12px;text-align:center;margin-top:20px">
      Sathvam Natural Products · Karur, Tamil Nadu<br>
      📞 +91 70921 77092 · sales@sathvam.in
    </p>
  </div>
</div>`,
    });

    // Mark session as retry-emailed in notes
    await supabase.from('chat_sessions').update({
      notes: (session.notes ? session.notes + '\n' : '') + `[${new Date().toLocaleDateString('en-IN')}] Retry email sent by admin`,
      updated_at: new Date().toISOString(),
    }).eq('id', session.id);

    res.json({ ok: true, sentTo: email });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/chat/sessions/:id — update status/notes ───────────────────────
router.patch('/sessions/:id', auth, async (req, res) => {
  const { status, notes } = req.body;
  const updates = { updated_at: new Date().toISOString() };
  if (status !== undefined) updates.status = status;
  if (notes  !== undefined) updates.notes  = notes;
  const { data, error } = await supabase.from('chat_sessions').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

module.exports = router;
