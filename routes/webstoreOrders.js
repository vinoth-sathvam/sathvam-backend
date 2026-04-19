const express      = require('express');
const nodemailer   = require('nodemailer');
const htmlPdf      = require('html-pdf-node');
const { execSync } = require('child_process');
const fs           = require('fs');
const os           = require('os');
const path         = require('path');
const supabase     = require('../config/supabase');
const { auth }     = require('../middleware/auth');
const rateLimit    = require('express-rate-limit');
const { decryptCustomer, hmac, encryptCustomer } = require('../config/crypto');
const router       = express.Router();

// Embed logo as base64 so wkhtmltoimage doesn't need network access
const LOGO_PATH   = path.join(__dirname, '../../sathvam-frontend/sathvam-vercel/public/logo.jpg');
const LOGO_B64    = fs.existsSync(LOGO_PATH) ? `data:image/jpeg;base64,${fs.readFileSync(LOGO_PATH).toString('base64')}` : '';
const BRAND_COLOR = '#4a7c59';  // Sathvam forest green

const STATUS_STYLES = {
  confirmed:        { color: '#15803d', bg: '#dcfce7', label: 'Order Confirmed',   labelTa: 'ஆர்டர் உறுதிப்பட்டது',   emoji: '✅' },
  packed:           { color: '#0369a1', bg: '#dbeafe', label: 'Order Packed',      labelTa: 'பேக் செய்யப்பட்டது',     emoji: '📦' },
  dispatched:       { color: '#b45309', bg: '#fef3c7', label: 'Order Dispatched',  labelTa: 'அனுப்பப்பட்டது',         emoji: '🚀' },
  delivered:        { color: '#065f46', bg: '#d1fae5', label: 'Order Delivered',   labelTa: 'வழங்கப்பட்டது',          emoji: '🎉' },
  cancelled:        { color: '#9f1239', bg: '#ffe4e6', label: 'Order Cancelled',   labelTa: 'ரத்து செய்யப்பட்டது',   emoji: '❌' },
  rejected:         { color: '#7f1d1d', bg: '#fecaca', label: 'Order Rejected',    labelTa: 'நிராகரிக்கப்பட்டது',    emoji: '❌' },
  refund_initiated: { color: '#5b21b6', bg: '#ede9fe', label: 'Refund Initiated',  labelTa: 'பணம் திரும்பும்',         emoji: '💸' },
  refunded:         { color: '#3730a3', bg: '#e0e7ff', label: 'Refund Completed',  labelTa: 'பணம் திரும்பியது',        emoji: '✅' },
};

