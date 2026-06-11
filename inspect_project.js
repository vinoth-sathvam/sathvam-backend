const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  'https://qgoyiwtxgelupamskhaa.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFnb3lpd3R4Z2VsdXBhbXNraGFhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDUxMTkzMCwiZXhwIjoyMDkwMDg3OTMwfQ.0-WKSNEch8WDYnD5n8a_hsqA9_-T3RIa-xS5mttMCOg',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const PROJECT_ID = '86b1cba6-65ea-4b10-97a8-a98ddcce6761';

async function main() {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', `project_full_${PROJECT_ID}`)
    .single();

  if (error) { console.error('DB error:', error); return; }
  const proj = data.value;

  const merch = proj.merch || {};
  const items = merch.items || [];

  // Print all merch items
  let total = 0;
  items.forEach((it, i) => {
    const t = parseFloat(it.totalINR) || 0;
    total += t;
    if (it.product) {
      console.log(`${i+1}. ${(it.product||'').padEnd(40)} qty=${it.qty} sp=₹${it.unitPriceINR} total=₹${t.toFixed(2)}`);
    }
  });
  const nonEmpty = items.filter(it => it.product);
  console.log(`\nTotal items with product: ${nonEmpty.length}`);
  console.log(`Total (summed): ₹${total.toFixed(2)}`);
  console.log(`InvoiceNo: ${merch.invoiceNo}`);
}

main().catch(console.error);
