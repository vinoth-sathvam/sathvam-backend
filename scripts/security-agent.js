#!/usr/bin/env node
/**
 * Sathvam Security Agent
 * ──────────────────────
 * Run after every patch/major deployment to verify the platform is secure.
 * Emails a full report to vinoth@sathvam.in and exits with code 1 if any
 * critical check fails (so a deploy script can catch it).
 *
 * Usage:
 *   node /home/ubuntu/sathvam-backend/scripts/security-agent.js
 *
 * Checks performed:
 *   1.  HTTP security headers — store, admin, API
 *   2.  SSL certificate validity & expiry
 *   3.  Admin routes require authentication
 *   4.  Customer routes require authentication
 *   5.  Public endpoints expose no PII
 *   6.  Rate limiting is active
 *   7.  CORS is locked to whitelist
 *   8.  ENCRYPTION_KEY is set and valid
 *   9.  API health endpoint responds
 *   10. PM2 process is online
 *   11. Database: customer PII is encrypted (ENC: prefix)
 *   12. Database: order customer PII is encrypted
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const tls            = require('tls');
const { execSync }   = require('child_process');
const nodemailer     = require('nodemailer');
const Anthropic      = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

// ── Config ────────────────────────────────────────────────────────────────────

const REPORT_TO  = 'vinoth@sathvam.in';
const STORE_URL  = 'https://sathvam.in';
const ADMIN_URL  = 'https://admin.sathvam.in';
const API_BASE   = 'https://api.sathvam.in';

const REQUIRED_HEADERS = [
  'strict-transport-security',
  'x-frame-options',
  'x-content-type-options',
];

const CORS_WHITELIST = [
  'https://sathvam.in',
  'https://www.sathvam.in',
  'https://admin.sathvam.in',
];

const PII_FIELDS = ['email', 'phone', 'address', 'pincode', 'aadhaar', 'pan', 'password', 'token'];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function httpFetch(url, opts = {}) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || 8000);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    const text = await res.text().catch(() => '');
    return { status: res.status, headers: res.headers, body: text, ms: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

function tlsCert(hostname) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(443, hostname, { servername: hostname }, () => {
      const cert = socket.getPeerCertificate();
      socket.destroy();
      if (!cert || !cert.valid_to) return reject(new Error('No cert data'));
      const expiry   = new Date(cert.valid_to);
      const daysLeft = Math.floor((expiry - Date.now()) / 86400000);
      resolve({ daysLeft, expiry: expiry.toISOString().slice(0, 10), subject: cert.subject?.CN || hostname });
    });
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('TLS timeout')); });
    socket.on('error', reject);
  });
}

function pm2Status() {
  try {
    const raw  = execSync('pm2 jlist', { timeout: 5000 }).toString();
    const list = JSON.parse(raw);
    return list.map(p => ({
      name:     p.name,
      status:   p.pm2_env?.status,
      restarts: p.pm2_env?.restart_time || 0,
      memory:   Math.round((p.monit?.memory || 0) / 1024 / 1024),
      uptime:   p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
    }));
  } catch { return []; }
}

function pass(name, detail = '')  { return { name, status: 'PASS', detail }; }
function warn(name, detail = '')  { return { name, status: 'WARN', detail }; }
function fail(name, detail = '')  { return { name, status: 'FAIL', detail }; }

// ── Checks ────────────────────────────────────────────────────────────────────

async function checkHeaders(label, url) {
  try {
    const r = await httpFetch(url, { method: 'HEAD' });
    const missing = REQUIRED_HEADERS.filter(h => !r.headers.get(h));
    if (missing.length > 0)
      return fail(`Security Headers: ${label}`, `Missing: ${missing.join(', ')}`);
    // Check HSTS max-age >= 180 days
    const hsts = r.headers.get('strict-transport-security') || '';
    const maxAge = parseInt((hsts.match(/max-age=(\d+)/) || [])[1] || '0');
    if (maxAge < 15552000)
      return warn(`Security Headers: ${label}`, `HSTS max-age too short: ${maxAge}s (need ≥15552000)`);
    return pass(`Security Headers: ${label}`, 'All required headers present');
  } catch (e) {
    return fail(`Security Headers: ${label}`, e.message);
  }
}

async function checkSSL(hostname) {
  try {
    const { daysLeft, expiry } = await tlsCert(hostname);
    if (daysLeft < 14)  return fail(`SSL: ${hostname}`, `Expires in ${daysLeft} days (${expiry}) — RENEW NOW`);
    if (daysLeft < 30)  return warn(`SSL: ${hostname}`, `Expires in ${daysLeft} days (${expiry})`);
    return pass(`SSL: ${hostname}`, `Valid for ${daysLeft} more days (expires ${expiry})`);
  } catch (e) {
    return fail(`SSL: ${hostname}`, e.message);
  }
}

async function checkAdminAuth() {
  const routes = [
    `${API_BASE}/api/webstore-orders`,
    `${API_BASE}/api/users`,
    `${API_BASE}/api/payroll`,
    `${API_BASE}/api/finance/dashboard`,
  ];
  const exposed = [];
  for (const url of routes) {
    try {
      const r = await httpFetch(url);
      if (r.status === 200) exposed.push(url.replace(API_BASE, ''));
    } catch { /* network error = not exposed */ }
  }
  if (exposed.length > 0)
    return fail('Admin Route Auth', `Unauthenticated access to: ${exposed.join(', ')}`);
  return pass('Admin Route Auth', 'All admin routes require authentication');
}

