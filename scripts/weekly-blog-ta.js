#!/usr/bin/env node
/**
 * Sathvam Weekly Tamil Blog Writer
 * Runs every Monday 10:00 AM IST (04:30 UTC) via systemd timer
 * Picks a rotating Tamil keyword, writes article via Claude, publishes to Supabase
 */
require('dotenv').config({ path: '/home/ubuntu/sathvam-backend/.env' });
const supabase = require('../config/supabase');

const KEYWORDS = [
  { keyword:'கோல்ட் பிரஸ்ட் நிலக்கடலை எண்ணெய் நன்மைகள்',    title:'நிலக்கடலை எண்ணெய்: உங்கள் சமையலறையில் இருக்க வேண்டிய 7 காரணங்கள்',              category:'oils'    },
  { keyword:'நல்லெண்ணெய் நன்மைகள் தமிழ் மருத்துவம்',         title:'நல்லெண்ணெய்: தமிழ் மருத்துவம் கூறும் தினசரி பயன்பாட்டின் அற்புத நன்மைகள்',     category:'oils'    },
  { keyword:'தேங்காய் எண்ணெய் நன்மைகள் சமையல்',             title:'தேங்காய் எண்ணெய்: ஒவ்வொரு இந்திய சமையலறையும் தேர்வு செய்ய வேண்டிய ஏன்',      category:'oils'    },
  { keyword:'கேழ்வரகு ராகி நன்மைகள் குழந்தைகள்',             title:'கேழ்வரகு: குழந்தைகளுக்கும் பெரியவர்களுக்கும் ஏற்ற சூப்பர்ஃபுட்',              category:'millets' },
  { keyword:'கம்பு பயன்கள் உடல் ஆரோக்கியம்',                title:'கம்பு: கோடை வெப்பத்தில் உடலை குளிர்விக்கும் பாரம்பரிய தானியம்',                category:'millets' },
  { keyword:'வரகு சர்க்கரை நோய் நன்மைகள்',                  title:'வரகு சாதம்: சர்க்கரை நோயாளிகளுக்கு வரப்பிரசாதமான தானியம்',                    category:'millets' },
  { keyword:'வெல்லம் நன்மைகள் சர்க்கரை விட சிறந்தது',       title:'வெல்லம் vs சர்க்கரை: நம் முன்னோர் ஏன் வெல்லம் சாப்பிட்டார்கள்?',              category:'health'  },
  { keyword:'மஞ்சள் தூள் நன்மைகள் நோய் எதிர்ப்பு சக்தி',   title:'மஞ்சள்: நம் சமையலறையில் மறைந்திருக்கும் இயற்கை மருத்துவம்',                   category:'spices'  },
  { keyword:'கோல்ட் பிரஸ்ட் எண்ணெய் எப்படி தேர்வு செய்வது', title:'கோல்ட் பிரஸ்ட் எண்ணெய் வாங்கும்போது கவனிக்க வேண்டியவை',                        category:'health'  },
  { keyword:'சாமை நன்மைகள் எடை குறைப்பு உணவு',              title:'சாமை: எடை குறைக்க விரும்புவோருக்கான இயற்கை தானியம்',                          category:'millets' },
  { keyword:'கடுகு எண்ணெய் நன்மைகள் தமிழ்நாடு',             title:'கடுகு எண்ணெய்: தமிழ் சமையலின் மறக்கப்பட்ட சுவை ரகசியம்',                     category:'oils'    },
  { keyword:'வேப்பெண்ணெய் பயன்கள் விவசாயம் சருமம்',         title:'வேப்பெண்ணெய்: விவசாயம் முதல் சருமம் வரை பயனுள்ள இயற்கை எண்ணெய்',             category:'oils'    },
  { keyword:'நாட்டு சக்கரை பனை வெல்லம் நன்மைகள்',          title:'நாட்டு சக்கரை மற்றும் பனை வெல்லம்: இயற்கை இனிப்புகளின் ஆரோக்கிய நன்மைகள்',   category:'health'  },
  { keyword:'ராகி கஞ்சி குழந்தை உணவு செய்முறை',             title:'ராகி கஞ்சி: குழந்தைகளுக்கான சத்தான காலை உணவு செய்முறை',                      category:'recipes' },
  { keyword:'சோளம் ஜோவார் நன்மைகள் குடல் ஆரோக்கியம்',      title:'சோளம்: குடல் ஆரோக்கியத்திற்கு சிறந்த தானியம் — ஏன் மீண்டும் சாப்பிட வேண்டும்',category:'millets' },
  { keyword:'கொள்ளு நன்மைகள் எடை குறைப்பு',                 title:'கொள்ளு: கிராமத்து சூப்பர்ஃபுட் — எடை குறைக்கவும் சர்க்கரை கட்டுப்படுத்தவும்', category:'health'  },
  { keyword:'தூய்மையான தேங்காய் எண்ணெய் பயன்கள்',           title:'தேங்காய் எண்ணெய்: சமையல், சருமம், முடி — மூன்றிலும் சிறந்தது ஏன்?',           category:'oils'    },
  { keyword:'உளுத்தம் பருப்பு நன்மைகள் தென்னிந்திய சமையல்', title:'உளுத்தம் பருப்பு: இட்லி தோசைக்கு மட்டுமல்ல, உடல் ஆரோக்கியத்திற்கும்',        category:'health'  },
  { keyword:'குதிரைவாலி விரத உணவு நன்மைகள்',                title:'குதிரைவாலி: விரத நாட்களில் மட்டுமல்ல, தினமும் சாப்பிட வேண்டிய தானியம்',       category:'millets' },
  { keyword:'இட்லி பொடி செய்முறை நன்மைகள்',                 title:'வீட்டு இட்லி பொடி: கடைபொடியை விட 10 மடங்கு சத்தானது ஏன்?',                   category:'recipes' },
  { keyword:'பாசிப் பருப்பு நன்மைகள் குழந்தைகள்',           title:'பாசிப் பருப்பு: எளிதில் செரிக்கும் குழந்தைகளுக்கான சிறந்த உணவு',             category:'health'  },
  { keyword:'வெந்தயம் நன்மைகள் சர்க்கரை கட்டுப்பாடு',      title:'வெந்தயம்: சர்க்கரை நோயை கட்டுப்படுத்தும் இயற்கை மருந்து',                    category:'health'  },
  { keyword:'கருப்பு கவுனி அரிசி நன்மைகள்',                 title:'கருப்பு கவுனி: மூதாதையர் சாப்பிட்ட அரிசியில் மறைந்திருக்கும் ஆரோக்கிய ரகசியம்',category:'health' },
  { keyword:'இட்லி அரிசி தரம் முக்கியத்துவம்',              title:'நல்ல இட்லிக்கு நல்ல அரிசி: இட்லி அரிசி தேர்வு செய்வது எப்படி?',               category:'recipes' },
  { keyword:'கொத்தமல்லி சீரகம் நன்மைகள் செரிமானம்',        title:'கொத்தமல்லி மற்றும் சீரகம்: செரிமான பிரச்சனைக்கு இயற்கை தீர்வு',              category:'spices'  },
  { keyword:'முளைகட்டிய தானியங்கள் நன்மைகள்',               title:'முளைகட்டிய தானியங்கள்: ஊட்டச்சத்தை இரண்டு மடங்கு அதிகரிக்கும் எளிய வழி',    category:'health'  },
  { keyword:'நிலக்கடலை புரதம் சிற்றுண்டி',                   title:'நிலக்கடலை: விலை குறைவான புரத சிற்றுண்டி — தினமும் சாப்பிடலாமா?',             category:'health'  },
  { keyword:'தீபம் நல்லெண்ணெய் பூஜை அறை',                  title:'தீபம் ஏற்றுவதற்கு நல்லெண்ணெய்: ஆன்மீக மற்றும் அறிவியல் காரணங்கள்',           category:'oils'    },
  { keyword:'புளி நன்மைகள் தமிழ் சமையல்',                   title:'புளி: தென்னிந்திய சமையலின் ஆத்மா — ஆரோக்கிய நன்மைகளும் பயன்பாடுகளும்',      category:'health'  },
  { keyword:'ஆமணக்கு எண்ணெய் முடி வளர்ச்சி',               title:'ஆமணக்கு எண்ணெய்: முடி உதிர்வை நிறுத்தி வளர்ச்சியை அதிகரிக்கும் வழி',         category:'health'  },
];

