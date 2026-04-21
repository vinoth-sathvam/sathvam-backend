'use strict';
/**
 * Google Ads API Integration — Sathvam Natural Products
 * REST API v18 via axios (no heavy npm package needed)
 *
 * Env vars required:
 *   GOOGLE_ADS_DEVELOPER_TOKEN   — from Google Ads > Tools > API Center
 *   GOOGLE_ADS_CLIENT_ID         — OAuth2 client ID (Google Cloud Console)
 *   GOOGLE_ADS_CLIENT_SECRET     — OAuth2 client secret
 *   GOOGLE_ADS_REFRESH_TOKEN     — long-lived OAuth2 refresh token for your Ads account
 *   GOOGLE_ADS_CUSTOMER_ID       — your Google Ads account ID (e.g. 123-456-7890)
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID — (optional) MCC manager account ID if using MCC
 */

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const jwt     = require('jsonwebtoken');

const JWT_SECRET    = process.env.JWT_SECRET;
const ADS_VERSION   = 'v18';
const ADS_BASE      = `https://googleads.googleapis.com/${ADS_VERSION}`;
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';

// ── Auth middleware (admin cookie) ────────────────────────────────────────────
const auth = (req, res, next) => {
  const token = req.cookies?.sathvam_admin;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Session expired' }); }
};

// Only admin and ceo can manage Google Ads
const requireAdminOrCeo = (req, res, next) => {
  if (!['admin', 'ceo'].includes(req.user?.role))
    return res.status(403).json({ error: 'Admin or CEO access required' });
  next();
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// Get fresh OAuth2 access token using the stored refresh token
async function getAccessToken() {
  const { data } = await axios.post(TOKEN_URL, null, {
    params: {
      client_id:     process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    },
  });
  return data.access_token;
}

// Build HTTP headers required for every Google Ads API call
function adsHeaders(accessToken) {
  const h = {
    'Authorization':   `Bearer ${accessToken}`,
    'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    'Content-Type':    'application/json',
  };
  const mcc = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/-/g, '');
  if (mcc) h['login-customer-id'] = mcc;
  return h;
}

