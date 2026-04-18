/**
 * Auto-link all products to their matching label + container in packing_materials.
 * Stores result in products.packing_links = { materialIds: [containerId], labelId }
 * Run: node scripts/auto-link-packing.js
 */
require('dotenv').config({ path: __dirname + '/../.env' });
const supabase = require('../config/supabase');

// ── Size normaliser → { v: number (ml or g), u: 'ml'|'g' } ──────────────────
function normSize(s) {
  const t = (s || '').toLowerCase().replace(/\s+/g, '');
  let m;
  if ((m = t.match(/^(\d+(?:\.\d+)?)ml$/)))  return { v: +m[1],          u: 'ml' };
  if ((m = t.match(/^(\d+(?:\.\d+)?)l$/)))   return { v: +m[1] * 1000,   u: 'ml' };
  if ((m = t.match(/^(\d+(?:\.\d+)?)gm?$/))) return { v: +m[1],          u: 'g'  };
  if ((m = t.match(/^(\d+(?:\.\d+)?)kg$/)))  return { v: +m[1] * 1000,   u: 'g'  };
  return null;
}

// Normalize a string for fuzzy matching (lowercase, strip spaces)
function norm(s) { return (s || '').toLowerCase().replace(/\s+/g, ''); }

// Strip size suffix from product name: "Groundnut Oil 1000ML" → "Groundnut Oil"
function baseName(productName) {
  return productName.replace(/\s+\d+(?:\.\d+)?(?:ML|GM|G|KG|L|KGS?)$/i, '').trim();
}

// Convert product pack_size + pack_unit → { v, u }
function productSize(p) {
  const u = (p.pack_unit || '').toUpperCase();
  const v = parseFloat(p.pack_size) || 0;
  if (!v) return null;
  if (u === 'ML')                   return { v, u: 'ml' };
  if (u === 'L')                    return { v: v * 1000, u: 'ml' };
  if (u === 'GM' || u === 'G')      return { v, u: 'g' };
  if (u === 'KG' || u === 'KGS')   return { v: v * 1000, u: 'g' };
  return null;
}

async function run() {
  const now = new Date().toISOString();

  // ── Fetch all products ───────────────────────────────────────────────────
  const { data: products, error: pe } = await supabase
    .from('products')
    .select('id, name, cat, pack_size, pack_unit, packing_links')
    .eq('active', true);
  if (pe) { console.error('products fetch error:', pe.message); process.exit(1); }

  // ── Fetch all packing materials ──────────────────────────────────────────
  const { data: mats, error: me } = await supabase
    .from('packing_materials')
    .select('id, name, category, product_name, size')
    .eq('active', true);
  if (me) { console.error('materials fetch error:', me.message); process.exit(1); }

  // ── Build container lookup: { 'ml:500' → id, 'g:500' → id, ... } ────────
  // Preference: can_5l > bottle_pet > bottle_glass > cover
  const containerMap = {}; // key: "{u}:{v}" → material id (best match)

  const PREF = { can_5l: 4, bottle_pet: 3, bottle_glass: 2, cover: 1 };

  for (const m of mats) {
    if (!['can_5l','bottle_pet','bottle_glass','cover'].includes(m.category)) continue;

    // Try normalising the size field first, then fall back to name
    let sz = normSize(m.size) || normSize(m.name.replace(/[^0-9a-z.]/gi, ' '));

    // Covers with dimensional sizes (e.g., "140X110") → extract from name
    if (!sz) {
      const nameMatch = m.name.match(/(\d+(?:\.\d+)?)\s*(g|gm|kg|ml|l)\b/i);
      if (nameMatch) sz = normSize(nameMatch[1] + nameMatch[2]);
    }
    if (!sz) continue;

    const key = `${sz.u}:${sz.v}`;
    const existing = containerMap[key];
    const pref = PREF[m.category] || 0;
    if (!existing || pref > (PREF[existing.cat] || 0)) {
      containerMap[key] = { id: m.id, cat: m.category, name: m.name };
    }
  }

  // ── Build label lookup: { norm(product_name) + ':' + '{u}:{v}' → id } ──
  const labelMap = {}; // key: "{normName}:{u}:{v}" → material id
  for (const m of mats) {
    if (m.category !== 'label') continue;
    const sz = normSize(m.size);
    if (!sz && m.size) continue; // has size but can't parse → skip
    const nameKey = norm(m.product_name);
    const sizeKey = sz ? `${sz.u}:${sz.v}` : 'none';
    const key = `${nameKey}:${sizeKey}`;
    if (!labelMap[key]) labelMap[key] = m.id;
  }

  // ── Process each product ─────────────────────────────────────────────────
  let updated = 0, skipped = 0, noContainer = 0, noLabel = 0, errors = 0;
  const issues = [];

  for (const prod of products) {
    if (prod.cat === 'raw') { skipped++; continue; } // raw materials — no packaging

    const sz = productSize(prod);
    if (!sz) { skipped++; continue; }

    const base  = baseName(prod.name);
    const cKey  = `${sz.u}:${sz.v}`;
    const lKey  = `${norm(base)}:${cKey}`;

    const container = containerMap[cKey];
    const labelId   = labelMap[lKey];

    if (!container) {
      issues.push(`  ⚠ NO CONTAINER [${prod.name}] size=${sz.v}${sz.u}`);
      noContainer++;
    }
    if (!labelId) {
      issues.push(`  ⚠ NO LABEL     [${prod.name}] key=${lKey}`);
      noLabel++;
    }

    // Build packing_links — keep any existing fields that aren't being replaced
    const existing = prod.packing_links || {};
    const newLinks = {
      ...existing,
      materialIds: container ? [container.id] : (existing.materialIds || []),
      coverId:     undefined,
      bottleId:    undefined,
      labelId:     labelId || existing.labelId || undefined,
    };

    const { error: upErr } = await supabase
      .from('products')
      .update({ packing_links: newLinks })
      .eq('id', prod.id);

    if (upErr) {
      console.error(`  ✗ UPDATE FAIL [${prod.name}]:`, upErr.message);
      errors++;
    } else {
      const cLabel = container ? container.name : '—';
      const lLabel = labelId   ? 'label ✓'      : 'no label';
      console.log(`  ✓ [${prod.name}]  → ${cLabel}  |  ${lLabel}`);
      updated++;
    }
  }

  if (issues.length) {
    console.log('\n── Issues ──────────────────────────────────────');
    issues.forEach(i => console.log(i));
  }

  console.log(`
── Summary ─────────────────────────────────────
  Products updated : ${updated}
  Skipped (raw/no size): ${skipped}
  Missing container: ${noContainer}
  Missing label    : ${noLabel}
  Errors           : ${errors}
`);
  process.exit(errors > 0 ? 1 : 0);
}

run();
