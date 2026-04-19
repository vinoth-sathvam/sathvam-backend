/**
 * Thirukural Daily WhatsApp Broadcast
 *
 * Flow A — Admin panel approval:
 *   GET  /api/thirukural/today          → today's kural + pending status
 *   POST /api/thirukural/send-preview   → send kural to admin WhatsApp for approval
 *   POST /api/thirukural/broadcast      → admin approves from UI → send to all customers
 *
 * Flow B — WhatsApp reply approval:
 *   Admin receives kural on WA → replies "APPROVE" → botsailor webhook calls
 *   POST /api/thirukural/approve-from-wa (internal, called by botsailor.js)
 */

const express  = require('express');
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');
const { decrypt } = require('../config/crypto');

const router = express.Router();

// ── Thirukkural data (same set as push-agent.js) ──────────────────────────────
const THIRUKKURALS = [
  { num:1,   tamil:"அகர முதல எழுத்தெல்லாம் ஆதி\nபகவன் முதற்றே உலகு.",         english:"As 'A' is the first of all letters, so the Primal Deity stands first in the world." },
  { num:2,   tamil:"கற்றதனால் ஆய பயனென்கொல் வாலறிவன்\nநற்றாள் தொழாஅர் எனின்.", english:"What is the use of all learning if one does not bow at the feet of the Pure-One?" },
  { num:4,   tamil:"வேண்டுதல் வேண்டாமை இலானடி சேர்ந்தார்க்கு\nயாண்டும் இடும்பை இல.", english:"Those who seek the feet of He who is free of desire and aversion shall never suffer." },
  { num:11,  tamil:"வான்நின்று உலகம் வழங்கி வருதலால்\nதான்அமிழ்தம் என்றுணரற் பாற்று.",   english:"Rain is the elixir of life — it sustains the entire world and all that live upon it." },
  { num:12,  tamil:"துப்பார்க்குத் துப்பாய துப்பாக்கித் துப்பார்க்குத்\nதுப்பாய தூஉம் மழை.", english:"Rain gives us food, gives us water, and then gives us rain again — rain is the foundation of life." },
  { num:14,  tamil:"ஏரின் உழாஅர் உழவர் புயல்என்னும்\nவாரி வளங்குன்றிடின்.",              english:"Farmers will not even till the soil if the rains that nurture growth cease to fall." },
  { num:24,  tamil:"உலகத்தோடு ஒட்ட ஒழுகல் பலகற்றும்\nகல்லார் அறிவிலா தார்.",           english:"Those who have not learned to live in harmony with the world are unlearned, despite all their learning." },
  { num:40,  tamil:"அன்பிலார் எல்லாம் தமக்குரியர் அன்புடையார்\nஎன்பும் உரியர் பிறர்க்கு.", english:"The loveless live only for themselves; those full of love give even their bones to others." },
  { num:50,  tamil:"நன்றாகும் ஆக்கம் பெரிதெனினும் சான்றோர்க்கு\nஒன்றாகும் ஒட்டார் செயல்.", english:"Even great gain is nothing to the virtuous if it comes through the deeds of the wicked." },
  { num:61,  tamil:"வாய்மை எனப்படுவது யாதெனின் யாதொன்றும்\nதீமை இலாத சொலல்.",         english:"Truth is speaking words that are absolutely free from harm to anyone." },
  { num:100, tamil:"பத்தும் பொது எனும் பொட்டு; அறிந்தக்கால்\nகத்தும் பறை இல்.",          english:"Learn virtue, for the wise who know its worth need proclaim it no further." },
  { num:121, tamil:"ஆர்வமொடு ஈதல் அறனெனும் ஆர்வமொடு\nஈதல் அறனெனும் ஆர்வமொடு ஈதல்.", english:"To give with joy is the true virtue — giving with enthusiasm is charity." },
  { num:151, tamil:"வெள்ளத்து அனைய மலர்நீட்டம் மாந்தர்தம்\nஉள்ளத்து அனையது உயர்வு.",   english:"As the lotus rises above the water that sustains it, a person's greatness rises with their soul." },
  { num:176, tamil:"நகையும் உவகையும் கொல்லும் சினத்தின்\nபகையும் உளவோ பிற.",            english:"Anger destroys joy and happiness — is there any greater enemy than rage?" },
  { num:191, tamil:"மனத்தான்ஆம் மாந்தர்க்கு உணர்ச்சி இனத்தான்ஆம்\nவேறுபாடு உடைய செயல்.", english:"People are distinguished by the thoughts of their minds and the deeds that flow from them." },
  { num:231, tamil:"தன்ஊன் பெருக்கற்கு தான்பிறர்க்கு உண்ணாமை\nென்ஊன் பெருக்கக் கொல்.", english:"Can one who kills another creature for the growth of their own body be said to have compassion?" },
  { num:241, tamil:"கல்வி கரையில கற்பவர் நாள்சில\nமல்லல் உலகின் நிலை.",               english:"Knowledge is boundless; the days of a learner are few — this is the condition of our vast world." },
  { num:261, tamil:"உழுதுண்டு வாழ்வாரே வாழ்வார்மற் றெல்லாம்\nதொழுதுண்டு பின்செல்பவர்.", english:"Those who live by the labour of farming truly live; all others merely follow behind begging." },
  { num:262, tamil:"உழுவார் உலகத்தார்க்கு ஆணிஆம் மற்றை\nத்தொழுவா ரெல்லாம் தொழவே.",    english:"Farmers are the linchpin of the world — all other professions exist because farmers feed them." },
  { num:321, tamil:"கொல்லான் புலாலை மறுத்தானைக் கைகூப்பி\nஎல்லா உயிரும் தொழும்.",       english:"All living beings worship with clasped hands the one who renounces killing and meat-eating." },
  { num:331, tamil:"நன்றிக்கு வித்தாகும் நல்லொழுக்கம் தீயொழுக்கம்\nஏன்றும் இடும்பை தரும்.", english:"Good conduct is the seed of all good fortune; bad conduct brings sorrow forever." },
  { num:371, tamil:"அன்பும் அறனும் உடையார்க்கு எஞ்சுமோ\nவன்பும் வதுவையும் நீங்கி.",     english:"Those with love and virtue — what can hardship and sorrow do to them?" },
  { num:391, tamil:"சொல்லுக சொல்லை பிறிதோர் சொல்\nசொல்லாது சொல்லும் பயன் இல்.",      english:"Speak only words that bring benefit; there is no point in speaking otherwise." },
  { num:441, tamil:"நிலையும் திருவும் நிலவாதே செல்வம்\nதலையாய பண்புடையார்க்கு.",        english:"Wealth and high status are unstable — only virtue that sits at the crown endures." },
  { num:461, tamil:"உரன் என்னும் தோட்டியால் ஓட்டப் படுமே\nதிரன் என்னும் யானை பிடிக்கும்.", english:"The elephant of desire is guided by the goad of wisdom — let wisdom steer you always." },
  { num:471, tamil:"அருள்சேர்ந்த நெஞ்சினார்க்கு இல்லை இருள்சேர்ந்த\nவினைப்பாட்டின் தன்பட்ட கோடு.", english:"Those whose hearts are filled with compassion need not fear the darkness of harmful deeds." },
  { num:491, tamil:"ஒல்லும் வகையான் அறவினை ஓவாதே\nசெல்லும்வாய் எல்லாம் செயல்.",      english:"In every way possible, without rest, do righteous deeds wherever the path leads you." },
  { num:595, tamil:"ஆர்வமொடு ஈதல் அறம் என்ப ஆர்வமின்\nஈதல் ஈட்டமும் ஆகா.",             english:"Giving with enthusiasm is virtue; giving without joy is neither charity nor investment." },
  { num:610, tamil:"கெடுவல்யான் என்றே கிளர்ந்து எழுவார்\nதொடுவான் தொடுத்தல் அரிது.",    english:"Those who rise up thinking 'I may fall!' and act despite fear — they are truly hard to stop." },
  { num:631, tamil:"உடம்புடைமை கை கொள்ளின் உட்கு அரிதாகும்\nகடன்பட்டோர் கண் அன்ன செயல்.", english:"Health is wealth — protect it as diligently as a debtor guards what is entrusted to them." },
  { num:671, tamil:"அரிது அரிது மானிடராய்ப் பிறத்தல் அரிது அதனினும்\nகுரிது கீழ்ஈனான் பிறத்தல்.", english:"It is rare to be born human; rarer still to be born into a life of goodness and virtue." },
  { num:731, tamil:"அன்பு எனும் தாயினும் நல்லள்; தண்ணார்\nதன்பால் நிற்பவர்க்கு.",         english:"Nature — cool and nourishing — is kinder even than a loving mother to those who dwell in her." },
  { num:801, tamil:"வலிமையும் உடைமையும் கல்விமான்களுக்குஆகுமோ\nதலைமை இலார்க்கும் அவை.",  english:"Strength and wealth become burdens to those without wisdom — they are blessings only for the learned." },
  { num:841, tamil:"கடல்ஓடா கால்வல் நெடுந்தேர் கடல்ஓடும்\nதிண்ணிய ஒரு தோழன் இல்.",     english:"Even the sturdiest chariot cannot sail the sea; without true friendship, life's journey is incomplete." },
  { num:901, tamil:"தக்கார் தகவிலர் என்பது அவரவர்\nதக்கன செய்தல் வழக்கு.",             english:"Whether one is worthy or unworthy is revealed only by what they actually do." },
  { num:941, tamil:"கூழுண்டு நீர்குடித்துக் கூடிப் பரிவற்றால்\nவாழ்ந்தான் எனல் ஆகாதோ?",  english:"If one eats simple food, drinks pure water, and lives without strife — is that not a life well lived?" },
  { num:1041,tamil:"இன்னா செய்தவரை இன்னா செய்தல் அவரவர்\nதன்னாட்டின் நீங்கிவிட் டேன்.", english:"I have left the territory of revenge — repaying harm with harm is not the path I walk." },
  { num:1062,tamil:"மருந்தென வேண்டாவாம் யாக்கைக்கு அருந்தியது\nஅற்றது போற்றி உணின்.",    english:"No medicine is needed for the body if one eats only after the previous meal is fully digested." },
  { num:1063,tamil:"அற்றால் அளவறிந்து உண்க அது உடம்பு\nபெற்றான் நெடிதுய்க்கும் ஆறு.",   english:"Eat only when hungry, and eat in the right measure — this is the way to preserve health for long." },
  { num:1091,tamil:"உள்ளுவ தெல்லாம் உயர்வுள்ளல் மற்றது\nதள்ளினும் தள்ளாமை நீர்த்து.",   english:"Always think of high goals; even if they elude you, the striving itself ennobles the mind." },
  { num:1093,tamil:"துன்பம் துடைத்துத் துணிவு கொள்; துன்பந்\nதுன்பம் எனில் துன்பமில்லை.",   english:"Wipe away sorrow and take courage; if you treat sorrow as just sorrow, it ceases to be sorrow." },
  { num:1102,tamil:"ஊக்கமது கைகொள்ளில் உள்ளது இல்லை\nசாக்காடு சால உணல்.",             english:"With determination, there is nothing impossible to achieve — even death holds no terror." },
  { num:1151,tamil:"ஊரவர் கண்ணோட்டம் உள்ளது அறிவுடையார்\nதேரவர் கண்ணோட்டம் பார்க்கும்.",  english:"The truly wise look for the goodwill of others; they know the world moves by grace and goodness." },
  { num:1231,tamil:"ஆகுல மன்ன அழிவு இல்; தழிவு ஒன்றோ\nதாகுல மன்னதாம்.",               english:"Anxiety destroys no enemy — it only destroys oneself. Calm courage conquers all." },
  { num:1330,tamil:"கற்புடைய கற்றவர் நாற்பொருள் காண்பார்\nநல்குரவு என்னும் நரகு.",        english:"Poverty is a hell — the learned with virtue endure it through the four noble virtues." },
];

