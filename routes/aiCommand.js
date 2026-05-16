/**
 * /api/ai-command  — Universal AI command parser for all modules
 * Accepts a plain-English prompt + module hint, returns structured data preview.
 */
const express = require('express');
const router  = express.Router();
const { auth } = require('../middleware/auth');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const TODAY = () => new Date().toISOString().slice(0, 10);

async function callClaude(system, userMsg) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('AI not configured');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j?.error?.message || 'AI error');
  const raw = j.content?.[0]?.text || '';
  const match = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error('Could not parse AI response: ' + raw.slice(0, 200));
  return JSON.parse(match[0]);
}

// ─── Module handlers ──────────────────────────────────────────────────────────

async function handleProcurement(prompt) {
  const { data: vendors } = await supabase.from('vendors').select('id,display_name,company_name').eq('active', true).limit(200);
  const vNames = (vendors || []).map(v => v.display_name || v.company_name).filter(Boolean).join(', ');
  const result = await callClaude(
    `You are a procurement assistant for Sathvam Natural Products (cold-pressed oil factory, Karur).
Known vendors: ${vNames || 'none'}
Today: ${TODAY()}
Return ONLY JSON:
{
  "vendor": "vendor name",
  "vendorId": null,
  "date": "YYYY-MM-DD",
  "invoiceNo": "",
  "notes": "",
  "items": [{"commodityName":"","orderedQty":0,"orderedPricePerKg":0,"gst":0,"unit":"kg"}]
}`,
    prompt
  );
  // match vendor
  if (result.vendor && vendors?.length) {
    const low = result.vendor.toLowerCase();
    const m = vendors.find(v => {
      const dn = (v.display_name||'').toLowerCase(), cn = (v.company_name||'').toLowerCase();
      return dn.includes(low)||low.includes(dn)||cn.includes(low)||low.includes(cn);
    });
    if (m) { result.vendorId = m.id; result.vendor = m.display_name || m.company_name; }
  }
  return { module: 'procurement', action: 'create_po', data: result };
}

async function handleSales(prompt) {
  const { data: products } = await supabase.from('products').select('id,name,retail_price,website_price,price').eq('active', true).limit(200);
  const pList = (products || []).map(p => `${p.name} (₹${p.retail_price || p.price})`).join(', ');
  const result = await callClaude(
    `You are a sales assistant for Sathvam Natural Products.
Products: ${pList || 'none'}
Today: ${TODAY()}
Return ONLY JSON:
{
  "customerName": "",
  "customerPhone": "",
  "date": "YYYY-MM-DD",
  "channel": "direct",
  "paymentMode": "cash",
  "notes": "",
  "items": [{"productName":"","productId":null,"qty":1,"rate":0,"unit":"pcs"}],
  "discount": 0
}`,
    prompt
  );
  // match product ids
  if (result.items && products?.length) {
    result.items = result.items.map(item => {
      const low = (item.productName||'').toLowerCase();
      const m = products.find(p => p.name.toLowerCase().includes(low) || low.includes(p.name.toLowerCase()));
      if (m) return { ...item, productId: m.id, productName: m.name, rate: item.rate || m.retail_price || m.price };
      return item;
    });
  }
  const subtotal = (result.items||[]).reduce((s,i) => s + (parseFloat(i.qty)||0)*(parseFloat(i.rate)||0), 0);
  result.totalAmount = subtotal;
  result.finalAmount = Math.max(0, subtotal - (parseFloat(result.discount)||0));
  return { module: 'sales', action: 'create_sale', data: result };
}

async function handleExpense(prompt) {
  const result = await callClaude(
    `You are an expense entry assistant for Sathvam Natural Products.
Today: ${TODAY()}
Common categories: Raw Material Purchase, Packaging, Transport, Utilities, Salaries, Maintenance, Marketing, Office, Miscellaneous
Return ONLY JSON:
{
  "date": "YYYY-MM-DD",
  "category": "",
  "description": "",
  "amount": 0,
  "vendorName": "",
  "paymentMode": "cash",
  "notes": ""
}`,
    prompt
  );
  return { module: 'expenses', action: 'create_expense', data: result };
}

