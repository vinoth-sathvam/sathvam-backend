#!/usr/bin/env node
/**
 * Sathvam Master AI Morning Briefing
 * Runs daily at 8:30 AM IST via cron: 0 3 * * * node /home/ubuntu/sathvam-backend/scripts/morning-briefing.js
 *
 * Calls the Claude Sonnet agent with all business tools → sends result via WhatsApp to admin
 */

require('dotenv').config({ path: '/home/ubuntu/sathvam-backend/.env' });

const { executeTool, TOOLS } = require('../routes/adminChat');

const ADMIN_PHONE = process.env.ADMIN_WHATSAPP_PHONE || process.env.WA_ADMIN_PHONE; // e.g. 919876543210

const SYSTEM_PROMPT = `You are the Master Business Intelligence Agent for Sathvam Natural Products — a factory-direct natural products brand in Karur, Tamil Nadu.

Today's date: ${new Date().toISOString().slice(0,10)}

You have access to all business data via tools. Use them to generate a sharp morning briefing.

Structure the briefing as:
🚨 URGENT (act today)
⚠️ WATCH (monitor this week)
💡 OPPORTUNITY (act to grow)
📊 KEY NUMBERS (revenue, orders, stock)

Be specific with product names and ₹ amounts. Max 300 words. No markdown symbols — plain text only (for WhatsApp).`;

async function runAgent(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('No ANTHROPIC_API_KEY in env');

  let messages = [{ role: 'user', content: prompt }];
  const toolStepsLog = [];

  for (let i = 0; i < 8; i++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error('Anthropic API error: ' + err);
    }

    const data = await res.json();

    if (data.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: data.content });
      const toolResults = [];
      for (const block of data.content) {
        if (block.type !== 'tool_use') continue;
        console.log(`  🔧 Tool: ${block.name}`, JSON.stringify(block.input).slice(0, 80));
        const result = await executeTool(block.name, block.input);
        toolStepsLog.push({ tool: block.name, result });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    const reply = data.content?.find(b => b.type === 'text')?.text ?? 'No briefing generated.';
    return { reply, toolStepsLog };
  }

  return { reply: 'Agent reached max iterations.', toolStepsLog };
}

async function sendWhatsApp(phone, message) {
  const phoneId = process.env.WA_PHONE_NUMBER_ID;
  const token   = process.env.WA_ACCESS_TOKEN;
  if (!phoneId || !token) {
    console.log('WhatsApp not configured — skipping send');
    console.log('\n--- BRIEFING ---\n' + message + '\n--- END ---');
    return;
  }
  const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: message } }),
  });
  const data = await res.json();
  if (data.error) throw new Error('WhatsApp error: ' + JSON.stringify(data.error));
  console.log('WhatsApp sent to', phone);
}

async function main() {
  console.log(`\n[${new Date().toISOString()}] Sathvam Master AI Morning Briefing starting...`);

  const prompt = `Good morning. Give me the complete morning briefing for Sathvam Natural Products.
Check: business summary, stock levels, reorder suggestions, anomalies, B2B pipeline, customer issues, operations status, demand forecast.
Prioritize urgent items first. Be specific with product names and rupee amounts.`;

  try {
    const { reply, toolStepsLog } = await runAgent(prompt);
    console.log(`\nAgent used ${toolStepsLog.length} tools:`);
    toolStepsLog.forEach(s => console.log(`  - ${s.tool}`));

    const header = `🌅 Sathvam Morning Briefing — ${new Date().toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'short' })}\n\n`;
    const fullMsg = header + reply;

    if (ADMIN_PHONE) {
      await sendWhatsApp(ADMIN_PHONE, fullMsg);
    } else {
      console.log('\n--- BRIEFING (no ADMIN_WHATSAPP_PHONE set) ---');
      console.log(fullMsg);
      console.log('--- END ---');
    }

    console.log(`\n[${new Date().toISOString()}] Morning briefing complete.`);
  } catch (e) {
    console.error('Morning briefing failed:', e.message);
    process.exit(1);
  }
}

main();