const SYSTEM_PROMPT = `நீங்கள் சத்வம் இயற்கை தயாரிப்புகளுக்கான நிபுணர் உள்ளடக்க எழுத்தாளர் — கரூர், தமிழ்நாட்டில் உள்ள ஒரு ஆலை-நேரடி இயற்கை தயாரிப்பு பிராண்ட்.

SEO-உகந்த தமிழ் வலைப்பதிவு கட்டுரைகளை எழுதுங்கள்:
- கொடுக்கப்பட்ட முக்கிய வார்த்தையை இயற்கையாக இலக்கு வையுங்கள்
- 700–900 வார்த்தைகள் நீளம் இருக்க வேண்டும்
- மார்க்டவுன் தலைப்புகளை பயன்படுத்துங்கள் (## மற்றும் ###)
- இந்திய வாசகர்களுக்கு முக்கியமான நடைமுறை தகவல்களை சேர்க்கவும்
- சத்வம் தயாரிப்புகளை இயற்கையாக 2-3 முறை குறிப்பிடுங்கள்
- www.sathvam.in க்கு இணைப்புடன் செயல்-அழைப்புடன் முடிக்கவும்
- எளிய, தெளிவான தமிழில் எழுதுங்கள்
- 3–5 புல்லட் பாயிண்ட் பட்டியல்களை சேர்க்கவும்

சத்வம் பிராண்ட் தூண்கள்: தூய்மை (சத்வம்), ஆரோக்கியம், சுகாதாரம், தரமான விதைகள்.
இயற்கையாகவும் உண்மையாகவும் எழுதுங்கள் — சந்தைப்படுத்தல் நகலாக அல்ல.`;

