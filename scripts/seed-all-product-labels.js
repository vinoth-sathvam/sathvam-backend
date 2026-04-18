/**
 * Seed labels for ALL products in the system.
 * - Skips any label that already exists by name (safe to re-run)
 * - Sets unit_price based on size
 * Run: node scripts/seed-all-product-labels.js
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const supabase = require('../config/supabase');

// Size → price map (INR)
const PRICE_MAP = {
  '5000ml': 10,
  '1l':     3.5,
  '500ml':  2.5,
  '250ml':  2,    // set now
  '200ml':  1.5,  // set now
  '100ml':  2,
  '1kg':    8,
  '500g':   4,
  '250g':   3,
  '200g':   2,
  '150g':   1.5,  // set now
  '160g':   1.5,  // set now
  '100g':   1,    // set now
  '80g':    1,    // set now
  '50g':    0.5,  // set now
  '5l':     10,   // alias for 5000ml
};

// Normalise size string to key used in PRICE_MAP
function normKey(size) {
  return (size || '').toLowerCase().replace(/\s/g, '')
    .replace(/gm$/, 'g').replace(/kg$/, 'kg');
}

// All products — { product_name, size (normalised) }
// Skip: Raw Material category, no-size items
const PRODUCTS = [
  // ── Nuts & Dry Fruits ──────────────────────────────────────────────────────
  { product_name:'Badam',                          size:'250g'   },
  { product_name:'Badam',                          size:'500g'   },
  { product_name:'Black Dry Grapes',               size:'100g'   },
  { product_name:'Black Dry Grapes',               size:'250g'   },
  { product_name:'Cashew Nut',                     size:'200g'   },
  { product_name:'Cashew Nut',                     size:'500g'   },
  { product_name:'Chia Seeds',                     size:'250g'   },
  { product_name:'Chia Seeds',                     size:'500g'   },
  { product_name:'Pista',                          size:'100g'   },
  { product_name:'Pista',                          size:'250g'   },
  { product_name:'Pumpkin Seeds',                  size:'250g'   },
  { product_name:'Sunflower Seeds',                size:'250g'   },
  { product_name:'Sunflower Seeds',                size:'500g'   },

  // ── Oils ──────────────────────────────────────────────────────────────────
  { product_name:'Castor Oil',                     size:'100ml'  },
  { product_name:'Castor Oil',                     size:'250ml'  },
  { product_name:'Castor Oil',                     size:'500ml'  },
  { product_name:'Coconut Oil',                    size:'250ml'  },
  { product_name:'Coconut Oil',                    size:'500ml'  },
  { product_name:'Coconut Oil',                    size:'1l'     },
  { product_name:'Coconut Oil',                    size:'5000ml' },
  { product_name:'Country Cow Ghee',               size:'250ml'  },
  { product_name:'Cow Ghee',                       size:'200ml'  },
  { product_name:'Deepam Oil',                     size:'250ml'  },
  { product_name:'Deepam Oil',                     size:'500ml'  },
  { product_name:'Deepam Oil',                     size:'1l'     },
  { product_name:'Groundnut Oil',                  size:'250ml'  },
  { product_name:'Groundnut Oil',                  size:'500ml'  },
  { product_name:'Groundnut Oil',                  size:'1l'     },
  { product_name:'Groundnut Oil',                  size:'5000ml' },
  { product_name:'Hand Churned Ghee',              size:'200ml'  },
  { product_name:'Hand Churned Ghee',              size:'500ml'  },
  { product_name:'Herbal Hair Oil',                size:'250ml'  },
  { product_name:'Herbal Hair Oil',                size:'500ml'  },
  { product_name:'Mustard Oil',                    size:'250ml'  },
  { product_name:'Mustard Oil',                    size:'500ml'  },
  { product_name:'Mustard Oil',                    size:'1l'     },
  { product_name:'Neem Oil',                       size:'100ml'  },
  { product_name:'Neem Oil',                       size:'500ml'  },
  { product_name:'Neem Oil',                       size:'1l'     },
  { product_name:'Sesame Oil',                     size:'250ml'  },
  { product_name:'Sesame Oil',                     size:'500ml'  },
  { product_name:'Sesame Oil',                     size:'1l'     },
  { product_name:'Sesame Oil',                     size:'5000ml' },
  { product_name:'Walnut Oil',                     size:'500ml'  },

  // ── Grains, Millets & Flours ──────────────────────────────────────────────
  { product_name:'Barnyard Flour',                 size:'500g'   },
  { product_name:'Barnyard Millet',                size:'500g'   },
  { product_name:'Barnyard Millet Flakes',         size:'250g'   },
  { product_name:'Barnyard Millet Flakes',         size:'500g'   },
  { product_name:'Besan Flour',                    size:'500g'   },
  { product_name:'Black Rice Flour',               size:'500g'   },
  { product_name:'Finger Millet',                  size:'500g'   },
  { product_name:'Foxtail Flour',                  size:'500g'   },
  { product_name:'Foxtail Millet',                 size:'500g'   },
  { product_name:'Foxtail Millet Flakes',          size:'250g'   },
  { product_name:'Foxtail Millet Flakes',          size:'500g'   },
  { product_name:'Kodo Millet',                    size:'500g'   },
  { product_name:'Kodo Millet Flakes',             size:'250g'   },
  { product_name:'Kodo Millet Flakes',             size:'500g'   },
  { product_name:'Little Millet',                  size:'500g'   },
  { product_name:'Little Millet Flakes',           size:'250g'   },
  { product_name:'Little Millet Flakes',           size:'500g'   },
  { product_name:'Organic Idly Rice',              size:'500g'   },
  { product_name:'Organic Idly Rice',              size:'1kg'    },
  { product_name:'Organic Karupu Kavuni Rice',     size:'500g'   },
  { product_name:'Organic Thooyamalli Rice',       size:'500g'   },
  { product_name:'Pearl Millet',                   size:'500g'   },
  { product_name:'Pearl Millet Flakes',            size:'250g'   },
  { product_name:'Pearl Millet Flakes',            size:'500g'   },
  { product_name:'Puffed Rice',                    size:'100g'   },
  { product_name:'Ragi/Finger Millet Flakes',      size:'250g'   },
  { product_name:'Ragi/Finger Millet Flakes',      size:'500g'   },
  { product_name:'Rava',                           size:'500g'   },
  { product_name:'Red Rice Flour',                 size:'500g'   },
  { product_name:'Semiya',                         size:'250g'   },
  { product_name:'Sorghum Millet',                 size:'500g'   },
  { product_name:'Sprouted Ragi Flour',            size:'500g'   },
  { product_name:'Wheat Flour',                    size:'500g'   },
  { product_name:'Wheat Rava',                     size:'500g'   },
  { product_name:'White Sorghum Flakes',           size:'250g'   },
  { product_name:'White Sorghum Flakes',           size:'500g'   },
  { product_name:'White Sorghum Flour',            size:'500g'   },

  // ── Dals & Pulses ────────────────────────────────────────────────────────
  { product_name:'Bengal Gram',                    size:'500g'   },
  { product_name:'Bengal Gram',                    size:'1kg'    },
  { product_name:'Black Chickpeas',                size:'250g'   },
  { product_name:'Black Chickpeas',                size:'500g'   },
  { product_name:'Black Eyed Bean',                size:'250g'   },
  { product_name:'Black Eyed Bean',                size:'500g'   },
  { product_name:'Chitra Rajma',                   size:'500g'   },
  { product_name:'Green Peas',                     size:'250g'   },
  { product_name:'Green Peas',                     size:'500g'   },
  { product_name:'Groundnut Seeds',                size:'500g'   },
  { product_name:'Groundnut Seeds',                size:'1kg'    },
  { product_name:'Horse Gram',                     size:'500g'   },
  { product_name:'Masoor Dal',                     size:'500g'   },
  { product_name:'Moong Dal',                      size:'500g'   },
  { product_name:'Moong Dal',                      size:'1kg'    },
  { product_name:'Red Rajma',                      size:'500g'   },
  { product_name:'Roasted Bengal Gram',            size:'250g'   },
  { product_name:'Roasted Bengal Gram',            size:'500g'   },
  { product_name:'Soya Beans',                     size:'500g'   },
  { product_name:'Toor Dal',                       size:'500g'   },
  { product_name:'Toor Dal',                       size:'1kg'    },
  { product_name:'Toor Dal Red Soiled',            size:'500g'   },
  { product_name:'Toor Dal Red Soiled',            size:'1kg'    },
  { product_name:'Urad Dal',                       size:'500g'   },
  { product_name:'Urad Dal',                       size:'1kg'    },
  { product_name:'White Chickpeas',                size:'250g'   },
  { product_name:'White Chickpeas',                size:'500g'   },
  { product_name:'White Lima Beans',               size:'250g'   },
  { product_name:'White Lima Beans',               size:'500g'   },
  { product_name:'Whole Black Urad Dal',           size:'500g'   },
  { product_name:'Whole Mung Beans',               size:'500g'   },

  // ── Spices & Powders ──────────────────────────────────────────────────────
  { product_name:'Black Pepper',                   size:'100g'   },
  { product_name:'Black Pepper',                   size:'250g'   },
  { product_name:'Black Pepper',                   size:'500g'   },
  { product_name:'Cardamom',                       size:'50g'    },
  { product_name:'Cardamom',                       size:'100g'   },
  { product_name:'Chilli Powder',                  size:'100g'   },
  { product_name:'Chilli Powder',                  size:'250g'   },
  { product_name:'Chilli Powder',                  size:'500g'   },
  { product_name:'Chilli Powder',                  size:'1kg'    },
  { product_name:'Coriander Powder',               size:'200g'   },
  { product_name:'Coriander Seeds',                size:'200g'   },
  { product_name:'Cumin',                          size:'200g'   },
  { product_name:'Dry Red Chilli',                 size:'100g'   },
  { product_name:'Dry Red Chilli',                 size:'250g'   },
  { product_name:'Dry Red Chilli',                 size:'500g'   },
  { product_name:'Fennel',                         size:'200g'   },
  { product_name:'Fenugreek',                      size:'200g'   },
  { product_name:'Idly Powder',                    size:'100g'   },
  { product_name:'Idly Powder',                    size:'250g'   },
  { product_name:'Idly Powder',                    size:'500g'   },
  { product_name:'Mustard Seeds',                  size:'200g'   },
  { product_name:'Rasam Powder',                   size:'200g'   },
  { product_name:'Sambar Powder',                  size:'100g'   },
  { product_name:'Sambar Powder',                  size:'250g'   },
  { product_name:'Sambar Powder',                  size:'500g'   },
  { product_name:'Sambar Powder',                  size:'1kg'    },
  { product_name:'Shikakai Powder',                size:'200g'   },
  { product_name:'Tamarind',                       size:'250g'   },
  { product_name:'Tamarind',                       size:'500g'   },
  { product_name:'Tamarind',                       size:'1kg'    },
  { product_name:'Turmeric Powder',                size:'200g'   },

  // ── Other / Miscellaneous ─────────────────────────────────────────────────
  { product_name:'Flax Seeds',                     size:'250g'   },
  { product_name:'Flax Seeds',                     size:'500g'   },
  { product_name:'Jaggery',                        size:'500g'   },
  { product_name:'Jaggery',                        size:'1kg'    },
  { product_name:'Navathaniya Dosa Mix',           size:'500g'   },
  { product_name:'Navathaniya Dosa Mix',           size:'1kg'    },
  { product_name:'Organic Nattu Sakkarai',         size:'500g'   },
  { product_name:'Organic Nattu Sakkarai',         size:'1kg'    },
  { product_name:'Palm Sugar Candy',               size:'150g'   },
  { product_name:'Tapioca Papad Garlic',           size:'150g'   },
  { product_name:'Tapioca Papad Red Chilli',       size:'150g'   },
  { product_name:'Tapioca Papad Tomato',           size:'150g'   },
  { product_name:'Tapioca Vathal Ajwain',          size:'150g'   },
  { product_name:'Tapioca Vathal Cumin',           size:'150g'   },
  { product_name:'Tapioca Vathal Green Chilli',    size:'150g'   },
];

function labelName(p) {
  return `${p.product_name} Label ${p.size}`;
}

async function run() {
  const now   = new Date().toISOString();
  const today = now.slice(0, 10);

  // Fetch all existing label names
  const { data: existing, error: fetchErr } = await supabase
    .from('packing_materials')
    .select('name')
    .eq('category', 'label');

  if (fetchErr) { console.error('Fetch error:', fetchErr.message); process.exit(1); }

  const existingNames = new Set((existing || []).map(r => r.name.toLowerCase()));

  const toInsert = [];
  const skipped  = [];

  for (const p of PRODUCTS) {
    const name = labelName(p);
    if (existingNames.has(name.toLowerCase())) {
      skipped.push(name);
      continue;
    }
    const price = PRICE_MAP[normKey(p.size)] ?? 0;
    toInsert.push({
      name,
      category:      'label',
      product_name:  p.product_name,
      size:          p.size,
      cover_size:    p.size,
      unit:          'pcs',
      current_stock: 0,
      min_stock:     50,
      reorder_qty:   200,
      unit_price:    price,
      supplier:      '',
      notes:         '',
      active:        true,
      updated_at:    now,
    });
  }

  console.log(`Existing (skip): ${skipped.length}  |  To insert: ${toInsert.length}`);

  let inserted = 0, errors = 0;
  // Insert in batches of 50
  for (let i = 0; i < toInsert.length; i += 50) {
    const batch = toInsert.slice(i, i + 50);
    const { data, error } = await supabase.from('packing_materials').insert(batch).select('name, unit_price');
    if (error) {
      console.error(`  ✗ Batch ${i}-${i+50} failed:`, error.message);
      errors++;
    } else {
      (data || []).forEach(r => console.log(`  + ${r.name}  ₹${r.unit_price}`));
      inserted += (data || []).length;
    }
  }

  // Also update unit_price on ALL existing labels that have price=0 but now have a rule
  console.log('\nPatching prices on existing zero-price labels…');
  const { data: zeroPriced } = await supabase
    .from('packing_materials')
    .select('id, name, size')
    .eq('category', 'label')
    .eq('unit_price', 0);

  let patched = 0;
  for (const lbl of (zeroPriced || [])) {
    const price = PRICE_MAP[normKey(lbl.size)];
    if (price == null || price === 0) continue;
    await supabase.from('packing_materials').update({ unit_price: price, updated_at: now }).eq('id', lbl.id);
    console.log(`  ✓ PATCHED [${lbl.name}] → ₹${price}`);
    patched++;
  }

  console.log(`\nDone. Inserted: ${inserted}  Patched prices: ${patched}  Errors: ${errors}`);
  process.exit(errors > 0 ? 1 : 0);
}

run();
