const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  'https://qgoyiwtxgelupamskhaa.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFnb3lpd3R4Z2VsdXBhbXNraGFhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDUxMTkzMCwiZXhwIjoyMDkwMDg3OTMwfQ.0-WKSNEch8WDYnD5n8a_hsqA9_-T3RIa-xS5mttMCOg',
  { auth: { autoRefreshToken: false, persistSession: false } }
);
const PROJECT_ID = '86b1cba6-65ea-4b10-97a8-a98ddcce6761';

// Direct name→exportHsn map for items that couldn't be fuzzy-matched
// Format: [exact calc item name, hsn]
const DIRECT = [
  // 8 unmatched MERCH items
  ["Jaggery 500G",         "17011310"],  // ROUND JAGGERY 500GM
  ["Coriander Seeds 200G", "09092190"],  // CORRIANDER 200GM
  ["Whole Mung Beans 500G","07133110"],  // WHOLE MOONG BEANS 500GM
  ["Vegetarain soyamate",  "21061000"],  // VEGETARIAN SOYAMATE 200GM
  ["Urad Dal 1KG",         "11063090"],  // URAD DHAL 1000GM
  ["Mace (Javitri)",       "09082200"],  // JAVITHRI 500GM
  ["Whole Mung Beans",     "07133110"],  // WHOLE MOONG BEANS 1000GM
  ["Kasthuri Methi",       "09109990"],  // KASOORI METHI 50GM

  // 9 MFG items
  ["Groundnut Oil 1000ML", "15131900"],
  ["Groundnut Oil 5000ML", "15131900"],
  ["Sesame Oil 1000ML",    "15155091"],
  ["Sesame Oil 5000ML",    "15155091"],  // if exists
  ["Groundnut Oil 250ML",  "15131900"],
  ["Chilli Powder",        "09042211"],
  ["Coriander Powder 200G","09092200"],
  ["Rasam Powder 200G",    "09109100"],
  ["Sambar Powder",        "09109100"],
];

async function main() {
  const { data, error } = await supabase
    .from('settings').select('value').eq('key', `project_full_${PROJECT_ID}`).single();
  if (error) { console.error(error); return; }

  const proj = data.value;
  const cc = proj.cc || {};
  const items = [...(cc.items || [])];

  let updated = 0, notFound = [];

  for (const [calcName, hsn] of DIRECT) {
    const idx = items.findIndex(it => it.name === calcName);
    if (idx >= 0) {
      items[idx] = { ...items[idx], exportHsn: hsn };
      updated++;
      console.log(`✓ "${calcName}" exportHsn=${hsn}`);
    } else {
      notFound.push(calcName);
      console.log(`✗ NOT FOUND: "${calcName}"`);
    }
  }

  console.log(`\nUpdated ${updated}, not found: ${notFound.length}`);
  if (notFound.length) console.log('Not found:', notFound);

  // Verify final coverage
  const withHsn = items.filter(it => it.exportHsn);
  console.log(`\nItems with exportHsn: ${withHsn.length} / ${items.length}`);
  const withoutHsn = items.filter(it => !it.exportHsn);
  if (withoutHsn.length) {
    console.log('Items still without exportHsn:');
    withoutHsn.forEach(it => console.log(`  - ${it.name} (${it.invoiceAssignment})`));
  }

  // Save
  const updatedProj = { ...proj, cc: { ...cc, items } };
  const { error: saveErr } = await supabase
    .from('settings')
    .upsert({ key: `project_full_${PROJECT_ID}`, value: updatedProj, updated_at: new Date().toISOString() });

  if (saveErr) { console.error('Save error:', saveErr); return; }
  console.log('\n✅ Saved to DB');
}

main().catch(console.error);
