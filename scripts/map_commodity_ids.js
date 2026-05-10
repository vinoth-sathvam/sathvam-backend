// map_commodity_ids.js
// Auto-maps products to their source commodity_id based on name matching
// Run: node scripts/map_commodity_ids.js

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://qgoyiwtxgelupamskhaa.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFnb3lpd3R4Z2VsdXBhbXNraGFhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDUxMTkzMCwiZXhwIjoyMDkwMDg3OTMwfQ.0-WKSNEch8WDYnD5n8a_hsqA9_-T3RIa-xS5mttMCOg'
);

// Full BULK_COMMODITIES list — mirrors frontend BULK_COMMODITIES_LIST
const BULK_COMMODITIES = [
  {id:"bulk-gn",         name:"Groundnut",                  aliases:["groundnut","peanut","moongphali"]},
  {id:"bulk-ses",        name:"Sesame",                     aliases:["sesame","gingelly","til"]},
  {id:"bulk-coc",        name:"Coconut",                    aliases:["coconut","thengai"]},
  {id:"bulk-toor",       name:"Toor Dal",                   aliases:["toor dal","toor dhal","tuvar dal","arhar","pigeon pea"]},
  {id:"bulk-toor-red",   name:"Toor Dal Red Soiled",        aliases:["toor dal red","red soiled toor","red toor"]},
  {id:"bulk-urad",       name:"Urad Dal",                   aliases:["urad dal","urad dhal","ulundu","black gram dal","white urad"]},
  {id:"bulk-urad-blk",   name:"Whole Black Urad Dal",       aliases:["whole black urad","black urad whole","whole urad"]},
  {id:"bulk-moong",      name:"Moong Dal",                  aliases:["moong dal","moong dhal","green gram dal","paasi paruppu","pasi paruppu"]},
  {id:"bulk-moong-w",    name:"Whole Mung Beans",           aliases:["whole moong","whole mung","whole green gram","mung bean"]},
  {id:"bulk-masoor",     name:"Masoor Dal",                 aliases:["masoor dal","masoor dhal","red lentil","lentil"]},
  {id:"bulk-bengal",     name:"Bengal Gram",                aliases:["bengal gram","chana dal","kadalai paruppu","chickpea dal"]},
  {id:"bulk-rbg",        name:"Roasted Bengal Gram",        aliases:["roasted bengal gram","roasted chana","pottukadalai","daria"]},
  {id:"bulk-horse",      name:"Horse Gram",                 aliases:["horse gram","kollu","kulthi"]},
  {id:"bulk-bchick",     name:"Black Chickpeas",            aliases:["black chickpeas","black channa","kala chana","karuppu kadalai"]},
  {id:"bulk-wchick",     name:"White Chickpeas",            aliases:["white chickpeas","white channa","kabuli chana","vella kadalai"]},
  {id:"bulk-lima",       name:"Lima Beans",                 aliases:["lima beans","butter beans","mochai"]},
  {id:"bulk-beb",        name:"Black Eyed Beans",           aliases:["black eyed beans","black eyed peas","lobia","thattapayir"]},
  {id:"bulk-rajma",      name:"Rajma",                      aliases:["rajma","kidney beans","red kidney"]},
  {id:"bulk-gnut",       name:"Groundnut Seeds",            aliases:["groundnut seeds","peanut seeds","raw groundnut","roasted groundnut","verkadalai"]},
  {id:"bulk-soya",       name:"Soya Beans",                 aliases:["soya","soybean","soy bean"]},
  {id:"bulk-pearl",      name:"Pearl Millet",               aliases:["pearl millet","bajra","kambu","bajra millet"]},
  {id:"bulk-fox",        name:"Foxtail Millet",             aliases:["foxtail millet","thinai","tinai","kangni"]},
  {id:"bulk-kodo",       name:"Kodo Millet",                aliases:["kodo millet","varagu","kodra"]},
  {id:"bulk-lit",        name:"Little Millet",              aliases:["little millet","samai","sama","kutki"]},
  {id:"bulk-barn",       name:"Barnyard Millet",            aliases:["barnyard millet","kuthiraivali","sawa"]},
  {id:"bulk-fing",       name:"Finger Millet / Ragi",       aliases:["finger millet","ragi","kezhvaragu","kelvaragu","nachni"]},
  {id:"bulk-sorg",       name:"Sorghum",                    aliases:["sorghum","cholam","jowar","jowar flour"]},
  {id:"bulk-wheat",      name:"Wheat",                      aliases:["wheat","godhumai"]},
  {id:"bulk-rice-b",     name:"Karupu Kavuni Rice",         aliases:["kavuni rice","karupu kavuni","black rice","purple rice"]},
  {id:"bulk-rice-r",     name:"Maapalai Samba Rice",        aliases:["maapalai samba","mappillai samba","red rice"]},
  {id:"bulk-rice-i",     name:"Idly Rice",                  aliases:["idly rice","idli rice","parboiled rice"]},
  {id:"bulk-chilli",     name:"Dry Red Chilli",             aliases:["dry red chilli","dry chilli","red chilli","dried chilli","milagai"]},
  {id:"bulk-turmeric",   name:"Turmeric",                   aliases:["turmeric","manjal","haldi"]},
  {id:"bulk-coriander",  name:"Coriander Seeds",            aliases:["coriander seeds","coriander","dhania","kothamalli vithai"]},
  {id:"bulk-pepper",     name:"Black Pepper",               aliases:["black pepper","pepper","milagu"]},
  {id:"bulk-cumin",      name:"Cumin",                      aliases:["cumin","jeera","seeragam","jeeragam"]},
  {id:"bulk-fennel",     name:"Fennel",                     aliases:["fennel","sombu","saunf"]},
  {id:"bulk-mustard",    name:"Mustard Seeds",              aliases:["mustard seeds","mustard","kadugu","rai"]},
  {id:"bulk-fenugreek",  name:"Fenugreek",                  aliases:["fenugreek","methi","vendhayam","venthayam"]},
  {id:"bulk-cardamom",   name:"Cardamom",                   aliases:["cardamom","elaichi","elakkai"]},
  {id:"bulk-tamarind",   name:"Tamarind",                   aliases:["tamarind","puli","imli"]},
  {id:"bulk-clove",      name:"Clove",                      aliases:["clove","krambu","laung"]},
  {id:"bulk-cassia",     name:"Cassia Whole",               aliases:["cassia","cinnamon","pattai","dalchini"]},
  {id:"bulk-kalpasi",    name:"Kalpasi (Stone Flower)",     aliases:["kalpasi","stone flower"]},
  {id:"bulk-staranise",  name:"Star Aniseeds",              aliases:["star anise","star aniseed","annasipoo"]},
  {id:"bulk-kasthurimethil",name:"Kasthuri Methi",          aliases:["kasthuri methi","kasoori methi","dried fenugreek leaves"]},
  {id:"bulk-brinjileaves",name:"Brinji Leaves",             aliases:["brinji leaves","bay leaf","bay leaves","biryani leaf"]},
  {id:"bulk-mustardclean",name:"Mustard Big Clean",         aliases:["mustard big clean","big mustard","yellow mustard"]},
  {id:"bulk-jaggery",    name:"Jaggery",                    aliases:["jaggery","vellam","gur","round jaggery","jaggery powder","nattu vellam"]},
  {id:"bulk-natsak",     name:"Nattu Sakkarai",             aliases:["nattu sakkarai","country sugar","unrefined sugar","khandsari"]},
  {id:"bulk-palm",       name:"Palm Candy",                 aliases:["palm candy","panangkalkandu","palm sugar candy"]},
  {id:"bulk-badam",      name:"Badam",                      aliases:["badam","almond"]},
  {id:"bulk-cashew",     name:"Cashew",                     aliases:["cashew","munthiri","kaju"]},
  {id:"bulk-pista",      name:"Pista",                      aliases:["pista","pistachio"]},
  {id:"bulk-raisin",     name:"Dry Grapes / Raisin",        aliases:["raisin","dry grapes","golden raisin","kismis","kismish","thrakhai"]},
  {id:"bulk-flax",       name:"Flax Seeds",                 aliases:["flax seeds","flaxseed","flax seed","ali virai","linseed"]},
  {id:"bulk-chia",       name:"Chia Seeds",                 aliases:["chia seeds","chia"]},
  {id:"bulk-sunfl",      name:"Sunflower Seeds",            aliases:["sunflower seeds","suryamukhi"]},
  {id:"bulk-pumpkin",    name:"Pumpkin Seeds",              aliases:["pumpkin seeds","poosanikai vithai"]},
  {id:"bulk-blackraisin",name:"Black Raisin",               aliases:["black raisin","black grapes dry","karuppu kismis"]},
  {id:"bulk-greenraisin",name:"Green Raisins",              aliases:["green raisins","green raisin","green grapes dry","pachai kismis"]},
  {id:"bulk-inddrygr",   name:"Indian Dry Grapes",          aliases:["indian dry grapes","draksha","honey grapes","theni kismis"]},
  {id:"bulk-dryfigs",    name:"Dry Figs (Atthi Fruit)",     aliases:["dry figs","figs","atthi","atthi pazham","anjeer"]},
  {id:"bulk-badamgond",  name:"Badam Gond (Imported Gum)",  aliases:["badam gond","imported gum","gond","edible gum","gondh"]},
];

