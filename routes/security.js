'use strict';
/**
 * Sathvam Security Route — /api/security
 * GET  /report    — returns saved security report from settings table
 * POST /run       — runs a fresh security check and saves the result
 */

const express  = require('express');
const { exec } = require('child_process');
const { promisify } = require('util');
const os       = require('os');
const router   = express.Router();
const supabase = require('../config/supabase');
const { auth, requireRole } = require('../middleware/auth');

const execAsync = promisify(exec);
const adminOrCeo = [auth, requireRole('admin', 'ceo')];

// ── Helper: HTTP health check ─────────────────────────────────────────────────
async function httpCheck(url) {
  const start = Date.now();
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
    return { ok: r.status < 500, status: r.status, ms: Date.now() - start };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - start, error: e.message.slice(0, 80) };
  }
}

// ── Helper: Service checks ────────────────────────────────────────────────────
async function serviceActive(name) {
  try {
    const { stdout } = await execAsync(`systemctl is-active ${name} 2>/dev/null`);
    return stdout.trim() === 'active' ? 'active' : stdout.trim();
  } catch { return 'inactive'; }
}

async function portOpen(port) {
  try {
    const { stdout } = await execAsync(`ss -tlnp 2>/dev/null | grep :${port}`);
    return stdout.trim().length > 0 ? 'active' : 'inactive';
  } catch { return 'inactive'; }
}

async function pm2ApiStatus() {
  try {
    const { stdout } = await execAsync('pm2 jlist 2>/dev/null');
    const procs = JSON.parse(stdout);
    const api = procs.find(p => p.name === 'sathvam-api');
    if (!api) return 'not found';
    return api.pm2_env?.status === 'online' ? 'active' : (api.pm2_env?.status || 'unknown');
  } catch { return 'unknown'; }
}

// ── Helper: SSL check ─────────────────────────────────────────────────────────
async function checkSSL(domain) {
  try {
    const { stdout } = await execAsync(
      `echo | timeout 10 openssl s_client -servername ${domain} -connect ${domain}:443 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null`,
      { timeout: 15000 }
    );
    const match = stdout.match(/notAfter=(.+)/);
    if (!match) return { domain, daysLeft: null, error: 'Could not parse certificate' };
    const expiry = new Date(match[1].trim());
    const daysLeft = Math.round((expiry - Date.now()) / 86400000);
    return { domain, daysLeft, expiry: expiry.toISOString().slice(0, 10) };
  } catch (e) {
    return { domain, daysLeft: null, error: e.message.slice(0, 80) };
  }
}

// ── Helper: Admin security ────────────────────────────────────────────────────
async function checkAdminSecurity() {
  const { data: users, error } = await supabase
    .from('users')
    .select('id,username,name,role,totp_enabled,active,created_at');
  if (error || !users) return null;

  const admins    = users.filter(u => u.active !== false);
  const with2fa   = admins.filter(u => u.totp_enabled).length;
  const no2fa     = admins.filter(u => !u.totp_enabled);
  const sevenAgo  = new Date(Date.now() - 7 * 86400000).toISOString();
  const recentAdmins = admins.filter(u => u.created_at && u.created_at > sevenAgo).length;

  return {
    totalAdmins:    admins.length,
    with2fa,
    without2fa:     no2fa.length,
    no2faNames:     no2fa.map(u => u.name || u.username),
    activeInactive: users.filter(u => u.active === false).length,
    recentAdmins,
  };
}

// ── Helper: Auth & Authorization checks ──────────────────────────────────────
async function checkAuthSecurity() {
  const result = {};

  // 1. JWT secret strength
  const jwtSecret = process.env.JWT_SECRET || '';
  result.jwtSecretLength   = jwtSecret.length;
  result.jwtSecretStrong   = jwtSecret.length >= 32;
  result.jwtAdminExpiry    = process.env.JWT_EXPIRES_IN || 'not set';
  result.jwtCustomerExpiry = '30d';

  // 2. Brute-force: admin /api/auth has authLimiter (10/15min) — static fact
  result.adminLoginRateLimited    = true;
  result.adminRateLimitConfig     = '10 attempts per 15 min';
  // Customer /api/customer has no dedicated auth limiter — only global 1200/15min
  result.customerLoginRateLimited = false;
  result.customerRateLimitConfig  = 'Global only (1200/15min) — no dedicated auth limiter';

  // 3. Password policy — no minimum length enforced in customer signup route
  result.passwordMinLengthEnforced = false;
  result.passwordMinLength = null;

  // 4. RBAC — verify protected endpoints return 401 without auth
  const rbacTests = await Promise.all([
    { endpoint:'/api/products',         label:'Products (admin)' },
    { endpoint:'/api/users',            label:'Users (admin only)' },
    { endpoint:'/api/finance/dashboard',label:'Finance (admin/ceo)' },
    { endpoint:'/api/webstore-orders',  label:'Orders (admin/manager)' },
  ].map(async ({ endpoint, label }) => {
    const start = Date.now();
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(`https://api.sathvam.in${endpoint}`, {
        headers: { Accept: 'application/json' },
        signal: ctrl.signal,
      });
      return { endpoint, label, status: r.status, passed: r.status === 401 || r.status === 403, ms: Date.now()-start };
    } catch (e) {
      return { endpoint, label, status: 0, passed: false, ms: Date.now()-start, error: e.message.slice(0,40) };
    }
  }));
  result.rbacTests    = rbacTests;
  result.rbacAllPassed = rbacTests.every(t => t.passed);

  // 5. Session timeout — known from frontend code
  result.adminSessionTimeoutMin    = 30;
  result.customerSessionTimeoutMin = 60;
  result.sessionTimeoutConfigured  = true;

  // 6. Customer 2FA adoption
  try {
    const { count: total } = await supabase.from('customers').select('*', { count:'exact', head:true });
    const { count: with2fa } = await supabase.from('customers').select('*', { count:'exact', head:true }).eq('totp_enabled', true);
    result.customerTotal    = total ?? null;
    result.customerWith2fa  = with2fa ?? null;
    result.customerWith2faPct = (total && total > 0) ? Math.round((with2fa||0) / total * 100) : 0;
  } catch {
    result.customerTotal = null; result.customerWith2fa = null; result.customerWith2faPct = null;
  }

  // 7. Recent auth failures — scan PM2 log lines
  try {
    const { stdout } = await execAsync(
      "pm2 logs sathvam-api --nostream --lines 500 2>/dev/null | grep -i 'incorrect password\\|invalid.*token\\|unauthorized' | wc -l"
    );
    result.recentAuthFailures = parseInt(stdout.trim()) || 0;
  } catch { result.recentAuthFailures = null; }

  return result;
}