function buildStatusCardHtml(order, newStatus, opts = {}) {
  const st      = STATUS_STYLES[newStatus] || STATUS_STYLES.confirmed;
  const cust    = order.customer || {};
  const orderNo = order.order_no || order.orderNo || '';
  const fullName = cust.name || 'Customer';
  const total   = parseFloat(order.total || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
  const courier = order.courier || '';
  const awb     = order.awb_number || '';
  const date    = order.date ? new Date(order.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
  const payStatus = (order.payment_status || 'paid').toLowerCase() === 'paid' ? '✅ Paid' : '⏳ Pending';
  const addr    = [cust.address, cust.city, cust.state, cust.pincode].filter(Boolean).join(', ') || '—';

  // Expected delivery dates
  const dFrom = new Date(order.date || Date.now()); dFrom.setDate(dFrom.getDate() + 3);
  const dTo   = new Date(order.date || Date.now()); dTo.setDate(dTo.getDate() + 5);
  const deliveryRange = `${dFrom.toLocaleDateString('en-IN',{day:'2-digit',month:'short'})} – ${dTo.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}`;

  // Items section for confirmed card
  const itemsHtml = newStatus === 'confirmed'
    ? (order.items || []).map(it => {
        const nm  = it.productName || it.name || 'Product';
        const qty = it.qty || 1;
        const pr  = parseFloat(it.rate || it.price || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
        return `<tr><td class="lbl">${nm}</td><td class="val">× ${qty} &nbsp; ₹${pr}</td></tr>`;
      }).join('')
    : '';

  let extraRows = '';
  if (newStatus === 'confirmed') {
    extraRows += `<tr><td colspan="2" style="padding:6px 0;border-top:1px solid #e5e7eb;"></td></tr>`;
    extraRows += `<tr><td class="lbl">Payment</td><td class="val">${payStatus}</td></tr>`;
    extraRows += `<tr><td class="lbl">Address</td><td class="val" style="font-size:12px;font-weight:500;">${addr}</td></tr>`;
    extraRows += `<tr><td class="lbl">Est. Delivery</td><td class="val" style="color:${BRAND_COLOR};">${deliveryRange}</td></tr>`;
  }
  if (newStatus === 'dispatched') {
    if (courier) extraRows += `<tr><td class="lbl">Courier</td><td class="val">${courier}</td></tr>`;
    if (awb)     extraRows += `<tr><td class="lbl">Tracking No</td><td class="val"><strong>${awb}</strong></td></tr>`;
  }
  if (opts.cancelReason) {
    extraRows += `<tr><td class="lbl">Reason</td><td class="val">${opts.cancelReason}</td></tr>`;
  }

  const greetingText = {
    confirmed: 'Thank you for your order! We are preparing your pure, cold-pressed products with care. 🌿',
    packed:    'Your order has been carefully packed and is ready for the courier.',
    dispatched:'Great news! Your order is on its way to you. Pure nature is coming to your doorstep! 🚀',
    delivered: 'Your Sathvam order has been delivered. We hope every drop brings health and happiness! 🙏',
    cancelled: 'Your order has been cancelled. Refund (if paid online) will be processed in 5–7 business days.',
    rejected:  'We regret we could not process your order. Refund (if paid online) will arrive in 5–7 business days.',
  }[newStatus] || 'Your order has been updated.';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #f5f5f0; width: 760px; }
  .card { background: #fff; border-radius: 20px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,.12); margin: 20px; }
  .header { background: ${BRAND_COLOR}; padding: 22px 28px; display: flex; align-items: center; gap: 16px; }
  .logo { width: 60px; height: 60px; border-radius: 10px; object-fit: cover; border: 2px solid rgba(255,255,255,.35); }
  .brand { color: #fff; }
  .brand-name { font-size: 20px; font-weight: 800; letter-spacing: .5px; }
  .brand-sub  { font-size: 11px; opacity: .75; margin-top: 3px; letter-spacing: 1.2px; text-transform: uppercase; }
  .status-banner { background: ${st.bg}; padding: 16px 28px; display: flex; align-items: center; gap: 14px; border-bottom: 2px solid ${st.color}22; }
  .status-emoji { font-size: 34px; }
  .status-label-en { font-size: 21px; font-weight: 800; color: ${st.color}; }
  .status-label-ta { font-size: 14px; color: ${st.color}99; margin-top: 2px; }
  .body { padding: 20px 28px 24px; }
  .greeting { font-size: 14px; color: #374151; margin-bottom: 16px; line-height: 1.6; }
  .greeting strong { color: #1f2937; font-size: 15px; }
  .items-header { font-size: 11px; font-weight: 700; color: #9ca3af; text-transform: uppercase; letter-spacing: .5px; padding: 8px 0 4px; border-top: 1px solid #f3f4f6; }
  table { width: 100%; border-collapse: collapse; }
  .lbl { font-size: 12px; color: #9ca3af; font-weight: 600; text-transform: uppercase; letter-spacing: .4px; padding: 6px 0; width: 38%; vertical-align: top; }
  .val { font-size: 13px; color: #1f2937; font-weight: 600; padding: 6px 0; }
  .total-row td { padding-top: 10px; border-top: 2px solid #e5e7eb; font-size: 15px; font-weight: 800; color: ${BRAND_COLOR}; }
  .footer { background: #f9faf8; padding: 14px 28px; display: flex; align-items: center; justify-content: space-between; border-top: 1px solid #e5e7eb; }
  .footer-left { font-size: 11px; color: #6b7280; }
  .footer-contact { font-size: 12px; color: ${BRAND_COLOR}; font-weight: 700; }
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <img class="logo" src="${LOGO_B64}" />
    <div class="brand">
      <div class="brand-name">Sathvam Natural Products</div>
      <div class="brand-sub">சத்வம் இயற்கை பொருட்கள் · Pure &amp; Natural</div>
    </div>
  </div>
  <div class="status-banner">
    <div class="status-emoji">${st.emoji}</div>
    <div>
      <div class="status-label-en">${st.label}</div>
      <div class="status-label-ta">${st.labelTa}</div>
    </div>
  </div>
  <div class="body">
    <div class="greeting">
      Dear <strong>${fullName}</strong>,<br/>${greetingText}
    </div>
    <table>
      <tr><td class="lbl">Order ID</td><td class="val" style="color:${BRAND_COLOR};font-size:15px;">#${orderNo}</td></tr>
      ${date ? `<tr><td class="lbl">Order Date</td><td class="val">${date}</td></tr>` : ''}
      ${itemsHtml ? `<tr><td colspan="2"><div class="items-header">Items Ordered</div></td></tr>${itemsHtml}` : ''}
      ${total !== '0.00' ? `<tr class="total-row"><td>Total Amount</td><td>₹${total}</td></tr>` : ''}
      ${extraRows}
    </table>
  </div>
  <div class="footer">
    <div class="footer-left">🌐 sathvam.in &nbsp;|&nbsp; Pure • Natural • Cold-Pressed</div>
    <div class="footer-contact">📞 +91 70921 77092</div>
  </div>
</div>
</body></html>`;
}

async function renderCardJpeg(html) {
  const id      = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tmpHtml = path.join(os.tmpdir(), `scard-${id}.html`);
  const tmpPng  = path.join(os.tmpdir(), `scard-${id}.png`);
  const tmpJpg  = path.join(os.tmpdir(), `scard-${id}.jpg`);
  try {
    fs.writeFileSync(tmpHtml, html, 'utf8');
    execSync(`wkhtmltoimage --width 800 --quality 92 "${tmpHtml}" "${tmpPng}"`, { timeout: 20000, stdio: 'pipe' });
    execSync(`convert "${tmpPng}" -quality 88 "${tmpJpg}"`, { timeout: 10000, stdio: 'pipe' });
    return fs.readFileSync(tmpJpg);
  } finally {
    try { fs.unlinkSync(tmpHtml); } catch {}
    try { fs.unlinkSync(tmpPng); } catch {}
    try { fs.unlinkSync(tmpJpg); } catch {}
  }
}

async function uploadCardImage(buf, prefix) {
  const fileName = `${prefix}-${Date.now()}.jpg`;
  const { error } = await supabase.storage
    .from('cards')
    .upload(fileName, buf, { contentType: 'image/jpeg', upsert: true });
  if (error) throw new Error(`Card image upload failed: ${error.message}`);
  const { data } = supabase.storage.from('cards').getPublicUrl(fileName);
  return data.publicUrl;
}

async function sendViaBotSailor(phone, message, imageUrl = null) {
  const token   = process.env.BOTSAILOR_API_TOKEN;
  const phoneId = process.env.BOTSAILOR_PHONE_NUMBER_ID || process.env.WA_PHONE_NUMBER_ID;
  if (!token || !phoneId) return false;
  const body = imageUrl
    ? JSON.stringify({ apiToken: token, phone_number_id: phoneId, phone_number: phone, type: 'image', url: imageUrl, message })
    : null;
  const formBody = !imageUrl
    ? new URLSearchParams({ apiToken: token, phone_number_id: phoneId, phone_number: phone, message }).toString()
    : null;
  const res = await fetch('https://botsailor.com/api/v1/whatsapp/send', {
    method:  'POST',
    headers: { 'Content-Type': imageUrl ? 'application/json' : 'application/x-www-form-urlencoded' },
    body:    imageUrl ? body : formBody,
  });
  const data = await res.json();
  return data.status === '1' || data.status === 1;
}

// Decrypt the customer JSONB field of a single order
function decryptOrder(order) {
  if (!order) return order;
  return { ...order, customer: order.customer ? decryptCustomer(order.customer) : order.customer };
}
// Decrypt an array of orders
function decryptOrders(orders) {
  return (orders || []).map(decryptOrder);
}

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

function buildInvoiceHtml(o, autoPrint = false) {
  const cust      = o.customer || {};
  const name      = cust.name || 'Customer';
  const phone     = cust.phone || '';
  const email     = cust.email || '';
  const addr      = cust.address || '';
  const city      = cust.city || '';
  const state     = cust.state || 'Tamil Nadu';
  const pin       = cust.pincode || '';
  const subtotal  = parseFloat(o.subtotal) || 0;
  const gstTotal  = parseFloat(o.gst) || 0;
  const shipping  = parseFloat(o.shipping) || 0;
  const total     = parseFloat(o.total) || (subtotal + gstTotal + shipping);
  const payMethod = cust.payment || 'online';
  const orderNo   = o.order_no || o.orderNo || '';
  const isIntra   = state.trim().toLowerCase() === 'tamil nadu'; // CGST+SGST vs IGST

  // Build items with per-item GST split
  let taxableTotal = 0, cgstTotal = 0, sgstTotal = 0, igstTotal = 0;
  const itemRows = (o.items || []).map((it, idx) => {
    const nm       = it.productName || it.name || 'Product';
    const hsn      = it.hsn_code || it.hsnCode || '—';
    const rate     = parseFloat(it.rate || it.price || 0);
    const qty      = parseInt(it.qty) || 1;
    const gstPct   = parseFloat(it.gst || 5);
    const baseRate = +(rate / (1 + gstPct / 100)).toFixed(2);
    const taxable  = +(baseRate * qty).toFixed(2);
    const gstAmt   = +(rate * qty - taxable).toFixed(2);
    const half     = +(gstAmt / 2).toFixed(2);
    const lineTotal = +(rate * qty).toFixed(2);
    const size     = it.packSize ? `${it.packSize}${it.packUnit || ''}` : '';
    taxableTotal  += taxable;
    if (isIntra) { cgstTotal += half; sgstTotal += half; }
    else { igstTotal += gstAmt; }
    const gstCols = isIntra
      ? `<td style="text-align:right">₹${half.toFixed(2)}</td><td style="text-align:right">₹${half.toFixed(2)}</td>`
      : `<td style="text-align:right" colspan="2">₹${gstAmt.toFixed(2)}</td>`;
    return `<tr style="background:${idx%2===0?'#fff':'#f9fdf9'}">
      <td>${idx+1}</td>
      <td><strong>${nm}</strong>${size?`<br><span style="color:#888;font-size:9px">${size}</span>`:''}</td>
      <td style="text-align:center;font-size:10px">${hsn}</td>
      <td style="text-align:center">${qty}</td>
      <td style="text-align:right">₹${baseRate.toFixed(2)}</td>
      <td style="text-align:right">₹${taxable.toFixed(2)}</td>
      <td style="text-align:center">${gstPct}%</td>
      ${gstCols}
      <td style="text-align:right;font-weight:700">₹${lineTotal.toFixed(2)}</td>
    </tr>`;
  }).join('');

  const gstHeader = isIntra
    ? `<th style="text-align:right">CGST (2.5%)</th><th style="text-align:right">SGST (2.5%)</th>`
    : `<th style="text-align:right" colspan="2">IGST (5%)</th>`;

  const gstSummaryRows = isIntra ? `
    <div class="tot-row"><span>CGST (2.5%)</span><span>₹${cgstTotal.toFixed(2)}</span></div>
    <div class="tot-row"><span>SGST (2.5%)</span><span>₹${sgstTotal.toFixed(2)}</span></div>` : `
    <div class="tot-row"><span>IGST (5%)</span><span>₹${igstTotal.toFixed(2)}</span></div>`;

  const qrData = encodeURIComponent(`INV:${orderNo}|AMT:${total.toFixed(2)}|DATE:${o.date}|GSTIN:33ABFCS9387K1ZN`);
  const qrUrl  = `https://api.qrserver.com/v1/create-qr-code/?data=${qrData}&size=90x90&format=png&margin=4`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Invoice ${orderNo}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  @page{size:A4;margin:15mm}
  body{font-family:Arial,sans-serif;font-size:11px;color:#1a1a1a;max-width:800px;margin:0 auto}
  .hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:14px;border-bottom:3px double #1a5c2a;margin-bottom:16px}
  .co-name{font-size:17px;font-weight:900;color:#1a5c2a;margin-bottom:3px}
  .co-sub{font-size:10px;color:#555;line-height:1.7}
  .inv-right{text-align:right}
  .inv-title{font-size:20px;font-weight:900;color:#111;letter-spacing:2px}
  .inv-meta{font-size:11px;color:#444;margin-top:4px;line-height:1.7}
  .paid-badge{display:inline-block;background:#dcfce7;color:#16a34a;border:1px solid #86efac;border-radius:4px;padding:2px 10px;font-size:11px;font-weight:800;margin-top:6px}
  .section{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden}
  .sec-box{padding:12px 14px}
  .sec-box:first-child{border-right:1px solid #e5e7eb}
  .sec-title{font-size:9px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:1px;margin-bottom:5px;padding-bottom:4px;border-bottom:1px solid #f0f0f0}
  .sec-val{font-size:11px;color:#222;line-height:1.9}
  table{width:100%;border-collapse:collapse;margin-bottom:14px;font-size:10px}
  thead tr{background:#1a5c2a}
  th{color:#fff;padding:7px 8px;font-size:9px;text-transform:uppercase;letter-spacing:.4px;font-weight:700}
  td{padding:7px 8px;border-bottom:1px solid #f0f0f0;vertical-align:middle}
  .bottom{display:flex;justify-content:space-between;align-items:flex-end;margin-top:10px;gap:20px}
  .totals{min-width:260px}
  .tot-row{display:flex;justify-content:space-between;padding:4px 0;font-size:11px;color:#555;border-bottom:1px solid #f5f5f5}
  .tot-taxable{display:flex;justify-content:space-between;padding:5px 0;font-weight:700;font-size:11px;border-top:1px solid #ddd;border-bottom:1px solid #ddd;margin:4px 0}
  .tot-final{display:flex;justify-content:space-between;padding:8px 0 0;font-size:16px;font-weight:900;color:#1a5c2a;border-top:2px solid #1a5c2a;margin-top:4px}
  .sign-box{border:1px solid #e5e7eb;border-radius:6px;padding:12px 16px;min-width:180px;text-align:center}
  .sign-line{border-top:1px solid #555;margin-top:30px;padding-top:5px;font-size:10px;color:#666}
  .notes{margin-top:14px;font-size:10px;color:#666;padding:10px 12px;background:#f9fafb;border-radius:6px;line-height:1.7;border-left:3px solid #1a5c2a}
  .footer{margin-top:16px;padding-top:10px;border-top:1px dashed #ccc;font-size:10px;color:#aaa;text-align:center;line-height:1.7}
</style></head><body>
  <div class="hdr">
    <div style="display:flex;align-items:center;gap:12px">
      <img src="https://admin.sathvam.in/logo.jpg" alt="Sathvam" style="height:60px;width:auto;object-fit:contain"/>
      <div>
      <div class="co-name">Sathvam Oils and Spices Pvt Ltd</div>
      <div class="co-sub">
        Plot No. 6, Anand Jothi Nagar, Near ABS Hospital, Thanthoni, Tamil Nadu 639005<br>
        GSTIN: <strong>33ABFCS9387K1ZN</strong> &nbsp;|&nbsp; PAN: ABFCS9387K<br>
        Phone: +91 70921 77092 &nbsp;|&nbsp; Email: sales@sathvam.in<br>
        Website: www.sathvam.in
      </div>
      </div>
    </div>
    <div class="inv-right">
      <div class="inv-title">TAX INVOICE</div>
      <div class="inv-meta">
        Invoice No: <strong>${orderNo}</strong><br>
        Invoice Date: <strong>${o.date}</strong><br>
        Supply Type: <strong>${isIntra ? 'Intra-State (TN)' : 'Inter-State'}</strong>
      </div>
      <div><span class="paid-badge">✓ PAID</span></div>
    </div>
  </div>

  <div class="section">
    <div class="sec-box">
      <div class="sec-title">Bill To &amp; Ship To</div>
      <div class="sec-val">
        <strong style="font-size:13px">${name}</strong><br>
        ${addr}<br>${city}${state ? `, ${state}` : ''} — ${pin}<br>
        Ph: <strong>${phone}</strong>${email ? `<br>Email: ${email}` : ''}
      </div>
    </div>
    <div class="sec-box">
      <div class="sec-title">Order &amp; Payment Info</div>
      <div class="sec-val">
        Order No: <strong>${orderNo}</strong><br>
        Order Date: ${o.date}<br>
        Payment: <strong>${payMethod === 'cod' ? 'Cash on Delivery' : payMethod.toUpperCase()}</strong><br>
        Status: <strong style="color:#16a34a">Paid &amp; Confirmed</strong><br>
        Channel: sathvam.in
        ${o.courier ? `<br>Courier: ${o.courier}${o.awb_number ? ` / AWB: ${o.awb_number}` : ''}` : ''}
      </div>
    </div>
  </div>

  <table>
    <thead><tr>
      <th style="text-align:center">#</th>
      <th>Item Description</th>
      <th style="text-align:center">HSN</th>
      <th style="text-align:center">Qty</th>
      <th style="text-align:right">Unit Rate</th>
      <th style="text-align:right">Taxable Amt</th>
      <th style="text-align:center">GST%</th>
      ${gstHeader}
      <th style="text-align:right">Total</th>
    </tr></thead>
    <tbody>${itemRows}</tbody>
  </table>

  <div class="bottom">
    <div>
      <div class="notes">
        <strong>Payment Terms:</strong> Paid in full online via sathvam.in<br>
        <strong>Note:</strong> Goods once sold will not be taken back unless defective.<br>
        <strong>Subject to:</strong> Karur Jurisdiction
      </div>
      <div style="margin-top:10px;display:flex;align-items:center;gap:10px">
        <img src="${qrUrl}" alt="QR" width="90" height="90" style="border:1px solid #e5e7eb;border-radius:4px"/>
        <div style="font-size:9px;color:#888">Scan to verify<br>invoice details</div>
      </div>
    </div>
    <div>
      <div class="totals">
        <div class="tot-row"><span>Taxable Amount</span><span>₹${taxableTotal.toFixed(2)}</span></div>
        ${gstSummaryRows}
        <div class="tot-row"><span>Shipping Charges</span><span>₹${shipping.toFixed(2)}</span></div>
        <div class="tot-taxable"><span>Grand Total (Rounded)</span><span>₹${total.toFixed(2)}</span></div>
        <div class="tot-final"><span>AMOUNT PAID</span><span>₹${total.toFixed(2)}</span></div>
      </div>
      <div class="sign-box" style="margin-top:14px">
        <div style="font-size:10px;color:#555;margin-bottom:4px"><strong>For Sathvam Oils and Spices Pvt Ltd</strong></div>
        <div class="sign-line">Authorised Signatory</div>
      </div>
    </div>
  </div>

  <div class="footer">
    This is a computer-generated tax invoice and does not require a physical signature.<br>
    Thank you for shopping with Sathvam! &nbsp;|&nbsp; Queries: +91 70921 77092 &nbsp;|&nbsp; sales@sathvam.in
  </div>
  ${autoPrint ? '<script>window.onload=()=>{setTimeout(()=>window.print(),500);}<\/script>' : ''}
</body></html>`;
}

// POST /api/webstore-orders/:id/send-whatsapp-invoice — generate PDF invoice & send via BotSailor
router.post('/:id/send-whatsapp-invoice', auth, async (req, res) => {
  try {
    const { data: rawO, error } = await supabase
      .from('webstore_orders').select('*').eq('id', req.params.id).single();
    if (error || !rawO) return res.status(404).json({ error: 'Order not found' });

    const o      = decryptOrder(rawO);
    const cust   = o.customer || {};
    const digits = (cust.phone || '').replace(/\D/g, '');
    if (!digits) return res.status(400).json({ error: 'Customer has no phone number' });
    const phone = digits.length === 10 ? `91${digits}` : digits;

    const token   = process.env.BOTSAILOR_API_TOKEN;
    const phoneId = process.env.BOTSAILOR_PHONE_NUMBER_ID || process.env.WA_PHONE_NUMBER_ID;
    if (!token || !phoneId) return res.status(500).json({ error: 'BotSailor not configured' });

    // ── 1. Generate PDF from existing invoice HTML ──────────────────────────
    const html    = buildInvoiceHtml(o, false);
    const pdfBuf  = await htmlPdf.generatePdf(
      { content: html },
      { format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' } }
    );

    // ── 2. Upload PDF to Supabase Storage ────────────────────────────────────
    const fileName = `invoice-${o.order_no}-${Date.now()}.pdf`;
    const { error: upErr } = await supabase.storage
      .from('invoices')
      .upload(fileName, pdfBuf, { contentType: 'application/pdf', upsert: true });
    if (upErr) throw new Error(`PDF upload failed: ${upErr.message}`);

    const { data: urlData } = supabase.storage.from('invoices').getPublicUrl(fileName);
    const pdfUrl = urlData.publicUrl;

    // ── 3. Send text message + PDF link via BotSailor ───────────────────────
    const subtotal = parseFloat(o.subtotal || 0);
    const gst      = parseFloat(o.gst_amount || o.gst || 0);
    const shipping = parseFloat(o.shipping || 0);
    const total    = parseFloat(o.total || (subtotal + gst + shipping));
    const payMode  = (cust.payment || o.payment_mode || 'online').replace(/upi/i,'UPI').replace(/cod/i,'Cash on Delivery');

    const message =
      `🧾 *Tax Invoice — ${o.order_no}*\n\n` +
      `Hi ${cust.name || 'there'}, your invoice from *Sathvam Natural Products* is ready 🌿\n\n` +
      `💰 Total: ₹${total.toFixed(2)}  |  ✅ ${payMode}\n` +
      `📅 Date: ${o.date || ''}\n\n` +
      `📄 *Download Invoice PDF:*\n${pdfUrl}\n\n` +
      `For any queries: *+91 70921 77092*`;

    const params = new URLSearchParams({ apiToken: token, phone_number_id: phoneId, phone_number: phone, message });
    const bsRes  = await fetch('https://botsailor.com/api/v1/whatsapp/send', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
    });
    const bsData = await bsRes.json();
    if (bsData.status !== '1' && bsData.status !== 1) {
      const msg   = bsData.message || 'BotSailor send failed';
      const is24h = msg.toLowerCase().includes('24 hour') || msg.toLowerCase().includes('template');

      if (is24h) {
        // ── 3b. Fallback: send via BotSailor template (bypasses 24h window) ──
        const tplId = process.env.BOTSAILOR_INVOICE_TEMPLATE_ID;
        if (!tplId) {
          return res.status(400).json({
            error: `WhatsApp 24h window expired. Set BOTSAILOR_INVOICE_TEMPLATE_ID in env to enable auto-fallback to template sending.`,
          });
        }
        const tplParams = new URLSearchParams({
          apiToken:          token,
          phoneNumberID:     phoneId,
          botTemplateID:     tplId,
          sendToPhoneNumber: phone,
          'templateVariable-order_no':   o.order_no || '',
          'templateVariable-name':       cust.name  || 'Customer',
          'templateVariable-total':      `₹${total.toFixed(2)}`,
          'templateVariable-pdf_url':    pdfUrl,
        });
        const tplRes  = await fetch(`https://botsailor.com/api/v1/whatsapp/send/template?${tplParams.toString()}`, { method: 'POST' });
        const tplData = await tplRes.json();
        if (tplData.status !== '1' && tplData.status !== 1) {
          return res.status(400).json({ error: tplData.message || 'Template send failed' });
        }

        await supabase.from('whatsapp_messages').insert({
          phone,
          contact_name: `${cust.name || ''} | ${o.order_no}`,
          direction:    'outbound',
          type:         'template',
          content:      message,
          status:       'sent',
          sent_by:      `invoice:${o.order_no}`,
          timestamp:    new Date().toISOString(),
        });

        return res.json({ success: true, phone, pdfUrl, via: 'template' });
      }

      return res.status(400).json({ error: msg });
    }

    // ── 4. Log the sent message ──────────────────────────────────────────────
    await supabase.from('whatsapp_messages').insert({
      phone,
      contact_name: `${cust.name || ''} | ${o.order_no}`,
      direction:    'outbound',
      type:         'document',
      content:      message,
      status:       'sent',
      sent_by:      `invoice:${o.order_no}`,
      timestamp:    new Date().toISOString(),
    });

    res.json({ success: true, phone, pdfUrl });
  } catch (e) {
    console.error('Send WhatsApp invoice error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/webstore-orders/:id/whatsapp-logs — fetch WA message log for order's customer phone
router.get('/:id/whatsapp-logs', auth, async (req, res) => {
  try {
    const { data: rawO, error } = await supabase
      .from('webstore_orders').select('*').eq('id', req.params.id).single();
    if (error || !rawO) return res.status(404).json({ error: 'Order not found' });

    const o      = decryptOrder(rawO);
    const digits = (o.customer?.phone || '').replace(/\D/g, '');
    const phone  = digits.length === 10 ? `91${digits}` : digits;
    if (!phone) return res.json({ logs: [] });

    const { data: logs } = await supabase
      .from('whatsapp_messages')
      .select('id,direction,content,status,sent_by,timestamp,contact_name')
      .eq('phone', phone)
      .order('timestamp', { ascending: false })
      .limit(50);

    res.json({ logs: logs || [], phone });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/webstore-orders/:id/send-invoice — send invoice to customer via email
router.post('/:id/send-invoice', auth, async (req, res) => {
  try {
    const { data: rawO, error } = await supabase
      .from('webstore_orders').select('*').eq('id', req.params.id).single();
    if (error || !rawO) return res.status(404).json({ error: 'Order not found' });

    const o     = decryptOrder(rawO);
    const cust  = o.customer || {};
    const email = cust.email || '';
    if (!email) return res.status(400).json({ error: 'Customer has no email address' });

    const html = buildInvoiceHtml(o, false);
    await mailer.sendMail({
      from:    process.env.SMTP_FROM || 'Sathvam Oils <sales@sathvam.in>',
      replyTo: process.env.SMTP_REPLY_TO || 'sales@sathvam.in',
      to:      email,
      subject: `Your Invoice ${o.order_no} — Sathvam Oils & Spices`,
      html,
    });
    res.json({ success: true });
  } catch (e) {
    console.error('Send invoice email error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const reviewLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: 'Too many review submissions. Please try again later.' },
  validate: { xForwardedForHeader: false },
});

// Admin: list all webstore orders
router.get('/', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('webstore_orders')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(2000);
  if (error) return res.status(500).json({ error: error.message });
  res.json(decryptOrders(data));
});

// ── Status-change notification helpers ───────────────────────────────────────
const STATUS_LABELS = {
  confirmed:        'Order Confirmed ✅',
  packed:           'Order Packed 📦',
  dispatched:       'Order Dispatched 🚚',
  delivered:        'Order Delivered 🎉',
  cancelled:        'Order Cancelled ❌',
  rejected:         'Order Rejected ❌',
  refund_initiated: 'Refund Initiated 💸',
  refunded:         'Refund Completed ✅',
  partial_refund:   'Partial Refund Initiated 💸',
};

async function sendStatusEmail(order, newStatus, cancelReason) {
  const cust  = order.customer || {};
  const email = cust.email || '';
  if (!email || !process.env.SMTP_USER) return;

  const label    = STATUS_LABELS[newStatus] || newStatus;
  const orderNo  = order.order_no || order.orderNo || '';
  const courier  = order.courier  || '';
  const awb      = order.awb_number || '';
  const trackLine = (newStatus === 'dispatched' && (courier || awb))
    ? `<p style="margin:8px 0;font-size:14px;color:#374151">🚚 <strong>Courier:</strong> ${courier} &nbsp;|&nbsp; <strong>AWB:</strong> ${awb}</p>`
    : '';

  const cancelMsg = cancelReason
    ? `Your order has been cancelled.<br><strong>Reason:</strong> ${cancelReason}<br><br>If you have paid online, your refund will be processed within 5–7 business days. For questions, contact us at sales@sathvam.in.`
    : `Your order has been cancelled. If you have questions, please contact us at sales@sathvam.in.`;

  const msgMap = {
    confirmed:        `We've confirmed your order and it's being prepared for packing.`,
    packed:           `Your order is packed and will be handed to the courier shortly.`,
    dispatched:       `Your order is on its way! ${courier ? `It's with ${courier}` : ''} ${awb ? `(AWB: ${awb})` : ''}.`.trim(),
    delivered:        `Your order has been delivered. We hope you love it! 🌿`,
    cancelled:        cancelMsg,
    rejected:         `We're sorry, your order could not be processed.${cancelReason ? `<br><strong>Reason:</strong> ${cancelReason}` : ''} If you have paid online, your refund will be processed within 5–7 business days. For questions, contact us at sales@sathvam.in.`,
    refund_initiated: `Your refund of <strong>₹${order.total || ''}</strong> has been initiated and will reach your account within 5–7 business days.`,
    refunded:         `Your refund of <strong>₹${order.total || ''}</strong> has been completed successfully. The amount should reflect in your account.`,
    partial_refund:   `A partial refund for your order has been initiated and will reach your account within 5–7 business days. The remaining items will continue to be processed.`,
  };

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#2d1a0e,#5c3317);padding:24px 32px">
        <div style="color:#f5a800;font-size:20px;font-weight:900;letter-spacing:2px">SATHVAM</div>
        <div style="color:rgba(255,255,255,0.7);font-size:12px;margin-top:4px">Order Update</div>
      </div>
      <div style="padding:28px 32px">
        <div style="font-size:18px;font-weight:800;color:#1f2937;margin-bottom:12px">${label}</div>
        <p style="margin:0 0 16px;font-size:14px;color:#374151">Hi ${cust.name || 'there'},</p>
        <p style="margin:0 0 16px;font-size:14px;color:#374151">${msgMap[newStatus] || `Your order status has been updated to <strong>${newStatus}</strong>.`}</p>
        ${trackLine}
        <div style="background:#f9fafb;border-radius:8px;padding:14px 18px;margin:20px 0;font-size:13px;color:#6b7280">
          Order: <strong style="color:#1f2937">${orderNo}</strong>
        </div>
        <p style="font-size:13px;color:#9ca3af;margin:0">Questions? Reply to this email or WhatsApp us at +91 70921 77092.</p>
      </div>
      <div style="background:#f9fafb;padding:14px 32px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af">
        Sathvam Natural Products · export@sathvam.in · +91 70921 77092
      </div>
    </div>`;

  try {
    await mailer.sendMail({
      from:    process.env.SMTP_FROM    || 'Sathvam Natural Products <noreply@sathvam.in>',
      replyTo: process.env.SMTP_REPLY_TO || 'sales@sathvam.in',
      to:      email,
      subject: `${label} — Order ${orderNo}`,
      html,
    });
  } catch (e) {
    console.error('Status email error:', e.message);
  }
}

// Generate PDF invoice and return its public URL (used in status messages)
async function generateInvoicePdfUrl(order) {
  try {
    const html    = buildInvoiceHtml(order, false);
    const pdfBuf  = await htmlPdf.generatePdf(
      { content: html },
      { format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' } }
    );
    const fileName = `invoice-${order.order_no || order.orderNo}-${Date.now()}.pdf`;
    const { error: upErr } = await supabase.storage
      .from('invoices')
      .upload(fileName, pdfBuf, { contentType: 'application/pdf', upsert: true });
    if (upErr) { console.error('Invoice PDF upload:', upErr.message); return null; }
    const { data: urlData } = supabase.storage.from('invoices').getPublicUrl(fileName);
    return urlData.publicUrl || null;
  } catch (e) {
    console.error('generateInvoicePdfUrl:', e.message);
    return null;
  }
}

async function sendStatusWhatsApp(order, newStatus, cancelReason) {
  const token   = process.env.BOTSAILOR_API_TOKEN;
  const phoneId = process.env.BOTSAILOR_PHONE_NUMBER_ID || process.env.WA_PHONE_NUMBER_ID;
  if (!token || !phoneId) return;

  const cust   = order.customer || {};
  const digits = (cust.phone || '').replace(/\D/g, '');
  if (!digits) return;
  const phone   = digits.length === 10 ? `91${digits}` : digits;

  const name    = (cust.name || 'Customer').split(' ')[0]; // first name only
  const orderNo = order.order_no || order.orderNo || '';
  const courier = order.courier || '';
  const awb     = order.awb_number || '';
  const total   = parseFloat(order.total || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const cancelLine = cancelReason ? `\n📋 *Reason / காரணம்:* ${cancelReason}` : '';

  // Generate PDF for statuses where invoice matters
  let invoiceLine = '';
  if (['confirmed', 'dispatched', 'delivered'].includes(newStatus)) {
    const pdfUrl = await generateInvoicePdfUrl(order);
    if (pdfUrl) {
      invoiceLine = `\n\n🧾 *Invoice / விலைப்பட்டியல்:*\n${pdfUrl}`;
    }
  }

  const footer = `\n📞 +91 70921 77092  |  📧 sales@sathvam.in\n🌐 sathvam.in\n\n_Regards,_\n*Sathvam Natural Products* 🌿`;

  // Build item lines for confirmed message
  const itemLines = (order.items || []).map(it => {
    const nm  = it.productName || it.name || 'Product';
    const qty = it.qty || 1;
    const pr  = parseFloat(it.rate || it.price || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
    return `  • ${nm} × ${qty}  —  ₹${pr}`;
  }).join('\n');

  const orderDate = order.date
    ? new Date(order.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    : new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  // Expected delivery: 3–5 business days from order date
  const deliveryFrom = new Date(order.date || Date.now());
  deliveryFrom.setDate(deliveryFrom.getDate() + 3);
  const deliveryTo   = new Date(order.date || Date.now());
  deliveryTo.setDate(deliveryTo.getDate() + 5);
  const deliveryRange = `${deliveryFrom.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} – ${deliveryTo.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`;

  const payStatus = (order.payment_status || 'paid').toLowerCase() === 'paid' ? '✅ Paid' : '⏳ Pending';
  const addr = [cust.address, cust.city, cust.state, cust.pincode].filter(Boolean).join(', ') || '—';

  const msgMap = {
    confirmed: [
      `✅ *Order Confirmation — Sathvam*`,
      ``,
      `Dear *${cust.name || name}*,`,
      `Thank you for your order with *Sathvam Natural Products*! 🌿`,
      ``,
      `📋 *Order ID:* #${orderNo}`,
      `📅 *Order Date:* ${orderDate}`,
      ``,
      `🛒 *Items:*`,
      itemLines || '  —',
      ``,
      `💰 *Total Amount:* ₹${total}`,
      `💳 *Payment Status:* ${payStatus}`,
      ``,
      `📍 *Delivery Address:*`,
      `  ${addr}`,
      ``,
      `🚚 *Expected Delivery:* ${deliveryRange}`,
      `${invoiceLine}`,
      ``,
      `For any queries, contact us at:`,
      `${footer}`,
    ].filter(l => l !== undefined).join('\n'),

    packed: [
      `📦 *ஆர்டர் பேக் செய்யப்பட்டது!* 📦`,
      ``,
      `🙏 வணக்கம் ${name}!`,
      ``,
      `✨ உங்கள் ஆர்டர் *${orderNo}* கவனமாக பேக் செய்யப்பட்டு`,
      `கூரியர் வழியாக அனுப்பத் தயாராக உள்ளது. 🌾`,
      ``,
      `⏳ சீக்கிரம் டிராக்கிங் விவரங்கள் தெரிவிக்கப்படும்.`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `📦 *Order Packed!*`,
      ``,
      `Dear ${name}, your order *${orderNo}* has been carefully packed`,
      `with love and is ready to be handed to the courier. 🌿`,
      ``,
      `⏳ Tracking details will follow shortly.`,
      `${footer}`,
    ].join('\n'),

    dispatched: [
      `🚀 *ஆர்டர் அனுப்பப்பட்டது!* 🚀`,
      ``,
      `🙏 வணக்கம் ${name}!`,
      ``,
      `🎊 உங்கள் ஆர்டர் *${orderNo}* இப்போது வழியில் உள்ளது!`,
      `இயற்கையின் தூய்மை உங்கள் வீட்டை நோக்கி பயணிக்கிறது. 🌿`,
      ``,
      ...(courier ? [`🚚 *கூரியர்:* ${courier}`] : []),
      ...(awb     ? [`📦 *டிராக்கிங் எண்:* ${awb}`, ``, `கூரியர் இணையதளத்தில் உங்கள் ஆர்டரை டிராக் செய்யலாம்.`] : []),
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `🚀 *Order Dispatched!*`,
      ``,
      `Dear ${name}, your order *${orderNo}* is on its way to you!`,
      `Pure nature is travelling to your doorstep. 🌾`,
      ``,
      ...(courier ? [`🚚 *Courier:* ${courier}`] : []),
      ...(awb     ? [`📦 *Tracking No:* ${awb}`, ``, `Track your shipment on the courier's website using the above tracking number.`] : []),
      `${invoiceLine}`,
      `${footer}`,
    ].join('\n'),

    delivered: [
      `🎉 *ஆர்டர் வழங்கப்பட்டது!* 🎉`,
      ``,
      `🙏 வணக்கம் ${name}!`,
      ``,
      `🌟 உங்கள் ஆர்டர் *${orderNo}* வெற்றிகரமாக வழங்கப்பட்டது.`,
      `சத்வம் இயற்கை பொருட்களை நம்பி வாங்கியதற்கு நன்றி! 🙏`,
      ``,
      `💛 உங்கள் ஆரோக்கியமான வாழ்க்கைக்காக நாங்கள் எப்போதும் இங்கே இருக்கிறோம்.`,
      `உங்கள் கருத்தை தெரிவிக்கவும் — அது எங்களுக்கு மிகவும் உதவும். ⭐`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `🎉 *Order Delivered!*`,
      ``,
      `Dear ${name}, your order *${orderNo}* has been delivered successfully.`,
      ``,
      `Thank you for trusting Sathvam Natural Products. 🌿`,
      `We hope every drop brings health and happiness to your family.`,
      ``,
      `⭐ Your review means the world to us — it helps other families`,
      `   discover the goodness of pure cold-pressed oils.`,
      `${invoiceLine}`,
      `${footer}`,
    ].join('\n'),

    cancelled: [
      `🙏 *ஆர்டர் ரத்து செய்யப்பட்டது — ${orderNo}*`,
      ``,
      `வணக்கம் ${name},`,
      ``,
      `உங்கள் ஆர்டர் ரத்து செய்யப்பட்டது.${cancelLine}`,
      ``,
      `💳 ஆன்லைனில் பணம் செலுத்தியிருந்தால், 5–7 வேலை நாட்களில் திரும்ப வரும்.`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `❌ *Order Cancelled — ${orderNo}*`,
      ``,
      `Dear ${name}, your order has been cancelled.${cancelLine}`,
      ``,
      `💳 If you paid online, your refund will be processed within 5–7 business days.`,
      `We apologise for any inconvenience and hope to serve you again. 🙏`,
      `${footer}`,
    ].join('\n'),

    rejected: [
      `🙏 *ஆர்டர் நிராகரிக்கப்பட்டது — ${orderNo}*`,
      ``,
      `வணக்கம் ${name},`,
      ``,
      `மிகவும் வருந்துகிறோம். உங்கள் ஆர்டரை நிறைவேற்ற இயலவில்லை.${cancelLine}`,
      ``,
      `💳 ஆன்லைனில் பணம் செலுத்தியிருந்தால், 5–7 வேலை நாட்களில் திரும்ப வரும்.`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `❌ *Order Rejected — ${orderNo}*`,
      ``,
      `Dear ${name}, unfortunately we were unable to fulfil your order.${cancelLine}`,
      ``,
      `💳 If you paid online, your refund will be processed within 5–7 business days.`,
      `We sincerely apologise and look forward to serving you again. 🙏`,
      `${footer}`,
    ].join('\n'),

    refund_initiated: [
      `💸 *பணத் திரும்பப் பெறுதல் தொடங்கியது — ${orderNo}*`,
      ``,
      `வணக்கம் ${name},`,
      ``,
      `₹${total} தொகை திரும்ப அனுப்பப்படும் செயல் தொடங்கியது.`,
      `5–7 வேலை நாட்களில் உங்கள் கணக்கில் வரும்.`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `💸 *Refund Initiated — ${orderNo}*`,
      ``,
      `Dear ${name}, your refund of ₹${total} has been initiated`,
      `and will reach your account within 5–7 business days.`,
      `${footer}`,
    ].join('\n'),

    refunded: [
      `✅ *பணம் திரும்பி விட்டது — ${orderNo}*`,
      ``,
      `வணக்கம் ${name},`,
      ``,
      `₹${total} தொகை உங்கள் கணக்கில் வரவு வைக்கப்பட்டது. 🙏`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `✅ *Refund Completed — ${orderNo}*`,
      ``,
      `Dear ${name}, your refund of ₹${total} is complete.`,
      `The amount should now reflect in your account. 🙏`,
      `${footer}`,
    ].join('\n'),
  };

  const caption = msgMap[newStatus];
  if (!caption) return;

  try {
    // ── 1. Generate status card image ────────────────────────────────────────
    let cardUrl = null;
    try {
      const html   = buildStatusCardHtml(order, newStatus, { cancelReason });
      const pngBuf = await renderCardJpeg(html);
      cardUrl      = await uploadCardImage(pngBuf, `status-${newStatus}-${orderNo}`);
    } catch (imgErr) {
      console.error('Status card image error:', imgErr.message);
    }

    // ── 2. Send image + caption (or plain text fallback) ─────────────────────
    await sendViaBotSailor(phone, caption, cardUrl || undefined);

    // ── 3. For confirmed/dispatched/delivered — send invoice PDF as follow-up ─
    if (['confirmed', 'dispatched', 'delivered'].includes(newStatus)) {
      try {
        const pdfUrl = await generateInvoicePdfUrl(order);
        if (pdfUrl) {
          const invoiceCaption = `🧾 *Invoice — ${orderNo}*\n\nவிலைப்பட்டியல் / Your tax invoice is attached below.\n\n📥 Download: ${pdfUrl}\n\n🌐 sathvam.in · 📞 +91 70921 77092`;
          await sendViaBotSailor(phone, invoiceCaption);
        }
      } catch (invErr) {
        console.error('Invoice follow-up error:', invErr.message);
      }
    }
  } catch (e) {
    console.error('WA status notify error:', e.message);
  }
}

// Admin: update order status + dispatch info
async function updateOrder(req, res) {
  const { status, notes, courier, awb_number, dispatch_date, delivered_date, cancel_reason } = req.body;
  const updates = {};
  if (status         !== undefined) updates.status         = status;
  if (notes          !== undefined) updates.notes          = notes;
  if (courier        !== undefined) updates.courier        = courier;
  if (awb_number     !== undefined) updates.awb_number     = awb_number;
  if (dispatch_date  !== undefined) updates.dispatch_date  = dispatch_date;
  if (delivered_date !== undefined) updates.delivered_date = delivered_date;
  if (cancel_reason  !== undefined) updates.cancel_reason  = cancel_reason;
  const { data, error } = await supabase
    .from('webstore_orders')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });

  const decrypted = decryptOrder(data);

  // Fire-and-forget notifications + stock automations on status change
  if (status && decrypted) {
    setImmediate(async () => {
      await sendStatusEmail(decrypted, status, cancel_reason);
      await sendStatusWhatsApp(decrypted, status, cancel_reason);

      const today   = new Date().toISOString().slice(0, 10);
      const orderNo = decrypted.order_no || decrypted.orderNo || '';
      const items   = decrypted.items || [];

      // ── PACKED: deduct packing materials (label + cover/bottle) ───────────
      if (status === 'packed') {
        try {
          const productIds = items.map(i => i.product_id).filter(Boolean);
          if (productIds.length) {
            const { data: prods } = await supabase
              .from('products').select('id,name,packing_links').in('id', productIds);
            const prodMap = {};
            for (const p of (prods || [])) prodMap[p.id] = p;

            for (const item of items) {
              const prod  = prodMap[item.product_id];
              const qty   = parseInt(item.qty) || 1;
              const links = prod?.packing_links || {};
              const matIds = [
                ...(Array.isArray(links.materialIds) ? links.materialIds : [links.coverId, links.bottleId].filter(Boolean)),
                links.labelId,
              ].filter(Boolean);

              for (const matId of matIds) {
                const { data: mat } = await supabase
                  .from('packing_materials').select('id,current_stock').eq('id', matId).single();
                if (!mat) continue;
                const newStock = Math.max(0, (parseFloat(mat.current_stock) || 0) - qty);
                await supabase.from('packing_materials').update({
                  current_stock: newStock, updated_at: new Date().toISOString(),
                }).eq('id', matId);
              }
            }
            console.log(`[AUTO] Packing materials deducted for order ${orderNo}`);
          }
        } catch (e) { console.error('[AUTO] Pack deduct error:', e.message); }
      }

      // ── SHIPPED: deduct finished goods ─────────────────────────────────────
      if (status === 'shipped') {
        try {
          const rows = items.map(item => ({
            product_name: item.productName || item.name || 'Unknown',
            category:     'oil',
            unit:         'pcs',
            qty:          parseFloat(item.qty) || 1,
            type:         'out',
            date:         today,
            notes:        `Auto-deducted on ship — Order ${orderNo}`,
            batch_ref:    orderNo,
            created_by:   'system',
            created_at:   new Date().toISOString(),
            updated_at:   new Date().toISOString(),
          }));
          await supabase.from('finished_goods').insert(rows);
          console.log(`[AUTO] Finished goods deducted for order ${orderNo}`);
        } catch (e) { console.error('[AUTO] FG deduct error:', e.message); }
      }

      // ── DELIVERED: auto-send invoice email + loyalty points ─────────────────
      if (status === 'delivered') {
        try { await sendCustomerInvoice(decrypted, decrypted.payment_id); } catch (e) {}

        // Award loyalty points (1 pt per ₹100)
        try {
          const custEmail = decrypted.customer?.email;
          if (custEmail) {
            const { data: cust } = await supabase
              .from('customers').select('id').eq('email', custEmail).single();
            if (cust) {
              const total  = parseFloat(decrypted.total) || 0;
              const points = Math.floor(total / 100);
              if (points > 0) {
                const key    = `cust_loyalty_${cust.id}`;
                const { data: setting } = await supabase
                  .from('settings').select('value').eq('key', key).single();
                const existing = setting?.value || { points: 0, history: [] };
                existing.points = (existing.points || 0) + points;
                existing.history = [
                  { date: today, type: 'earn', pts: points, ref: orderNo, note: 'Delivery loyalty' },
                  ...(existing.history || []),
                ].slice(0, 50);
                await supabase.from('settings').upsert({ key, value: existing, updated_at: new Date().toISOString() });
                console.log(`[AUTO] Loyalty +${points} pts for ${custEmail} — ${orderNo}`);
              }
            }
          }
        } catch (e) { console.error('[AUTO] Loyalty error:', e.message); }
      }
    });
  }

  res.json(decrypted);
}
router.put('/:id',   auth, updateOrder);
router.patch('/:id', auth, updateOrder);

// Bulk insert — used once to migrate existing localStorage data
router.post('/bulk', auth, async (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : [];
  if (rows.length === 0) return res.json({ synced: 0 });
  const ins = rows.map(o => ({
    id:       o.id,
    order_no: o.orderNo || o.order_no || '',
    date:     o.date || new Date().toISOString().slice(0, 10),
    customer: o.customer || {},
    items:    o.items || [],
    subtotal: parseFloat(o.subtotal) || 0,
    gst:      parseFloat(o.gst) || 0,
    shipping: parseFloat(o.shipping) || 0,
    total:    parseFloat(o.total) || 0,
    status:   o.status || 'confirmed',
    channel:  o.channel || 'website',
  }));
  const { data, error } = await supabase.from('webstore_orders').upsert(ins, { onConflict: 'id' }).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json({ synced: (data || []).length });
});

// Public: look up order status by order_no + phone (customer self-serve)
router.get('/status', async (req, res) => {
  const { order_no, phone } = req.query;
  if (!order_no || !phone) return res.status(400).json({ error: 'order_no and phone required' });
  const { data, error } = await supabase
    .from('webstore_orders')
    .select('id,order_no,status,delivered_date,items,customer')
    .ilike('order_no', order_no.trim())
    .single();
  if (error || !data) return res.status(404).json({ error: 'Order not found' });
  // Decrypt customer field before comparing phone number
  const plainCustomer = data.customer ? decryptCustomer(data.customer) : {};
  const orderPhone = (plainCustomer.phone || '').replace(/\D/g,'');
  const inputPhone = phone.trim().replace(/\D/g,'');
  if (!orderPhone.endsWith(inputPhone.slice(-10)) && !inputPhone.endsWith(orderPhone.slice(-10)))
    return res.status(403).json({ error: 'Phone number does not match' });
  res.json({ id: data.id, order_no: data.order_no, status: data.status, delivered_date: data.delivered_date, items: data.items });
});

// ── BotSailor webhook — order status lookup for WhatsApp bot ─────────────────
// BotSailor calls this when customer types "track order" or "where is my order"
// Configure in BotSailor: API Integration → POST https://api.sathvam.in/api/webstore-orders/botsailor/track
// Expected body from BotSailor: { phone, order_no } OR { phone } to get latest order
router.post('/botsailor/track', async (req, res) => {
  try {
    const secret = process.env.BOTSAILOR_WEBHOOK_SECRET;
    if (secret && req.headers['x-botsailor-secret'] !== secret)
      return res.status(401).json({ error: 'Unauthorized' });

    const rawPhone = (req.body.phone || req.body.customer_phone || '').replace(/\D/g, '');
    const orderNo  = (req.body.order_no || req.body.orderNo || '').trim().toUpperCase();
    if (!rawPhone) return res.status(400).json({ message: 'Please share your phone number to look up your order.' });

    // Build query — by order number or by phone (latest order)
    let query = supabase.from('webstore_orders').select('order_no,status,courier,awb_number,items,customer,date,dispatch_date,delivered_date');
    if (orderNo) {
      query = query.ilike('order_no', orderNo);
    } else {
      query = query.order('created_at', { ascending: false }).limit(10);
    }
    const { data: orders, error } = await query;
    if (error || !orders?.length) return res.json({ message: `No orders found. Please check your order number or contact us at +91 70921 77092.` });

    // Find order matching phone
    let order = null;
    for (const o of orders) {
      const plain = o.customer ? decryptCustomer(o.customer) : {};
      const oPhone = (plain.phone || '').replace(/\D/g, '');
      if (oPhone.endsWith(rawPhone.slice(-10)) || rawPhone.endsWith(oPhone.slice(-10))) {
        order = { ...o, customer: plain };
        break;
      }
    }
    if (!order) return res.json({ message: `No order found for this phone number. Contact us at +91 70921 77092 for help.` });

    const STATUS_LABELS = {
      confirmed:  '✅ Confirmed — being packed',
      packed:     '📦 Packed — ready to dispatch',
      dispatched: '🚚 Dispatched — on the way',
      delivered:  '🎉 Delivered',
      cancelled:  '❌ Cancelled',
    };
    const statusLabel = STATUS_LABELS[order.status] || order.status;
    const trackingInfo = order.awb_number
      ? `\n🔍 *AWB:* ${order.awb_number}${order.courier ? ` (${order.courier})` : ''}`
      : '';
    const deliveredOn = order.delivered_date ? `\n📅 Delivered on: ${order.delivered_date}` : '';

    const message =
      `📦 *Order Status — ${order.order_no}*\n\n` +
      `📋 *Status:* ${statusLabel}${trackingInfo}${deliveredOn}\n` +
      `📅 *Ordered:* ${order.date || ''}\n` +
      `🛍️ *Items:* ${(order.items || []).map(i => `${i.name} ×${i.qty}`).join(', ')}\n\n` +
      `Questions? Call *+91 70921 77092*`;

    res.json({ message, order_no: order.order_no, status: order.status });
  } catch (e) {
    console.error('BotSailor track error:', e.message);
    res.json({ message: 'Sorry, could not fetch order status. Please contact us at +91 70921 77092.' });
  }
});

// ── Product Reviews ──────────────────────────────────────────────────────────

// GET /api/webstore-orders/reviews — list all reviews (admin)
router.get('/reviews', auth, async (req, res) => {
  try {
    const { product_id, status, limit = 200 } = req.query;
    let q = supabase.from('product_reviews')
      .select('*').order('created_at', { ascending: false }).limit(parseInt(limit));
    if (product_id) q = q.eq('product_id', product_id);
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/webstore-orders/reviews/public/:product_id — public approved reviews
router.get('/reviews/public/:product_id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('product_reviews')
      .select('id,reviewer_name,rating,title,body,created_at')
      .eq('product_id', req.params.product_id)
      .eq('status', 'approved')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/webstore-orders/reviews/verify-purchase — check order before allowing review
router.post('/reviews/verify-purchase', reviewLimiter, async (req, res) => {
  try {
    const { order_no } = req.body;
    if (!order_no || !order_no.trim()) return res.status(400).json({ error: 'Order number required' });
    const { data, error } = await supabase.from('webstore_orders')
      .select('order_no, customer, items, status')
      .eq('order_no', order_no.trim().toUpperCase())
      .single();
    if (error || !data) return res.status(404).json({ error: 'Order not found. Please check your order number.' });
    if (!['confirmed','dispatched','delivered'].includes(data.status)) {
      return res.status(400).json({ error: 'Only delivered or confirmed orders can be reviewed.' });
    }
    res.json({
      valid: true,
      customer_name: data.customer?.name || '',
      items: (data.items || []).map(i => ({ id: i.id, name: i.name })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/webstore-orders/reviews — submit review (verified purchase only)
router.post('/reviews', reviewLimiter, async (req, res) => {
  try {
    const { product_id, product_name, order_no, reviewer_name, reviewer_email, rating, title, body } = req.body;
    if (!product_id || !rating || !reviewer_name || !order_no) return res.status(400).json({ error: 'product_id, rating, reviewer_name, order_no required' });
    if (reviewer_name.length > 100) return res.status(400).json({ error: 'Name too long' });
    if (title && title.length > 200) return res.status(400).json({ error: 'Title too long' });
    if (body && body.length > 2000) return res.status(400).json({ error: 'Review too long' });

    // Verify the order exists and is from a real customer
    const { data: order } = await supabase.from('webstore_orders')
      .select('order_no, status').eq('order_no', order_no.trim().toUpperCase()).single();
    if (!order) return res.status(400).json({ error: 'Invalid order number.' });

    // Prevent duplicate review for same order + product
    const { data: existing } = await supabase.from('product_reviews')
      .select('id').eq('order_id', order_no.trim().toUpperCase()).eq('product_id', product_id).single();
    if (existing) return res.status(400).json({ error: 'You have already reviewed this product.' });

    const { data, error } = await supabase.from('product_reviews')
      .insert({ product_id, product_name: product_name || '', order_id: order_no.trim().toUpperCase(), reviewer_name, reviewer_email: reviewer_email || '', rating: Math.min(5, Math.max(1, parseInt(rating))), title: title || '', body: body || '', status: 'pending' })
      .select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/webstore-orders/reviews/:id — approve/reject (admin)
router.patch('/reviews/:id', auth, async (req, res) => {
  try {
    const { status, admin_reply } = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (status !== undefined) updates.status = status;
    if (admin_reply !== undefined) updates.admin_reply = admin_reply;
    const { data, error } = await supabase.from('product_reviews')
      .update(updates).eq('id', req.params.id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Customer CRM ─────────────────────────────────────────────────────────────

// GET /api/webstore-orders/crm — customer list with order stats
router.get('/crm', auth, async (req, res) => {
  try {
    const { data: orders, error } = await supabase.from('webstore_orders')
      .select('customer,total,status,created_at')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    const customers = {};
    for (const o of orders || []) {
      const cust = o.customer ? decryptCustomer(o.customer) : {};
      const key = (cust.phone || '').replace(/\D/g, '') || cust.email || cust.name;
      if (!key) continue;
      if (!customers[key]) {
        customers[key] = { name: cust.name, phone: cust.phone, email: cust.email, city: cust.city, state: cust.state, orders: 0, total_spent: 0, first_order: o.created_at, last_order: o.created_at };
      }
      customers[key].orders++;
      if (o.status !== 'cancelled') customers[key].total_spent += parseFloat(o.total || 0);
      if (o.created_at > customers[key].last_order) customers[key].last_order = o.created_at;
      if (o.created_at < customers[key].first_order) customers[key].first_order = o.created_at;
    }
    const list = Object.values(customers).sort((a, b) => b.total_spent - a.total_spent);
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Exported helper: send order confirmation + invoice email to customer ───────
async function sendCustomerInvoice(order, paymentId) {
  // Decrypt customer PII — caller may pass encrypted data from DB
  const decOrder = decryptOrder(order);
  const cust  = decOrder.customer || {};
  const email = cust.email || decOrder.email;
  if (!email) return; // no email — skip silently
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  try {
    const html = buildInvoiceHtml(decOrder, false);
    await mailer.sendMail({
      from:    process.env.SMTP_FROM || 'Sathvam Natural Products <noreply@sathvam.in>',
      replyTo: process.env.SMTP_REPLY_TO || 'sales@sathvam.in',
      to:      email,
      subject: `Your Order Confirmation — ${order.orderNo || order.order_no} 🌿`,
      html: `<div style="font-family:sans-serif;max-width:640px;margin:0 auto">
  <div style="background:linear-gradient(135deg,#1a5c2a,#2d7a3a);color:#fff;padding:20px 28px;border-radius:10px 10px 0 0;text-align:center">
    <div style="font-size:32px;margin-bottom:6px">🌿</div>
    <h2 style="margin:0;font-size:20px">Order Confirmed!</h2>
    <div style="opacity:.85;font-size:13px;margin-top:4px">Thank you for choosing Sathvam Natural Products</div>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:20px 28px;background:#fffdf7;border-radius:0 0 10px 10px">
    <p style="color:#1f2937;font-size:15px;margin-top:0">Hi <strong>${cust.name || 'there'}</strong>! 👋</p>
    <p style="color:#374151;font-size:14px;line-height:1.6">
      Your order <strong>#${order.orderNo || order.order_no}</strong> has been placed successfully and will be dispatched within 1–2 business days.
      ${paymentId ? `<br><span style="color:#6b7280;font-size:12px">Payment ID: ${paymentId}</span>` : ''}
    </p>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px 16px;margin:16px 0;font-size:13px;color:#166534">
      📦 We'll send you a WhatsApp/SMS update once your order is dispatched with tracking details.
    </div>
    <p style="color:#374151;font-size:13px">Your invoice is attached below for reference:</p>
  </div>
</div>
<div style="margin-top:16px">${html}</div>`,
    });
  } catch (e) { console.error('Customer invoice email error:', e.message); }
}

module.exports = router;
module.exports.sendCustomerInvoice = sendCustomerInvoice;
