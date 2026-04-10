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
    const { type, path, title, product_id, product_name,
            session_id, items, customer_name, customer_phone, customer_email,
            cart_total, order_no } = req.body;
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

    // ── Funnel events ──────────────────────────────────────────────────────────

    if (type === 'add_to_cart') {
      await updateAnalytics('funnel_add_to_cart', d => ({ ...d, [today]: (d[today] || 0) + 1 }));
    }

    if (type === 'checkout_start') {
      await updateAnalytics('funnel_checkout_start', d => ({ ...d, [today]: (d[today] || 0) + 1 }));
      // Store checkout session for follow-up (using store_analytics as KV store)
      if (session_id && (customer_name || customer_phone)) {
        const key = `_cs_${session_id}`;
        const sessionData = {
          customer_name: customer_name || null,
          customer_phone: customer_phone || null,
          customer_email: customer_email || null,
          items: (items || []).slice(0, 5).map(i => ({ name: i.name || i.id, qty: i.qty || 1 })),
          cart_total: cart_total || 0,
          recovered: false,
          date: today,
          updated_at: new Date().toISOString(),
        };
        const { data: existing } = await supabase.from('store_analytics').select('id').eq('key', key).single();
        if (existing?.id) {
          await supabase.from('store_analytics').update({ data: sessionData }).eq('key', key);
        } else {
          await supabase.from('store_analytics').insert({ key, data: sessionData });
        }
      }
    }

    if (type === 'order_placed') {
      await updateAnalytics('funnel_order_placed', d => ({ ...d, [today]: (d[today] || 0) + 1 }));
      // Mark checkout session as recovered
      if (session_id) {
        const key = `_cs_${session_id}`;
        const { data: existing } = await supabase.from('store_analytics').select('id,data').eq('key', key).single();
        if (existing?.id) {
          await supabase.from('store_analytics').update({
            data: { ...existing.data, recovered: true, order_no: order_no || null }
          }).eq('key', key);
        }
      }
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

// Aggregate daily counts from a key-value store entry over last N days
function sumDays(data, days = 30) {
  const now = new Date();
  let total = 0;
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const ds = d.toISOString().slice(0, 10);
    total += data[ds] || 0;
  }
  return total;
}