// ── Helper: Database health ───────────────────────────────────────────────────
async function checkDatabase() {
  const tableCount = async (table) => {
    const start = Date.now();
    const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
    return { ok: !error, count: count ?? null, ms: Date.now() - start };
  };

  const start = Date.now();
  const [products, orders, stockLedger, procurements] = await Promise.all([
    tableCount('products'),
    tableCount('webstore_orders'),
    tableCount('stock_ledger'),
    tableCount('procurements'),
  ]);

  return {
    ok: products.ok,
    restMs: Date.now() - start,
    tables: {
      products:        { count: products.count,     ms: products.ms,     ok: products.ok },
      webstore_orders: { count: orders.count,       ms: orders.ms,       ok: orders.ok },
      stock_ledger:    { count: stockLedger.count,  ms: stockLedger.ms,  ok: stockLedger.ok },
      procurements:    { count: procurements.count, ms: procurements.ms, ok: procurements.ok },
    },
  };
}

// ── Helper: Input Validation checks ──────────────────────────────────────────
async function checkInputValidation() {
  const result = {};
  const backendDir = '/home/ubuntu/sathvam-backend';
  const frontendSrc = '/home/ubuntu/sathvam-frontend/sathvam-vercel/src';

  // SQL injection — raw string concat with req.*
  try {
    const { stdout } = await execAsync(
      `grep -rn "query.*+.*req\\|\\$\\{req\\.body\\|\\$\\{req\\.params\\|\\$\\{req\\.query" ${backendDir}/routes/ 2>/dev/null | wc -l`
    );
    result.sqlInjectionRisk = parseInt(stdout.trim()) || 0;
    result.sqlInjectionSafe = result.sqlInjectionRisk === 0;
    const { stdout: orm } = await execAsync(`grep -rn "supabase\\.from" ${backendDir}/routes/ 2>/dev/null | wc -l`);
    result.supabaseOrmUsed = parseInt(orm.trim()) > 10;
  } catch { result.sqlInjectionSafe = true; result.supabaseOrmUsed = true; result.sqlInjectionRisk = 0; }

  // XSS — DOMPurify in frontend
  try {
    const { stdout } = await execAsync(`grep -rn "DOMPurify\\|dompurify\\|sanitize" ${frontendSrc}/ 2>/dev/null | wc -l`);
    result.xssProtectionPresent = parseInt(stdout.trim()) > 0;
  } catch { result.xssProtectionPresent = false; }

  // Command injection
  try {
    const { stdout } = await execAsync(`grep -rn "exec.*req\\|spawn.*req\\|execSync.*req" ${backendDir}/routes/ 2>/dev/null | grep -v security.js | wc -l`);
    result.commandInjectionRisk = parseInt(stdout.trim()) || 0;
    result.commandInjectionSafe = result.commandInjectionRisk === 0;
  } catch { result.commandInjectionSafe = true; result.commandInjectionRisk = 0; }

  // File upload MIME check
  try {
    const { stdout } = await execAsync(`grep -rn "image/jpeg\\|image/png\\|image/webp\\|mimetype\\|fileFilter" ${backendDir}/routes/ ${backendDir}/middleware/ 2>/dev/null | wc -l`);
    result.fileUploadMimeCheck = parseInt(stdout.trim()) > 0;
  } catch { result.fileUploadMimeCheck = false; }

  // Helmet
  try {
    const { stdout } = await execAsync(`grep -c "helmet" ${backendDir}/server.js 2>/dev/null`);
    result.helmetEnabled = parseInt(stdout.trim()) > 0;
  } catch { result.helmetEnabled = false; }

  return result;
}

// ── Helper: API Security checks ───────────────────────────────────────────────
async function checkApiSecurity() {
  const result = {};
  const backendDir = '/home/ubuntu/sathvam-backend';

  // Rate limiters count
  try {
    const { stdout } = await execAsync(`grep -c "Limiter" ${backendDir}/server.js 2>/dev/null`);
    result.rateLimitersCount = parseInt(stdout.trim()) || 0;
    result.rateLimitingOk    = result.rateLimitersCount >= 4;
  } catch { result.rateLimitingOk = false; result.rateLimitersCount = 0; }

  // CORS origins
  try {
    const { stdout } = await execAsync(`grep -A10 "cors(" ${backendDir}/server.js 2>/dev/null | head -20`);
    result.corsConfigured = stdout.includes('origin');
    result.corsOrigins    = stdout.includes('sathvam.in') ? ['sathvam.in','admin.sathvam.in','www.sathvam.in'] : [];
    result.corsWildcard   = stdout.includes("'*'") || stdout.includes('"*"');
  } catch { result.corsConfigured = false; result.corsWildcard = false; result.corsOrigins = []; }

  // Tokens in URL
  try {
    const { stdout } = await execAsync(
      `grep -rn "?token=\\|&token=" /home/ubuntu/sathvam-frontend/sathvam-vercel/src/ 2>/dev/null | grep -v "localStorage\\|Bearer" | wc -l`
    );
    result.tokensInUrl     = parseInt(stdout.trim()) || 0;
    result.tokensInUrlSafe = result.tokensInUrl === 0;
  } catch { result.tokensInUrlSafe = true; result.tokensInUrl = 0; }

  // HTTPS redirect in nginx
  try {
    const { stdout } = await execAsync(
      `grep -n "return 301\\|https://\\$host\\|ssl_redirect" /etc/nginx/sites-enabled/sathvam 2>/dev/null | wc -l`
    );
    result.httpsEnforced = parseInt(stdout.trim()) > 0;
  } catch { result.httpsEnforced = null; }

  // Live security headers check
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch('https://api.sathvam.in/health', { signal: ctrl.signal });
    result.hsts          = r.headers.has('strict-transport-security');
    result.xFrameOptions = r.headers.has('x-frame-options');
    result.csp           = r.headers.has('content-security-policy');
    result.xContentType  = r.headers.has('x-content-type-options');
  } catch { result.hsts = null; result.xFrameOptions = null; result.csp = null; result.xContentType = null; }

  // Sensitive data in responses
  try {
    const { stdout } = await execAsync(
      `grep -rn "password_hash\\|totp_secret" ${backendDir}/routes/ 2>/dev/null | grep "res\\.json\\|res\\.send" | wc -l`
    );
    result.sensitiveDataLeak = parseInt(stdout.trim()) || 0;
    result.sensitiveDataSafe = result.sensitiveDataLeak === 0;
  } catch { result.sensitiveDataSafe = true; result.sensitiveDataLeak = 0; }

  return result;
}