// ── Daily rotation (same seed as push-agent) ─────────────────────────────────
function todaysKural() {
  const now  = new Date();
  const seed = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
  return THIRUKKURALS[seed % THIRUKKURALS.length];
}

// ── Settings key for today's pending kural ────────────────────────────────────
function pendingKey() {
  return `thirukural_pending_${new Date().toISOString().slice(0, 10)}`;
}

// ── BotSailor send helper ─────────────────────────────────────────────────────
async function sendWA(phone, message) {
  const token   = process.env.BOTSAILOR_API_TOKEN;
  const phoneId = process.env.BOTSAILOR_PHONE_NUMBER_ID || process.env.WA_PHONE_NUMBER_ID;
  if (!token || !phoneId) throw new Error('BotSailor not configured');
  const params = new URLSearchParams({ apiToken: token, phone_number_id: phoneId, phone_number: phone, message });
  const res    = await fetch('https://botsailor.com/api/v1/whatsapp/send', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
  });
  return res.json();
}

// ── Build WA message for a kural ──────────────────────────────────────────────
function kuralMessage(kural) {
  return (
    `🌅 *திருக்குறள் #${kural.num} — இன்றைய ஞானம்*\n\n` +
    `📖 *Tamil:*\n_${kural.tamil}_\n\n` +
    `💡 *English:*\n${kural.english}\n\n` +
    `🌿 _Sathvam Natural Products_\n_sathvam.in_`
  );
}

