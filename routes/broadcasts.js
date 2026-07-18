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
const { uploadFile } = require('../config/storage');
const { auth }       = require('../middleware/auth');
const { decrypt }    = require('../config/crypto');
const { sendText: gaSendText, sendFile: gaSendFile, isAutomationDisabled } = require('../lib/greenapi');

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
    ingredients_ta: "சமைத்த சாதம், 3 மேசை கரண்டி சத்துவம் நல்லெண்ணெய், கடுகு, உளுந்து, கறிவேப்பிலை, உலர் சிவப்பு மிளகாய், பெருங்காயம், வறுத்த எள், உப்பு",
    method_en: "Heat sesame oil, splutter mustard seeds, urad dal, curry leaves & red chilli. Add asafoetida. Mix into cooked rice with roasted sesame seeds & salt. Serve warm.",
    method_ta: "நல்லெண்ணெயை சூடாக்கி, கடுகு, உளுந்து, கறிவேப்பிலை, மிளகாய் தாளிக்கவும். பெருங்காயம் சேர்க்கவும். சமைத்த சாதத்துடன் வறுத்த எள் மற்றும் உப்பு கலக்கவும். சூடாக பரிமாறவும்.",
    oil: "Sesame Oil | நல்லெண்ணெய்"
  },
  {
    name_en: "Groundnut Oil Brinjal Curry (Kathirikkai Kulambu)",
    name_ta: "கடலை எண்ணெய் கத்திரிக்காய் குழம்பு",
    ingredients_en: "Brinjal, 2 tbsp Sathvam groundnut oil, onion, tomato, tamarind, sambar powder, turmeric, mustard, curry leaves, salt",
    ingredients_ta: "கத்திரிக்காய், 2 மேசை கரண்டி சத்துவம் கடலை எண்ணெய், வெங்காயம், தக்காளி, புளி, சாம்பார் பொடி, மஞ்சள், கடுகு, கறிவேப்பிலை, உப்பு",
    method_en: "Heat groundnut oil, add mustard & curry leaves. Sauté onion, tomato till soft. Add brinjal, sambar powder, turmeric, tamarind water & salt. Simmer 15 mins till thick.",
    method_ta: "கடலை எண்ணெயை சூடாக்கி கடுகு, கறிவேப்பிலை தாளிக்கவும். வெங்காயம், தக்காளி வதக்கவும். கத்திரிக்காய், சாம்பார் பொடி, மஞ்சள், புளி தண்ணீர், உப்பு சேர்க்கவும். 15 நிமிடம் கொதிக்க விடவும்.",
    oil: "Groundnut Oil | கடலை எண்ணெய்"
  },
  {
    name_en: "Coconut Oil Pongal (Traditional Kerala Style)",
    name_ta: "தேங்காய் எண்ணெய் பொங்கல்",
    ingredients_en: "Raw rice, moong dal, 2 tbsp Sathvam coconut oil, cumin, pepper, ginger, cashews, ghee, turmeric, salt",
    ingredients_ta: "பச்சரிசி, பாசிப்பருப்பு, 2 மேசை கரண்டி சத்துவம் தேங்காய் எண்ணெய், சீரகம், மிளகு, இஞ்சி, முந்திரி, நெய், மஞ்சள், உப்பு",
    method_en: "Cook rice and dal together with turmeric. Heat coconut oil, fry cashews, add cumin, pepper, ginger. Mix into pongal with ghee & salt. Aromatic and nourishing!",
    method_ta: "அரிசி மற்றும் பருப்பை மஞ்சளுடன் சமைக்கவும். தேங்காய் எண்ணெயில் முந்திரி, சீரகம், மிளகு, இஞ்சி வதக்கவும். பொங்கலில் நெய் மற்றும் உப்புடன் கலக்கவும்.",
    oil: "Coconut Oil | தேங்காய் எண்ணெய்"
  },
  {
    name_en: "Mustard Oil Aloo Paratha (North Indian Classic)",
    name_ta: "கடுகு எண்ணெய் உருளைக்கிழங்கு பராத்தா",
    ingredients_en: "Whole wheat flour, boiled potatoes, Sathvam mustard oil, cumin, coriander, green chilli, garam masala, salt, coriander leaves",
    ingredients_ta: "கோதுமை மாவு, வேகவைத்த உருளை, சத்துவம் கடுகு எண்ணெய், சீரகம், கொத்தமல்லி, பச்சை மிளகாய், கரம் மசாலா, உப்பு, கொத்தமல்லி இலை",
    method_en: "Make stuffing with mashed potato, spices & coriander. Stuff into wheat dough balls, roll flat. Cook on tawa with mustard oil till golden. The oil gives authentic flavour!",
    method_ta: "உருளை, மசாலா, கொத்தமல்லி சேர்த்து அரைக்கவும். கோதுமை மாவில் நிரப்பி தட்டையாக இடவும். தவாவில் கடுகு எண்ணெய் விட்டு நல்ல சிவப்பு வரும்வரை சுடவும்.",
    oil: "Mustard Oil | கடுகு எண்ணெய்"
  },
  {
    name_en: "Sesame Oil Murukku (Traditional Diwali Snack)",
    name_ta: "நல்லெண்ணெய் முறுக்கு",
    ingredients_en: "Rice flour, urad dal flour, Sathvam sesame oil (for dough & frying), cumin, sesame seeds, asafoetida, butter, salt, water",
    ingredients_ta: "அரிசி மாவு, உளுந்து மாவு, சத்துவம் நல்லெண்ணெய், சீரகம், எள், பெருங்காயம், வெண்ணெய், உப்பு, தண்ணீர்",
    method_en: "Mix flours with sesame seeds, cumin, asafoetida, butter & hot sesame oil. Add water to make stiff dough. Press through murukku press into hot oil. Fry till crisp & golden.",
    method_ta: "மாவுகளை எள், சீரகம், பெருங்காயம், வெண்ணெய் மற்றும் சூடான நல்லெண்ணெயுடன் கலக்கவும். தண்ணீர் சேர்த்து மாவை பிசையவும். சூடான எண்ணெயில் முறுக்கு அச்சில் பிழியவும்.",
    oil: "Sesame Oil | நல்லெண்ணெய்"
  },
  {
    name_en: "Groundnut Oil Tomato Rasam",
    name_ta: "கடலை எண்ணெய் தக்காளி ரசம்",
    ingredients_en: "Tomatoes, tamarind, Sathvam groundnut oil, mustard, cumin, pepper, turmeric, rasam powder, garlic, curry leaves, coriander, asafoetida, salt",
    ingredients_ta: "தக்காளி, புளி, சத்துவம் கடலை எண்ணெய், கடுகு, சீரகம், மிளகு, மஞ்சள், ரசப்பொடி, பூண்டு, கறிவேப்பிலை, கொத்தமல்லி, பெருங்காயம், உப்பு",
    method_en: "Boil tomatoes with tamarind water, turmeric, rasam powder. Heat groundnut oil, splutter mustard, cumin, pepper, garlic, curry leaves. Add to rasam, garnish with coriander.",
    method_ta: "தக்காளியை புளி தண்ணீர், மஞ்சள், ரசப்பொடியுடன் கொதிக்க வைக்கவும். கடலை எண்ணெயில் கடுகு, சீரகம், மிளகு, பூண்டு, கறிவேப்பிலை தாளிக்கவும். ரசத்தில் சேர்க்கவும்.",
    oil: "Groundnut Oil | கடலை எண்ணெய்"
  },
  {
    name_en: "Coconut Oil Thenga Chutney (Kerala Style)",
    name_ta: "தேங்காய் எண்ணெய் தேங்காய் சட்னி",
    ingredients_en: "Fresh coconut, Sathvam coconut oil, green chilli, ginger, roasted chana dal, salt; Tempering: mustard, curry leaves, dry red chilli",
    ingredients_ta: "தேங்காய், சத்துவம் தேங்காய் எண்ணெய், பச்சை மிளகாய், இஞ்சி, வறுத்த கடலை, உப்பு; தாளிக்க: கடுகு, கறிவேப்பிலை, சிவப்பு மிளகாய்",
    method_en: "Grind coconut, chilli, ginger, chana dal & salt. Heat coconut oil, splutter mustard, curry leaves & red chilli. Pour over chutney. Serve with idli or dosa!",
    method_ta: "தேங்காய், மிளகாய், இஞ்சி, கடலை, உப்பு அரைக்கவும். தேங்காய் எண்ணெயில் கடுகு, கறிவேப்பிலை, சிவப்பு மிளகாய் தாளிக்கவும். சட்னியின் மேல் ஊற்றவும். இட்லி அல்லது தோசையுடன் பரிமாறவும்!",
    oil: "Coconut Oil | தேங்காய் எண்ணெய்"
  },
  {
    name_en: "Sesame Oil Kara Kuzhambu",
    name_ta: "நல்லெண்ணெய் கார குழம்பு",
    ingredients_en: "Small onions, garlic, Sathvam sesame oil, tamarind, chilli powder, coriander powder, turmeric, mustard, curry leaves, salt",
    ingredients_ta: "சின்ன வெங்காயம், பூண்டு, சத்துவம் நல்லெண்ணெய், புளி, மிளகாய் பொடி, கொத்தமல்லி பொடி, மஞ்சள், கடுகு, கறிவேப்பிலை, உப்பு",
    method_en: "Heat sesame oil generously, sauté onions & garlic till brown. Add all powders, cook 2 mins. Add tamarind water & salt, simmer 20 mins till thick. The sesame oil is essential!",
    method_ta: "நல்லெண்ணெயில் வெங்காயம் மற்றும் பூண்டை பழுப்பு நிறமாகும் வரை வதக்கவும். அனைத்து பொடிகளையும் சேர்க்கவும். புளி தண்ணீர் மற்றும் உப்பு சேர்த்து 20 நிமிடம் கொதிக்க விடவும்.",
    oil: "Sesame Oil | நல்லெண்ணெய்"
  },
  {
    name_en: "Groundnut Oil Peanut Chutney",
    name_ta: "கடலை எண்ணெய் வேர்க்கடலை சட்னி",
    ingredients_en: "Roasted peanuts, Sathvam groundnut oil, red chilli, garlic, tamarind, onion, salt; Tempering: mustard, urad dal, curry leaves",
    ingredients_ta: "வறுத்த வேர்க்கடலை, சத்துவம் கடலை எண்ணெய், சிவப்பு மிளகாய், பூண்டு, புளி, வெங்காயம், உப்பு; தாளிக்க: கடுகு, உளுந்து, கறிவேப்பிலை",
    method_en: "Grind peanuts, chilli, garlic, tamarind, onion & salt with water. Heat groundnut oil, splutter mustard, urad dal & curry leaves. Add to chutney. Rich and nutty!",
    method_ta: "வேர்க்கடலை, மிளகாய், பூண்டு, புளி, வெங்காயம், உப்பு தண்ணீருடன் அரைக்கவும். கடலை எண்ணெயில் கடுகு, உளுந்து, கறிவேப்பிலை தாளிக்கவும். சட்னியில் சேர்க்கவும்.",
    oil: "Groundnut Oil | கடலை எண்ணெய்"
  },
  {
    name_en: "Coconut Oil Payasam (Festive Kheer)",
    name_ta: "தேங்காய் எண்ணெய் பாயசம்",
    ingredients_en: "Vermicelli or rice, coconut milk, Sathvam coconut oil, jaggery, cardamom, cashews, raisins, saffron",
    ingredients_ta: "சேமியா அல்லது அரிசி, தேங்காய் பால், சத்துவம் தேங்காய் எண்ணெய், வெல்லம், ஏலக்காய், முந்திரி, திராட்சை, குங்குமப்பூ",
    method_en: "Fry vermicelli in coconut oil till golden. Add coconut milk & jaggery, cook till thick. Add cardamom, saffron. Fry cashews & raisins in coconut oil, garnish. Divine!",
    method_ta: "சேமியாவை தேங்காய் எண்ணெயில் பொன்னிறமாக வறுக்கவும். தேங்காய் பால் மற்றும் வெல்லம் சேர்த்து காய்ச்சவும். ஏலக்காய், குங்குமப்பூ சேர்க்கவும். முந்திரி, திராட்சை வறுத்து அலங்கரிக்கவும்.",
    oil: "Coconut Oil | தேங்காய் எண்ணெய்"
  },
];

