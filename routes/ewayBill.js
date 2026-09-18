const express = require('express');
const supabase = require('../config/supabase');
const { auth, requireRole } = require('../middleware/auth');
const { zoho, findOrCreateContact } = require('../config/zoho');
const router  = express.Router();

// ── Zoho Books — E-Way Bill API Integration ─────────────────────────────────
// Docs: https://www.zoho.com/books/api/v3/
// E-Way Bill help: https://www.zoho.com/in/books/help/e-way-bill/

const GSTIN = '33ABFCS9387K1ZN';

// State code map — NIC/Zoho uses 2-letter state codes
const STATE_CODE_MAP = {
  'Andhra Pradesh':'AP','Arunachal Pradesh':'AR','Assam':'AS','Bihar':'BR',
  'Chhattisgarh':'CG','Goa':'GA','Gujarat':'GJ','Haryana':'HR','Himachal Pradesh':'HP',
  'Jharkhand':'JH','Karnataka':'KA','Kerala':'KL','Madhya Pradesh':'MP','Maharashtra':'MH',
  'Manipur':'MN','Meghalaya':'ML','Mizoram':'MZ','Nagaland':'NL','Odisha':'OD',
  'Punjab':'PB','Rajasthan':'RJ','Sikkim':'SK','Tamil Nadu':'TN','Telangana':'TS',
  'Tripura':'TR','Uttar Pradesh':'UP','Uttarakhand':'UK','West Bengal':'WB',
  'Delhi':'DL','Jammu and Kashmir':'JK','Ladakh':'LA','Puducherry':'PY',
  'Chandigarh':'CH','Andaman and Nicobar Islands':'AN','Dadra and Nagar Haveli and Daman and Diu':'DD',
  'Lakshadweep':'LD',
};
const stateCode = (name) => STATE_CODE_MAP[name] || '';

// Sub-supply type codes (Zoho uses same NIC integer codes)
const SUB_SUPPLY_TYPES = {
  'Supply': 'supply', 'Import': 'import', 'Export': 'export', 'Job Work': 'job_work',
  'For Own Use': 'for_own_use', 'Job Work Returns': 'job_work_returns',
  'Sales Return': 'sales_return', 'Others': 'others',
};

// ── Helper: save/load e-way bills from settings ─────────────────────────────
async function saveBills(bills) {
  await supabase.from('settings').upsert({ key: 'eway_bills', value: bills, updated_at: new Date() });
}
async function loadBills() {
  const { data } = await supabase.from('settings').select('value').eq('key', 'eway_bills').maybeSingle();
  const v = data?.value;
  return Array.isArray(v) ? v : (v && Array.isArray(v.value) ? v.value : []);
}

// ── Helper: find local bill by ewb_no ───────────────────────────────────────
async function findBillByEwbNo(ewb_no) {
  const bills = await loadBills();
  return bills.find(b => b.ewb_no === String(ewb_no));
}

