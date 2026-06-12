/**
 * WhatsApp Ordering System — State Machine
 *
 * Handles a full ordering flow via WhatsApp messages:
 *   ORDER/BUY  → browse products → add to cart → checkout → name → address → pay
 *
 * Session stored in Supabase `settings` table:
 *   key = wa_order_session_<phone>
 *   value = { step, products, cart, customer_name, address, payment_link_id,
 *             payment_link_url, created_at, updated_at }
 *
 * Session expires after 45 minutes of inactivity (based on updated_at).
 *
 * Public exports:
 *   handleOrderMessage(phone, text, subscriberName) → { reply, done }
 *   handlePaymentLinkPaid(paymentLinkId, razorpayPaymentId)
 */

'use strict';

const fs            = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { sendText, toChatId } = require('../lib/greenapi');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

const GREENAPI_BASE = 'https://api.green-api.com';
const PNG_GEN_URL   = 'http://host.docker.internal:8765/generate';

// ── Session helpers ───────────────────────────────────────────────────────────

const SESSION_KEY   = phone => `wa_order_session_${phone}`;
const SESSION_TTL_MS = 45 * 60 * 1000; // 45 minutes

async function loadSession(phone) {
  try {
    const { data } = await supabase
      .from('settings')
      .select('value')
      .eq('key', SESSION_KEY(phone))
      .single();
    if (!data?.value) return null;
    const sess = data.value;
    // Expire check
    const updatedAt = sess.updated_at || sess.created_at;
    if (updatedAt && Date.now() - new Date(updatedAt).getTime() > SESSION_TTL_MS) {
      await clearSession(phone);
      return null;
    }
    return sess;
  } catch {
    return null;
  }
}

async function saveSession(phone, session) {
  const now = new Date().toISOString();
  const value = {
    ...session,
    updated_at: now,
    created_at: session.created_at || now,
  };
  await supabase.from('settings').upsert({
    key:   SESSION_KEY(phone),
    value,
  });
  return value;
}

async function clearSession(phone) {
  try {
    await supabase.from('settings').delete().eq('key', SESSION_KEY(phone));
  } catch { /* non-fatal */ }
}

// ── Product loader ────────────────────────────────────────────────────────────

async function loadOrderableProducts() {
  const { data, error } = await supabase
    .from('products')
    .select('id,name,cat,pack_size,pack_unit,unit,website_price,price,active')
    .eq('active', true)
    .neq('cat', 'raw')
    .order('name');

  if (error) throw new Error(`Product load failed: ${error.message}`);

  return (data || [])
    .filter(p => (p.website_price || p.price || 0) > 0)
    .map((p, i) => ({
      id:      p.id,
      name:    p.name,
      price:   p.website_price || p.price,
      packStr: p.pack_size ? `${p.pack_size}${p.pack_unit || p.unit || ''}` : (p.unit || ''),
      index:   i + 1,
    }));
}

// ── Cart helpers ──────────────────────────────────────────────────────────────

function cartTotal(cart) {
  return cart.reduce((s, i) => s + i.price * i.qty, 0);
}

function formatCartLine(item) {
  return `• ${item.name} ${item.packStr} × ${item.qty} — ₹${(item.price * item.qty).toLocaleString('en-IN')}`;
}

function formatCartBlock(cart) {
  const lines = cart.map(formatCartLine).join('\n');
  const total = cartTotal(cart);
  return `${lines}\n\n💰 *Total: ₹${total.toLocaleString('en-IN')}*`;
}

// ── Input parsers ─────────────────────────────────────────────────────────────

/**
 * Parse item selections from user text.
 * Supported formats:
 *   "1 2"          → item 1, qty 2
 *   "1:2"          → item 1, qty 2
 *   "1,2"          → item 1, qty 2 (single item)
 *   "1 2, 3 1"     → item 1 qty 2, item 3 qty 1
 *   "1 2 3 1"      → item 1 qty 2, item 3 qty 1 (pairs)
 *   "add 1 qty 2"  → item 1, qty 2
 * Returns: [{index, qty}] or null if no valid selections
 */