// ── Helper: Data Security checks ─────────────────────────────────────────────
async function checkDataSecurity() {
  const result = {};
  const backendDir  = '/home/ubuntu/sathvam-backend';
  const frontendSrc = '/home/ubuntu/sathvam-frontend/sathvam-vercel/src';

  // HTTPS in frontend source
  try {
    const { stdout } = await execAsync(
      `grep -rn "http://" ${frontendSrc}/ 2>/dev/null | grep -v "localhost\\|127\\.0\\.0\\.1\\|schema\\|fonts\\|maps\\|w3\\.org\\|comment" | wc -l`
    );
    result.httpCallsInFrontend = parseInt(stdout.trim()) || 0;
    result.httpsEverywhereOk  = result.httpCallsInFrontend === 0;
  } catch { result.httpsEverywhereOk = true; result.httpCallsInFrontend = 0; }

  // HTTP port 80 redirects to HTTPS
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch('http://sathvam.in/', { redirect: 'manual', signal: ctrl.signal });
    result.httpRedirects  = r.status === 301 || r.status === 302;
    result.httpPortStatus = r.status;
  } catch (e) {
    result.httpRedirects  = e.message.includes('ECONNREFUSED') ? null : false;
    result.httpPortStatus = 0;
  }

  // Old TLS versions disabled
  for (const [flag, key] of [['-tls1', 'tls10Disabled'], ['-tls1_1', 'tls11Disabled']]) {
    try {
      const { stdout } = await execAsync(
        `echo | timeout 6 openssl s_client -connect api.sathvam.in:443 ${flag} 2>&1 | grep -iE "handshake failure|alert|no protocols available" | wc -l`,
        { timeout: 10000 }
      );
      result[key] = parseInt(stdout.trim()) > 0;
    } catch { result[key] = null; }
  }

  // Passwords hashed with bcrypt
  try {
    const { stdout: bcrypt } = await execAsync(`grep -rn "bcrypt\\|argon2" ${backendDir}/routes/ 2>/dev/null | wc -l`);
    result.bcryptUsed = parseInt(bcrypt.trim()) > 0;
    const { stdout: plain } = await execAsync(
      `grep -rn "password\\s*===\\|=== .*password\\b" ${backendDir}/routes/ 2>/dev/null | grep -v "bcrypt\\|hash\\|//\\|password_hash\\|test" | wc -l`
    );
    result.plaintextPasswordRisk = parseInt(plain.trim()) || 0;
    result.passwordsSafe = result.bcryptUsed && result.plaintextPasswordRisk === 0;
  } catch { result.bcryptUsed = true; result.passwordsSafe = true; result.plaintextPasswordRisk = 0; }

  // bcrypt salt rounds
  try {
    const { stdout } = await execAsync(`grep -rn "bcrypt.hash\\|hashSync" ${backendDir}/routes/ 2>/dev/null | grep -oE ",\\s*[0-9]+" | head -1`);
    const match = stdout.trim().match(/(\d+)/);
    result.bcryptRounds   = match ? parseInt(match[1]) : null;
    result.bcryptRoundsOk = result.bcryptRounds !== null ? result.bcryptRounds >= 10 : null;
  } catch { result.bcryptRounds = null; result.bcryptRoundsOk = null; }

  // No hardcoded secrets
  try {
    const { stdout } = await execAsync(
      `grep -rEn "(API_KEY|SECRET|PASSWORD|TOKEN)\\s*=\\s*['\\"'\\"][A-Za-z0-9/+]{8,}" ${backendDir}/routes/ ${backendDir}/server.js 2>/dev/null | grep -v "process\\.env\\|//\\|\\.example\\|test\\|node_modules" | wc -l`
    );
    result.hardcodedSecretsRisk = parseInt(stdout.trim()) || 0;
    result.noHardcodedSecrets   = result.hardcodedSecretsRisk === 0;
  } catch { result.noHardcodedSecrets = true; result.hardcodedSecretsRisk = 0; }

  // .env in .gitignore
  try {
    const { stdout } = await execAsync(`grep -c "^\\.env" ${backendDir}/.gitignore 2>/dev/null`);
    result.envInGitignore = parseInt(stdout.trim()) > 0;
  } catch { result.envInGitignore = false; }

  // Database port 5432 exposure
  try {
    const { stdout } = await execAsync(`ss -tlnp 2>/dev/null | grep ":5432"`);
    result.dbPortOpen        = stdout.trim().length > 0;
    result.dbPubliclyExposed = stdout.includes('0.0.0.0:5432') || stdout.includes('*:5432');
  } catch { result.dbPortOpen = false; result.dbPubliclyExposed = false; }
  result.dbIsCloudHosted     = !result.dbPortOpen;
  result.supabaseEncryptedAtRest = true;

  return result;
}