// ── POST /api/eway-bill/generate — Generate official E-Way Bill via Zoho ────
router.post('/generate', auth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const b = req.body;
    if (!b.recipient_name) return res.status(400).json({ error: 'Recipient name required' });

    const items = (b.items || []).filter(it => it.name);
    const totalTaxable = items.reduce((s, it) => s + (parseFloat(it.taxable_value) || 0), 0);
    const totalGst = items.reduce((s, it) => {
      const tv = parseFloat(it.taxable_value) || 0;
      const gr = parseFloat(it.gst_rate) || 0;
      return s + tv * gr / 100;
    }, 0);

    // Step 1: Create/find contact in Zoho Books for the recipient
    let contactId = null;
    try {
      contactId = await findOrCreateContact(
        b.recipient_name,
        b.recipient_email || `${b.recipient_name.replace(/\s+/g, '').toLowerCase()}@placeholder.ewb`,
        b.recipient_phone || ''
      );
    } catch (e) {
      console.warn('[EWB] Could not create Zoho contact, proceeding with name:', e.message);
    }

    // Step 2: Create a Zoho Books invoice to link the e-way bill to
    const lineItems = items.map(it => ({
      name: it.name || 'Product',
      quantity: parseFloat(it.qty) || 1,
      rate: parseFloat(it.taxable_value) / (parseFloat(it.qty) || 1) || 0,
      hsn_or_sac: it.hsn || '',
      tax_percentage: parseFloat(it.gst_rate) || 0,
    }));

    const invoicePayload = {
      invoice_number: b.doc_no || 'EWB-' + Date.now(),
      reference_number: b.doc_no || '',
      date: b.doc_date || new Date().toISOString().slice(0, 10),
      line_items: lineItems,
      notes: `E-Way Bill invoice — ${b.recipient_name}`,
      gst_no: b.recipient_gstin || '',
      place_of_supply: stateCode(b.recipient_state) || 'TN',
      ...(contactId
        ? { customer_id: contactId }
        : { customer_name: b.recipient_name }),
    };

    console.log('[EWB] Creating Zoho invoice for e-way bill:', JSON.stringify({ doc_no: b.doc_no, recipient: b.recipient_name }));
    let invoice;
    try {
      const invResult = await zoho('post', '/invoices', invoicePayload);
      invoice = invResult.invoice;
      console.log('[EWB] Zoho invoice created:', invoice?.invoice_id);
    } catch (e) {
      const detail = e.response?.data;
      const msg = detail?.message || e.message;
      console.error('[EWB] Zoho invoice creation failed:', msg);
      return res.status(400).json({ error: 'Failed to create invoice in Zoho Books: ' + msg });
    }

    // Step 3: Create E-Way Bill in Zoho Books linked to the invoice
    const ewbPayload = {
      transaction_type: 'regular',
      sub_supply_type: SUB_SUPPLY_TYPES[b.sub_supply_type || 'Supply'] || 'supply',
      transportation_mode: b.transport_mode || 'road',
      distance: String(parseInt(b.distance_km) || 0),
      vehicle_number: (b.vehicle_no || '').replace(/\s/g, ''),
      vehicle_type: b.vehicle_type || 'regular',
      entity_id: invoice.invoice_id,
      entity_type: 'invoice',
      action: 'save_generate',
      ship_to_state_code: stateCode(b.recipient_state) || 'TN',
      transporter_name: b.transporter_name || '',
      transporter_id: b.transporter_gstin || '',
    };

    console.log('[EWB] Generating e-way bill via Zoho:', JSON.stringify({ doc_no: b.doc_no, recipient: b.recipient_name, invoice_id: invoice.invoice_id }));
    let ewbResult;
    try {
      ewbResult = await zoho('post', '/ewaybills', ewbPayload);
    } catch (e) {
      const detail = e.response?.data;
      const msg = detail?.message || e.message;
      console.error('[EWB] Zoho e-way bill generation failed:', msg);
      return res.status(400).json({ error: 'E-Way Bill generation failed: ' + msg });
    }

    const ewb = ewbResult?.ewaybill;
    if (ewb && ewb.ewaybill_number) {
      // Save to local storage
      const bills = await loadBills();
      const localBill = {
        id: b.id || 'ewb_' + Date.now(),
        ewb_no: String(ewb.ewaybill_number),
        ewb_date: ewb.generated_date || b.doc_date || '',
        valid_upto_api: ewb.valid_upto || '',
        status: 'active',
        source: 'zoho',
        zoho_ewaybill_id: ewb.ewaybill_id,
        zoho_invoice_id: invoice.invoice_id,
        ...b,
        items,
        total_value: totalTaxable,
        total_gst: totalGst,
        total_invoice: totalTaxable + totalGst,
        valid_from: b.doc_date,
        valid_upto: ewb.valid_upto || b.doc_date,
        created_at: new Date().toISOString(),
        generated_by: req.user?.name || 'admin',
      };
      const updated = [localBill, ...bills.filter(bl => bl.id !== localBill.id)];
      await saveBills(updated);

      console.log('[EWB] E-Way Bill generated:', ewb.ewaybill_number);
      res.json({ success: true, ewb: { ewayBillNo: ewb.ewaybill_number, ewayBillDate: ewb.generated_date, validUpto: ewb.valid_upto }, bill: localBill });
    } else {
      console.error('[EWB] Unexpected Zoho response:', JSON.stringify(ewbResult));
      res.status(400).json({ error: 'E-Way Bill generation returned no bill number. Check Zoho Books configuration.' });
    }
  } catch (e) {
    console.error('[EWB] Generate error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/eway-bill/cancel — Cancel an E-Way Bill ───────────────────────
router.post('/cancel', auth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { ewb_no, reason, remark } = req.body;
    if (!ewb_no) return res.status(400).json({ error: 'E-Way Bill number required' });

    // Look up local bill to get Zoho IDs
    const bill = await findBillByEwbNo(ewb_no);
    if (!bill) return res.status(404).json({ error: 'E-Way Bill not found in local records' });

    if (bill.zoho_ewaybill_id) {
      try {
        await zoho('post', `/ewaybills/${bill.zoho_ewaybill_id}/cancel`, {
          reason: remark || reason || 'Cancelled',
        });
      } catch (e) {
        const msg = e.response?.data?.message || e.message;
        console.error('[EWB] Zoho cancel failed:', msg);
        return res.status(400).json({ error: 'Cancel failed: ' + msg });
      }
    }

    // Update local record
    const bills = await loadBills();
    const updated = bills.map(b => b.ewb_no === String(ewb_no)
      ? { ...b, status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: remark || reason }
      : b);
    await saveBills(updated);
    res.json({ success: true, data: { message: 'E-Way Bill cancelled' } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/eway-bill/update-vehicle — Update Part B (vehicle/transporter) ─
router.post('/update-vehicle', auth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { ewb_no, vehicle_no, vehicle_type, transport_mode, reason } = req.body;
    if (!ewb_no || !vehicle_no) return res.status(400).json({ error: 'EWB number and vehicle number required' });

    const bill = await findBillByEwbNo(ewb_no);
    if (!bill) return res.status(404).json({ error: 'E-Way Bill not found in local records' });

    if (bill.zoho_ewaybill_id) {
      try {
        await zoho('put', `/ewaybills/${bill.zoho_ewaybill_id}`, {
          vehicle_number: vehicle_no.replace(/\s/g, ''),
          vehicle_type: vehicle_type || 'regular',
          transportation_mode: transport_mode || 'road',
          reason: reason || 'Vehicle update',
        });
      } catch (e) {
        const msg = e.response?.data?.message || e.message;
        console.error('[EWB] Zoho vehicle update failed:', msg);
        return res.status(400).json({ error: 'Vehicle update failed: ' + msg });
      }
    }

    // Update local record
    const bills = await loadBills();
    const updated = bills.map(b => {
      if (b.ewb_no === String(ewb_no)) {
        return { ...b, vehicle_no, vehicle_updated_at: new Date().toISOString() };
      }
      return b;
    });
    await saveBills(updated);
    res.json({ success: true, data: { message: 'Vehicle updated' } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/eway-bill/details — Get E-Way Bill details from Zoho ───────────
router.get('/details', auth, async (req, res) => {
  try {
    const { ewb_no } = req.query;
    if (!ewb_no) return res.status(400).json({ error: 'E-Way Bill number required' });

    const bill = await findBillByEwbNo(ewb_no);
    if (!bill || !bill.zoho_ewaybill_id) {
      return res.status(404).json({ error: 'E-Way Bill not found or not linked to Zoho' });
    }

    try {
      const result = await zoho('get', `/ewaybills/${bill.zoho_ewaybill_id}`);
      const ewb = result?.ewaybill || {};
      res.json({
        success: true,
        data: {
          eway_bill_status: ewb.status || bill.status || 'Active',
          validUpto: ewb.valid_upto || bill.valid_upto || '',
          ewaybill_number: ewb.ewaybill_number || bill.ewb_no,
          vehicle_number: ewb.vehicle_number || bill.vehicle_no,
          generated_date: ewb.generated_date || bill.ewb_date,
        }
      });
    } catch (e) {
      const msg = e.response?.data?.message || e.message;
      res.status(400).json({ error: 'Fetch failed: ' + msg });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/eway-bill/list — Get local e-way bills (from settings) ─────────
router.get('/list', auth, async (req, res) => {
  try {
    const bills = await loadBills();
    res.json(bills);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/eway-bill/save-local — Save/update local e-way bill (draft) ────
router.put('/save-local', auth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const bill = req.body;
    if (!bill.id) bill.id = 'ewb_' + Date.now();
    if (!bill.ewb_no) bill.ewb_no = 'DRAFT-' + Date.now().toString(36).toUpperCase();
    bill.source = 'local';
    bill.status = bill.status || 'draft';

    const bills = await loadBills();
    const existing = bills.filter(b => b.id !== bill.id);
    const updated = [bill, ...existing];
    await saveBills(updated);
    res.json({ success: true, bill });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