const KNOWLEDGE_TIPS = [
  // ── Oil Wisdom ──────────────────────────────────────────────────────────────
  {
    category: 'oil',
    title_en: 'Cold-Pressed vs Refined Oil — The Real Difference',
    title_ta: 'குளிர் அழுத்த எண்ணெய் vs பதப்படுத்தப்பட்ட எண்ணெய்',
    body_en: 'Cold-pressed oils are extracted at low temperatures (below 40°C), preserving all vitamins, antioxidants, and natural flavour. Refined oils are chemically bleached, deodorised and stripped of nutrients during high-heat processing. Your family deserves the real thing.',
    body_ta: 'குளிர் அழுத்த எண்ணெய்கள் குறைந்த வெப்பநிலையில் (40°C க்கும் குறைவாக) பிழியப்படுகின்றன, இதனால் அனைத்து வைட்டமின்களும் ஆன்டிஆக்சிடன்ட்களும் பாதுகாக்கப்படுகின்றன. பதப்படுத்தப்பட்ட எண்ணெய்கள் வேதியியல் செயல்முறைகள் மூலம் ஊட்டச்சத்துக்களை இழக்கின்றன.',
    tip_en: 'Switch to cold-pressed oil for just one month — you will notice the difference in taste and energy.',
    tip_ta: 'ஒரு மாதத்திற்கு குளிர் அழுத்த எண்ணெய் பயன்படுத்துங்கள் — சுவை மற்றும் ஆற்றலில் வித்தியாசம் தெரியும்.',
    emoji: '🛢️',
  },
  {
    category: 'oil',
    title_en: 'Sesame Oil — The Ayurvedic Elixir for 5000 Years',
    title_ta: 'நல்லெண்ணெய் — 5000 ஆண்டு ஆயுர்வேத அமிழ்தம்',
    body_en: 'Sesame oil (நல்லெண்ணெய்) is the cornerstone of Ayurvedic medicine. Rich in sesamol and sesamin antioxidants, it reduces inflammation, strengthens bones, and supports liver health. In Tamil culture, it has been used in cooking, massage, and rituals for millennia.',
    body_ta: 'நல்லெண்ணெய் ஆயுர்வேத மருத்துவத்தின் அடிப்படை. செசமோல் மற்றும் செசமின் என்ற சக்திவாய்ந்த ஆன்டிஆக்சிடன்ட்கள் நிரம்பியுள்ளன. வீக்கத்தை குறைக்கிறது, எலும்புகளை வலுப்படுத்துகிறது.',
    tip_en: 'Use sesame oil as your daily cooking oil for stir-fries and tempering — just one tablespoon provides daily antioxidant needs.',
    tip_ta: 'தினமும் சமையலில் ஒரு மேசை கரண்டி நல்லெண்ணெய் தாளிக்கவும் — நாளை ஆன்டிஆக்சிடன்ட் தேவை பூர்த்தியாகும்.',
    emoji: '🌿',
  },
  {
    category: 'oil',
    title_en: 'Groundnut Oil & Heart Health',
    title_ta: 'கடலை எண்ணெய் மற்றும் இதய ஆரோக்கியம்',
    body_en: 'Groundnut oil is rich in oleic acid (monounsaturated fat) and Vitamin E, which actively lower LDL cholesterol and raise HDL. Studies show regular use of cold-pressed groundnut oil reduces cardiovascular risk. It has a naturally high smoke point — perfect for Indian deep-frying.',
    body_ta: 'கடலை எண்ணெயில் ஒலிக் அமிலம் மற்றும் வைட்டமின் E நிரம்பியுள்ளன. இவை கெட்ட கொழுப்பை குறைத்து நல்ல கொழுப்பை அதிகரிக்கின்றன. இந்திய பொரித்த உணவுகளுக்கு இது சிறந்தது.',
    tip_en: 'For deep frying, groundnut oil is the healthiest traditional choice — it does not break down at frying temperatures.',
    tip_ta: 'பொரிக்கும்போது கடலை எண்ணெய் சிறந்த தேர்வு — அதிக வெப்பத்திலும் இது நிலையாக இருக்கும்.',
    emoji: '🥜',
  },
  {
    category: 'oil',
    title_en: 'Coconut Oil & Lauric Acid — Nature\'s Immunity Booster',
    title_ta: 'தேங்காய் எண்ணெய் மற்றும் லாரிக் அமிலம்',
    body_en: 'About 50% of coconut oil is lauric acid — a rare fatty acid found abundantly in mother\'s milk. Lauric acid is antiviral and antibacterial. It boosts HDL (good cholesterol), supports brain function, and gives the body quick energy. Always choose cold-pressed for full benefit.',
    body_ta: 'தேங்காய் எண்ணெயில் சுமார் 50% லாரிக் அமிலம் உள்ளது. இது அம்மா பாலில் மட்டுமே அதிகமாக காணப்படுகிறது. நோய் எதிர்ப்பு சக்தியை அதிகரிக்கிறது, மூளை செயல்பாட்டை மேம்படுத்துகிறது.',
    tip_en: 'Add one teaspoon of coconut oil to your morning coffee or warm milk — it gives sustained energy through the morning.',
    tip_ta: 'காலை காபி அல்லது பாலில் ஒரு டீஸ்பூன் தேங்காய் எண்ணெய் சேர்க்கவும் — நீடித்த ஆற்றல் கிடைக்கும்.',
    emoji: '🥥',
  },
  {
    category: 'oil',
    title_en: 'Oil Pulling — Ancient Detox for Oral Health',
    title_ta: 'எண்ணெய் வாய் கொப்பளிப்பு — வாய் ஆரோக்கியத்திற்கான பழங்கால சுத்திகரிப்பு',
    body_en: 'Oil pulling (kavala/gandush in Ayurveda) involves swishing sesame or coconut oil in the mouth for 15–20 minutes each morning. This ancient practice removes oral bacteria, whitens teeth, strengthens gums, and is said to improve overall health by reducing the toxic load on the body.',
    body_ta: 'காலையில் 15–20 நிமிடங்கள் நல்லெண்ணெய் அல்லது தேங்காய் எண்ணெயால் வாய் கொப்பளிப்பது வாயில் உள்ள தீங்கு விளைவிக்கும் பாக்டீரியாவை அகற்றுகிறது, பற்களை வெண்மையாக்குகிறது.',
    tip_en: 'Do oil pulling on an empty stomach every morning — spit into a bin (not the sink), then brush teeth normally.',
    tip_ta: 'காலை வெறும் வயிற்றில் எண்ணெய் கொப்பளிக்கவும் — குப்பைத் தொட்டியில் துப்பவும், பிறகு பல் துலக்கவும்.',
    emoji: '🦷',
  },
  {
    category: 'oil',
    title_en: 'Smoke Point — Why It Matters for Your Health',
    title_ta: 'புகை புள்ளி — உங்கள் ஆரோக்கியத்திற்கு ஏன் முக்கியம்',
    body_en: 'Every oil has a "smoke point" — the temperature at which it begins to degrade and release harmful free radicals. Cold-pressed groundnut oil (232°C) and coconut oil (177°C) are safe for Indian cooking. Never reuse oil after deep frying — it oxidises and creates toxic compounds.',
    body_ta: 'ஒவ்வொரு எண்ணெய்க்கும் ஒரு "புகை புள்ளி" உள்ளது — இதற்கு அப்பால் எண்ணெய் சிதைந்து தீங்கான கலவைகளை உருவாக்குகிறது. கடலை எண்ணெய் (232°C) இந்திய சமையலுக்கு மிகவும் பாதுகாப்பானது.',
    tip_en: 'Never reuse oil after deep frying. If you must, filter it and use only once more for light cooking.',
    tip_ta: 'பொரித்த எண்ணெயை மீண்டும் ஆழமான பொரிக்க பயன்படுத்தாதீர்கள். அதிகபட்சம் ஒரு முறை மட்டும் மீண்டும் பயன்படுத்தவும்.',
    emoji: '🔥',
  },
  {
    category: 'oil',
    title_en: 'Storing Oils Correctly — Preserve Nutrition',
    title_ta: 'எண்ணெய்களை சரியாக சேமித்தல்',
    body_en: 'Cold-pressed oils are sensitive to light, heat, and air because they retain natural antioxidants. Store in a dark glass or stainless steel container away from heat. Never store in plastic — chemicals leach into oil. Sesame oil lasts 1 year, groundnut oil 8–12 months, coconut oil 2 years when stored properly.',
    body_ta: 'குளிர் அழுத்த எண்ணெய்கள் வெளிச்சம், வெப்பம் மற்றும் காற்றினால் பாதிக்கப்படும். கருமையான கண்ணாடி அல்லது எஃகு பாத்திரத்தில் வெப்பத்திலிருந்து விலகி சேமிக்கவும். பிளாஸ்டிக்கில் ஒருபோதும் சேமிக்காதீர்கள்.',
    tip_en: 'Keep oils in a cool, dark cupboard. Once opened, consume within 3–4 months for best nutrition.',
    tip_ta: 'எண்ணெய்களை குளிர்ந்த, இருண்ட இடத்தில் வைக்கவும். திறந்த பிறகு 3–4 மாதங்களுக்குள் பயன்படுத்தவும்.',
    emoji: '🫙',
  },
  {
    category: 'oil',
    title_en: 'Abhyanga — Ayurvedic Oil Self-Massage',
    title_ta: 'அபியங்க — ஆயுர்வேத எண்ணெய் சுய மசாஜ்',
    body_en: 'Abhyanga is a traditional Ayurvedic practice of massaging warm sesame oil onto the entire body before bathing. It nourishes the skin, improves circulation, calms the nervous system, and helps with joint pain. Classical texts recommend it daily, especially in winter months.',
    body_ta: 'அபியங்க என்பது குளிக்கும் முன் உடல் முழுவதும் சூடான நல்லெண்ணெய் தடவி மசாஜ் செய்வது. இது தோலை பளபளப்பாக்குகிறது, ரத்த ஓட்டத்தை மேம்படுத்துகிறது, மூட்டு வலியை குறைக்கிறது.',
    tip_en: 'Warm sesame oil slightly and massage into skin for 10 minutes before showering — especially great for joint pain and dry skin.',
    tip_ta: 'நல்லெண்ணெயை சற்று சூடாக்கி குளிக்கும் 10 நிமிடங்கள் முன் தடவி மசாஜ் செய்யுங்கள் — மூட்டு வலிக்கும், வறண்ட தோலுக்கும் சிறந்தது.',
    emoji: '💆',
  },
  {
    category: 'oil',
    title_en: 'Mustard Oil — The Pungent Powerhouse',
    title_ta: 'கடுகு எண்ணெய் — கூர்மையான சக்தி',
    body_en: 'Mustard oil is rich in omega-3 fatty acids, glucosinolates, and erucic acid compounds that are antibacterial and antifungal. Used for centuries in North Indian and Bengali cuisine, it protects the heart, relieves muscle aches when used for massage, and has a very high smoke point of 250°C.',
    body_ta: 'கடுகு எண்ணெய் ஒமேகா-3 கொழுப்பு அமிலங்கள் மற்றும் நுண்ணுயிர் எதிர்ப்பு கலவைகளால் நிரம்பியுள்ளது. வட இந்திய சமையலில் நூற்றாண்டுகளாக பயன்படுத்தப்படுகிறது. 250°C வரை நிலையாக இருக்கிறது.',
    tip_en: 'Heat mustard oil to its smoke point briefly before cooking to reduce its pungency — this is the traditional North Indian technique.',
    tip_ta: 'சமைக்கும் முன் கடுகு எண்ணெயை புகை வரும் வரை சூடாக்கவும் — இது அதன் கடுமையை குறைக்கும், இது வட இந்திய மரபு.',
    emoji: '🌿',
  },
  {
    category: 'oil',
    title_en: 'Fat-Soluble Vitamins Need Healthy Fat to Work',
    title_ta: 'கொழுப்பில் கரையும் வைட்டமின்களுக்கு ஆரோக்கியமான கொழுப்பு அவசியம்',
    body_en: 'Vitamins A, D, E, and K are fat-soluble — they cannot be absorbed by your body without healthy fat. Eating salads and cooked vegetables without any oil means you are wasting much of their nutrition. Always add a drizzle of cold-pressed oil to get the full benefit.',
    body_ta: 'A, D, E, மற்றும் K வைட்டமின்கள் கொழுப்பில் மட்டுமே கரையும். எண்ணெய் இல்லாமல் காய்கறிகள் சாப்பிட்டால் அவற்றின் பெரும்பாலான ஊட்டச்சத்து வீணாகும்.',
    tip_en: 'Add one teaspoon of sesame or coconut oil to your vegetable dishes — it multiplies the nutrition you absorb.',
    tip_ta: 'காய்கறி உணவில் ஒரு டீஸ்பூன் நல்லெண்ணெய் அல்லது தேங்காய் எண்ணெய் சேர்க்கவும் — உறிஞ்சப்படும் ஊட்டச்சத்து பல மடங்கு அதிகரிக்கும்.',
    emoji: '🥗',
  },
  // ── Millet Power ─────────────────────────────────────────────────────────────
  {
    category: 'millet',
    title_en: 'Foxtail Millet (Thinai) vs White Rice',
    title_ta: 'தினை vs வெள்ளை அரிசி — ஒரு ஒப்பீடு',
    body_en: 'Foxtail millet (தினை) has 3x more fibre, double the protein, and far more iron than white rice — yet its Glycemic Index is 50, versus rice at 72. This means thinai releases energy slowly, keeping blood sugar stable. It was the staple grain of ancient Tamil civilisation before polished rice took over.',
    body_ta: 'தினையில் வெள்ளை அரிசியை விட 3 மடங்கு அதிக நார்ச்சத்து, இரண்டு மடங்கு புரதம் உள்ளது. இதன் கிளைசெமிக் இண்டெக்ஸ் 50 மட்டுமே — அரிசியின் 72 ஐ விட மிகக் குறைவு. செரிமானம் மெதுவாக நடக்கும், ரத்த சர்க்கரை நிலையாக இருக்கும்.',
    tip_en: 'Replace one rice meal per day with thinai rice or thinai pongal — your blood sugar and digestion will thank you within a week.',
    tip_ta: 'ஒரு நாளில் ஒரு வேளை சாப்பாட்டை தினை சாதம் அல்லது தினை பொங்கலாக மாற்றுங்கள் — ஒரு வாரத்தில் வித்தியாசம் தெரியும்.',
    emoji: '🌾',
  },
  {
    category: 'millet',
    title_en: 'Ragi — More Calcium Than Milk',
    title_ta: 'கேழ்வரகு — பாலை விட அதிக கால்சியம்',
    body_en: '100g of ragi (finger millet/கேழ்வரகு) contains 344mg of calcium — more than the 120mg in 100g of milk. It is the best plant source of calcium for growing children, lactating mothers, and seniors at risk of osteoporosis. Ragi also contains all 8 essential amino acids, making it a complete protein grain.',
    body_ta: '100 கிராம் கேழ்வரகில் 344 மி.கி. கால்சியம் உள்ளது — 100 கிராம் பாலில் உள்ள 120 மி.கி. ஐ விட அதிகம். வளரும் குழந்தைகளுக்கும், தாய்ப்பால் கொடுக்கும் தாய்மார்களுக்கும் சிறந்தது.',
    tip_en: 'Make ragi porridge (கஞ்சி) with milk and jaggery for breakfast — it gives children strong bones and all-day energy.',
    tip_ta: 'கேழ்வரகு கஞ்சியை காலை உணவாக பாலும் வெல்லமும் சேர்த்து கொடுங்கள் — குழந்தைகளுக்கு வலிமையான எலும்புகளும் நாள் முழுவதும் ஆற்றலும் கிடைக்கும்.',
    emoji: '💪',
  },
  {
    category: 'millet',
    title_en: 'Kambu (Bajra/Pearl Millet) — The Summer Cooling Grain',
    title_ta: 'கம்பு — கோடை குளிர்ச்சி தானியம்',
    body_en: 'Kambu (pearl millet/கம்பு) has natural cooling properties and is high in magnesium, which relaxes blood vessels and lowers blood pressure. It is the traditional summer grain of Tamil Nadu — consumed as kambu koozh (a chilled porridge) to beat the heat. It also supports thyroid function.',
    body_ta: 'கம்பு இயற்கையான குளிர்ச்சி குணங்களை கொண்டுள்ளது. மக்னீசியம் நிரம்பியுள்ளது — இது ரத்த நாளங்களை தளர்த்தி ரத்த அழுத்தத்தை குறைக்கிறது. தமிழ்நாட்டின் பாரம்பரிய கோடை உணவான கம்பு கூழ் சூட்டை தணிக்கிறது.',
    tip_en: 'Drink kambu koozh (fermented pearl millet porridge) this summer — it cools the body and replenishes minerals lost through sweating.',
    tip_ta: 'இந்த கோடையில் கம்பு கூழ் குடிக்கவும் — உடலை குளிர்விக்கும், வியர்வையில் இழந்த தாதுக்களை நிரப்பும்.',
    emoji: '🌿',
  },
  {
    category: 'millet',
    title_en: 'Kodo Millet — The Diabetic\'s Best Friend',
    title_ta: 'வரகு — நீரிழிவு நோயாளிகளின் சிறந்த நண்பன்',
    body_en: 'Kodo millet (வரகு) has the lowest Glycemic Index (45) of all common grains. It is rich in polyphenols and phytic acid that slow sugar absorption and improve insulin sensitivity. Clinical studies have shown that regular kodo millet consumption significantly reduces HbA1c levels in Type 2 diabetes patients.',
    body_ta: 'வரகுவின் கிளைசெமிக் இண்டெக்ஸ் 45 — அனைத்து பொது தானியங்களிலும் மிகக் குறைவு. பாலிஃபீனால்கள் நிரம்பியுள்ளன, இவை சர்க்கரை உறிஞ்சுதலை குறைக்கின்றன. நீரிழிவு நோயாளிகளில் HbA1c அளவை கணிசமாக குறைக்கிறது.',
    tip_en: 'If you or a family member has diabetes, swap white rice for kodo millet rice at least 3 days a week.',
    tip_ta: 'உங்களுக்கு அல்லது உங்கள் குடும்பத்தினருக்கு நீரிழிவு இருந்தால், வாரம் மூன்று நாட்கள் வெள்ளை அரிசிக்கு பதில் வரகு சாதம் சாப்பிடுங்கள்.',
    emoji: '🌾',
  },
  {
    category: 'millet',
    title_en: 'Little Millet (Saamai) — The Gut Health Champion',
    title_ta: 'சாமை — குடல் ஆரோக்கியத்தின் வீரன்',
    body_en: 'Little millet (சாமை) is exceptionally high in resistant starch and prebiotic fibre that feeds beneficial gut bacteria. It promotes regularity, reduces bloating, and has been shown to lower colon cancer risk. It is the easiest millet for first-time switchers — the most similar in texture to rice.',
    body_ta: 'சாமையில் ஆரோக்கியமான குடல் பாக்டீரியாவை வளர்க்கும் நார்ச்சத்து மிகுந்துள்ளது. மலச்சிக்கல், வாய்வு தொல்லை குறைக்கிறது. அரிசி போன்ற அமைப்பு இருப்பதால் புதியவர்களுக்கு மாற்ற எளிதாக இருக்கும்.',
    tip_en: 'Start your millet journey with saamai (little millet) — cook it exactly like rice and serve with your regular curries.',
    tip_ta: 'சாமையில் இருந்து சிறுதானிய பயணத்தை தொடங்குங்கள் — அரிசி போல் சமைத்து உங்கள் வழக்கமான குழம்புகளுடன் சாப்பிடுங்கள்.',
    emoji: '🌾',
  },
  {
    category: 'millet',
    title_en: 'Millet Roti — Better Than Wheat Roti',
    title_ta: 'சிறுதானிய ரொட்டி — கோதுமை ரொட்டியை விட சிறந்தது',
    body_en: 'Jowar (cholam), bajra (kambu), and ragi rotis have far more fibre, iron, and minerals than wheat rotis. They are gluten-free, making them perfect for those with wheat sensitivity. In Tamil Nadu, kambu roti with onion chutney is a traditional breakfast that provides sustained energy all morning.',
    body_ta: 'சோளம், கம்பு மற்றும் கேழ்வரகு ரொட்டிகளில் கோதுமையை விட அதிக நார்ச்சத்து, இரும்பு மற்றும் தாதுக்கள் உள்ளன. இவை பசை இல்லாதவை. கம்பு ரொட்டியும் வெங்காய சட்னியும் தமிழ்நாட்டின் பாரம்பரிய காலை உணவு.',
    tip_en: 'Mix ragi or jowar flour with 20% wheat flour to start — this makes the dough easier to roll while boosting nutrition.',
    tip_ta: 'கேழ்வரகு அல்லது சோள மாவில் 20% கோதுமை மாவு கலக்கவும் — உருட்ட எளிதாக இருக்கும், ஊட்டச்சத்தும் அதிகமாகும்.',
    emoji: '🫓',
  },
  {
    category: 'millet',
    title_en: 'Millet Porridge for Babies — Traditional Wisdom',
    title_ta: 'சிறு குழந்தைகளுக்கு சிறுதானிய கஞ்சி — பாரம்பரிய அறிவு',
    body_en: 'Before commercial baby foods existed, Indian grandmothers fed babies ragi and foxtail millet porridge after 6 months. Ragi is still recommended by paediatricians for iron and calcium. It prevents anaemia, supports brain development, and builds strong bones — naturally, without additives.',
    body_ta: 'வணிக குழந்தை உணவுகள் வருவதற்கு முன், இந்திய பாட்டிமார்கள் ஆறு மாதத்திற்கு பிறகு கேழ்வரகு மற்றும் தினை கஞ்சி கொடுத்தனர். குழந்தை மருத்துவர்களால் இன்னும் பரிந்துரைக்கப்படுகிறது.',
    tip_en: 'For babies over 6 months: cook fine ragi flour with water, add breast milk or formula, a pinch of jaggery — no additives needed.',
    tip_ta: '6 மாதத்திற்கு மேல் உள்ள குழந்தைகளுக்கு: கேழ்வரகு மாவை தண்ணீரில் கொதிக்க வைத்து, தாய்ப்பால் அல்லது ஃபார்முலா, ஒரு சிட்டிகை வெல்லம் சேர்க்கவும்.',
    emoji: '👶',
  },
  {
    category: 'millet',
    title_en: 'Millets vs Wheat — The Full Picture',
    title_ta: 'சிறுதானியம் vs கோதுமை — முழு ஒப்பீடு',
    body_en: 'Millets are naturally gluten-free, have 3–5x more fibre than wheat, and higher levels of iron, magnesium, and B-vitamins. Unlike wheat, they were grown in India for 10,000 years without genetic modification. India\'s government is actively promoting millets — 2023 was declared the International Year of Millets.',
    body_ta: 'சிறுதானியங்கள் இயற்கையாகவே பசை இல்லாதவை, கோதுமையை விட 3–5 மடங்கு அதிக நார்ச்சத்து கொண்டவை. இரும்பு, மக்னீசியம், B வைட்டமின்கள் அதிகம். 10,000 ஆண்டுகளாக இந்தியாவில் வளர்க்கப்படுகின்றன. 2023 சர்வதேச சிறுதானிய ஆண்டாக அறிவிக்கப்பட்டது.',
    tip_en: 'Try replacing just breakfast with a millet dish 5 days a week — that is enough to see measurable health improvements.',
    tip_ta: 'வாரம் 5 நாட்கள் காலை உணவை மட்டும் சிறுதானிய உணவாக மாற்றுங்கள் — அளவிடத்தக்க ஆரோக்கிய மேம்பாடுகள் தெரியும்.',
    emoji: '🌾',
  },
  // ── Kitchen Secrets ───────────────────────────────────────────────────────
  {
    category: 'recipe',
    title_en: 'Traditional Lemon Rice with Sesame Oil',
    title_ta: 'பாரம்பரிய எலுமிச்சை சாதம் நல்லெண்ணெயுடன்',
    body_en: 'Authentic South Indian lemon rice uses cold-pressed sesame oil as the base — not sunflower or refined oil. The sesame oil\'s nuttiness complements the sourness of lemon perfectly, and the turmeric-sesame combination has potent anti-inflammatory synergy that Ayurveda has known about for centuries.',
    body_ta: 'உண்மையான தென்னிந்திய எலுமிச்சை சாதம் குளிர் அழுத்த நல்லெண்ணெயில் செய்யப்படுகிறது. நல்லெண்ணெயின் கொட்டை சுவை எலுமிச்சையின் புளிப்புடன் சிறப்பாக பொருந்துகிறது. மஞ்சள்-நல்லெண்ணெய் கலவை சக்திவாய்ந்த அழற்சி எதிர்ப்பு குணம் கொண்டது.',
    tip_en: 'Always add the lemon juice AFTER removing from heat — heat destroys Vitamin C. Mix into warm (not hot) rice.',
    tip_ta: 'தீயை அணைத்த பிறகே எலுமிச்சை சாறு சேர்க்கவும் — வெப்பம் வைட்டமின் C ஐ அழிக்கும். சூடான (கொதிக்காத) சாதத்தில் கலக்கவும்.',
    emoji: '🍋',
  },
  {
    category: 'recipe',
    title_en: 'Rasam — The Original Immune Booster',
    title_ta: 'ரசம் — மூல நோய் எதிர்ப்பு மருந்து',
    body_en: 'Traditional rasam is a powerhouse: black pepper (piperine) enhances curcumin absorption, tomato provides Vitamin C and lycopene, tamarind is antioxidant-rich, and garlic is antibacterial. Made with a groundnut oil tempering, rasam was the original "soup" prescribed by Tamil grandmothers for every cold and fever.',
    body_ta: 'பாரம்பரிய ரசம் ஒரு சக்தி மையம்: மிளகு (பைபரின்) மஞ்சள் உறிஞ்சுதலை அதிகரிக்கிறது, தக்காளி வைட்டமின் C கொடுக்கிறது, புளி ஆன்டிஆக்சிடன்ட் நிரம்பியது, பூண்டு நுண்ணுயிர் எதிர்ப்பு. தமிழ் பாட்டிமார்களின் சளி மருந்து இதுவே.',
    tip_en: 'Add a small piece of jaggery to rasam — it balances the sour-spicy taste and adds iron. This is the traditional way.',
    tip_ta: 'ரசத்தில் ஒரு சிறிய வெல்ல துண்டு சேர்க்கவும் — புளிப்பு-காரம் சமன் செய்யும், இரும்பு கிடைக்கும். இதுவே பாரம்பரிய முறை.',
    emoji: '🥣',
  },
  {
    category: 'recipe',
    title_en: 'Kootu with Coconut Oil — The Complete Meal',
    title_ta: 'தேங்காய் எண்ணெயில் கூட்டு — முழுமையான உணவு',
    body_en: 'Kootu (vegetable + lentil dish) made with coconut oil tempering is a nutritionally complete Tamil meal component. The combination of vegetable fibre, lentil protein, coconut\'s lauric acid, and aromatic spices creates a dish that was the everyday staple of healthy Tamil families for centuries. Simple, cheap, powerful.',
    body_ta: 'தேங்காய் எண்ணெயில் கூட்டு செய்வது ஊட்டச்சத்து நிரம்பிய தமிழ் உணவு. காய்கறி நார்ச்சத்து, பருப்பு புரதம், தேங்காயின் லாரிக் அமிலம் — இவை சேர்ந்து நூற்றாண்டுகளாக தமிழ் குடும்பங்களின் அன்றாட உணவாக இருந்தது.',
    tip_en: 'Use fresh grated coconut (not desiccated) and temper in coconut oil — this preserves all the nutrients and gives authentic taste.',
    tip_ta: 'சுக்காவை (காய்ந்த தேங்காய்) அல்ல, புதிய தேங்காய் துருவல் பயன்படுத்துங்கள், தேங்காய் எண்ணெயில் தாளிக்கவும் — ஊட்டச்சத்தும் சுவையும் அசலாக இருக்கும்.',
    emoji: '🥥',
  },
  {
    category: 'recipe',
    title_en: 'Ellu Sadham — Sesame Rice, Tamil Superfood',
    title_ta: 'எள்ளு சாதம் — தமிழ் சூப்பர் உணவு',
    body_en: 'Ellu sadham (sesame rice) is one of the naivedyam (offering) dishes of Tamil temples and is deeply nutritious. Roasted sesame seeds provide calcium, iron, and healthy fats, while sesame oil tempering adds antioxidants. This humble dish packs more nutrition than most modern health foods.',
    body_ta: 'எள்ளு சாதம் தமிழ் கோயில்களின் நைவேத்யம் (படைப்பு) உணவுகளில் ஒன்று. வறுத்த எள்ளில் கால்சியம், இரும்பு, ஆரோக்கியமான கொழுப்புகள் உள்ளன. நல்லெண்ணெய் தாளிப்பு ஆன்டிஆக்சிடன்ட்கள் சேர்க்கிறது.',
    tip_en: 'Dry roast sesame seeds until they pop and become golden before adding to rice — this releases maximum flavour and nutrition.',
    tip_ta: 'எள்ளை வறுக்கும்போது தாவும் வரை வறுக்கவும் — இது சுவையையும் ஊட்டச்சத்தையும் அதிகமாக வெளியிடும்.',
    emoji: '🍚',
  },
  {
    category: 'recipe',
    title_en: 'Kollu Rasam — Nature\'s Fat Burner',
    title_ta: 'கொள்ளு ரசம் — இயற்கையான கொழுப்பு எரிப்பான்',
    body_en: 'Horse gram (kollu/கொள்ளு) has been scientifically proven to inhibit fat cell formation, reduce LDL cholesterol, and help dissolve kidney stones. When made into rasam with pepper, garlic, and cumin in sesame oil, it becomes a powerful cleansing soup. Traditional women consumed it after childbirth for fast recovery.',
    body_ta: 'கொள்ளு கொழுப்பு உயிரணு உருவாவதை தடுக்கிறது, கெட்ட கொழுப்பை குறைக்கிறது, சிறுநீரக கற்களை கரைக்க உதவுகிறது என்று அறிவியல் நிரூபிக்கிறது. நல்லெண்ணெயில் மிளகு, பூண்டு, சீரகத்துடன் செய்யும் கொள்ளு ரசம் சக்திவாய்ந்த சுத்திகரிப்பு சூப்.',
    tip_en: 'Soak horse gram overnight, boil well, extract the water for rasam. Eat the cooked gram as a side dish — double the benefit.',
    tip_ta: 'கொள்ளுவை இரவு நனைத்து, நன்கு வேகவைத்து, தண்ணீரை ரசமாக செய்யுங்கள். வேகவைத்த கொள்ளுவை பக்க உணவாக சாப்பிடுங்கள் — இரட்டை நன்மை.',
    emoji: '🌿',
  },
  // ── Natural Living ────────────────────────────────────────────────────────
  {
    category: 'living',
    title_en: 'Empty Stomach Warm Water — Start Every Day Right',
    title_ta: 'வெறும் வயிற்றில் வெந்நீர் — ஒவ்வொரு நாளையும் சரியாக தொடங்குங்கள்',
    body_en: 'Drinking 2–3 glasses of warm water immediately after waking (before tea, coffee, or food) stimulates bowel movement, flushes kidneys, activates metabolism, and hydrates cells after 7–8 hours of sleep. This is a core Ayurvedic practice called "ushapan" and is recommended by modern gastroenterologists.',
    body_ta: 'எழுந்திரித்த உடனே (தேநீர், காபி, உணவுக்கு முன்) 2–3 கிளாஸ் வெந்நீர் குடிப்பது குடல் இயக்கத்தை தூண்டுகிறது, சிறுநீரகங்களை சுத்தப்படுத்துகிறது, வளர்சிதை மாற்றத்தை செயல்படுத்துகிறது. ஆயுர்வேதத்தில் "உஷாபன்" என்று அழைக்கப்படுகிறது.',
    tip_en: 'Keep a bottle of water by your bed the night before. When you wake, drink it warm (not ice cold). Do this for 21 days.',
    tip_ta: 'இரவு தூங்கும் முன் படுக்கை அருகே ஒரு பாட்டில் தண்ணீர் வையுங்கள். எழுந்திரிக்கும்போது வெந்நீராக (குளிர்ந்ததாக அல்ல) குடிக்கவும். 21 நாட்கள் தொடர்ந்து செய்யுங்கள்.',
    emoji: '💧',
  },
  {
    category: 'living',
    title_en: 'Sunlight & Vitamin D — The Free Medicine',
    title_ta: 'சூரிய வெளிச்சம் மற்றும் வைட்டமின் D — இலவச மருந்து',
    body_en: 'Over 70% of Indians are Vitamin D deficient despite living in one of the sunniest countries. Vitamin D is essential for calcium absorption (bone health), immune function, mood regulation, and preventing depression. Just 20–30 minutes of morning sun exposure on arms and face is enough for daily needs.',
    body_ta: 'உலகின் மிக அதிக வெயில் உள்ள நாடுகளில் ஒன்றாக இருந்தும் 70%க்கும் அதிகமான இந்தியர்களுக்கு வைட்டமின் D பற்றாக்குறை உள்ளது. இது கால்சியம் உறிஞ்சுதல், நோய் எதிர்ப்பு சக்தி, மனநிலை கட்டுப்பாட்டிற்கு அவசியம்.',
    tip_en: 'Sit in morning sunlight (6–9 AM) for 20 minutes with arms and face exposed — this is the only way to truly make Vitamin D.',
    tip_ta: 'காலை வெயிலில் (6–9 AM) கைகளும் முகமும் வெளியில் இருக்கும்படி 20 நிமிடங்கள் உட்காருங்கள் — வைட்டமின் D தயாரிக்க இதுவே உண்மையான வழி.',
    emoji: '☀️',
  },
  {
    category: 'living',
    title_en: 'Traditional Brass & Iron Cookware — Micronutrient Magic',
    title_ta: 'பாரம்பரிய பித்தளை மற்றும் இரும்பு பாத்திரங்கள்',
    body_en: 'Cooking in iron kadai naturally adds dietary iron to food — this was how traditional Indian families prevented anaemia for generations. Copper vessels for water storage add trace copper, which is antibacterial. Brass vessels add zinc. These traditional cookware provided micronutrients that modern Teflon pans strip away.',
    body_ta: 'இரும்பு கடாயில் சமைப்பது உணவில் இரும்பு சத்தை இயற்கையாக சேர்க்கிறது — இதனால் பாரம்பரிய இந்திய குடும்பங்களில் இரத்த சோகை இருக்கவில்லை. தாமிர பாத்திரத்தில் தண்ணீர் சேமித்தால் நுண்ணுயிர் எதிர்ப்பு குணம் கிடைக்கும்.',
    tip_en: 'Switch one cooking pan to iron and store drinking water in a copper pot overnight — simple steps with lasting health benefits.',
    tip_ta: 'ஒரு சமையல் பாத்திரத்தை இரும்பாக மாற்றுங்கள், குடிநீரை தாமிர பாத்திரத்தில் இரவு சேமிக்கவும் — நீடித்த ஆரோக்கிய நன்மைகளுக்கான எளிய படிகள்.',
    emoji: '🍳',
  },
  {
    category: 'living',
    title_en: 'Mindful Eating — Eat Only When Truly Hungry',
    title_ta: 'மனநிலை சாப்பாடு — உண்மையிலேயே பசிக்கும்போது மட்டுமே சாப்பிடுங்கள்',
    body_en: 'Thirukkural 943 says "Eat the right amount, after the previous meal is fully digested." Modern science calls this intuitive eating. Eating only when truly hungry (not by the clock, not out of boredom) dramatically reduces calorie intake, improves digestion, and prevents obesity, diabetes, and heart disease.',
    body_ta: 'திருக்குறள் 943: "அற்றது அறிந்து உண்க" — முந்தைய உணவு முழுமையாக செரித்த பிறகே சாப்பிடுங்கள். உண்மையான பசி வரும்போது மட்டுமே சாப்பிடுவது (கடிகாரம் பார்த்தோ, சலிப்பிலோ அல்ல) உடல் எடையை கட்டுக்குள் வைக்கும்.',
    tip_en: 'Before eating, ask yourself: "Am I truly hungry or just bored/stressed?" Wait for genuine stomach hunger before eating.',
    tip_ta: 'சாப்பிடுவதற்கு முன் உங்களை கேட்டுக்கொள்ளுங்கள்: "உண்மையிலேயே பசிக்கிறதா அல்லது சலிப்பு/மன அழுத்தமா?" உண்மையான வயிற்று பசி வரும் வரை காத்திருங்கள்.',
    emoji: '🍽️',
  },
  {
    category: 'living',
    title_en: 'No Plastic for Hot Food — A Non-Negotiable Rule',
    title_ta: 'சூடான உணவிற்கு பிளாஸ்டிக் வேண்டாம்',
    body_en: 'When hot food or liquids contact plastic containers, Bisphenol A (BPA) and phthalates leach into the food. These are endocrine disruptors linked to hormonal imbalance, early puberty in children, thyroid disorders, and cancer risk. Never microwave in plastic, never pour hot food into plastic containers, never use plastic water bottles for warm water.',
    body_ta: 'சூடான உணவு அல்லது திரவங்கள் பிளாஸ்டிக் பாத்திரங்களை தொடும்போது BPA மற்றும் ஃபைத்தேலேட்டுகள் உணவில் கலக்கின்றன. இவை ஹார்மோன் ஏற்றத்தாழ்வு, குழந்தைகளில் ஆரம்ப பருவமடைதல், தைராய்டு கோளாறுகளுடன் இணைக்கப்பட்டுள்ளன.',
    tip_en: 'Never pour hot food or liquids into plastic containers. Use steel, glass, or ceramic for all hot foods.',
    tip_ta: 'சூடான உணவை ஒருபோதும் பிளாஸ்டிக் பாத்திரத்தில் ஊற்றாதீர்கள். அனைத்து சூடான உணவுகளுக்கும் எஃகு, கண்ணாடி அல்லது மட்பாண்டம் பயன்படுத்துங்கள்.',
    emoji: '🚫',
  },
  {
    category: 'living',
    title_en: 'Traditional Sleep Patterns — Align with the Sun',
    title_ta: 'பாரம்பரிய தூக்க முறை — சூரியனுடன் ஒத்துப்போங்கள்',
    body_en: 'Our ancestors slept at sunset and rose at sunrise, aligning with circadian rhythms. Modern research confirms: sleeping before 10 PM and waking before 6 AM optimises melatonin production, cortisol regulation, and immune function. Even one hour of blue light (phones/TV) after 9 PM disrupts this cycle for up to 3 hours.',
    body_ta: 'நம் முன்னோர்கள் சூரிய அஸ்தமனத்தில் தூங்கி சூரிய உதயத்தில் எழுந்திருந்தனர். நவீன ஆராய்ச்சி உறுதிப்படுத்துகிறது: இரவு 10 மணிக்கு முன் தூங்கி காலை 6 மணிக்கு முன் எழுவது மெலடோனின் உற்பத்தியை மேம்படுத்துகிறது.',
    tip_en: 'Set a phone-free rule after 9:30 PM for 30 days — you will fall asleep faster and wake refreshed without an alarm.',
    tip_ta: 'இரவு 9:30 மணிக்கு பிறகு 30 நாட்கள் போன் இல்லாத விதி வையுங்கள் — அலாரம் இல்லாமலேயே வேகமாக தூங்கி புத்துணர்வுடன் எழுவீர்கள்.',
    emoji: '🌙',
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
      <div class="brand-sub">சத்துவம் இயற்கை பொருட்கள்</div>
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
    <div class="footer-web">🌐 sathvam.in · 📞 +91 70923 77092</div>
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
      <div class="brand-sub">சத்துவம் இயற்கை பொருட்கள்</div>
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
    <div class="footer-web">🌐 sathvam.in · 📞 +91 70923 77092</div>
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
      <div class="brand-sub">சத்துவம் இயற்கை பொருட்கள்</div>
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
    <div class="footer-web">📞 +91 70923 77092</div>
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
      <div class="brand-ta">சத்துவம் இயற்கை உணவுகள்</div>
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
        நாங்கள் <strong>சத்துவம் இயற்கை உணவுகள்</strong> — கரூரிலிருந்து தூய்மையான
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
    <div class="footer-right">📞 +91 70923 77092</div>
  </div>

</div>
</body></html>`;
}

async function renderCardJpeg(html) {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 792, height: 600, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    // Auto-fit height to content
    const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
    await page.setViewport({ width: 792, height: bodyHeight, deviceScaleFactor: 2 });
    const buf = await page.screenshot({ type: 'jpeg', quality: 90, fullPage: true });
    return buf;
  } finally {
    await browser.close();
  }
}

async function uploadCardImage(buf, prefix) {
  const fileName = `broadcast-${prefix}-${Date.now()}.jpg`;
  const url = await uploadFile('cards', fileName, buf, 'image/jpeg');
  return url;
}

// ── WhatsApp send (text only OR image+caption) ───────────────────────────────
// Green API caption limit is 1024 chars. If message is longer, send image first then text separately.
async function sendViaBotSailor(phone, message, imageUrl = null) {
  if (imageUrl) {
    if (message && message.length > 1024) {
      // Send image with short caption, then full text as follow-up
      await gaSendFile(phone, imageUrl, 'sathvam.jpg', '🌿 *Sathvam Natural Products*\n_sathvam.in_');
      return gaSendText(phone, message);
    }
    return gaSendFile(phone, imageUrl, 'sathvam.jpg', message);
  }
  return gaSendText(phone, message);
}

async function broadcastToAllCustomers(message, imageUrl = null, broadcastMeta = {}, broadcastId = null) {
  if (await isAutomationDisabled('scheduled_broadcasts')) { console.log('[broadcasts] Disabled via toggle'); return { sent: 0, failed: 0, skipped: 0 }; }
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
      else     { failed++; logs.push({ broadcast_id: broadcastId, customer_id: cust.id, customer_name: cust.name || null, phone, status: 'failed', reason: 'send_error', sent_at: sentAt, ...broadcastMeta }); }
      broadcastProgress.set(broadcastId, { sent, failed, skipped, total, done: false });
      await new Promise(r => setTimeout(r, 5000)); // 1 per 5s — anti-spam
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
    preview: `🌅 *காலை வணக்கம்! Good Morning!* ☀️\n\n📖 *திருக்குறள் #${kural.num}*\n\n*தமிழ்:*\n_${kural.tamil}_\n\n*English:*\n"${kural.english}"\n\n🌿 *Sathvam Natural Products*\nPure • Natural • Traditional\n📞 +91 70923 77092`,
    meta: { num: kural.num, tamil: kural.tamil, english: kural.english },
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
      `🌿 Sathvam Natural Products · 📞 +91 70923 77092`;
    return { preview: msg, meta: { type: 'recipe', name: r.name_en } };
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
        `🔗 Read more on our blog!\n\n` +
        `🌿 _Sathvam Natural Products · 📞 +91 70923 77092_`;
      return { preview: msg, meta: { type: 'blog', title: post.title } };
    } else {
      const r = dailyItem(RECIPES, 7);
      const msg =
        `🍳 *இன்றைய சிறப்பு சமையல்!*\n*Recipe of the Day!* 🌿\n\n` +
        `*${r.name_en}*\n*${r.name_ta}*\n\n` +
        `🛢️ _Oil used: ${r.oil}_\n\n` +
        `👨‍🍳 *Method:*\n${r.method_en}\n\n` +
        `🌿 Sathvam Natural Products · 📞 +91 70923 77092`;
      return { preview: msg, meta: { type: 'recipe', name: r.name_en } };
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
    `💤 நல்ல இரவு! Sleep well. 🌙\n🌿 _Sathvam Natural Products · 📞 +91 70923 77092_`;
  return { preview: msg, meta: { title: tip.title } };
}

function buildKnowledgeCardHtml(tip) {
  const catConfig = {
    oil:    { accent: '#C9541A', accent2: '#f59e0b', badge: '🛢️ Oil Wisdom', badgeTa: 'எண்ணெய் அறிவு',  bg: 'linear-gradient(145deg,#0a1f10 0%,#0f2820 45%,#1a3a10 100%)' },
    millet: { accent: '#16a34a', accent2: '#4ade80', badge: '🌾 Millet Power', badgeTa: 'சிறுதானிய சக்தி', bg: 'linear-gradient(145deg,#052e16 0%,#064e3b 50%,#0f3d1a 100%)' },
    recipe: { accent: '#b45309', accent2: '#fbbf24', badge: '🍳 Kitchen Secret', badgeTa: 'சமையல் ரகசியம்', bg: 'linear-gradient(145deg,#1c0b04 0%,#3b1506 50%,#1a0e02 100%)' },
    living: { accent: '#0891b2', accent2: '#67e8f9', badge: '🌱 Natural Living', badgeTa: 'இயற்கை வாழ்வு',  bg: 'linear-gradient(145deg,#0a1628 0%,#0c2340 50%,#0d1f35 100%)' },
  };
  const c = catConfig[tip.category] || catConfig.oil;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { width:760px; font-family:'Segoe UI',Arial,sans-serif; background:#0a1f10; }
.card { background:${c.bg}; border-radius:20px; overflow:hidden; margin:16px; box-shadow:0 8px 40px rgba(0,0,0,.6); }
.header { display:flex; align-items:center; justify-content:space-between; padding:16px 22px 14px; border-bottom:1px solid rgba(255,255,255,.08); }
.header-left { display:flex; align-items:center; gap:12px; }
.logo { width:44px; height:44px; border-radius:8px; object-fit:cover; border:1.5px solid ${c.accent}; }
.brand-name { color:#fff; font-size:15px; font-weight:800; }
.brand-sub  { color:rgba(255,255,255,.5); font-size:9px; letter-spacing:1.8px; text-transform:uppercase; margin-top:2px; }
.hub-badge { background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.15); color:rgba(255,255,255,.7); font-size:10px; font-weight:700; padding:4px 12px; border-radius:20px; letter-spacing:.8px; }
.cat-strip { background:${c.accent}; padding:8px 22px; display:flex; align-items:center; gap:8px; }
.cat-label { color:#fff; font-size:13px; font-weight:800; letter-spacing:.5px; }
.cat-label-ta { color:rgba(255,255,255,.75); font-size:11px; margin-left:6px; }
.body { padding:20px 24px 16px; }
.title-en { color:#fff; font-size:20px; font-weight:900; line-height:1.3; margin-bottom:6px; }
.title-ta { color:${c.accent2}; font-size:16px; font-weight:600; line-height:1.4; margin-bottom:16px; }
.divider { height:1px; background:linear-gradient(90deg,${c.accent},transparent); margin:0 0 14px; opacity:.4; }
.body-en { color:rgba(255,255,255,.88); font-size:13px; line-height:1.75; margin-bottom:10px; }
.body-ta { color:rgba(255,255,255,.65); font-size:12px; line-height:1.75; margin-bottom:16px; font-style:italic; }
.tip-box { background:rgba(255,255,255,.06); border-left:3px solid ${c.accent}; border-radius:0 10px 10px 0; padding:12px 16px; }
.tip-label { color:${c.accent2}; font-size:10px; font-weight:800; letter-spacing:1.5px; text-transform:uppercase; margin-bottom:5px; }
.tip-en { color:rgba(255,255,255,.9); font-size:12px; line-height:1.6; margin-bottom:4px; }
.tip-ta { color:rgba(255,255,255,.6); font-size:11px; line-height:1.6; font-style:italic; }
.footer { display:flex; justify-content:space-between; align-items:center; padding:11px 22px; background:rgba(0,0,0,.35); border-top:1px solid rgba(255,255,255,.06); }
.footer-tag { font-size:10px; color:${c.accent}; font-weight:700; letter-spacing:.5px; }
.footer-web { font-size:10px; color:rgba(255,255,255,.4); }
</style></head><body>
<div class="card">
  <div class="header">
    <div class="header-left">
      <img class="logo" src="${LOGO_URL}" />
      <div>
        <div class="brand-name">Sathvam Knowledge Hub</div>
        <div class="brand-sub">சத்துவம் அறிவு மூலை</div>
      </div>
    </div>
    <div class="hub-badge">📚 Daily Guide</div>
  </div>
  <div class="cat-strip">
    <span class="cat-label">${c.badge}</span><span class="cat-label-ta">${c.badgeTa}</span>
  </div>
  <div class="body">
    <div class="title-en">${tip.title_en}</div>
    <div class="title-ta">${tip.title_ta}</div>
    <div class="divider"></div>
    <div class="body-en">${tip.body_en}</div>
    <div class="body-ta">${tip.body_ta}</div>
    <div class="tip-box">
      <div class="tip-label">💡 Today's Tip · இன்றைய குறிப்பு</div>
      <div class="tip-en">${tip.tip_en}</div>
      <div class="tip-ta">${tip.tip_ta}</div>
    </div>
  </div>
  <div class="footer">
    <div class="footer-tag">Pure · Natural · Cold-Pressed</div>
    <div class="footer-web">🌐 sathvam.in · 📞 +91 70923 77092</div>
  </div>
</div>
</body></html>`;
}

function buildKnowledgeMessage() {
  const tip = dailyItem(KNOWLEDGE_TIPS);
  const catStyle = {
    oil:    { icon: '🛢️', dot: '🟠', label: 'Oil Wisdom',      labelTa: 'எண்ணெய் அறிவு' },
    millet: { icon: '🌾', dot: '🟢', label: 'Millet Power',     labelTa: 'சிறுதானிய சக்தி' },
    recipe: { icon: '🍳', dot: '🟡', label: 'Kitchen Secret',   labelTa: 'சமையல் ரகசியம்' },
    living: { icon: '🌱', dot: '🔵', label: 'Natural Living',   labelTa: 'இயற்கை வாழ்வு' },
  }[tip.category] || { icon: '🌿', dot: '🟢', label: 'Knowledge Hub', labelTa: 'அறிவு மூலை' };

  const msg =
    `╔═══════════════════════╗\n` +
    `   📚 *SATHVAM KNOWLEDGE HUB*\n` +
    `   _சத்துவம் அறிவு மூலை_ 🌿\n` +
    `╚═══════════════════════╝\n\n` +
    `${catStyle.dot}${catStyle.dot}${catStyle.dot} *${catStyle.icon} ${catStyle.label}* ${catStyle.dot}${catStyle.dot}${catStyle.dot}\n` +
    `          _${catStyle.labelTa}_\n\n` +
    `▶ *${tip.title_en}*\n` +
    `▷ _${tip.title_ta}_\n\n` +
    `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
    `🇬🇧 ${tip.body_en}\n\n` +
    `🇮🇳 _${tip.body_ta}_\n\n` +
    `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n` +
    `💡 *Today's Tip | இன்றைய குறிப்பு*\n\n` +
    `✅ ${tip.tip_en}\n` +
    `✅ _${tip.tip_ta}_\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🌿 *Sathvam Natural Products*\n` +
    `📞 +91 70923 77092`;

  return { preview: msg, meta: { category: tip.category, title: tip.title_en } };
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE KEY AUTH (for scheduled/cron callers)
// ─────────────────────────────────────────────────────────────────────────────
const SERVICE_KEY = process.env.SCHEDULER_SECRET || (process.env.SUPABASE_SERVICE_KEY || '').slice(-16);
function serviceAuth(req, res, next) {
  const key = req.headers['x-service-key'];
  if (SERVICE_KEY && key !== SERVICE_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/broadcasts/today — all 4 broadcasts + their status
router.get('/today', auth, async (req, res) => {
  try {
    const types   = ['morning', 'afternoon', 'night', 'knowledge'];
    const keys    = types.map(settingsKey);
    const { data } = await supabase.from('settings').select('key,value').in('key', keys);
    const statusMap = {};
    for (const row of data || []) statusMap[row.key] = row.value;

    const morning   = buildMorningMessage();
    const afternoon = await buildAfternoonMessage();
    const night     = buildNightMessage();
    const knowledge = buildKnowledgeMessage();

    res.json({
      today: today(),
      morning:   { ...morning,   status: statusMap[settingsKey('morning')]   || null },
      afternoon: { ...afternoon, status: statusMap[settingsKey('afternoon')] || null },
      night:     { ...night,     status: statusMap[settingsKey('night')]     || null },
      knowledge: { ...knowledge, status: statusMap[settingsKey('knowledge')] || null },
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
  if (!['morning', 'afternoon', 'night', 'knowledge'].includes(type))
    return res.status(400).json({ error: 'Invalid type' });

  try {
    const adminNos = (process.env.THIRUKURAL_APPROVAL_PHONE || process.env.WA_NOTIFY_TO || '')
      .split(',').map(n => n.trim().replace(/\D/g, '')).filter(n => n.length >= 10);
    if (!adminNos.length) return res.status(400).json({ error: 'THIRUKURAL_APPROVAL_PHONE not set' });

    let content;
    if (type === 'morning')   content = buildMorningMessage();
    if (type === 'afternoon') content = await buildAfternoonMessage();
    if (type === 'night')     content = buildNightMessage();
    if (type === 'knowledge') content = buildKnowledgeMessage();

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

    const labels = { morning: 'MORNING', afternoon: 'AFTERNOON', night: 'NIGHT', knowledge: 'KNOWLEDGE' };
    const approvalCaption =
      `🔔 *Approval Request — ${type.toUpperCase()} Broadcast*\n\n` +
      `${content.preview}\n\n` +
      `---\nReply *${labels[type]}* to broadcast to all customers.\nReply *SKIP ${labels[type]}* to cancel.`;

    // Send card image + approval text to each admin phone
    let ok = false;
    for (const adminNo of adminNos) {
      const r = await sendViaBotSailor(adminNo, approvalCaption, cardUrl || undefined);
      if (r) ok = true;
    }
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
  if (!['morning', 'afternoon', 'night', 'knowledge'].includes(type))
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
      if (type === 'knowledge') content = buildKnowledgeMessage();

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
  if (!['morning', 'afternoon', 'night', 'knowledge'].includes(type))
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
    if (type === 'knowledge') content = buildKnowledgeMessage();

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

நாங்கள் *சத்துவம் இயற்கை உணவுகள் (Sathvam Natural Foods)* — கரூரிலிருந்து தரமான குளிர்-அழுத்த எண்ணெய்கள் மற்றும் இயற்கை உணவு பொருட்கள் வழங்கும் உங்கள் நம்பகமான நண்பர்கள்.

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

உங்கள் ஆரோக்கியமான வாழ்க்கைக்கான வழி — *சத்துவம்* 🌿
_Your Way to a Healthier Life — *Sathvam*_

🌐 *sathvam.in*
📞 +91 70923 77092`;

// POST /api/broadcasts/knowledge/schedule-run — called by systemd timer (service key auth)
router.post('/knowledge/schedule-run', serviceAuth, async (req, res) => {
  const broadcastId = `bc_sched_${Date.now()}`;
  broadcastProgress.set(broadcastId, { sent: 0, failed: 0, skipped: 0, total: 0, done: false, preparing: true });
  res.json({ success: true, broadcast_id: broadcastId, status: 'started' });

  (async () => {
    try {
      const content = buildKnowledgeMessage();
      const p = broadcastProgress.get(broadcastId) || {};
      broadcastProgress.set(broadcastId, { ...p, preparing: false });
      const result = await broadcastToAllCustomers(content.preview, null, { message_type: 'knowledge', triggered_by: 'scheduler' }, broadcastId);
      await supabase.from('settings').upsert({
        key:   settingsKey('knowledge'),
        value: { ...content, status: 'broadcast', broadcast_at: new Date().toISOString(), ...result },
      });
      console.log(`[Knowledge Hub] Scheduled broadcast done: ${JSON.stringify(result)}`);
    } catch (e) {
      console.error('[Knowledge Hub] Scheduled broadcast error:', e.message);
      const p = broadcastProgress.get(broadcastId) || {};
      broadcastProgress.set(broadcastId, { ...p, done: true, error: e.message });
    }
  })();
});

module.exports = router;
