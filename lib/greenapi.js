/**
 * Green API — WhatsApp integration helper
 * Replaces BotSailor middleware.
 *
 * Required env vars:
 *   GREENAPI_INSTANCE_ID  — idInstance from green-api.com dashboard
 *   GREENAPI_API_TOKEN    — apiTokenInstance from green-api.com dashboard
 *
 * Phone format: digits only (10 or 12 digits)
 *   10 digits (Indian): auto-prefixed with 91
 *   12+ digits (91XXXXXXXXXX): used as-is
 */

const BASE = 'https://api.green-api.com';

// ── Send limits — prevents WhatsApp ban on Green API ─────────────────────────
// Caps: 200/day, 50/hour. Override with WA_DAILY_CAP / WA_HOURLY_CAP env vars
// Higher defaults to support AI customer support replies (every inbound needs a response)
const DAILY_CAP  = parseInt(process.env.WA_DAILY_CAP  || '200', 10);
const HOURLY_CAP = parseInt(process.env.WA_HOURLY_CAP || '50', 10);
const MIN_INTERVAL_MS = 30 * 60 * 1000; // minimum 30 minutes between any two sends

let _dailySendCount  = 0;
let _dailyResetDate  = '';
let _hourlySendCount = 0;
let _hourlyResetHour = -1;
let _lastSendTime    = 0;
// Track suppressed messages for admin visibility
let _suppressedToday = 0;
let _suppressedResetDate = '';

// Use IST date/hour for rate limit resets (UTC+5:30)
function _getISTDate() {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}
function _getISTHour() {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return now.getUTCHours();
}

function _checkAndIncrementCap() {
  const today = _getISTDate();
  const hour  = _getISTHour();

  // Reset daily counter at IST midnight
  if (today !== _dailyResetDate) {
    _dailySendCount = 0;
    _dailyResetDate = today;
  }
  // Reset hourly counter at IST hour boundary
  if (hour !== _hourlyResetHour) {
    _hourlySendCount = 0;
    _hourlyResetHour = hour;
  }
  // Reset suppressed counter daily
  if (today !== _suppressedResetDate) {
    _suppressedToday = 0;
    _suppressedResetDate = today;
  }

  if (_dailySendCount >= DAILY_CAP) {
    _suppressedToday++;
    console.warn(`[GreenAPI] Daily cap reached (${_dailySendCount}/${DAILY_CAP}). Message suppressed. Total suppressed today: ${_suppressedToday}`);
    return false;
  }
  if (_hourlySendCount >= HOURLY_CAP) {
    _suppressedToday++;
    console.warn(`[GreenAPI] Hourly cap reached (${_hourlySendCount}/${HOURLY_CAP}). Message suppressed. Total suppressed today: ${_suppressedToday}`);
    return false;
  }

  _dailySendCount++;
  _hourlySendCount++;
  return true;
}

async function _rateLimit(priority = false) {
  if (priority) { _lastSendTime = Date.now(); return; } // skip wait for priority messages
  const now = Date.now();
  const elapsed = now - _lastSendTime;
  if (elapsed < MIN_INTERVAL_MS) {
    _suppressedToday++;
    console.warn(`[GreenAPI] Rate limited — ${Math.round((MIN_INTERVAL_MS - elapsed)/1000)}s remaining. Message queued for next window. Suppressed today: ${_suppressedToday}`);
    return 'RATE_LIMITED';
  }
  _lastSendTime = Date.now();
}

// ── Per-customer rate limiting (max 20 msgs/hour per phone) ─────────────────
const _customerSends = new Map(); // phone → { count, resetTime }
const CUSTOMER_HOURLY_CAP = 20;

function _checkCustomerRate(phone) {
  if (!phone) return true;
  const now = Date.now();
  const entry = _customerSends.get(phone);
  if (!entry || now > entry.resetTime) {
    _customerSends.set(phone, { count: 1, resetTime: now + 60 * 60 * 1000 });
    return true;
  }
  if (entry.count >= CUSTOMER_HOURLY_CAP) {
    console.warn(`[GreenAPI] Per-customer rate limit: ${phone} sent ${entry.count} msgs this hour. Suppressed.`);
    return false;
  }
  entry.count++;
  return true;
}

