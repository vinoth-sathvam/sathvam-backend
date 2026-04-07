const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');

// GET /api/campaigns — list campaigns
router.get('/', auth, async (req, res) => {
  try {
    const { status, limit = 100 } = req.query;
    let q = supabase.from('email_campaigns')
      .select('*').order('created_at', { ascending: false }).limit(parseInt(limit));
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/campaigns — create campaign
router.post('/', auth, async (req, res) => {
  try {
    const { name, subject, body_html, body_text, segment, scheduled_at } = req.body;
    if (!name || !subject) return res.status(400).json({ error: 'name and subject required' });
    const { data, error } = await supabase.from('email_campaigns')
      .insert({ name, subject, body_html: body_html || '', body_text: body_text || '', segment: segment || 'all', scheduled_at: scheduled_at || null, status: 'draft', sent_count: 0, open_count: 0 })
      .select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/campaigns/:id — update campaign
router.patch('/:id', auth, async (req, res) => {
  try {
    const allowed = ['name','subject','body_html','body_text','segment','scheduled_at','status'];
    const updates = { updated_at: new Date().toISOString() };
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    const { data, error } = await supabase.from('email_campaigns')
      .update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/campaigns/:id
router.delete('/:id', auth, async (req, res) => {
  const { error } = await supabase.from('email_campaigns').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// POST /api/campaigns/:id/send — send campaign
router.post('/:id/send', auth, async (req, res) => {
  try {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return res.status(503).json({ error: 'Email not configured' });
    const { data: campaign, error: cErr } = await supabase.from('email_campaigns').select('*').eq('id', req.params.id).single();
    if (cErr || !campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status === 'sent') return res.status(400).json({ error: 'Campaign already sent' });

    // Get recipients based on segment
    let recipientsQuery = supabase.from('customers').select('id,name,email').not('email', 'is', null).neq('email', '');
    if (campaign.segment === 'b2b') recipientsQuery = recipientsQuery.eq('type', 'b2b');
    else if (campaign.segment === 'b2c') recipientsQuery = recipientsQuery.eq('type', 'b2c');
    const { data: customers } = await recipientsQuery;
    const recipients = (customers || []).filter(c => c.email);

    if (!recipients.length) return res.status(400).json({ error: 'No recipients found for segment' });

    const nodemailer = require('nodemailer');
    const mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    let sentCount = 0;
    const sends = [];
    for (const c of recipients) {
      try {
        await mailer.sendMail({
          from: process.env.SMTP_FROM || 'Sathvam <noreply@sathvam.in>',
          to: c.email,
          subject: campaign.subject,
          html: campaign.body_html || `<p>${campaign.body_text}</p>`,
          text: campaign.body_text || '',
        });
        sends.push({ campaign_id: campaign.id, customer_id: c.id, email: c.email, status: 'sent', sent_at: new Date().toISOString() });
        sentCount++;
      } catch (mailErr) {
        sends.push({ campaign_id: campaign.id, customer_id: c.id, email: c.email, status: 'failed', error: mailErr.message });
      }
    }
    if (sends.length) await supabase.from('email_campaign_sends').insert(sends);
    await supabase.from('email_campaigns').update({ status: 'sent', sent_count: sentCount, sent_at: new Date().toISOString() }).eq('id', req.params.id);
    res.json({ ok: true, sent: sentCount, total: recipients.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/campaigns/:id/sends — list individual sends
router.get('/:id/sends', auth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('email_campaign_sends')
      .select('*').eq('campaign_id', req.params.id).order('sent_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
