// Run once: node migrations/run-2fa-migration.js
// Adds 2FA columns to users and customers tables via Supabase service role
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function runSQL(sql) {
  // Supabase doesn't expose raw SQL via REST unless you have a pg_net function.
  // We use the PostgREST schema introspection trick: try to UPDATE with the column,
  // if it fails with 42703 (column not found) we know migration is needed.
  // Actual DDL must go through Supabase dashboard SQL editor.
  console.log('SQL to run in Supabase dashboard:\n');
  console.log(sql);
}

runSQL(`
-- Run this in your Supabase project > SQL Editor:
ALTER TABLE users      ADD COLUMN IF NOT EXISTS totp_secret  TEXT;
ALTER TABLE users      ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE customers  ADD COLUMN IF NOT EXISTS totp_secret  TEXT;
ALTER TABLE customers  ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
`);

// Verify columns exist
async function verify() {
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
  };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/users?select=totp_enabled&limit=1`, { headers });
  if (r.ok) { console.log('\n✅ users.totp_enabled — EXISTS'); }
  else { console.log('\n❌ users.totp_enabled — MISSING — run the SQL above in Supabase dashboard'); }

  const r2 = await fetch(`${SUPABASE_URL}/rest/v1/customers?select=totp_enabled&limit=1`, { headers });
  if (r2.ok) { console.log('✅ customers.totp_enabled — EXISTS'); }
  else { console.log('❌ customers.totp_enabled — MISSING — run the SQL above in Supabase dashboard'); }
}

verify();
