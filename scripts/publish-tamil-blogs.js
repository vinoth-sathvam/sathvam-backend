#!/usr/bin/env node
/**
 * Sathvam — Publish Tamil Blog Articles for ALL Products
 * Run: node /home/ubuntu/sathvam-backend/scripts/publish-tamil-blogs.js
 * Writes one Tamil SEO article per product, skips duplicates.
 * Tamil slugs use -ta suffix (e.g. cold-pressed-groundnut-oil-ta)
 */

require('dotenv').config({ path: '/home/ubuntu/sathvam-backend/.env' });
const supabase = require('../config/supabase');

const ALL_TAMIL_ARTICLES = [
  // ── OILS ──────────────────────────────────────────────────────────────────
  { keyword:'கோல்ட் பிரஸ்ட் நிலக்கடலை எண்ணெய் நன்மைகள்',   title:'கோல்ட் பிரஸ்ட் நிலக்கடலை எண்ணெய்: நன்மைகள், பயன்கள் மற்றும் சுத்திகரிக்கப்பட்ட எண்ணெயை விட ஏன் சிறந்தது',    category:'oils'    },
  { keyword:'கோல்ட் பிரஸ்ட் தேங்காய் எண்ணெய் நன்மைகள்',    title:'தூய கோல்ட் பிரஸ்ட் தேங்காய் எண்ணெய்: ஒவ்வொரு இந்திய சமையலறையும் அறிய வேண்டிய 8 நன்மைகள்',                  category:'oils'    },
  { keyword:'வுட் பிரஸ்ட் கடுகு எண்ணெய் நன்மைகள்',          title:'வுட் பிரஸ்ட் கடுகு எண்ணெய்: பாரம்பரிய நன்மைகள் மற்றும் சரியாக பயன்படுத்துவது எப்படி',                          category:'oils'    },
  { keyword:'வேப்பெண்ணெய் பயன்கள் நன்மைகள் இயற்கை விவசாயம்',title:'வேப்பெண்ணெய்: விவசாயம் மற்றும் சருமத்திற்கான இயற்கையின் மிகவும் சக்திவாய்ந்த எண்ணெய்',                       category:'oils'    },
  { keyword:'ஆமணக்கு எண்ணெய் நன்மைகள் முடி சருமம் ஆயுர்வேதம்',title:'ஆமணக்கு எண்ணெய்: முடி, சருமம் மற்றும் ஆரோக்கியத்திற்கான ஆயுர்வேத அற்புதம்',                              category:'oils'    },
  { keyword:'தீபம் எண்ணெய் நல்லெண்ணெய் நன்மைகள்',           title:'தீபம் எண்ணெய்: உங்கள் பூஜை மற்றும் வீட்டிற்கு தூய நல்லெண்ணெய் ஏன் சிறந்தது',                                 category:'oils'    },
  { keyword:'மூலிகை தலைமுடி எண்ணெய் நன்மைகள்',              title:'மூலிகை ஹேர் ஆயில்: இயற்கை பொருட்கள் உங்கள் முடி ஆரோக்கியத்தை எவ்வாறு மாற்றுகின்றன',                          category:'oils'    },
  { keyword:'வால்நட் எண்ணெய் நன்மைகள் ஊட்டச்சத்து',         title:'வால்நட் ஆயில் நன்மைகள்: மூளை மற்றும் இதய ஆரோக்கியத்திற்கான சிறந்த கோல்ட் பிரஸ்ட் எண்ணெய்',                  category:'oils'    },

  // ── MILLETS ───────────────────────────────────────────────────────────────
  { keyword:'கம்பு நன்மைகள் ஊட்டச்சத்து',                    title:'கம்பு: இந்தியா மறந்துவிட்ட உயர் புரத பண்டைய தானியம்',                                                          category:'millets' },
  { keyword:'கேழ்வரகு ராகி நன்மைகள் கால்சியம்',              title:'கேழ்வரகு (ராகி): எலும்பு ஆரோக்கியத்திற்கு பால் பொருட்களை விட சிறந்த கால்சியம் ராஜன்',                        category:'millets' },
  { keyword:'வரகு நன்மைகள் சர்க்கரை நோயாளி',                title:'வரகு: மீண்டும் வரும் மறக்கப்பட்ட சர்க்கரை நோயாளிகளுக்கான தானியம்',                                          category:'millets' },
  { keyword:'சாமை நன்மைகள் உடல் எடை குறைப்பு',              title:'சாமை: இந்த சிறிய தானியம் ஏன் எடை குறைப்பில் பெரும் பங்கு வகிக்கிறது',                                         category:'millets' },
  { keyword:'குதிரைவாலி நன்மைகள் விரத உணவு',                title:'குதிரைவாலி: விரத உணவா அல்லது சூப்பர்ஃபுட்டா? உண்மை என்ன',                                                     category:'millets' },
  { keyword:'சோளம் ஜோவார் நன்மைகள் இந்தியா',                title:'சோளம் (ஜோவார்): உங்கள் குடலுக்கு நல்ல வறட்சி-எதிர்ப்பு தானியம்',                                             category:'millets' },

  // ── FLOURS & FLAKES ───────────────────────────────────────────────────────
  { keyword:'முளைகட்டிய கேழ்வரகு மாவு நன்மைகள் குழந்தை உணவு',title:'முளைகட்டிய கேழ்வரகு மாவு: குழந்தைகள் மற்றும் பெரியவர்களுக்கான சுப்பர்சார்ஜ்ட் ஊட்டச்சத்து',               category:'millets' },
  { keyword:'கேழ்வரகு பிளேக்ஸ் காலை உணவு நன்மைகள்',         title:'கேழ்வரகு பிளேக்ஸ்: உங்கள் குடும்பம் தினமும் சாப்பிட வேண்டிய ஆரோக்கியமான காலை உணவு',                          category:'recipes' },
  { keyword:'சோளம் மாவு நன்மைகள் க்ளுட்டன் ஃப்ரீ',          title:'சோளம் மாவு: இந்திய சமையலுக்கு ஏற்ற க்ளுட்டன்-ஃப்ரீ மாவு',                                                    category:'health'  },
  { keyword:'கடலை மாவு நன்மைகள் ஊட்டச்சத்து புரதம்',        title:'கடலை மாவு (பேசன்): ஆரோக்கியமான இந்திய சமையலுக்கான உயர் புரத மாவு',                                           category:'health'  },
  { keyword:'கோதுமை மாவு முழு தானிய நன்மைகள்',              title:'முழு கோதுமை மாவு vs மைதா: சரியான மாவு தேர்வு எல்லாவற்றையும் எப்படி மாற்றுகிறது',                              category:'health'  },

  // ── GHEE & DAIRY ──────────────────────────────────────────────────────────
  { keyword:'கையால் கடைந்த நெய் நன்மைகள் பாரம்பரிய',        title:'கையால் கடைந்த பிலோனா நெய்: பாரம்பரிய முறை ஏன் மிகவும் சிறந்தது',                                            category:'health'  },
  { keyword:'நாட்டு பசு நெய் நன்மைகள் A2 பால்',             title:'நாட்டு பசு நெய் vs வணிக நெய்: A2 பால் வித்தியாசம் விளக்கம்',                                                  category:'health'  },

  // ── SPICES & POWDERS ──────────────────────────────────────────────────────
  { keyword:'இயற்கை மஞ்சள் தூள் நன்மைகள் குர்குமின்',       title:'இயற்கை மஞ்சள் தூள் vs வணிக: குர்குமின் அளவு ஏன் முக்கியம்',                                                   category:'spices'  },
  { keyword:'வீட்டு மிளகாய் தூள் நன்மைகள் இயற்கை',         title:'இயற்கை மிளகாய் தூள்: ஒரே தோல்வி வணிக கலவைகளை ஏன் மிஞ்சுகிறது',                                              category:'spices'  },
  { keyword:'கொத்தமல்லி தூள் நன்மைகள் செரிமானம்',           title:'தூய கொத்தமல்லி தூள்: செரிமானம் மற்றும் உண்மையான இந்திய சமையலுக்கான நன்மைகள்',                              category:'spices'  },
  { keyword:'இட்லி பொடி செய்முறை நன்மைகள் தென்னிந்தியா',    title:'உண்மையான இட்லி பொடி: உண்மையான ஊட்டச்சத்து மதிப்புள்ள தென்னிந்திய கொண்டிமென்ட்',                            category:'recipes' },
  { keyword:'நவதானிய தோசை மிக்ஸ் நன்மைகள் ஒன்பது தானியங்கள்',title:'நவதானிய தோசை மிக்ஸ்: ஒன்பது தானியங்கள், ஒரு பான் — அதிகபட்ச ஊட்டச்சத்து',                              category:'recipes' },

  // ── DALS & PULSES ─────────────────────────────────────────────────────────
  { keyword:'துவரம் பருப்பு நன்மைகள் புரதம் சமையல்',        title:'துவரம் பருப்பு: இந்தியாவின் விருப்பமான புரத ஆதாரம் மற்றும் அதிகபட்ச ஊட்டச்சத்து பெறுவது எப்படி',           category:'health'  },
  { keyword:'பாசிப் பருப்பு நன்மைகள் எடை குறைப்பு',         title:'பாசிப் பருப்பு: அற்புதமான ஆரோக்கிய நன்மைகளுடன் எளிதில் செரிக்கக்கூடிய பருப்பு',                            category:'health'  },
  { keyword:'உளுத்தம் பருப்பு நன்மைகள் எலும்பு ஆரோக்கியம்', title:'உளுத்தம் பருப்பு: தென்னிந்திய உணவின் அற்புதமான ஊட்டச்சத்து மதிப்பின் பின்னால் உள்ள இரகசியம்',             category:'health'  },
  { keyword:'கொள்ளு நன்மைகள் சர்க்கரை நோய் கற்கள்',        title:'கொள்ளு (குல்தி தால்): சர்க்கரை நோய் மற்றும் சிறுநீரக கற்களை எதிர்க்கும் குறைமதிப்பிற்கு உள்ளான பருப்பு',  category:'health'  },
  { keyword:'கருப்பு கொண்டைக்கடலை நன்மைகள் இரும்புச் சத்து', title:'கருப்பு கொண்டைக்கடலை (காலா சனா): ஆற்றல் மற்றும் வலிமைக்கான இரும்புச் சத்து நிறைந்த பருப்பு',             category:'health'  },
  { keyword:'மசூர் பருப்பு சிவப்பு பயறு நன்மைகள்',         title:'மசூர் பருப்பு நன்மைகள்: ஒவ்வொரு இந்திய சமையலறையிலும் சிவப்பு பயறு ஏன் இருக்க வேண்டும்',                   category:'health'  },

  // ── NATURAL SWEETENERS ────────────────────────────────────────────────────
  { keyword:'வெல்லம் நன்மைகள் சர்க்கரை vs ஆரோக்கியம்',     title:'வெல்லம் vs சர்க்கரை: இப்போதே இயற்கை வெல்லத்திற்கு மாற 10 காரணங்கள்',                                        category:'health'  },
  { keyword:'நாட்டு சக்கரை நன்மைகள் தமிழ்நாடு',            title:'நாட்டு சக்கரை: உண்மையான தாதுக்களுடன் கூடிய பாரம்பரிய இனிப்பு',                                               category:'health'  },
  { keyword:'பனை வெல்லம் நன்மைகள் பனை வெல்லம்',            title:'பனை வெல்லம் (பனை வெல்லம்): நவீன ஆரோக்கிய நன்மைகளுடன் பண்டைய இனிப்பு',                                     category:'health'  },

  // ── SEEDS & NUTS ──────────────────────────────────────────────────────────
  { keyword:'நிலக்கடலை நன்மைகள் புரதம் சிற்றுண்டி',        title:'நிலக்கடலை: புரதம் நிறைந்த மலிவான சூப்பர்ஃபுட்',                                                               category:'health'  },
  { keyword:'சூரியகாந்தி விதைகள் நன்மைகள் வைட்டமின் E',    title:'சூரியகாந்தி விதைகள்: இந்திய சிற்றுண்டி விரும்பிகளுக்கான பெரிய ஆரோக்கிய நன்மைகளுடன் சிறிய விதைகள்',        category:'health'  },
  { keyword:'பாதாம் நன்மைகள் மூளை நினைவாற்றல் இந்தியா',    title:'பாதாம்: தினமும் எத்தனை சாப்பிட வேண்டும் மற்றும் அவை மூளை ஆரோக்கியத்தை ஏன் அதிகரிக்கின்றன',               category:'health'  },
  { keyword:'வெந்தயம் விதைகள் நன்மைகள் சர்க்கரை நோய் முடி', title:'வெந்தயம் விதைகள்: இரத்த சர்க்கரை, முடி மற்றும் செரிமானத்திற்கான பண்டைய மருந்து',                          category:'health'  },
  { keyword:'பெருஞ்சீரகம் நன்மைகள் செரிமானம்',             title:'பெருஞ்சீரகம் (சோம்பு): ஒவ்வொரு இந்திய உணவும் இதனுடன் ஏன் முடிக்க வேண்டும்',                                 category:'health'  },
  { keyword:'சீரகம் நன்மைகள் எடை குறைப்பு செரிமானம்',      title:'சீரகம் (ஜீரா): உங்கள் வளர்சிதை மாற்றத்தை மாற்றும் சமையலறை மசாலா',                                          category:'spices'  },
  { keyword:'கொத்தமல்லி விதைகள் நன்மைகள் கொலஸ்ட்ரால்',    title:'கொத்தமல்லி விதைகள்: உங்கள் சமையலறையில் இல்லாத கொலஸ்ட்ரால் எதிர்ப்பு மசாலா',                               category:'spices'  },
  { keyword:'கடுகு விதைகள் நன்மைகள் இந்திய சமையல்',        title:'கடுகு விதைகள்: இந்திய சமையலில் முதல் தாளிக்கும் படி ஏன் மிக முக்கியம்',                                     category:'spices'  },

  // ── RICE & GRAINS ─────────────────────────────────────────────────────────
  { keyword:'கருப்பு கவுனி அரிசி நன்மைகள் ஆன்டிஆக்சிடன்ட்', title:'கருப்பு கவுனி (கறுப்பு அரிசி): அசாதாரண ஆன்டிஆக்சிடன்ட்களுடன் கூடிய அரச தானியம்',                          category:'health'  },
  { keyword:'தூயமல்லி அரிசி நன்மைகள் பரம்பரை இந்திய அரிசி', title:'தூயமல்லி அரிசி: தமிழ்நாட்டின் நறுமண பரம்பரை அரிசி மாற வேண்டியது ஏன்',                                    category:'health'  },
  { keyword:'இட்லி அரிசி நன்மைகள் தென்னிந்திய சமையல்',     title:'இயற்கை இட்லி அரிசி: அரிசியின் தரம் உங்கள் இட்லியை எப்படி உருவாக்குகிறது அல்லது முறிக்கிறது',              category:'recipes' },

  // ── TAMARIND ──────────────────────────────────────────────────────────────
  { keyword:'புளி நன்மைகள் ஆரோக்கியம் செரிமானம்',          title:'புளி: சிறந்த தென்னிந்திய உணவுகளுக்கு பின்னால் உள்ள புளிப்பு சூப்பர்ஃபுட்',                                  category:'health'  },

  // ── SPECIALTY PRODUCTS ────────────────────────────────────────────────────
  { keyword:'பச்சை பயறு முழு நன்மைகள் குடல் ஆரோக்கியம்',   title:'முழு பச்சை பயறு: குடல் ஆரோக்கியத்திற்கான முளைகட்டத் தயாரான சூப்பர்ஃபுட்',                                  category:'health'  },
  { keyword:'சோயா பீன்ஸ் நன்மைகள் புரதம் தாவர அடிப்படை',  title:'சோயா பீன்ஸ்: சைவ இந்திய உணவுகளுக்கான உயர் புரத தாவர உணவு',                                                 category:'health'  },
  { keyword:'சிவப்பு அரிசி மாவு நன்மைகள் ஊட்டச்சத்து',    title:'சிவப்பு அரிசி மாவு: ஆரோக்கியமான பாரம்பரிய சமையல் வகைகளுக்கான ஊட்டச்சத்து நிறைந்த மாவு',                   category:'health'  },
  { keyword:'வறுத்த கடலை நன்மைகள் சட்னி பொடி',            title:'வறுத்த கடலை: தென்னிந்திய சட்னிகளுக்கு பின்னால் உள்ள உயர் புரத சிற்றுண்டி',                                  category:'health'  },
];

