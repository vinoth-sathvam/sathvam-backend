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

async function sendText(phone, message) {
  if (isDisabled()) { console.log('[GreenAPI] WA_DISABLED — sendText suppressed to', phone); return false; }
  const instanceId = process.env.GREENAPI_INSTANCE_ID;
  const token      = process.env.GREENAPI_API_TOKEN;
  if (!instanceId || !token) {
    console.error('[GreenAPI] GREENAPI_INSTANCE_ID or GREENAPI_API_TOKEN not set');
    return false;
  }
  const chatId = toChatId(phone);
  if (!chatId) { console.error('[GreenAPI] Invalid phone:', phone); return false; }
  try {
    const res  = await fetch(`${BASE}/waInstance${instanceId}/sendMessage/${token}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chatId, message }),
    });
    const data = await res.json();
    if (!data.idMessage) { console.error('[GreenAPI] sendText failed:', JSON.stringify(data)); return false; }
    return true;
  } catch (e) {
    console.error('[GreenAPI] sendText error:', e.message);
    return false;
  }
}

async function sendFile(phone, urlFile, fileName, caption = '') {
  if (isDisabled()) { console.log('[GreenAPI] WA_DISABLED — sendFile suppressed to', phone); return false; }
  const instanceId = process.env.GREENAPI_INSTANCE_ID;
  const token      = process.env.GREENAPI_API_TOKEN;
  if (!instanceId || !token) {
    console.error('[GreenAPI] GREENAPI_INSTANCE_ID or GREENAPI_API_TOKEN not set');
    return false;
  }
  const chatId = toChatId(phone);
  if (!chatId) { console.error('[GreenAPI] Invalid phone:', phone); return false; }
  try {
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
 * sendButtons — interactive message with up to 3 tap buttons.
 * Falls back to plain text if Green API returns an error.
 * buttons: [{ id: '1', text: '🛒 Shop Now' }, ...]   (max 3)
 */
async function sendButtons(phone, message, buttons, footer = '') {
  if (isDisabled()) { console.log('[GreenAPI] WA_DISABLED — sendButtons suppressed to', phone); return false; }
  const instanceId = process.env.GREENAPI_INSTANCE_ID;
  const token      = process.env.GREENAPI_API_TOKEN;
  if (!instanceId || !token) return false;
  const chatId = toChatId(phone);
  if (!chatId) return false;
  try {
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
  const instanceId = process.env.GREENAPI_INSTANCE_ID;
  const token      = process.env.GREENAPI_API_TOKEN;
  if (!instanceId || !token) return false;
  const chatId = toChatId(phone);
  if (!chatId) return false;
  try {
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
  const instanceId = process.env.GREENAPI_INSTANCE_ID;
  const token      = process.env.GREENAPI_API_TOKEN;
  if (!instanceId || !token) return false;
  const chatId = toChatId(phone);
  if (!chatId) return false;
  try {
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
  const instanceId = process.env.GREENAPI_INSTANCE_ID;
  const token      = process.env.GREENAPI_API_TOKEN;
  if (!instanceId || !token) { console.error('[GreenAPI] credentials not set'); return false; }
  if (!chatId) { console.error('[GreenAPI] sendToGroup: chatId required'); return false; }
  try {
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
async function isAutomationDisabled(category) {
  if (!_automationsLoaded && !global.__waAutomations) {
    try {
      const supabase = require('../config/supabase');
      const { data } = await supabase.from('settings').select('value').eq('key', 'wa_automations').maybeSingle();
      global.__waAutomations = data?.value || {};
      _automationsLoaded = true;
    } catch (e) {
      console.error('[GreenAPI] Failed to load wa_automations:', e.message);
      return false; // fail open — don't block if we can't read settings
    }
  }
  const toggles = global.__waAutomations || {};
  return toggles[category] === false; // explicitly false = disabled
}

module.exports = { sendText, sendFile, toChatId, sendButtons, sendListMessage, sendToGroup, sendContact, isAutomationDisabled };