// Clean up stale entries every hour
setInterval(() => {
  const now = Date.now();
  for (const [phone, entry] of _customerSends) {
    if (now > entry.resetTime) _customerSends.delete(phone);
  }
}, 60 * 60 * 1000);

// Expose for monitoring
function getDailySendCount() { return { daily: _dailySendCount, dailyCap: DAILY_CAP, hourly: _hourlySendCount, hourlyCap: HOURLY_CAP, suppressedToday: _suppressedToday }; }

// Global kill-switch — set WA_DISABLED=true in .env to block all outbound WhatsApp messages
function isDisabled() {
  return process.env.WA_DISABLED === 'true';
}

function toChatId(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  if (!digits || digits.length < 10) return null;
  const normalized = digits.length === 10 ? '91' + digits : digits;
  return normalized + '@c.us';
}

// priority: true = skip 30-min interval (for order confirmations, admin-triggered sends)
async function sendText(phone, message, { priority = false, quotedMessageId = null } = {}) {
  if (isDisabled()) { console.log('[GreenAPI] WA_DISABLED — sendText suppressed to', phone); return false; }
  if (!_checkAndIncrementCap()) return false;
  const instanceId = process.env.GREENAPI_INSTANCE_ID;
  const token      = process.env.GREENAPI_API_TOKEN;
  if (!instanceId || !token) {
    console.error('[GreenAPI] GREENAPI_INSTANCE_ID or GREENAPI_API_TOKEN not set');
    return false;
  }
  const chatId = toChatId(phone);
  if (!chatId) { console.error('[GreenAPI] Invalid phone:', phone); return false; }
  try {
    const rl = await _rateLimit(priority);
    if (rl === 'RATE_LIMITED') { _dailySendCount--; _hourlySendCount--; return false; }
    const res  = await fetch(`${BASE}/waInstance${instanceId}/sendMessage/${token}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(Object.assign({ chatId, message }, quotedMessageId ? { quotedMessageId } : {})),
    });
    const data = await res.json();
    if (!data.idMessage) { console.error('[GreenAPI] sendText failed:', JSON.stringify(data)); return false; }
    return true;
  } catch (e) {
    console.error('[GreenAPI] sendText error:', e.message);
    return false;
  }
}

async function sendFile(phone, urlFile, fileName, caption = '', { priority = false } = {}) {
  if (isDisabled()) { console.log('[GreenAPI] WA_DISABLED — sendFile suppressed to', phone); return false; }
  if (!_checkAndIncrementCap()) return false;
  const instanceId = process.env.GREENAPI_INSTANCE_ID;
  const token      = process.env.GREENAPI_API_TOKEN;
  if (!instanceId || !token) {
    console.error('[GreenAPI] GREENAPI_INSTANCE_ID or GREENAPI_API_TOKEN not set');
    return false;
  }
  const chatId = toChatId(phone);
  if (!chatId) { console.error('[GreenAPI] Invalid phone:', phone); return false; }
  try {
    const rl = await _rateLimit(priority);
    if (rl === 'RATE_LIMITED') { _dailySendCount--; _hourlySendCount--; return false; }
    const res  = await fetch(`${BASE}/waInstance${instanceId}/sendFileByUrl/${token}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chatId, urlFile, fileName: fileName || 'file', caption }),
    });
    const data = await res.json();
    if (!data.idMessage) { console.error('[GreenAPI] sendFile failed:', JSON.stringify(data)); return false; }
    return true;
  } catch (e) {
    console.error('[GreenAPI] sendFile error:', e.message);
    return false;
  }
}

/**
 * sendFileByUpload — upload a file buffer directly to Green API and send.
 * fileBuffer: Buffer, fileName: string, caption: optional string
 * Returns idMessage string on success, false on failure.
 */
