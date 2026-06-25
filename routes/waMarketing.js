'use strict';
/**
 * WhatsApp Marketing — broadcast, schedule, templates, drip campaigns, analytics
 * Mounted at /api/wa-marketing
 */
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { auth } = require('../middleware/auth');
const { sendText: gaSendText, sendFile: gaSendFile } = require('../lib/greenapi');
const { decryptCustomer, decrypt } = require('../config/crypto');
const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchAllContacts() {
  const { data: rawCustomers } = await supabase
    .from('customers')
    .select('id,name,phone,email,city,state,created_at')
    .not('phone', 'is', null)
    .limit(5000);

  const { data: optouts } = await supabase
    .from('settings')
    .select('key')
    .like('key', 'wa_optout_%');

  const { data: loyalties } = await supabase
    .from('settings')
    .select('key,value')
    .like('key', 'cust_loyalty_%');

  const optoutSet = new Set((optouts || []).map(o => o.key));
  const loyaltyMap = {};
  for (const l of loyalties || []) loyaltyMap[l.key] = l.value?.points || 0;

  return (rawCustomers || []).map(c => {
    const phone = (decrypt(c.phone) || '').replace(/\D/g, '');
    return {
      id: c.id,
      name: decrypt(c.name) || '',
      phone,
      email: decrypt(c.email) || '',
      city: c.city || '',
      state: c.state || '',
      optedOut: optoutSet.has(`wa_optout_${phone}`),
      loyaltyPoints: loyaltyMap[`cust_loyalty_${c.id}`] || 0,
      createdAt: c.created_at,
    };
  }).filter(c => c.phone && c.phone.length >= 10);
}

// ── GET /contacts ─────────────────────────────────────────────────────────────