const SYSTEM_PROMPT = `நீங்கள் சத்வம் இயற்கை தயாரிப்புகளுக்கான நிபுணர் உள்ளடக்க எழுத்தாளர் — கரூர், தமிழ்நாட்டில் உள்ள ஒரு ஆலை-நேரடி இயற்கை தயாரிப்பு பிராண்ட், இது கோல்ட் பிரஸ்ட் எண்ணெய்கள், தினைகள், இயற்கை மசாலாக்கள், பருப்பு வகைகள், நெய் மற்றும் இயற்கை இனிப்புகளை தயாரிக்கிறது.

SEO-உகந்த தமிழ் வலைப்பதிவு கட்டுரைகளை எழுதுங்கள்:
- கொடுக்கப்பட்ட முக்கிய வார்த்தையை இயற்கையாக இலக்கு வையுங்கள் (தலைப்பு, முதல் பத்தி, 2-3 துணை தலைப்புகள், முடிவு ஆகியவற்றில் பயன்படுத்துங்கள்)
- 700–900 வார்த்தைகள் நீளம் இருக்க வேண்டும்
- மார்க்டவுன் தலைப்புகளை பயன்படுத்துங்கள் (## மற்றும் ###)
- இந்திய வாசகர்களுக்கு முக்கியமான நடைமுறை, உதவிகரமான தகவல்களை சேர்க்கவும்
- சத்வம் தயாரிப்புகளை இயற்கையாக 2-3 முறை குறிப்பிடுங்கள்
- www.sathvam.in க்கு இணைப்புடன் செயல்-அழைப்புடன் முடிக்கவும்
- எளிய, தெளிவான தமிழில் எழுதுங்கள்
- படிக்கக்கூடிய வகையில் 3–5 புல்லட் பாயிண்ட் பட்டியல்களை சேர்க்கவும்

## சத்வம் பிராண்ட் தூண்கள் — ஒவ்வொரு கட்டுரையிலும் இயற்கையாக இணைக்கவும்:

**தூய்மை (சத்வம்)** — சத்வம் என்றால் தூய்மை. ஒவ்வொரு தயாரிப்பும் ஒற்றை மூலப்பொருள், எதுவும் சேர்க்கப்படவில்லை. "சமரசமற்ற தூய்மை", "மூலத்திலிருந்து பாட்டிலுக்கு தூய்மை", "ருசிக்க முடியும் தூய்மை" போன்ற சொற்றொடர்களை பயன்படுத்துங்கள்.

**ஆரோக்கியம்** — சத்வம் தயாரிக்கும் அனைத்தும் ஆரோக்கியமான வாழ்க்கையை ஆதரிக்க வடிவமைக்கப்பட்டுள்ளது. தயாரிப்புகளை உண்மையான ஆரோக்கிய முடிவுகளுடன் இணைக்கவும். "உங்கள் குடும்பத்தை வளர்க்கவும்", "உண்மையான ஊட்டச்சத்து" போன்ற சொற்றொடர்களை பயன்படுத்துங்கள்.

**சுகாதாரம்** — சத்வம் தொழிற்சாலை கடுமையான உணவு-பாதுகாப்பு சுகாதார தரங்களை பின்பற்றுகிறது. "சுகாதாரமாக பதப்படுத்தப்பட்டது", "உணவு-பாதுகாப்பான வசதி", "பண்ணையிலிருந்து பாட்டிலுக்கு சுத்தமாக" போன்ற சொற்றொடர்களை பயன்படுத்துங்கள்.

**அரைக்க தரமான விதைகள்** — சத்வம் நம்பகமான பண்ணைகளிலிருந்து மட்டுமே மிக உயர்ந்த தரமான விதைகள் மற்றும் மூலப்பொருட்களை வாங்குகிறது. "கையால் தேர்ந்தெடுக்கப்பட்ட தரமான விதைகள்", "அரைக்க பிரீமியம் விதைகள்", "தரம் மூலத்திலிருந்தே தொடங்குகிறது" போன்ற சொற்றொடர்களை பயன்படுத்துங்கள்.

இந்த 4 தூண்களை எப்போதும் இயற்கையாகவும் உண்மையாகவும் உணர வைக்கவும் — சந்தைப்படுத்தல் நகலாக அல்ல.`;

