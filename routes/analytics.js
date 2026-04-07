const express = require('express');
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');
const router = express.Router();

const TODAY = () => new Date().toISOString().slice(0, 10);

// Helper — atomic upsert of a JSON blob in store_analytics
async function updateAnalytics(key, updater, def = {}) {
  const { data } = await supabase.from('store_analytics').select('id,data').eq('key', key).single();
  const current = data?.data ?? def;
  const updated = updater(current);
  if (data?.id) {
    await supabase.from('store_analytics').update({ data: updated }).eq('key', key);
  } else {
    await supabase.from('store_analytics').insert({ key, data: updated });
  }
}

// POST /api/analytics/track  (public — called from website, no auth)
router.post('/track', async (req, res) => {
  try {
    const { type, path, title, product_id, product_name } = req.body;
    const today = TODAY();

    if (type === 'visit') {
      await updateAnalytics('visits', d => ({ ...d, [today]: (d[today] || 0) + 1 }));
    }

    if (type === 'page_view' && path) {
      await updateAnalytics('page_views', d => {
        const entry = d[path] || { title: title || path, count: 0 };
        return { ...d, [path]: { ...entry, title: title || entry.title, count: entry.count + 1 } };
      });
    }

    if (type === 'product_view' && product_id) {
      await updateAnalytics('product_views', d => {
        const entry = d[product_id] || { name: product_name || product_id, count: 0 };
        return { ...d, [product_id]: { ...entry, name: product_name || entry.name, count: entry.count + 1 } };
      });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function getAKey(key, def = {}) {
  const { data } = await supabase.from('store_analytics').select('data').eq('key', key).single();
  return data?.data ?? def;
}

// GET /api/analytics — full analytics summary for admin dashboard
router.get('/', auth, async (req, res) => {
  try {
    const [visits, pageViews, productViews, { data: carts }] = await Promise.all([
      getAKey('visits', {}),
      getAKey('page_views', {}),
      getAKey('product_views', {}),
      supabase.from('abandoned_carts').select('*').eq('recovered', false)
        .order('updated_at', { ascending: false }).limit(200),
    ]);

    const now = new Date();

    // Last 7 days (daily)
    const daily = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now);
      d.setDate(d.getDate() - 6 + i);
      const ds = d.toISOString().slice(0, 10);
      return { date: ds, label: `${d.getDate()}/${d.getMonth() + 1}`, count: visits[ds] || 0 };
    });

    // Last 12 months (monthly)
    const monthly = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
      const prefix = d.toISOString().slice(0, 7);
      const count = Object.entries(visits).filter(([k]) => k.startsWith(prefix)).reduce((s, [, v]) => s + v, 0);
      return { month: prefix, label: d.toLocaleString('en', { month: 'short' }), count };
    });

    // Current year (monthly breakdown)
    const yr = now.getFullYear().toString();
    const yearly = Array.from({ length: 12 }, (_, i) => {
      const prefix = `${yr}-${String(i + 1).padStart(2, '0')}`;
      const count = Object.entries(visits).filter(([k]) => k.startsWith(prefix)).reduce((s, [, v]) => s + v, 0);
      const d = new Date(parseInt(yr), i, 1);
      return { month: prefix, label: d.toLocaleString('en', { month: 'short' }), count };
    });

    // Top pages
    const topPages = Object.entries(pageViews)
      .map(([path, v]) => ({ path, title: v.title || path, count: v.count }))
      .sort((a, b) => b.count - a.count).slice(0, 10);

    // Top products by views
    const topProductViews = Object.entries(productViews)
      .map(([id, v]) => ({ id, name: v.name || id, count: v.count }))
      .sort((a, b) => b.count - a.count).slice(0, 10);

    // Abandoned cart product aggregation
    const abMap = {};
    for (const cart of (carts || [])) {
      for (const item of (cart.items || [])) {
        const key = item.id || item.name;
        if (!abMap[key]) abMap[key] = { name: item.name || key, qty: 0, carts: 0 };
        abMap[key].qty += item.qty || 1;
        abMap[key].carts += 1;
      }
    }
    const topAbandoned = Object.values(abMap).sort((a, b) => b.carts - a.carts).slice(0, 10);

    const totalVisits = Object.values(visits).reduce((s, v) => s + v, 0);
    const todayVisits = visits[TODAY()] || 0;
    const thisMonthVisits = monthly[11]?.count || 0;

    res.json({
      visits: { daily, monthly, yearly, total: totalVisits, today: todayVisits, thisMonth: thisMonthVisits },
      topPages,
      topProductViews,
      topAbandoned,
      abandonedCartCount: (carts || []).length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