function slugify(title, weekNum) {
  return `ta-weekly-${String(weekNum).padStart(3,'0')}`;
}

async function main() {
  console.log(`[${new Date().toISOString()}] Weekly Tamil blog writer starting...`);

  const weekOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(),0,1)) / (7*24*60*60*1000));
  const pick = KEYWORDS[weekOfYear % KEYWORDS.length];
  const slug = slugify(pick.title, weekOfYear);

  console.log(`Article: "${pick.title.slice(0,60)}..."`);

  const { data: existing } = await supabase.from('blog_posts').select('id').eq('slug', slug).single();
  if (existing) {
    console.log('Already published this week, skipping.');
    process.exit(0);
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `இந்த தலைப்பில் வலைப்பதிவு பதிவை எழுதுங்கள்: "${pick.title}"\nமுக்கிய வார்த்தை: "${pick.keyword}"\nவகை: ${pick.category}\n\nமார்க்டவுன் வடிவத்தில் முழு கட்டுரையை இப்போதே எழுதுங்கள்.` }],
    }),
  });
  if (!res.ok) throw new Error('API error: ' + await res.text());
  const content = (await res.json()).content?.find(b=>b.type==='text')?.text;
  if (!content) throw new Error('No content returned');

  const excerpt = content.replace(/[#*>\n`]/g,' ').replace(/\s+/g,' ').trim().slice(0,200);
  const { error } = await supabase.from('blog_posts').insert({
    title: pick.title, slug, excerpt, content,
    keywords: [pick.keyword], category: pick.category,
    author: 'Sathvam குழு',
    read_time: Math.max(1, Math.ceil(content.split(' ').length / 200)),
    published: true,
    published_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);

  console.log(`✓ வெளியிட்டோம்: https://www.sathvam.in/?view=post&slug=${slug}`);
  await fetch(`https://www.google.com/ping?sitemap=${encodeURIComponent('https://www.sathvam.in/sitemap.xml')}`).catch(()=>{});
  console.log(`[${new Date().toISOString()}] முடிந்தது.`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