async function sendFileByUpload(phone, fileBuffer, fileName, caption = '') {
  if (isDisabled()) { console.log('[GreenAPI] WA_DISABLED — sendFileByUpload suppressed to', phone); return false; }
  if (!_checkAndIncrementCap()) return false;
  const instanceId = process.env.GREENAPI_INSTANCE_ID;
  const token      = process.env.GREENAPI_API_TOKEN;
  if (!instanceId || !token) {
    console.error('[GreenAPI] GREENAPI_INSTANCE_ID or GREENAPI_API_TOKEN not set');
    return false;
  }
  const chatId = toChatId(phone);
  if (!chatId) { console.error('[GreenAPI] Invalid phone:', phone); return false; }
  try {
    const rl = await _rateLimit(true); // priority — file uploads are admin-initiated
    if (rl === 'RATE_LIMITED') { _dailySendCount--; _hourlySendCount--; return false; }

    // Build multipart form-data manually using native fetch + Blob
    const { FormData, Blob } = await import('formdata-node');
    const form = new FormData();
    form.set('chatId', chatId);
    form.set('caption', caption);
    form.set('file', new Blob([fileBuffer]), fileName);

    const res = await fetch(`${BASE}/waInstance${instanceId}/sendFileByUpload/${token}`, {
      method: 'POST',
      body:   form,
    });
    const data = await res.json();
    if (!data.idMessage) { console.error('[GreenAPI] sendFileByUpload failed:', JSON.stringify(data)); return false; }
    return data.idMessage;
  } catch (e) {
    console.error('[GreenAPI] sendFileByUpload error:', e.message);
    return false;
  }
}

/**
 * sendButtons — interactive message with up to 3 tap buttons.
 * Falls back to plain text if Green API returns an error.
 * buttons: [{ id: '1', text: '🛒 Shop Now' }, ...]   (max 3)
 */
async function sendButtons(phone, message, buttons, footer = '') {
  if (isDisabled()) { console.log('[GreenAPI] WA_DISABLED — sendButtons suppressed to', phone); return false; }
  if (!_checkAndIncrementCap()) return false;
  const instanceId = process.env.GREENAPI_INSTANCE_ID;
  const token      = process.env.GREENAPI_API_TOKEN;
  if (!instanceId || !token) return false;
  const chatId = toChatId(phone);
  if (!chatId) return false;
  try {
    await _rateLimit();
    const res  = await fetch(`${BASE}/waInstance${instanceId}/sendButtons/${token}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chatId,
        message,
        footer,
        buttons: buttons.map(b => ({ buttonId: String(b.id), buttonText: b.text })),
      }),
    });
    const data = await res.json();
    if (!data.idMessage) {
      console.error('[GreenAPI] sendButtons failed:', JSON.stringify(data));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[GreenAPI] sendButtons error:', e.message);
    return false;
  }
}

/**
 * sendListMessage — interactive list with multiple rows grouped in sections.
 * sections: [{ title: 'Options', rows: [{ id:'1', title:'🛒 Shop', desc:'Browse products' }] }]
 * buttonText: label on the "open list" button (max 20 chars)
 */
async function sendListMessage(phone, message, buttonText, sections, footer = '') {
  if (isDisabled()) { console.log('[GreenAPI] WA_DISABLED — sendListMessage suppressed to', phone); return false; }
  if (!_checkAndIncrementCap()) return false;
  const instanceId = process.env.GREENAPI_INSTANCE_ID;
  const token      = process.env.GREENAPI_API_TOKEN;
  if (!instanceId || !token) return false;
  const chatId = toChatId(phone);
  if (!chatId) return false;
  try {
    await _rateLimit();
    const res  = await fetch(`${BASE}/waInstance${instanceId}/sendListMessage/${token}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chatId,
        message,
        buttonText,
        footer,
        // Green API expects rowId not id
        sections: sections.map(s => ({
          ...s,
          rows: s.rows.map(r => ({ rowId: r.id || r.rowId, title: r.title, description: r.description || '' })),
        })),
      }),
    });
    const data = await res.json();
    if (!data.idMessage) {
      console.error('[GreenAPI] sendListMessage failed:', JSON.stringify(data));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[GreenAPI] sendListMessage error:', e.message);
    return false;
  }
}

/**
 * sendContact — send a vCard contact card so the customer can save our number with one tap.
 * phoneContact: digits only, e.g. 917092377092
 */
