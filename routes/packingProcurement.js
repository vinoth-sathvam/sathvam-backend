const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const { auth, requireRole } = require('../middleware/auth');
const supabase = require('../config/supabase');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10 MB

// Allowed MIME types for bill scans (images + PDF)
const BILL_MIME = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/webp': 'webp', 'application/pdf': 'pdf',
};

async function ensureBillsBucket() {
  const { data: buckets } = await supabase.storage.listBuckets();
  if (!buckets?.find(b => b.name === 'po-bills')) {
    await supabase.storage.createBucket('po-bills', { public: true, fileSizeLimit: 10485760 });
  }
}

const round2 = v => Math.round((v||0)*100)/100;

// ── GET all POs ───────────────────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('packing_procurement')
      .select('*')
      .order('date', { ascending: false })
      .limit(200);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST create PO ────────────────────────────────────────────────────────────
router.post('/', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    const { vendor_id, vendor_name, vendor_gst, date, expected_delivery, items, gst_pct, notes, bill_no } = req.body;
    if (!vendor_name || !date) return res.status(400).json({ error: 'vendor_name and date required' });
    if (!items || !items.length) return res.status(400).json({ error: 'at least one item required' });

    const subtotal = round2(items.reduce((s,i) => s + (parseFloat(i.qty)||0)*(parseFloat(i.unit_price)||0), 0));
    const gstPct   = parseFloat(gst_pct)||0;
    const gstAmt   = round2(subtotal * gstPct / 100);
    const total    = round2(subtotal + gstAmt);

    // Auto-generate PO number: POSA{YYYYMMMDD}-{seq} e.g. POSA2026APR18-01
    const now = new Date();
    const yr  = now.getFullYear();
    const mon = now.toLocaleString('en-US',{month:'short'}).toUpperCase();
    const day = String(now.getDate()).padStart(2,'0');
    const dateTag = `${yr}${mon}${day}`;
    const { count } = await supabase.from('packing_procurement').select('*', { count: 'exact', head: true });
    const poNumber  = `POSA${dateTag}-${String((count||0)+1).padStart(2,'0')}`;

    const { data, error } = await supabase.from('packing_procurement').insert({
      po_number: poNumber,
      vendor_id: vendor_id || null,
      vendor_name: vendor_name.trim(),
      vendor_gst: vendor_gst || '',
      date, expected_delivery: expected_delivery || null,
      status: 'pending',
      items: items.map(i => ({
        material_id: i.material_id,
        name: i.name,
        spec: i.spec || '',
        unit: i.unit || 'pcs',
        qty: parseFloat(i.qty)||0,
        unit_price: parseFloat(i.unit_price)||0,
        received_qty: 0,
      })),
      subtotal, gst_pct: gstPct, gst_amt: gstAmt, total,
      notes: notes || '',
      bill_no: bill_no || '',
      payable_id: null,
      created_by: req.user?.email || '',
    }).select().single();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT update PO (before receiving) ─────────────────────────────────────────
router.put('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    const { vendor_id, vendor_name, vendor_gst, date, expected_delivery, items, gst_pct, notes, bill_no, status, vendor_bill_no, bill_scan_url } = req.body;
    const updates = { updated_at: new Date().toISOString() };

    if (vendor_id   !== undefined) updates.vendor_id = vendor_id;
    if (vendor_name !== undefined) updates.vendor_name = vendor_name;
    if (vendor_gst  !== undefined) updates.vendor_gst = vendor_gst;
    if (date        !== undefined) updates.date = date;
    if (expected_delivery !== undefined) updates.expected_delivery = expected_delivery;
    if (notes       !== undefined) updates.notes = notes;
    if (bill_no     !== undefined) updates.bill_no = bill_no;
    if (status      !== undefined) updates.status = status;
    if (vendor_bill_no !== undefined) updates.vendor_bill_no = vendor_bill_no;
    if (bill_scan_url  !== undefined) updates.bill_scan_url  = bill_scan_url;

    if (items !== undefined) {
      const subtotal = round2(items.reduce((s,i) => s + (parseFloat(i.qty)||0)*(parseFloat(i.unit_price)||0), 0));
      const gstPct   = parseFloat(gst_pct !== undefined ? gst_pct : 0);
      const gstAmt   = round2(subtotal * gstPct / 100);
      updates.items    = items;
      updates.subtotal = subtotal;
      updates.gst_pct  = gstPct;
      updates.gst_amt  = gstAmt;
      updates.total    = round2(subtotal + gstAmt);
    }

    const { data, error } = await supabase.from('packing_procurement').update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:id/receive — mark items received, update stock + avg_cost ──────────
router.post('/:id/receive', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    // received_items: [{ material_id, received_qty, unit_price }]
    const { received_items, bill_no, create_payable } = req.body;
    if (!received_items?.length) return res.status(400).json({ error: 'received_items required' });

    // Load PO
    const { data: po, error: poErr } = await supabase.from('packing_procurement').select('*').eq('id', req.params.id).single();
    if (poErr || !po) return res.status(404).json({ error: 'PO not found' });

    // Update each received item in packing_materials (stock + avg_cost)
    for (const ri of received_items) {
      if (!ri.material_id || !(parseFloat(ri.received_qty) > 0)) continue;

      const recvQty   = parseFloat(ri.received_qty);
      const unitPrice = parseFloat(ri.unit_price) || 0;

      // Fetch current stock + avg_cost
      const { data: mat } = await supabase.from('packing_materials').select('current_stock,avg_cost').eq('id', ri.material_id).single();
      if (!mat) continue;

      const curStock   = parseFloat(mat.current_stock) || 0;
      const curAvg     = parseFloat(mat.avg_cost)      || 0;
      // Weighted average cost
      const newAvgCost = curStock + recvQty > 0
        ? round2((curStock * curAvg + recvQty * unitPrice) / (curStock + recvQty))
        : unitPrice;
      const newStock   = curStock + recvQty;

      await supabase.from('packing_materials').update({
        current_stock: newStock,
        avg_cost: newAvgCost,
        unit_price: newAvgCost,   // keep unit_price in sync for compatibility
        updated_at: new Date().toISOString(),
      }).eq('id', ri.material_id);

      // Alert if avg cost changed by more than 5%
      if (curAvg > 0 && Math.abs(newAvgCost - curAvg) / curAvg > 0.05) {
        const { data: mat2 } = await supabase.from('packing_materials').select('name').eq('id', ri.material_id).single();
        console.log(`[PRICE ALERT] ${mat2?.name}: avg cost changed ${curAvg} → ${newAvgCost} (${Math.round((newAvgCost-curAvg)/curAvg*100)}%)`);
        // Log to a price_alerts settings key for the frontend to display
        const alertKey = 'packing_price_alerts';
        const { data: existing } = await supabase.from('settings').select('value').eq('key', alertKey).single();
        const alerts = (existing?.value || []).slice(0, 49);
        alerts.unshift({ date: new Date().toISOString().slice(0,10), material: mat2?.name, old: curAvg, new: newAvgCost, pct: Math.round((newAvgCost-curAvg)/curAvg*100) });
        await supabase.from('settings').upsert({ key: alertKey, value: alerts, updated_at: new Date().toISOString() });
      }
    }

    // Update PO items with received quantities
    const updatedItems = (po.items || []).map(item => {
      const ri = received_items.find(r => r.material_id === item.material_id);
      if (!ri) return item;
      return { ...item, received_qty: (parseFloat(item.received_qty)||0) + parseFloat(ri.received_qty||0) };
    });

    // Determine new status
    const allReceived = updatedItems.every(i => (parseFloat(i.received_qty)||0) >= (parseFloat(i.qty)||0));
    const anyReceived = updatedItems.some(i => (parseFloat(i.received_qty)||0) > 0);
    const newStatus   = allReceived ? 'received' : anyReceived ? 'partial' : 'pending';

    const poUpdates = {
      items: updatedItems,
      status: newStatus,
      updated_at: new Date().toISOString(),
    };
    if (bill_no) poUpdates.bill_no = bill_no;

    // Optionally create vendor payable in finance
    let payableId = po.payable_id;
    if (create_payable && !payableId) {
      const totalAmt = round2(received_items.reduce((s,ri) => s + (parseFloat(ri.received_qty)||0)*(parseFloat(ri.unit_price)||0), 0));
      const gstAmt   = round2(totalAmt * (parseFloat(po.gst_pct)||0) / 100);
      const { data: payable } = await supabase.from('vendor_bills').insert({
        vendor_name: po.vendor_name,
        vendor_gst: po.vendor_gst || '',
        bill_no: bill_no || po.bill_no || po.po_number,
        bill_date: new Date().toISOString().slice(0,10),
        due_date: null,
        amount: totalAmt,
        gst_amount: gstAmt,
        category: 'Packing Materials',
        notes: `PO: ${po.po_number}`,
        status: 'unpaid',
        paid_amount: 0,
        created_by: req.user?.email || '',
      }).select().single();
      if (payable) {
        payableId = payable.id;
        poUpdates.payable_id = payableId;
      }
    }

    const { data: updated, error: upErr } = await supabase.from('packing_procurement').update(poUpdates).eq('id', req.params.id).select().single();
    if (upErr) return res.status(400).json({ error: upErr.message });

    res.json({ po: updated, payable_id: payableId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:id/attach-bill — attach vendor hardcopy bill (bill no + optional scan) ──
router.post('/:id/attach-bill', auth, requireRole('admin','manager'), upload.single('bill_scan'), async (req, res) => {
  try {
    await ensureBillsBucket();
    const { vendor_bill_no } = req.body;
    const updates = { updated_at: new Date().toISOString() };

    if (vendor_bill_no !== undefined) updates.vendor_bill_no = vendor_bill_no.trim();

    if (req.file) {
      const ext = BILL_MIME[req.file.mimetype];
      if (!ext) return res.status(400).json({ error: 'Invalid file type. Allowed: jpg, png, webp, pdf' });
      const fileName = `po-${req.params.id}-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from('po-bills').upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype, upsert: true,
      });
      if (upErr) return res.status(500).json({ error: 'File upload failed: ' + upErr.message });
      const { data: urlData } = supabase.storage.from('po-bills').getPublicUrl(fileName);
      updates.bill_scan_url = urlData.publicUrl;
    }

    const { data, error } = await supabase.from('packing_procurement').update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /admin/migrate-po-numbers — one-time migration to new PO number format ──
router.post('/admin/migrate-po-numbers', auth, requireRole('admin'), async (req, res) => {
  try {
    const { data: all, error } = await supabase.from('packing_procurement').select('id,po_number,date').order('date', { ascending: true }).order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });

    // Group by date, assign new sequential numbers
    const byDate = {};
    for (const po of all) {
      const d = (po.date || new Date().toISOString().slice(0,10));
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(po);
    }

    const renames = []; // { id, old, new }
    for (const [d, pos] of Object.entries(byDate)) {
      const dt = new Date(d);
      const yr  = dt.getFullYear();
      const mon = dt.toLocaleString('en-US', { month: 'short' }).toUpperCase();
      const day = String(dt.getDate()).padStart(2, '0');
      const tag = `${yr}${mon}${day}`;
      pos.forEach((po, idx) => {
        const newNum = `POSA${tag}-${String(idx + 1).padStart(2, '0')}`;
        if (po.po_number !== newNum) renames.push({ id: po.id, old: po.po_number, new: newNum });
      });
    }

    let updated = 0;
    for (const r of renames) {
      await supabase.from('packing_procurement').update({ po_number: r.new, updated_at: new Date().toISOString() }).eq('id', r.id);
      // Also update any vendor bills that reference the old PO number
      const { data: bills } = await supabase.from('vendor_bills').select('id,bill_no,notes').or(`bill_no.ilike.%${r.old}%,notes.ilike.%${r.old}%`);
      for (const bill of (bills||[])) {
        const newBillNo = bill.bill_no ? bill.bill_no.replace(r.old, r.new) : bill.bill_no;
        const newNotes  = bill.notes  ? bill.notes.replace(r.old, r.new)  : bill.notes;
        await supabase.from('vendor_bills').update({ bill_no: newBillNo, notes: newNotes, updated_at: new Date().toISOString() }).eq('id', bill.id);
      }
      updated++;
    }

    res.json({ ok: true, total: all.length, migrated: updated, renames });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE (cancel) PO ────────────────────────────────────────────────────────
router.delete('/:id', auth, requireRole('admin','manager'), async (req, res) => {
  try {
    await supabase.from('packing_procurement').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
