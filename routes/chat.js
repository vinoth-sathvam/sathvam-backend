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
async function saveLead(name, phone) {
  try {
    await supabase.from('chat_leads').insert({ name, phone, created_at: new Date().toISOString() });
  } catch (e) {
    // Table may not exist yet — log and continue
    console.warn('chat_leads save skipped:', e.message);
  }
}

// ── POST /api/chat ────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Service unavailable' });

  const { messages, lead } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'No messages provided' });
  }

  // Save lead on first message
  if (lead?.name && lead?.phone) {
    await saveLead(lead.name, lead.phone);
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

    res.json({ reply, showWhatsApp: wantsHuman });
  } catch (err) {
    console.error('Chat route error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
