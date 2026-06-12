/**
 * Cart Reminder Image Generator + WhatsApp Sender
 *
 * POST /api/cart-reminder/send
 *   Body: { phone, name, items: [{product, qty}], cart_value }
 *
 * Generates a branded PNG via the Python/Playwright script at
 * /home/ubuntu/cart-reminder/generate_reminder.py, then uploads
 * it to Green API via sendFileByUpload (direct binary upload, no public URL needed).
 */

const express    = require('express');
const { execFile } = require('child_process');
const fs         = require('fs');
const path       = require('path');
const { auth }   = require('../middleware/auth');
const { toChatId } = require('../lib/greenapi');

const router     = express.Router();

const SCRIPT_DIR = '/home/ubuntu/cart-reminder';
const SCRIPT     = path.join(SCRIPT_DIR, 'generate_reminder.py');
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'output');
const PYTHON     = 'python3';

const GREENAPI_BASE = 'https://api.green-api.com';

// ── Helper: upload PNG file to Green API and send to WhatsApp ─────────────────
async function sendPngViaGreenApi(phone, pngPath, caption) {
  const instanceId = process.env.GREENAPI_INSTANCE_ID;
  const token      = process.env.GREENAPI_API_TOKEN;
  const chatId     = toChatId(phone);
  if (!chatId) throw new Error(`Invalid phone number: ${phone}`);

  const fileBuffer = fs.readFileSync(pngPath);
  const blob       = new Blob([fileBuffer], { type: 'image/png' });

  const form = new FormData();
  form.append('chatId', chatId);
  form.append('caption', caption || '');
  form.append('file', blob, 'Sathvam_Cart_Reminder.png');

  const res  = await fetch(
    `${GREENAPI_BASE}/waInstance${instanceId}/sendFileByUpload/${token}`,
    { method: 'POST', body: form }
  );
  const data = await res.json();
  if (!data.idMessage) throw new Error(`Green API error: ${JSON.stringify(data)}`);
  return data.idMessage;
}

// ── Helper: safe filename from customer name ──────────────────────────────────
function safeName(name) {
  return (name || 'Customer').replace(/[^a-zA-Z0-9_-]/g, '_');
}

// ── Helper: run the Python generator ─────────────────────────────────────────
function runGenerator(inputJsonPath) {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON,
      [SCRIPT, '--input', inputJsonPath],
      { timeout: 45_000, cwd: SCRIPT_DIR },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      }
    );
  });
}

// ── POST /api/cart-reminder/send ──────────────────────────────────────────────
router.post('/send', auth, async (req, res) => {
  const { phone, name, items, cart_value } = req.body;

  if (!phone)                           return res.status(400).json({ error: 'phone required' });
  if (!name)                            return res.status(400).json({ error: 'name required' });
  if (!Array.isArray(items) || !items.length)
                                        return res.status(400).json({ error: 'items must be a non-empty array' });

  const tmpJson  = path.join('/tmp', `cart_rm_${Date.now()}.json`);
  const pngPath  = path.join(OUTPUT_DIR, `${safeName(name)}_cart_reminder.png`);

  try {
    // 1. Write temp input JSON
    fs.writeFileSync(tmpJson, JSON.stringify([{ name, items, cart_value: cart_value || 0 }]));

    // 2. Generate PNG
    await runGenerator(tmpJson);

    if (!fs.existsSync(pngPath)) throw new Error('PNG was not generated');

    // 3. Send via Green API
    const caption = `🌿 *SATHVAM*\n_Pure. Cold-Pressed. Honest._\n\nDear *${name}*, your cart is saved and waiting for you 🛒\n\n👉 *Complete your order:*\nhttps://www.sathvam.in/cart\n\nReply here anytime — we're happy to help! 🙏`;
    const msgId   = await sendPngViaGreenApi(phone, pngPath, caption);

    res.json({ ok: true, idMessage: msgId });
  } catch (err) {
    console.error('[cart-reminder]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (fs.existsSync(tmpJson)) fs.unlinkSync(tmpJson);
  }
});

module.exports = router;
