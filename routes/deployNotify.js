'use strict';
/**
 * POST /api/deploy-notify
 * Called by GitHub Actions after a successful frontend or backend deploy.
 * Sends WhatsApp + email notification to admin phones.
 * Auth: x-service-key header (DEPLOY_NOTIFY_KEY in .env)
 */

const express    = require('express');
const nodemailer = require('nodemailer');
const router     = express.Router();

const SERVICE_KEY         = process.env.DEPLOY_NOTIFY_KEY;
const BOTSAILOR_TOKEN     = process.env.BOTSAILOR_API_TOKEN;
const BOTSAILOR_PHONE_ID  = process.env.BOTSAILOR_PHONE_NUMBER_ID || process.env.WA_PHONE_NUMBER_ID;
const BOTSAILOR_SEND_URL  = 'https://botsailor.com/api/v1/whatsapp/send';
const ADMIN_PHONES        = [process.env.WA_ADMIN_PHONE1, process.env.WA_ADMIN_PHONE2].filter(Boolean);

// ── Auth ────────────────────────────────────────────────────────────────────
function serviceAuth(req, res, next) {
  if (!SERVICE_KEY || req.headers['x-service-key'] !== SERVICE_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── WhatsApp helper ─────────────────────────────────────────────────────────
async function sendWA(phone, message) {
  if (!BOTSAILOR_TOKEN || !BOTSAILOR_PHONE_ID) return;
  try {
    const params = new URLSearchParams({
      apiToken:        BOTSAILOR_TOKEN,
      phone_number_id: BOTSAILOR_PHONE_ID,
      phone_number:    phone,
      message,
    });
    await fetch(BOTSAILOR_SEND_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
    });
  } catch (e) {
    console.error('[deploy-notify] WA error:', e.message);
  }
}

// ── Email helper ────────────────────────────────────────────────────────────
async function sendEmail(subject, html) {
  try {
    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   Number(process.env.SMTP_PORT) || 587,
      secure: false,
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from:    process.env.SMTP_FROM,
      to:      process.env.SMTP_USER,
      subject,
      html,
    });
  } catch (e) {
    console.error('[deploy-notify] Email error:', e.message);
  }
}

// ── POST /api/deploy-notify ─────────────────────────────────────────────────
router.post('/', serviceAuth, async (req, res) => {
  const {
    repo    = 'sathvam-frontend',
    branch  = 'main',
    commit  = '',
    message = '',
    author  = '',
    status  = 'success',
    url     = 'https://admin.sathvam.in',
  } = req.body;

  const shortCommit = commit.slice(0, 7);
  const emoji       = status === 'success' ? '✅' : '❌';
  const site        = repo.includes('backend') ? 'api.sathvam.in' : 'admin.sathvam.in';

  // First line of commit message only
  const commitTitle = (message || '').split('\n')[0].slice(0, 120);

  // ── WhatsApp message ──────────────────────────────────────────────────────
  const waMsg = [
    `${emoji} *Sathvam Deployed* — ${site}`,
    ``,
    `📦 Repo: ${repo}`,
    `🌿 Branch: ${branch}`,
    `🔖 Commit: ${shortCommit}`,
    `📝 ${commitTitle}`,
    author ? `👤 By: ${author}` : null,
    ``,
    `🔗 ${url}`,
  ].filter(l => l !== null).join('\n');

  // ── Email ─────────────────────────────────────────────────────────────────
  const emailHtml = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">
      <div style="background:${status==='success'?'#16a34a':'#dc2626'};padding:16px 24px">
        <h2 style="margin:0;color:#fff;font-size:18px">${emoji} Sathvam Deployed — ${site}</h2>
      </div>
      <div style="padding:20px 24px;background:#fff">
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr><td style="padding:6px 0;color:#6b7280;width:90px">Repo</td><td style="padding:6px 0;font-weight:600">${repo}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280">Branch</td><td style="padding:6px 0;font-weight:600">${branch}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280">Commit</td><td style="padding:6px 0;font-family:monospace;font-size:13px">${shortCommit}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280">Message</td><td style="padding:6px 0">${commitTitle}</td></tr>
          ${author ? `<tr><td style="padding:6px 0;color:#6b7280">Author</td><td style="padding:6px 0">${author}</td></tr>` : ''}
          <tr><td style="padding:6px 0;color:#6b7280">Status</td><td style="padding:6px 0;font-weight:700;color:${status==='success'?'#16a34a':'#dc2626'}">${status.toUpperCase()}</td></tr>
        </table>
        <div style="margin-top:16px">
          <a href="${url}" style="background:#16a34a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:700;font-size:14px">Open ${site} →</a>
        </div>
      </div>
      <div style="padding:10px 24px;background:#f9fafb;font-size:12px;color:#9ca3af">Sathvam Auto-Deploy System</div>
    </div>`;

  // Send both in parallel (best effort — don't fail the response)
  await Promise.allSettled([
    ...ADMIN_PHONES.map(p => sendWA(p, waMsg)),
    sendEmail(`${emoji} Deployed: ${site} — ${shortCommit} ${commitTitle}`, emailHtml),
  ]);

  console.log(`[deploy-notify] ${emoji} ${repo}@${shortCommit} deployed to ${site}`);
  res.json({ ok: true, site, commit: shortCommit });
});

module.exports = router;
