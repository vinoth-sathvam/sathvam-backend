/**
 * utils/email.js
 * Shared email helper using nodemailer SMTP config from .env
 */
const nodemailer = require('nodemailer');

function createTransport() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST  || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '465'),
    secure: process.env.SMTP_PORT  !== '587',
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

/**
 * Send a plain or HTML email.
 * @param {string} subject
 * @param {string} html
 * @param {string} [to]  defaults to FINANCE_ALERT_EMAIL or SMTP_USER
 */
async function sendEmail(subject, html, to) {
  const recipient = to || process.env.FINANCE_ALERT_EMAIL || process.env.SMTP_USER;
  if (!recipient) { console.warn('[EMAIL] No recipient configured'); return; }
  try {
    const mailer = createTransport();
    await mailer.sendMail({
      from:    process.env.SMTP_FROM || `Sathvam Finance <${process.env.SMTP_USER}>`,
      to:      recipient,
      subject,
      html,
    });
    console.log(`[EMAIL] Sent: ${subject} → ${recipient}`);
  } catch (e) {
    console.error('[EMAIL] Send error:', e.message);
  }
}

/**
 * Wrap content in a branded HTML email shell.
 */
function emailHtml(title, bodyHtml) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<style>
  body{margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif}
  .wrap{max-width:640px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)}
  .hdr{background:linear-gradient(135deg,#0a1f10,#0f2820);padding:24px 28px;color:#fff}
  .hdr h1{margin:0;font-size:20px;font-weight:700;letter-spacing:.3px}
  .hdr p{margin:4px 0 0;font-size:12px;color:rgba(255,255,255,0.55)}
  .body{padding:24px 28px}
  .section{margin-bottom:20px}
  .section h3{margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.8px;color:#64748b}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{background:#f8fafc;padding:7px 10px;text-align:left;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0}
  td{padding:7px 10px;border-bottom:1px solid #f1f5f9;color:#1e293b}
  .badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700}
  .critical{background:#fef2f2;color:#dc2626}
  .high{background:#fff7ed;color:#c2410c}
  .medium{background:#fefce8;color:#a16207}
  .low{background:#f0fdf4;color:#16a34a}
  .pill{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600}
  .in{background:#f0fdf4;color:#16a34a}
  .out{background:#fef2f2;color:#dc2626}
  .ftr{padding:16px 28px;background:#f8fafc;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <h1>${title}</h1>
    <p>Sathvam Natural Products Pvt. Ltd. · ${new Date().toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric'})}</p>
  </div>
  <div class="body">${bodyHtml}</div>
  <div class="ftr">This is an automated alert from the Sathvam Finance Intelligence System. Do not reply to this email.</div>
</div>
</body>
</html>`;
}

module.exports = { sendEmail, emailHtml };