async function checkCustomerAuth() {
  const routes = [
    `${API_BASE}/api/customer/orders`,
    `${API_BASE}/api/customer/me`,
  ];
  const exposed = [];
  for (const url of routes) {
    try {
      const r = await httpFetch(url);
      if (r.status === 200) exposed.push(url.replace(API_BASE, ''));
    } catch { /* ok */ }
  }
  if (exposed.length > 0)
    return fail('Customer Route Auth', `Unauthenticated access to: ${exposed.join(', ')}`);
  return pass('Customer Route Auth', 'All customer routes require authentication');
}

async function checkPublicPII() {
  try {
    const r = await httpFetch(`${API_BASE}/api/public/products`);
    const products = JSON.parse(r.body);
    const found = [];
    for (const p of (Array.isArray(products) ? products : []).slice(0, 5)) {
      for (const key of Object.keys(p)) {
        if (PII_FIELDS.includes(key.toLowerCase())) found.push(key);
      }
    }
    if (found.length > 0)
      return fail('Public Endpoint PII', `PII fields found in public response: ${[...new Set(found)].join(', ')}`);
    return pass('Public Endpoint PII', 'No PII fields in public product responses');
  } catch (e) {
    return warn('Public Endpoint PII', `Could not check: ${e.message}`);
  }
}

async function checkRateLimiting() {
  try {
    const r = await httpFetch(`${API_BASE}/health`);
    const limitHdr = r.headers.get('ratelimit-limit') || r.headers.get('x-ratelimit-limit');
    if (!limitHdr)
      return warn('Rate Limiting', 'Rate limit headers not found on /health');
    const limit = parseInt(limitHdr);
    if (limit > 10000)
      return warn('Rate Limiting', `Limit suspiciously high: ${limit} — verify middleware is active`);
    return pass('Rate Limiting', `Active — limit: ${limit} req/window`);
  } catch (e) {
    return warn('Rate Limiting', e.message);
  }
}

async function checkCORS() {
  const issues = [];
  // Evil origin must be rejected
  try {
    const evil = await httpFetch(`${API_BASE}/health`, {
      headers: { Origin: 'https://evil-hacker.com' },
    });
    const acao = evil.headers.get('access-control-allow-origin') || '';
    if (acao === '*' || acao === 'https://evil-hacker.com')
      issues.push('evil origin is allowed!');
  } catch { /* ok */ }

  // Whitelisted origins must be allowed
  for (const origin of CORS_WHITELIST.slice(0, 2)) {
    try {
      const r = await httpFetch(`${API_BASE}/health`, { headers: { Origin: origin } });
      const acao = r.headers.get('access-control-allow-origin') || '';
      if (!acao) issues.push(`${origin} not in ACAO response`);
    } catch { /* ok */ }
  }

  if (issues.length > 0)
    return fail('CORS Whitelist', issues.join('; '));
  return pass('CORS Whitelist', 'Whitelist enforced, unauthorized origins rejected');
}

function checkEncryptionKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) return fail('ENCRYPTION_KEY', 'Not set in environment');
  try {
    const buf = Buffer.from(key, 'base64');
    if (buf.length !== 32) return fail('ENCRYPTION_KEY', `Invalid length: ${buf.length} bytes (need 32)`);
    return pass('ENCRYPTION_KEY', '32-byte AES-256 key is set');
  } catch {
    return fail('ENCRYPTION_KEY', 'Cannot decode — must be valid base64');
  }
}

async function checkAPIHealth() {
  try {
    const r = await httpFetch(`${API_BASE}/health`, { timeout: 5000 });
    if (r.status !== 200) return fail('API Health', `HTTP ${r.status}`);
    const body = JSON.parse(r.body);
    if (body.status !== 'ok') return warn('API Health', `Unexpected status: ${body.status}`);
    return pass('API Health', `OK — version ${body.version || 'unknown'} (${r.ms}ms)`);
  } catch (e) {
    return fail('API Health', e.message);
  }
}

