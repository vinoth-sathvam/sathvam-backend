const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  'https://qgoyiwtxgelupamskhaa.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFnb3lpd3R4Z2VsdXBhbXNraGFhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDUxMTkzMCwiZXhwIjoyMDkwMDg3OTMwfQ.0-WKSNEch8WDYnD5n8a_hsqA9_-T3RIa-xS5mttMCOg',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const PROJECT_ID = '86b1cba6-65ea-4b10-97a8-a98ddcce6761';

// Merchant export data (from user's screenshot)
const merchantExport = [
  { name: "ASAFOETIDA 50G", qty: 100, total: 4550 },
  { name: "BAY LEAVES 100G", qty: 50, total: 1050 },
  { name: "BENGAL GRAM 1KG", qty: 72, total: 7624 },
  { name: "BIG ONION POWDER 100G", qty: 24, total: 2040 },
  { name: "BLACK PEPPER 100G", qty: 100, total: 6200 },
  { name: "BLACK PEPPER 50G", qty: 50, total: 1650 },
  { name: "BLACK PEPPER POWDER 100G", qty: 48, total: 3600 },
  { name: "CARDAMOM 10G", qty: 100, total: 8200 },
  { name: "CARDAMOM 50G", qty: 50, total: 21500 },
  { name: "CHILLI POWDER 200G", qty: 100, total: 9800 },
  { name: "CINNAMON 100G", qty: 24, total: 1848 },
  { name: "CLOVES 10G", qty: 100, total: 3500 },
  { name: "CLOVES 50G", qty: 50, total: 8000 },
  { name: "CORIANDER LEAVES POWDER 100G", qty: 50, total: 3500 },
  { name: "CORIANDER POWDER 200G", qty: 100, total: 6600 },
  { name: "CORIANDER SEEDS 200G", qty: 100, total: 4400 },
  { name: "CUMIN POWDER 100G", qty: 50, total: 2100 },
  { name: "CUMIN SEEDS 200G", qty: 100, total: 8400 },
  { name: "CURRY LEAVES POWDER 100G", qty: 50, total: 3600 },
  { name: "CURRY MASALA 200G", qty: 100, total: 10600 },
  { name: "DRUMSTICK POWDER 100G", qty: 50, total: 5400 },
  { name: "DRY GINGER POWDER 100G", qty: 50, total: 3850 },
  { name: "FENNEL 200G", qty: 100, total: 8165 },
  { name: "FENUGREEK POWDER 100G", qty: 50, total: 2450 },
  { name: "FENUGREEK SEEDS 200G", qty: 100, total: 4600 },
  { name: "FISH CURRY MASALA 200G", qty: 100, total: 10600 },
  { name: "GARLIC POWDER 100G", qty: 50, total: 4800 },
  { name: "GREEN CHILLI POWDER 100G", qty: 50, total: 3800 },
  { name: "HORSE GRAM 1KG", qty: 24, total: 2904 },
  { name: "IDLI RICE 1KG", qty: 120, total: 7080 },
  { name: "KASHMIRI CHILLI POWDER 200G", qty: 100, total: 10400 },
  { name: "KITCHEN KING MASALA 200G", qty: 100, total: 10200 },
  { name: "LENTILS 1KG", qty: 72, total: 7992 },
  { name: "MACE 10G", qty: 100, total: 4700 },
  { name: "MORINGA 100G", qty: 50, total: 5500 },
  { name: "MORINGA SEEDS 100G", qty: 50, total: 5600 },
  { name: "MUSTARD 200G", qty: 100, total: 3500 },
  { name: "MUTTON MASALA 200G", qty: 100, total: 10500 },
  { name: "ONION FLAKES 100G", qty: 50, total: 4400 },
  { name: "PEPPER CHICKEN MASALA 200G", qty: 100, total: 10600 },
  { name: "RAW RICE 1KG", qty: 120, total: 7080 },
  { name: "RED CHILLI 200G", qty: 100, total: 7400 },
  { name: "RICE FLOUR 1KG", qty: 72, total: 5184 },
  { name: "SAMBAR POWDER 200G", qty: 100, total: 10800 },
  { name: "SEERAGA SAMBA RICE 1KG", qty: 60, total: 4200 },
  { name: "SMALL ONION POWDER 100G", qty: 24, total: 2160 },
  { name: "SOMBU POWDER 100G", qty: 50, total: 2200 },
  { name: "STAR ANISE 10G", qty: 100, total: 2600 },
  { name: "STAR ANISE 50G", qty: 50, total: 5950 },
  { name: "STONE FLOWER 10G", qty: 100, total: 2400 },
  { name: "TAMARIND 250G", qty: 100, total: 6000 },
  { name: "TAMARIND POWDER 100G", qty: 50, total: 3800 },
  { name: "TOOR DAL 1KG", qty: 120, total: 10320 },
  { name: "TURMERIC POWDER 200G", qty: 100, total: 6800 },
  { name: "URAD DAL 1KG", qty: 120, total: 10680 },
  { name: "URAD DAL POWDER 100G", qty: 50, total: 2750 },
  { name: "VENDHAYA KEERAI POWDER 100G", qty: 50, total: 3800 },
  { name: "WHITE PEPPER POWDER 100G", qty: 24, total: 1968 },
  { name: "BIRYANI MASALA 200G", qty: 100, total: 10200 },
  { name: "BLACK SESAME 200G", qty: 50, total: 4100 },
  { name: "CARDAMOM POWDER 10G", qty: 100, total: 5000 },
  { name: "GROUNDNUTS 1KG", qty: 48, total: 4896 },
  { name: "PEANUT BUTTER CRUNCHY 400G", qty: 12, total: 2040 },
];

