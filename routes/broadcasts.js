/**
 * WhatsApp Broadcast System — All daily broadcasts with approval flow
 *
 * Types:
 *   morning   — Good Morning + Thirukkural (Tamil & English)
 *   afternoon — Alternating Recipe / Blog post
 *   night     — Health tip + Good Night (Tamil & English)
 *
 * Approval keywords (admin replies on WhatsApp):
 *   MORNING   → approve & broadcast morning
 *   AFTERNOON → approve & broadcast afternoon
 *   NIGHT     → approve & broadcast night
 *
 * Routes:
 *   GET  /api/broadcasts/today                — all 3 broadcasts for today
 *   POST /api/broadcasts/:type/send-preview   — send preview to admin WA
 *   POST /api/broadcasts/:type/broadcast      — broadcast to all customers
 *   POST /api/broadcasts/:type/approve-from-wa — called internally by botsailor
 */

const express        = require('express');
const { execSync }   = require('child_process');
const fs             = require('fs');
const os             = require('os');
const path           = require('path');
const supabase       = require('../config/supabase');
const { auth }       = require('../middleware/auth');
const { decrypt }    = require('../config/crypto');

// In-memory broadcast progress store (broadcastId → { sent, failed, skipped, total, done, error })
const broadcastProgress = new Map();

// Embed logo as base64 so wkhtmltoimage doesn't need network access
const LOGO_PATH = path.join(__dirname, '../../sathvam-frontend/sathvam-vercel/public/logo.jpg');
const LOGO_URL  = fs.existsSync(LOGO_PATH) ? `data:image/jpeg;base64,${fs.readFileSync(LOGO_PATH).toString('base64')}` : '';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// CONTENT DATA
// ─────────────────────────────────────────────────────────────────────────────

const THIRUKKURALS = [
  { num:1,   tamil:"அகர முதல எழுத்தெல்லாம் ஆதி\nபகவன் முதற்றே உலகு.",         english:"As 'A' is the first of all letters, so the Primal Deity stands first in the world." },
  { num:2,   tamil:"கற்றதனால் ஆய பயனென்கொல் வாலறிவன்\nநற்றாள் தொழாஅர் எனின்.", english:"What is the use of all learning if one does not bow at the feet of the Pure-One?" },
  { num:4,   tamil:"வேண்டுதல் வேண்டாமை இலானடி சேர்ந்தார்க்கு\nயாண்டும் இடும்பை இல.", english:"Those who seek the feet of He who is free of desire and aversion shall never suffer." },
  { num:11,  tamil:"வான்நின்று உலகம் வழங்கி வருதலால்\nதான்அமிழ்தம் என்றுணரற் பாற்று.",   english:"Rain is the elixir of life — it sustains the entire world and all that live upon it." },
  { num:24,  tamil:"உலகத்தோடு ஒட்ட ஒழுகல் பலகற்றும்\nகல்லார் அறிவிலா தார்.",           english:"Those who have not learned to live in harmony with the world are unlearned, despite all their learning." },
  { num:40,  tamil:"அன்பிலார் எல்லாம் தமக்குரியர் அன்புடையார்\nஎன்பும் உரியர் பிறர்க்கு.", english:"The loveless live only for themselves; those full of love give even their bones to others." },
  { num:50,  tamil:"நன்றாகும் ஆக்கம் பெரிதெனினும் சான்றோர்க்கு\nஒன்றாகும் ஒட்டார் செயல்.", english:"Even great gain is nothing to the virtuous if it comes through the deeds of the wicked." },
  { num:61,  tamil:"வாய்மை எனப்படுவது யாதெனின் யாதொன்றும்\nதீமை இலாத சொலல்.",         english:"Truth is speaking words that are absolutely free from harm to anyone." },
  { num:121, tamil:"ஆர்வமொடு ஈதல் அறனெனும் ஆர்வமொடு\nஈதல் அறனெனும் ஆர்வமொடு ஈதல்.", english:"To give with joy is the true virtue — giving with enthusiasm is charity." },
  { num:151, tamil:"வெள்ளத்து அனைய மலர்நீட்டம் மாந்தர்தம்\nஉள்ளத்து அனையது உயர்வு.",   english:"As the lotus rises above the water that sustains it, a person's greatness rises with their soul." },
  { num:176, tamil:"நகையும் உவகையும் கொல்லும் சினத்தின்\nபகையும் உளவோ பிற.",            english:"Anger destroys joy and happiness — is there any greater enemy than rage?" },
  { num:241, tamil:"கல்வி கரையில கற்பவர் நாள்சில\nமல்லல் உலகின் நிலை.",               english:"Knowledge is boundless; the days of a learner are few — this is the condition of our vast world." },
  { num:261, tamil:"உழுதுண்டு வாழ்வாரே வாழ்வார்மற் றெல்லாம்\nதொழுதுண்டு பின்செல்பவர்.", english:"Those who live by the labour of farming truly live; all others merely follow behind begging." },
  { num:331, tamil:"நன்றிக்கு வித்தாகும் நல்லொழுக்கம் தீயொழுக்கம்\nஏன்றும் இடும்பை தரும்.", english:"Good conduct is the seed of all good fortune; bad conduct brings sorrow forever." },
  { num:441, tamil:"நிலையும் திருவும் நிலவாதே செல்வம்\nதலையாய பண்புடையார்க்கு.",        english:"Wealth and high status are unstable — only virtue that sits at the crown endures." },
  { num:461, tamil:"உரன் என்னும் தோட்டியால் ஓட்டப் படுமே\nதிரன் என்னும் யானை பிடிக்கும்.", english:"The elephant of desire is guided by the goad of wisdom — let wisdom steer you always." },
  { num:631, tamil:"உடம்புடைமை கை கொள்ளின் உட்கு அரிதாகும்\nகடன்பட்டோர் கண் அன்ன செயல்.", english:"Health is wealth — protect it as diligently as a debtor guards what is entrusted to them." },
  { num:941, tamil:"கூழுண்டு நீர்குடித்துக் கூடிப் பரிவற்றால்\nவாழ்ந்தான் எனல் ஆகாதோ?",  english:"If one eats simple food, drinks pure water, and lives without strife — is that not a life well lived?" },
  { num:1062,tamil:"மருந்தென வேண்டாவாம் யாக்கைக்கு அருந்தியது\nஅற்றது போற்றி உணின்.",    english:"No medicine is needed for the body if one eats only after the previous meal is fully digested." },
  { num:1063,tamil:"அற்றால் அளவறிந்து உண்க அது உடம்பு\nபெற்றான் நெடிதுய்க்கும் ஆறு.",   english:"Eat only when hungry, and eat in the right measure — this is the way to preserve health for long." },
  { num:1091,tamil:"உள்ளுவ தெல்லாம் உயர்வுள்ளல் மற்றது\nதள்ளினும் தள்ளாமை நீர்த்து.",   english:"Always think of high goals; even if they elude you, the striving itself ennobles the mind." },
  { num:1093,tamil:"துன்பம் துடைத்துத் துணிவு கொள்; துன்பந்\nதுன்பம் எனில் துன்பமில்லை.",   english:"Wipe away sorrow and take courage; if you treat sorrow as just sorrow, it ceases to be sorrow." },
  { num:1102,tamil:"ஊக்கமது கைகொள்ளில் உள்ளது இல்லை\nசாக்காடு சால உணல்.",             english:"With determination, there is nothing impossible to achieve — even death holds no terror." },
  { num:1231,tamil:"ஆகுல மன்ன அழிவு இல்; தழிவு ஒன்றோ\nதாகுல மன்னதாம்.",               english:"Anxiety destroys no enemy — it only destroys oneself. Calm courage conquers all." },
];

