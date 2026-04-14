'use strict';
/**
 * Application-level AES-256-GCM encryption for customer PII.
 *
 * Why application-level and not just DB encryption?
 *   - Database-level encryption (Supabase TDE) protects physical disk access but
 *     still exposes plaintext to anyone with DB credentials or a leaked backup.
 *   - Application-level encryption means even a full DB dump is useless without
 *     the ENCRYPTION_KEY stored separately in the server environment.
 *
 * Algorithm: AES-256-GCM
 *   - 256-bit key, 96-bit random IV per encryption
 *   - GCM mode provides authenticated encryption (integrity + confidentiality)
 *   - Tampered ciphertext is rejected at decrypt time
 *
 * Email lookups:
 *   Since the same plaintext always produces a DIFFERENT ciphertext (random IV),
 *   encrypted email cannot be used in a WHERE clause. Instead we store an
 *   HMAC-SHA256 of the normalised email in a separate `email_hash` column and
 *   index that for lookups.
 *
 * Backward compatibility:
 *   Existing rows that were inserted before this module was deployed will have
 *   plaintext values (no ENC: prefix). decrypt() detects this and returns the
 *   value unchanged so old rows still work while new rows are encrypted.
 *
 * Key generation (run once, save to .env):
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */

const crypto = require('crypto');

const ALGO   = 'aes-256-gcm';
const PREFIX = 'ENC:';        // sentinel so we can detect encrypted values
const IV_LEN = 12;            // 96-bit IV — optimal for GCM

// Lazy-cache the key buffer so we parse it once per process lifetime.
let _cachedKey = null;

function getKey() {
  if (_cachedKey) return _cachedKey;
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('FATAL: ENCRYPTION_KEY is not set in environment');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must decode to exactly 32 bytes (got ${buf.length}). ` +
      'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
  }
  _cachedKey = buf;
  return buf;
}

/**
 * Encrypt a string value.
 * Returns null/undefined/''/already-encrypted values unchanged.
 * Stored format: ENC:<iv_base64url>:<authtag_base64url>:<ciphertext_base64url>
 */
function encrypt(value) {
  if (value === null || value === undefined || value === '') return value;
  const text = String(value);
  if (text.startsWith(PREFIX)) return text; // already encrypted — idempotent
  const key    = getKey();
  const iv     = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc    = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return (
    PREFIX +
    iv.toString('base64url')  + ':' +
    tag.toString('base64url') + ':' +
    enc.toString('base64url')
  );
}

/**
 * Decrypt a value produced by encrypt().
 * If the value does NOT start with ENC: it is treated as legacy plaintext
 * and returned as-is (backward compatibility with pre-encryption rows).
 * Returns null if decryption fails (tampered data).
 */
function decrypt(value) {
  if (value === null || value === undefined || value === '') return value;
  const s = String(value);
  if (!s.startsWith(PREFIX)) return s; // legacy plaintext — return as-is
  try {
    const inner = s.slice(PREFIX.length);
    const parts = inner.split(':');
    if (parts.length !== 3) return null; // malformed
    const [ivB64, tagB64, dataB64] = parts;
    const key      = getKey();
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return (
      decipher.update(Buffer.from(dataB64, 'base64url')) +
      decipher.final('utf8')
    );
  } catch {
    return null; // authentication tag mismatch (tampered) or corrupt data
  }
}

/**
 * HMAC-SHA256 of a normalised value.
 * Used to create a searchable, deterministic hash of encrypted fields
 * (e.g. email_hash column) so we can do WHERE email_hash = hmac(input).
 * The key is used as the HMAC secret so the hash is useless without it.
 */
function hmac(value) {
  if (!value) return null;
  return crypto
    .createHmac('sha256', getKey())
    .update(String(value).toLowerCase().trim())
    .digest('hex');
}

// ── Convenience helpers for customer objects ──────────────────────────────────

const CUSTOMER_PII = ['name', 'email', 'phone', 'address', 'city', 'state', 'pincode'];

/**
 * Return a new customer object with all PII fields encrypted.
 * Also sets email_hash for DB lookup.
 */
function encryptCustomer(obj) {
  if (!obj) return obj;
  const out = { ...obj };
  for (const f of CUSTOMER_PII) {
    if (out[f] != null && out[f] !== '') {
      out[f] = encrypt(out[f]);
    }
  }
  return out;
}

/**
 * Return a new customer object with all PII fields decrypted.
 * Safe to call on legacy plaintext objects — decrypt() is a no-op there.
 */
function decryptCustomer(obj) {
  if (!obj) return obj;
  const out = { ...obj };
  for (const f of CUSTOMER_PII) {
    if (out[f] != null) out[f] = decrypt(out[f]);
  }
  return out;
}

module.exports = { encrypt, decrypt, hmac, encryptCustomer, decryptCustomer, CUSTOMER_PII };