function parseSelections(text) {
  const t = text.trim().toLowerCase().replace(/^add\s+/i, '');

  // Remove "qty" keyword
  const cleaned = t.replace(/\bqty\b/gi, '').replace(/\s+/g, ' ').trim();

  const results = [];

  // Split on commas first
  const parts = cleaned.split(',').map(s => s.trim()).filter(Boolean);

  for (const part of parts) {
    // Match "N:M" or "N M"
    const m = part.match(/^(\d+)\s*[:\s]\s*(\d+)$/);
    if (m) {
      results.push({ index: parseInt(m[1], 10), qty: parseInt(m[2], 10) });
      continue;
    }
    // Single number — qty defaults to 1
    const single = part.match(/^(\d+)$/);
    if (single) {
      results.push({ index: parseInt(single[1], 10), qty: 1 });
    }
  }

  // If single part had no comma and we got nothing, try sequential pairs "1 2 3 1"
  if (results.length === 0 && parts.length === 1) {
    const nums = parts[0].match(/\d+/g);
    if (nums && nums.length >= 2 && nums.length % 2 === 0) {
      for (let i = 0; i < nums.length; i += 2) {
        results.push({ index: parseInt(nums[i], 10), qty: parseInt(nums[i + 1], 10) });
      }
    }
  }

  return results.length > 0 ? results : null;
}

// ── Razorpay payment link creator ─────────────────────────────────────────────

async function createRazorpayPaymentLink({ total, customerName, phone, notes }) {
  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error('Razorpay credentials not configured');

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const expireBy = Math.floor(Date.now() / 1000) + 24 * 60 * 60; // 24 hours

  // Normalize phone to 12 digits for Razorpay
  const digits = (phone || '').replace(/\D/g, '');
  const contact = digits.length === 10 ? `91${digits}` : digits;

  const body = {
    amount:          Math.round(total * 100), // paise
    currency:        'INR',
    description:     'Sathvam Order via WhatsApp',
    customer:        { name: customerName, contact },
    notify:          { sms: false, email: false },
    reminder_enable: false,
    expire_by:       expireBy,
    notes:           { wa_phone: phone, source: 'whatsapp_order', ...notes },
  };

  const res = await fetch('https://api.razorpay.com/v1/payment_links', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Basic ${auth}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data.id) throw new Error(`Razorpay payment link error: ${JSON.stringify(data)}`);

  return { id: data.id, url: data.short_url || data.id };
}

// ── Order number generator ─────────────────────────────────────────────────────

async function generateWaOrderNo() {
  const now = new Date();
  // Use IST (UTC+5:30)
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const dateStr = ist.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD

  // Count existing WA orders today (IST date)
  const todayIST = ist.toISOString().slice(0, 10);
  const { count } = await supabase
    .from('webstore_orders')
    .select('id', { count: 'exact', head: true })
    .eq('channel', 'whatsapp')
    .eq('date', todayIST);

  const seq = String((count || 0) + 1).padStart(4, '0');
  return `SAT-${dateStr}-${seq}`;
}

// ── PNG sender (same pattern as cartReminder.js) ───────────────────────────────

async function sendOrderConfirmationPng(phone, orderData) {
  try {
    // Generate PNG via the cart-reminder microservice
    const genRes = await fetch(PNG_GEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'order', data: orderData }),
      signal:  AbortSignal.timeout(60_000),
    });
    const genJson = await genRes.json();
    if (!genJson.ok) throw new Error(genJson.error || 'PNG generation failed');
    const pngPath = genJson.path;

    // Upload via Green API sendFileByUpload
    const instanceId = process.env.GREENAPI_INSTANCE_ID;
    const token      = process.env.GREENAPI_API_TOKEN;
    const chatId     = toChatId(phone);
    if (!chatId) throw new Error(`Invalid phone: ${phone}`);

    const fileBuffer = fs.readFileSync(pngPath);
    const blob       = new Blob([fileBuffer], { type: 'image/png' });
    const form       = new FormData();
    form.append('chatId',   chatId);
    form.append('caption',  `🌿 *SATHVAM* | Order #${orderData.order_no}\n✅ *Order Confirmed*\n\nThank you! We'll process your order shortly.\n\n👉 https://www.sathvam.in/orders\n\nReply anytime — Team Sathvam 🙏`);
    form.append('file',     blob, 'Sathvam_Order.png');

    const uploadRes = await fetch(
      `${GREENAPI_BASE}/waInstance${instanceId}/sendFileByUpload/${token}`,
      { method: 'POST', body: form },
    );
    const uploadData = await uploadRes.json();
    if (!uploadData.idMessage) throw new Error(`Green API upload error: ${JSON.stringify(uploadData)}`);
    return true;
  } catch (e) {
    console.error('[wa-order] PNG send error:', e.message);
    return false;
  }
}

