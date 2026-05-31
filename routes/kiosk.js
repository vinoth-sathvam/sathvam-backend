const express    = require('express');
const router     = express.Router();
const crypto     = require('crypto');
const QRCode     = require('qrcode');
const cron       = require('node-cron');
const { RekognitionClient, CreateCollectionCommand, IndexFacesCommand,
        SearchFacesByImageCommand, DeleteFacesCommand } = require('@aws-sdk/client-rekognition');
const supabase   = require('../config/supabase');
const { auth, requireRole } = require('../middleware/auth');

const COLLECTION_ID = 'sathvam-employees';
const MATCH_THRESHOLD = 90; // % confidence required

// ── AWS Rekognition client ────────────────────────────────────────────────────
const rekognition = new RekognitionClient({
  region: process.env.AWS_REGION || 'ap-south-1',
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function ensureCollection() {
  try {
    await rekognition.send(new CreateCollectionCommand({ CollectionId: COLLECTION_ID }));
  } catch (e) {
    if (!e.name?.includes('ResourceAlreadyExists')) throw e;
  }
}

// ── IST helpers ───────────────────────────────────────────────────────────────
function getIST() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return {
    date: ist.toISOString().substring(0, 10),
    time: ist.toISOString().substring(11, 19),
    mmdd: ist.toISOString().substring(5, 10), // MM-DD for birthday
  };
}

// ── Shift config cache (refreshed every 5 min) ────────────────────────────────
let _shiftCfg    = null;
let _shiftCfgAt  = 0;
const DEFAULT_SHIFT = {
  late_after:     '09:30',
  overtime_after: '18:00',
  early_before:   '17:00',
};

async function getShiftConfig() {
  if (_shiftCfg && Date.now() - _shiftCfgAt < 5 * 60 * 1000) return _shiftCfg;
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'kiosk_shift_config').single();
    _shiftCfg = { ...DEFAULT_SHIFT, ...(data?.value || {}) };
  } catch (_) {
    _shiftCfg = { ...DEFAULT_SHIFT };
  }
  _shiftCfgAt = Date.now();
  return _shiftCfg;
}

function invalidateShiftCache() { _shiftCfgAt = 0; }

// ── WhatsApp helper (BotSailor) ───────────────────────────────────────────────
async function sendWhatsAppToAdmin(message) {
  const token   = process.env.BOTSAILOR_API_TOKEN;
  const phoneId = process.env.BOTSAILOR_PHONE_NUMBER_ID || process.env.WA_PHONE_NUMBER_ID;
  const phone   = process.env.WA_ADMIN_PHONE1;
  if (!token || !phoneId || !phone) {
    console.warn('[kiosk] WhatsApp env vars missing — skipping alert');
    return;
  }
  try {
    const params = new URLSearchParams({
      apiToken: token, phone_number_id: phoneId, phone_number: phone, message,
    });
    const r = await fetch('https://botsailor.com/api/v1/whatsapp/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:   params.toString(),
    });
    const d = await r.json();
    if (d.status !== '1' && d.status !== 1) console.warn('[kiosk] WA send issue:', JSON.stringify(d));
  } catch (e) { console.error('[kiosk] WA error:', e.message); }
}

// ── Leave balance helper ──────────────────────────────────────────────────────
// Returns { casual, medical, earned } remaining days for the current year
async function getLeaveBalance(employeeId) {
  const year = new Date().getFullYear();
  const { data } = await supabase
    .from('leave_requests')
    .select('leave_type, days')
    .eq('employee_id', employeeId)
    .eq('status', 'approved')
    .gte('from_date', `${year}-01-01`);

  const used = { casual: 0, medical: 0, earned: 0 };
  (data || []).forEach(r => { used[r.leave_type] = (used[r.leave_type] || 0) + (r.days || 0); });

  const quota = { casual: 12, medical: 12, earned: 15 };
  return {
    casual:  Math.max(0, quota.casual  - used.casual),
    medical: Math.max(0, quota.medical - used.medical),
    earned:  Math.max(0, quota.earned  - used.earned),
  };
}

// ── Kiosk device token middleware ─────────────────────────────────────────────
async function kioskAuth(req, res, next) {
  const token = req.headers['x-kiosk-token'];
  if (!token) return res.status(401).json({ error: 'Kiosk token required' });
  const { data } = await supabase.from('settings').select('value').eq('key', 'kiosk_device_token').single();
  if (!data || data.value !== token) return res.status(401).json({ error: 'Invalid kiosk token' });
  next();
}

