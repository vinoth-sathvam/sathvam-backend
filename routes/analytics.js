const express = require('express');
const https = require('https');
const http = require('http');
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');
const { decrypt } = require('../config/crypto');
const router = express.Router();

const TODAY = () => new Date().toISOString().slice(0, 10);

// IP geolocation using ip-api.com (free tier — HTTP only, no key needed)
const geoCache = new Map();
async function geoIP(ip) {
  if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.')) return null;
  if (geoCache.has(ip)) return geoCache.get(ip);
  return new Promise((resolve) => {
    http.get(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city`, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const geo = j.status === 'success' ? { country: j.country, state: j.regionName, city: j.city } : null;
          geoCache.set(ip, geo);
          resolve(geo);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// Helper — atomic upsert of a JSON blob in store_analytics
async function updateAnalytics(key, updater, def = {}) {
  const { data } = await supabase.from('store_analytics').select('data').eq('key', key).maybeSingle();
  const current = data?.data ?? def;
  const updated = updater(current);
  await supabase.from('store_analytics').upsert(
    { key, data: updated, updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  );
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

      // Geo tracking — fire and forget, don't block response
      const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
      geoIP(ip).then(geo => {
        if (!geo) return;
        const stateKey = geo.state || 'Unknown';
        const cityKey  = geo.city  || 'Unknown';
        updateAnalytics('visits_by_state', d => ({ ...d, [stateKey]: (d[stateKey] || 0) + 1 })).catch(e => console.error('[GEO] state write error:', e.message));
        updateAnalytics('visits_by_city',  d => ({ ...d, [cityKey]:  (d[cityKey]  || 0) + 1 })).catch(e => console.error('[GEO] city write error:', e.message));
      }).catch(e => console.error('[GEO] lookup error:', e.message));
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
      // Also track per-product
      if (product_id) {
        await updateAnalytics('product_cart_adds', d => {
          const entry = d[product_id] || { name: product_name || product_id, count: 0 };
          return { ...d, [product_id]: { ...entry, name: product_name || entry.name, count: entry.count + 1 } };
        });
      }
    }

    if (type === 'product_interest') {
      // Customer spent 25+ seconds on a product page — high intent signal
      if (product_id) {
        await updateAnalytics('product_interest', d => {
          const entry = d[product_id] || { name: product_name || product_id, count: 0 };
          return { ...d, [product_id]: { ...entry, name: product_name || entry.name, count: entry.count + 1 } };
        });
      }
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
    const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().slice(0, 10);

    const [visits, pageViews, productViews, productCartAdds, productInterest, funnelCart, funnelCheckout, funnelOrder, visitsByState, visitsByCity, { data: carts }, { data: checkoutSessions }, { data: recentOrders }] = await Promise.all([
      getAKey('visits', {}),
      getAKey('page_views', {}),
      getAKey('product_views', {}),
      getAKey('product_cart_adds', {}),
      getAKey('product_interest', {}),
      getAKey('funnel_add_to_cart', {}),
      getAKey('funnel_checkout_start', {}),
      getAKey('funnel_order_placed', {}),
      getAKey('visits_by_state', {}),
      getAKey('visits_by_city', {}),
      supabase.from('abandoned_carts').select('*').eq('recovered', false)
        .order('updated_at', { ascending: false }).limit(200),
      supabase.from('store_analytics').select('key,data').like('key', '_cs_%').order('id', { ascending: false }).limit(100),
      supabase.from('webstore_orders').select('items').gte('date', thirtyDaysAgoStr)
        .in('status', ['confirmed','shipped','delivered','paid']).limit(500),
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

    // Product opportunities — join views, cart adds, interest, orders
    const orderCountsByProduct = {};
    for (const order of (recentOrders || [])) {
      for (const item of (order.items || [])) {
        const key = item.id || item.name;
        if (key) orderCountsByProduct[key] = (orderCountsByProduct[key] || 0) + (item.qty || 1);
      }
    }
    // Build combined product table
    const allProductIds = new Set([
      ...Object.keys(productViews),
      ...Object.keys(productCartAdds),
      ...Object.keys(productInterest),
    ]);
    const productOpportunities = Array.from(allProductIds).map(id => {
      const views    = productViews[id]?.count || 0;
      const cartAdds = productCartAdds[id]?.count || 0;
      const interest = productInterest[id]?.count || 0;
      const orders   = orderCountsByProduct[id] || 0;
      const name     = productViews[id]?.name || productCartAdds[id]?.name || productInterest[id]?.name || id;
      const cartRate = views > 0 ? Math.round(cartAdds / views * 100) : 0;
      const orderRate = views > 0 ? Math.round(orders / views * 100) : 0;
      return { id, name, views, cartAdds, interest, orders, cartRate, orderRate };
    })
    .filter(p => p.views > 0)
    .sort((a, b) => b.views - a.views)
    .slice(0, 20);

    // State breakdown — sorted by visits
    const topStates = Object.entries(visitsByState)
      .map(([state, count]) => ({ state, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    // City breakdown — sorted by visits
    const topCities = Object.entries(visitsByCity)
      .map(([city, count]) => ({ city, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    res.json({
      visits: { daily, monthly, yearly, total: totalVisits, today: todayVisits, thisMonth: thisMonthVisits },
      topPages,
      topProductViews,
      topAbandoned,
      abandonedCartCount: (carts || []).length,
      funnel: funnelData,
      abandonedCheckouts,
      productOpportunities,
      topStates,
      topCities,
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

    // Compute previous period (same duration, immediately before)
    const startD = new Date(start), endD = new Date(end);
    const dur = Math.round((endD - startD) / (1000*86400));
    const prevEnd = new Date(startD); prevEnd.setDate(prevEnd.getDate()-1);
    const prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate()-dur);
    const prevStartStr = prevStart.toISOString().slice(0,10);
    const prevEndStr   = prevEnd.toISOString().slice(0,10);

    const LABOUR_PKG_CATS = ['labour','packaging','utilities','electricity','water'];

    const [salesRes, wsoRes, b2bRes, procRes, expRes,
           attRes, empRes,
           pSalesRes, pWsoRes, pB2bRes, pProcRes, pExpRes] = await Promise.allSettled([
      supabase.from('sales').select('final_amount,date').gte('date',start).lte('date',end).eq('status','paid'),
      supabase.from('webstore_orders').select('total,date,created_at').gte('date',start).lte('date',end).in('status',['confirmed','shipped','delivered','paid']),
      supabase.from('b2b_orders').select('total_value,date').gte('date',start).lte('date',end).in('stage',['shipped','delivered','invoice_sent','paid']),
      supabase.from('procurements').select('ordered_qty,ordered_price_per_kg,gst,date').gte('date',start).lte('date',end).in('status',['received','stocked','cleaned']),
      supabase.from('company_expenses').select('amount,category,date').gte('date',start).lte('date',end).is('deleted_at',null),
      // Payroll: attendance in period
      supabase.from('attendance').select('employee_id,status').gte('date',start).lte('date',end),
      supabase.from('employees').select('id,daily_rate'),
      // Previous period
      supabase.from('sales').select('final_amount,date').gte('date',prevStartStr).lte('date',prevEndStr).eq('status','paid'),
      supabase.from('webstore_orders').select('total,date,created_at').gte('date',prevStartStr).lte('date',prevEndStr).in('status',['confirmed','shipped','delivered','paid']),
      supabase.from('b2b_orders').select('total_value,date').gte('date',prevStartStr).lte('date',prevEndStr).in('stage',['shipped','delivered','invoice_sent','paid']),
      supabase.from('procurements').select('ordered_qty,ordered_price_per_kg,gst,date').gte('date',prevStartStr).lte('date',prevEndStr).in('status',['received','stocked','cleaned']),
      supabase.from('company_expenses').select('amount,category,date').gte('date',prevStartStr).lte('date',prevEndStr).is('deleted_at',null),
    ]);

    const sales   = salesRes.value?.data || [];
    const wso     = wsoRes.value?.data || [];
    const b2b     = b2bRes.value?.data || [];
    const procs   = procRes.value?.data || [];
    const expenses= expRes.value?.data || [];
    const attendance = attRes.value?.data || [];
    const empList    = empRes.value?.data || [];

    const pSales   = pSalesRes.value?.data || [];
    const pWso     = pWsoRes.value?.data || [];
    const pB2b     = pB2bRes.value?.data || [];
    const pProcs   = pProcRes.value?.data || [];
    const pExpenses= pExpRes.value?.data || [];

    // Revenue
    const rev_sales   = sales.reduce((s,r)=>s+parseFloat(r.final_amount||0),0);
    const rev_webstore= wso.reduce((s,r)=>s+parseFloat(r.total||0),0);
    const rev_b2b     = b2b.reduce((s,r)=>s+parseFloat(r.total_value||0),0);
    const total_revenue = rev_sales + rev_webstore + rev_b2b;

    // Procurement cost
    const cost_procurement = procs.reduce((s,r)=>{
      const qty = parseFloat(r.ordered_qty||0);
      const rate= parseFloat(r.ordered_price_per_kg||0);
      const gst = parseFloat(r.gst||0);
      return s + qty * rate * (1 + gst/100);
    },0);

    // Payroll for period
    const empRateMap = {};
    for (const e of empList) empRateMap[e.id] = parseFloat(e.daily_rate||0);
    const payrollCost = attendance.reduce((s,a)=>{
      const rate = empRateMap[a.employee_id] || 0;
      const mult = a.status==='present' ? 1 : a.status==='half_day' ? 0.5 : 0;
      return s + rate*mult;
    },0);

    // Expenses split
    const labour_packaging_expenses = expenses.reduce((s,r)=>
      LABOUR_PKG_CATS.includes((r.category||'').toLowerCase()) ? s+parseFloat(r.amount||0) : s, 0);
    const other_expenses = expenses.reduce((s,r)=>
      !LABOUR_PKG_CATS.includes((r.category||'').toLowerCase()) ? s+parseFloat(r.amount||0) : s, 0);
    const cost_expenses = labour_packaging_expenses + other_expenses;

    // 3-level profit
    const gross_profit    = total_revenue - cost_procurement;
    const operating_profit= gross_profit - payrollCost - labour_packaging_expenses;
    const net_profit      = operating_profit - other_expenses;

    // GST
    const gst_output = total_revenue * 0.05;
    const gst_input  = procs.reduce((s,r)=>{
      const qty = parseFloat(r.ordered_qty||0);
      const rate= parseFloat(r.ordered_price_per_kg||0);
      const gstPct = parseFloat(r.gst||0);
      return s + qty * rate * (gstPct/100);
    },0);
    const gst_payable = gst_output - gst_input;

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

    // Previous period totals
    const prev_rev = pSales.reduce((s,r)=>s+parseFloat(r.final_amount||0),0)
                   + pWso.reduce((s,r)=>s+parseFloat(r.total||0),0)
                   + pB2b.reduce((s,r)=>s+parseFloat(r.total_value||0),0);
    const prev_proc = pProcs.reduce((s,r)=>{
      const qty=parseFloat(r.ordered_qty||0),rate=parseFloat(r.ordered_price_per_kg||0),gst=parseFloat(r.gst||0);
      return s+qty*rate*(1+gst/100);
    },0);
    const prev_exp = pExpenses.reduce((s,r)=>s+parseFloat(r.amount||0),0);
    const prev_gross = prev_rev - prev_proc;
    const prev_net   = prev_gross - prev_exp;

    res.json({
      period: { start, end },
      prev_period: { start: prevStartStr, end: prevEndStr, revenue: prev_rev, procurement: prev_proc, expenses: prev_exp, gross_profit: prev_gross, net_profit: prev_net },
      revenue: { sales: rev_sales, webstore: rev_webstore, b2b: rev_b2b, total: total_revenue },
      costs:   { procurement: cost_procurement, payroll: payrollCost, labour_packaging: labour_packaging_expenses, other_expenses, expenses: cost_expenses, total: cost_procurement+cost_expenses+payrollCost },
      gross_profit,
      operating_profit,
      net_profit,
      margin_pct: total_revenue > 0 ? ((gross_profit / total_revenue) * 100).toFixed(1) : 0,
      operating_margin_pct: total_revenue > 0 ? ((operating_profit / total_revenue) * 100).toFixed(1) : 0,
      net_margin_pct: total_revenue > 0 ? ((net_profit / total_revenue) * 100).toFixed(1) : 0,
      gst: { output: gst_output, input: gst_input, payable: gst_payable },
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

// POST /api/analytics/carts/ai-followup — manual AI follow-up for a single cart
router.post('/carts/ai-followup', auth, async (req, res) => {
  res.json({ ok: true }); // respond immediately
  try {
    const { session_id, email, phone, name, items, touch = 1 } = req.body;
    if (!session_id) return;

    const { generateCartMessage, buildCartEmailHtml, sendWhatsAppMsg } = require('../scripts/automation-service');
    const nodemailer = require('nodemailer');
    const mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const cart = { session_id, email, phone, customer_name: name, customer_phone: phone, items: items || [] };
    const { wa: waMsg, subject } = await generateCartMessage(cart, touch);
    const htmlBody = buildCartEmailHtml(cart, touch, waMsg);

    let channels = [];

    if (phone) {
      const sent = await sendWhatsAppMsg(phone, waMsg);
      if (sent) channels.push('whatsapp');
    }
    if (email && process.env.SMTP_USER) {
      try {
        await mailer.sendMail({
          from: process.env.SMTP_FROM || 'Sathvam <noreply@sathvam.in>',
          to: email,
          subject,
          html: htmlBody,
        });
        channels.push('email');
      } catch (e) { console.error('[AI-FOLLOWUP] Email failed:', e.message); }
    }

    // Update follow-up state
    const { data: stateRow } = await supabase.from('settings').select('value').eq('key', 'cart_followup_state').single();
    const state = stateRow?.value || {};
    state[session_id] = { count: touch, last_at: new Date().toISOString(), manual: true };
    await supabase.from('settings').upsert({ key: 'cart_followup_state', value: state, updated_at: new Date().toISOString() });

    console.log(`[AI-FOLLOWUP] Touch ${touch} sent via [${channels.join(', ')}] for cart ${session_id}`);
  } catch (e) { console.error('[AI-FOLLOWUP] Error:', e.message); }
});

// ── Discount Approval Endpoints ───────────────────────────────────────────────

// GET /api/analytics/carts/discount-approvals
router.get('/carts/discount-approvals', auth, async (req, res) => {
  try {
    const { data } = await supabase.from('settings').select('value').eq('key', 'cart_discount_approvals').maybeSingle();
    res.json(data?.value || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/analytics/carts/discount-approvals/approve
// Body: { id, session_id, discount_pct }
router.post('/carts/discount-approvals/approve', auth, async (req, res) => {
  try {
    const { id, session_id, discount_pct = 10 } = req.body;
    if (!id || !session_id) return res.status(400).json({ error: 'id and session_id required' });

    // 1. Fetch approval queue
    const { data: aqRow } = await supabase.from('settings').select('value').eq('key', 'cart_discount_approvals').maybeSingle();
    const queue = aqRow?.value || [];
    const approval = queue.find(a => a.id === id);
    if (!approval) return res.status(404).json({ error: 'Approval not found' });
    if (approval.status !== 'pending') return res.status(400).json({ error: 'Already actioned' });

    // 2. Mark approved
    const updatedQueue = queue.map(a => a.id === id ? { ...a, status: 'approved', discount_pct, actioned_at: new Date().toISOString(), actioned_by: req.user?.email || 'admin' } : a);
    await supabase.from('settings').upsert({ key: 'cart_discount_approvals', value: updatedQueue, updated_at: new Date().toISOString() });

    res.json({ ok: true }); // respond immediately

    // 3. Send AI follow-up message in background
    try {
      const { generateCartMessage, buildCartEmailHtml, sendWhatsAppMsg } = require('../scripts/automation-service');
      const nodemailer = require('nodemailer');
      const mailer = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });

      const cart = approval.cart;
      const { wa: waMsg, subject } = await generateCartMessage(cart, 2, discount_pct);
      const htmlBody = buildCartEmailHtml(cart, 2, waMsg, discount_pct);

      let channels = [];
      if (cart.customer_phone || cart.phone) {
        const sent = await sendWhatsAppMsg(cart.customer_phone || cart.phone, waMsg);
        if (sent) channels.push('whatsapp');
      }
      if ((cart.email || cart.customer_email) && process.env.SMTP_USER) {
        try {
          await mailer.sendMail({
            from: process.env.SMTP_FROM || 'Sathvam <noreply@sathvam.in>',
            to: cart.email || cart.customer_email,
            subject,
            html: htmlBody,
          });
          channels.push('email');
        } catch (e) { console.error('[APPROVE] Email failed:', e.message); }
      }

      // 4. Advance cart state to count=2 so T3 can proceed
      const { data: stateRow } = await supabase.from('settings').select('value').eq('key', 'cart_followup_state').maybeSingle();
      const state = stateRow?.value || {};
      state[session_id] = { ...state[session_id], count: 2, last_at: new Date().toISOString(), approval_queued: false };
      await supabase.from('settings').upsert({ key: 'cart_followup_state', value: state, updated_at: new Date().toISOString() });

      console.log(`[APPROVE] Discount ${discount_pct}% approved for ${session_id}, sent via [${channels.join(', ')}]`);
    } catch (e) { console.error('[APPROVE] Send error:', e.message); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/analytics/carts/discount-approvals/reject
// Body: { id, session_id }
router.post('/carts/discount-approvals/reject', auth, async (req, res) => {
  try {
    const { id, session_id } = req.body;
    if (!id || !session_id) return res.status(400).json({ error: 'id and session_id required' });

    // 1. Mark rejected in queue
    const { data: aqRow } = await supabase.from('settings').select('value').eq('key', 'cart_discount_approvals').maybeSingle();
    const queue = aqRow?.value || [];
    if (!queue.find(a => a.id === id)) return res.status(404).json({ error: 'Approval not found' });

    const updatedQueue = queue.map(a => a.id === id ? { ...a, status: 'rejected', actioned_at: new Date().toISOString(), actioned_by: req.user?.email || 'admin' } : a);
    await supabase.from('settings').upsert({ key: 'cart_discount_approvals', value: updatedQueue, updated_at: new Date().toISOString() });

    // 2. Advance cart state past T2 (count=2) — no discount message sent
    const { data: stateRow } = await supabase.from('settings').select('value').eq('key', 'cart_followup_state').maybeSingle();
    const state = stateRow?.value || {};
    state[session_id] = { ...state[session_id], count: 2, last_at: new Date().toISOString(), approval_queued: false };
    await supabase.from('settings').upsert({ key: 'cart_followup_state', value: state, updated_at: new Date().toISOString() });

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/analytics/carts/failed-payment-followup — manual retry for a single failed payment session
router.post('/carts/failed-payment-followup', auth, async (req, res) => {
  res.json({ ok: true });
  try {
    const { session_id, email, phone, name, items, cart_total, touch = 1 } = req.body;
    if (!session_id) return;

    const { sendWhatsAppMsg } = require('../scripts/automation-service');
    const nodemailer = require('nodemailer');
    const mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const first = (name || 'there').split(' ')[0];
    const total = cart_total ? `₹${Math.round(cart_total)}` : 'your order';
    const waMsg = `Hi ${first}! 👋 We noticed your payment for ${total} didn't complete. Please retry: https://sathvam.in/cart — or call us and we'll help you manually! 🙏`;
    const subject = `Your Sathvam payment didn't go through — retry link inside`;
    const html = `<p>Hi ${first},</p><p>Your payment for <strong>${total}</strong> was unsuccessful. <a href="https://sathvam.in/cart">Retry here</a> or call us to complete manually.</p><p>Team Sathvam 🌿</p>`;

    let channels = [];
    if (phone) { const s = await sendWhatsAppMsg(phone, waMsg); if (s) channels.push('whatsapp'); }
    if (email && process.env.SMTP_USER) {
      try { await mailer.sendMail({ from: process.env.SMTP_FROM || 'Sathvam <noreply@sathvam.in>', to: email, subject, html }); channels.push('email'); }
      catch (e) { console.error('[FAILED-PAY-MANUAL] Email error:', e.message); }
    }

    // Mark in state
    const { data: stateRow } = await supabase.from('settings').select('value').eq('key', 'failed_payment_state').maybeSingle();
    const state = stateRow?.value || {};
    state[session_id] = { count: touch, last_at: new Date().toISOString(), manual: true };
    await supabase.from('settings').upsert({ key: 'failed_payment_state', value: state, updated_at: new Date().toISOString() });

    console.log(`[FAILED-PAY-MANUAL] Touch ${touch} sent via [${channels.join(', ')}] for ${session_id}`);
  } catch (e) { console.error('[FAILED-PAY-MANUAL] Error:', e.message); }
});

// GET /api/analytics/carts — admin cart tracking (Live / Abandoned / Failed / Recovered)
router.get('/carts', auth, async (req, res) => {
  try {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const [{ data: allCarts }, { data: csSessions }] = await Promise.all([
      supabase.from('abandoned_carts').select('*').order('updated_at', { ascending: false }).limit(500),
      supabase.from('store_analytics').select('key,data').like('key', '_cs_%').order('id', { ascending: false }).limit(200),
    ]);

    const carts = allCarts || [];
    const sessions = (csSessions || []).map(r => ({ id: r.key.replace('_cs_', ''), ...r.data }));

    // Enrich carts that belong to logged-in customers (session_id = 'cust_<uuid>')
    const custIds = [...new Set(
      carts.filter(c => c.session_id && c.session_id.startsWith('cust_'))
           .map(c => c.session_id.replace('cust_', ''))
    )];
    let custMap = {};
    if (custIds.length > 0) {
      const { data: custs } = await supabase
        .from('customers')
        .select('id, name, email, phone')
        .in('id', custIds);
      (custs || []).forEach(c => { custMap[c.id] = c; });
    }
    const enrichCart = (c) => {
      if (c.session_id && c.session_id.startsWith('cust_')) {
        const cust = custMap[c.session_id.replace('cust_', '')];
        if (cust) return {
          ...c,
          customer_name:  decrypt(cust.name),
          customer_email: decrypt(cust.email),
          customer_phone: decrypt(cust.phone),
        };
      }
      return c;
    };
    const enrichedCarts = carts.map(enrichCart);

    // Live = updated in last 30 min, not recovered
    const live = enrichedCarts.filter(c => !c.recovered && c.updated_at >= thirtyMinAgo);
    // Abandoned = not recovered, older than 30 min
    const abandoned = enrichedCarts.filter(c => !c.recovered && c.updated_at < thirtyMinAgo);
    // Failed payments = started checkout (have name/phone) but never placed order
    const failedPayments = sessions.filter(s => !s.recovered && (s.customer_name || s.customer_phone));
    // Recovered = carts that converted + checkout sessions that converted
    const recoveredCarts = enrichedCarts.filter(c => c.recovered);
    const recoveredSessions = sessions.filter(s => s.recovered);

    res.json({ live, abandoned, failedPayments, recovered: [...recoveredCarts, ...recoveredSessions] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
