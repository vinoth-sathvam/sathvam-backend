/**
 * Server-side cart price validation — shared across all order creation paths.
 *
 * Fetches current product prices from DB and recalculates order totals.
 * Prevents stale/tampered prices from being accepted regardless of channel
 * (website checkout, WhatsApp Flow, WhatsApp bot, public API, admin edit).
 */
const supabase = require('../config/supabase');

async function validateCartPrices(order) {
  const items = order.items || [];
  if (!items.length) return order;

  // Fetch current prices for all products in the order
  const productIds = items.map(i => i.id || i.product_id).filter(Boolean);
  if (!productIds.length) return order;

  const { data: products } = await supabase
    .from('products')
    .select('id, website_price, price, gst, name, offer_price, offer_ends_at')
    .in('id', productIds);

  if (!products || !products.length) return order; // fail-open if DB unavailable

  const priceMap = {};
  for (const p of products) priceMap[p.id] = p;

  let priceChanged = false;
  const correctedItems = items.map(item => {
    const itemId = item.id || item.product_id;
    const dbProd = priceMap[itemId];
    if (!dbProd) return item; // unknown product — keep as-is

    // Determine current price (check active offers first)
    let currentPrice = dbProd.website_price || dbProd.price || 0;
    if (dbProd.offer_price && dbProd.offer_ends_at) {
      const offerEnd = new Date(dbProd.offer_ends_at);
      if (offerEnd > new Date() && parseFloat(dbProd.offer_price) < currentPrice) {
        currentPrice = parseFloat(dbProd.offer_price);
      }
    }

    const itemPrice = parseFloat(item.price) || 0;
    if (Math.abs(itemPrice - currentPrice) > 0.5) {
      priceChanged = true;
      console.log(`Price correction: ${item.name || dbProd.name} ₹${itemPrice} → ₹${currentPrice}`);
    }

    return {
      ...item,
      price: currentPrice,
      gst: dbProd.gst != null ? dbProd.gst : (item.gst || 0),
    };
  });

  // Recalculate totals using corrected prices (GST-inclusive model)
  const newSubtotal = correctedItems.reduce((s, i) => s + (i.qty || 1) * (i.price || 0), 0);
  const newGST = correctedItems.reduce((s, i) => {
    const g = i.gst || 0;
    return s + (i.qty || 1) * (i.price || 0) * (g / (100 + g));
  }, 0);

  // Preserve discounts from original order
  const shipping = parseFloat(order.shipping) || 0;
  const loyaltyDisc = parseFloat(order.loyalty_discount) || 0;
  const couponDisc = parseFloat(order.coupon_discount) || 0;
  const festivalDisc = parseFloat(order.festival_discount) || 0;
  const puthanduDisc = parseFloat(order.puthandu_discount) || 0;
  const giftPacking = order.gift_packing ? 49 : 0;

  const newTotal = Math.max(0, Math.round(
    newSubtotal + shipping - loyaltyDisc - couponDisc - festivalDisc - puthanduDisc + giftPacking
  ));

  if (priceChanged) {
    console.log(`Order price corrected: subtotal ₹${order.subtotal} → ₹${newSubtotal}, total ₹${order.total} → ₹${newTotal}`);
  }

  return {
    ...order,
    items: correctedItems,
    subtotal: newSubtotal,
    gst: Math.round(newGST),
    total: newTotal,
    _pricesCorrected: priceChanged,
  };
}

module.exports = { validateCartPrices };