// ── GET /api/kiosk/setup-qr ──────────────────────────────────────────────────
router.get('/setup-qr', auth, async (req, res) => {
  const { data } = await supabase.from('settings').select('value').eq('key', 'kiosk_device_token').single();
  if (!data?.value) return res.status(404).json({ error: 'No kiosk token generated yet.' });
  const url = `https://admin.sathvam.in/kiosk.html?token=${data.value}`;
  const qrDataUrl = await QRCode.toDataURL(url, { width: 320, margin: 2, color: { dark: '#0a1a0e', light: '#ffffff' } });
  res.json({ qr: qrDataUrl, url });
});

// ── POST /api/kiosk/setup-token ───────────────────────────────────────────────
router.post('/setup-token', auth, requireRole('admin'), async (req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  const { error } = await supabase.from('settings').upsert({ key: 'kiosk_device_token', value: token }, { onConflict: 'key' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ token, note: 'Copy this token to the kiosk app. It will not be shown again.' });
});

// ── POST /api/kiosk/register-face ─────────────────────────────────────────────
router.post('/register-face', auth, requireRole('admin', 'manager'), async (req, res) => {
  const { employee_id, image } = req.body;
  if (!employee_id || !image) return res.status(400).json({ error: 'employee_id and image are required' });

  const { data: emp, error: empErr } = await supabase
    .from('employees').select('id, name, rekognition_face_id').eq('id', employee_id).single();
  if (empErr || !emp) return res.status(404).json({ error: 'Employee not found' });

  await ensureCollection();

  if (emp.rekognition_face_id) {
    try { await rekognition.send(new DeleteFacesCommand({ CollectionId: COLLECTION_ID, FaceIds: [emp.rekognition_face_id] })); }
    catch (e) { console.warn('[kiosk] Could not delete old face:', e.message); }
  }

  let indexResult;
  try {
    indexResult = await rekognition.send(new IndexFacesCommand({
      CollectionId:    COLLECTION_ID,
      Image:           { Bytes: Buffer.from(image, 'base64') },
      ExternalImageId: String(employee_id),
      MaxFaces:        1,
      QualityFilter:   'AUTO',
      DetectionAttributes: [],
    }));
  } catch (e) { return res.status(400).json({ error: 'Rekognition error: ' + e.message }); }

  if (!indexResult.FaceRecords?.length)
    return res.status(400).json({ error: 'No face detected. Use a clear, front-facing photo.' });

  const faceId = indexResult.FaceRecords[0].Face.FaceId;
  const { error: updateErr } = await supabase.from('employees').update({ rekognition_face_id: faceId }).eq('id', employee_id);
  if (updateErr) return res.status(500).json({ error: updateErr.message });
  res.json({ success: true, employee: emp.name, face_id: faceId });
});

// ── DELETE /api/kiosk/register-face/:employee_id ──────────────────────────────
router.delete('/register-face/:employee_id', auth, requireRole('admin'), async (req, res) => {
  const { employee_id } = req.params;
  const { data: emp } = await supabase.from('employees').select('id, name, rekognition_face_id').eq('id', employee_id).single();
  if (!emp?.rekognition_face_id) return res.status(404).json({ error: 'No face registered for this employee' });
  try { await rekognition.send(new DeleteFacesCommand({ CollectionId: COLLECTION_ID, FaceIds: [emp.rekognition_face_id] })); }
  catch (e) { console.warn('[kiosk] Rekognition delete failed:', e.message); }
  await supabase.from('employees').update({ rekognition_face_id: null }).eq('id', employee_id);
  res.json({ success: true, employee: emp.name });
});