async function handleBatch(prompt) {
  const result = await callClaude(
    `You are a production batch logger for Sathvam Natural Products (cold-pressed oil factory).
Oil types: Groundnut, Sesame, Coconut, Castor, Mustard
Today: ${TODAY()}
Return ONLY JSON:
{
  "date": "YYYY-MM-DD",
  "oilType": "",
  "inputKg": 0,
  "oilOutput": 0,
  "cakeOutput": 0,
  "rawPricePerKg": 0,
  "notes": ""
}`,
    prompt
  );
  return { module: 'batch', action: 'log_batch', data: result };
}

async function handleAttendance(prompt) {
  const { data: employees } = await supabase.from('employees').select('id,name').limit(100);
  const empList = (employees || []).map(e => e.name).join(', ');
  const result = await callClaude(
    `You are an attendance logger for Sathvam Natural Products.
Employees: ${empList || 'none on file'}
Today: ${TODAY()}
Status values: present, absent, half_day, leave
Return ONLY JSON array:
[{"employeeName":"","employeeId":null,"date":"YYYY-MM-DD","status":"present","notes":""}]`,
    prompt
  );
  const arr = Array.isArray(result) ? result : [result];
  // match employee ids
  if (employees?.length) {
    arr.forEach(r => {
      const low = (r.employeeName||'').toLowerCase();
      const m = employees.find(e => e.name.toLowerCase().includes(low)||low.includes(e.name.toLowerCase()));
      if (m) r.employeeId = m.id;
    });
  }
  return { module: 'attendance', action: 'mark_attendance', data: arr };
}

async function handleTask(prompt) {
  const { data: users } = await supabase.from('users').select('id,name').eq('active', true).limit(50);
  const uList = (users || []).map(u => u.name).join(', ');
  const result = await callClaude(
    `You are a task creator for Sathvam Natural Products.
Team members: ${uList || 'none'}
Today: ${TODAY()}
Return ONLY JSON:
{
  "title": "",
  "description": "",
  "assignedTo": "",
  "assignedToId": null,
  "dueDate": "YYYY-MM-DD or null",
  "priority": "medium",
  "category": ""
}`,
    prompt
  );
  if (result.assignedTo && users?.length) {
    const low = result.assignedTo.toLowerCase();
    const m = users.find(u => u.name.toLowerCase().includes(low)||low.includes(u.name.toLowerCase()));
    if (m) result.assignedToId = m.id;
  }
  return { module: 'task', action: 'create_task', data: result };
}

async function handlePackingPO(prompt) {
  const { data: materials } = await supabase.from('packing_materials').select('id,name,category').eq('active', true).limit(200);
  const { data: vendors } = await supabase.from('vendors').select('id,display_name,company_name').eq('active', true).limit(100);
  const mList = (materials||[]).map(m=>m.name).join(', ');
  const vNames = (vendors||[]).map(v=>v.display_name||v.company_name).filter(Boolean).join(', ');
  const result = await callClaude(
    `You are a packing material procurement assistant for Sathvam Natural Products.
Known materials: ${mList||'none'}
Known vendors: ${vNames||'none'}
Today: ${TODAY()}
Return ONLY JSON:
{
  "vendorName": "",
  "vendorId": null,
  "date": "YYYY-MM-DD",
  "poNumber": "",
  "notes": "",
  "items": [{"materialName":"","materialId":null,"qty":0,"unit":"pcs","unitPrice":0}]
}`,
    prompt
  );
  if (result.vendorName && vendors?.length) {
    const low = result.vendorName.toLowerCase();
    const m = vendors.find(v=>{
      const dn=(v.display_name||'').toLowerCase(),cn=(v.company_name||'').toLowerCase();
      return dn.includes(low)||low.includes(dn)||cn.includes(low)||low.includes(cn);
    });
    if (m) { result.vendorId = m.id; result.vendorName = m.display_name||m.company_name; }
  }
  if (result.items && materials?.length) {
    result.items = result.items.map(item => {
      const low=(item.materialName||'').toLowerCase();
      const m = materials.find(mat=>mat.name.toLowerCase().includes(low)||low.includes(mat.name.toLowerCase()));
      if (m) return {...item, materialId: m.id, materialName: m.name};
      return item;
    });
  }
  return { module: 'packing_po', action: 'create_packing_po', data: result };
}

async function handleFlourBatch(prompt) {
  const result = await callClaude(
    `You are a flour/grain batch logger for Sathvam Natural Products.
Today: ${TODAY()}
Return ONLY JSON:
{
  "date": "YYYY-MM-DD",
  "commodity": "",
  "inputKg": 0,
  "cleanedKg": 0,
  "flourReceivedKg": 0,
  "rawRatePerKg": 0,
  "grindingCharge": 0,
  "notes": ""
}`,
    prompt
  );
  return { module: 'flour_batch', action: 'log_flour_batch', data: result };
}