function checkPM2() {
  const procs = pm2Status();
  const api   = procs.find(p => p.name === 'sathvam-api');
  if (!api) return fail('PM2 Process', 'sathvam-api not found in PM2 list');
  if (api.status !== 'online') return fail('PM2 Process', `Status: ${api.status}`);
  if (api.restarts > 200) return warn('PM2 Process', `Online but ${api.restarts} restarts — investigate crash logs`);
  if (api.restarts > 50)  return warn('PM2 Process', `Online with ${api.restarts} restarts`);
  return pass('PM2 Process', `Online — ${api.restarts} restarts, ${api.memory}MB RAM`);
}

async function checkDBEncryption(table, field) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  try {
    const { data, error } = await supabase.from(table).select(field).limit(20);
    if (error) return warn(`DB Encryption: ${table}`, `Query failed: ${error.message}`);
    if (!data || data.length === 0) return pass(`DB Encryption: ${table}`, 'No rows to check');

    let plain = 0, encrypted = 0, nulls = 0;
    for (const row of data) {
      let val = row[field];
      // For JSONB customer field, check email inside it
      if (typeof val === 'object' && val !== null) val = val.email || val.name || null;
      if (!val)                          nulls++;
      else if (String(val).startsWith('ENC:')) encrypted++;
      else                               plain++;
    }

    const total = plain + encrypted;
    if (plain > 0 && total > 0) {
      const pct = Math.round((plain / total) * 100);
      if (pct > 5) return fail(`DB Encryption: ${table}`, `${plain}/${total} rows have plaintext PII (${pct}%) — run backfill`);
      return warn(`DB Encryption: ${table}`, `${plain}/${total} rows not yet encrypted — run backfill`);
    }
    return pass(`DB Encryption: ${table}`, `${encrypted} rows verified encrypted`);
  } catch (e) {
    return warn(`DB Encryption: ${table}`, e.message);
  }
}

// ── Run all checks ────────────────────────────────────────────────────────────

async function runAllChecks() {
  const results = await Promise.allSettled([
    checkHeaders('sathvam.in',       STORE_URL),
    checkHeaders('admin.sathvam.in', ADMIN_URL),
    checkHeaders('api.sathvam.in',   API_BASE),
    checkSSL('sathvam.in'),
    checkSSL('admin.sathvam.in'),
    checkSSL('api.sathvam.in'),
    checkAdminAuth(),
    checkCustomerAuth(),
    checkPublicPII(),
    checkRateLimiting(),
    checkCORS(),
    Promise.resolve(checkEncryptionKey()),
    checkAPIHealth(),
    Promise.resolve(checkPM2()),
    checkDBEncryption('customers',      'email'),
    checkDBEncryption('webstore_orders','customer'),
  ]);

  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return fail(`Check #${i + 1}`, r.reason?.message || 'Unknown error');
  });
}

// ── Claude analysis ───────────────────────────────────────────────────────────

async function analyzeWithClaude(results) {
  if (!process.env.ANTHROPIC_API_KEY) return 'Claude analysis skipped — ANTHROPIC_API_KEY not set.';
  try {
    const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const summary = results.map(r => `[${r.status}] ${r.name}: ${r.detail}`).join('\n');
    const msg = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `You are a security analyst reviewing automated checks for Sathvam, a cold-pressed oil e-commerce platform.

Check results:
${summary}

Write a concise security report with three sections:
1. Executive Summary (2 sentences — overall security posture)
2. Issues Requiring Action (bulleted, most critical first — only include FAIL/WARN items)
3. Observations (brief non-critical notes)

Be direct. No fluff.`,
      }],
    });
    return msg.content[0]?.text || 'No response from Claude.';
  } catch (e) {
    return `Claude analysis unavailable: ${e.message}`;
  }
}

// ── Email report ──────────────────────────────────────────────────────────────

function statusBadge(status) {
  const styles = {
    PASS: 'background:#dcfce7;color:#16a34a;border:1px solid #86efac',
    WARN: 'background:#fef9c3;color:#a16207;border:1px solid #fde047',
    FAIL: 'background:#fee2e2;color:#dc2626;border:1px solid #fca5a5',
  };
  return `<span style="${styles[status] || ''};padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700">${status}</span>`;
}