// ── POST /api/kiosk/checkin ───────────────────────────────────────────────────
router.post('/checkin', kioskAuth, async (req, res) => {
  const { image, offlineTimestamp } = req.body;
  if (!image) return res.status(400).json({ error: 'image is required' });

  await ensureCollection();

  let searchResult;
  try {
    searchResult = await rekognition.send(new SearchFacesByImageCommand({
      CollectionId:       COLLECTION_ID,
      Image:              { Bytes: Buffer.from(image, 'base64') },
      MaxFaces:           1,
      FaceMatchThreshold: MATCH_THRESHOLD,
    }));
  } catch (e) {
    if (e.name === 'InvalidParameterException')
      return res.status(400).json({ error: 'No face detected in image' });
    return res.status(500).json({ error: 'Face search failed: ' + e.message });
  }

  // Stranger alert — face detected but not in collection
  if (!searchResult.FaceMatches?.length) {
    const { date, time } = getIST();
    sendWhatsAppToAdmin(
      `⚠️ *Stranger Alert — Sathvam Kiosk*\nUnknown face detected at entrance.\nTime: ${time} IST on ${date}\n\nPlease check kiosk camera / verify visitor at reception.`
    ).catch(() => {});
    return res.status(404).json({ error: 'Face not recognized', message: 'Please register your face with HR.' });
  }

  const match      = searchResult.FaceMatches[0];
  const confidence = match.Similarity;
  const employeeId = parseInt(match.Face.ExternalImageId, 10) || match.Face.ExternalImageId;

  const { data: emp } = await supabase
    .from('employees')
    .select('id, name, date_of_birth')
    .eq('id', employeeId)
    .eq('active', true)
    .single();

  if (!emp) return res.status(404).json({ error: 'Employee not found or inactive' });

  // Use offlineTimestamp if provided (queued scan) — must be within last 24h
  let { date, time, mmdd } = getIST();
  if (offlineTimestamp) {
    const ts = new Date(offlineTimestamp);
    const ageMs = Date.now() - ts.getTime();
    if (!isNaN(ts.getTime()) && ageMs >= 0 && ageMs <= 86400000) {
      const ist = new Date(ts.getTime() + 5.5 * 60 * 60 * 1000);
      date = ist.toISOString().substring(0, 10);
      time = ist.toISOString().substring(11, 19);
      mmdd = ist.toISOString().substring(5, 10);
    }
  }
  const isBirthday = emp.date_of_birth ? emp.date_of_birth.substring(5, 10) === mmdd : false;

  const { data: existing } = await supabase
    .from('attendance')
    .select('status, time_in, time_out, notes')
    .eq('employee_id', employeeId)
    .eq('date', date)
    .maybeSingle();

  // Load shift config (cached)
  const cfg = await getShiftConfig();
  // Pad times to HH:MM:SS for string comparison
  const lateThreshold     = (cfg.late_after     || '09:30') + ':00';
  const overtimeThreshold = (cfg.overtime_after || '18:00') + ':00';
  const earlyThreshold    = (cfg.early_before   || '17:00') + ':00';

  let action, upsertRow, leaveBalance = null;

  if (!existing?.time_in) {
    // ── Check-in (first arrival) ──────────────────────────────────────────
    action = 'check_in';
    upsertRow = {
      employee_id: employeeId, date, status: 'present',
      time_in: time, time_out: null,
      notes: `Biometric check-in (${confidence.toFixed(1)}% match)`,
      change_reason: '',
    };

    // Late arrival alert
    if (time > lateThreshold) {
      sendWhatsAppToAdmin(
        `⏰ *Late Arrival*\n${emp.name} checked in at *${time} IST* (expected by ${cfg.late_after || '09:30'}).`
      ).catch(() => {});
    }

    // Birthday alert
    if (isBirthday) {
      sendWhatsAppToAdmin(
        `🎂 *Birthday Today!*\nToday is *${emp.name}*'s birthday! Don't forget to wish them. 🎉`
      ).catch(() => {});
    }

  } else if (!existing?.time_out) {
    // ── Check-out (leaving) ───────────────────────────────────────────────
    action = 'check_out';
    upsertRow = {
      employee_id: employeeId, date, status: 'present',
      time_in: existing.time_in, time_out: time,
      notes: existing.notes || `Biometric check-out (${confidence.toFixed(1)}% match)`,
      change_reason: '',
    };

    // Overtime alert
    if (time > overtimeThreshold) {
      sendWhatsAppToAdmin(
        `🕕 *Overtime Alert*\n${emp.name} checked out at *${time} IST* (after ${cfg.overtime_after || '18:00'}).\nChecked in: ${existing.time_in}`
      ).catch(() => {});
    }

    // Early departure alert
    if (time < earlyThreshold) {
      sendWhatsAppToAdmin(
        `🚪 *Early Departure*\n${emp.name} left at *${time} IST* (before ${cfg.early_before || '17:00'}).\nChecked in: ${existing.time_in}`
      ).catch(() => {});
    }

    // Fetch leave balance for checkout display
    leaveBalance = await getLeaveBalance(employeeId).catch(() => null);

  } else {
    // ── Back-in (returned after break) ────────────────────────────────────
    action = 'back_in';
    upsertRow = {
      employee_id: employeeId, date, status: 'present',
      time_in: existing.time_in, time_out: null,
      notes: `${existing.notes || ''} | Returned at ${time}`.trim().replace(/^\| /, ''),
      change_reason: '',
    };
  }

  const { error: upsertErr } = await supabase
    .from('attendance')
    .upsert(upsertRow, { onConflict: 'employee_id,date' });

  if (upsertErr) return res.status(500).json({ error: upsertErr.message });

  res.json({
    success:       true,
    action,
    employee:      emp.name,
    time,
    date,
    confidence:    confidence.toFixed(1),
    is_birthday:   isBirthday,
    leave_balance: leaveBalance, // null unless action === 'check_out'
    message:       action === 'check_in'  ? `Good morning, ${emp.name}! Checked in at ${time}`
                 : action === 'check_out' ? `Goodbye, ${emp.name}! Checked out at ${time}`
                 : `Welcome back, ${emp.name}! Returned at ${time}`,
  });
});