async function handleB2BOrder(prompt) {
  const { data: customers } = await supabase.from('b2b_customers').select('id,company_name,contact_name,currency').eq('active', true).limit(100);
  const { data: products } = await supabase.from('products').select('id,name,price').eq('active', true).limit(200);
  const cList = (customers||[]).map(c=>c.company_name).join(', ');
  const pList = (products||[]).map(p=>`${p.name} (₹${p.price})`).join(', ');
  const result = await callClaude(
    `You are a B2B order assistant for Sathvam Natural Products.
B2B Customers: ${cList||'none'}
Products: ${pList||'none'}
Today: ${TODAY()}
Return ONLY JSON:
{
  "customerName": "",
  "customerId": null,
  "date": "YYYY-MM-DD",
  "currency": "INR",
  "notes": "",
  "items": [{"productName":"","productId":null,"qty":0,"unit":"pcs","rate":0}]
}`,
    prompt
  );
  if (result.customerName && customers?.length) {
    const low = result.customerName.toLowerCase();
    const m = customers.find(c=>(c.company_name||'').toLowerCase().includes(low)||low.includes((c.company_name||'').toLowerCase()));
    if (m) { result.customerId = m.id; result.customerName = m.company_name; result.currency = m.currency||'INR'; }
  }
  if (result.items && products?.length) {
    result.items = result.items.map(item => {
      const low=(item.productName||'').toLowerCase();
      const m=products.find(p=>p.name.toLowerCase().includes(low)||low.includes(p.name.toLowerCase()));
      if (m) return {...item, productId: m.id, productName: m.name, rate: item.rate||m.price};
      return item;
    });
  }
  return { module: 'b2b_order', action: 'create_b2b_order', data: result };
}

// ─── Module auto-detect from prompt keywords ──────────────────────────────────
function detectModule(prompt, hint) {
  if (hint) return hint;
  const p = prompt.toLowerCase();
  if (p.includes('po') || p.includes('purchase order') || p.includes('procure') || p.includes('buy') || p.includes('order from vendor') || p.includes('raise po')) return 'procurement';
  if (p.includes('sale') || p.includes('sold') || p.includes('customer order') || p.includes('invoice') || p.includes('bill to')) return 'sales';
  if (p.includes('expense') || p.includes('spent') || p.includes('paid for') || p.includes('payment for')) return 'expense';
  if (p.includes('batch') || p.includes('oil') || p.includes('crush') || p.includes('extract') || p.includes('production batch')) return 'batch';
  if (p.includes('attend') || p.includes('present') || p.includes('absent') || p.includes('half day') || p.includes('leave mark')) return 'attendance';
  if (p.includes('task') || p.includes('assign') || p.includes('todo') || p.includes('to-do')) return 'task';
  if (p.includes('packing') || p.includes('bottle') || p.includes('label') || p.includes('cap') || p.includes('carton') || p.includes('pack material')) return 'packing_po';
  if (p.includes('flour') || p.includes('mill') || p.includes('grain') || p.includes('grind')) return 'flour_batch';
  if (p.includes('b2b') || p.includes('wholesale') || p.includes('bulk order') || p.includes('export')) return 'b2b_order';
  return 'procurement'; // default
}

// ─── Main route ───────────────────────────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  const { prompt, module: hint } = req.body;
  if (!prompt?.trim()) return res.status(400).json({ error: 'prompt required' });

  const mod = detectModule(prompt, hint);
  try {
    let result;
    switch (mod) {
      case 'procurement':  result = await handleProcurement(prompt); break;
      case 'sales':        result = await handleSales(prompt); break;
      case 'expense':      result = await handleExpense(prompt); break;
      case 'batch':        result = await handleBatch(prompt); break;
      case 'attendance':   result = await handleAttendance(prompt); break;
      case 'task':         result = await handleTask(prompt); break;
      case 'packing_po':   result = await handlePackingPO(prompt); break;
      case 'flour_batch':  result = await handleFlourBatch(prompt); break;
      case 'b2b_order':    result = await handleB2BOrder(prompt); break;
      default:             result = await handleProcurement(prompt);
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
