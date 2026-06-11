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

module.exports = { sendText, sendFile, toChatId };