// GET /api/analytics — full analytics summary for admin dashboard
router.get('/', auth, async (req, res) => {
  try {
    const [visits, pageViews, productViews, funnelCart, funnelCheckout, funnelOrder, { data: carts }, { data: checkoutSessions }] = await Promise.all([
      getAKey('visits', {}),
      getAKey('page_views', {}),
      getAKey('product_views', {}),
      getAKey('funnel_add_to_cart', {}),
      getAKey('funnel_checkout_start', {}),
      getAKey('funnel_order_placed', {}),
      supabase.from('abandoned_carts').select('*').eq('recovered', false)
        .order('updated_at', { ascending: false }).limit(200),
      supabase.from('store_analytics').select('key,data').like('key', '_cs_%').order('id', { ascending: false }).limit(100),
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

    // Funnel — last 30 days
    const funnelData = {
      visits:          sumDays(visits, 30),
      add_to_cart:     sumDays(funnelCart, 30),
      checkout_start:  sumDays(funnelCheckout, 30),
      order_placed:    sumDays(funnelOrder, 30),
    };

    // Abandoned checkouts with customer info (for follow-up)
    const abandonedCheckouts = (checkoutSessions || [])
      .map(row => row.data)
      .filter(d => d && !d.recovered && (d.customer_phone || d.customer_name))
      .map(d => ({
        customer_name: d.customer_name,
        customer_phone: d.customer_phone,
        customer_email: d.customer_email,
        cart_total: d.cart_total || 0,
        items: (d.items || []).map(i => i.name).join(', '),
        item_count: (d.items || []).length,
        updated_at: d.updated_at,
      }))
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    res.json({
      visits: { daily, monthly, yearly, total: totalVisits, today: todayVisits, thisMonth: thisMonthVisits },
      topPages,
      topProductViews,
      topAbandoned,
      abandonedCartCount: (carts || []).length,
      funnel: funnelData,
      abandonedCheckouts,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/pnl?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get('/pnl', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    const start = req.query.start || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
    const end   = req.query.end   || today;

    const [salesRes, wsoRes, b2bRes, procRes, expRes] = await Promise.allSettled([
      // Revenue: local sales
      supabase.from('sales').select('final_amount,date').gte('date',start).lte('date',end).eq('status','paid'),
      // Revenue: webstore orders
      supabase.from('webstore_orders').select('total,date,created_at').gte('date',start).lte('date',end).in('status',['confirmed','shipped','delivered','paid']),
      // Revenue: B2B orders
      supabase.from('b2b_orders').select('total_value,date').gte('date',start).lte('date',end).in('stage',['shipped','delivered','invoice_sent','paid']),
      // Cost: procurement
      supabase.from('procurements').select('ordered_qty,ordered_price_per_kg,gst,date').gte('date',start).lte('date',end).in('status',['received','stocked','cleaned']),
      // Cost: expenses
      supabase.from('company_expenses').select('amount,category,date').gte('date',start).lte('date',end).is('deleted_at',null),
    ]);

    const sales   = salesRes.value?.data || [];
    const wso     = wsoRes.value?.data || [];
    const b2b     = b2bRes.value?.data || [];
    const procs   = procRes.value?.data || [];
    const expenses= expRes.value?.data || [];

    const rev_sales   = sales.reduce((s,r)=>s+parseFloat(r.final_amount||0),0);
    const rev_webstore= wso.reduce((s,r)=>s+parseFloat(r.total||0),0);
    const rev_b2b     = b2b.reduce((s,r)=>s+parseFloat(r.total_value||0),0);
    const total_revenue = rev_sales + rev_webstore + rev_b2b;

    const cost_procurement = procs.reduce((s,r)=>{
      const qty = parseFloat(r.ordered_qty||0);
      const rate= parseFloat(r.ordered_price_per_kg||0);
      const gst = parseFloat(r.gst||0);
      return s + qty * rate * (1 + gst/100);
    },0);
    const cost_expenses = expenses.reduce((s,r)=>s+parseFloat(r.amount||0),0);
    const total_cost    = cost_procurement + cost_expenses;
    const gross_profit  = total_revenue - total_cost;

    // Revenue by day for chart
    const revenueByDay = {};
    for (const r of sales)  { const d=r.date; revenueByDay[d]=(revenueByDay[d]||0)+parseFloat(r.final_amount||0); }
    for (const r of wso)    { const d=(r.date||r.created_at||'').slice(0,10); revenueByDay[d]=(revenueByDay[d]||0)+parseFloat(r.total||0); }
    for (const r of b2b)    { const d=r.date; revenueByDay[d]=(revenueByDay[d]||0)+parseFloat(r.total_value||0); }

    // Expenses by category
    const expByCategory = {};
    for (const r of expenses) {
      const cat = r.category || 'Other';
      expByCategory[cat] = (expByCategory[cat] || 0) + parseFloat(r.amount||0);
    }

    res.json({
      period: { start, end },
      revenue: { sales: rev_sales, webstore: rev_webstore, b2b: rev_b2b, total: total_revenue },
      costs:   { procurement: cost_procurement, expenses: cost_expenses, total: total_cost },
      gross_profit,
      margin_pct: total_revenue > 0 ? ((gross_profit / total_revenue) * 100).toFixed(1) : 0,
      revenue_by_day: revenueByDay,
      expenses_by_category: expByCategory,
      counts: { sales: sales.length, webstore_orders: wso.length, b2b_orders: b2b.length },
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/analytics/dashboard — quick stats for dashboard header
router.get('/dashboard', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate()-7);
    const weekStart = weekAgo.toISOString().slice(0,10);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);

    const [todaySales, pendingWSO, pendingB2B, lowRaw] = await Promise.allSettled([
      // Today's revenue across all channels
      Promise.allSettled([
        supabase.from('sales').select('final_amount').eq('date',today).eq('status','paid'),
        supabase.from('webstore_orders').select('total').eq('date',today).in('status',['confirmed','shipped','delivered','paid']),
        supabase.from('b2b_orders').select('total_value').eq('date',today).not('stage','in','("cancelled")'),
      ]),
      // Pending webstore orders
      supabase.from('webstore_orders').select('id',{count:'exact'}).in('status',['confirmed','processing']),
      // Pending B2B orders
      supabase.from('b2b_orders').select('id',{count:'exact'}).not('stage','in','("shipped","delivered","cancelled","invoice_sent")'),
      // Low raw materials
      supabase.from('raw_materials').select('id',{count:'exact'}).eq('active',true).gt('min_stock',0).lte('current_stock', supabase.raw?.('min_stock') || 0),
    ]);

    const salesRows = todaySales.value?.[0].value?.data || [];
    const wsoRows   = todaySales.value?.[1].value?.data || [];
    const b2bRows   = todaySales.value?.[2].value?.data || [];

    const today_revenue = [
      ...salesRows.map(r=>parseFloat(r.final_amount||0)),
      ...wsoRows.map(r=>parseFloat(r.total||0)),
      ...b2bRows.map(r=>parseFloat(r.total_value||0)),
    ].reduce((s,v)=>s+v,0);

    res.json({
      today_revenue,
      pending_webstore: pendingWSO.value?.count || 0,
      pending_b2b:      pendingB2B.value?.count || 0,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