// ── Step handlers ─────────────────────────────────────────────────────────────

async function handleBrowse(phone) {
  const products = await loadOrderableProducts();
  if (!products.length) {
    return { reply: '😔 No products are available for ordering right now. Please visit https://sathvam.in', done: true };
  }

  const productLines = products
    .map(p => `${p.index}. ${p.name} · ${p.packStr} — ₹${p.price.toLocaleString('en-IN')}`)
    .join('\n');

  await saveSession(phone, { step: 'selecting', products, cart: [] });

  const reply =
    `🛍 *Sathvam — Place Your Order*\n\n` +
    `Choose products by number and quantity:\n\n` +
    `${productLines}\n\n` +
    `*How to order:* Reply with item number and qty\n` +
    `Example: *1 2* (item 1, qty 2)\n` +
    `Or multiple: *1 2, 3 1*\n\n` +
    `Reply *CART* to see your cart\n` +
    `Reply *DONE* to finish selecting`;

  return { reply, done: false };
}

async function handleSelecting(phone, text, session) {
  const t = text.trim().toUpperCase();

  // CANCEL
  if (/^(cancel|CANCEL)$/i.test(t)) {
    await clearSession(phone);
    return { reply: 'Order cancelled. Reply *ORDER* to start again.', done: true };
  }

  // CART
  if (/^cart$/i.test(t)) {
    if (!session.cart || !session.cart.length) {
      return { reply: '🛒 Your cart is empty.\n\nSend item numbers to add products. Example: *1 2*', done: false };
    }
    const reply = `🛒 *Your Cart:*\n\n${formatCartBlock(session.cart)}\n\nSend more items or reply *DONE* to checkout.`;
    return { reply, done: false };
  }

  // DONE / CHECKOUT / CONFIRM
  if (/^(done|checkout|confirm)$/i.test(t)) {
    if (!session.cart || !session.cart.length) {
      return { reply: '🛒 Your cart is empty. Add some items first!', done: false };
    }
    await saveSession(phone, { ...session, step: 'address_name' });
    const reply =
      `📋 *Your Cart:*\n\n${formatCartBlock(session.cart)}\n\n` +
      `To complete your order, I need your delivery details.\n\n` +
      `👤 Please reply with your *name*:`;
    return { reply, done: false };
  }

  // Try to parse item selections
  const selections = parseSelections(text);
  if (!selections) {
    return {
      reply: `❓ I didn't understand that.\n\nSend item number + qty (e.g. *1 2*)\nReply *CART* to see cart\nReply *DONE* to checkout`,
      done: false,
    };
  }

  const updatedCart = [...(session.cart || [])];

  for (const sel of selections) {
    const product = (session.products || []).find(p => p.index === sel.index);
    if (!product) continue;
    const qty = Math.max(1, Math.min(sel.qty, 99));
    const existing = updatedCart.find(c => c.id === product.id);
    if (existing) {
      existing.qty = qty;
    } else {
      updatedCart.push({ id: product.id, name: product.name, price: product.price, packStr: product.packStr, qty });
    }
  }

  await saveSession(phone, { ...session, cart: updatedCart });

  const addedNames = selections
    .map(s => (session.products || []).find(p => p.index === s.index))
    .filter(Boolean)
    .map(p => p.name)
    .join(', ');

  const cartSummary = updatedCart.map(i => `${i.name} ×${i.qty}`).join(', ');
  const total = cartTotal(updatedCart);

  const reply =
    `✅ *Added!* ${addedNames || 'Items updated'}\n\n` +
    `🛒 Cart: ${cartSummary}\n💰 Total: ₹${total.toLocaleString('en-IN')}\n\n` +
    `Send more items or reply *DONE* to checkout`;

  return { reply, done: false };
}