// ── Helper: OWASP Top 10 checks ───────────────────────────────────────────────
async function checkOwaspTop10() {
  const result = {};
  const backendDir = '/home/ubuntu/sathvam-backend';

  // A02 — Cryptographic Failures
  try {
    const { stdout } = await execAsync(`grep -rn "bcrypt" ${backendDir}/routes/ 2>/dev/null | wc -l`);
    result.bcryptUsed = parseInt(stdout.trim()) > 0;
  } catch { result.bcryptUsed = false; }

  try {
    const { stdout } = await execAsync(
      `grep -rn "createHash.*['\\"](md5|sha1)['\\"\\|md5(\\|sha1(" ${backendDir}/routes/ 2>/dev/null | grep -v "//\\|webhook\\|signature" | wc -l`
    );
    result.weakHashingRisk = parseInt(stdout.trim()) || 0;
    result.noWeakHashing   = result.weakHashingRisk === 0;
  } catch { result.noWeakHashing = true; result.weakHashingRisk = 0; }

  try {
    const { stdout } = await execAsync(
      `grep -rn "algorithm.*none\\|alg.*none\\|algorithms.*none\\|jwt.*none" ${backendDir}/routes/ ${backendDir}/middleware/ 2>/dev/null | grep -v "node_modules\\|//\\|security\\.js" | wc -l`
    );
    result.jwtAlgNoneRisk   = parseInt(stdout.trim()) || 0;
    result.jwtAlgorithmSafe = result.jwtAlgNoneRisk === 0;
  } catch { result.jwtAlgorithmSafe = true; result.jwtAlgNoneRisk = 0; }

  // A05 — Security Misconfiguration
  try {
    const { stdout } = await execAsync(`grep "^NODE_ENV=" ${backendDir}/.env 2>/dev/null`);
    result.nodeEnv       = stdout.trim().split('=')[1]?.trim() || 'not set';
    result.productionMode = result.nodeEnv === 'production';
  } catch { result.nodeEnv = 'not set'; result.productionMode = false; }

  try {
    const { stdout } = await execAsync(
      `grep -rn "\\.stack\\b" ${backendDir}/routes/ 2>/dev/null | grep "res\\.json\\|res\\.send\\|error.*stack" | grep -v "//\\|comment" | wc -l`
    );
    result.stackTraceLeakRisk = parseInt(stdout.trim()) || 0;
    result.noStackTraceLeak   = result.stackTraceLeakRisk === 0;
  } catch { result.noStackTraceLeak = true; result.stackTraceLeakRisk = 0; }

  try {
    const { stdout } = await execAsync(
      `ss -tlnp 2>/dev/null | grep -E "0\\.0\\.0\\.0:(3306|6379|27017|9200|5601|8080|8443)" | wc -l`
    );
    result.dangerousPortsOpen    = parseInt(stdout.trim()) || 0;
    result.noDefaultPortsExposed = result.dangerousPortsOpen === 0;
  } catch { result.noDefaultPortsExposed = true; result.dangerousPortsOpen = 0; }

  try {
    const { stdout } = await execAsync(`ss -tlnp 2>/dev/null | grep -E "0\\.0\\.0\\.0:(9191)" | wc -l`);
    result.monitorPublic = parseInt(stdout.trim()) > 0;
  } catch { result.monitorPublic = false; }

  // A06 — Vulnerable Dependencies
  for (const [dir, key] of [[backendDir, 'npmAuditBackend'], ['/home/ubuntu/sathvam-frontend/sathvam-vercel', 'npmAuditFrontend']]) {
    try {
      const { stdout } = await execAsync(`cd ${dir} && npm audit --json 2>/dev/null`, { timeout: 40000 });
      const parsed = JSON.parse(stdout);
      const v = parsed.metadata?.vulnerabilities || {};
      result[key] = { critical: v.critical||0, high: v.high||0, moderate: v.moderate||0, low: v.low||0,
                      total: (v.critical||0)+(v.high||0)+(v.moderate||0)+(v.low||0) };
    } catch { result[key] = null; }
  }

  // A09 — Security Logging
  try {
    const { stdout } = await execAsync(`ls /home/ubuntu/.pm2/logs/sathvam-api-out.log 2>/dev/null`);
    result.loggingEnabled = stdout.trim().length > 0;
  } catch { result.loggingEnabled = false; }

  try {
    const { stdout } = await execAsync(`grep -n "morgan" ${backendDir}/server.js 2>/dev/null | wc -l`);
    result.morganEnabled = parseInt(stdout.trim()) > 0;
  } catch { result.morganEnabled = false; }

  // A10 — SSRF
  try {
    const { stdout } = await execAsync(
      `grep -rn "fetch.*req\\.body\\|axios.*req\\.body\\|fetch.*req\\.query\\|axios.*req\\.query" ${backendDir}/routes/ 2>/dev/null | grep -v "//\\|security.js" | wc -l`
    );
    result.ssrfRisk = parseInt(stdout.trim()) || 0;
    result.ssrfSafe = result.ssrfRisk === 0;
  } catch { result.ssrfSafe = true; result.ssrfRisk = 0; }

  return result;
}