const HEALTH_TIPS = [
  {
    english: "Cold-pressed oils retain all natural vitamins, antioxidants & flavour. Refined oils are bleached & stripped of nutrients. Make the switch for your family's health!",
    tamil:   "குளிர்-அழுத்த எண்ணெய்கள் அனைத்து இயற்கை வைட்டமின்கள் மற்றும் ஊட்டச்சத்துக்களை தக்கவைக்கின்றன. உங்கள் குடும்பத்தின் ஆரோக்கியத்திற்காக மாற்றுங்கள்! 🌿",
    title:   "Cold-Pressed vs Refined Oil"
  },
  {
    english: "Sesame oil (நல்லெண்ணெய்) has been used in Ayurveda for 5000+ years. Rich in antioxidants — reduces inflammation, strengthens bones, and is perfect for oil pulling!",
    tamil:   "நல்லெண்ணெய் 5000 ஆண்டுகளாக ஆயுர்வேதத்தில் பயன்படுத்தப்படுகிறது. வீக்கத்தை குறைக்கிறது, எலும்புகளை வலுப்படுத்துகிறது! 🌿",
    title:   "Sesame Oil — The Ayurvedic Elixir"
  },
  {
    english: "Groundnut oil is rich in Vitamin E and monounsaturated fats that support heart health. It has a high smoke point — perfect for deep frying and Indian cooking!",
    tamil:   "கடலை எண்ணெய் இதய ஆரோக்கியத்தை ஆதரிக்கும் வைட்டமின் E நிரம்பியுள்ளது. அதிக புகை புள்ளியுடன் இது இந்திய சமையலுக்கு சிறந்தது! 🥜",
    title:   "Groundnut Oil for Heart Health"
  },
  {
    english: "Millets have 3x more fibre than rice and release sugar slowly (low GI). Foxtail millet, Ragi, Kambu — ancient grains that modern nutrition science loves!",
    tamil:   "சிறுதானியங்களில் அரிசியை விட 3 மடங்கு அதிக நார்ச்சத்து உள்ளது. தினை, கேழ்வரகு, கம்பு — நவீன ஊட்டச்சத்து அறிவியல் விரும்பும் பண்டைய தானியங்கள்! 🌾",
    title:   "Millets — Ancient Superfoods"
  },
  {
    english: "100g of Ragi (Finger Millet) has more calcium than milk! Excellent for growing children, bone health, and preventing osteoporosis. Add to dosa, porridge or ladoo.",
    tamil:   "100 கிராம் கேழ்வரகில் பாலை விட அதிக கால்சியம் உள்ளது! வளரும் குழந்தைகளுக்கும் எலும்பு ஆரோக்கியத்திற்கும் சிறந்தது. தோசை, கஞ்சி அல்லது லட்டுவில் சேர்க்கலாம்! 💪",
    title:   "Ragi — Calcium Powerhouse"
  },
  {
    english: "Coconut oil contains Lauric acid which boosts immunity, improves good cholesterol (HDL), and supports brain function. Always choose cold-pressed for maximum benefit.",
    tamil:   "தேங்காய் எண்ணெயில் உள்ள லாரிக் அமிலம் நோய் எதிர்ப்பு சக்தியை அதிகரிக்கிறது, நல்ல கொழுப்பை (HDL) மேம்படுத்துகிறது. அதிக பலனுக்கு குளிர்-அழுத்த எண்ணெயை தேர்வுசெய்யுங்கள்! 🥥",
    title:   "Coconut Oil Benefits"
  },
  {
    english: "Turmeric + Black Pepper = Powerful healing! Piperine in black pepper boosts curcumin absorption by 2000%. Add both to your morning milk or cooking daily.",
    tamil:   "மஞ்சள் + மிளகு = சக்திவாய்ந்த மருத்துவம்! மிளகிலுள்ள பைபரின் குர்குமின் உறிஞ்சுதலை 2000% அதிகரிக்கிறது. தினமும் பாலில் அல்லது சமையலில் சேர்க்கவும்! ✨",
    title:   "Turmeric + Black Pepper"
  },
  {
    english: "Jaggery retains iron, magnesium, potassium and B-vitamins stripped from white sugar. It detoxifies the liver and boosts digestion. Always choose jaggery over sugar!",
    tamil:   "வெல்லத்தில் இரும்பு, மக்னீசியம், பொட்டாசியம் மற்றும் B வைட்டமின்கள் நிரம்பியுள்ளன. கல்லீரலை சுத்திகரிக்கிறது மற்றும் செரிமானத்தை மேம்படுத்துகிறது. எப்போதும் சர்க்கரைக்கு பதில் வெல்லம் சாப்பிடுங்கள்! 🍬",
    title:   "Jaggery vs White Sugar"
  },
  {
    english: "Oil pulling with sesame or coconut oil for 15 minutes each morning removes toxins, whitens teeth, and strengthens gums. This Ayurvedic practice is 3000 years old!",
    tamil:   "காலையில் 15 நிமிடங்கள் நல்லெண்ணெய் அல்லது தேங்காய் எண்ணெயால் வாய் கொப்பளிப்பது நச்சுகளை நீக்கி, பற்களை வெண்மையாக்கும். இந்த ஆயுர்வேத பழக்கம் 3000 ஆண்டுகள் பழமையானது! 🦷",
    title:   "Oil Pulling Ritual"
  },
  {
    english: "Eat only when truly hungry and stop before you're completely full. This simple practice — followed by our ancestors — prevents lifestyle diseases naturally.",
    tamil:   "உண்மையிலேயே பசிக்கும்போது மட்டுமே சாப்பிடுங்கள், முழுமையாக நிரம்பும் முன் நிறுத்துங்கள். நம் முன்னோர்கள் கடைப்பிடித்த இந்த எளிய பழக்கம் வாழ்க்கை முறை நோய்களை இயற்கையாக தடுக்கிறது! 🍽️",
    title:   "Mindful Eating"
  },
  {
    english: "Horse gram (Kollu) scientifically inhibits fat cell formation, reduces cholesterol, and helps manage kidney stones. Boil with garlic and pepper in sesame oil — a superfood soup!",
    tamil:   "கொள்ளு கொழுப்பு உயிரணு உருவாவதை தடுக்கிறது, கொழுப்பை குறைக்கிறது மற்றும் சிறுநீரக கற்களை நிர்வகிக்க உதவுகிறது. நல்லெண்ணெயில் பூண்டு மற்றும் மிளகு சேர்த்து கொதிக்க வைக்கவும்! 💪",
    title:   "Horse Gram — Fat Burner"
  },
  {
    english: "Fat-soluble vitamins A, D, E & K in vegetables NEED healthy fat to be absorbed. Always drizzle cold-pressed sesame or groundnut oil on your salads and cooked vegetables!",
    tamil:   "காய்கறிகளிலுள்ள A, D, E மற்றும் K வைட்டமின்களை உடல் உறிஞ்ச ஆரோக்கியமான கொழுப்பு அவசியம். சாலட் மற்றும் சமைத்த காய்கறிகளில் குளிர்-அழுத்த எண்ணெய் சேர்க்கவும்! 🥗",
    title:   "Vitamins Need Healthy Fat"
  },
];