async function handleAddressName(phone, text, session) {
  if (/^(cancel)$/i.test(text.trim())) {
    await clearSession(phone);
    return { reply: 'Order cancelled. Reply *ORDER* to start again.', done: true };
  }

  const name = text.trim();
  if (name.length < 2) {
    return { reply: '👤 Please reply with your full *name*:', done: false };
  }

  await saveSession(phone, { ...session, step: 'address_text', customer_name: name });

  return {
    reply: `📍 Please send your complete *delivery address*:\n(Street, City, State, Pincode)`,
    done: false,
  };
}

async function handleAddressText(phone, text, session) {
  if (/^(cancel)$/i.test(text.trim())) {
    await clearSession(phone);
    return { reply: 'Order cancelled. Reply *ORDER* to start again.', done: true };
  }

  const address = text.trim();
  if (address.length < 10) {
    return {
      reply: `📍 Please send your complete *delivery address*:\n(Street, City, State, Pincode)`,
      done: false,
    };
  }

  const total = cartTotal(session.cart || []);
  let paymentLink;
  try {
    paymentLink = await createRazorpayPaymentLink({
      total,
      customerName: session.customer_name,
      phone,
      notes: { address },
    });
  } catch (e) {
    console.error('[wa-order] Payment link error:', e.message);
    return {
      reply: `❌ Sorry, something went wrong creating your payment link. Please try again or order at https://sathvam.in`,
      done: true,
    };
  }

  await saveSession(phone, {
    ...session,
    step:             'payment_pending',
    address,
    payment_link_id:  paymentLink.id,
    payment_link_url: paymentLink.url,
  });

  const cartLines = (session.cart || []).map(formatCartLine).join('\n');
  const shipping  = total >= 2500 ? 0 : 60;
  const grandTotal = total + shipping;
  const shippingLine = shipping > 0 ? `\n🚚 Shipping: ₹${shipping}` : '\n🚚 Free shipping';

  const reply =
    `✅ *Order Summary*\n\n` +
    `${cartLines}${shippingLine}\n💰 *Total: ₹${grandTotal.toLocaleString('en-IN')}*\n` +
    `📍 Deliver to: ${address}\n\n` +
    `💳 *Pay now:*\n${paymentLink.url}\n\n` +
    `Link valid for 24 hours. Your order will be confirmed instantly after payment.\n\n` +
    `Reply *CANCEL* to cancel this order.`;

  return { reply, done: false };
}

