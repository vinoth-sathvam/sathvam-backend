/**
 * One-off script: seed / update label stock counts (April 2026 physical count)
 * Run: node scripts/seed-labels-2026-04-18.js
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const supabase = require('../config/supabase');

const LABELS = [
  { product_name:'Ground Nut Oil',                     size:'1L',     qty:350 },
  { product_name:'Ground Nut Oil',                     size:'5000ml', qty:40  },
  { product_name:'Jaggery Sesame Oil',                 size:'1L',     qty:200 },
  { product_name:'Jaggery Sesame Oil',                 size:'5000ml', qty:10  },
  { product_name:'Ground Nut Oil (Ginger Infused)',    size:'250ml',  qty:30  },
  { product_name:'Neem Oil',                           size:'100ml',  qty:70  },
  { product_name:'Deepam Oil',                         size:'1L',     qty:50  },
  { product_name:'Chilli Powder',                      size:'200g',   qty:60  },
  { product_name:'Coriander Powder',                   size:'200g',   qty:100 },
  { product_name:'Pappad',                             size:'160g',   qty:50  },
  { product_name:'Turmeric Powder',                    size:'200g',   qty:80  },
  { product_name:'Sambar Powder',                      size:'200g',   qty:30  },
  { product_name:'Garam Masala',                       size:'200g',   qty:50  },
  { product_name:'Round Jaggery',                      size:'500g',   qty:100 },
  { product_name:'Rice Flour',                         size:'500g',   qty:50  },
  { product_name:'Sprouted Ragi Flour',                size:'500g',   qty:70  },
  { product_name:'White Sorghum Flour',                size:'500g',   qty:50  },
  { product_name:'Besan Flour',                        size:'500g',   qty:100 },
  { product_name:'Paruppu Powder',                     size:'200g',   qty:50  },
  { product_name:'Long Vathal',                        size:'150g',   qty:20  },
  { product_name:'Onion Vathal',                       size:'150g',   qty:20  },
  { product_name:'Foxtail Millet',                     size:'500g',   qty:100 },
  { product_name:'Salt',                               size:'500g',   qty:70  },
  { product_name:'Kodo Millet',                        size:'500g',   qty:100 },
  { product_name:'Flax Seed',                          size:'500g',   qty:100 },
  { product_name:'Little Millet',                      size:'500g',   qty:100 },
  { product_name:'Barley',                             size:'500g',   qty:30  },
  { product_name:'Moong Dal',                          size:'500g',   qty:300 },
  { product_name:'Bengal Gram',                        size:'500g',   qty:100 },
  { product_name:'Tamarind',                           size:'500g',   qty:40  },
  { product_name:'Fenugreek',                          size:'200g',   qty:30  },
  { product_name:'Cumin',                              size:'200g',   qty:100 },
  { product_name:'Fennel',                             size:'200g',   qty:100 },
  { product_name:'Black Chick Peas',                   size:'500g',   qty:100 },
  { product_name:'White Chick Peas',                   size:'500g',   qty:100 },
  { product_name:'Coriander Seed',                     size:'200g',   qty:100 },
  { product_name:'Whole Moong Beans',                  size:'500g',   qty:50  },
  { product_name:'Ajwain',                             size:'100g',   qty:100 },
  { product_name:'White Aval',                         size:'250g',   qty:100 },
  { product_name:'Mini Soya Chunks',                   size:'200g',   qty:200 },
  { product_name:'Urad Dal',                           size:'1kg',    qty:100 },
  { product_name:'Masoor Dal',                         size:'1kg',    qty:100 },
  { product_name:'Toor Dal',                           size:'1kg',    qty:150 },
  { product_name:'Black Raisin',                       size:'250g',   qty:50  },
  { product_name:'Dry Golden Raisin',                  size:'250g',   qty:50  },
  { product_name:'Roasted Bengal Gram',                size:'500g',   qty:50  },
  { product_name:'Rajma (Chitra)',                     size:'500g',   qty:100 },
  { product_name:'Red Rajma',                          size:'500g',   qty:20  },
  { product_name:'Hing',                               size:'80g',    qty:100 },
  { product_name:'Almond Oil',                         size:'5000ml', qty:5   },
  { product_name:'Yellow Mustard Oil',                 size:'5000ml', qty:5   },
  { product_name:'Flaxseed Oil',                       size:'5000ml', qty:5   },
  { product_name:'Whole Moong Beans',                  size:'1kg',    qty:60  },
  { product_name:'White Chick Peas',                   size:'1kg',    qty:60  },
  { product_name:'Foxtail Millet',                     size:'1kg',    qty:60  },
  { product_name:'Moong Dal',                          size:'1kg',    qty:60  },
  { product_name:'Black Cumin Seed',                   size:'80g',    qty:110 },
  { product_name:'Kasoori Methi',                      size:'50g',    qty:55  },
  { product_name:'Common Label (Singapore)',            size:'',       qty:350 },
];

// Build canonical label name: "<product_name> Label <size>"
function labelName(entry) {
  return entry.size
    ? `${entry.product_name} Label ${entry.size}`
    : `${entry.product_name} Label`;
}

async function run() {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  // Fetch all existing label entries
  const { data: existing, error: fetchErr } = await supabase
    .from('packing_materials')
    .select('id, name, current_stock')
    .eq('category', 'label');

  if (fetchErr) { console.error('Fetch error:', fetchErr.message); process.exit(1); }

  const existingMap = {};
  (existing || []).forEach(r => { existingMap[r.name.toLowerCase()] = r; });

  let updated = 0, inserted = 0, errors = 0;

  for (const entry of LABELS) {
    const name = labelName(entry);
    const key  = name.toLowerCase();
    const existing_row = existingMap[key];

    if (existing_row) {
      // Update stock + log audit
      const { error: upErr } = await supabase
        .from('packing_materials')
        .update({ current_stock: entry.qty, last_audited: today, updated_at: now })
        .eq('id', existing_row.id);

      if (upErr) {
        console.error(`  ✗ UPDATE failed [${name}]:`, upErr.message);
        errors++;
      } else {
        // Audit log (fire-and-forget, ignore errors)
        supabase.from('packing_audit_log').insert({
          material_id: existing_row.id, audit_date: today,
          quantity: entry.qty, previous_qty: existing_row.current_stock || 0,
          audited_by: 'seed-labels-2026-04-18', notes: 'Physical count April 2026',
        }).then(() => {}).catch(() => {});
        console.log(`  ✓ UPDATED [${name}] → ${entry.qty} pcs`);
        updated++;
      }
    } else {
      // Insert new label record
      const insertObj = {
        name, category: 'label',
        product_name: entry.product_name,
        size: entry.size,
        cover_size: entry.size,
        unit: 'pcs',
        current_stock: entry.qty,
        min_stock: 50,
        reorder_qty: 200,
        unit_price: 0,
        supplier: '',
        notes: 'Added via April 2026 physical count',
        active: true,
        updated_at: now,
        last_audited: today,
        audited_by: 'seed-labels-2026-04-18',
      };

      const { data: newRow, error: insErr } = await supabase
        .from('packing_materials')
        .insert(insertObj)
        .select()
        .single();

      if (insErr) {
        console.error(`  ✗ INSERT failed [${name}]:`, insErr.message);
        errors++;
      } else {
        // Audit log (fire-and-forget, ignore errors)
        supabase.from('packing_audit_log').insert({
          material_id: newRow.id, audit_date: today,
          quantity: entry.qty, previous_qty: 0,
          audited_by: 'seed-labels-2026-04-18', notes: 'Opening stock — April 2026 physical count',
        }).then(() => {}).catch(() => {});
        console.log(`  + INSERTED [${name}] → ${entry.qty} pcs`);
        inserted++;
      }
    }
  }

  console.log(`\nDone. Updated: ${updated}  Inserted: ${inserted}  Errors: ${errors}`);
  process.exit(errors > 0 ? 1 : 0);
}

run();