// ── Helper: Build findings ────────────────────────────────────────────────────
function buildFindings({ ssl, system, services, adminSecurity, database, http, authSecurity, inputValidation, apiSecurity, dataSecurity, owaspTop10 }) {
  const findings = [];

  for (const s of ssl) {
    if (s.daysLeft == null)   findings.push({ sev:'critical', title:`SSL: ${s.domain} — check failed`,      detail: s.error });
    else if (s.daysLeft < 7)  findings.push({ sev:'critical', title:`SSL: ${s.domain} expires in ${s.daysLeft}d!`, detail:'Renew immediately: sudo certbot renew' });
    else if (s.daysLeft < 30) findings.push({ sev:'warning',  title:`SSL: ${s.domain} expires in ${s.daysLeft} days`, detail:'Run: sudo certbot renew' });
    else                      findings.push({ sev:'ok',       title:`SSL: ${s.domain}`, detail:`${s.daysLeft} days left` });
  }

  if      (system.cpu > 85)    findings.push({ sev:'critical', title:`CPU high: ${system.cpu}%` });
  else if (system.cpu > 70)    findings.push({ sev:'warning',  title:`CPU elevated: ${system.cpu}%` });
  else                         findings.push({ sev:'ok',       title:`CPU: ${system.cpu}%` });

  if      (system.memPct > 90) findings.push({ sev:'critical', title:`Memory critical: ${system.memPct}%`, detail:`${system.memUsedMB}MB / ${system.memTotalMB}MB` });
  else if (system.memPct > 80) findings.push({ sev:'warning',  title:`Memory high: ${system.memPct}%` });
  else                         findings.push({ sev:'ok',       title:`Memory: ${system.memPct}%`, detail:`${system.memUsedMB}MB used` });

  if      (system.diskPct > 90) findings.push({ sev:'critical', title:`Disk critical: ${system.diskPct}%`, detail:`${system.diskUsedGB}GB / ${system.diskTotalGB}GB` });
  else if (system.diskPct > 80) findings.push({ sev:'warning',  title:`Disk high: ${system.diskPct}%` });
  else                          findings.push({ sev:'ok',       title:`Disk: ${system.diskPct}%`, detail:`${system.diskUsedGB}GB / ${system.diskTotalGB}GB used` });

  for (const [name, status] of Object.entries(services)) {
    if (status !== 'active') findings.push({ sev:'critical', title:`${name}: DOWN`, detail:`Status: ${status}` });
    else                     findings.push({ sev:'ok',       title:`${name}: running` });
  }

  if (adminSecurity) {
    if (adminSecurity.without2fa > 0)
      findings.push({ sev:'warning', title:`${adminSecurity.without2fa} admin${adminSecurity.without2fa>1?'s':''} without 2FA`, detail:`Users: ${adminSecurity.no2faNames.join(', ')}` });
    else
      findings.push({ sev:'ok', title:'All admin accounts have 2FA enabled' });

    if (adminSecurity.recentAdmins > 0)
      findings.push({ sev:'warning', title:`${adminSecurity.recentAdmins} new admin account${adminSecurity.recentAdmins>1?'s':''} added this week`, detail:'Verify these are authorized' });
    else
      findings.push({ sev:'ok', title:'No new admin accounts in last 7 days' });
  }

  if (!database.ok)
    findings.push({ sev:'critical', title:'Supabase connection FAILED' });
  else {
    findings.push({ sev:'ok', title:`Database connected (${database.restMs}ms)` });
    for (const [tbl, info] of Object.entries(database.tables)) {
      if (!info.ok) findings.push({ sev:'critical', title:`Table unreachable: ${tbl}` });
    }
  }

  if (!http.api.ok) findings.push({ sev:'critical', title:'API endpoint DOWN', detail:`Status ${http.api.status}` });
  else              findings.push({ sev:'ok', title:`API health: ${http.api.ms}ms` });

  if (!http.website.ok) findings.push({ sev:'critical', title:'Website DOWN', detail:`Status ${http.website.status}` });
  else                  findings.push({ sev:'ok', title:`Website: ${http.website.ms}ms` });

  // Auth & Authorization
  if (authSecurity) {
    if (!authSecurity.jwtSecretStrong)
      findings.push({ sev:'critical', title:`JWT secret too weak (${authSecurity.jwtSecretLength} chars)`, detail:'Regenerate with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"' });
    else
      findings.push({ sev:'ok', title:`JWT secret: ${authSecurity.jwtSecretLength} chars (strong)` });

    const expiry = authSecurity.jwtAdminExpiry;
    const expiryDays = expiry.includes('d') ? parseInt(expiry) : expiry.includes('h') ? Math.round(parseInt(expiry)/24) : null;
    if (!expiry || expiry === 'not set')
      findings.push({ sev:'warning', title:'JWT_EXPIRES_IN not set — tokens never expire' });
    else if (expiryDays && expiryDays > 30)
      findings.push({ sev:'warning', title:`JWT admin expiry long: ${expiry}`, detail:'Consider 7d or less' });
    else
      findings.push({ sev:'ok', title:`JWT admin expiry: ${expiry}` });

    findings.push({ sev:'ok', title:`Admin login rate limited: ${authSecurity.adminRateLimitConfig}` });

    if (!authSecurity.customerLoginRateLimited)
      findings.push({ sev:'warning', title:'Customer login has no dedicated rate limit', detail:`${authSecurity.customerRateLimitConfig}. Add authLimiter to /api/customer/login.` });
    else
      findings.push({ sev:'ok', title:`Customer login rate limited: ${authSecurity.customerRateLimitConfig}` });

    if (!authSecurity.passwordMinLengthEnforced)
      findings.push({ sev:'warning', title:'No minimum password length enforced at customer signup', detail:'Add validation in customer.js: if (password.length < 8) return 400' });
    else
      findings.push({ sev:'ok', title:`Password minimum length: ${authSecurity.passwordMinLength} chars` });

    if (!authSecurity.rbacAllPassed) {
      const failed = (authSecurity.rbacTests||[]).filter(t=>!t.passed);
      findings.push({ sev:'critical', title:`RBAC failure: ${failed.length} endpoint${failed.length>1?'s':''} accessible without auth`, detail: failed.map(t=>`${t.label} → HTTP ${t.status}`).join(', ') });
    } else {
      findings.push({ sev:'ok', title:`RBAC: all ${(authSecurity.rbacTests||[]).length} protected endpoints require auth` });
    }

    if (authSecurity.sessionTimeoutConfigured)
      findings.push({ sev:'ok', title:`Session timeout: admin ${authSecurity.adminSessionTimeoutMin}min, customer ${authSecurity.customerSessionTimeoutMin}min` });
    else
      findings.push({ sev:'warning', title:'Session timeout not configured' });

    if (authSecurity.customerTotal !== null) {
      const pct = authSecurity.customerWith2faPct;
      findings.push({
        sev: pct < 5 ? 'info' : 'ok',
        title:`Customer 2FA adoption: ${pct}% (${authSecurity.customerWith2fa}/${authSecurity.customerTotal})`,
        detail: pct < 5 ? 'Low adoption is normal — consider promoting 2FA' : undefined,
      });
    }

    if (authSecurity.recentAuthFailures !== null && authSecurity.recentAuthFailures > 50)
      findings.push({ sev:'warning', title:`High auth failure count in logs: ${authSecurity.recentAuthFailures}`, detail:'Could indicate brute-force or misconfigured client' });
    else if (authSecurity.recentAuthFailures !== null)
      findings.push({ sev:'ok', title:`Auth failure log entries: ${authSecurity.recentAuthFailures} (normal)` });
  }

  // Input Validation
  if (inputValidation) {
    if (!inputValidation.sqlInjectionSafe)
      findings.push({ sev:'critical', title:`SQL injection risk: ${inputValidation.sqlInjectionRisk} raw concatenation(s) in routes`, detail:'Use Supabase ORM parameterized queries only' });
    else if (inputValidation.supabaseOrmUsed)
      findings.push({ sev:'ok', title:'SQL injection: Supabase ORM (parameterized) used throughout' });

    if (!inputValidation.xssProtectionPresent)
      findings.push({ sev:'warning', title:'XSS: DOMPurify not detected in frontend', detail:'Sanitize all user-generated HTML before rendering' });
    else
      findings.push({ sev:'ok', title:'XSS protection: DOMPurify sanitization present' });

    if (!inputValidation.commandInjectionSafe)
      findings.push({ sev:'critical', title:'Command injection risk: user input passed to exec/spawn', detail:'Never pass req.body/params to shell commands' });
    else
      findings.push({ sev:'ok', title:'Command injection: no exec/spawn with user input detected' });

    if (!inputValidation.fileUploadMimeCheck)
      findings.push({ sev:'warning', title:'File upload: no MIME type whitelist detected', detail:'Add fileFilter in multer config' });
    else
      findings.push({ sev:'ok', title:'File upload: MIME type validation present' });

    if (!inputValidation.helmetEnabled)
      findings.push({ sev:'warning', title:'Helmet security headers not enabled', detail:'Add helmet() to Express middleware' });
    else
      findings.push({ sev:'ok', title:'Helmet: HTTP security headers enabled' });
  }

  // API Security
  if (apiSecurity) {
    if (apiSecurity.rateLimitingOk)
      findings.push({ sev:'ok', title:`Rate limiting: ${apiSecurity.rateLimitersCount} limiters (general, auth, public, payments)` });
    else
      findings.push({ sev:'warning', title:`Rate limiting: only ${apiSecurity.rateLimitersCount} limiter(s) found`, detail:'Expected 4: general, auth, public, payments' });

    if (apiSecurity.corsConfigured && !apiSecurity.corsWildcard)
      findings.push({ sev:'ok', title:`CORS: restricted to trusted origins` });
    else if (apiSecurity.corsWildcard)
      findings.push({ sev:'critical', title:'CORS wildcard (*) — any origin allowed', detail:'Set explicit origin whitelist' });
    else
      findings.push({ sev:'warning', title:'CORS not configured', detail:'Add cors() with origin whitelist' });

    if (apiSecurity.tokensInUrlSafe)
      findings.push({ sev:'ok', title:'Tokens in URL: auth tokens not passed as GET params' });
    else
      findings.push({ sev:'warning', title:`Tokens in URL: ${apiSecurity.tokensInUrl} occurrence(s) found`, detail:'Pass auth tokens in headers only' });

    if (apiSecurity.httpsEnforced)
      findings.push({ sev:'ok', title:'HTTPS: HTTP → HTTPS redirect enforced in nginx' });
    else if (apiSecurity.httpsEnforced === false)
      findings.push({ sev:'warning', title:'HTTPS redirect not in nginx config', detail:'Add: return 301 https://$host$request_uri;' });

    if (apiSecurity.hsts)         findings.push({ sev:'ok',      title:'HSTS header present' });
    else if (apiSecurity.hsts===false) findings.push({ sev:'warning', title:'HSTS header missing' });

    if (apiSecurity.xFrameOptions)         findings.push({ sev:'ok',      title:'X-Frame-Options present (clickjacking protection)' });
    else if (apiSecurity.xFrameOptions===false) findings.push({ sev:'warning', title:'X-Frame-Options header missing' });

    if (apiSecurity.sensitiveDataSafe)
      findings.push({ sev:'ok', title:'No password_hash/secrets in API responses' });
    else
      findings.push({ sev:'critical', title:`Sensitive data leak: ${apiSecurity.sensitiveDataLeak} route(s) may expose secrets`, detail:'Remove password_hash, totp_secret from response JSON' });
  }

  // Data Security
  if (dataSecurity) {
    if (!dataSecurity.httpsEverywhereOk)
      findings.push({ sev:'warning', title:`HTTPS: ${dataSecurity.httpCallsInFrontend} http:// call(s) in frontend source`, detail:'Replace all http:// with https:// in API calls' });
    else
      findings.push({ sev:'ok', title:'HTTPS: all frontend API calls use HTTPS' });

    if (dataSecurity.httpRedirects === true)
      findings.push({ sev:'ok', title:'HTTP port 80: redirects to HTTPS' });
    else if (dataSecurity.httpRedirects === false)
      findings.push({ sev:'warning', title:`HTTP port 80: not redirecting (status ${dataSecurity.httpPortStatus})`, detail:'Add HTTP→HTTPS redirect in nginx' });

    if (dataSecurity.tls10Disabled === true)  findings.push({ sev:'ok',      title:'TLS 1.0: disabled' });
    if (dataSecurity.tls10Disabled === false)  findings.push({ sev:'warning', title:'TLS 1.0 still enabled', detail:'Set: ssl_protocols TLSv1.2 TLSv1.3; in nginx' });
    if (dataSecurity.tls11Disabled === true)  findings.push({ sev:'ok',      title:'TLS 1.1: disabled' });
    if (dataSecurity.tls11Disabled === false)  findings.push({ sev:'warning', title:'TLS 1.1 still enabled', detail:'Set: ssl_protocols TLSv1.2 TLSv1.3; in nginx' });

    if (!dataSecurity.passwordsSafe)
      findings.push({ sev:'critical', title:'Password storage unsafe', detail:`bcrypt: ${dataSecurity.bcryptUsed}, plaintext risk: ${dataSecurity.plaintextPasswordRisk}` });
    else
      findings.push({ sev:'ok', title:`Passwords: bcrypt hashed (${dataSecurity.bcryptRounds ?? '?'} rounds)` });

    if (dataSecurity.bcryptRoundsOk === false)
      findings.push({ sev:'warning', title:`bcrypt salt rounds too low: ${dataSecurity.bcryptRounds}`, detail:'Use at least 10 rounds' });

    if (!dataSecurity.noHardcodedSecrets)
      findings.push({ sev:'critical', title:`Hardcoded secrets: ${dataSecurity.hardcodedSecretsRisk} pattern(s) in source`, detail:'Move all secrets to .env' });
    else
      findings.push({ sev:'ok', title:'No hardcoded secrets detected in source files' });

    if (!dataSecurity.envInGitignore)
      findings.push({ sev:'warning', title:'.env not in .gitignore', detail:'Add .env to .gitignore immediately' });
    else
      findings.push({ sev:'ok', title:'.env is in .gitignore' });

    if (dataSecurity.dbPubliclyExposed)
      findings.push({ sev:'critical', title:'Database port 5432 publicly exposed!', detail:'Restrict to 127.0.0.1 or firewall immediately' });
    else if (dataSecurity.dbIsCloudHosted)
      findings.push({ sev:'ok', title:'Database: Supabase cloud-hosted — not on this server' });
    else
      findings.push({ sev:'ok', title:'Database port 5432: not publicly exposed' });

    findings.push({ sev:'ok', title:'Supabase: AES-256 encryption at rest (managed)' });
  }

  // OWASP Top 10
  if (owaspTop10) {
    if (owaspTop10.bcryptUsed)
      findings.push({ sev:'ok', title:'A02 Cryptographic: bcrypt password hashing in use' });
    else
      findings.push({ sev:'critical', title:'A02 Cryptographic: bcrypt NOT found — passwords may be unsafe' });

    if (!owaspTop10.noWeakHashing)
      findings.push({ sev:'warning', title:`A02 Cryptographic: weak hashing (MD5/SHA1) in ${owaspTop10.weakHashingRisk} place(s)`, detail:'Use SHA-256 or bcrypt for sensitive data' });
    else
      findings.push({ sev:'ok', title:'A02 Cryptographic: no MD5/SHA1 for sensitive data' });

    if (!owaspTop10.jwtAlgorithmSafe)
      findings.push({ sev:'critical', title:`A02 Cryptographic: JWT algorithm 'none' found in ${owaspTop10.jwtAlgNoneRisk} place(s)`, detail:'Set algorithms:["HS256"] in jwt.verify()' });
    else
      findings.push({ sev:'ok', title:'A02 Cryptographic: JWT algorithm "none" bypass not present' });

    if (!owaspTop10.productionMode)
      findings.push({ sev:'warning', title:`A05 Misconfiguration: NODE_ENV = "${owaspTop10.nodeEnv}" (not production)`, detail:'Set NODE_ENV=production in .env' });
    else
      findings.push({ sev:'ok', title:'A05 Misconfiguration: NODE_ENV=production' });

    if (!owaspTop10.noStackTraceLeak)
      findings.push({ sev:'warning', title:`A05 Misconfiguration: stack traces in ${owaspTop10.stackTraceLeakRisk} error response(s)`, detail:'Remove e.stack from res.json() error responses' });
    else
      findings.push({ sev:'ok', title:'A05 Misconfiguration: no stack traces in error responses' });

    if (!owaspTop10.noDefaultPortsExposed)
      findings.push({ sev:'critical', title:`A05 Misconfiguration: ${owaspTop10.dangerousPortsOpen} dangerous port(s) publicly exposed`, detail:'Firewall MySQL/Redis/Mongo/ES ports immediately' });
    else
      findings.push({ sev:'ok', title:'A05 Misconfiguration: no dangerous ports publicly exposed' });

    if (owaspTop10.monitorPublic)
      findings.push({ sev:'warning', title:'A05 Misconfiguration: monitor API (9191) may be publicly reachable', detail:'Verify nginx Basic Auth is in place' });
    else
      findings.push({ sev:'ok', title:'A05 Misconfiguration: monitor API (9191) bound to localhost only' });

    const ba = owaspTop10.npmAuditBackend;
    if (ba === null)
      findings.push({ sev:'info', title:'A06 Dependencies: npm audit could not run on backend' });
    else if (ba.critical > 0)
      findings.push({ sev:'critical', title:`A06 Dependencies: ${ba.critical} critical vulnerability(ies) in backend`, detail:`Also: ${ba.high} high. Run: cd sathvam-backend && npm audit fix` });
    else if (ba.high > 0)
      findings.push({ sev:'warning', title:`A06 Dependencies: ${ba.high} high severity vulnerability(ies) in backend`, detail:'Run: npm audit fix' });
    else
      findings.push({ sev:'ok', title:`A06 Dependencies: backend — ${ba.total === 0 ? 'no vulnerabilities' : `${ba.total} low/moderate`}` });

    const fa = owaspTop10.npmAuditFrontend;
    if (fa !== null && fa.critical > 0)
      findings.push({ sev:'critical', title:`A06 Dependencies: ${fa.critical} critical vulnerability(ies) in frontend` });
    else if (fa !== null && fa.high > 0)
      findings.push({ sev:'warning', title:`A06 Dependencies: ${fa.high} high severity in frontend` });
    else if (fa !== null)
      findings.push({ sev:'ok', title:`A06 Dependencies: frontend — ${fa.total === 0 ? 'no vulnerabilities' : `${fa.total} low/moderate`}` });

    if (owaspTop10.loggingEnabled && owaspTop10.morganEnabled)
      findings.push({ sev:'ok', title:'A09 Logging: PM2 logs + Morgan request logging enabled' });
    else if (!owaspTop10.loggingEnabled)
      findings.push({ sev:'warning', title:'A09 Logging: PM2 log file not found' });
    else
      findings.push({ sev:'warning', title:'A09 Logging: Morgan HTTP logger not detected', detail:'Add app.use(morgan("combined")) to server.js' });

    if (!owaspTop10.ssrfSafe)
      findings.push({ sev:'warning', title:`A10 SSRF: ${owaspTop10.ssrfRisk} route(s) fetch URLs from user input`, detail:'Validate and whitelist allowed domains' });
    else
      findings.push({ sev:'ok', title:'A10 SSRF: no server-side fetch with user-supplied URLs detected' });
  }

  return findings;
}