// ── GET /api/thirukural/today ──────────────────────────────────────────────────
router.get('/today', auth, async (req, res) => {
  try {
    const kural = todaysKural();
    const today = new Date().toISOString().slice(0, 10);

    const { data: pending } = await supabase
      .from('settings').select('value').eq('key', pendingKey()).single();

    res.json({ kural, today, pending: pending?.value || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/thirukural/send-preview ─────────────────────────────────────────
// Sends today's kural to admin WhatsApp for approval
router.post('/send-preview', auth, async (req, res) => {
  try {
    const kural    = todaysKural();
    const adminNo  = (process.env.THIRUKURAL_APPROVAL_PHONE || process.env.WA_NOTIFY_TO || '').replace(/\D/g, '');
    if (!adminNo) return res.status(400).json({ error: 'THIRUKURAL_APPROVAL_PHONE not set in .env' });

    const preview =
      `🔔 *Thirukkural Approval Request*\n\n` +
      kuralMessage(kural) +
      `\n\n---\nReply *APPROVE* to broadcast this to all customers.\nReply *SKIP* to cancel today's broadcast.`;

    const r = await sendWA(adminNo, preview);
    if (r.status !== '1' && r.status !== 1)
      return res.status(400).json({ error: r.message || 'Failed to send to admin WA' });

    // Store pending state
    await supabase.from('settings').upsert({
      key:   pendingKey(),
      value: { kural, status: 'pending', preview_sent_at: new Date().toISOString(), broadcast_at: null, sent_count: 0 },
    });

    res.json({ success: true, kural });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/thirukural/broadcast ────────────────────────────────────────────
// Called from UI (admin clicked Approve & Broadcast) OR from botsailor webhook
router.post('/broadcast', auth, async (req, res) => {
  try {
    const { kural: customKural } = req.body;
    const kural = customKural || todaysKural();

    const message = kuralMessage(kural);

    // Fetch all customers with phone numbers
    const { data: customers, error } = await supabase
      .from('customers')
      .select('id, phone, name')
      .not('phone', 'is', null);

    if (error) throw new Error(error.message);

    let sent = 0, failed = 0, skipped = 0;
    const token   = process.env.BOTSAILOR_API_TOKEN;
    const phoneId = process.env.BOTSAILOR_PHONE_NUMBER_ID || process.env.WA_PHONE_NUMBER_ID;

    for (const cust of customers || []) {
      try {
        let rawPhone = cust.phone;
        // Decrypt if encrypted
        if (typeof rawPhone === 'string' && rawPhone.startsWith('ENC:')) {
          try { rawPhone = decrypt(rawPhone); } catch { skipped++; continue; }
        }
        const digits = (rawPhone || '').replace(/\D/g, '');
        if (digits.length < 10) { skipped++; continue; }
        const phone = digits.length === 10 ? `91${digits}` : digits;

        const params = new URLSearchParams({ apiToken: token, phone_number_id: phoneId, phone_number: phone, message });
        const r = await fetch('https://botsailor.com/api/v1/whatsapp/send', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
        });
        const d = await r.json();
        if (d.status === '1' || d.status === 1) sent++;
        else failed++;

        // Throttle — 3 messages per second to avoid rate limits
        await new Promise(ok => setTimeout(ok, 333));
      } catch { failed++; }
    }

    // Update pending state
    await supabase.from('settings').upsert({
      key:   pendingKey(),
      value: { kural, status: 'broadcast', broadcast_at: new Date().toISOString(), sent_count: sent, failed_count: failed },
    });

    res.json({ success: true, sent, failed, skipped, total: (customers || []).length });
  } catch (e) {
    console.error('Kural broadcast error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/thirukural/approve-from-wa ─────────────────────────────────────
// Called internally by botsailor.js when admin replies APPROVE on WhatsApp
router.post('/approve-from-wa', async (req, res) => {
  try {
    const { data: pending } = await supabase
      .from('settings').select('value').eq('key', pendingKey()).single();

    if (!pending?.value || pending.value.status !== 'pending') {
      return res.json({ ok: false, reason: 'No pending kural for today' });
    }

    const kural   = pending.value.kural;
    const message = kuralMessage(kural);
    const token   = process.env.BOTSAILOR_API_TOKEN;
    const phoneId = process.env.BOTSAILOR_PHONE_NUMBER_ID || process.env.WA_PHONE_NUMBER_ID;

    const { data: customers } = await supabase
      .from('customers').select('id, phone').not('phone', 'is', null);

    let sent = 0, failed = 0, skipped = 0;
    for (const cust of customers || []) {
      try {
        let rawPhone = cust.phone;
        if (typeof rawPhone === 'string' && rawPhone.startsWith('ENC:')) {
          try { rawPhone = decrypt(rawPhone); } catch { skipped++; continue; }
        }
        const digits = (rawPhone || '').replace(/\D/g, '');
        if (digits.length < 10) { skipped++; continue; }
        const phone = digits.length === 10 ? `91${digits}` : digits;

        const params = new URLSearchParams({ apiToken: token, phone_number_id: phoneId, phone_number: phone, message });
        const r = await fetch('https://botsailor.com/api/v1/whatsapp/send', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
        });
        const d = await r.json();
        if (d.status === '1' || d.status === 1) sent++;
        else failed++;
        await new Promise(ok => setTimeout(ok, 333));
      } catch { failed++; }
    }

    await supabase.from('settings').upsert({
      key:   pendingKey(),
      value: { kural, status: 'broadcast', broadcast_at: new Date().toISOString(), sent_count: sent, failed_count: failed },
    });

    res.json({ ok: true, sent, failed, skipped });
  } catch (e) {
    console.error('approve-from-wa error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, todaysKural, pendingKey };
