#!/usr/bin/env node
/**
 * AI Logistics Agent — End-to-end export shipment automation
 *
 * Polls Gmail IMAP for emails from logistics vendors, classifies them
 * with Claude, and takes automated action:
 *
 *   Phase 1: CORRECTIONS — vendor asks to fix invoice/packing → auto-fix + resend
 *   Phase 2: CONFIRMATION — vendor says docs OK → update stage
 *   Phase 3: CHECKLIST    — vendor sends checklist → compare with invoices
 *   Phase 4: CUSTOMS      — vendor says customs cleared → update stage
 *   Phase 5: SHIPPING     — vendor sends BL/docs + vessel schedule → draft buyer email
 *
 * Run: node scripts/logistics-agent.js [--dry-run]
 * Timer: sathvam-logistics-agent.timer (every 5 min)
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { ImapFlow }       = require('imapflow');
const Anthropic          = require('@anthropic-ai/sdk');
const nodemailer         = require('nodemailer');
const { sendText }       = require('../lib/greenapi');
const { simpleParser }   = require('mailparser');
const path               = require('path');
const fs                 = require('fs');

// ── Config ──────────────────────────────────────────────────────────────────────
const DRY_RUN       = process.argv.includes('--dry-run');
// PostgREST runs in Docker — host scripts access via localhost:3100
const POSTGREST_URL = process.env.SUPABASE_URL_HOST || process.env.SUPABASE_URL?.replace('postgrest:3000', 'localhost:3100') || process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const IMAP_HOST     = process.env.IMAP_HOST || 'imap.gmail.com';
const IMAP_PORT     = parseInt(process.env.IMAP_PORT || '993');
const IMAP_USER     = process.env.SMTP_USER;
const IMAP_PASS     = process.env.SMTP_PASS;
const ADMIN_PHONES  = [process.env.WA_ADMIN_PHONE1, process.env.WA_ADMIN_PHONE2].filter(Boolean);
const API_BASE      = process.env.API_INTERNAL_URL || 'https://api.sathvam.in/api';
const S3_BUCKET     = process.env.S3_BUCKET || 'sathvam-storage';

// Use PostgrestClient directly (no /rest/v1 prefix) for self-hosted PostgREST
const { PostgrestClient } = require('@supabase/postgrest-js');
const pgClient = new PostgrestClient(POSTGREST_URL, {
  headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY },
});
const supabase = { from: pgClient.from.bind(pgClient) };
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
const sleep     = ms => new Promise(r => setTimeout(r, ms));

// ── Logging ─────────────────────────────────────────────────────────────────────
const LOG_PREFIX = '[logistics-agent]';
const log  = (...args) => console.log(LOG_PREFIX, new Date().toISOString(), ...args);
const warn = (...args) => console.warn(LOG_PREFIX, ...args);

// ── Admin notification via WhatsApp ─────────────────────────────────────────────
async function notifyAdmin(msg) {
  log('NOTIFY:', msg);
  if (DRY_RUN) return;
  for (const phone of ADMIN_PHONES) {
    try { await sendText(phone, `🤖 *Logistics Agent*\n\n${msg}`); } catch (e) { warn('WA notify failed:', e.message); }
    await sleep(2000);
  }
}

// ── Load all active projects with logistics vendor emails ───────────────────────
async function loadActiveProjects() {
  // Get all project settings keys
  const { data: rows, error } = await supabase
    .from('settings')
    .select('key, value')
    .like('key', 'project_full_%');
  if (error) { warn('Failed to load projects:', error.message); return []; }

  const projects = [];
  for (const row of (rows || [])) {
    const full = row.value || {};
    const logistics = full.logistics || {};
    if (!logistics.vendorEmail) continue;
    // Skip projects where agent is paused
    if (logistics.agentPaused) continue;
    // Extract project ID from key
    const projectId = row.key.replace('project_full_', '');
    // Support multiple vendor emails (comma-separated)
    const vendorEmails = logistics.vendorEmail.toLowerCase().split(',').map(e => e.trim()).filter(Boolean);
    projects.push({
      id: projectId,
      key: row.key,
      full,
      logistics,
      vendorEmail: vendorEmails[0], // primary email for backward compat
      vendorEmails, // all emails for matching
      vendorName: logistics.vendorName || 'Logistics Vendor',
      projectName: full.projectName || '',
      buyerName: full.buyerName || '',
      mfgInvoiceNo: full.mfg?.invoiceNo || '',
      merchInvoiceNo: full.merch?.invoiceNo || '',
      stage: logistics.agentStage || 'docs_sent', // docs_sent, confirmed, checklist_verified, customs_cleared, shipping_received, buyer_notified
    });
  }
  return projects;
}

// ── Connect to Gmail IMAP and fetch unread emails ───────────────────────────────
async function fetchUnreadEmails(vendorEmails) {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: IMAP_USER, pass: IMAP_PASS },
    logger: false,
  });

  const emails = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Search for unread emails from any logistics vendor in the last 14 days
      const since = new Date(Date.now() - 14 * 86400000);
      for (const vendorEmail of vendorEmails) {
        const uids = await client.search({
          unseen: true,
          from: vendorEmail,
          since,
        });
        if (!uids.length) continue;

        for (const uid of uids) {
          try {
            const msg = await client.fetchOne(uid, { source: true, uid: true });
            if (!msg?.source) continue;
            const parsed = await simpleParser(msg.source);
            emails.push({
              uid,
              from: parsed.from?.value?.[0]?.address?.toLowerCase() || '',
              fromName: parsed.from?.value?.[0]?.name || '',
              subject: parsed.subject || '',
              text: parsed.text || '',
              html: parsed.html || '',
              date: parsed.date || new Date(),
              attachments: (parsed.attachments || []).map(att => ({
                filename: att.filename || 'unknown',
                contentType: att.contentType || '',
                size: att.size || 0,
                content: att.content, // Buffer
              })),
              messageId: parsed.messageId || '',
              inReplyTo: parsed.inReplyTo || '',
            });
          } catch (e) { warn('Failed to parse email uid', uid, e.message); }
        }
      }
    } finally {
      lock.release();
    }

    // Mark fetched emails as seen (so we don't process again)
    if (!DRY_RUN && emails.length > 0) {
      const lock2 = await client.getMailboxLock('INBOX');
      try {
        for (const email of emails) {
          await client.messageFlagsAdd(email.uid, ['\\Seen']);
        }
      } finally {
        lock2.release();
      }
    }

    await client.logout();
  } catch (err) {
    warn('IMAP error:', err.message);
    try { await client.logout(); } catch (_) {}
  }
  return emails;
}

// ── Match email to project ──────────────────────────────────────────────────────
function matchEmailToProject(email, projects) {
  // First try sender match against all vendor emails per project
  const byVendor = projects.filter(p => p.vendorEmails.includes(email.from));
  if (byVendor.length === 1) return byVendor[0];

  // Multiple projects with same vendor — match by subject keywords
  if (byVendor.length > 1) {
    const subj = email.subject.toLowerCase();
    for (const p of byVendor) {
      if (p.projectName && subj.includes(p.projectName.toLowerCase())) return p;
      if (p.mfgInvoiceNo && subj.includes(p.mfgInvoiceNo.toLowerCase())) return p;
      if (p.merchInvoiceNo && subj.includes(p.merchInvoiceNo.toLowerCase())) return p;
    }
    // Default to most recent project with that vendor
    return byVendor[0];
  }

  return null;
}

// ── Classify email with Claude ──────────────────────────────────────────────────
async function classifyEmail(email, project) {
  const mfgItems = (project.full.mfg?.items || []).filter(i => i.product);
  const merchItems = (project.full.merch?.items || []).filter(i => i.product);
  const allItems = [...mfgItems, ...merchItems];

  const itemsList = allItems.map((it, i) =>
    `${i + 1}. ${it.exportName || it.product} | HSN: ${it.hsnCode || '—'} | Qty: ${it.qty || '—'} | Pack: ${it.packSize || ''}${it.packUnit || ''} | Price: ₹${it.unitPriceINR || '—'} | Total: ₹${it.totalINR || '—'}`
  ).join('\n');

  const prompt = `You are an AI logistics agent for Sathvam Oils & Spices (Indian food products exporter).

CONTEXT:
- Project: ${project.projectName}
- Buyer: ${project.buyerName}
- MFG Invoice: ${project.mfgInvoiceNo} (${mfgItems.length} items)
- MERCH Invoice: ${project.merchInvoiceNo} (${merchItems.length} items)
- Current Stage: ${project.stage}
- Vendor: ${project.vendorName}

CURRENT INVOICE ITEMS:
${itemsList || 'No items'}

EMAIL FROM LOGISTICS VENDOR:
Subject: ${email.subject}
From: ${email.fromName} <${email.from}>
Date: ${email.date}
Body:
${email.text || '(HTML only — see below)'}
${!email.text && email.html ? email.html.replace(/<[^>]+>/g, ' ').slice(0, 3000) : ''}

Attachments: ${email.attachments.map(a => a.filename).join(', ') || 'None'}

CLASSIFY this email into exactly ONE category and extract relevant data. Respond in JSON only:

{
  "category": "correction" | "confirmation" | "checklist" | "customs_cleared" | "stuffing_update" | "shipping_docs" | "general_query",
  "confidence": 0.0-1.0,
  "summary": "one-line summary of what vendor is saying",
  "corrections": [
    // ONLY if category=correction. Each correction:
    { "itemIndex": 0-based, "field": "hsnCode|qty|packSize|packUnit|exportName|unitPriceINR|weightKg|product", "oldValue": "current", "newValue": "corrected", "reason": "vendor note" }
  ],
  "checklistItems": [
    // ONLY if category=checklist. Items from vendor's checklist:
    { "product": "name", "qty": number, "hsn": "code", "weight": "kg" }
  ],
  "vesselSchedule": {
    // ONLY if category=shipping_docs. Extract vessel info if present:
    "vesselName": "", "voyageNo": "", "etdPort": "", "etdDate": "", "etaPort": "", "etaDate": "", "sailed": true/false
  },
  "shippingDocs": ["BL", "Shipping Bill", "Fumigation Certificate", "Insurance Policy"],
  "replyNeeded": true/false,
  "suggestedReply": "draft reply text if replyNeeded"
}`;

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = resp.content[0]?.text || '';
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { warn('No JSON in Claude response'); return null; }
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    warn('Claude classify error:', e.message);
    return null;
  }
}

// ── Apply corrections to project data ───────────────────────────────────────────
async function handleCorrection(project, classification, email) {
  const corrections = classification.corrections || [];
  if (!corrections.length) {
    log('No specific corrections found, logging for admin review');
    await addLogEntry(project, {
      phase: 'correction',
      action: 'Vendor requested changes but AI could not parse specific corrections',
      detail: classification.summary,
      emailSubject: email.subject,
      emailFrom: email.from,
      needsApproval: true,
      autoAction: false,
    });
    await notifyAdmin(`📧 ${project.projectName}\nVendor sent corrections but AI needs help parsing them.\nSubject: ${email.subject}\n\nPlease review in admin panel.`);
    return;
  }

  const full = project.full;
  const mfgItems = full.mfg?.items || [];
  const merchItems = full.merch?.items || [];
  const allItems = [...mfgItems, ...merchItems];
  const changes = [];

  for (const corr of corrections) {
    const idx = corr.itemIndex;
    if (idx < 0 || idx >= allItems.length) continue;
    const item = allItems[idx];
    const oldVal = item[corr.field];
    item[corr.field] = corr.newValue;

    // If totalINR depends on qty/price, recalculate
    if (corr.field === 'qty' || corr.field === 'unitPriceINR') {
      item.totalINR = String((Number(item.qty) || 0) * (Number(item.unitPriceINR) || 0));
    }
    if (corr.field === 'qty' || corr.field === 'packSize') {
      const ps = Number(item.packSize) || 0;
      const qty = Number(item.qty) || 0;
      if (item.packUnit === 'GM' || item.packUnit === 'ML') item.weightKg = String(parseFloat((qty * ps / 1000).toFixed(3)));
      else item.weightKg = String(parseFloat((qty * ps).toFixed(3)));
    }

    changes.push(`${item.exportName || item.product}: ${corr.field} ${oldVal} → ${corr.newValue} (${corr.reason || ''})`);
  }

  // Split items back to mfg/merch
  full.mfg.items = allItems.slice(0, mfgItems.length);
  full.merch.items = allItems.slice(mfgItems.length);

  // Save updated project
  if (!DRY_RUN) {
    await supabase.from('settings').upsert({ key: project.key, value: full });
  }

  const changeSummary = changes.join('\n');
  log('Applied corrections:', changeSummary);

  await addLogEntry(project, {
    phase: 'correction',
    action: `Applied ${corrections.length} correction(s) from vendor`,
    detail: changeSummary,
    emailSubject: email.subject,
    emailFrom: email.from,
    autoAction: true,
    needsApproval: false,
    corrections,
  });

  // Resend corrected docs by calling the existing API endpoint
  if (!DRY_RUN) {
    try {
      // Get an admin JWT for the API call
      const jwt = await getAdminToken();
      const resp = await fetch(`${API_BASE}/projects/${project.id}/email-logistics-vendor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `sathvam_admin=${jwt}` },
        body: JSON.stringify({ emails: '' }),
      });
      const result = await resp.json();
      if (result.success) {
        log('Corrected docs resent to', result.sentTo);
        await addLogEntry(project, {
          phase: 'correction',
          action: 'Corrected documents resent to vendor',
          detail: `Sent to: ${result.sentTo}`,
          autoAction: true,
        });
      }
    } catch (e) {
      warn('Failed to resend corrected docs:', e.message);
      await notifyAdmin(`⚠️ ${project.projectName}\nApplied corrections but failed to resend docs: ${e.message}`);
    }
  }

  await notifyAdmin(`✏️ ${project.projectName}\nApplied ${corrections.length} correction(s) from ${project.vendorName}:\n${changeSummary}\n\nCorrected docs resent automatically.`);
}

// ── Handle vendor confirmation ──────────────────────────────────────────────────
async function handleConfirmation(project, classification, email) {
  log('Vendor confirmed docs for', project.projectName);

  const full = project.full;
  full.logistics = { ...full.logistics, vendorConfirmed: true, vendorConfirmedDate: new Date().toISOString().slice(0, 10), agentStage: 'confirmed' };

  if (!DRY_RUN) {
    await supabase.from('settings').upsert({ key: project.key, value: full });
  }

  await addLogEntry(project, {
    phase: 'confirmation',
    action: 'Vendor confirmed documents are correct',
    detail: classification.summary,
    emailSubject: email.subject,
    emailFrom: email.from,
    autoAction: true,
  });

  await notifyAdmin(`✅ ${project.projectName}\n${project.vendorName} confirmed all documents are correct.\nReady for checklist / cargo release.`);
}

// ── Handle checklist comparison ─────────────────────────────────────────────────
async function handleChecklist(project, classification, email) {
  const checklistItems = classification.checklistItems || [];
  const mfgItems = (project.full.mfg?.items || []).filter(i => i.product);
  const merchItems = (project.full.merch?.items || []).filter(i => i.product);
  const allItems = [...mfgItems, ...merchItems];

  const results = [];
  let allMatch = true;

  for (const ci of checklistItems) {
    const match = allItems.find(it => {
      const name = (it.exportName || it.product || '').toLowerCase();
      const ciName = (ci.product || '').toLowerCase();
      return name.includes(ciName) || ciName.includes(name);
    });

    if (!match) {
      results.push(`❌ ${ci.product} — NOT FOUND in our invoices`);
      allMatch = false;
    } else {
      const qtyMatch = !ci.qty || Number(ci.qty) === Number(match.qty);
      const hsnMatch = !ci.hsn || ci.hsn === match.hsnCode;
      if (qtyMatch && hsnMatch) {
        results.push(`✅ ${ci.product} — Qty: ${ci.qty || '—'}, HSN: ${ci.hsn || '—'} — MATCH`);
      } else {
        const diffs = [];
        if (!qtyMatch) diffs.push(`Qty: theirs=${ci.qty} ours=${match.qty}`);
        if (!hsnMatch) diffs.push(`HSN: theirs=${ci.hsn} ours=${match.hsnCode}`);
        results.push(`⚠️ ${ci.product} — MISMATCH: ${diffs.join(', ')}`);
        allMatch = false;
      }
    }
  }

  const comparisonReport = results.join('\n');
  log('Checklist comparison:', allMatch ? 'ALL MATCH' : 'DISCREPANCIES FOUND');

  const full = project.full;
  full.logistics = { ...full.logistics, agentStage: allMatch ? 'checklist_verified' : project.stage };

  if (!DRY_RUN) {
    await supabase.from('settings').upsert({ key: project.key, value: full });
  }

  await addLogEntry(project, {
    phase: 'checklist',
    action: allMatch ? `Checklist verified — ${checklistItems.length}/${checklistItems.length} items match` : `Checklist has discrepancies — needs review`,
    detail: comparisonReport,
    emailSubject: email.subject,
    emailFrom: email.from,
    autoAction: true,
    needsApproval: !allMatch, // admin must review if mismatches
    checklistResult: { total: checklistItems.length, matched: results.filter(r => r.startsWith('✅')).length, allMatch },
  });

  if (allMatch) {
    await notifyAdmin(`✅ ${project.projectName}\nChecklist verified — all ${checklistItems.length} items match!\n\n${comparisonReport}\n\nApprove cargo release in admin panel.`);
  } else {
    await notifyAdmin(`⚠️ ${project.projectName}\nChecklist comparison found discrepancies:\n\n${comparisonReport}\n\nReview and resolve in admin panel.`);
  }
}

// ── Handle customs cleared ──────────────────────────────────────────────────────
async function handleCustomsCleared(project, classification, email) {
  log('Customs cleared for', project.projectName);

  const full = project.full;
  full.logistics = { ...full.logistics, agentStage: 'customs_cleared', customsClearedDate: new Date().toISOString().slice(0, 10) };

  if (!DRY_RUN) {
    await supabase.from('settings').upsert({ key: project.key, value: full });
  }

  await addLogEntry(project, {
    phase: 'customs',
    action: 'Customs cleared — shipment moving for stuffing',
    detail: classification.summary,
    emailSubject: email.subject,
    emailFrom: email.from,
    autoAction: true,
  });

  await notifyAdmin(`🛃 ${project.projectName}\nCustoms cleared! Shipment is being moved for stuffing.\n\n${classification.summary}`);
}

// ── Handle stuffing update ──────────────────────────────────────────────────────
async function handleStuffingUpdate(project, classification, email) {
  log('Stuffing update for', project.projectName);

  const full = project.full;
  full.logistics = { ...full.logistics, stuffingDate: new Date().toISOString().slice(0, 10) };

  if (!DRY_RUN) {
    await supabase.from('settings').upsert({ key: project.key, value: full });
  }

  await addLogEntry(project, {
    phase: 'stuffing',
    action: 'Stuffing update received',
    detail: classification.summary,
    emailSubject: email.subject,
    emailFrom: email.from,
    autoAction: true,
  });

  await notifyAdmin(`📦 ${project.projectName}\nStuffing update: ${classification.summary}`);
}

// ── Handle shipping docs (BL, vessel schedule) ──────────────────────────────────
async function handleShippingDocs(project, classification, email) {
  log('Shipping docs received for', project.projectName);

  const vessel = classification.vesselSchedule || {};
  const docs = classification.shippingDocs || [];
  const full = project.full;

  // Save attachments to S3
  const savedAttachments = [];
  if (!DRY_RUN && email.attachments.length > 0) {
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
    for (const att of email.attachments) {
      const s3Key = `logistics-docs/${project.id}/${Date.now()}_${att.filename}`;
      try {
        await s3.send(new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: s3Key,
          Body: att.content,
          ContentType: att.contentType,
        }));
        savedAttachments.push({ filename: att.filename, s3Key, size: att.size, contentType: att.contentType });
        log('Saved attachment to S3:', s3Key);
      } catch (e) { warn('S3 upload failed:', att.filename, e.message); }
    }
  }

  // Update project logistics data
  full.logistics = {
    ...full.logistics,
    agentStage: 'shipping_received',
    vesselName: vessel.vesselName || full.logistics.vesselName || '',
    voyageNo: vessel.voyageNo || '',
    etdPort: vessel.etdPort || '',
    etdDate: vessel.etdDate || '',
    etaPort: vessel.etaPort || '',
    etaDate: vessel.etaDate || '',
    sailed: vessel.sailed || false,
    shippingDocs: [...(full.logistics.shippingDocs || []), ...savedAttachments],
    blReceivedDate: docs.some(d => d.toLowerCase().includes('bl') || d.toLowerCase().includes('bill of lading'))
      ? new Date().toISOString().slice(0, 10) : (full.logistics.blReceivedDate || ''),
  };

  // Draft buyer email
  const buyerEmailDraft = buildBuyerVesselEmail(project, vessel, docs, savedAttachments);
  full.logistics.pendingBuyerEmail = buyerEmailDraft;

  if (!DRY_RUN) {
    await supabase.from('settings').upsert({ key: project.key, value: full });
  }

  await addLogEntry(project, {
    phase: 'shipping',
    action: `Shipping documents received: ${docs.join(', ')}`,
    detail: vessel.vesselName
      ? `Vessel: ${vessel.vesselName} ${vessel.voyageNo || ''}\nETD ${vessel.etdPort || ''}: ${vessel.etdDate || '—'}${vessel.sailed ? ' (Sailed)' : ''}\nETA ${vessel.etaPort || ''}: ${vessel.etaDate || '—'}`
      : classification.summary,
    emailSubject: email.subject,
    emailFrom: email.from,
    autoAction: true,
    needsApproval: true, // admin must approve before sending to buyer
    attachments: savedAttachments.map(a => a.filename),
    vesselSchedule: vessel,
    buyerEmailReady: true,
  });

  await notifyAdmin(`🚢 ${project.projectName}\nShipping docs received from ${project.vendorName}!\n\nDocs: ${docs.join(', ')}\n${vessel.vesselName ? `Vessel: ${vessel.vesselName} ${vessel.voyageNo || ''}\nETD: ${vessel.etdDate || '—'}\nETA: ${vessel.etaDate || '—'}` : ''}\n\n📧 Buyer email drafted — approve in admin panel to send.`);
}

// ── Build buyer vessel schedule email ───────────────────────────────────────────
function buildBuyerVesselEmail(project, vessel, docs, attachments) {
  const full = project.full;
  return {
    subject: `Vessel Schedule — ${project.projectName} — ${vessel.vesselName || 'Shipment'} [${project.mfgInvoiceNo}${project.merchInvoiceNo ? ', ' + project.merchInvoiceNo : ''}]`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto">
        <div style="background:#0A4840;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0">
          <h2 style="margin:0;font-size:18px">🚢 Vessel Schedule — ${project.projectName}</h2>
          <p style="margin:4px 0 0;font-size:13px;color:#a7f3d0">From SATHVAM OILS AND SPICES PVT LTD</p>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;padding:20px 24px;border-radius:0 0 8px 8px">
          <p style="color:#374151;font-size:14px">Dear ${project.buyerName || 'Valued Customer'},</p>
          <p style="color:#374151;font-size:14px">Please find attached the following documents for your reference:</p>

          <ol style="color:#374151;font-size:14px;line-height:2">
            ${docs.map(d => `<li>${d}</li>`).join('')}
          </ol>

          <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:16px 20px;margin:20px 0">
            <h3 style="margin:0 0 10px;color:#166534;font-size:15px">📋 Vessel Schedule</h3>
            <table style="font-size:14px;color:#374151">
              <tr><td style="padding:4px 16px 4px 0;font-weight:700">Vessel</td><td>${vessel.vesselName || '—'} ${vessel.voyageNo ? 'Voy.' + vessel.voyageNo : ''}</td></tr>
              <tr><td style="padding:4px 16px 4px 0;font-weight:700">ETD ${vessel.etdPort || ''}</td><td>${vessel.etdDate || '—'}${vessel.sailed ? ' <strong style="color:#16a34a">(Sailed)</strong>' : ''}</td></tr>
              <tr><td style="padding:4px 16px 4px 0;font-weight:700">ETA ${vessel.etaPort || ''}</td><td>${vessel.etaDate || '—'}</td></tr>
            </table>
          </div>

          <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
            <tr><td style="padding:6px 0;color:#6b7280;width:140px"><strong>MFG Invoice</strong></td><td style="color:#111827">${project.mfgInvoiceNo || '—'}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280"><strong>MERCH Invoice</strong></td><td style="color:#111827">${project.merchInvoiceNo || '—'}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280"><strong>Port of Loading</strong></td><td style="color:#111827">${full.portOfLoading || '—'}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280"><strong>Port of Discharge</strong></td><td style="color:#111827">${full.portOfDischarge || '—'}</td></tr>
          </table>

          <p style="color:#374151;font-size:14px">For any queries, please don't hesitate to reach out.</p>

          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb">
            <p style="margin:0;font-weight:700;color:#0A4840;font-size:13px">SATHVAM OILS AND SPICES PVT LTD</p>
            <p style="margin:2px 0 0;color:#6b7280;font-size:12px">GST: 33ABFCS9387K1ZN | IEC: ABFCS9387K</p>
            <p style="margin:2px 0 0;color:#6b7280;font-size:12px">MOB: +917092177092 | EMAIL: SALES@SATHVAM.IN</p>
          </div>
        </div>
      </div>`,
    // Attach all shipping documents (BL, shipping bill, insurance, fumigation)
    blAttachments: attachments.filter(a =>
      /\b(bl|bill.of.lading|seaway|shipping.?bill|insurance|fumigat|sb\b)/i.test(a.filename)
    ),
    vesselSchedule: vessel,
  };
}

// ── Handle general query — forward to admin ─────────────────────────────────────
async function handleGeneralQuery(project, classification, email) {
  await addLogEntry(project, {
    phase: 'general',
    action: 'Vendor sent a query — forwarded to admin',
    detail: classification.summary,
    emailSubject: email.subject,
    emailFrom: email.from,
    autoAction: false,
    needsApproval: true,
  });

  await notifyAdmin(`💬 ${project.projectName}\nVendor query from ${project.vendorName}:\n\n"${classification.summary}"\n\nSubject: ${email.subject}\n\nPlease reply manually.`);
}

// ── Add log entry to project ────────────────────────────────────────────────────
async function addLogEntry(project, entry) {
  const logEntry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: new Date().toISOString(),
    ...entry,
  };

  if (DRY_RUN) {
    log('DRY RUN — would log:', JSON.stringify(logEntry, null, 2));
    return;
  }

  // Re-read project to avoid stale writes
  const { data: row } = await supabase.from('settings').select('value').eq('key', project.key).single();
  const full = row?.value || project.full;
  full.logisticsLog = full.logisticsLog || [];
  full.logisticsLog.push(logEntry);

  await supabase.from('settings').upsert({ key: project.key, value: full });
  project.full = full;
}

// ── Get admin JWT for API calls ─────────────────────────────────────────────────
async function getAdminToken() {
  const jwt = require('jsonwebtoken');
  // Create a service-level JWT for the agent
  return jwt.sign(
    { id: 'logistics-agent', username: 'logistics-agent', name: 'Logistics Agent', role: 'admin' },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
  );
}

// ── Check for pending buyer email approvals ─────────────────────────────────────
async function checkPendingApprovals(projects) {
  for (const project of projects) {
    const full = project.full;
    const logistics = full.logistics || {};
    const pendingEmail = logistics.pendingBuyerEmail;
    if (!pendingEmail || !logistics.buyerEmailApproved) continue;

    // Admin has approved — send buyer email
    log('Sending approved buyer email for', project.projectName);

    if (!DRY_RUN) {
      try {
        const mailer = nodemailer.createTransport({
          host: process.env.SMTP_HOST || 'smtp.gmail.com',
          port: parseInt(process.env.SMTP_PORT || '465'),
          secure: process.env.SMTP_PORT !== '587',
          auth: { user: IMAP_USER, pass: IMAP_PASS },
        });

        // Get buyer email from project or B2B customer
        let buyerEmail = full.buyerEmail || '';
        if (!buyerEmail && full.b2bOrderId) {
          try {
            const { data: ord } = await supabase.from('b2b_orders').select('customer_id').eq('id', full.b2bOrderId).single();
            if (ord?.customer_id) {
              const { data: cust } = await supabase.from('b2b_customers').select('email').eq('id', ord.customer_id).single();
              if (cust?.email) buyerEmail = cust.email;
            }
          } catch (_) {}
        }
        if (!buyerEmail) {
          warn('No buyer email for project', project.projectName);
          continue;
        }

        // Prepare BL attachments from S3
        const attachments = [];
        if (pendingEmail.blAttachments?.length) {
          const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
          const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
          for (const att of pendingEmail.blAttachments) {
            try {
              const resp = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: att.s3Key }));
              const chunks = []; for await (const chunk of resp.Body) chunks.push(chunk);
              attachments.push({
                filename: att.filename,
                content: Buffer.concat(chunks),
                contentType: att.contentType,
              });
            } catch (e) { warn('S3 download failed:', att.filename, e.message); }
          }
        }

        await mailer.sendMail({
          from: process.env.SMTP_FROM || `"Sathvam Export" <${IMAP_USER}>`,
          to: buyerEmail,
          replyTo: IMAP_USER,
          subject: pendingEmail.subject,
          html: pendingEmail.html,
          attachments,
        });

        // Update project
        full.logistics.agentStage = 'buyer_notified';
        full.logistics.blSharedToCustomerDate = new Date().toISOString().slice(0, 10);
        full.logistics.pendingBuyerEmail = null;
        full.logistics.buyerEmailApproved = false;

        await supabase.from('settings').upsert({ key: project.key, value: full });

        await addLogEntry(project, {
          phase: 'buyer_update',
          action: `Vessel schedule + shipping docs sent to buyer`,
          detail: `Sent to: ${buyerEmail}\nSubject: ${pendingEmail.subject}`,
          autoAction: true,
        });

        await notifyAdmin(`📧 ${project.projectName}\nVessel schedule + BL sent to buyer (${buyerEmail}) ✅`);
      } catch (e) {
        warn('Failed to send buyer email:', e.message);
        await notifyAdmin(`⚠️ ${project.projectName}\nFailed to send buyer email: ${e.message}`);
      }
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────────
async function main() {
  log('Starting logistics agent...', DRY_RUN ? '(DRY RUN)' : '');

  // Validate env
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'ANTHROPIC_API_KEY', 'SMTP_USER', 'SMTP_PASS', 'JWT_SECRET'];
  for (const key of required) {
    if (!process.env[key]) { console.error(`Missing env: ${key}`); process.exit(1); }
  }

  // 1. Load active projects
  const projects = await loadActiveProjects();
  if (!projects.length) { log('No active projects with logistics vendors. Exiting.'); return; }
  log(`Found ${projects.length} active project(s) with logistics vendors`);

  // 2. Check pending approvals first
  await checkPendingApprovals(projects);

  // 3. Collect unique vendor emails (flatten all per-project emails)
  const vendorEmails = [...new Set(projects.flatMap(p => p.vendorEmails))];
  log(`Checking emails from ${vendorEmails.length} vendor(s):`, vendorEmails.join(', '));

  // 4. Fetch unread emails
  const emails = await fetchUnreadEmails(vendorEmails);
  if (!emails.length) { log('No new emails from vendors. Done.'); return; }
  log(`Found ${emails.length} new email(s) to process`);

  // 5. Process each email
  for (const email of emails) {
    log(`\nProcessing: "${email.subject}" from ${email.from}`);

    // Match to project
    const project = matchEmailToProject(email, projects);
    if (!project) {
      warn('Could not match email to any project. Skipping.');
      continue;
    }
    log(`Matched to project: ${project.projectName} (${project.id})`);

    // Classify with Claude
    const classification = await classifyEmail(email, project);
    if (!classification) {
      warn('Could not classify email. Skipping.');
      continue;
    }
    log(`Classification: ${classification.category} (confidence: ${classification.confidence})`);
    log(`Summary: ${classification.summary}`);

    // Low confidence — forward to admin
    if (classification.confidence < 0.6) {
      log('Low confidence — forwarding to admin for manual review');
      await handleGeneralQuery(project, classification, email);
      continue;
    }

    // Act based on category
    switch (classification.category) {
      case 'correction':
        await handleCorrection(project, classification, email);
        break;
      case 'confirmation':
        await handleConfirmation(project, classification, email);
        break;
      case 'checklist':
        await handleChecklist(project, classification, email);
        break;
      case 'customs_cleared':
        await handleCustomsCleared(project, classification, email);
        break;
      case 'stuffing_update':
        await handleStuffingUpdate(project, classification, email);
        break;
      case 'shipping_docs':
        await handleShippingDocs(project, classification, email);
        break;
      default:
        await handleGeneralQuery(project, classification, email);
    }

    await sleep(1000); // pace between emails
  }

  log('\nLogistics agent run complete.');
}

main().catch(err => {
  console.error(LOG_PREFIX, 'Fatal error:', err);
  process.exit(1);
});