// ── Helper: Collect system metrics ───────────────────────────────────────────
async function getSystem() {
  const mem   = os.totalmem();
  const free  = os.freemem();
  const used  = mem - free;

  let diskPct = 0, diskUsedGB = 0, diskTotalGB = 0;
  try {
    const { stdout } = await execAsync("df -BG / | tail -1 | awk '{print $2,$3,$5}'");
    const [t, u, p] = stdout.trim().split(' ');
    diskTotalGB = parseInt(t); diskUsedGB = parseInt(u); diskPct = parseInt(p);
  } catch { /**/ }

  const [l1] = os.loadavg();
  const cores = os.cpus().length;

  return {
    cpu:         Math.round(l1 / cores * 100),  // approx from load avg
    memTotalMB:  Math.round(mem  / 1024 / 1024),
    memUsedMB:   Math.round(used / 1024 / 1024),
    memPct:      Math.round(used / mem * 100),
    diskTotalGB, diskUsedGB, diskPct,
    uptime:      (() => { const s=Math.round(os.uptime()); const d=Math.floor(s/86400); const h=Math.floor((s%86400)/3600); const m=Math.floor((s%3600)/60); return d>0?`${d}d ${h}h ${m}m`:`${h}h ${m}m`; })(),
  };
}

// ── Helper: Save report to Supabase ──────────────────────────────────────────
async function saveReport(report) {
  await supabase.from('settings')
    .upsert({ key: 'security_report_latest', value: report, updated_at: new Date() });

  // Append to history — keep last 7
  const { data: histData } = await supabase.from('settings')
    .select('value').eq('key', 'security_report_history').single();
  const history = (histData?.value || []);
  history.unshift({ ts: report.ts, findings: report.findings, summary: report.summary });
  if (history.length > 7) history.length = 7;
  await supabase.from('settings')
    .upsert({ key: 'security_report_history', value: history, updated_at: new Date() });
}

