/**
 * One-time migration: assign SAAPR08-1 style invoice numbers to all existing orders.
 * Groups by date, sorts by created_at within each day, assigns sequential numbers.
 * Updates both `sales` (order_no) and `webstore_orders` (order_no).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const supabase = require('../config/supabase');

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function prefix(dateStr) {
  const d = new Date(dateStr);
  return `SA${MONTHS[d.getUTCMonth()]}${String(d.getUTCDate()).padStart(2,'0')}`;
}

async function run() {
  // Fetch all sales
  const { data: sales, error: sErr } = await supabase
    .from('sales')
    .select('id, order_no, date, created_at')
    .order('date', { ascending: true })
    .order('created_at', { ascending: true });
  if (sErr) { console.error('sales fetch error:', sErr.message); process.exit(1); }

  // Fetch all webstore_orders
  const { data: ws, error: wErr } = await supabase
    .from('webstore_orders')
    .select('id, order_no, date, created_at')
    .order('date', { ascending: true })
    .order('created_at', { ascending: true });
  if (wErr) { console.error('webstore_orders fetch error:', wErr.message); process.exit(1); }

  // Combine, tag with source
  const all = [
    ...(sales||[]).map(r => ({ ...r, _src: 'sales' })),
    ...(ws||[]).map(r => ({ ...r, _src: 'ws' })),
  ];

  // Sort by date then created_at
  all.sort((a, b) => {
    const dateDiff = new Date(a.date) - new Date(b.date);
    if (dateDiff !== 0) return dateDiff;
    return new Date(a.created_at) - new Date(b.created_at);
  });

  // Assign sequential numbers per day
  const seqMap = {}; // prefix -> counter
  const updates = { sales: [], ws: [] };

  for (const r of all) {
    const p = prefix(r.date);
    seqMap[p] = (seqMap[p] || 0) + 1;
    const newNo = `${p}-${seqMap[p]}`;
    console.log(`[${r._src}] ${r.order_no} → ${newNo}  (id: ${r.id})`);
    if (r._src === 'sales') updates.sales.push({ id: r.id, order_no: newNo });
    else                    updates.ws.push({ id: r.id, order_no: newNo });
  }

  console.log(`\nUpdating ${updates.sales.length} sales + ${updates.ws.length} webstore_orders...`);

  // Update sales in batches
  for (const u of updates.sales) {
    const { error } = await supabase.from('sales').update({ order_no: u.order_no }).eq('id', u.id);
    if (error) console.error(`  sales ${u.id} failed:`, error.message);
  }

  // Update webstore_orders in batches
  for (const u of updates.ws) {
    const { error } = await supabase.from('webstore_orders').update({ order_no: u.order_no }).eq('id', u.id);
    if (error) console.error(`  ws ${u.id} failed:`, error.message);
  }

  console.log('\nDone.');
}

run();