function normalize(s) {
  return (s || '').toLowerCase()
    .replace(/\s*\d+\s*(g|gm|kg|ml|l|pcs|pieces)\b/gi, '')  // strip pack sizes
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findMatch(productName) {
  const pn = normalize(productName);
  if (!pn) return null;

  // 1. Exact alias match
  for (const c of BULK_COMMODITIES) {
    for (const alias of c.aliases) {
      if (pn === normalize(alias)) return { id: c.id, name: c.name, score: 100 };
    }
  }

  // 2. Product name contains alias (or alias contains product name)
  let best = null;
  for (const c of BULK_COMMODITIES) {
    for (const alias of c.aliases) {
      const an = normalize(alias);
      if (!an) continue;
      if (pn.includes(an) || an.includes(pn)) {
        const score = an.length; // longer match = more specific
        if (!best || score > best.score) best = { id: c.id, name: c.name, score };
      }
    }
  }
  if (best) return best;

  // 3. Word overlap — all significant words of product name appear in any alias
  const words = pn.split(' ').filter(w => w.length > 2);
  if (words.length === 0) return null;
  for (const c of BULK_COMMODITIES) {
    for (const alias of c.aliases) {
      const an = normalize(alias);
      if (words.every(w => an.includes(w))) {
        return { id: c.id, name: c.name, score: 50 };
      }
    }
  }

  return null;
}

async function run() {
  const { data: products, error } = await supabase
    .from('products')
    .select('id, name, commodity_id, cat')
    .eq('active', true);

  if (error) { console.error('Fetch error:', error.message); process.exit(1); }

  console.log(`\nFound ${products.length} active products\n`);

  const updates = [];
  const skipped = [];
  const noMatch = [];

  for (const p of products) {
    if (p.commodity_id) {
      skipped.push(`  [SKIP already linked] ${p.name} → ${p.commodity_id}`);
      continue;
    }
    if (p.cat === 'oil') {
      // Oil products use oilTypeKey, not commodity_id — skip
      skipped.push(`  [SKIP oil product]     ${p.name}`);
      continue;
    }

    const match = findMatch(p.name);
    if (match) {
      updates.push({ id: p.id, name: p.name, commodity_id: match.id, matchedTo: match.name });
    } else {
      noMatch.push(`  [NO MATCH]  ${p.name}`);
    }
  }

  console.log('=== WILL LINK ===');
  updates.forEach(u => console.log(`  ${u.name}  →  ${u.commodity_id}  (${u.matchedTo})`));

  console.log('\n=== NO MATCH FOUND ===');
  noMatch.forEach(s => console.log(s));

  console.log('\n=== SKIPPED ===');
  skipped.forEach(s => console.log(s));

  if (!updates.length) {
    console.log('\nNothing to update.');
    return;
  }

  console.log(`\nApplying ${updates.length} links...`);
  for (const u of updates) {
    const { error: err } = await supabase
      .from('products')
      .update({ commodity_id: u.commodity_id })
      .eq('id', u.id);
    if (err) console.error(`  ERROR ${u.name}: ${err.message}`);
    else console.log(`  ✅ ${u.name} → ${u.commodity_id}`);
  }

  console.log('\nDone.');
}

run().catch(console.error);