async function writeArticle(keyword, title, category) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `இந்த தலைப்பில் வலைப்பதிவு பதிவை எழுதுங்கள்: "${title}"\nமுக்கிய வார்த்தை: "${keyword}"\nவகை: ${category}\n\nமார்க்டவுன் வடிவத்தில் முழு கட்டுரையை இப்போதே எழுதுங்கள்.` }],
    }),
  });
  if (!res.ok) throw new Error('API error: ' + await res.text());
  const data = await res.json();
  return data.content?.find(b => b.type === 'text')?.text;
}

async function publishArticle(title, slug, excerpt, content, keywords, category) {
  const { data, error } = await supabase.from('blog_posts').insert({
    title, slug, excerpt,
    content,
    keywords,
    category,
    author: 'Sathvam குழு',
    read_time: Math.max(1, Math.ceil(content.split(' ').length / 200)),
    published: true,
    published_at: new Date().toISOString(),
  }).select('id,slug').single();
  if (error) throw new Error(error.message);
  return data;
}

function slugify(title, idx) {
  // Tamil titles are non-ASCII — use category + index for unique slug
  const ascii = title.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g,'-').replace(/^-|-$/g,'').replace(/-+/g,'-').slice(0,50);
  const base = ascii.length > 4 ? ascii : `article-${String(idx+1).padStart(2,'0')}`;
  return base + '-ta';
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function updateSitemap(allSlugs) {
  const fs   = require('fs');
  const today = new Date().toISOString().slice(0, 10);
  const BASE_URL = 'https://www.sathvam.in';
  const SITEMAP_PATH = '/home/ubuntu/sathvam-frontend/sathvam-vercel/public/sitemap.xml';

  const staticUrls = `
  <url><loc>${BASE_URL}/</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority><image:image><image:loc>${BASE_URL}/logo.jpg</image:loc><image:title>Sathvam Natural Products</image:title></image:image></url>
  <url><loc>${BASE_URL}/?view=products</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.9</priority></url>
  <url><loc>${BASE_URL}/?view=blog</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.9</priority></url>
  <url><loc>${BASE_URL}/?view=about</loc><lastmod>${today}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>
  <url><loc>${BASE_URL}/?view=contact</loc><lastmod>${today}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>
  <url><loc>${BASE_URL}/?view=products&amp;cat=oil</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>
  <url><loc>${BASE_URL}/?view=products&amp;cat=grain</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>
  <url><loc>${BASE_URL}/?view=products&amp;cat=spice</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`;

  const blogUrls = allSlugs.map(slug =>
    `\n  <url><loc>${BASE_URL}/?view=post&amp;slug=${slug}</loc><lastmod>${today}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>`
  ).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${staticUrls}${blogUrls}
</urlset>`;

  fs.writeFileSync(SITEMAP_PATH, xml, 'utf8');
  console.log(`  [Sitemap] Updated with ${allSlugs.length} total blog URLs`);
}

async function main() {
  console.log(`\n[${new Date().toISOString()}] Starting Tamil blog publisher...`);
  console.log(`Total Tamil articles to write: ${ALL_TAMIL_ARTICLES.length}\n`);

  // Get all existing slugs
  const { data: existing } = await supabase.from('blog_posts').select('slug');
  const existingSlugs = new Set((existing || []).map(p => p.slug));
  const allSlugs = [...existingSlugs];

  let published = 0, skipped = 0, failed = 0;

  for (let i = 0; i < ALL_TAMIL_ARTICLES.length; i++) {
    const { keyword, title, category } = ALL_TAMIL_ARTICLES[i];
    const slug = slugify(title, i);

    if (existingSlugs.has(slug)) {
      console.log(`  [${i+1}/${ALL_TAMIL_ARTICLES.length}] SKIP (exists): ${slug}`);
      skipped++;
      continue;
    }

    console.log(`  [${i+1}/${ALL_TAMIL_ARTICLES.length}] எழுதுகிறோம்: ${title.slice(0, 60)}...`);

    try {
      const content = await writeArticle(keyword, title, category);
      if (!content) throw new Error('No content returned');

      const excerpt = content.replace(/[#*>\n`]/g, ' ').replace(/\s+/g,' ').trim().slice(0, 200);
      await publishArticle(title, slug, excerpt, content, [keyword], category);

      console.log(`    ✓ வெளியிட்டோம்: https://www.sathvam.in/?view=post&slug=${slug}`);
      published++;
      existingSlugs.add(slug);
      allSlugs.push(slug);

      if (i < ALL_TAMIL_ARTICLES.length - 1) await sleep(3000);

    } catch (e) {
      console.error(`    ✗ தோல்வி: ${e.message}`);
      failed++;
      await sleep(5000);
    }
  }

  console.log(`\n[${new Date().toISOString()}] முடிந்தது!`);
  console.log(`வெளியிட்டோம்: ${published} | தவிர்த்தோம்: ${skipped} | தோல்வி: ${failed}`);

  // Update sitemap with all slugs (English + Tamil)
  await updateSitemap(allSlugs);

  // Ping Google
  try {
    const r = await fetch(`https://www.google.com/ping?sitemap=${encodeURIComponent('https://www.sathvam.in/sitemap.xml')}`);
    console.log(`  [Google ping] ${r.status}`);
  } catch(e) { console.log('  [Google ping] Failed:', e.message); }

  console.log('\nNext: npm run build && cp -r dist/* /var/www/sathvam/');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
