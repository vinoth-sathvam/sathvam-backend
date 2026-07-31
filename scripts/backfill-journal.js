#!/usr/bin/env node
/**
 * One-time script: backfill journal entries from money_ledger records.
 * Safe to run multiple times (idempotent via ref_no).
 *
 * Usage: node scripts/backfill-journal.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const supabase = require('../config/supabase');
const { insertJournal } = require('../utils/journalPoster');

async function main() {
  console.log('Fetching money_ledger entries...');
  const { data: rows, error } = await supabase.from('money_ledger')
    .select('*').order('txn_date', { ascending: true });

  if (error) { console.error('Failed to fetch:', error.message); process.exit(1); }
  console.log(`Found ${rows.length} money_ledger entries`);

  let posted = 0, skipped = 0, errors = 0;

  for (const row of rows) {
    try {
      // Check if already posted
      const refNo = (row.source_table && row.source_id)
        ? `${row.source_table}-${row.source_id}`
        : `ML-${row.id}`;

      const { data: existing } = await supabase.from('journal_entries')
        .select('id').eq('ref_no', refNo).maybeSingle();
      if (existing) { skipped++; continue; }

      // Override source for ref_no generation
      const data = { ...row };
      if (!data.source_table || !data.source_id) {
        data.source_table = 'money_ledger';
        data.source_id = String(row.id);
      }

      await insertJournal(data);
      posted++;
    } catch (e) {
      errors++;
      console.error(`Error on row ${row.id}:`, e.message);
    }
  }

  console.log(`\nBackfill complete:`);
  console.log(`  Total:   ${rows.length}`);
  console.log(`  Posted:  ${posted}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Errors:  ${errors}`);

  // Verify
  const { data: jeCount } = await supabase.from('journal_entries').select('id', { count: 'exact', head: true });
  console.log(`\nJournal entries in DB: ${jeCount?.length ?? 'unknown'}`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