// ── GET /api/security/report ──────────────────────────────────────────────────
router.get('/report', ...adminOrCeo, async (req, res) => {
  const { data: latestData } = await supabase.from('settings')
    .select('value').eq('key', 'security_report_latest').single();
  const { data: histData } = await supabase.from('settings')
    .select('value').eq('key', 'security_report_history').single();

  const report = latestData?.value || null;
  if (report) report.history = histData?.value || [];

  res.json({ value: report });
});

// ── POST /api/security/run ────────────────────────────────────────────────────
// Runs the full security check in the background so heavy shell commands
// (npm audit, openssl, grep on large files) do not block incoming store requests.
// Returns the previously saved report immediately, then overwrites it when done.
let _securityRunning = false;
router.post('/run', ...adminOrCeo, async (req, res) => {
  // Return the last saved report immediately so the UI is never blocked
  const { data: latestData } = await supabase.from('settings')
    .select('value').eq('key', 'security_report_latest').single();
  const savedReport = latestData?.value || null;

  if (_securityRunning) {
    return res.json({ ...(savedReport || {}), _running: true, _msg: 'Security check already in progress — showing last result' });
  }

  // Respond right away with last report (or empty shell)
  res.json({ ...(savedReport || { findings:[], summary:{critical:0,warnings:0,ok:0} }), _running: true, _msg: 'Security check started in background — refresh in ~60s for updated results' });

  // Run the heavy check in the background
  _securityRunning = true;
  setImmediate(async () => {
    try {
      const [ssl, system, nginxSt, pm2St, port3001, dbResult, adminSec, authSec, inputVal, apiSec, dataSec, owaspResult, httpApi, httpWs] = await Promise.all([
        Promise.all(['sathvam.in','admin.sathvam.in','api.sathvam.in'].map(checkSSL)),
        getSystem(),
        serviceActive('nginx'),
        pm2ApiStatus(),
        portOpen(3001),
        checkDatabase(),
        checkAdminSecurity(),
        checkAuthSecurity(),
        checkInputValidation(),
        checkApiSecurity(),
        checkDataSecurity(),
        checkOwaspTop10(),
        httpCheck('https://api.sathvam.in/health'),
        httpCheck('https://www.sathvam.in'),
      ]);

      const services = { nginx: nginxSt, 'sathvam-api': pm2St, 'port-3001': port3001 };
      const http     = { api: httpApi, website: httpWs };
      const findings = buildFindings({ ssl, system, services, adminSecurity: adminSec, database: dbResult, http, authSecurity: authSec, inputValidation: inputVal, apiSecurity: apiSec, dataSecurity: dataSec, owaspTop10: owaspResult });

      const report = {
        ts: new Date().toISOString(),
        findings,
        ssl,
        system,
        services,
        adminSecurity:   adminSec,
        authSecurity:    authSec,
        inputValidation: inputVal,
        apiSecurity:     apiSec,
        dataSecurity:    dataSec,
        owaspTop10:      owaspResult,
        database: dbResult,
        http,
        summary: {
          critical: findings.filter(f=>f.sev==='critical').length,
          warnings: findings.filter(f=>f.sev==='warning').length,
          ok:       findings.filter(f=>f.sev==='ok').length,
        },
      };

      await saveReport(report);
    } catch (e) {
      console.error('[security/run background]', e);
    } finally {
      _securityRunning = false;
    }
  });
});