router.get('/contacts', auth, async (req, res) => {
  try {
    const contacts = await fetchAllContacts();
    res.json({
      contacts,
      total: contacts.length,
      optedOut: contacts.filter(c => c.optedOut).length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /broadcast ───────────────────────────────────────────────────────────

router.post('/broadcast', auth, async (req, res) => {
  const { message, segment = 'all', phones: customPhones, imageUrl, caption } = req.body;
  if (!message && !caption) return res.status(400).json({ error: 'message or caption required' });

  const broadcastId = `wa_broadcast_${Date.now()}`;
  const isImage = !!imageUrl;

  // Acknowledge immediately — sends run in background
  res.json({ ok: true, broadcastId, status: 'queued' });

  setImmediate(async () => {
    try {
      let phones = customPhones;

      if (!phones) {
        let allContacts = await fetchAllContacts();
        allContacts = allContacts.filter(c => !c.optedOut);

        const now = Date.now();
        const d30 = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
        const d60 = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString();
        const d90 = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();

        if (segment === 'new_30') {
          allContacts = allContacts.filter(c => c.createdAt > d30);
        } else if (segment === 'loyalty_gold') {
          allContacts = allContacts.filter(c => c.loyaltyPoints >= 500);
        } else if (segment === 'loyalty_silver') {
          allContacts = allContacts.filter(c => c.loyaltyPoints >= 100 && c.loyaltyPoints < 500);
        } else if (segment.startsWith('city:')) {
          const city = segment.slice(5).toLowerCase();
          allContacts = allContacts.filter(c => c.city.toLowerCase().includes(city));
        } else if (['active_30', 'active_60', 'inactive_60', 'inactive_90'].includes(segment)) {
          // Fetch recent orders for activity-based segmentation
          const { data: recentOrders } = await supabase
            .from('webstore_orders')
            .select('customer,created_at')
            .gte('created_at', d90);

          const orderedPhones60 = new Set();
          const orderedPhones30 = new Set();
          for (const o of recentOrders || []) {
            try {
              const cust = decryptCustomer(o.customer || {});
              const ph = (cust.phone || '').replace(/\D/g, '');
              if (ph && o.created_at > d60) orderedPhones60.add(ph);
              if (ph && o.created_at > d30) orderedPhones30.add(ph);
            } catch (e) { /* skip */ }
          }

          if (segment === 'active_30') {
            allContacts = allContacts.filter(c => orderedPhones30.has(c.phone));
          } else if (segment === 'active_60') {
            allContacts = allContacts.filter(c => orderedPhones60.has(c.phone));
          } else if (segment === 'inactive_60') {
            allContacts = allContacts.filter(c => !orderedPhones60.has(c.phone));
          } else if (segment === 'inactive_90') {
            const { data: allOrders } = await supabase
              .from('webstore_orders')
              .select('customer,created_at')
              .gte('created_at', d90);
            const orderedPhones90 = new Set();
            for (const o of allOrders || []) {
              try {
                const cust = decryptCustomer(o.customer || {});
                const ph = (cust.phone || '').replace(/\D/g, '');
                if (ph) orderedPhones90.add(ph);
              } catch (e) { /* skip */ }
            }
            allContacts = allContacts.filter(c => !orderedPhones90.has(c.phone));
          }
        }
        // 'all' — no extra filter

        phones = allContacts.map(c => c.phone.length === 10 ? '91' + c.phone : c.phone);
      }

      let sent = 0, failed = 0;
      for (const phone of phones) {
        try {
          const ok = isImage
            ? await gaSendFile(phone, imageUrl, 'sathvam.jpg', caption || message)
            : await gaSendText(phone, message);
          if (ok) sent++; else failed++;
        } catch (e) { failed++; }
        await new Promise(r => setTimeout(r, 500));
      }

      await supabase.from('settings').upsert({
        key: broadcastId,
        value: {
          id: broadcastId,
          message: message || caption,
          segment,
          sentAt: new Date().toISOString(),
          sent,
          failed,
          skipped: 0,
          type: isImage ? 'image' : 'text',
          imageUrl: imageUrl || null,
        },
        updated_at: new Date().toISOString(),
      });

      console.log(`[WA-MARKETING] Broadcast ${broadcastId}: sent=${sent} failed=${failed}`);
    } catch (e) {
      console.error('[WA-MARKETING] Broadcast error:', e.message);
    }
  });
});

// ── GET /broadcast-history ────────────────────────────────────────────────────

router.get('/broadcast-history', auth, async (req, res) => {
  try {
    const { data } = await supabase
      .from('settings')
      .select('key,value,updated_at')
      .like('key', 'wa_broadcast_%')
      .order('updated_at', { ascending: false })
      .limit(50);
    const history = (data || []).map(r => r.value).filter(Boolean);
    res.json({ history });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /analytics ────────────────────────────────────────────────────────────

router.get('/analytics', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [outbound, inbound, todayOut, weekOut, optouts, broadcasts] = await Promise.all([
      supabase.from('whatsapp_messages').select('id', { count: 'exact', head: true }).eq('direction', 'outbound'),
      supabase.from('whatsapp_messages').select('id', { count: 'exact', head: true }).eq('direction', 'inbound'),
      supabase.from('whatsapp_messages').select('id', { count: 'exact', head: true }).eq('direction', 'outbound').gte('timestamp', today),
      supabase.from('whatsapp_messages').select('id', { count: 'exact', head: true }).eq('direction', 'outbound').gte('timestamp', weekAgo),
      supabase.from('settings').select('key', { count: 'exact', head: true }).like('key', 'wa_optout_%'),
      supabase.from('settings').select('value,updated_at').like('key', 'wa_broadcast_%').order('updated_at', { ascending: false }).limit(10),
    ]);

    const broadcastList = (broadcasts.data || []).map(r => r.value).filter(Boolean);
    const totalSentViaBroadcast = broadcastList.reduce((s, b) => s + (b.sent || 0), 0);

    res.json({
      totalSent: outbound.count || 0,
      totalReceived: inbound.count || 0,
      todaySent: todayOut.count || 0,
      weekSent: weekOut.count || 0,
      optedOut: optouts.count || 0,
      broadcastCount: broadcastList.length,
      totalReachedViaBroadcast: totalSentViaBroadcast,
      recentBroadcasts: broadcastList.slice(0, 5),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Templates CRUD ────────────────────────────────────────────────────────────

router.get('/templates', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'wa_templates').single();
    res.json({ templates: data?.value || [] });
  } catch (e) {
    res.json({ templates: [] });
  }
});

router.post('/templates', auth, async (req, res) => {
  try {
    const { name, message, imageUrl, category } = req.body;
    if (!name || !message) return res.status(400).json({ error: 'name and message required' });
    const { data: existing } = await supabase.from('settings').select('value').eq('key', 'wa_templates').single();
    const templates = existing?.value || [];
    const newTpl = {
      id: Date.now().toString(),
      name,
      message,
      imageUrl: imageUrl || null,
      category: category || 'general',
      createdAt: new Date().toISOString(),
    };
    templates.push(newTpl);
    await supabase.from('settings').upsert({ key: 'wa_templates', value: templates, updated_at: new Date().toISOString() });
    res.json({ ok: true, template: newTpl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/templates/:id', auth, async (req, res) => {
  try {
    const { data: existing } = await supabase.from('settings').select('value').eq('key', 'wa_templates').single();
    const templates = (existing?.value || []).filter(t => t.id !== req.params.id);
    await supabase.from('settings').upsert({ key: 'wa_templates', value: templates, updated_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Schedules CRUD ────────────────────────────────────────────────────────────

router.get('/schedules', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'wa_schedules').single();
    res.json({ schedules: data?.value || [] });
  } catch (e) {
    res.json({ schedules: [] });
  }
});

router.post('/schedules', auth, async (req, res) => {
  try {
    const { name, message, imageUrl, segment, scheduledAt } = req.body;
    if (!message || !scheduledAt) return res.status(400).json({ error: 'message and scheduledAt required' });
    const { data: existing } = await supabase.from('settings').select('value').eq('key', 'wa_schedules').single();
    const schedules = existing?.value || [];
    const newSched = {
      id: Date.now().toString(),
      name: name || 'Scheduled Broadcast',
      message,
      imageUrl: imageUrl || null,
      segment: segment || 'all',
      scheduledAt,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    schedules.push(newSched);
    await supabase.from('settings').upsert({ key: 'wa_schedules', value: schedules, updated_at: new Date().toISOString() });
    res.json({ ok: true, schedule: newSched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/schedules/:id', auth, async (req, res) => {
  try {
    const { data: existing } = await supabase.from('settings').select('value').eq('key', 'wa_schedules').single();
    const schedules = (existing?.value || []).filter(s => s.id !== req.params.id);
    await supabase.from('settings').upsert({ key: 'wa_schedules', value: schedules, updated_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Drips CRUD ────────────────────────────────────────────────────────────────

router.get('/drips', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'wa_drips').single();
    res.json({ drips: data?.value || [] });
  } catch (e) {
    res.json({ drips: [] });
  }
});

router.post('/drips', auth, async (req, res) => {
  try {
    const { name, trigger, steps, active } = req.body;
    if (!name || !steps?.length) return res.status(400).json({ error: 'name and steps required' });
    const { data: existing } = await supabase.from('settings').select('value').eq('key', 'wa_drips').single();
    const drips = existing?.value || [];
    const newDrip = {
      id: Date.now().toString(),
      name,
      trigger: trigger || 'new_customer',
      steps,
      active: active !== false,
      createdAt: new Date().toISOString(),
    };
    drips.push(newDrip);
    await supabase.from('settings').upsert({ key: 'wa_drips', value: drips, updated_at: new Date().toISOString() });
    res.json({ ok: true, drip: newDrip });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/drips/:id', auth, async (req, res) => {
  try {
    const { data: existing } = await supabase.from('settings').select('value').eq('key', 'wa_drips').single();
    const drips = (existing?.value || []).map(d => d.id === req.params.id ? { ...d, ...req.body, id: d.id } : d);
    await supabase.from('settings').upsert({ key: 'wa_drips', value: drips, updated_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/drips/:id', auth, async (req, res) => {
  try {
    const { data: existing } = await supabase.from('settings').select('value').eq('key', 'wa_drips').single();
    const drips = (existing?.value || []).filter(d => d.id !== req.params.id);
    await supabase.from('settings').upsert({ key: 'wa_drips', value: drips, updated_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
