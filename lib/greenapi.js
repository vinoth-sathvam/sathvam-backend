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

function toChatId(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  if (!digits || digits.length < 10) return null;
  const normalized = digits.length === 10 ? '91' + digits : digits;
  return normalized + '@c.us';
}

async function sendText(phone, message) {
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

module.exports = { sendText, sendFile, toChatId, sendButtons, sendListMessage };