const toNum = v => parseFloat(v) || 0;

const deriveSize = (it) => {
  const pu = (it.packUnit || '').toUpperCase();
  const ps = toNum(it.packSize);
  if (ps > 0) {
    if (pu === 'L' || pu === 'KG') return ps;
    if (pu === 'ML' || pu === 'GM') return ps / 1000;
  }
  return toNum(it.sizeL);
};

async function main() {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', `project_full_${PROJECT_ID}`)
    .single();

  if (error) { console.error('DB error:', error); return; }

  const proj = data.value;
  const cc = proj.cc || {};
  const allItems = cc.items || [];

  // Only merchant items
  const items = allItems.filter(it => (it.invoiceAssignment || 'merch') === 'merch');
  console.log(`Merchant items in DB: ${items.length}`);

  // Carton costs
  const carton12l  = toNum(cc.carton12lCost);
  const carton5l   = toNum(cc.carton5lCost);
  const carton30cm = toNum(cc.carton30cmCost);
  const carton50cm = toNum(cc.carton50cmCost);
  const sackCost   = toNum(cc.sackCost);
  const transport  = toNum(cc.transportCost);
  const avgCartonMode = cc.avgCartonMode === true || cc.avgCartonMode === 'true';
  const miscItems  = Array.isArray(cc.miscItems) ? cc.miscItems : [];
  const miscTotal  = miscItems.reduce((s, m) => s + toNum(m.amount), 0);
  const totalCCQty = allItems.reduce((s, it) => s + toNum(it.qty), 0);
  const miscPerPc  = totalCCQty > 0 ? miscTotal / totalCCQty : 0;

  const cartonCostFor = (type) =>
    type === '12L'  ? carton12l :
    type === '5L'   ? carton5l  :
    type === '30CM' ? carton30cm:
    type === '50CM' ? carton50cm:
    type === 'Sack' ? sackCost  : 0;

  // Total ship weight uses ALL items (mfg+merch), same as browser
  const totalShipWt = allItems.reduce((s, it) => s + toNum(it.qty) * deriveSize(it), 0);

  // Avg carton per pc uses ALL items
  const totalCartonSpend = allItems.reduce((s, it) => {
    const perCtn = toNum(it.perCarton) || 1;
    return s + cartonCostFor(it.packageType) * (toNum(it.qty) / perCtn);
  }, 0);
  const avgCartonPerPc = totalCCQty > 0 ? totalCartonSpend / totalCCQty : 0;

  console.log(`Transport: ₹${transport}, Total ship weight (all): ${totalShipWt.toFixed(3)} kg`);
  console.log(`MiscItems: ₹${miscTotal} over ${totalCCQty} pcs = ₹${miscPerPc.toFixed(4)}/pc`);
  console.log(`AvgCartonMode: ${avgCartonMode}, AvgCarton/pc: ₹${avgCartonPerPc.toFixed(4)}`);
  console.log(`Carton costs — 12L:₹${carton12l} 5L:₹${carton5l} 30CM:₹${carton30cm} 50CM:₹${carton50cm} Sack:₹${sackCost}\n`);

  // Calculate for each merchant item
  const calcItems = items.map(it => {
    const size    = deriveSize(it);
    const pp      = toNum(it.purchasePrice);
    const qty     = toNum(it.qty);
    const perCtn  = toNum(it.perCarton) || 1;
    const pack    = toNum(it.packingCost);
    const bottle  = toNum(it.bottleCost);
    const label   = toNum(it.labelCost);

    const productCost    = (pp * size) + pack + bottle + label;
    const cartonPerPiece = avgCartonMode ? avgCartonPerPc : cartonCostFor(it.packageType) / perCtn;
    const itemWt         = size;
    const transPerPiece  = totalShipWt > 0 ? (transport / totalShipWt) * itemWt : 0;
    const totalCostPer   = productCost + cartonPerPiece + transPerPiece + miscPerPc;

    const profitAmt      = (it.profitMode || 'pct') === 'pct'
                           ? totalCostPer * (toNum(it.profitPct) || 0) / 100
                           : toNum(it.profitCost);
    const sellingPrice   = totalCostPer + profitAmt;
    const totalRevenue   = sellingPrice * qty;

    return {
      name: it.name,
      qty,
      size,
      packSize: it.packSize,
      packUnit: it.packUnit,
      purchasePrice: pp,
      productCost,
      cartonPerPiece,
      transPerPiece,
      miscPerPc,
      totalCostPer,
      profitPct: toNum(it.profitPct),
      profitMode: it.profitMode || 'pct',
      sellingPrice,
      totalRevenue,
      packageType: it.packageType,
    };
  });

  const calcGrandTotal = calcItems.reduce((s, c) => s + c.totalRevenue, 0);
  const merchantTotal  = merchantExport.reduce((s, p) => s + p.total, 0);
  console.log(`Calc merch total (sell×qty): ₹${calcGrandTotal.toFixed(2)}`);
  console.log(`Merchant export total:        ₹${merchantTotal.toFixed(2)}\n`);

  // Fuzzy matching
  const normalize = (s) => s.toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

  const matchItem = (meName) => {
    const mnorm = normalize(meName);
    let found = calcItems.find(c => normalize(c.name) === mnorm);
    if (found) return found;

    const sizeMatch = meName.match(/(\d+)\s*(G|GM|KG|ML|L)$/i);
    let baseName = meName;
    let meSizeKg = -1;
    if (sizeMatch) {
      baseName = meName.slice(0, meName.lastIndexOf(sizeMatch[0])).trim();
      const n = parseFloat(sizeMatch[1]);
      const u = sizeMatch[2].toUpperCase();
      meSizeKg = (u === 'G' || u === 'GM') ? n/1000 : (u === 'KG') ? n : (u === 'ML') ? n/1000 : n;
    }

    const baseWords = normalize(baseName).split(' ').filter(w => w.length > 2);

    // Match name keywords + size
    found = calcItems.find(c => {
      const cn = normalize(c.name);
      const sizeOk = meSizeKg < 0 || Math.abs(c.size - meSizeKg) < 0.001;
      return baseWords.length > 0 && baseWords.every(w => cn.includes(w)) && sizeOk;
    });
    if (found) return found;

    // Relax: match first 2 words + size
    if (baseWords.length >= 2) {
      found = calcItems.find(c => {
        const cn = normalize(c.name);
        const sizeOk = meSizeKg < 0 || Math.abs(c.size - meSizeKg) < 0.001;
        return cn.includes(baseWords[0]) && cn.includes(baseWords[1]) && sizeOk;
      });
    }
    if (found) return found;

    // Relax: first word + size
    if (baseWords.length >= 1) {
      found = calcItems.find(c => {
        const cn = normalize(c.name);
        const sizeOk = meSizeKg < 0 || Math.abs(c.size - meSizeKg) < 0.001;
        return cn.includes(baseWords[0]) && sizeOk;
      });
    }
    return found || null;
  };

  console.log('=== RECONCILIATION ===\n');
  const hdr = `${'EXPORT NAME'.padEnd(35)} ${'ME Qty'.padStart(6)} ${'ME/pc'.padStart(7)} ${'ME Total'.padStart(9)} | ${'CALC Name'.padEnd(28)} ${'SP'.padStart(7)} ${'CALC Tot'.padStart(9)} ${'DIFF'.padStart(8)}`;
  console.log(hdr);
  console.log('—'.repeat(120));

  let totalDiff = 0;
  let unmatchedME = [];
  let matchedMETotal = 0;
  let matchedCalcTotal = 0;

  for (const me of merchantExport) {
    const calc = matchItem(me.name);
    const mePerPc = (me.total / me.qty).toFixed(2);
    if (calc) {
      const cTotal = calc.sellingPrice * me.qty;
      const diff = cTotal - me.total;
      totalDiff += diff;
      matchedMETotal += me.total;
      matchedCalcTotal += cTotal;
      const flag = Math.abs(diff) > 5 ? ' <<<' : '';
      console.log(
        `${me.name.padEnd(35)} ${String(me.qty).padStart(6)} ${('₹'+mePerPc).padStart(7)} ${('₹'+me.total).padStart(9)} | ` +
        `${calc.name.padEnd(28)} ${('₹'+calc.sellingPrice.toFixed(2)).padStart(7)} ${('₹'+cTotal.toFixed(2)).padStart(9)} ${((diff>=0?'+':'')+diff.toFixed(2)).padStart(8)}${flag}`
      );
    } else {
      unmatchedME.push(me);
      console.log(
        `${me.name.padEnd(35)} ${String(me.qty).padStart(6)} ${('₹'+mePerPc).padStart(7)} ${('₹'+me.total).padStart(9)} | NO MATCH IN CALC`
      );
    }
  }

  console.log('\n=== CALC MERCH ITEMS NOT IN EXPORT ===\n');
  for (const c of calcItems) {
    const inExport = merchantExport.find(me => {
      const m = matchItem(me.name);
      return m && m.name === c.name;
    });
    if (!inExport) {
      console.log(`  CALC ONLY: ${c.name.padEnd(35)} qty=${c.qty} sp=₹${c.sellingPrice.toFixed(2)} total=₹${c.totalRevenue.toFixed(2)}`);
    }
  }

  console.log('\n=== UNMATCHED EXPORT ITEMS ===\n');
  unmatchedME.forEach(me => console.log(`  ME ONLY: ${me.name.padEnd(35)} qty=${me.qty} total=₹${me.total}`));

  console.log('\n=== SUMMARY ===');
  console.log(`Merchant export total:           ₹${merchantTotal.toFixed(2)} (${merchantExport.length} products)`);
  console.log(`Calc merch total (sell×qty):     ₹${calcGrandTotal.toFixed(2)} (${calcItems.length} items)`);
  console.log(`Overall difference (calc-ME):    ₹${(calcGrandTotal - merchantTotal).toFixed(2)}`);
  console.log(`Matched ME total:                ₹${matchedMETotal.toFixed(2)}`);
  console.log(`Matched Calc total:              ₹${matchedCalcTotal.toFixed(2)}`);
  console.log(`Line-item sum of diffs:          ₹${totalDiff.toFixed(2)}`);
  console.log(`Unmatched ME items count/value:  ${unmatchedME.length} / ₹${unmatchedME.reduce((s,m)=>s+m.total,0).toFixed(2)}`);
}

main().catch(console.error);