const RECIPES = [
  {
    name_en: "Traditional Sesame Oil Rice (Ellu Sadam)",
    name_ta: "பாரம்பரிய எள்ளு சாதம்",
    ingredients_en: "Cooked rice, 3 tbsp Sathvam sesame oil, mustard seeds, urad dal, curry leaves, dry red chilli, asafoetida, roasted sesame seeds, salt",
    ingredients_ta: "சமைத்த சாதம், 3 மேசை கரண்டி சத்வம் நல்லெண்ணெய், கடுகு, உளுந்து, கறிவேப்பிலை, உலர் சிவப்பு மிளகாய், பெருங்காயம், வறுத்த எள், உப்பு",
    method_en: "Heat sesame oil, splutter mustard seeds, urad dal, curry leaves & red chilli. Add asafoetida. Mix into cooked rice with roasted sesame seeds & salt. Serve warm.",
    method_ta: "நல்லெண்ணெயை சூடாக்கி, கடுகு, உளுந்து, கறிவேப்பிலை, மிளகாய் தாளிக்கவும். பெருங்காயம் சேர்க்கவும். சமைத்த சாதத்துடன் வறுத்த எள் மற்றும் உப்பு கலக்கவும். சூடாக பரிமாறவும்.",
    oil: "Sesame Oil | நல்லெண்ணெய்"
  },
  {
    name_en: "Groundnut Oil Brinjal Curry (Kathirikkai Kulambu)",
    name_ta: "கடலை எண்ணெய் கத்திரிக்காய் குழம்பு",
    ingredients_en: "Brinjal, 2 tbsp Sathvam groundnut oil, onion, tomato, tamarind, sambar powder, turmeric, mustard, curry leaves, salt",
    ingredients_ta: "கத்திரிக்காய், 2 மேசை கரண்டி சத்வம் கடலை எண்ணெய், வெங்காயம், தக்காளி, புளி, சாம்பார் பொடி, மஞ்சள், கடுகு, கறிவேப்பிலை, உப்பு",
    method_en: "Heat groundnut oil, add mustard & curry leaves. Sauté onion, tomato till soft. Add brinjal, sambar powder, turmeric, tamarind water & salt. Simmer 15 mins till thick.",
    method_ta: "கடலை எண்ணெயை சூடாக்கி கடுகு, கறிவேப்பிலை தாளிக்கவும். வெங்காயம், தக்காளி வதக்கவும். கத்திரிக்காய், சாம்பார் பொடி, மஞ்சள், புளி தண்ணீர், உப்பு சேர்க்கவும். 15 நிமிடம் கொதிக்க விடவும்.",
    oil: "Groundnut Oil | கடலை எண்ணெய்"
  },
  {
    name_en: "Coconut Oil Pongal (Traditional Kerala Style)",
    name_ta: "தேங்காய் எண்ணெய் பொங்கல்",
    ingredients_en: "Raw rice, moong dal, 2 tbsp Sathvam coconut oil, cumin, pepper, ginger, cashews, ghee, turmeric, salt",
    ingredients_ta: "பச்சரிசி, பாசிப்பருப்பு, 2 மேசை கரண்டி சத்வம் தேங்காய் எண்ணெய், சீரகம், மிளகு, இஞ்சி, முந்திரி, நெய், மஞ்சள், உப்பு",
    method_en: "Cook rice and dal together with turmeric. Heat coconut oil, fry cashews, add cumin, pepper, ginger. Mix into pongal with ghee & salt. Aromatic and nourishing!",
    method_ta: "அரிசி மற்றும் பருப்பை மஞ்சளுடன் சமைக்கவும். தேங்காய் எண்ணெயில் முந்திரி, சீரகம், மிளகு, இஞ்சி வதக்கவும். பொங்கலில் நெய் மற்றும் உப்புடன் கலக்கவும்.",
    oil: "Coconut Oil | தேங்காய் எண்ணெய்"
  },
  {
    name_en: "Mustard Oil Aloo Paratha (North Indian Classic)",
    name_ta: "கடுகு எண்ணெய் உருளைக்கிழங்கு பராத்தா",
    ingredients_en: "Whole wheat flour, boiled potatoes, Sathvam mustard oil, cumin, coriander, green chilli, garam masala, salt, coriander leaves",
    ingredients_ta: "கோதுமை மாவு, வேகவைத்த உருளை, சத்வம் கடுகு எண்ணெய், சீரகம், கொத்தமல்லி, பச்சை மிளகாய், கரம் மசாலா, உப்பு, கொத்தமல்லி இலை",
    method_en: "Make stuffing with mashed potato, spices & coriander. Stuff into wheat dough balls, roll flat. Cook on tawa with mustard oil till golden. The oil gives authentic flavour!",
    method_ta: "உருளை, மசாலா, கொத்தமல்லி சேர்த்து அரைக்கவும். கோதுமை மாவில் நிரப்பி தட்டையாக இடவும். தவாவில் கடுகு எண்ணெய் விட்டு நல்ல சிவப்பு வரும்வரை சுடவும்.",
    oil: "Mustard Oil | கடுகு எண்ணெய்"
  },
  {
    name_en: "Sesame Oil Murukku (Traditional Diwali Snack)",
    name_ta: "நல்லெண்ணெய் முறுக்கு",
    ingredients_en: "Rice flour, urad dal flour, Sathvam sesame oil (for dough & frying), cumin, sesame seeds, asafoetida, butter, salt, water",
    ingredients_ta: "அரிசி மாவு, உளுந்து மாவு, சத்வம் நல்லெண்ணெய், சீரகம், எள், பெருங்காயம், வெண்ணெய், உப்பு, தண்ணீர்",
    method_en: "Mix flours with sesame seeds, cumin, asafoetida, butter & hot sesame oil. Add water to make stiff dough. Press through murukku press into hot oil. Fry till crisp & golden.",
    method_ta: "மாவுகளை எள், சீரகம், பெருங்காயம், வெண்ணெய் மற்றும் சூடான நல்லெண்ணெயுடன் கலக்கவும். தண்ணீர் சேர்த்து மாவை பிசையவும். சூடான எண்ணெயில் முறுக்கு அச்சில் பிழியவும்.",
    oil: "Sesame Oil | நல்லெண்ணெய்"
  },
  {
    name_en: "Groundnut Oil Tomato Rasam",
    name_ta: "கடலை எண்ணெய் தக்காளி ரசம்",
    ingredients_en: "Tomatoes, tamarind, Sathvam groundnut oil, mustard, cumin, pepper, turmeric, rasam powder, garlic, curry leaves, coriander, asafoetida, salt",
    ingredients_ta: "தக்காளி, புளி, சத்வம் கடலை எண்ணெய், கடுகு, சீரகம், மிளகு, மஞ்சள், ரசப்பொடி, பூண்டு, கறிவேப்பிலை, கொத்தமல்லி, பெருங்காயம், உப்பு",
    method_en: "Boil tomatoes with tamarind water, turmeric, rasam powder. Heat groundnut oil, splutter mustard, cumin, pepper, garlic, curry leaves. Add to rasam, garnish with coriander.",
    method_ta: "தக்காளியை புளி தண்ணீர், மஞ்சள், ரசப்பொடியுடன் கொதிக்க வைக்கவும். கடலை எண்ணெயில் கடுகு, சீரகம், மிளகு, பூண்டு, கறிவேப்பிலை தாளிக்கவும். ரசத்தில் சேர்க்கவும்.",
    oil: "Groundnut Oil | கடலை எண்ணெய்"
  },
  {
    name_en: "Coconut Oil Thenga Chutney (Kerala Style)",
    name_ta: "தேங்காய் எண்ணெய் தேங்காய் சட்னி",
    ingredients_en: "Fresh coconut, Sathvam coconut oil, green chilli, ginger, roasted chana dal, salt; Tempering: mustard, curry leaves, dry red chilli",
    ingredients_ta: "தேங்காய், சத்வம் தேங்காய் எண்ணெய், பச்சை மிளகாய், இஞ்சி, வறுத்த கடலை, உப்பு; தாளிக்க: கடுகு, கறிவேப்பிலை, சிவப்பு மிளகாய்",
    method_en: "Grind coconut, chilli, ginger, chana dal & salt. Heat coconut oil, splutter mustard, curry leaves & red chilli. Pour over chutney. Serve with idli or dosa!",
    method_ta: "தேங்காய், மிளகாய், இஞ்சி, கடலை, உப்பு அரைக்கவும். தேங்காய் எண்ணெயில் கடுகு, கறிவேப்பிலை, சிவப்பு மிளகாய் தாளிக்கவும். சட்னியின் மேல் ஊற்றவும். இட்லி அல்லது தோசையுடன் பரிமாறவும்!",
    oil: "Coconut Oil | தேங்காய் எண்ணெய்"
  },
  {
    name_en: "Sesame Oil Kara Kuzhambu",
    name_ta: "நல்லெண்ணெய் கார குழம்பு",
    ingredients_en: "Small onions, garlic, Sathvam sesame oil, tamarind, chilli powder, coriander powder, turmeric, mustard, curry leaves, salt",
    ingredients_ta: "சின்ன வெங்காயம், பூண்டு, சத்வம் நல்லெண்ணெய், புளி, மிளகாய் பொடி, கொத்தமல்லி பொடி, மஞ்சள், கடுகு, கறிவேப்பிலை, உப்பு",
    method_en: "Heat sesame oil generously, sauté onions & garlic till brown. Add all powders, cook 2 mins. Add tamarind water & salt, simmer 20 mins till thick. The sesame oil is essential!",
    method_ta: "நல்லெண்ணெயில் வெங்காயம் மற்றும் பூண்டை பழுப்பு நிறமாகும் வரை வதக்கவும். அனைத்து பொடிகளையும் சேர்க்கவும். புளி தண்ணீர் மற்றும் உப்பு சேர்த்து 20 நிமிடம் கொதிக்க விடவும்.",
    oil: "Sesame Oil | நல்லெண்ணெய்"
  },
  {
    name_en: "Groundnut Oil Peanut Chutney",
    name_ta: "கடலை எண்ணெய் வேர்க்கடலை சட்னி",
    ingredients_en: "Roasted peanuts, Sathvam groundnut oil, red chilli, garlic, tamarind, onion, salt; Tempering: mustard, urad dal, curry leaves",
    ingredients_ta: "வறுத்த வேர்க்கடலை, சத்வம் கடலை எண்ணெய், சிவப்பு மிளகாய், பூண்டு, புளி, வெங்காயம், உப்பு; தாளிக்க: கடுகு, உளுந்து, கறிவேப்பிலை",
    method_en: "Grind peanuts, chilli, garlic, tamarind, onion & salt with water. Heat groundnut oil, splutter mustard, urad dal & curry leaves. Add to chutney. Rich and nutty!",
    method_ta: "வேர்க்கடலை, மிளகாய், பூண்டு, புளி, வெங்காயம், உப்பு தண்ணீருடன் அரைக்கவும். கடலை எண்ணெயில் கடுகு, உளுந்து, கறிவேப்பிலை தாளிக்கவும். சட்னியில் சேர்க்கவும்.",
    oil: "Groundnut Oil | கடலை எண்ணெய்"
  },
  {
    name_en: "Coconut Oil Payasam (Festive Kheer)",
    name_ta: "தேங்காய் எண்ணெய் பாயசம்",
    ingredients_en: "Vermicelli or rice, coconut milk, Sathvam coconut oil, jaggery, cardamom, cashews, raisins, saffron",
    ingredients_ta: "சேமியா அல்லது அரிசி, தேங்காய் பால், சத்வம் தேங்காய் எண்ணெய், வெல்லம், ஏலக்காய், முந்திரி, திராட்சை, குங்குமப்பூ",
    method_en: "Fry vermicelli in coconut oil till golden. Add coconut milk & jaggery, cook till thick. Add cardamom, saffron. Fry cashews & raisins in coconut oil, garnish. Divine!",
    method_ta: "சேமியாவை தேங்காய் எண்ணெயில் பொன்னிறமாக வறுக்கவும். தேங்காய் பால் மற்றும் வெல்லம் சேர்த்து காய்ச்சவும். ஏலக்காய், குங்குமப்பூ சேர்க்கவும். முந்திரி, திராட்சை வறுத்து அலங்கரிக்கவும்.",
    oil: "Coconut Oil | தேங்காய் எண்ணெய்"
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

function dailyItem(arr, salt = 0) {
  const now  = new Date();
  const seed = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate() + salt;
  return arr[seed % arr.length];
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function settingsKey(type) {
  return `broadcast_${type}_${today()}`;
}

// ── Card image helpers ──────────────────────────────────────────────────────

function buildKuralCardHtml(kural) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { width:760px; font-family:'Segoe UI',Arial,sans-serif; background:#1a1a2e; }
.card { background:linear-gradient(145deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%); border-radius:20px; overflow:hidden; margin:16px; box-shadow:0 8px 40px rgba(0,0,0,.5); }
.header { display:flex; align-items:center; gap:14px; padding:18px 24px 14px; border-bottom:1px solid rgba(255,200,80,.15); }
.logo { width:48px; height:48px; border-radius:9px; object-fit:cover; border:1.5px solid rgba(255,200,80,.4); }
.brand-name { color:#ffd700; font-size:17px; font-weight:800; letter-spacing:.3px; }
.brand-sub  { color:rgba(255,215,0,.6); font-size:10px; letter-spacing:1.5px; text-transform:uppercase; margin-top:2px; }
.kural-header { text-align:center; padding:20px 24px 10px; }
.kural-num { display:inline-block; background:rgba(255,215,0,.15); border:1px solid rgba(255,215,0,.4); color:#ffd700; font-size:12px; font-weight:700; padding:3px 14px; border-radius:20px; letter-spacing:1px; margin-bottom:12px; }
.morning-label { color:#ffd700; font-size:20px; font-weight:900; letter-spacing:.5px; }
.morning-sub   { color:rgba(255,255,255,.6); font-size:12px; margin-top:3px; }
.kural-body { padding:16px 28px 20px; }
.kural-tamil { font-size:22px; color:#fff; line-height:1.7; text-align:center; font-weight:500; margin-bottom:16px; background:rgba(255,255,255,.05); border-radius:12px; padding:16px 18px; border-left:3px solid #ffd700; }
.divider { text-align:center; color:rgba(255,215,0,.4); font-size:20px; margin:8px 0; }
.kural-en { font-size:14px; color:rgba(255,255,255,.8); line-height:1.7; text-align:center; font-style:italic; padding:0 8px; }
.footer { display:flex; justify-content:space-between; align-items:center; padding:12px 24px; background:rgba(0,0,0,.3); border-top:1px solid rgba(255,200,80,.1); }
.footer-tag { font-size:11px; color:rgba(255,215,0,.7); font-style:italic; }
.footer-web { font-size:11px; color:rgba(255,255,255,.5); }
</style></head><body>
<div class="card">
  <div class="header">
    <img class="logo" src="${LOGO_URL}" />
    <div>
      <div class="brand-name">Sathvam Natural Products</div>
      <div class="brand-sub">சத்வம் இயற்கை பொருட்கள்</div>
    </div>
  </div>
  <div class="kural-header">
    <div class="kural-num">திருக்குறள் #${kural.num} · Thirukkural ${kural.num}</div>
    <div class="morning-label">🌅 காலை வணக்கம் · Good Morning ☀️</div>
    <div class="morning-sub">Start your day with ancient Tamil wisdom</div>
  </div>
  <div class="kural-body">
    <div class="kural-tamil">${kural.tamil.replace(/\n/g,'<br/>')}</div>
    <div class="divider">✦</div>
    <div class="kural-en">"${kural.english}"</div>
  </div>
  <div class="footer">
    <div class="footer-tag">Pure · Natural · Traditional</div>
    <div class="footer-web">🌐 sathvam.in · 📞 +91 70921 77092</div>
  </div>
</div>
</body></html>`;
}

function buildHealthCardHtml(tip) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { width:760px; font-family:'Segoe UI',Arial,sans-serif; background:#0a1628; }
.card { background:linear-gradient(145deg,#0d2137 0%,#0a3d2b 50%,#0d5c3a 100%); border-radius:20px; overflow:hidden; margin:16px; box-shadow:0 8px 40px rgba(0,0,0,.5); }
.header { display:flex; align-items:center; gap:14px; padding:18px 24px 14px; border-bottom:1px solid rgba(100,255,150,.15); }
.logo { width:48px; height:48px; border-radius:9px; object-fit:cover; border:1.5px solid rgba(100,255,150,.4); }
.brand-name { color:#7dffb0; font-size:17px; font-weight:800; }
.brand-sub  { color:rgba(125,255,176,.6); font-size:10px; letter-spacing:1.5px; text-transform:uppercase; margin-top:2px; }
.night-label { text-align:center; padding:18px 24px 10px; }
.night-title { color:#7dffb0; font-size:22px; font-weight:900; }
.night-sub   { color:rgba(255,255,255,.5); font-size:12px; margin-top:3px; }
.tip-body { padding:16px 28px 22px; }
.tip-title { color:#7dffb0; font-size:18px; font-weight:800; margin-bottom:14px; text-align:center; }
.tip-en { font-size:14px; color:rgba(255,255,255,.9); line-height:1.8; background:rgba(255,255,255,.06); border-radius:12px; padding:14px 18px; border-left:3px solid #7dffb0; margin-bottom:12px; }
.tip-ta { font-size:14px; color:rgba(255,255,255,.75); line-height:1.8; font-style:italic; padding:0 8px; text-align:center; }
.footer { display:flex; justify-content:space-between; align-items:center; padding:12px 24px; background:rgba(0,0,0,.3); border-top:1px solid rgba(100,255,150,.1); }
.footer-tag { font-size:11px; color:rgba(125,255,176,.7); font-style:italic; }
.footer-web { font-size:11px; color:rgba(255,255,255,.4); }
</style></head><body>
<div class="card">
  <div class="header">
    <img class="logo" src="${LOGO_URL}" />
    <div>
      <div class="brand-name">Sathvam Natural Products</div>
      <div class="brand-sub">சத்வம் இயற்கை பொருட்கள்</div>
    </div>
  </div>
  <div class="night-label">
    <div class="night-title">🌙 இரவு வணக்கம் · Good Night ⭐</div>
    <div class="night-sub">இன்றைய ஆரோக்கிய குறிப்பு · Today's Health Tip</div>
  </div>
  <div class="tip-body">
    <div class="tip-title">💡 ${tip.title}</div>
    <div class="tip-en">${tip.english}</div>
    <div class="tip-ta">🌿 ${tip.tamil}</div>
  </div>
  <div class="footer">
    <div class="footer-tag">Your health is our purpose 🙏</div>
    <div class="footer-web">🌐 sathvam.in · 📞 +91 70921 77092</div>
  </div>
</div>
</body></html>`;
}

function buildRecipeCardHtml(recipe) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { width:760px; font-family:'Segoe UI',Arial,sans-serif; background:#1a0a00; }
.card { background:linear-gradient(145deg,#2d1500 0%,#4a2200 50%,#3d1c00 100%); border-radius:20px; overflow:hidden; margin:16px; box-shadow:0 8px 40px rgba(0,0,0,.5); }
.header { display:flex; align-items:center; gap:14px; padding:18px 24px 14px; border-bottom:1px solid rgba(255,165,0,.15); }
.logo { width:48px; height:48px; border-radius:9px; object-fit:cover; border:1.5px solid rgba(255,165,0,.4); }
.brand-name { color:#ffb347; font-size:17px; font-weight:800; }
.brand-sub  { color:rgba(255,179,71,.6); font-size:10px; letter-spacing:1.5px; text-transform:uppercase; margin-top:2px; }
.recipe-label { text-align:center; padding:18px 24px 10px; }
.recipe-title-en { color:#ffb347; font-size:20px; font-weight:900; }
.recipe-title-ta { color:rgba(255,179,71,.75); font-size:15px; margin-top:4px; }
.recipe-oil { display:inline-block; margin-top:10px; background:rgba(255,165,0,.15); border:1px solid rgba(255,165,0,.35); color:#ffb347; font-size:11px; font-weight:700; padding:3px 14px; border-radius:20px; }
.recipe-body { padding:14px 28px 22px; display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.section-title { color:#ffb347; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:1px; margin-bottom:8px; }
.section-box { background:rgba(255,255,255,.05); border-radius:10px; padding:12px 14px; border-left:3px solid rgba(255,165,0,.4); }
.section-text { font-size:12px; color:rgba(255,255,255,.85); line-height:1.7; }
.footer { display:flex; justify-content:space-between; align-items:center; padding:12px 24px; background:rgba(0,0,0,.3); border-top:1px solid rgba(255,165,0,.1); }
.footer-tag { font-size:11px; color:rgba(255,179,71,.7); font-style:italic; }
.footer-web { font-size:11px; color:rgba(255,255,255,.4); }
</style></head><body>
<div class="card">
  <div class="header">
    <img class="logo" src="${LOGO_URL}" />
    <div>
      <div class="brand-name">Sathvam Natural Products</div>
      <div class="brand-sub">சத்வம் இயற்கை பொருட்கள்</div>
    </div>
  </div>
  <div class="recipe-label">
    <div class="recipe-title-en">🍳 ${recipe.name_en}</div>
    <div class="recipe-title-ta">${recipe.name_ta}</div>
    <div class="recipe-oil">🛢️ ${recipe.oil}</div>
  </div>
  <div class="recipe-body">
    <div class="section-box">
      <div class="section-title">📋 Ingredients</div>
      <div class="section-text">${recipe.ingredients_en}</div>
    </div>
    <div class="section-box">
      <div class="section-title">👨‍🍳 Method</div>
      <div class="section-text">${recipe.method_en}</div>
    </div>
  </div>
  <div class="footer">
    <div class="footer-tag">🌿 Cook with pure cold-pressed oils · sathvam.in</div>
    <div class="footer-web">📞 +91 70921 77092</div>
  </div>
</div>
</body></html>`;
}

function buildWelcomeCardHtml() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Segoe UI',Arial,sans-serif; background:#f5f5f0; width:760px; }
  .card { background:#fff; border-radius:22px; overflow:hidden; box-shadow:0 6px 32px rgba(0,0,0,.15); margin:20px; }

  /* Green header with logo */
  .header { background:linear-gradient(135deg,#2d6a4f,#52b788); padding:28px 32px; display:flex; align-items:center; gap:20px; }
  .logo { width:72px; height:72px; border-radius:14px; object-fit:cover; border:3px solid rgba(255,255,255,.4); box-shadow:0 2px 12px rgba(0,0,0,.2); }
  .brand { color:#fff; }
  .brand-name { font-size:22px; font-weight:900; letter-spacing:.5px; }
  .brand-ta   { font-size:13px; opacity:.8; margin-top:3px; }
  .brand-sub  { font-size:11px; opacity:.65; margin-top:4px; letter-spacing:1px; text-transform:uppercase; }

  /* Gold launch banner */
  .launch-banner { background:linear-gradient(135deg,#f59e0b,#d97706); padding:14px 32px; display:flex; align-items:center; gap:14px; }
  .launch-emoji  { font-size:32px; }
  .launch-text   { color:#fff; }
  .launch-en { font-size:17px; font-weight:900; }
  .launch-ta { font-size:13px; opacity:.85; margin-top:2px; }

  /* Body */
  .body { padding:24px 32px 20px; }

  /* Message blocks */
  .msg-block { margin-bottom:20px; }
  .msg-label { font-size:10px; font-weight:800; letter-spacing:1.5px; text-transform:uppercase; color:#9ca3af; margin-bottom:6px; }
  .msg-en { font-size:14px; color:#1f2937; line-height:1.75; }
  .msg-ta { font-size:14px; color:#374151; line-height:1.85; margin-top:14px; padding-top:14px; border-top:1px dashed #e5e7eb; }

  /* Features grid */
  .features { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin:18px 0; }
  .feat { background:#f0fdf4; border:1px solid #bbf7d0; border-radius:10px; padding:10px 14px; display:flex; align-items:center; gap:8px; font-size:12px; color:#14532d; font-weight:700; }
  .feat-ta { background:#f0fdf4; border:1px solid #bbf7d0; border-radius:10px; padding:10px 14px; display:flex; align-items:center; gap:8px; font-size:12px; color:#14532d; font-weight:700; margin-top:4px; }

  /* Tagline */
  .tagline-block { background:linear-gradient(135deg,#2d6a4f,#52b788); border-radius:14px; padding:16px 22px; text-align:center; margin:18px 0 0; }
  .tagline-en { font-size:18px; font-weight:900; color:#fff; letter-spacing:.5px; }
  .tagline-ta { font-size:13px; color:rgba(255,255,255,.8); margin-top:4px; }

  /* Footer */
  .footer { background:#f9fafb; padding:14px 32px; display:flex; align-items:center; justify-content:space-between; border-top:1px solid #e5e7eb; }
  .footer-left { font-size:11px; color:#6b7280; }
  .footer-right { font-size:12px; color:#2d6a4f; font-weight:800; }
</style>
</head>
<body>
<div class="card">

  <div class="header">
    <img class="logo" src="${LOGO_URL}" />
    <div class="brand">
      <div class="brand-name">Sathvam Natural Foods</div>
      <div class="brand-ta">சத்வம் இயற்கை உணவுகள்</div>
      <div class="brand-sub">Pure · Natural · Cold-Pressed · Karur</div>
    </div>
  </div>

  <div class="launch-banner">
    <div class="launch-emoji">🎉</div>
    <div class="launch-text">
      <div class="launch-en">We've Relaunched — Welcome Back!</div>
      <div class="launch-ta">நாங்கள் புதுப்பிக்கப்பட்டோம் — மீண்டும் வரவேற்கிறோம்!</div>
    </div>
  </div>

  <div class="body">
    <div class="msg-block">
      <div class="msg-label">🇬🇧 English</div>
      <div class="msg-en">
        Dear valued customer, 🙏<br/><br/>
        This is <strong>Sathvam Natural Foods</strong> — your trusted source for pure,
        cold-pressed oils and quality traditional food products from Karur, Tamil Nadu.<br/><br/>
        We are thrilled to announce that we have <strong>completely redesigned our website</strong>
        with many new features and an even smoother experience. We warmly welcome you back!
      </div>
      <div class="features">
        <div class="feat">✅ Easy Order &amp; Tracking</div>
        <div class="feat">🎁 Loyalty Rewards</div>
        <div class="feat">🌟 Exclusive Offers</div>
        <div class="feat">🛡️ Secure Checkout</div>
      </div>
      <div class="msg-ta">
        அன்பான வாடிக்கையாளரே, 🙏<br/><br/>
        நாங்கள் <strong>சத்வம் இயற்கை உணவுகள்</strong> — கரூரிலிருந்து தூய்மையான
        குளிர்-அழுத்த எண்ணெய்கள் மற்றும் தரமான பாரம்பரிய உணவு பொருட்களுக்கான
        உங்கள் நம்பகமான மூலம்.<br/><br/>
        நாங்கள் எங்கள் <strong>இணையதளத்தை முற்றிலும் புதுப்பித்துள்ளோம்</strong> —
        புதிய வசதிகள் மற்றும் சிறந்த அனுபவத்துடன். மீண்டும் உங்களை வரவேற்கிறோம்!
      </div>
    </div>

    <div class="tagline-block">
      <div class="tagline-en">🌿 Your Way to a Healthier Life</div>
      <div class="tagline-ta">ஆரோக்கியமான வாழ்க்கைக்கான உங்கள் வழி 🌱</div>
    </div>
  </div>

  <div class="footer">
    <div class="footer-left">🌐 sathvam.in &nbsp;|&nbsp; Pure • Natural • Cold-Pressed</div>
    <div class="footer-right">📞 +91 70921 77092</div>
  </div>

</div>
</body></html>`;
}

async function renderCardJpeg(html) {
  const id      = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tmpHtml = path.join(os.tmpdir(), `bc-card-${id}.html`);
  const tmpPng  = path.join(os.tmpdir(), `bc-card-${id}.png`);
  const tmpJpg  = path.join(os.tmpdir(), `bc-card-${id}.jpg`);
  try {
    fs.writeFileSync(tmpHtml, html, 'utf8');
    execSync(`wkhtmltoimage --width 800 --quality 92 "${tmpHtml}" "${tmpPng}"`, { timeout: 20000, stdio: 'pipe' });
    execSync(`convert "${tmpPng}" -quality 88 "${tmpJpg}"`, { timeout: 10000, stdio: 'pipe' });
    return fs.readFileSync(tmpJpg);
  } finally {
    try { fs.unlinkSync(tmpHtml); } catch {}
    try { fs.unlinkSync(tmpPng); } catch {}
    try { fs.unlinkSync(tmpJpg); } catch {}
  }
}

async function uploadCardImage(buf, prefix) {
  const fileName = `broadcast-${prefix}-${Date.now()}.jpg`;
  const { error } = await supabase.storage
    .from('cards')
    .upload(fileName, buf, { contentType: 'image/jpeg', upsert: true });
  if (error) throw new Error(`Card upload failed: ${error.message}`);
  const { data } = supabase.storage.from('cards').getPublicUrl(fileName);
  return data.publicUrl;
}

// ── BotSailor send (text only OR image+caption) ──────────────────────────────
async function sendViaBotSailor(phone, message, imageUrl = null) {
  const token   = process.env.BOTSAILOR_API_TOKEN;
  const phoneId = process.env.BOTSAILOR_PHONE_NUMBER_ID || process.env.WA_PHONE_NUMBER_ID;
  if (!token || !phoneId) throw new Error('BotSailor not configured');
  const res = imageUrl
    ? await fetch('https://botsailor.com/api/v1/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiToken: token, phone_number_id: phoneId, phone_number: phone, type: 'image', url: imageUrl, message }),
      })
    : await fetch('https://botsailor.com/api/v1/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ apiToken: token, phone_number_id: phoneId, phone_number: phone, message }).toString(),
      });
  const d = await res.json();
  return d.status === '1' || d.status === 1;
}

async function broadcastToAllCustomers(message, imageUrl = null, broadcastMeta = {}, broadcastId = null) {
  const { data: customers } = await supabase
    .from('customers').select('id, name, phone').not('phone', 'is', null);

  if (!broadcastId) broadcastId = `bc_${Date.now()}`;
  const sentAt = new Date().toISOString();
  const logs   = [];
  const total  = (customers || []).length;

  // Initialise progress
  broadcastProgress.set(broadcastId, { sent: 0, failed: 0, skipped: 0, total, done: false });

  let sent = 0, failed = 0, skipped = 0;
  for (const cust of customers || []) {
    try {
      let raw = cust.phone;
      if (typeof raw === 'string' && raw.startsWith('ENC:')) {
        try { raw = decrypt(raw); } catch {
          skipped++;
          logs.push({ broadcast_id: broadcastId, customer_id: cust.id, customer_name: cust.name || null, phone: null, status: 'skipped', reason: 'decrypt_error', sent_at: sentAt, ...broadcastMeta });
          broadcastProgress.set(broadcastId, { sent, failed, skipped, total, done: false });
          continue;
        }
      }
      const digits = (raw || '').replace(/\D/g, '');
      if (digits.length < 10) {
        skipped++;
        logs.push({ broadcast_id: broadcastId, customer_id: cust.id, customer_name: cust.name || null, phone: digits || null, status: 'skipped', reason: 'invalid_phone', sent_at: sentAt, ...broadcastMeta });
        broadcastProgress.set(broadcastId, { sent, failed, skipped, total, done: false });
        continue;
      }
      const phone = digits.length === 10 ? `91${digits}` : digits;
      const ok = await sendViaBotSailor(phone, message, imageUrl);
      if (ok) { sent++; logs.push({ broadcast_id: broadcastId, customer_id: cust.id, customer_name: cust.name || null, phone, status: 'sent', sent_at: sentAt, ...broadcastMeta }); }
      else     { failed++; logs.push({ broadcast_id: broadcastId, customer_id: cust.id, customer_name: cust.name || null, phone, status: 'failed', reason: 'botsailor_error', sent_at: sentAt, ...broadcastMeta }); }
      broadcastProgress.set(broadcastId, { sent, failed, skipped, total, done: false });
      await new Promise(r => setTimeout(r, 333)); // 3/sec throttle
    } catch(e) {
      failed++;
      logs.push({ broadcast_id: broadcastId, customer_id: cust.id, customer_name: cust.name || null, phone: null, status: 'failed', reason: String(e.message || 'unknown'), sent_at: sentAt, ...broadcastMeta });
      broadcastProgress.set(broadcastId, { sent, failed, skipped, total, done: false });
    }
  }

  // Save logs in batches of 100
  for (let i = 0; i < logs.length; i += 100) {
    await supabase.from('broadcast_logs').insert(logs.slice(i, i + 100)).catch(() => {});
  }

  // Mark done
  broadcastProgress.set(broadcastId, { sent, failed, skipped, total, done: true });
  // Auto-clean after 1 hour
  setTimeout(() => broadcastProgress.delete(broadcastId), 3600000);

  return { sent, failed, skipped, total, broadcast_id: broadcastId };
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

function buildMorningMessage() {
  const kural = dailyItem(THIRUKKURALS);
  return {
    preview: `🌅 *காலை வணக்கம்! Good Morning!* ☀️\n\n📖 *திருக்குறள் #${kural.num}*\n\n*தமிழ்:*\n_${kural.tamil}_\n\n*English:*\n"${kural.english}"\n\n🌿 *Sathvam Natural Products*\nPure • Natural • Traditional\n_sathvam.in · +91 70921 77092_`,
    meta: { num: kural.num, tamil: kural.tamil, english: kural.english },
    cardHtml: buildKuralCardHtml(kural),
    cardPrefix: `kural-${kural.num}`,
  };
}

async function buildAfternoonMessage() {
  // Alternate: even days = recipe, odd days = blog
  const dayOfYear = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  const useRecipe = dayOfYear % 2 === 0;

  if (useRecipe) {
    const r = dailyItem(RECIPES, 3);
    const msg =
      `🍳 *இன்றைய சிறப்பு சமையல்!*\n*Recipe of the Day!* 🌿\n\n` +
      `*${r.name_en}*\n*${r.name_ta}*\n\n` +
      `🛢️ _Oil used: ${r.oil}_\n\n` +
      `📋 *Ingredients | தேவையானவை:*\n${r.ingredients_en}\n\n` +
      `👨‍🍳 *Method | செய்முறை:*\n${r.method_en}\n\n` +
      `🌿 Get Sathvam cold-pressed oils at *sathvam.in* · 📞 +91 70921 77092`;
    return { preview: msg, meta: { type: 'recipe', name: r.name_en }, cardHtml: buildRecipeCardHtml(r), cardPrefix: 'recipe' };
  } else {
    const { data: posts } = await supabase
      .from('blog_posts')
      .select('title, title_ta, content, slug')
      .eq('published', true)
      .order('published_at', { ascending: false })
      .limit(10);

    if (posts && posts.length > 0) {
      const post = dailyItem(posts, 5);
      const excerpt = (post.content || '').replace(/<[^>]+>/g, '').slice(0, 200).trim();
      const msg =
        `📰 *இன்றைய வலைப்பதிவு!*\n*Blog of the Day!* 📖\n\n` +
        `*${post.title || ''}*\n${post.title_ta ? `_${post.title_ta}_` : ''}\n\n` +
        `${excerpt}${excerpt.length >= 200 ? '…' : ''}\n\n` +
        `🔗 Read more: *sathvam.in/blog/${post.slug || ''}*\n\n` +
        `🌿 _Sathvam Natural Products · sathvam.in · +91 70921 77092_`;
      return { preview: msg, meta: { type: 'blog', title: post.title } };
    } else {
      const r = dailyItem(RECIPES, 7);
      const msg =
        `🍳 *இன்றைய சிறப்பு சமையல்!*\n*Recipe of the Day!* 🌿\n\n` +
        `*${r.name_en}*\n*${r.name_ta}*\n\n` +
        `🛢️ _Oil used: ${r.oil}_\n\n` +
        `👨‍🍳 *Method:*\n${r.method_en}\n\n` +
        `🌿 Get Sathvam cold-pressed oils at *sathvam.in* · 📞 +91 70921 77092`;
      return { preview: msg, meta: { type: 'recipe', name: r.name_en }, cardHtml: buildRecipeCardHtml(r), cardPrefix: 'recipe' };
    }
  }
}

function buildNightMessage() {
  const tip = dailyItem(HEALTH_TIPS, 2);
  const msg =
    `🌙 *இரவு வணக்கம்! Good Night!* ⭐\n\n` +
    `🌿 *இன்றைய ஆரோக்கிய குறிப்பு*\n*Today's Health Tip*\n\n` +
    `💡 *${tip.title}*\n\n` +
    `🇬🇧 ${tip.english}\n\n` +
    `🇮🇳 ${tip.tamil}\n\n` +
    `💤 நல்ல இரவு! Sleep well. 🌙\n🌿 _Sathvam Natural Products · sathvam.in · +91 70921 77092_`;
  return { preview: msg, meta: { title: tip.title }, cardHtml: buildHealthCardHtml(tip), cardPrefix: 'health' };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/broadcasts/today — all 3 broadcasts + their status
router.get('/today', auth, async (req, res) => {
  try {
    const types   = ['morning', 'afternoon', 'night'];
    const keys    = types.map(settingsKey);
    const { data } = await supabase.from('settings').select('key,value').in('key', keys);
    const statusMap = {};
    for (const row of data || []) statusMap[row.key] = row.value;

    const morning   = buildMorningMessage();
    const afternoon = await buildAfternoonMessage();
    const night     = buildNightMessage();

    res.json({
      today: today(),
      morning:   { ...morning,   status: statusMap[settingsKey('morning')]   || null },
      afternoon: { ...afternoon, status: statusMap[settingsKey('afternoon')] || null },
      night:     { ...night,     status: statusMap[settingsKey('night')]     || null },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/broadcasts/progress/:broadcastId — real-time progress for a running broadcast
router.get('/progress/:broadcastId', auth, (req, res) => {
  const p = broadcastProgress.get(req.params.broadcastId);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

// POST /api/broadcasts/welcome/preview — send card preview to admin WA
router.post('/welcome/preview', auth, async (req, res) => {
  try {
    const adminPhone = (process.env.WA_NOTIFY_TO || '').replace(/\D/g, '');
    if (!adminPhone) return res.status(500).json({ error: 'WA_NOTIFY_TO not set' });

    const cardHtml = buildWelcomeCardHtml();
    let cardUrl = null;
    try {
      const buf = await renderCardJpeg(cardHtml);
      cardUrl   = await uploadCardImage(buf, 'welcome-relaunch');
    } catch (e) {
      console.error('Welcome card render error:', e.message);
    }

    await sendViaBotSailor(adminPhone, `👀 *PREVIEW — Welcome Re-launch Blast*\n\nReview and click "Broadcast Now" to send to all customers.\n\n---\n${WELCOME_MESSAGE}`, cardUrl);
    res.json({ ok: true, card_url: cardUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/broadcasts/welcome/broadcast — send to ALL customers (async, returns broadcastId immediately)
router.post('/welcome/broadcast', auth, async (req, res) => {
  const broadcastId = `bc_${Date.now()}`;
  broadcastProgress.set(broadcastId, { sent: 0, failed: 0, skipped: 0, total: 0, done: false, preparing: true });
  res.json({ ok: true, broadcast_id: broadcastId, status: 'started' });

  // Run broadcast in background
  (async () => {
    try {
      const cardHtml = buildWelcomeCardHtml();
      let cardUrl = null;
      try {
        const buf = await renderCardJpeg(cardHtml);
        cardUrl   = await uploadCardImage(buf, 'welcome-relaunch');
      } catch (e) {
        console.error('Welcome card render error:', e.message);
      }
      const p = broadcastProgress.get(broadcastId) || {};
      broadcastProgress.set(broadcastId, { ...p, preparing: false });

      const result = await broadcastToAllCustomers(WELCOME_MESSAGE, cardUrl, {
        message_type: 'welcome',
        triggered_by: req.user?.name || 'admin',
      }, broadcastId);

      await supabase.from('settings').upsert({
        key:   'welcome_blast',
        value: { sent_at: new Date().toISOString(), card_url: cardUrl, ...result, triggered_by: req.user?.name },
      });
    } catch (e) {
      console.error('Welcome broadcast error:', e.message);
      const p = broadcastProgress.get(broadcastId) || {};
      broadcastProgress.set(broadcastId, { ...p, done: true, error: e.message });
    }
  })();
});

// GET /api/broadcasts/welcome/status — has the welcome blast been sent?
router.get('/welcome/status', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'welcome_blast').single();
    res.json(data?.value || null);
  } catch (e) {
    res.json(null);
  }
});

// POST /api/broadcasts/:type/send-preview — send preview to admin WA
router.post('/:type/send-preview', auth, async (req, res) => {
  const { type } = req.params;
  if (!['morning', 'afternoon', 'night'].includes(type))
    return res.status(400).json({ error: 'Invalid type' });

  try {
    const adminNo = (process.env.THIRUKURAL_APPROVAL_PHONE || process.env.WA_NOTIFY_TO || '').replace(/\D/g, '');
    if (!adminNo) return res.status(400).json({ error: 'THIRUKURAL_APPROVAL_PHONE not set' });

    let content;
    if (type === 'morning')   content = buildMorningMessage();
    if (type === 'afternoon') content = await buildAfternoonMessage();
    if (type === 'night')     content = buildNightMessage();

    // Generate card image for preview
    let cardUrl = null;
    if (content.cardHtml) {
      try {
        const buf = await renderCardJpeg(content.cardHtml);
        cardUrl   = await uploadCardImage(buf, content.cardPrefix || type);
      } catch (imgErr) {
        console.error('Preview card image error:', imgErr.message);
      }
    }

    const labels = { morning: 'MORNING', afternoon: 'AFTERNOON', night: 'NIGHT' };
    const approvalCaption =
      `🔔 *Approval Request — ${type.toUpperCase()} Broadcast*\n\n` +
      `${content.preview}\n\n` +
      `---\nReply *${labels[type]}* to broadcast to all customers.\nReply *SKIP ${labels[type]}* to cancel.`;

    // Send card image + approval text to admin (or text-only if no card)
    const ok = await sendViaBotSailor(adminNo, approvalCaption, cardUrl || undefined);
    if (!ok) return res.status(400).json({ error: 'Failed to send preview to admin WhatsApp' });

    await supabase.from('settings').upsert({
      key:   settingsKey(type),
      value: { ...content, cardHtml: undefined, status: 'pending', preview_sent_at: new Date().toISOString(), card_url: cardUrl },
    });

    res.json({ success: true, type });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/broadcasts/:type/broadcast — direct broadcast from UI (async, returns broadcastId immediately)
router.post('/:type/broadcast', auth, async (req, res) => {
  const { type } = req.params;
  if (!['morning', 'afternoon', 'night'].includes(type))
    return res.status(400).json({ error: 'Invalid type' });

  const broadcastId = `bc_${Date.now()}`;
  broadcastProgress.set(broadcastId, { sent: 0, failed: 0, skipped: 0, total: 0, done: false, preparing: true });
  res.json({ success: true, type, broadcast_id: broadcastId, status: 'started' });

  // Run broadcast in background
  (async () => {
    try {
      let content;
      if (type === 'morning')   content = buildMorningMessage();
      if (type === 'afternoon') content = await buildAfternoonMessage();
      if (type === 'night')     content = buildNightMessage();

      // Generate card image if this broadcast type has one
      let cardUrl = null;
      if (content.cardHtml) {
        try {
          const buf = await renderCardJpeg(content.cardHtml);
          cardUrl   = await uploadCardImage(buf, content.cardPrefix || type);
        } catch (imgErr) {
          console.error('Broadcast card image error:', imgErr.message);
        }
      }

      const p = broadcastProgress.get(broadcastId) || {};
      broadcastProgress.set(broadcastId, { ...p, preparing: false });

      const result = await broadcastToAllCustomers(content.preview, cardUrl, { message_type: type, triggered_by: req.user?.name || 'admin' }, broadcastId);

      await supabase.from('settings').upsert({
        key:   settingsKey(type),
        value: { ...content, cardHtml: undefined, status: 'broadcast', broadcast_at: new Date().toISOString(), card_url: cardUrl, ...result },
      });
    } catch (e) {
      console.error(`Broadcast ${type} error:`, e.message);
      const p = broadcastProgress.get(broadcastId) || {};
      broadcastProgress.set(broadcastId, { ...p, done: true, error: e.message });
    }
  })();
});

// POST /api/broadcasts/:type/approve-from-wa — called by botsailor webhook
router.post('/:type/approve-from-wa', async (req, res) => {
  const { type } = req.params;
  if (!['morning', 'afternoon', 'night'].includes(type))
    return res.json({ ok: false, reason: 'Invalid type' });

  try {
    const { data: pending } = await supabase
      .from('settings').select('value').eq('key', settingsKey(type)).single();

    if (!pending?.value || pending.value.status !== 'pending')
      return res.json({ ok: false, reason: `No pending ${type} broadcast for today` });

    // Re-generate card (fresh build from today's content)
    let content;
    if (type === 'morning')   content = buildMorningMessage();
    if (type === 'afternoon') content = await buildAfternoonMessage();
    if (type === 'night')     content = buildNightMessage();

    let cardUrl = null;
    if (content.cardHtml) {
      try {
        const buf = await renderCardJpeg(content.cardHtml);
        cardUrl   = await uploadCardImage(buf, content.cardPrefix || type);
      } catch (imgErr) {
        console.error('Approve card image error:', imgErr.message);
      }
    }

    const message = content.preview;
    const result  = await broadcastToAllCustomers(message, cardUrl, { message_type: type, triggered_by: 'wa_approve' });

    await supabase.from('settings').upsert({
      key:   settingsKey(type),
      value: { ...pending.value, status: 'broadcast', broadcast_at: new Date().toISOString(), card_url: cardUrl, ...result },
    });

    res.json({ ok: true, type, card_url: cardUrl, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/broadcasts/delivery-logs?broadcast_id=bc_xxx&page=1&limit=100
router.get('/delivery-logs', auth, async (req, res) => {
  try {
    const { broadcast_id, status, page = 1, limit = 200 } = req.query;
    const from = (parseInt(page) - 1) * parseInt(limit);
    const to   = from + parseInt(limit) - 1;

    let q = supabase.from('broadcast_logs').select('*', { count: 'exact' }).order('sent_at', { ascending: false }).range(from, to);
    if (broadcast_id) q = q.eq('broadcast_id', broadcast_id);
    if (status)       q = q.eq('status', status);

    const { data, error, count } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ logs: data || [], total: count || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/broadcasts/delivery-summary — grouped totals per broadcast
router.get('/delivery-summary', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('broadcast_logs')
      .select('broadcast_id, message_type, triggered_by, sent_at, status')
      .order('sent_at', { ascending: false })
      .limit(2000);
    if (error) return res.status(500).json({ error: error.message });

    // Group by broadcast_id
    const groups = {};
    for (const row of data || []) {
      if (!groups[row.broadcast_id]) {
        groups[row.broadcast_id] = { broadcast_id: row.broadcast_id, message_type: row.message_type, triggered_by: row.triggered_by, sent_at: row.sent_at, sent: 0, failed: 0, skipped: 0 };
      }
      if (row.status === 'sent')    groups[row.broadcast_id].sent++;
      if (row.status === 'failed')  groups[row.broadcast_id].failed++;
      if (row.status === 'skipped') groups[row.broadcast_id].skipped++;
    }
    res.json({ broadcasts: Object.values(groups).slice(0, 100) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WELCOME / RE-LAUNCH BLAST
// ─────────────────────────────────────────────────────────────────────────────

const WELCOME_MESSAGE = `🌿 *வணக்கம்! Namaste!* 🙏

நாங்கள் *சத்வம் இயற்கை உணவுகள் (Sathvam Natural Foods)* — கரூரிலிருந்து தரமான குளிர்-அழுத்த எண்ணெய்கள் மற்றும் இயற்கை உணவு பொருட்கள் வழங்கும் உங்கள் நம்பகமான நண்பர்கள்.

---

🎉 *பெரிய செய்தி! Big News!*

நாங்கள் எங்கள் *இணையதளத்தை முற்றிலும் புதுப்பித்துள்ளோம்!*
We have completely *redesigned our website* with exciting new features!

✅ எளிதான ஆர்டர் & கண்காணிப்பு | Easy ordering & tracking
🎁 விசுவாச வெகுமதி திட்டம் | Loyalty rewards program
🌟 சிறப்பு உறுப்பினர் சலுகைகள் | Exclusive member offers
🛡️ பாதுகாப்பான பணம் செலுத்தல் | Secure checkout

---

மீண்டும் உங்களை வரவேற்கிறோம்! 🌱
*We warmly welcome you back!*

உங்கள் ஆரோக்கியமான வாழ்க்கைக்கான வழி — *சத்வம்* 🌿
_Your Way to a Healthier Life — *Sathvam*_

🌐 *sathvam.in*
📞 +91 70921 77092`;

module.exports = router;
