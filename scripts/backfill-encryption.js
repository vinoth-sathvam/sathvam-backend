#!/usr/bin/env node
/**
 * One-time backfill script: encrypt all existing plaintext customer PII in:
 *   - customers table (name, email, phone, address, city, state, pincode)
 *   - webstore_orders table (customer JSONB field)
 *
 * Run AFTER:
 *   1. Applying migrations/add_encryption_columns.sql in Supabase
 *   2. Adding ENCRYPTION_KEY to .env
 *   3. node scripts/backfill-encryption.js
 *
 * Safe to re-run — already-encrypted values (ENC: prefix) are skipped.
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const supabase = require('../config/supabase');
const { encrypt, hmac, decryptCustomer, CUSTOMER_PII } = require('../config/crypto');

const BATCH_SIZE = 100;

function needsEncryption(value) {
  return value && typeof value === 'string' && !value.startsWith('ENC:');
}

async function backfillCustomers() {
  console.log('\n── Customers table ──────────────────────────────');
  let offset = 0;
  let total = 0;

  while (true) {
    const { data: rows, error } = await supabase
      .from('customers')
      .select('id,name,email,phone,address,city,state,pincode,email_hash')
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) { console.error('  Error fetching customers:', error.message); break; }
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      // Skip if email is already encrypted (already migrated)
      if (row.email && !needsEncryption(row.email)) continue;

      const normEmail = (row.email || '').toLowerCase().trim();
      const updates = {};

      for (const f of CUSTOMER_PII) {
        if (needsEncryption(row[f])) {
          updates[f] = encrypt(row[f]);
        }
      }

      if (!row.email_hash && normEmail) {
        updates.email_hash = hmac(normEmail);
      }

      if (Object.keys(updates).length > 0) {
        const { error: upErr } = await supabase.from('customers').update(updates).eq('id', row.id);
        if (upErr) {
          console.error(`  Failed to encrypt customer ${row.id}:`, upErr.message);
        } else {
          total++;
          process.stdout.write(`  Encrypted customer ${row.id} (${normEmail})\n`);
        }
      }
    }

    offset += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }

  console.log(`  Done. ${total} customers encrypted.`);
}

async function backfillOrders() {
  console.log('\n── webstore_orders table ────────────────────────');
  let offset = 0;
  let total = 0;

  while (true) {
    const { data: rows, error } = await supabase
      .from('webstore_orders')
      .select('id,customer,customer_email_hash')
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) { console.error('  Error fetching orders:', error.message); break; }
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      const cust = row.customer;
      if (!cust || typeof cust !== 'object') continue;

      // Check if customer email is already encrypted
      const emailVal = cust.email || '';
      if (emailVal && !needsEncryption(emailVal)) continue; // already encrypted

      // Build encrypted customer object
      const encCust = {};
      let changed = false;
      for (const f of CUSTOMER_PII) {
        if (cust[f] !== undefined) {
          if (needsEncryption(cust[f])) {
            encCust[f] = encrypt(cust[f]);
            changed = true;
          } else {
            encCust[f] = cust[f];
          }
        }
      }
      // Preserve any non-PII fields (e.g. payment method)
      for (const k of Object.keys(cust)) {
        if (!CUSTOMER_PII.includes(k)) encCust[k] = cust[k];
      }

      const updates = {};
      if (changed) updates.customer = encCust;
      if (!row.customer_email_hash && emailVal) {
        updates.customer_email_hash = hmac(emailVal.toLowerCase().trim());
      }

      if (Object.keys(updates).length > 0) {
        const { error: upErr } = await supabase.from('webstore_orders').update(updates).eq('id', row.id);
        if (upErr) {
          console.error(`  Failed to encrypt order ${row.id}:`, upErr.message);
        } else {
          total++;
          process.stdout.write(`  Encrypted order ${row.id}\n`);
        }
      }
    }

    offset += rows.length;
    if (rows.length < BATCH_SIZE) break;
  }

  console.log(`  Done. ${total} orders encrypted.`);
}

async function main() {
  console.log('Sathvam PII Backfill — AES-256-GCM encryption');
  console.log('==============================================');

  if (!process.env.ENCRYPTION_KEY) {
    console.error('\nFATAL: ENCRYPTION_KEY not set in .env');
    console.error('Generate one with:');
    console.error("  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"");
    process.exit(1);
  }

  await backfillCustomers();
  await backfillOrders();

  console.log('\nBackfill complete.');
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