async function sendContact(phone, contactPhone, firstName, lastName = '', company = '') {
  if (isDisabled()) { console.log('[GreenAPI] WA_DISABLED — sendContact suppressed to', phone); return false; }
  if (!_checkAndIncrementCap()) return false;
  const instanceId = process.env.GREENAPI_INSTANCE_ID;
  const token      = process.env.GREENAPI_API_TOKEN;
  if (!instanceId || !token) return false;
  const chatId = toChatId(phone);
  if (!chatId) return false;
  try {
    await _rateLimit();
    const res  = await fetch(`${BASE}/waInstance${instanceId}/sendContact/${token}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chatId,
        contact: { phoneContact: parseInt(contactPhone), firstName, lastName, company },
      }),
    });
    const data = await res.json();
    if (!data.idMessage) { console.error('[GreenAPI] sendContact failed:', JSON.stringify(data)); return false; }
    return true;
  } catch (e) {
    console.error('[GreenAPI] sendContact error:', e.message);
    return false;
  }
}

/**
 * sendToGroup — send a text message to a WhatsApp group using its chatId directly.
 * chatId format: "120363403146320645@g.us"
 */
async function sendToGroup(chatId, message) {
  if (isDisabled()) { console.log('[GreenAPI] WA_DISABLED — sendToGroup suppressed to', chatId); return false; }
  if (!_checkAndIncrementCap()) return false;
  const instanceId = process.env.GREENAPI_INSTANCE_ID;
  const token      = process.env.GREENAPI_API_TOKEN;
  if (!instanceId || !token) { console.error('[GreenAPI] credentials not set'); return false; }
  if (!chatId) { console.error('[GreenAPI] sendToGroup: chatId required'); return false; }
  try {
    await _rateLimit();
    const res  = await fetch(`${BASE}/waInstance${instanceId}/sendMessage/${token}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chatId, message }),
    });
    const data = await res.json();
    if (!data.idMessage) { console.error('[GreenAPI] sendToGroup failed:', JSON.stringify(data)); return false; }
    return true;
  } catch (e) {
    console.error('[GreenAPI] sendToGroup error:', e.message);
    return false;
  }
}

/**
 * isAutomationDisabled — check if a specific automation category is disabled.
 * Reads from in-memory cache (global.__waAutomations) populated by settings API.
 * Falls back to Supabase if cache is empty (first call).
 * Returns true if the automation should be BLOCKED.
 */
let _automationsLoaded = false;
let _automationsLoadedAt = 0;
const AUTOMATIONS_CACHE_TTL = 5 * 60 * 1000; // refresh every 5 minutes

async function isAutomationDisabled(category) {
  const stale = Date.now() - _automationsLoadedAt > AUTOMATIONS_CACHE_TTL;
  if ((!_automationsLoaded && !global.__waAutomations) || stale) {
    try {
      const supabase = require('../config/supabase');
      const { data } = await supabase.from('settings').select('value').eq('key', 'wa_automations').maybeSingle();
      global.__waAutomations = data?.value || {};
      _automationsLoaded = true;
      _automationsLoadedAt = Date.now();
    } catch (e) {
      console.error('[GreenAPI] Failed to load wa_automations:', e.message);
      return false; // fail open — don't block if we can't read settings
    }
  }
  const toggles = global.__waAutomations || {};
  return toggles[category] === false; // explicitly false = disabled
}

// Send "typing..." presence to a chat — no rate limit, no cap (it's not a message)
async function sendTyping(phone) {
  const instanceId = process.env.GREENAPI_INSTANCE_ID;
  const token      = process.env.GREENAPI_API_TOKEN;
  if (!instanceId || !token) return false;
  const chatId = toChatId(phone);
  if (!chatId) return false;
  try {
    await fetch(`${BASE}/waInstance${instanceId}/sendPresence/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, presence: 'typing' }),
    });
    return true;
  } catch { return false; }
}

module.exports = { sendText, sendFile, sendFileByUpload, toChatId, sendButtons, sendListMessage, sendToGroup, sendContact, isAutomationDisabled, getDailySendCount, sendTyping, checkCustomerRate: _checkCustomerRate };
