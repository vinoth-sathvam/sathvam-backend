const express = require('express');
const webpush  = require('web-push');
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');
const router   = express.Router();

// ── VAPID setup ────────────────────────────────────────────────────────────────
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:admin@sathvam.in',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

// ── Firebase Admin (FCM) — only init if credentials are provided ───────────────
let fcmMessaging = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(
          JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
        ),
      });
    }
    fcmMessaging = admin.messaging();
    console.log('[PUSH] Firebase Admin initialized — FCM ready');
  } catch (e) {
    console.error('[PUSH] Firebase Admin init failed:', e.message);
  }
} else {
  console.log('[PUSH] FIREBASE_SERVICE_ACCOUNT_JSON not set — FCM disabled');
}

// ── Helpers ────────────────────────────────────────────────────────────────────
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// ── POST /api/notifications/register-token ─────────────────────────────────────
// Called by website visitors (web) and Android app (android) — no auth required
router.post('/register-token', async (req, res) => {
  try {
    const { platform, endpoint, p256dh, auth_key, fcm_token } = req.body;
    if (!platform || !['web', 'android'].includes(platform)) {
      return res.status(400).json({ error: 'platform must be web or android' });
    }

    if (platform === 'web') {
      if (!endpoint || !p256dh || !auth_key) {
        return res.status(400).json({ error: 'endpoint, p256dh and auth_key required for web' });
      }
      await supabase.from('push_tokens').upsert(
        { platform: 'web', endpoint, p256dh, auth_key, user_agent: req.headers['user-agent'] || null, last_seen_at: new Date().toISOString(), active: true },
        { onConflict: 'endpoint' }
      );
    } else {
      if (!fcm_token) {
        return res.status(400).json({ error: 'fcm_token required for android' });
      }
      await supabase.from('push_tokens').upsert(
        { platform: 'android', fcm_token, user_agent: req.headers['user-agent'] || null, last_seen_at: new Date().toISOString(), active: true },
        { onConflict: 'fcm_token' }
      );
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[PUSH] register-token error:', e.message);
    res.status(500).json({ error: 'server error' });
  }
});

// ── DELETE /api/notifications/unregister-token ─────────────────────────────────
router.delete('/unregister-token', async (req, res) => {
  try {
    const { endpoint, fcm_token } = req.body;
    if (endpoint) {
      await supabase.from('push_tokens').update({ active: false }).eq('endpoint', endpoint);
    } else if (fcm_token) {
      await supabase.from('push_tokens').update({ active: false }).eq('fcm_token', fcm_token);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

// ── GET /api/notifications/stats ───────────────────────────────────────────────
router.get('/stats', auth, async (req, res) => {
  try {
    const { data } = await supabase
      .from('push_tokens')
      .select('platform')
      .eq('active', true);
    const web     = (data || []).filter(r => r.platform === 'web').length;
    const android = (data || []).filter(r => r.platform === 'android').length;
    res.json({ web, android, total: web + android });
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

// ── GET /api/notifications/campaigns ──────────────────────────────────────────
router.get('/campaigns', auth, async (req, res) => {
  try {
    const { data } = await supabase
      .from('push_campaigns')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

// ── POST /api/notifications/campaigns ─────────────────────────────────────────
router.post('/campaigns', auth, async (req, res) => {
  try {
    const { title, body, icon, image, url, template, platform } = req.body;
    if (!title || !body || !template) {
      return res.status(400).json({ error: 'title, body and template are required' });
    }
    const { data, error } = await supabase.from('push_campaigns').insert({
      title,
      body,
      icon:     icon     || '/icon-192.png',
      image:    image    || null,
      url:      url      || '/',
      template: template || 'custom',
      platform: platform || 'all',
      status:   'draft',
    }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    console.error('[PUSH] create campaign error:', e.message);
    res.status(500).json({ error: 'server error' });
  }
});

// ── POST /api/notifications/campaigns/:id/send ────────────────────────────────
router.post('/campaigns/:id/send', auth, async (req, res) => {
  const campaignId = parseInt(req.params.id);
  try {
    // Load campaign
    const { data: campaign } = await supabase
      .from('push_campaigns')
      .select('*')
      .eq('id', campaignId)
      .single();
    if (!campaign) return res.status(404).json({ error: 'campaign not found' });

    // Mark as sending
    await supabase.from('push_campaigns').update({ status: 'sending' }).eq('id', campaignId);

    // Load active tokens
    let query = supabase.from('push_tokens').select('*').eq('active', true);
    if (campaign.platform !== 'all') query = query.eq('platform', campaign.platform);
    const { data: tokens } = await query;

    const webTokens     = (tokens || []).filter(t => t.platform === 'web');
    const androidTokens = (tokens || []).filter(t => t.platform === 'android');

    const payload = JSON.stringify({
      title:  campaign.title,
      body:   campaign.body,
      icon:   campaign.icon  || '/icon-192.png',
      image:  campaign.image || null,
      url:    campaign.url   || '/',
    });

    let sentWeb = 0, sentAndroid = 0, failed = 0;
    const deadEndpoints = [];

    // ── Send web push ──────────────────────────────────────────────────────────
    const webBatches = chunk(webTokens, 100);
    for (const batch of webBatches) {
      const results = await Promise.allSettled(
        batch.map(t =>
          webpush.sendNotification(
            { endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth_key } },
            payload,
          )
        )
      );
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          sentWeb++;
        } else {
          failed++;
          const statusCode = r.reason?.statusCode;
          if (statusCode === 410 || statusCode === 404) {
            deadEndpoints.push(batch[i].endpoint);
          }
        }
      });
    }

    // ── Send FCM (Android) ─────────────────────────────────────────────────────
    if (fcmMessaging && androidTokens.length > 0) {
      const fcmBatches = chunk(androidTokens, 500);
      for (const batch of fcmBatches) {
        try {
          const result = await fcmMessaging.sendEachForMulticast({
            tokens: batch.map(t => t.fcm_token),
            notification: {
              title: campaign.title,
              body:  campaign.body,
              imageUrl: campaign.image || undefined,
            },
            data: { url: campaign.url || '/' },
            android: {
              notification: {
                icon:  'ic_notification',
                color: '#c97b2e',
                clickAction: 'FLUTTER_NOTIFICATION_CLICK',
              },
            },
          });
          sentAndroid += result.successCount;
          failed      += result.failureCount;
          // Remove invalid FCM tokens
          result.responses.forEach((r, i) => {
            if (!r.success && r.error?.code === 'messaging/registration-token-not-registered') {
              deadEndpoints.push(batch[i].fcm_token);
            }
          });
        } catch (e) {
          console.error('[PUSH] FCM batch error:', e.message);
          failed += batch.length;
        }
      }
    } else if (androidTokens.length > 0 && !fcmMessaging) {
      console.warn('[PUSH] FCM not configured — skipping', androidTokens.length, 'android tokens');
      failed += androidTokens.length;
    }

    // Clean up dead tokens
    if (deadEndpoints.length > 0) {
      await supabase.from('push_tokens')
        .update({ active: false })
        .in('endpoint', deadEndpoints.filter(e => e.startsWith('http')));
      await supabase.from('push_tokens')
        .update({ active: false })
        .in('fcm_token', deadEndpoints.filter(e => !e.startsWith('http')));
    }

    // Update campaign with results
    await supabase.from('push_campaigns').update({
      status:       'sent',
      sent_web:     sentWeb,
      sent_android: sentAndroid,
      failed_count: failed,
      sent_at:      new Date().toISOString(),
    }).eq('id', campaignId);

    res.json({ ok: true, sentWeb, sentAndroid, failed });
  } catch (e) {
    console.error('[PUSH] send campaign error:', e.message);
    await supabase.from('push_campaigns').update({ status: 'failed' }).eq('id', campaignId);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