// Customer ID without dashes
const cid = () => (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');

// Check all required env vars are set
function checkConfig() {
  const required = [
    'GOOGLE_ADS_DEVELOPER_TOKEN',
    'GOOGLE_ADS_CLIENT_ID',
    'GOOGLE_ADS_CLIENT_SECRET',
    'GOOGLE_ADS_REFRESH_TOKEN',
    'GOOGLE_ADS_CUSTOMER_ID',
  ];
  return required.filter(k => !process.env[k]);
}

// Extract a clean error message from Axios Google Ads errors
function adsError(e) {
  return e.response?.data?.error?.message
    || e.response?.data?.error?.errors?.[0]?.message
    || e.message;
}

// ── Pre-built Sathvam campaign templates ─────────────────────────────────────
//
// Google Ads Geo Target IDs (India):
//   2356       = India (country)
//   20470      = Tamil Nadu (state)
//   20461      = Kerala (state)
//   1007768    = Bangalore (city) / Bengaluru
//   1007805    = Hyderabad (city)
//
// Language Constant IDs:
//   1000 = English
//   1003 = Tamil
//   1099 = Telugu
//   1109 = Malayalam
//
const SATHVAM_CAMPAIGNS = [
  {
    key:       'tamilnadu',
    name:      'Sathvam - Tamil Nadu',
    geoIds:    [20470],
    langIds:   ['1000', '1003'],
    adGroups: [
      {
        name: 'Cold Pressed Oil - Tamil Nadu',
        keywords: [
          { text: 'cold pressed oil tamil nadu',              matchType: 'PHRASE' },
          { text: 'wood pressed oil karur',                   matchType: 'PHRASE' },
          { text: 'cold pressed groundnut oil tamil nadu',    matchType: 'PHRASE' },
          { text: 'cold pressed sesame oil tamil nadu',       matchType: 'PHRASE' },
          { text: 'chemical free oil tamil nadu',             matchType: 'BROAD'  },
          { text: 'buy cold pressed oil online tamil nadu',   matchType: 'BROAD'  },
          { text: 'gingelly oil buy online tamil nadu',       matchType: 'BROAD'  },
          { text: 'groundnut oil karur factory',              matchType: 'BROAD'  },
        ],
        headlines: [
          'Pure Cold Pressed Oil TN',
          'Factory Direct from Karur',
          'No Chemicals No Preservatives',
          '100% Pure Groundnut Oil',
          'Free Delivery Above ₹2500',
          'Sesame Coconut Groundnut Oil',
          'Traditional Wood Pressed Oil',
          'Order Now & Save',
        ],
        descriptions: [
          'Buy pure cold-pressed groundnut, sesame & coconut oil direct from our Karur factory. No hexane, no chemicals. Free delivery in Tamil Nadu above ₹2500.',
          'Sathvam Natural Products — chemical-free cold pressed oils & millets from Karur, Tamil Nadu. Trusted by 10,000+ families. Order at sathvam.in',
        ],
        finalUrl: 'https://www.sathvam.in/shop',
      },
      {
        name: 'Millets & Spices - Tamil Nadu',
        keywords: [
          { text: 'buy millets online tamil nadu',            matchType: 'PHRASE' },
          { text: 'organic millets tamil nadu',               matchType: 'PHRASE' },
          { text: 'ragi buy online tamil nadu',               matchType: 'BROAD'  },
          { text: 'foxtail millet online karur',              matchType: 'BROAD'  },
          { text: 'organic spices buy online tamil nadu',     matchType: 'BROAD'  },
        ],
        headlines: [
          'Organic Millets Tamil Nadu',
          'Ragi Foxtail Kodo Millets',
          'Stone-Cleaned Ancient Grains',
          'Buy Millets Direct Factory',
          'Free Delivery Above ₹2500',
          'Organic Spices from Karur',
        ],
        descriptions: [
          'Shop finger millet, foxtail millet, kodo millet & more. Stone-cleaned, chemical-free. Direct from Karur factory. Free delivery in Tamil Nadu.',
          'Sathvam millets & spices — 100% natural, no pesticides. Factory direct pricing. Order online at sathvam.in',
        ],
        finalUrl: 'https://www.sathvam.in/shop',
      },
    ],
  },
  {
    key:       'bangalore',
    name:      'Sathvam - Bangalore',
    geoIds:    [1007768],
    langIds:   ['1000', '1003'],
    adGroups: [
      {
        name: 'Cold Pressed Oil - Bangalore',
        keywords: [
          { text: 'cold pressed oil bangalore',               matchType: 'PHRASE' },
          { text: 'wood pressed oil bengaluru',               matchType: 'PHRASE' },
          { text: 'buy cold pressed oil bangalore',           matchType: 'PHRASE' },
          { text: 'organic oil delivery bangalore',           matchType: 'PHRASE' },
          { text: 'chemical free oil bangalore',              matchType: 'BROAD'  },
          { text: 'pure groundnut oil bangalore delivery',    matchType: 'BROAD'  },
          { text: 'natural sesame oil bengaluru',             matchType: 'BROAD'  },
          { text: 'hexane free oil bangalore',                matchType: 'BROAD'  },
        ],
        headlines: [
          'Cold Pressed Oil Bangalore',
          'Factory Direct from Karur',
          'Delivered to Bengaluru Fast',
          'No Chemicals No Preservatives',
          'Free Delivery Above ₹2500',
          'Pure Groundnut Sesame Oil',
          'Order Now — 3-5 Day Delivery',
          'Trusted by 10000+ Families',
        ],
        descriptions: [
          'Get 100% pure cold-pressed oils delivered to Bangalore in 3-5 days. Groundnut, sesame, coconut oil direct from our Karur factory. Free delivery above ₹2500.',
          'Sathvam Natural Products — chemical-free, hexane-free cold pressed oils & millets. Trusted by families across Bengaluru. Shop at sathvam.in',
        ],
        finalUrl: 'https://www.sathvam.in/shop',
      },
    ],
  },
  {
    key:       'hyderabad',
    name:      'Sathvam - Hyderabad',
    geoIds:    [1007805],
    langIds:   ['1000', '1099'],
    adGroups: [
      {
        name: 'Cold Pressed Oil - Hyderabad',
        keywords: [
          { text: 'cold pressed oil hyderabad',               matchType: 'PHRASE' },
          { text: 'cold pressed sesame oil hyderabad',        matchType: 'PHRASE' },
          { text: 'buy natural oil hyderabad',                matchType: 'PHRASE' },
          { text: 'organic oil delivery hyderabad',           matchType: 'PHRASE' },
          { text: 'wood pressed oil hyderabad',               matchType: 'BROAD'  },
          { text: 'pure groundnut oil telangana',             matchType: 'BROAD'  },
          { text: 'chemical free cooking oil hyderabad',      matchType: 'BROAD'  },
        ],
        headlines: [
          'Cold Pressed Oil Hyderabad',
          'Delivered from Karur Factory',
          'No Chemicals Pure Oil',
          'Free Delivery Above ₹2500',
          'Sesame Groundnut Coconut Oil',
          'Order Now 3-5 Day Delivery',
          'Sathvam Natural Products',
          'Trusted by 10000+ Families',
        ],
        descriptions: [
          'Pure cold-pressed sesame oil, groundnut oil & coconut oil delivered to Hyderabad in 3-5 days. No hexane, no chemicals. Factory direct pricing.',
          'Sathvam Natural Products — 100% chemical-free oils from Karur, Tamil Nadu. Order online and get delivery anywhere in Telangana & Hyderabad.',
        ],
        finalUrl: 'https://www.sathvam.in/shop',
      },
    ],
  },
  {
    key:       'kerala',
    name:      'Sathvam - Kerala',
    geoIds:    [20461],
    langIds:   ['1000', '1109'],
    adGroups: [
      {
        name: 'Cold Pressed Oil - Kerala',
        keywords: [
          { text: 'cold pressed oil kerala',                  matchType: 'PHRASE' },
          { text: 'cold pressed coconut oil kerala',          matchType: 'PHRASE' },
          { text: 'natural oil kerala',                       matchType: 'PHRASE' },
          { text: 'buy organic oil kerala',                   matchType: 'PHRASE' },
          { text: 'cold pressed sesame oil kochi',            matchType: 'BROAD'  },
          { text: 'pure coconut oil thrissur',                matchType: 'BROAD'  },
          { text: 'chemical free oil kerala delivery',        matchType: 'BROAD'  },
          { text: 'wood pressed oil kozhikode',               matchType: 'BROAD'  },
        ],
        headlines: [
          'Cold Pressed Oil Kerala',
          'Pure Coconut Sesame Oil',
          'Delivered to Kochi Thrissur',
          'No Chemicals No Preservatives',
          'Factory Direct from Karur',
          'Free Delivery Above ₹2500',
          'Order Now 3-5 Days',
          'Trusted Natural Products',
        ],
        descriptions: [
          'Pure cold-pressed coconut oil, sesame oil & groundnut oil delivered across Kerala. No hexane, no chemicals. Free delivery above ₹2500.',
          'Sathvam Natural Products — traditional factory-direct oils delivered to Kochi, Thrissur, Kozhikode and all of Kerala in 3-5 days.',
        ],
        finalUrl: 'https://www.sathvam.in/shop',
      },
    ],
  },
  {
    key:       'panindia',
    name:      'Sathvam - Pan India',
    geoIds:    [2356],
    langIds:   ['1000'],
    adGroups: [
      {
        name: 'Cold Pressed Oil - Pan India',
        keywords: [
          { text: 'buy cold pressed oil online india',        matchType: 'PHRASE' },
          { text: 'cold pressed oil delivery india',          matchType: 'PHRASE' },
          { text: 'pure wood pressed oil buy online',         matchType: 'PHRASE' },
          { text: 'chemical free cooking oil india',          matchType: 'BROAD'  },
          { text: 'hexane free oil india',                    matchType: 'BROAD'  },
          { text: 'factory direct cold pressed oil',          matchType: 'BROAD'  },
          { text: 'buy groundnut oil online india',           matchType: 'BROAD'  },
        ],
        headlines: [
          'Buy Cold Pressed Oil Online',
          'Delivered Pan India',
          'No Chemicals No Hexane',
          'Factory Direct from Karur',
          'Free Delivery Above ₹2500',
          'Pure Groundnut Sesame Oil',
          'Trusted by 10000+ Families',
          'Order Now 3-5 Day Delivery',
        ],
        descriptions: [
          'Buy 100% pure cold-pressed oils online. Delivered anywhere in India in 3-5 days. Groundnut, sesame, coconut — chemical-free, factory direct from Karur.',
          "Sathvam Natural Products — India's trusted cold-pressed oil factory. 10,000+ families. No hexane, no chemicals. Free delivery above ₹2500.",
        ],
        finalUrl: 'https://www.sathvam.in/shop',
      },
      {
        name: 'Millets - Pan India',
        keywords: [
          { text: 'buy millets online india',                 matchType: 'PHRASE' },
          { text: 'organic millets buy online',               matchType: 'PHRASE' },
          { text: 'finger millet ragi buy online',            matchType: 'BROAD'  },
          { text: 'foxtail millet online india',              matchType: 'BROAD'  },
          { text: 'kodo millet buy online',                   matchType: 'BROAD'  },
        ],
        headlines: [
          'Buy Millets Online India',
          'Ragi Foxtail Kodo Millets',
          'Organic Millets Delivered',
          'Factory Direct Pricing',
          'Free Delivery Above ₹2500',
          'Stone-Cleaned Ancient Grains',
        ],
        descriptions: [
          'Shop organic finger millet, foxtail millet, kodo millet & 10+ varieties. Stone-cleaned, chemical-free. Delivered pan India. Free delivery above ₹2500.',
          'Sathvam millets — traditional varieties, factory direct from Karur. 100% natural, no preservatives. Order online at sathvam.in',
        ],
        finalUrl: 'https://www.sathvam.in/shop',
      },
    ],
  },
];

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/google-ads/status
 * Check if env vars are configured and verify API connectivity.
 */
router.get('/status', auth, requireAdminOrCeo, async (req, res) => {
  const missing = checkConfig();
  if (missing.length) return res.json({ configured: false, missing });

  try {
    const token = await getAccessToken();
    const { data } = await axios.get(`${ADS_BASE}/customers/${cid()}`, {
      headers: adsHeaders(token),
    });
    res.json({
      configured: true,
      account: {
        id:           data.id,
        name:         data.descriptiveName,
        currencyCode: data.currencyCode,
        timeZone:     data.timeZone,
      },
    });
  } catch (e) {
    res.json({ configured: false, error: adsError(e) });
  }
});

/**
 * GET /api/google-ads/campaigns
 * List all campaigns with key metrics.
 */
router.get('/campaigns', auth, requireAdminOrCeo, async (req, res) => {
  const missing = checkConfig();
  if (missing.length) return res.status(503).json({ error: 'Google Ads not configured', missing });

  try {
    const token = await getAccessToken();
    const query = `
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        campaign.advertising_channel_type,
        campaign_budget.amount_micros,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions,
        metrics.average_cpc,
        metrics.ctr
      FROM campaign
      WHERE campaign.status != 'REMOVED'
        AND segments.date DURING LAST_30_DAYS
      ORDER BY campaign.name
    `;
    const { data } = await axios.post(
      `${ADS_BASE}/customers/${cid()}/googleAds:search`,
      { query },
      { headers: adsHeaders(token) }
    );

    const campaigns = (data.results || []).map(r => ({
      id:             r.campaign.id,
      name:           r.campaign.name,
      status:         r.campaign.status,
      budgetINR:      (Number(r.campaignBudget?.amountMicros || 0) / 1000000).toFixed(0),
      impressions:    Number(r.metrics.impressions || 0),
      clicks:         Number(r.metrics.clicks || 0),
      costINR:        (Number(r.metrics.costMicros || 0) / 1000000).toFixed(2),
      conversions:    Number(r.metrics.conversions || 0),
      avgCpcINR:      (Number(r.metrics.averageCpc || 0) / 1000000).toFixed(2),
      ctr:            (Number(r.metrics.ctr || 0) * 100).toFixed(2) + '%',
    }));

    res.json(campaigns);
  } catch (e) {
    res.status(500).json({ error: adsError(e) });
  }
});

/**
 * POST /api/google-ads/campaigns
 * Create a single custom campaign.
 * Body: { name, dailyBudgetINR, locationIds, languageIds, status }
 */
router.post('/campaigns', auth, requireAdminOrCeo, async (req, res) => {
  const missing = checkConfig();
  if (missing.length) return res.status(503).json({ error: 'Google Ads not configured', missing });

  try {
    const {
      name,
      dailyBudgetINR = 500,
      locationIds    = [2356],   // India default
      languageIds    = ['1000'],  // English default
      status         = 'PAUSED',
    } = req.body;

    if (!name) return res.status(400).json({ error: 'Campaign name required' });

    const token   = await getAccessToken();
    const headers = adsHeaders(token);
    const c       = cid();

    // Budget
    const budgetRes = await axios.post(
      `${ADS_BASE}/customers/${c}/campaignBudgets:mutate`,
      { operations: [{ create: { name: `${name} Budget`, amountMicros: dailyBudgetINR * 1000000, deliveryMethod: 'STANDARD' } }] },
      { headers }
    );
    const budgetRN = budgetRes.data.results[0].resourceName;

    // Campaign
    const campRes = await axios.post(
      `${ADS_BASE}/customers/${c}/campaigns:mutate`,
      { operations: [{ create: {
        name,
        status,
        advertisingChannelType: 'SEARCH',
        campaignBudget:         budgetRN,
        biddingStrategyType:    'MAXIMIZE_CLICKS',
        targetSpend:            {},
        networkSettings:        { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false },
      }}] },
      { headers }
    );
    const campRN = campRes.data.results[0].resourceName;
    const campId = campRN.split('/').pop();

    // Geo targets
    await axios.post(
      `${ADS_BASE}/customers/${c}/campaignCriteria:mutate`,
      { operations: locationIds.map(id => ({ create: { campaign: campRN, type: 'LOCATION', location: { geoTargetConstant: `geoTargetConstants/${id}` } } })) },
      { headers }
    );

    // Language targets
    await axios.post(
      `${ADS_BASE}/customers/${c}/campaignCriteria:mutate`,
      { operations: languageIds.map(id => ({ create: { campaign: campRN, type: 'LANGUAGE', language: { languageConstant: `languageConstants/${id}` } } })) },
      { headers }
    );

    res.json({ success: true, campaignId: campId, resourceName: campRN });
  } catch (e) {
    res.status(500).json({ error: adsError(e), details: e.response?.data });
  }
});

/**
 * PATCH /api/google-ads/campaigns/:id/status
 * Enable, pause, or remove a campaign.
 * Body: { status: 'ENABLED'|'PAUSED'|'REMOVED' }
 */
router.patch('/campaigns/:id/status', auth, requireAdminOrCeo, async (req, res) => {
  const missing = checkConfig();
  if (missing.length) return res.status(503).json({ error: 'Google Ads not configured', missing });

  try {
    const { status } = req.body;
    if (!['ENABLED', 'PAUSED', 'REMOVED'].includes(status))
      return res.status(400).json({ error: 'status must be ENABLED, PAUSED, or REMOVED' });

    const token = await getAccessToken();
    const c     = cid();
    const rn    = `customers/${c}/campaigns/${req.params.id}`;

    await axios.post(
      `${ADS_BASE}/customers/${c}/campaigns:mutate`,
      { operations: [{ update: { resourceName: rn, status }, updateMask: 'status' }] },
      { headers: adsHeaders(token) }
    );

    res.json({ success: true, campaignId: req.params.id, status });
  } catch (e) {
    res.status(500).json({ error: adsError(e) });
  }
});

/**
 * GET /api/google-ads/reports?days=30
 * Performance report: impressions, clicks, spend, conversions per campaign.
 */
router.get('/reports', auth, requireAdminOrCeo, async (req, res) => {
  const missing = checkConfig();
  if (missing.length) return res.status(503).json({ error: 'Google Ads not configured', missing });

  try {
    const days  = Math.min(Number(req.query.days) || 30, 90);
    const token = await getAccessToken();

    const query = `
      SELECT
        campaign.name,
        campaign.status,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions,
        metrics.average_cpc,
        metrics.ctr
      FROM campaign
      WHERE segments.date DURING LAST_${days}_DAYS
        AND campaign.status != 'REMOVED'
      ORDER BY metrics.cost_micros DESC
    `;
    const { data } = await axios.post(
      `${ADS_BASE}/customers/${cid()}/googleAds:search`,
      { query },
      { headers: adsHeaders(token) }
    );

    // Aggregate by campaign (multiple date rows get merged)
    const map = {};
    for (const r of (data.results || [])) {
      const key = r.campaign.name;
      if (!map[key]) map[key] = { name: key, status: r.campaign.status, impressions: 0, clicks: 0, costINR: 0, conversions: 0 };
      map[key].impressions += Number(r.metrics.impressions || 0);
      map[key].clicks      += Number(r.metrics.clicks || 0);
      map[key].costINR     += Number(r.metrics.costMicros || 0) / 1000000;
      map[key].conversions += Number(r.metrics.conversions || 0);
    }

    const campaigns = Object.values(map).map(c => ({
      ...c,
      costINR:  c.costINR.toFixed(2),
      ctr:      c.clicks && c.impressions ? ((c.clicks / c.impressions) * 100).toFixed(2) + '%' : '0%',
      cpcINR:   c.clicks ? (c.costINR / c.clicks).toFixed(2) : '0',
    }));

    res.json({ days, campaigns, totalSpendINR: campaigns.reduce((s, c) => s + Number(c.costINR), 0).toFixed(2) });
  } catch (e) {
    res.status(500).json({ error: adsError(e) });
  }
});

/**
 * POST /api/google-ads/setup-sathvam
 * One-click: creates all 5 city campaigns with ad groups, keywords, and responsive search ads.
 * Body: { dailyBudgetINR: 500, status: 'PAUSED' }
 *
 * All campaigns are created PAUSED by default — review in Google Ads dashboard before enabling.
 */
router.post('/setup-sathvam', auth, requireAdminOrCeo, async (req, res) => {
  const missing = checkConfig();
  if (missing.length) return res.status(503).json({ error: 'Google Ads not configured', missing });

  const { dailyBudgetINR = 500, status = 'PAUSED' } = req.body;
  const log     = [];
  const errors  = [];
  const results = {};

  try {
    const token   = await getAccessToken();
    const headers = adsHeaders(token);
    const c       = cid();

    for (const camp of SATHVAM_CAMPAIGNS) {
      try {
        // 1. Campaign budget
        const budgetRes = await axios.post(
          `${ADS_BASE}/customers/${c}/campaignBudgets:mutate`,
          { operations: [{ create: { name: `${camp.name} Budget`, amountMicros: dailyBudgetINR * 1000000, deliveryMethod: 'STANDARD' } }] },
          { headers }
        );
        const budgetRN = budgetRes.data.results[0].resourceName;

        // 2. Campaign
        const campRes = await axios.post(
          `${ADS_BASE}/customers/${c}/campaigns:mutate`,
          { operations: [{ create: {
            name: camp.name, status,
            advertisingChannelType: 'SEARCH',
            campaignBudget:         budgetRN,
            biddingStrategyType:    'MAXIMIZE_CLICKS',
            targetSpend:            {},
            networkSettings:        { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false },
          }}] },
          { headers }
        );
        const campRN = campRes.data.results[0].resourceName;

        // 3. Geo targets
        await axios.post(
          `${ADS_BASE}/customers/${c}/campaignCriteria:mutate`,
          { operations: camp.geoIds.map(id => ({ create: { campaign: campRN, type: 'LOCATION', location: { geoTargetConstant: `geoTargetConstants/${id}` } } })) },
          { headers }
        );

        // 4. Language targets
        await axios.post(
          `${ADS_BASE}/customers/${c}/campaignCriteria:mutate`,
          { operations: camp.langIds.map(id => ({ create: { campaign: campRN, type: 'LANGUAGE', language: { languageConstant: `languageConstants/${id}` } } })) },
          { headers }
        );

        const agResults = [];

        // 5. Ad groups, keywords, ads
        for (const ag of camp.adGroups) {
          // Ad group
          const agRes = await axios.post(
            `${ADS_BASE}/customers/${c}/adGroups:mutate`,
            { operations: [{ create: { name: ag.name, campaign: campRN, status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidMicros: 5000000 } }] },
            { headers }
          );
          const agRN = agRes.data.results[0].resourceName;

          // Keywords
          await axios.post(
            `${ADS_BASE}/customers/${c}/adGroupCriteria:mutate`,
            { operations: ag.keywords.map(kw => ({ create: { adGroup: agRN, status: 'ENABLED', keyword: { text: kw.text, matchType: kw.matchType } } })) },
            { headers }
          );

          // Responsive Search Ad
          await axios.post(
            `${ADS_BASE}/customers/${c}/adGroupAds:mutate`,
            { operations: [{ create: {
              adGroup: agRN,
              status:  'ENABLED',
              ad: {
                finalUrls:          [ag.finalUrl],
                responsiveSearchAd: {
                  headlines:    ag.headlines.map((text, i) => ({ text, ...(i === 0 ? { pinnedField: 'HEADLINE_1' } : {}) })),
                  descriptions: ag.descriptions.map(text => ({ text })),
                },
              },
            }}] },
            { headers }
          );

          agResults.push({ name: ag.name, keywords: ag.keywords.length });
        }

        results[camp.key] = { campaign: camp.name, status, adGroups: agResults };
        log.push(`✅ ${camp.name} — ${camp.adGroups.length} ad group(s) created`);
      } catch (e) {
        const msg = adsError(e);
        errors.push(`❌ ${camp.name}: ${msg}`);
        results[camp.key] = { error: msg };
      }
    }

    res.json({
      success: errors.length === 0,
      log,
      errors,
      results,
      note: 'All campaigns created as PAUSED. Review keywords and ads in Google Ads dashboard, then enable each campaign.',
    });
  } catch (e) {
    res.status(500).json({ error: adsError(e) });
  }
});

/**
 * GET /api/google-ads/keywords?campaignId=xxx
 * List all keywords across ad groups for a campaign.
 */
router.get('/keywords', auth, requireAdminOrCeo, async (req, res) => {
  const missing = checkConfig();
  if (missing.length) return res.status(503).json({ error: 'Google Ads not configured', missing });

  try {
    const { campaignId } = req.query;
    const token = await getAccessToken();

    const where = campaignId
      ? `WHERE campaign.id = ${campaignId} AND ad_group_criterion.type = 'KEYWORD'`
      : `WHERE ad_group_criterion.type = 'KEYWORD' AND campaign.status != 'REMOVED'`;

    const query = `
      SELECT
        campaign.name,
        ad_group.name,
        ad_group_criterion.keyword.text,
        ad_group_criterion.keyword.match_type,
        ad_group_criterion.status,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.average_cpc
      FROM ad_group_criterion
      ${where}
        AND segments.date DURING LAST_30_DAYS
      ORDER BY metrics.impressions DESC
      LIMIT 200
    `;

    const { data } = await axios.post(
      `${ADS_BASE}/customers/${cid()}/googleAds:search`,
      { query },
      { headers: adsHeaders(token) }
    );

    const keywords = (data.results || []).map(r => ({
      campaign:    r.campaign.name,
      adGroup:     r.adGroup.name,
      keyword:     r.adGroupCriterion.keyword.text,
      matchType:   r.adGroupCriterion.keyword.matchType,
      status:      r.adGroupCriterion.status,
      impressions: Number(r.metrics.impressions || 0),
      clicks:      Number(r.metrics.clicks || 0),
      costINR:     (Number(r.metrics.costMicros || 0) / 1000000).toFixed(2),
      avgCpcINR:   (Number(r.metrics.averageCpc || 0) / 1000000).toFixed(2),
    }));

    res.json(keywords);
  } catch (e) {
    res.status(500).json({ error: adsError(e) });
  }
});

module.exports = router;
