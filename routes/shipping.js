const express  = require('express');
const axios    = require('axios');
const supabase = require('../config/supabase');
const { auth } = require('../middleware/auth');
const router   = express.Router();

const SR_BASE = 'https://apiv2.shiprocket.in/v1/external';

let srToken    = null;
let srTokenExp = 0;

async function getSRToken() {
  if (srToken && Date.now() < srTokenExp) return srToken;
  const { data } = await axios.post(`${SR_BASE}/auth/login`, {
    email:    process.env.SHIPROCKET_EMAIL,
    password: process.env.SHIPROCKET_PASSWORD,
  });
  srToken    = data.token;
  srTokenExp = Date.now() + 9 * 24 * 60 * 60 * 1000; // 9 days
  return srToken;
}

async function sr(method, path, payload) {
  const token = await getSRToken();
  const cfg   = { headers: { Authorization: `Bearer ${token}` } };
  if (method === 'get') return axios.get(`${SR_BASE}${path}`, cfg);
  return axios.post(`${SR_BASE}${path}`, payload, cfg);
}

// POST /api/shipping/book
router.post('/book', auth, async (req, res) => {
  try {
    const { order_no } = req.body;
    const { data: order, error } = await supabase
      .from('webstore_orders')
      .select('*')
      .eq('order_no', order_no)
      .single();
    if (error || !order) return res.status(404).json({ error: 'Order not found' });

    const cust  = order.customer || {};
    const items = order.items    || [];
    const weight = items.reduce((s, i) => s + (parseFloat(i.qty || 1) * 0.5), 0) || 0.5;
    const pincode = (cust.pincode || '639005').replace(/\D/g, '');

    const payload = {
      order_id:                order.order_no,
      order_date:              order.date || new Date().toISOString().slice(0, 10),
      pickup_location:         'Primary',
      billing_customer_name:   cust.name || 'Customer',
      billing_last_name:       '',
      billing_address:         cust.address || 'Sathvam',
      billing_city:            cust.city    || 'Karur',
      billing_pincode:         cust.pincode || '639005',
      billing_state:           cust.state   || 'Tamil Nadu',
      billing_country:         'India',
      billing_email:           cust.email   || '',
      billing_phone:           (cust.phone  || '').replace(/\D/g, '').slice(-10),
      shipping_is_billing:     true,
      order_items: items.map(i => ({
        name:          i.productName || i.name || 'Product',
        sku:           i.sku         || i.product_id || 'SKU',
        units:         i.qty         || 1,
        selling_price: parseFloat(i.rate || i.price || 0),
        discount:      0,
        tax:           '',
        hsn:           i.hsn         || '',
      })),
      payment_method: order.payment_status === 'paid' ? 'Prepaid' : 'COD',
      sub_total:      order.total || 0,
      length: 20, breadth: 15, height: 10,
      weight,
    };

    const { data: srOrder } = await sr('post', '/orders/create/adhoc', payload);

    const { data: svc } = await sr(
      'get',
      `/courier/serviceability/?pickup_postcode=639005&delivery_postcode=${pincode}&weight=${weight}&cod=0`,
    );

    const couriers = (svc?.data?.available_courier_companies || []).map(c => ({
      courier_company_id: c.courier_company_id,
      courier_name:       c.courier_name,
      rate:               c.rate,
      etd:                c.etd,
    }));

    res.json({
      shiprocket_order_id: srOrder.order_id,
      shipment_id:         srOrder.shipment_id,
      couriers,
    });
  } catch (e) {
    console.error('[SR-BOOK]', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// POST /api/shipping/assign
router.post('/assign', auth, async (req, res) => {
  try {
    const { order_no, shiprocket_order_id, shipment_id, courier_id } = req.body;

    const { data: awbRes } = await sr('post', '/courier/assign/awb', { shipment_id, courier_id });

    const awb          = awbRes?.response?.data?.awb_code   || awbRes?.awb_code || '';
    const courier_name = awbRes?.response?.data?.courier_name || '';
    const label_url    = awbRes?.response?.data?.label_url   || '';

    await supabase
      .from('webstore_orders')
      .update({ courier: courier_name, awb_number: awb, status: 'packed' })
      .eq('order_no', order_no);

    res.json({ awb, courier_name, label_url });
  } catch (e) {
    console.error('[SR-ASSIGN]', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// GET /api/shipping/track/:awb
router.get('/track/:awb', auth, async (req, res) => {
  try {
    const { data } = await sr('get', `/courier/track/awb/${req.params.awb}`);
    res.json(data);
  } catch (e) {
    console.error('[SR-TRACK]', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// GET /api/shipping/live/:orderNo  (public — customer tracking)
router.get('/live/:orderNo', async (req, res) => {
  try {
    const { data: order, error } = await supabase
      .from('webstore_orders')
      .select('awb_number')
      .eq('order_no', req.params.orderNo)
      .single();
    if (error || !order?.awb_number) return res.status(404).json({ error: 'Tracking not available' });

    const { data: trackData } = await sr('get', `/courier/track/awb/${order.awb_number}`);
    const activities = trackData?.tracking_data?.shipment_track_activities || [];
    const simplified = activities.map(a => ({
      date:     a.date,
      activity: a.activity,
      location: a.location,
      status:   a['sr-status-label'] || a.status || '',
    }));
    res.json(simplified);
  } catch (e) {
    console.error('[SR-LIVE]', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// POST /api/shipping/label
router.post('/label', auth, async (req, res) => {
  try {
    const { shipment_ids } = req.body;
    const { data } = await sr('post', '/courier/generate/label', { shipment_id: shipment_ids });
    res.json({ label_url: data?.label_url || data?.response?.label_url || '' });
  } catch (e) {
    console.error('[SR-LABEL]', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// GET /api/shipping/serviceability
router.get('/serviceability', auth, async (req, res) => {
  try {
    const { pincode = '', weight = '0.5', cod = '0' } = req.query;
    const { data } = await sr(
      'get',
      `/courier/serviceability/?pickup_postcode=639005&delivery_postcode=${pincode}&weight=${weight}&cod=${cod}`,
    );
    const couriers = (data?.data?.available_courier_companies || []).map(c => ({
      courier_company_id: c.courier_company_id,
      courier_name:       c.courier_name,
      rate:               c.rate,
      etd:                c.etd,
    }));
    res.json({ couriers });
  } catch (e) {
    console.error('[SR-SVC]', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.message || e.message });
  }
});

// POST /api/shipping/webhook  (Shiprocket webhook — no auth)
router.post('/webhook', async (req, res) => {
  try {
    const body      = req.body || {};
    const awb       = body.awb || body.awb_code || '';
    const srStatus  = body.current_status || body.status || '';

    const STATUS_MAP = {
      'Delivered':   'delivered',
      'Shipped':     'dispatched',
      'In Transit':  'dispatched',
    };

    const newStatus = STATUS_MAP[srStatus];

    if (awb) {
      const updates = { awb_number: awb };
      if (newStatus) updates.status = newStatus;
      if (!newStatus && (srStatus.includes('RTO') || srStatus.includes('Return'))) {
        updates.notes = `Shiprocket: ${srStatus}`;
      }
      await supabase
        .from('webstore_orders')
        .update(updates)
        .eq('awb_number', awb);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('[SR-WEBHOOK]', e.message);
    res.sendStatus(200);
  }
});

module.exports = router;
