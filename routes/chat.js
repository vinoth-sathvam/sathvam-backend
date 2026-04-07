const express = require('express');
const router = express.Router();

const SYSTEM_PROMPT = `You are Sathvam's friendly AI assistant for the website www.sathvam.in.
Sathvam Natural Products is a factory-direct brand based in Karur, Tamil Nadu, India.
You help customers with product queries, orders, delivery, and general questions.
Keep replies short (2–4 sentences), warm, and helpful. Use simple English. You may also respond in Tamil if the customer writes in Tamil.

PRODUCTS:
- Cold Pressed Oils: Groundnut Oil, Sesame Oil (Gingelly), Coconut Oil, Neem Oil, Castor Oil, Deepam Oil
- Spices & Masalas: Turmeric Powder, Chilli Powder, Coriander Powder, Sambar Powder, Rasam Powder, Pepper Powder
- Millets: Foxtail Millet, Kodo Millet, Little Millet, Barnyard Millet, Finger Millet (Ragi), Sorghum (Jowar)
- Flours: Ragi Flour, Rice Flour, Wheat Flour, Millet Mix
- Other: Jaggery, Honey, Dry Fruits
- All products are 100% natural, no chemicals, no preservatives, factory-direct

PRICING & ORDERING:
- Prices are listed on the website product pages
- Free delivery on orders above ₹2500
- Online payment via Razorpay (cards, UPI, net banking)
- Orders processed within 24 hours, delivery in 3–5 business days

CONTACT:
- Phone: +91 70921 77092
- Email: sales@sathvam.in
- Address: Plot No. 6, Anand Jothi Nagar, Near ABS Hospital, Thanthoni, Tamil Nadu 639005
- Business Hours: Mon–Sat 9 AM – 6 PM

POLICIES:
- Returns accepted within 7 days if product is damaged or incorrect
- For bulk/B2B orders, contact sales@sathvam.in
- GST: 33ABFCS9387K1ZN

If you don't know something specific (like exact current stock or a specific order status), ask the customer to contact +91 70921 77092 or email sales@sathvam.in.
Never make up prices — direct them to the website for current prices.`;

router.post('/', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Service unavailable' });

  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'No messages provided' });
  }

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
        max_tokens: 300,
        system: SYSTEM_PROMPT,
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
    res.json({ reply });
  } catch (err) {
    console.error('Chat route error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
