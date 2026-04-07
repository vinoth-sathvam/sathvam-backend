const express = require('express');
const router  = express.Router();
const supabase = require('../config/supabase');

// ── Fetch live products + prices + stock from DB ──────────────────────────────
async function getLiveContext() {
  try {
    const [{ data: products }, { data: stockData }, { data: enabledSettings }] = await Promise.all([
      supabase.from('products')
        .select('id,name,cat,unit,pack_size,pack_unit,gst,website_price,price,active')
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
      return `  - ${p.name} | ${packStr} | ₹${price} (+${p.gst||0}% GST) | ${stockStr}`;
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

// ── POST /api/chat ────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Service unavailable' });

  const { messages, lead, sessionId } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'No messages provided' });
  }

  // Save lead on first message
  if (lead?.name && lead?.phone) {
    await saveLead(lead.name, lead.phone, lead.email);
  }

  // Build system prompt with live data
  const productContext = await getLiveContext();

  const systemPrompt = `You are Sathvam's friendly AI assistant for www.sathvam.in.
Sathvam Natural Products is a factory-direct brand in Karur, Tamil Nadu. No chemicals, no preservatives.
Keep replies short, warm and helpful. Respond in Tamil if the customer writes in Tamil.

IMPORTANT FORMATTING RULES — you are inside a plain text chat bubble, NOT a webpage:
- Never use markdown: no **, no *, no #, no |tables|, no dashes for lists
- Use plain text only. For multiple items, just use line breaks or simple "→" bullet
- Example good format: "Coconut Oil is available in 3 sizes: 500ml → ₹305, 1L → ₹605, 5L → ₹2805 (all +5% GST). Currently in stock!"

LIVE PRODUCT LIST (name | pack size | price | stock):
${productContext}

ORDERING:
- Free delivery above ₹2500. Pay via UPI, cards, net banking (Razorpay).
- Orders processed in 24 hrs, delivered in 3–5 business days.
- Prices shown are base price; GST added at checkout.

CONTACT:
- Phone/WhatsApp: +91 70921 77092
- Email: sales@sathvam.in
- Hours: Mon–Sat 9 AM – 6 PM

POLICIES:
- Returns within 7 days for damaged/wrong items.
- Bulk/B2B orders: email sales@sathvam.in
- GST: 33ABFCS9387K1ZN

If a customer asks to speak to a human, talk to someone, or needs help you can't provide, tell them:
"Sure! You can reach us on WhatsApp at +91 70921 77092 — our team is available Mon–Sat 9 AM–6 PM. 💬"

Never make up stock or prices beyond what is listed above.`;

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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 350,
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

    // Detect WhatsApp handoff trigger in reply
    const wantsHuman = /whatsapp|speak to|talk to|human|agent|\+91 70921/i.test(reply);

    // Save session + detect issues (non-blocking)
    const allMessages = [...messages, { role: 'assistant', content: reply }];
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

    res.json({ reply, showWhatsApp: wantsHuman });
  } catch (err) {
    console.error('Chat route error:', err);
    res.status(500).json({ error: 'Internal error' });
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
