const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { auth, requireRole } = require('../middleware/auth');

router.post('/chat', auth, requireRole('admin','ceo'), async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    // ── Gather system-wide context ──────────────────────────────────────────
    // Projects
    const { data: projects } = await supabase.from('projects')
      .select('id,project_name,buyer_name,status,b2b_order_id,created_at')
      .order('created_at', { ascending: false }).limit(20);

    // B2B orders
    const { data: b2bOrders } = await supabase.from('b2b_orders')
      .select('id,order_no,buyer_name,stage,total_value,created_at,logistics_charge,other_charges')
      .order('created_at', { ascending: false }).limit(20);

    // B2B payments
    const { data: pmtRow } = await supabase.from('settings').select('value').eq('key', 'b2b_payments').single();
    const allPayments = pmtRow?.value || {};

    // Load full data for active projects
    const activeProjects = (projects || []).filter(p => p.status !== 'closed').slice(0, 5);
    const projectFulls = {};
    for (const proj of activeProjects) {
      const { data: fRow } = await supabase.from('settings').select('value').eq('key', `project_full_${proj.id}`).single();
      if (fRow?.value) projectFulls[proj.id] = fRow.value;
    }

    // Build project summaries for context
    const projectSummaries = (projects || []).map(proj => {
      const full = projectFulls[proj.id] || {};
      const log = full.logistics || {};
      const mfgItems = (full.mfg?.items || []).filter(i => i.product);
      const merchItems = (full.merch?.items || []).filter(i => i.product);
      const boxes = full.packingBoxes || [];
      const order = (b2bOrders || []).find(o => o.id === proj.b2b_order_id);
      const pmt = allPayments[proj.b2b_order_id] || {};

      return {
        id: proj.id,
        name: proj.project_name,
        buyer: proj.buyer_name,
        status: proj.status,
        orderNo: order?.order_no,
        orderStage: order?.stage,
        mfgInvoice: full.mfg?.invoiceNo || null,
        merchInvoice: full.merch?.invoiceNo || null,
        mfgItems: mfgItems.length,
        merchItems: merchItems.length,
        missingHSN: [...mfgItems, ...merchItems].filter(i => !i.hsnCode).length,
        totalBoxes: boxes.length,
        totalValue: order?.total_value || 0,
        advancePaid: parseFloat(pmt.advance_paid || 0),
        balancePaid: parseFloat(pmt.remaining_paid || 0),
        logisticsVendor: log.vendorName || null,
        logisticsDocsSent: !!log.docsSentDate,
        logisticsConfirmed: !!log.vendorConfirmed,
        portOfLoading: full.portOfLoading || null,
        portOfDischarge: full.portOfDischarge || null,
        emailsSent: (full._emailLog || []).length,
        piNo: full.piNo || full.mfg?.piNo || null,
        terms: full.terms || full.paymentTerms || null,
        country: full.buyerCountry || null,
      };
    });

    // ── Call Claude ──────────────────────────────────────────────────────────
    const Anthropic = require('@anthropic-ai/sdk');
    const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const systemPrompt = `You are the AI Operations Agent for **Sathvam Oils & Spices Pvt Ltd**, an Indian FMCG manufacturer and exporter of cold-pressed oils, spices, millets, and food products.

You are a strategic operations consultant with deep knowledge of:
- Indian export compliance (FSSAI, GST, IEC, LUT, HSN codes, customs)
- B2B export workflow (Proforma Invoice → Order → Production → Packing → Invoicing → Logistics → Customs → Shipping → Delivery → Payment)
- Indian accounting (Companies Act 2013, GST, TDS, RCM)
- Supply chain management for FMCG food products
- The Sathvam ERP system architecture and capabilities

YOUR ROLE:
1. **Workflow Monitor** — Analyze all active projects, find bottlenecks, missed steps, errors
2. **Automation Suggester** — Identify repetitive manual work and suggest what to automate
3. **Process Consultant** — Answer questions about export procedures, compliance, best practices
4. **Problem Solver** — Help debug issues, suggest fixes, explain why things work the way they do
5. **Feature Advisor** — When asked, suggest new features or improvements to the system

CURRENT SYSTEM STATE:
Total Projects: ${(projects || []).length}
Active Projects: ${activeProjects.length}
B2B Orders: ${(b2bOrders || []).length}

PROJECT SUMMARIES:
${JSON.stringify(projectSummaries, null, 1)}

WORKFLOW STAGES (B2B Export):
1. order_placed → 2. confirmed → 3. in_production → 4. quality_check → 5. ready_to_ship
6. stuffing → 7. shipped → 8. sailing → 9. in_transit → 10. arrived_at_port
11. customs_clearance → 12. delivered → 13. payment_received

PROJECT WORKFLOW:
1. Create project linked to B2B order
2. Add MFG items (manufactured goods — oils, powders) and MERCH items (traded/merchant goods — millets, dals, spices)
3. Assign HSN codes, prices, quantities to all items
4. Generate Proforma Invoice → send to buyer
5. Receive advance payment from buyer
6. Production & quality check
7. Create packing boxes/sacks, assign products to boxes
8. Generate Export Invoices (MFG + MERCH)
9. Generate Packing Lists
10. Assign logistics vendor, send docs for customs filing
11. Logistics vendor confirms, arranges container/shipment
12. Stuffing → ship → sailing → delivery
13. Collect balance payment
14. Close project

AUTOMATION OPPORTUNITIES TO CONSIDER:
- Auto-assign HSN codes based on product name
- Auto-send docs to logistics when packing is complete
- Auto-reminder for overdue payments
- Auto-stage update based on logistics milestones
- Auto-generate packing boxes from order quantities
- Auto-check compliance before shipping (LUT, IEC, all HSN filled)
- Scheduled email reminders to buyer for balance payment
- Auto-detect pricing anomalies (item priced too low/high vs history)

RULES:
- Be concise but thorough
- Use bullet points for lists
- When suggesting automations, explain what trigger and what action
- When analyzing workflows, be specific about which project/order you're referring to
- Always think from the perspective of a small export business — practical, not theoretical
- If asked about code or features, describe what the feature should do and how it fits the existing system`;

    const messages = [
      ...(history || []).slice(-15).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    const resp = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      system: systemPrompt,
      messages,
    });

    const aiText = resp.content?.[0]?.text || '';
    res.json({ reply: aiText });
  } catch (err) {
    console.error('[ai-ops]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
