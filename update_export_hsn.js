const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  'https://qgoyiwtxgelupamskhaa.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFnb3lpd3R4Z2VsdXBhbXNraGFhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDUxMTkzMCwiZXhwIjoyMDkwMDg3OTMwfQ.0-WKSNEch8WDYnD5n8a_hsqA9_-T3RIa-xS5mttMCOg',
  { auth: { autoRefreshToken: false, persistSession: false } }
);
const PROJECT_ID = '86b1cba6-65ea-4b10-97a8-a98ddcce6761';

// User-provided export HSN mapping (product name → export HSN code)
// Names normalised to uppercase for fuzzy matching
const EXPORT_HSN = [
  ["CASTOR OIL 500ML",           "15153010"],
  ["NEEM OIL 100ML",             "15159020"],
  ["DEEPAM OIL 1000ML",          "15159099"],
  ["PAPPAD 160GM",               "19059040"],
  ["IDLY POWDER 1000GM",         "09109100"],
  ["ROUND JAGGERY 500GM",        "17011310"],
  ["RICE FLOUR 500GM",           "11029022"],
  ["SPROUTED RAGI FLOUR 500GM",  "11029029"],
  ["WHITE SORGHUM FLOUR 500GM",  "11029029"],
  ["BESAN FLOUR 500GM",          "11029090"],
  ["PARUPPU POWDER 200GM",       "21069099"],
  ["FOXTAIL MILLET 500GM",       "11029090"],
  ["SALT 500GM",                 "25010010"],
  ["KODO MILLET 500GM",          "10082170"],
  ["FINGER MILLET 500GM",        "10082199"],
  ["FLAX 500GM",                 "12040090"],
  ["LITTLE MILLET 500GM",        "10082980"],
  ["WHITE SORGHUM MILLET 500GM", "10082199"],
  ["BARLEY 500GM",               "10039000"],
  ["BARNYARD MILLET 500GM",      "10082199"],
  ["MOONG DAL 500GM",            "07133110"],
  ["BENGAL GRAM 500GM",          "07132020"],
  ["TAMARIND 500GM",             "08134010"],
  ["FENUGREEK 200GM",            "09109912"],
  ["CUMIN 200GM",                "09093119"],
  ["FENNEL 200GM",               "09096230"],
  ["BLACK CHICK PEAS 500GM",     "07132010"],
  ["WHITE CHICK PEAS 500GM",     "07132010"],
  ["CORRIANDER 200GM",           "09092190"],
  ["WHOLE MOONG BEANS 500GM",    "07133110"],
  ["AJWAIN 100G",                "09109914"],
  ["WHITE AVAL 250GM",           "19041090"],
  ["RED AVAL 250GM",             "19041090"],
  ["VEGETARIAN SOYAMATE 200GM",  "21061000"],
  ["URAD DHAL 1000GM",           "11063090"],
  ["MASOOR DAL 1000GM",          "07139090"],
  ["TOOR DAL 1000GM",            "07139090"],
  ["BLACK RAISIN 250G",          "08062010"],
  ["DRY GOLDEN RAISIN 250GM",    "08062010"],
  ["ROASTED BENGAL GRAM 500GM",  "07132020"],
  ["FENUGREEK 1000GM",           "09109912"],
  ["MUSTARD 1000GM",             "09109927"],
  ["WHITE SESAME 200GM",         "12074090"],
  ["GROUNDNUT 500GM",            "20081100"],
  ["RAJMA (CHITRA) 500GM",       "07133300"],
  ["PEPPER 1000GM",              "09041140"],
  ["RED RAJMA 500GM",            "07133300"],
  ["NUTMEG 1000GM",              "09081120"],
  ["JAVITHRI 500GM",             "09082200"],
  ["BARNYARD MILLET FLAKES 200GM","19042090"],
  ["NAVATHANIYA DOSA MIX 500GM", "21069099"],
  ["MILLET DOSA MIX 500GM",      "21069099"],
  ["HING 80GM",                  "13019013"],
  ["WHOLE MOONG BEANS 1000GM",   "07133110"],
  ["WHITE CHICK PEAS 1000GM",    "07132010"],
  ["FOXTAIL MILLET 1000GM",      "10083090"],
  ["MOONG DAL 1000GM",           "07133110"],
  ["BLACK CUMIN 80GM",           "09093119"],
  ["BAY LEAF 40GM",              "09109990"],
  ["STAR ANISE 25GM",            "09096119"],
  ["KASOORI METHI 50GM",         "09109990"],
  ["CHIA 500GM",                 "12079990"],
  ["JAGGERY POWDER 1000GM",      "17011310"],
  ["RED SOIL TOOR DAL 1000GM",   "07139090"],
];