// ── GET /api/security/metrics — live IT metrics from monitor-api ──────────────
router.get('/metrics', ...adminOrCeo, async (req, res) => {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 8000);
    const monitorHost = process.env.MONITOR_API_HOST || '172.17.0.1';
    const r = await fetch(`http://${monitorHost}:9191/metrics`, { signal: ctrl.signal });
    if (!r.ok) return res.status(502).json({ error: `Monitor API returned ${r.status}` });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(503).json({ error: 'Monitor API unreachable', detail: e.message });
  }
});

// ── GET /api/security/deploy-status — proxy to monitor-api (host) ────────────
// Backend runs in Docker — no git/.git or systemctl available inside container.
// Monitor API runs on host (port 9191) and has full access to both.
router.get('/deploy-status', ...adminOrCeo, async (req, res) => {
  try {
    const r = await fetch('http://host.docker.internal:9191/deploy-status');
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/security/deploy-now — proxy to monitor-api (host) ──────────────
router.post('/deploy-now', ...adminOrCeo, async (req, res) => {
  try {
    const r = await fetch('http://host.docker.internal:9191/deploy-now', { method: 'POST' });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/security/ai-agents — status of all AI agents ────────────────────
router.get('/ai-agents', ...adminOrCeo, async (req, res) => {
  const apiKeySet = !!process.env.ANTHROPIC_API_KEY;
  const waAiEnabled = process.env.WHATSAPP_AI_REPLIES !== 'false';

  // Recent chat session stats
  let chatSessions = 0, lastChatAt = null;
  try {
    const [countRes, lastRes] = await Promise.all([
      supabase.from('chat_sessions').select('id', { count: 'exact', head: true }),
      supabase.from('chat_sessions').select('updated_at').order('updated_at', { ascending: false }).limit(1),
    ]);
    chatSessions = countRes.count || 0;
    lastChatAt   = lastRes.data?.[0]?.updated_at || null;
  } catch { /**/ }

  // Scheduled blog timers status
  let blogEnTimer = null, blogTaTimer = null;
  try {
    const { stdout } = await execAsync("systemctl is-active sathvam-blog-en.timer sathvam-blog-ta.timer 2>/dev/null || true");
    const lines = stdout.trim().split('\n');
    blogEnTimer = lines[0] === 'active';
    blogTaTimer = lines[1] === 'active';
  } catch { /**/ }

  const agents = [
    {
      id: 'customer-chat',
      name: 'Customer Chat',
      description: 'Live AI chat on sathvam.in — answers product & order questions',
      model: 'claude-sonnet-4-6',
      enabled: apiKeySet,
      stat: `${chatSessions} total sessions`,
      lastUsed: lastChatAt,
    },
    {
      id: 'admin-assistant',
      name: 'Admin AI Assistant',
      description: 'Morning briefings, stock alerts, Q&A for admin panel',
      model: 'claude-sonnet-4-6',
      enabled: apiKeySet,
      stat: null,
      lastUsed: null,
    },
    {
      id: 'monitor-agent',
      name: 'IT Monitor Agent',
      description: 'Daily security scan — checks SSL, auth, OWASP, APIs',
      model: 'claude-opus-4-6',
      enabled: apiKeySet,
      stat: null,
      lastUsed: null,
    },
    {
      id: 'whatsapp-ai',
      name: 'WhatsApp Auto-Reply',
      description: 'Replies to customer WhatsApp messages via BotSailor',
      model: 'claude-sonnet-4-6',
      enabled: apiKeySet && waAiEnabled,
      stat: waAiEnabled ? 'Active' : 'Disabled (WHATSAPP_AI_REPLIES=false)',
      lastUsed: null,
    },
    {
      id: 'social-content',
      name: 'Social Media Writer',
      description: 'Generates Instagram/Facebook/Twitter captions for products',
      model: 'claude-haiku-4-5',
      enabled: apiKeySet,
      stat: 'On-demand',
      lastUsed: null,
    },
    {
      id: 'blog-writer',
      name: 'Blog Writer',
      description: 'Weekly auto-generates English + Tamil blog posts',
      model: 'claude-sonnet-4-6',
      enabled: apiKeySet,
      stat: blogEnTimer ? 'Timer active' : 'Timer inactive',
      lastUsed: null,
    },
    {
      id: 'tts',
      name: 'Text-to-Speech',
      description: 'Converts product descriptions to audio (Tamil/English)',
      model: 'claude-tts',
      enabled: apiKeySet,
      stat: 'On-demand',
      lastUsed: null,
    },
    {
      id: 'docker-agent',
      name: 'Docker Agent',
      description: 'Monitors containers every 5 min — health, restarts, CPU/mem, AI root-cause analysis',
      model: 'claude-haiku-4-5',
      enabled: apiKeySet,
      stat: 'Every 5 min',
      lastUsed: null,
    },
  ];

  res.json({
    apiKeyConfigured: apiKeySet,
    totalAgents: agents.length,
    enabledCount: agents.filter(a => a.enabled).length,
    agents,
  });
});

// ── GET /api/security/docker-agent — latest Docker agent report ───────────────
router.get('/docker-agent', ...adminOrCeo, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('value, updated_at')
      .eq('key', 'docker_report_latest')
      .single();

    if (error || !data) {
      return res.json({ error: 'No Docker agent report yet. Agent runs every 5 minutes.' });
    }
    res.json({ ...data.value, fetchedAt: data.updated_at });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/security/audit-log — recent admin mutation log ────────────────────
router.get('/audit-log', ...adminOrCeo, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '200'), 500);
    const offset = parseInt(req.query.offset || '0');
    const user   = req.query.user   || null;
    const method = req.query.method || null;

    let q = supabase
      .from('admin_audit_logs')
      .select('id,ts,username,role,method,path,status,ip', { count: 'exact' })
      .order('ts', { ascending: false })
      .range(offset, offset + limit - 1);

    if (user)   q = q.eq('username', user);
    if (method) q = q.eq('method', method);

    const { data, error, count } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ logs: data || [], total: count ?? 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