async function handlePaymentPending(phone, text, session) {
  if (/^(cancel)$/i.test(text.trim())) {
    await clearSession(phone);
    return { reply: 'Order cancelled. Reply *ORDER* to start again.', done: true };
  }

  // Re-send payment link
  const total = cartTotal(session.cart || []);
  const shipping = total >= 2500 ? 0 : 60;
  const grandTotal = total + shipping;

  return {
    reply:
      `⏳ Your order is awaiting payment.\n\n` +
      `💰 Total: ₹${grandTotal.toLocaleString('en-IN')}\n\n` +
      `💳 *Pay here:*\n${session.payment_link_url || 'Link unavailable'}\n\n` +
      `Reply *CANCEL* to cancel.`,
    done: false,
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * handleOrderMessage — called from botsailor webhook for every incoming message.
 *
 * Returns { reply: string|null, done: boolean }
 *   reply = null  → not handled here, fall through to AI / keyword replies
 *   reply = string → send this reply, stop processing
 *   done = true   → session ended (can be used for logging)
 */
async function handleOrderMessage(phone, text, subscriberName) {
  const t = (text || '').trim();

  // Check for ORDER trigger keywords (always active — starts a new session)
  if (/^(order|buy|ஆர்டர்)$/i.test(t)) {
    return handleBrowse(phone);
  }

  // Load existing session
  const session = await loadSession(phone);
  if (!session) {
    // No active session — not our message
    return { reply: null, done: false };
  }

  // Route by step
  switch (session.step) {
    case 'browsing':
      // Shouldn't stay here, but treat as selecting
      return handleSelecting(phone, t, session);

    case 'selecting':
      return handleSelecting(phone, t, session);

    case 'address_name':
      return handleAddressName(phone, t, session);

    case 'address_text':
      return handleAddressText(phone, t, session);

    case 'payment_pending':
      return handlePaymentPending(phone, t, session);

    default:
      // Unknown step — clear and bail
      await clearSession(phone);
      return { reply: null, done: false };
  }
}

// ── Payment webhook handler ───────────────────────────────────────────────────

/**
 * handlePaymentLinkPaid — called from payments.js webhook when payment_link.paid fires.
 * Searches all wa_order_session_* settings for matching payment_link_id,
 * creates the webstore_orders row, sends confirmation PNG, notifies admin.
 */
async function handlePaymentLinkPaid(paymentLinkId, razorpayPaymentId) {
  if (!paymentLinkId) return;

  // Find all wa order sessions
  const { data: sessions, error } = await supabase
    .from('settings')
    .select('key, value')
    .like('key', 'wa_order_session_%');

  if (error) throw new Error(`Session search error: ${error.message}`);

  const matchedRow = (sessions || []).find(
    row => row.value?.payment_link_id === paymentLinkId,
  );

  if (!matchedRow) {
    console.log(`[wa-order] No WA session found for payment link ${paymentLinkId}`);
    return;
  }

  const phone   = matchedRow.key.replace('wa_order_session_', '');
  const session = matchedRow.value;
  const cart    = session.cart || [];

  // Generate order number
  const orderNo = await generateWaOrderNo();

  // Compute totals
  const subtotal   = cartTotal(cart);
  const gstAmount  = Math.round(subtotal * 0.05 * 100) / 100;
  const shipping   = subtotal >= 2500 ? 0 : 60;
  const total      = subtotal + gstAmount + shipping;

  // IST date string
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const dateStr = ist.toISOString().slice(0, 10);

  // Map cart to order items
  const items = cart.map(item => ({
    product_id: item.id,
    name:       item.name,
    qty:        item.qty,
    unit:       item.packStr || '',
    price:      item.price,
    gst:        5,
  }));

  // Customer object
  const customer = {
    name:    session.customer_name || '',
    phone,
    address: session.address || '',
  };

  // Insert webstore_orders row
  const { data: newOrder, error: insertErr } = await supabase
    .from('webstore_orders')
    .insert({
      order_no:       orderNo,
      date:           dateStr,
      customer,
      items,
      subtotal,
      gst_amount:     gstAmount,
      shipping,
      total,
      payment_id:     razorpayPaymentId,
      payment_status: 'paid',
      status:         'confirmed',
      channel:        'whatsapp',
      notes:          'WhatsApp Order',
    })
    .select('id,order_no')
    .single();

  if (insertErr) {
    console.error('[wa-order] Order insert error:', insertErr.message);
    throw insertErr;
  }

  console.log(`[wa-order] Order created: ${orderNo} for phone ${phone}`);

  // Send order confirmation PNG to customer
  const orderData = {
    name:      customer.name,
    order_no:  orderNo,
    status:    'confirmed',
    items:     cart.map(i => ({ product: `${i.name} ${i.packStr}`, qty: i.qty })),
    cart_value: total,
  };
  await sendOrderConfirmationPng(phone, orderData);

  // Also send plain text confirmation in case PNG fails / for accessibility
  const cartSummary = cart.map(i => `• ${i.name} ${i.packStr} ×${i.qty}`).join('\n');
  await sendText(phone,
    `✅ *Order Confirmed!*\n\n` +
    `Order No: *${orderNo}*\n\n` +
    `${cartSummary}\n\n` +
    `💰 Total Paid: ₹${total.toLocaleString('en-IN')}\n` +
    `📍 Delivery to: ${customer.address}\n\n` +
    `We'll ship your order soon. Track at https://sathvam.in/orders 🙏`,
  );

  // Notify admin
  const adminPhone = (process.env.WA_ADMIN_PHONE1 || process.env.WA_NOTIFY_TO || '').replace(/\D/g, '');
  if (adminPhone) {
    const adminMsg =
      `🛍 *New WhatsApp Order!*\n\n` +
      `Order: *${orderNo}*\n` +
      `Customer: ${customer.name} (${phone})\n` +
      `Address: ${customer.address}\n\n` +
      `${cartSummary}\n\n` +
      `💰 Total: ₹${total.toLocaleString('en-IN')}\n` +
      `Payment ID: ${razorpayPaymentId}`;
    await sendText(adminPhone, adminMsg);
  }

  // Clear session
  await clearSession(phone);
}

module.exports = { handleOrderMessage, handlePaymentLinkPaid };