// ── GET /api/kiosk/today-summary ─────────────────────────────────────────────
router.get('/today-summary', kioskAuth, async (req, res) => {
  const { date } = getIST();
  const [{ data: allEmps }, { data: attRecs }] = await Promise.all([
    supabase.from('employees').select('id, name').eq('active', true).order('name'),
    supabase.from('attendance').select('employee_id, status, time_in, time_out').eq('date', date),
  ]);
  const attMap  = Object.fromEntries((attRecs || []).map(r => [String(r.employee_id), r]));
  const total   = (allEmps || []).length;
  const present = (attRecs || []).filter(r => r.status === 'present').length;
  const list    = (allEmps || []).map(e => ({
    id:       e.id,
    name:     e.name,
    status:   attMap[String(e.id)]?.status  || 'no_record',
    time_in:  attMap[String(e.id)]?.time_in  || null,
    time_out: attMap[String(e.id)]?.time_out || null,
  }));
  res.json({ date, total, present, absent: total - present, list });
});

// ── GET /api/kiosk/admin-summary ─────────────────────────────────────────────
// Same as today-summary but for admin (cookie auth). Used by live feed panel.
router.get('/admin-summary', auth, async (req, res) => {
  const { date } = getIST();
  const [{ data: allEmps }, { data: attRecs }] = await Promise.all([
    supabase.from('employees').select('id, name').eq('active', true).order('name'),
    supabase.from('attendance').select('employee_id, status, time_in, time_out').eq('date', date),
  ]);
  const attMap  = Object.fromEntries((attRecs || []).map(r => [String(r.employee_id), r]));
  const total   = (allEmps || []).length;
  const present = (attRecs || []).filter(r => r.status === 'present').length;
  const list    = (allEmps || []).map(e => ({
    id:       e.id,
    name:     e.name,
    status:   attMap[String(e.id)]?.status  || 'no_record',
    time_in:  attMap[String(e.id)]?.time_in  || null,
    time_out: attMap[String(e.id)]?.time_out || null,
  }));
  res.json({ date, total, present, absent: total - present, list });
});

// ── GET /api/kiosk/voices ─────────────────────────────────────────────────────
router.get('/voices', async (req, res) => {
  const kioskTok = req.headers['x-kiosk-token'];
  if (kioskTok) {
    const { data: td } = await supabase.from('settings').select('value').eq('key', 'kiosk_device_token').single();
    if (!td || td.value !== kioskTok) return res.status(401).json({ error: 'Invalid kiosk token' });
  } else {
    const jwt = require('jsonwebtoken');
    const token = req.cookies?.sathvam_admin || req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    try { jwt.verify(token, process.env.JWT_SECRET); } catch { return res.status(401).json({ error: 'Session expired' }); }
  }
  const { data } = await supabase.from('settings').select('value').eq('key', 'kiosk_voices').single();
  res.json(data?.value || {});
});

