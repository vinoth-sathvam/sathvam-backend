/**
 * One-off: set unit_price on labels by size
 * Run: node scripts/set-label-prices-2026-04-18.js
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const supabase = require('../config/supabase');

// Normalise size strings to a common key
const PRICE_MAP = {
  '5000ml': 10,
  '1l':     3.5,
  '500ml':  2.5,
  '100ml':  2,
  '1kg':    8,
  '500g':   4,
  '250g':   3,
  '200g':   2,
};

function normalise(size) {
  return (size || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/500gm/, '500g')
    .replace(/200gm/, '200g')
    .replace(/250gm/, '250g')
    .replace(/1000ml/, '1l')
    .replace(/1000g/,  '1kg');
}

async function run() {
  const now = new Date().toISOString();

  const { data: labels, error } = await supabase
    .from('packing_materials')
    .select('id, name, size, unit_price')
    .eq('category', 'label')
    .eq('active', true);

  if (error) { console.error('Fetch error:', error.message); process.exit(1); }

  let updated = 0, skipped = 0;

  for (const lbl of (labels || [])) {
    const key   = normalise(lbl.size);
    const price = PRICE_MAP[key];

    if (price == null) {
      console.log(`  - SKIP  [${lbl.name}] size="${lbl.size}" — no price rule`);
      skipped++;
      continue;
    }

    const { error: upErr } = await supabase
      .from('packing_materials')
      .update({ unit_price: price, updated_at: now })
      .eq('id', lbl.id);

    if (upErr) {
      console.error(`  ✗ FAIL  [${lbl.name}]:`, upErr.message);
    } else {
      console.log(`  ✓ SET   [${lbl.name}] → ₹${price}`);
      updated++;
    }
  }

  console.log(`\nDone. Updated: ${updated}  Skipped: ${skipped}`);
  process.exit(0);
}

run();