function buildEmailHtml(results, analysis, meta) {
  const counts  = { PASS: 0, WARN: 0, FAIL: 0 };
  results.forEach(r => counts[r.status]++);
  const overall = counts.FAIL > 0 ? 'FAIL' : counts.WARN > 0 ? 'WARN' : 'PASS';
  const overallColors = { PASS: '#16a34a', WARN: '#a16207', FAIL: '#dc2626' };
  const overallBg     = { PASS: '#dcfce7', WARN: '#fef9c3', FAIL: '#fee2e2' };

  const rows = results.map((r, i) => `
    <tr style="border-bottom:1px solid #f3f4f6">
      <td style="padding:8px 10px;color:#6b7280;font-size:12px">${i + 1}</td>
      <td style="padding:8px 10px;font-size:13px">${r.name}</td>
      <td style="padding:8px 10px">${statusBadge(r.status)}</td>
    </tr>`).join('');

  const failures = results.filter(r => r.status !== 'PASS');
  const failureDetails = failures.length === 0 ? '' : `
    <div style="margin-top:20px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
      <div style="background:#f9fafb;padding:10px 16px;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:1px">Issues Detail</div>
      ${failures.map(r => `
        <div style="padding:12px 16px;border-top:1px solid #e5e7eb">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            ${statusBadge(r.status)}
            <strong style="font-size:13px">${r.name}</strong>
          </div>
          <div style="font-size:12px;color:#6b7280;margin-left:4px">${r.detail}</div>
        </div>`).join('')}
    </div>`;

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,sans-serif">
<div style="max-width:600px;margin:24px auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">

  <div style="background:#1a5c2a;padding:20px 24px">
    <div style="color:#f5a800;font-size:18px;font-weight:900;letter-spacing:2px">SATHVAM</div>
    <div style="color:rgba(255,255,255,0.8);font-size:13px;margin-top:2px">Security Verification Report</div>
  </div>

  <div style="padding:20px 24px">

    <div style="background:${overallBg[overall]};border:1px solid;border-color:${overallColors[overall]}40;border-radius:8px;padding:14px 18px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center">
      <div>
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Overall Status</div>
        <div style="font-size:22px;font-weight:900;color:${overallColors[overall]}">${overall}</div>
      </div>
      <div style="text-align:right;font-size:12px;color:#6b7280">
        ${meta.total} checks · ${counts.PASS} passed · ${counts.WARN} warnings · ${counts.FAIL} failed<br>
        ${meta.date} · Ran in ${meta.duration}s
      </div>
    </div>

    <div style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:20px">
      <div style="background:#f9fafb;padding:10px 16px;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:1px">AI Security Analysis</div>
      <div style="padding:14px 16px;font-size:13px;color:#374151;white-space:pre-wrap;line-height:1.7">${analysis}</div>
    </div>

    <div style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
      <div style="background:#f9fafb;padding:10px 16px;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:1px">Check Results</div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:#f3f4f6">
          <th style="padding:8px 10px;text-align:left;font-size:11px;color:#6b7280">#</th>
          <th style="padding:8px 10px;text-align:left;font-size:11px;color:#6b7280">Check</th>
          <th style="padding:8px 10px;text-align:left;font-size:11px;color:#6b7280">Status</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    ${failureDetails}

  </div>

  <div style="background:#f9fafb;padding:12px 24px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;text-align:center">
    Sathvam Security Agent · ${meta.date} · Exit code: ${meta.exitCode}
  </div>

</div></body></html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const start = Date.now();
  console.log('Sathvam Security Agent');
  console.log('======================');

  // Validate required env vars
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SMTP_USER', 'SMTP_PASS'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error('FATAL: Missing env vars:', missing.join(', '));
    process.exit(1);
  }

  console.log('Running checks...');
  const results = await runAllChecks();

  // Console summary
  results.forEach(r => {
    const icon = r.status === 'PASS' ? '✓' : r.status === 'WARN' ? '!' : '✗';
    console.log(`  ${icon} [${r.status}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  });

  const duration = ((Date.now() - start) / 1000).toFixed(1);
  const counts   = { PASS: 0, WARN: 0, FAIL: 0 };
  results.forEach(r => counts[r.status]++);
  const overall  = counts.FAIL > 0 ? 'FAIL' : counts.WARN > 0 ? 'WARN' : 'PASS';

  console.log(`\nResult: ${overall} — ${counts.PASS} passed, ${counts.WARN} warnings, ${counts.FAIL} failed (${duration}s)`);

  // Claude analysis
  console.log('Getting Claude analysis...');
  const analysis = await analyzeWithClaude(results);

  // Build and send email
  const meta = {
    date:     new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }),
    total:    results.length,
    duration,
    exitCode: counts.FAIL > 0 ? 1 : 0,
  };
  const html    = buildEmailHtml(results, analysis, meta);
  const subject = `[${overall}] Sathvam Security Check — ${meta.date}`;

  try {
    const mailer = nodemailer.createTransport({
      host:   process.env.SMTP_HOST || 'smtp.gmail.com',
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await mailer.sendMail({
      from:    process.env.SMTP_FROM || 'Sathvam Security <noreply@sathvam.in>',
      to:      REPORT_TO,
      subject,
      html,
    });
    console.log(`Report emailed to ${REPORT_TO}`);
  } catch (e) {
    console.error('Email failed:', e.message);
  }

  process.exit(counts.FAIL > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Security agent crashed:', err);
  process.exit(1);
});