const norm = s => s.toUpperCase().replace(/[^A-Z0-9 ]/g,' ').replace(/\s+/g,' ').trim();

// Fuzzy match: extract keywords from export name, find calc item whose name contains them
function findMatch(exportName, calcItems) {
  const en = norm(exportName);
  // Remove size suffix (e.g. "500GM", "1000GM", "100G")
  const noSize = en.replace(/\b\d+\s*(?:GM|ML|KG|G|L)\b/g,'').trim();
  const words = noSize.split(' ').filter(w => w.length > 2);

  // Size in kg from export name
  const sizeM = exportName.match(/(\d+)\s*(G|GM|KG|ML|L)$/i);
  let sizeKg = -1;
  if (sizeM) {
    const n = parseFloat(sizeM[1]);
    const u = sizeM[2].toUpperCase();
    sizeKg = (u==='G'||u==='GM') ? n/1000 : (u==='KG') ? n : (u==='ML') ? n/1000 : n;
  }

  const deriveSize = it => {
    const pu = (it.packUnit||'').toUpperCase();
    const ps = parseFloat(it.packSize)||0;
    if (ps > 0) {
      if (pu==='L'||pu==='KG') return ps;
      if (pu==='ML'||pu==='GM') return ps/1000;
    }
    return parseFloat(it.sizeL)||0;
  };

  // Try: all keywords match + size matches
  let found = calcItems.find(it => {
    const cn = norm(it.name);
    const sizeOk = sizeKg < 0 || Math.abs(deriveSize(it) - sizeKg) < 0.001;
    return words.length > 0 && words.every(w => cn.includes(w)) && sizeOk;
  });
  if (found) return found;

  // Relax: all keywords match (ignore size)
  found = calcItems.find(it => {
    const cn = norm(it.name);
    return words.length > 0 && words.every(w => cn.includes(w));
  });
  if (found) return found;

  // Relax: first 2 keywords + size
  if (words.length >= 2) {
    found = calcItems.find(it => {
      const cn = norm(it.name);
      const sizeOk = sizeKg < 0 || Math.abs(deriveSize(it) - sizeKg) < 0.001;
      return cn.includes(words[0]) && cn.includes(words[1]) && sizeOk;
    });
  }
  return found || null;
}

async function main() {
  const { data, error } = await supabase
    .from('settings').select('value').eq('key', `project_full_${PROJECT_ID}`).single();
  if (error) { console.error(error); return; }

  const proj = data.value;
  const cc = proj.cc || {};
  const items = cc.items || [];

  console.log(`Loaded ${items.length} CC items\n`);

  let updated = 0, notFound = [];
  const updatedItems = items.map(it => ({ ...it })); // clone

  for (const [exportName, hsn] of EXPORT_HSN) {
    const match = findMatch(exportName, updatedItems);
    if (match) {
      const idx = updatedItems.findIndex(it => it.id === match.id);
      updatedItems[idx] = { ...updatedItems[idx], exportHsn: hsn };
      updated++;
      console.log(`✓ ${exportName.padEnd(38)} → "${match.name}" exportHsn=${hsn}`);
    } else {
      notFound.push(exportName);
      console.log(`✗ NO MATCH: ${exportName}`);
    }
  }

  console.log(`\n✅ Matched: ${updated} / ${EXPORT_HSN.length}`);
  if (notFound.length) console.log(`⚠ Not found: ${notFound.join(', ')}`);

  // Save back to DB
  const updatedProj = { ...proj, cc: { ...cc, items: updatedItems } };
  const { error: saveErr } = await supabase
    .from('settings')
    .upsert({ key: `project_full_${PROJECT_ID}`, value: updatedProj, updated_at: new Date().toISOString() });

  if (saveErr) { console.error('Save error:', saveErr); return; }
  console.log('\n✅ Saved to DB');
}

main().catch(console.error);