// ── POST /api/kiosk/voices ────────────────────────────────────────────────────
router.post('/voices', auth, requireRole('admin', 'manager'), async (req, res) => {
  const voices = req.body;
  const { error } = await supabase.from('settings').upsert({ key: 'kiosk_voices', value: voices }, { onConflict: 'key' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── GET /api/kiosk/shift-config ───────────────────────────────────────────────
// Returns current shift timing config (admin or kiosk auth).
router.get('/shift-config', async (req, res) => {
  const kioskTok = req.headers['x-kiosk-token'];
  if (kioskTok) {
    const { data: td } = await supabase.from('settings').select('value').eq('key', 'kiosk_device_token').single();
    if (!td || td.value !== kioskTok) return res.status(401).json({ error: 'Invalid kiosk token' });
  } else {
    const jwt = require('jsonwebtoken');
    const token = req.cookies?.sathvam_admin || req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    try { jwt.verify(token, process.env.JWT_SECRET); } catch { return res.status(401).json({ error: 'Session expired' }); }
  }
  const cfg = await getShiftConfig();
  res.json(cfg);
});

// ── POST /api/kiosk/shift-config ──────────────────────────────────────────────
// Admin updates shift timing config.
// Body: { late_after: 'HH:MM', overtime_after: 'HH:MM', early_before: 'HH:MM' }
router.post('/shift-config', auth, requireRole('admin', 'manager'), async (req, res) => {
  const { late_after, overtime_after, early_before } = req.body;
  const value = {
    late_after:     late_after     || DEFAULT_SHIFT.late_after,
    overtime_after: overtime_after || DEFAULT_SHIFT.overtime_after,
    early_before:   early_before   || DEFAULT_SHIFT.early_before,
  };
  const { error } = await supabase.from('settings').upsert({ key: 'kiosk_shift_config', value }, { onConflict: 'key' });
  if (error) return res.status(500).json({ error: error.message });
  invalidateShiftCache(); // force re-read on next checkin
  res.json({ success: true, config: value });
});

// ── GET /api/kiosk/status ─────────────────────────────────────────────────────
router.get('/status', auth, async (req, res) => {
  const { data: tokenRow } = await supabase.from('settings').select('value').eq('key', 'kiosk_device_token').single();
  const { data: emps }     = await supabase.from('employees').select('id, name, rekognition_face_id').eq('active', true).order('name');
  const list        = emps || [];
  const withFace    = list.filter(e => e.rekognition_face_id);
  const withoutFace = list.filter(e => !e.rekognition_face_id);
  res.json({
    kiosk_configured: !!tokenRow?.value,
    aws_region:       process.env.AWS_REGION || 'ap-south-1',
    collection_id:    COLLECTION_ID,
    employees: {
      face_registered: withFace.length,
      face_missing:    withoutFace.length,
      missing_list:    withoutFace.map(e => ({ id: e.id, name: e.name })),
    },
  });
});

// ── Cron: auto-mark absent at 10 AM IST (04:30 UTC) ─────────────────────────
cron.schedule('30 4 * * *', async () => {
  try {
    const { date } = getIST();
    console.log('[kiosk-cron] auto-absent for', date);
    const { data: allEmps } = await supabase.from('employees').select('id, name').eq('active', true);
    const { data: checkedIn } = await supabase.from('attendance').select('employee_id').eq('date', date);
    const checkedIds = new Set((checkedIn || []).map(r => String(r.employee_id)));
    const absent     = (allEmps || []).filter(e => !checkedIds.has(String(e.id)));
    if (!absent.length) return;
    const rows = absent.map(e => ({
      employee_id: e.id, date, status: 'absent',
      notes: 'Auto-marked absent (no biometric check-in by 10:00 AM IST)', change_reason: '',
    }));
    await supabase.from('attendance').upsert(rows, { onConflict: 'employee_id,date' });
    await sendWhatsAppToAdmin(
      `📋 *Absent Today (Auto-marked)*\n${absent.length} employee(s) did not check in by 10:00 AM IST on ${date}:\n\n${absent.map(e => `• ${e.name}`).join('\n')}`
    );
  } catch (e) { console.error('[kiosk-cron] auto-absent error:', e.message); }
});

// ── Cron: missed-checkout alert at 7 PM IST (13:30 UTC) ─────────────────────
cron.schedule('30 13 * * *', async () => {
  try {
    const { date } = getIST();
    console.log('[kiosk-cron] missed-checkout check for', date);
    const { data: records } = await supabase
      .from('attendance').select('employee_id, time_in')
      .eq('date', date).eq('status', 'present').is('time_out', null);
    if (!records?.length) return;
    const ids = records.map(r => r.employee_id);
    const { data: emps } = await supabase.from('employees').select('id, name').in('id', ids);
    const nameMap = Object.fromEntries((emps || []).map(e => [String(e.id), e.name]));
    const lines   = records.map(r => `• ${nameMap[String(r.employee_id)] || r.employee_id} (in: ${r.time_in})`);
    await sendWhatsAppToAdmin(
      `⚠️ *Missed Checkout Alert*\n${records.length} employee(s) not checked out by 7:00 PM IST on ${date}:\n\n${lines.join('\n')}\n\nPlease verify they have left.`
    );
  } catch (e) { console.error('[kiosk-cron] missed-checkout error:', e.message); }
});

module.exports = router;
