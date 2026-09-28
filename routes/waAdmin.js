/**
 * WhatsApp Admin Agent — Process admin commands via WhatsApp
 *
 * When an admin sends a WhatsApp message, this handler:
 * 1. Detects business intent (order status, cancel, refund, pricing, stock, etc.)
 * 2. Queries the database with the right tools
 * 3. Replies with formatted results on WhatsApp
 *
 * Supports: order lookup, cancel+refund, pricing check, stock check,
 * revenue summary, pending orders, customer lookup, B2B order status,
 * attendance, expenses, procurement, production, leave, vendor bills,
 * finance, delivery tracking, tasks, maintenance, analytics, low stock,
 * payroll, compliance, WhatsApp stats, production plan, blog stats,
 * server health
 */

const Anthropic = require('@anthropic-ai/sdk');
const supabase  = require('../config/supabase');
const { sendText: gaSendText } = require('../lib/greenapi');
const { insertLedger } = require('../utils/ledger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Helper: IST today ────────────────────────────────────────────────────────
function istToday() {
  const now = new Date();
  return new Date(now.getTime() + 5.5 * 60 * 60000).toISOString().slice(0, 10);
}

// ── Tool definitions for Claude ──────────────────────────────────────────────
const TOOLS = [
  {
    name: 'search_orders',
    description: 'Search webstore orders by order number, customer name, phone, email, or status. Returns order details including items, payment, status, tracking.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Order number (e.g. SAT-20260926-0012), customer name, phone number, or email' },
        status: { type: 'string', description: 'Filter by status: new, confirmed, packed, shipped, delivered, cancelled, refunded' },
        limit: { type: 'number', description: 'Max results (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_product_pricing',
    description: 'Get product pricing details — procurement cost (CPL), wholesale price, retail price, website price, and profit margin.',
    input_schema: {
      type: 'object',
      properties: {
        product_name: { type: 'string', description: 'Product name or partial name to search (e.g. "groundnut oil", "sesame", "1000ml")' },
      },
      required: ['product_name'],
    },
  },
  {
    name: 'check_stock',
    description: 'Check current stock levels for finished goods, raw materials, or packing materials.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['finished', 'raw', 'packing'], description: 'finished = bottled products, raw = seeds/commodities, packing = bottles/caps/labels/cartons' },
        product_name: { type: 'string', description: 'Product or material name to search (optional — omit to see all)' },
      },
      required: ['type'],
    },
  },
  {
    name: 'get_revenue_summary',
    description: 'Get revenue and order summary for today, this week, or this month.',
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['today', 'week', 'month'], description: 'Time period for summary' },
      },
      required: ['period'],
    },
  },
  {
    name: 'cancel_and_refund',
    description: 'Cancel a webstore order and initiate Razorpay refund. Use ONLY when admin explicitly asks to cancel/refund.',
    input_schema: {
      type: 'object',
      properties: {
        order_no: { type: 'string', description: 'Order number to cancel (e.g. SAT-20260926-0012)' },
        reason: { type: 'string', description: 'Reason for cancellation' },
      },
      required: ['order_no'],
    },
  },
  {
    name: 'get_pending_orders',
    description: 'List orders pending dispatch — new, confirmed, or packed status.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['new', 'confirmed', 'packed', 'all_pending'], description: 'Filter by specific status or all pending' },
      },
      required: ['status'],
    },
  },
  {
    name: 'search_b2b_orders',
    description: 'Search B2B/wholesale orders by order number, customer name, or stage.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'B2B order number, customer name, or stage' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_customers',
    description: 'Search customers by name, email, or phone number.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Customer name, email, or phone' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_bank_balance',
    description: 'Get current bank account balance and recent transactions.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'server_health',
    description: 'Check server health — CPU usage, memory, disk, Docker containers, systemd services status, SSL certificates.',
    input_schema: {
      type: 'object',
      properties: {
        check: { type: 'string', enum: ['overview', 'cpu', 'memory', 'disk', 'docker', 'services', 'ssl'], description: 'What to check' },
      },
      required: ['check'],
    },
  },
  {
    name: 'get_attendance',
    description: 'Get employee attendance status for today, a specific date, or a date range. Shows present/absent/half-day/leave status for each employee.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date in YYYY-MM-DD format (default: today)' },
        employee_name: { type: 'string', description: 'Filter by employee name (optional)' },
        period: { type: 'string', enum: ['today', 'week', 'month'], description: 'Quick period selector (overrides date)' },
      },
    },
  },
  // ── New tools (v3.42) ────────────────────────────────────────────────────────
  {
    name: 'get_expenses',
    description: 'Get company expenses for today, this week, or this month. Shows category-wise breakdown and total.',
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['today', 'week', 'month'], description: 'Time period' },
        category: { type: 'string', description: 'Filter by category (optional): raw_material, logistics, salary, utilities, maintenance, marketing, packaging, other' },
      },
      required: ['period'],
    },
  },
  {
    name: 'get_procurement',
    description: 'Get procurement/purchase order status — pending POs, received, processed. Shows commodity, vendor, qty, rate.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'received', 'processed', 'all'], description: 'Filter by PO status' },
        commodity: { type: 'string', description: 'Filter by commodity name (optional)' },
      },
      required: ['status'],
    },
  },
  {
    name: 'get_production',
    description: 'Get oil production batches or flour/grain processing batches. Shows input, output, yield, cost.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['oil', 'flour'], description: 'oil = oil extraction batches, flour = grain/flour processing' },
        period: { type: 'string', enum: ['today', 'week', 'month', 'all'], description: 'Time period (default: week)' },
        oil_type: { type: 'string', description: 'Filter oil batches by type: groundnut, sesame, coconut (optional)' },
      },
      required: ['type'],
    },
  },
  {
    name: 'get_leave_requests',
    description: 'Get leave requests — pending approvals, approved leaves, or who is on leave today/tomorrow.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['pending', 'approved', 'today', 'tomorrow', 'all'], description: 'What to show' },
        employee_name: { type: 'string', description: 'Filter by employee name (optional)' },
      },
      required: ['filter'],
    },
  },
  {
    name: 'get_vendor_bills',
    description: 'Get vendor bills — unpaid, due this week, overdue, or all. Shows vendor, amount, due date.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['unpaid', 'overdue', 'due_this_week', 'partial', 'all'], description: 'Bill filter' },
        vendor: { type: 'string', description: 'Filter by vendor name (optional)' },
      },
      required: ['filter'],
    },
  },
  {
    name: 'get_finance_summary',
    description: 'Get financial summary — P&L, GST liability, receivables (AR), payables (AP), or overall dashboard.',
    input_schema: {
      type: 'object',
      properties: {
        report: { type: 'string', enum: ['pnl', 'gst', 'receivables', 'payables', 'dashboard'], description: 'Which financial report' },
        period: { type: 'string', enum: ['today', 'week', 'month'], description: 'Time period (default: month)' },
      },
      required: ['report'],
    },
  },
  {
    name: 'get_delivery_tracking',
    description: 'Get shipped/in-transit orders with tracking info. Also shows recently delivered orders.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['shipped', 'delivered_today', 'all_in_transit'], description: 'What to show' },
      },
      required: ['filter'],
    },
  },
  {
    name: 'get_tasks',
    description: 'Get staff task assignments — pending, overdue, or by assignee.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['pending', 'overdue', 'completed_today', 'all'], description: 'Task filter' },
        assigned_to: { type: 'string', description: 'Filter by assignee name (optional)' },
      },
      required: ['filter'],
    },
  },
  {
    name: 'get_maintenance',
    description: 'Get equipment/machine maintenance status — due, overdue, or recent maintenance history.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['due', 'overdue', 'recent', 'all'], description: 'What to show' },
      },
      required: ['filter'],
    },
  },
  {
    name: 'get_analytics',
    description: 'Get store analytics — visitor count, page views, product views, conversion funnel.',
    input_schema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: ['visitors', 'product_views', 'conversions', 'overview'], description: 'Which metric' },
        period: { type: 'string', enum: ['today', 'week', 'month'], description: 'Time period' },
      },
      required: ['metric'],
    },
  },
  {
    name: 'get_low_stock_alerts',
    description: 'Get all items that are below minimum stock level — raw materials, finished goods, and packing materials combined.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_payroll',
    description: 'Get payroll/salary information — employee salary details, this month payment status.',
    input_schema: {
      type: 'object',
      properties: {
        employee_name: { type: 'string', description: 'Filter by employee name (optional — omit to see all)' },
        month: { type: 'string', description: 'Month in YYYY-MM format (default: current month)' },
      },
    },
  },
  {
    name: 'get_compliance',
    description: 'Get compliance checklist items — due, overdue, or all active compliance requirements (FSSAI, GST, labour, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['due', 'overdue', 'all'], description: 'Filter compliance items' },
      },
      required: ['filter'],
    },
  },
  {
    name: 'get_whatsapp_stats',
    description: 'Get WhatsApp messaging statistics — messages sent/received today, failed sends, AI vs human replies.',
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['today', 'week', 'month'], description: 'Time period' },
      },
      required: ['period'],
    },
  },
  {
    name: 'get_production_plan',
    description: 'Get production plan and demand forecast — planned vs actual production, upcoming forecasts.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_blog_stats',
    description: 'Get blog WhatsApp share statistics — how many blogs shared, sent count, delivery status.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_pending_b2b_claims',
    description: 'List all pending (unverified) B2B payment claims — advance, balance, or logistics. Use this when admin says "mark as received" or asks about pending payments without specifying an order number, to find which B2B order has a pending claim.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'record_b2b_payment',
    description: 'Record/verify a B2B payment (advance, balance/remaining, or logistics). Use when admin says "mark as received", "record payment", "verify payment" for a B2B order. Also checks for pending payment claims from the customer portal.',
    input_schema: {
      type: 'object',
      properties: {
        order_no: { type: 'string', description: 'B2B order number (e.g. B2B-829795)' },
        type: { type: 'string', enum: ['advance', 'remaining', 'logistics'], description: 'Payment type: advance, remaining (balance/final), or logistics' },
        amount: { type: 'number', description: 'Payment amount in INR (optional if customer claim exists — will use claim amount)' },
        ref: { type: 'string', description: 'Transaction reference / UTR (optional — will use claim ref if available)' },
        date: { type: 'string', description: 'Payment date YYYY-MM-DD (optional — defaults to today)' },
        notes: { type: 'string', description: 'Optional notes' },
      },
      required: ['order_no', 'type'],
    },
  },
];

// ── Tool Implementations ─────────────────────────────────────────────────────

// Decrypt AES-256 encrypted fields
function decrypt(val) {
  if (!val || typeof val !== 'string' || !val.startsWith('ENC:')) return val || '';
  try {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) return val;
    const { createDecipheriv } = require('crypto');
    const raw = Buffer.from(val.slice(4), 'base64');
    const iv = raw.slice(0, 12);
    const tag = raw.slice(12, 28);
    const data = raw.slice(28);
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString();
  } catch { return val; }
}

function decryptOrder(o) {
  if (!o) return o;
  if (o.customer && typeof o.customer === 'object') {
    for (const k of ['name', 'email', 'phone', 'address', 'city', 'state', 'pincode']) {
      if (o.customer[k]) o.customer[k] = decrypt(o.customer[k]);
    }
  }
  return o;
}

function fmtINR(n) { return (parseFloat(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 }); }

async function executeTool(name, input) {
  try {
    switch (name) {

      case 'search_orders': {
        const q = input.query || '';
        let filter = supabase.from('webstore_orders').select('id,order_no,date,customer,items,subtotal,gst_amount,shipping,total,payment_status,status,tracking_no,courier,payment_id,notes,created_at');
        if (/^SAT-/i.test(q)) {
          filter = filter.ilike('order_no', `%${q}%`);
        } else {
          filter = filter.or(`order_no.ilike.%${q}%,customer->>name.ilike.%${q}%,customer->>phone.ilike.%${q}%,customer->>email.ilike.%${q}%`);
        }
        if (input.status) filter = filter.eq('status', input.status);
        filter = filter.order('created_at', { ascending: false }).limit(input.limit || 5);
        const { data, error } = await filter;
        if (error) return `Error: ${error.message}`;
        if (!data?.length) return 'No orders found matching that query.';
        return data.map(o => {
          decryptOrder(o);
          const c = o.customer || {};
          return `*${o.order_no}* | ${o.date}\nCustomer: ${c.name || '?'} | ${c.phone || ''}\nItems: ${(o.items || []).map(i => `${i.name} ×${i.qty}`).join(', ')}\nTotal: ₹${o.total} | Payment: ${o.payment_status}\nStatus: ${o.status}${o.tracking_no ? ' | Track: ' + o.tracking_no : ''}`;
        }).join('\n\n');
      }

      case 'get_product_pricing': {
        const { data } = await supabase.from('products').select('name,sku,price,retail_price,website_price,gst,hsn_code,active').ilike('name', `%${input.product_name}%`).limit(10);
        if (!data?.length) return 'No products found matching that name.';
        return data.map(p =>
          `*${p.name}* ${p.active ? '' : '(inactive)'}\nSKU: ${p.sku || '-'} | HSN: ${p.hsn_code || '-'}\nWholesale: ₹${p.price || 0} | Retail: ₹${p.retail_price || 0} | Web: ₹${p.website_price || 0}\nGST: ${p.gst || 0}%`
        ).join('\n\n');
      }

      case 'check_stock': {
        if (input.type === 'raw') {
          let filter = supabase.from('raw_materials').select('name,current_stock,min_stock,unit,category');
          if (input.product_name) filter = filter.ilike('name', `%${input.product_name}%`);
          filter = filter.eq('active', true).limit(20);
          const { data } = await filter;
          if (!data?.length) return 'No raw materials found.';
          return data.map(r => {
            const status = r.min_stock && r.current_stock < r.min_stock ? '🔴 LOW' : '🟢';
            return `${status} *${r.name}*: ${r.current_stock} ${r.unit || 'kg'}${r.min_stock ? ` (min: ${r.min_stock})` : ''}`;
          }).join('\n');
        } else if (input.type === 'packing') {
          let filter = supabase.from('packing_materials').select('name,category,current_stock,min_stock,unit,unit_price').eq('active', true);
          if (input.product_name) filter = filter.ilike('name', `%${input.product_name}%`);
          filter = filter.order('name').limit(20);
          const { data } = await filter;
          if (!data?.length) return 'No packing materials found.';
          return data.map(r => {
            const status = r.min_stock && r.current_stock < r.min_stock ? '🔴 LOW' : '🟢';
            return `${status} *${r.name}* (${r.category || '-'}): ${r.current_stock} ${r.unit || 'pcs'}${r.min_stock ? ` (min: ${r.min_stock})` : ''}`;
          }).join('\n');
        } else {
          let filter = supabase.from('stock_ledger').select('product_name,qty,type,date').order('date', { ascending: false });
          if (input.product_name) filter = filter.ilike('product_name', `%${input.product_name}%`);
          filter = filter.limit(50);
          const { data } = await filter;
          if (!data?.length) return 'No stock movements found.';
          const stocks = {};
          for (const r of data) {
            if (!stocks[r.product_name]) stocks[r.product_name] = 0;
            stocks[r.product_name] += r.type === 'IN' ? r.qty : -r.qty;
          }
          return Object.entries(stocks).map(([n, qty]) => {
            const status = qty <= 0 ? '🔴 OUT' : qty < 10 ? '🟡 LOW' : '🟢';
            return `${status} *${n}*: ${qty} units`;
          }).join('\n');
        }
      }

      case 'get_revenue_summary': {
        const now = new Date();
        let fromDate;
        if (input.period === 'today') fromDate = now.toISOString().slice(0, 10);
        else if (input.period === 'week') { const d = new Date(now); d.setDate(d.getDate() - 7); fromDate = d.toISOString().slice(0, 10); }
        else { const d = new Date(now); d.setDate(1); fromDate = d.toISOString().slice(0, 10); }
        const { data: orders } = await supabase.from('webstore_orders').select('total,status,payment_status,date').gte('date', fromDate);
        if (!orders?.length) return `No orders found for ${input.period}.`;
        const paid = orders.filter(o => o.payment_status === 'paid');
        const totalRevenue = paid.reduce((s, o) => s + (parseFloat(o.total) || 0), 0);
        const pending = orders.filter(o => ['new', 'confirmed', 'packed'].includes(o.status));
        return `📊 *${input.period.toUpperCase()} Summary*\nTotal Orders: ${orders.length}\nPaid Orders: ${paid.length}\nRevenue: ₹${fmtINR(totalRevenue)}\nPending Dispatch: ${pending.length}\nDelivered: ${orders.filter(o => o.status === 'delivered').length}\nCancelled: ${orders.filter(o => o.status === 'cancelled').length}`;
      }

      case 'cancel_and_refund': {
        const { data: order } = await supabase.from('webstore_orders').select('*').eq('order_no', input.order_no).single();
        if (!order) return `Order ${input.order_no} not found.`;
        if (['cancelled', 'refunded'].includes(order.status)) return `Order ${input.order_no} is already ${order.status}.`;
        await supabase.from('webstore_orders').update({
          status: 'cancelled',
          notes: `${order.notes || ''}\nCancelled via WhatsApp admin: ${input.reason || 'No reason'}`.trim(),
        }).eq('id', order.id);
        let refundMsg = 'No payment to refund.';
        if (order.payment_id && order.payment_status === 'paid') {
          try {
            const Razorpay = require('razorpay');
            const rz = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
            const refund = await rz.payments.refund(order.payment_id, { amount: Math.round(order.total * 100), notes: { reason: input.reason || 'Admin cancel via WhatsApp' } });
            await supabase.from('webstore_orders').update({ status: 'refund_initiated', refund_id: refund.id }).eq('id', order.id);
            refundMsg = `Refund initiated: ₹${order.total} (ID: ${refund.id})`;
          } catch (e) {
            refundMsg = `Refund failed: ${e.message}`;
          }
        }
        decryptOrder(order);
        return `✅ *Order ${input.order_no} cancelled*\nCustomer: ${order.customer?.name || '?'}\nAmount: ₹${order.total}\n${refundMsg}\nReason: ${input.reason || '-'}`;
      }

      case 'get_pending_orders': {
        const statuses = input.status === 'all_pending' ? ['new', 'confirmed', 'packed'] : [input.status];
        const { data } = await supabase.from('webstore_orders').select('order_no,date,customer,total,status,created_at')
          .in('status', statuses).order('created_at', { ascending: true }).limit(20);
        if (!data?.length) return 'No pending orders.';
        return `📦 *${data.length} Pending Orders*\n\n` + data.map(o => {
          decryptOrder(o);
          const hrs = Math.round((Date.now() - new Date(o.created_at).getTime()) / 3600000);
          return `*${o.order_no}* | ${o.status} | ${hrs}h ago\n${o.customer?.name || '?'} | ₹${o.total}`;
        }).join('\n\n');
      }

      case 'search_b2b_orders': {
        const { data } = await supabase.from('b2b_orders').select('order_no,customer_name,stage,total_value,currency,created_at,items')
          .or(`order_no.ilike.%${input.query}%,customer_name.ilike.%${input.query}%,stage.ilike.%${input.query}%`)
          .order('created_at', { ascending: false }).limit(5);
        if (!data?.length) return 'No B2B orders found.';
        return data.map(o =>
          `*${o.order_no}* | ${o.customer_name}\nStage: ${o.stage} | Value: ${o.currency} ${o.total_value?.toLocaleString('en-IN')}\nItems: ${(o.items || []).length} products`
        ).join('\n\n');
      }

      case 'search_customers': {
        const { data } = await supabase.from('customers').select('name,email,phone,city,state,created_at')
          .or(`name.ilike.%${input.query}%,email.ilike.%${input.query}%,phone.ilike.%${input.query}%`)
          .limit(5);
        if (!data?.length) return 'No customers found.';
        const maskEmail = (e) => { if (!e || e.length < 4) return '****'; const [u,d] = e.split('@'); return u.slice(0,2) + '***@' + (d||'***'); };
        const maskPhone = (p) => { if (!p || p.length < 4) return '****'; return '****' + p.slice(-4); };
        return data.map(c => `*${decrypt(c.name)}*\n📧 ${maskEmail(decrypt(c.email))} | 📱 ${maskPhone(decrypt(c.phone))}\n📍 ${decrypt(c.city) || '-'}, ${decrypt(c.state) || '-'}`).join('\n\n');
      }

      case 'get_bank_balance': {
        const { data: accounts } = await supabase.from('bank_accounts').select('name,bank_name,current_balance,type').eq('is_active', true);
        if (!accounts?.length) return 'No bank accounts found.';
        const total = accounts.reduce((s, a) => s + (parseFloat(a.current_balance) || 0), 0);
        return `🏦 *Bank Balances*\n\n` + accounts.map(a =>
          `*${a.name}* (${a.bank_name})\n${a.type} | ₹${fmtINR(a.current_balance)}`
        ).join('\n\n') + `\n\n💰 *Total: ₹${fmtINR(total)}*`;
      }

      case 'get_attendance': {
        const today = istToday();
        let fromDate, toDate;
        if (input.period === 'week') {
          const d = new Date(today); d.setDate(d.getDate() - 6);
          fromDate = d.toISOString().slice(0, 10); toDate = today;
        } else if (input.period === 'month') {
          fromDate = today.slice(0, 8) + '01'; toDate = today;
        } else {
          fromDate = input.date || today; toDate = fromDate;
        }
        const { data: employees } = await supabase.from('employees').select('id,name,role,active').eq('active', true).order('name');
        if (!employees?.length) return 'No active employees found.';
        let attFilter = supabase.from('attendance').select('employee_id,date,status,time_in,time_out,notes').gte('date', fromDate).lte('date', toDate);
        if (input.employee_name) {
          const matchedEmp = employees.filter(e => e.name.toLowerCase().includes(input.employee_name.toLowerCase()));
          if (!matchedEmp.length) return `No employee found matching "${input.employee_name}".`;
          attFilter = attFilter.in('employee_id', matchedEmp.map(e => e.id));
        }
        const { data: attendance } = await attFilter;
        if (fromDate === toDate) {
          const attMap = {};
          for (const a of (attendance || [])) attMap[a.employee_id] = a;
          const present = [], absent = [], halfDay = [], leave = [], unmarked = [];
          for (const emp of employees) {
            if (input.employee_name && !emp.name.toLowerCase().includes(input.employee_name.toLowerCase())) continue;
            const a = attMap[emp.id];
            if (!a) { unmarked.push(emp.name); continue; }
            const timeInfo = a.time_in ? ` (${a.time_in}${a.time_out ? '-' + a.time_out : ''})` : '';
            if (a.status === 'present') present.push(emp.name + timeInfo);
            else if (a.status === 'absent') absent.push(emp.name);
            else if (a.status === 'half-day') halfDay.push(emp.name + timeInfo);
            else if (a.status === 'leave') leave.push(emp.name);
            else unmarked.push(emp.name);
          }
          let msg = `📋 *Attendance — ${fromDate}*\n\n`;
          if (present.length) msg += `✅ Present (${present.length}):\n${present.join('\n')}\n\n`;
          if (absent.length) msg += `❌ Absent (${absent.length}):\n${absent.join('\n')}\n\n`;
          if (halfDay.length) msg += `🕐 Half-day (${halfDay.length}):\n${halfDay.join('\n')}\n\n`;
          if (leave.length) msg += `🏖️ Leave (${leave.length}):\n${leave.join('\n')}\n\n`;
          if (unmarked.length) msg += `⬜ Not Marked (${unmarked.length}):\n${unmarked.join('\n')}\n\n`;
          const total = input.employee_name ? (present.length + absent.length + halfDay.length + leave.length + unmarked.length) : employees.length;
          msg += `📊 ${present.length}/${total} present`;
          return msg.trim();
        }
        const empMap = {};
        for (const e of employees) {
          if (input.employee_name && !e.name.toLowerCase().includes(input.employee_name.toLowerCase())) continue;
          empMap[e.id] = { name: e.name, present: 0, absent: 0, halfDay: 0, leave: 0 };
        }
        for (const a of (attendance || [])) {
          if (!empMap[a.employee_id]) continue;
          if (a.status === 'present') empMap[a.employee_id].present++;
          else if (a.status === 'absent') empMap[a.employee_id].absent++;
          else if (a.status === 'half-day') empMap[a.employee_id].halfDay++;
          else if (a.status === 'leave') empMap[a.employee_id].leave++;
        }
        let workDays = 0;
        const d = new Date(fromDate); const end = new Date(toDate);
        while (d <= end) { if (d.getDay() !== 0) workDays++; d.setDate(d.getDate() + 1); }
        let msg = `📋 *Attendance — ${fromDate} to ${toDate}*\n(${workDays} working days)\n\n`;
        for (const emp of Object.values(empMap)) {
          const pct = workDays > 0 ? Math.round((emp.present + emp.halfDay * 0.5) / workDays * 100) : 0;
          const icon = pct >= 80 ? '🟢' : pct >= 50 ? '🟡' : '🔴';
          msg += `${icon} *${emp.name}*: ${emp.present}P ${emp.absent}A ${emp.halfDay}H ${emp.leave}L (${pct}%)\n`;
        }
        return msg.trim();
      }

      case 'server_health': {
        const { execSync } = require('child_process');
        let cmd;
        switch (input.check) {
          case 'cpu': cmd = `top -bn1 | head -5 && echo "\\nLoad avg:" && cat /proc/loadavg`; break;
          case 'memory': cmd = 'free -h'; break;
          case 'disk': cmd = 'df -h /'; break;
          case 'docker': cmd = 'sudo docker ps --format "{{.Names}}: {{.Status}}" 2>&1'; break;
          case 'services': cmd = 'systemctl list-units --type=service --all 2>&1 | grep sathvam | head -30'; break;
          case 'ssl': cmd = 'sudo /home/ubuntu/sathvam-frontend/sathvam-vercel/scripts/ssl-cert-monitor.sh --check-only 2>&1 | tail -10'; break;
          default:
            cmd = `echo "=== CPU ===" && top -bn1 | grep "Cpu\\|load" | head -2 && echo "\\n=== Memory ===" && free -h | head -2 && echo "\\n=== Disk ===" && df -h / | tail -1 && echo "\\n=== Docker ===" && sudo docker ps --format "{{.Names}}: {{.Status}}" 2>&1`;
        }
        try {
          return execSync(cmd, { timeout: 15000, encoding: 'utf8' });
        } catch (e) { return `Error: ${e.message}`; }
      }

      // ── New tool implementations (v3.42) ──────────────────────────────────────

      case 'get_expenses': {
        const now = new Date();
        let fromDate;
        if (input.period === 'today') fromDate = istToday();
        else if (input.period === 'week') { const d = new Date(now); d.setDate(d.getDate() - 7); fromDate = d.toISOString().slice(0, 10); }
        else { const d = new Date(now); d.setDate(1); fromDate = d.toISOString().slice(0, 10); }
        let filter = supabase.from('company_expenses').select('date,category,description,amount,vendor_name,payment_mode')
          .gte('date', fromDate).is('deleted_at', null).order('date', { ascending: false });
        if (input.category) filter = filter.eq('category', input.category);
        filter = filter.limit(30);
        const { data } = await filter;
        if (!data?.length) return `No expenses found for ${input.period}.`;
        const total = data.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
        const byCat = {};
        for (const e of data) { byCat[e.category || 'other'] = (byCat[e.category || 'other'] || 0) + (parseFloat(e.amount) || 0); }
        let msg = `💸 *Expenses — ${input.period}*\n*Total: ₹${fmtINR(total)}*\n\n`;
        msg += `*By Category:*\n` + Object.entries(byCat).sort((a,b) => b[1]-a[1]).map(([c, v]) => `• ${c}: ₹${fmtINR(v)}`).join('\n');
        msg += `\n\n*Recent:*\n` + data.slice(0, 8).map(e => `${e.date} | ₹${fmtINR(e.amount)} | ${e.category || '-'} | ${e.description || e.vendor_name || '-'}`).join('\n');
        return msg;
      }

      case 'get_procurement': {
        let filter = supabase.from('procurements').select('id,date,commodity_name,supplier,ordered_qty,ordered_price_per_kg,received_qty,cleaned_qty,status,payment_status,total_amount')
          .order('date', { ascending: false });
        if (input.status !== 'all') filter = filter.eq('status', input.status);
        if (input.commodity) filter = filter.ilike('commodity_name', `%${input.commodity}%`);
        filter = filter.limit(15);
        const { data } = await filter;
        if (!data?.length) return `No ${input.status} procurement orders found.`;
        const totalVal = data.reduce((s, p) => s + (parseFloat(p.total_amount) || 0), 0);
        let msg = `🛒 *Procurement — ${input.status}* (${data.length} POs)\n*Total: ₹${fmtINR(totalVal)}*\n\n`;
        msg += data.map(p => {
          const recv = p.received_qty ? ` | Recv: ${p.received_qty}kg` : '';
          return `*${p.commodity_name}* | ${p.date}\n${p.supplier || '-'} | ${p.ordered_qty}kg @ ₹${p.ordered_price_per_kg}/kg${recv}\nStatus: ${p.status} | Pay: ${p.payment_status || '-'}`;
        }).join('\n\n');
        return msg;
      }

      case 'get_production': {
        const now = new Date();
        let fromDate;
        const period = input.period || 'week';
        if (period === 'today') fromDate = istToday();
        else if (period === 'week') { const d = new Date(now); d.setDate(d.getDate() - 7); fromDate = d.toISOString().slice(0, 10); }
        else if (period === 'month') { const d = new Date(now); d.setDate(1); fromDate = d.toISOString().slice(0, 10); }
        else fromDate = '2020-01-01';

        if (input.type === 'oil') {
          let filter = supabase.from('batches').select('date,oil_type,input_kg,oil_output,cake_output,notes')
            .gte('date', fromDate).order('date', { ascending: false });
          if (input.oil_type) filter = filter.ilike('oil_type', `%${input.oil_type}%`);
          filter = filter.limit(20);
          const { data } = await filter;
          if (!data?.length) return `No oil batches found for ${period}.`;
          const totalInput = data.reduce((s, b) => s + (parseFloat(b.input_kg) || 0), 0);
          const totalOil = data.reduce((s, b) => s + (parseFloat(b.oil_output) || 0), 0);
          const totalCake = data.reduce((s, b) => s + (parseFloat(b.cake_output) || 0), 0);
          let msg = `🛢️ *Oil Production — ${period}* (${data.length} batches)\n`;
          msg += `Input: ${totalInput.toFixed(1)}kg | Oil: ${totalOil.toFixed(1)}L | Cake: ${totalCake.toFixed(1)}kg\n`;
          msg += `Yield: ${totalInput > 0 ? (totalOil / totalInput * 100).toFixed(1) : 0}%\n\n`;
          msg += data.slice(0, 10).map(b =>
            `${b.date} | *${b.oil_type}*\n${b.input_kg}kg → ${b.oil_output}L oil + ${b.cake_output}kg cake`
          ).join('\n\n');
          return msg;
        } else {
          let filter = supabase.from('flour_batches').select('date,commodity,input_kg,flour_received_kg,grinding_charge,total_cost,cost_per_kg,notes')
            .gte('date', fromDate).order('date', { ascending: false }).limit(20);
          const { data } = await filter;
          if (!data?.length) return `No flour batches found for ${period}.`;
          const totalInput = data.reduce((s, b) => s + (parseFloat(b.input_kg) || 0), 0);
          const totalFlour = data.reduce((s, b) => s + (parseFloat(b.flour_received_kg) || 0), 0);
          let msg = `🌾 *Flour Production — ${period}* (${data.length} batches)\n`;
          msg += `Input: ${totalInput.toFixed(1)}kg | Flour: ${totalFlour.toFixed(1)}kg\n\n`;
          msg += data.slice(0, 10).map(b =>
            `${b.date} | *${b.commodity}*\n${b.input_kg}kg → ${b.flour_received_kg}kg | Cost: ₹${b.cost_per_kg || '-'}/kg`
          ).join('\n\n');
          return msg;
        }
      }

      case 'get_leave_requests': {
        const today = istToday();
        const tomorrow = new Date(new Date(today).getTime() + 86400000).toISOString().slice(0, 10);

        if (input.filter === 'today' || input.filter === 'tomorrow') {
          const checkDate = input.filter === 'today' ? today : tomorrow;
          let filter = supabase.from('leave_requests').select('employee_name,leave_type,from_date,to_date,reason,status')
            .eq('status', 'approved').lte('from_date', checkDate).gte('to_date', checkDate);
          if (input.employee_name) filter = filter.ilike('employee_name', `%${input.employee_name}%`);
          const { data } = await filter;
          if (!data?.length) return `No one is on leave ${input.filter}.`;
          return `🏖️ *On Leave ${input.filter === 'today' ? 'Today' : 'Tomorrow'} (${checkDate})*\n\n` +
            data.map(l => `• *${l.employee_name}* — ${l.leave_type} (${l.from_date} to ${l.to_date})\n  Reason: ${l.reason || '-'}`).join('\n\n');
        }

        let filter = supabase.from('leave_requests').select('employee_name,leave_type,from_date,to_date,days,reason,status,created_at')
          .order('created_at', { ascending: false });
        if (input.filter === 'pending') filter = filter.eq('status', 'pending');
        else if (input.filter === 'approved') filter = filter.eq('status', 'approved');
        if (input.employee_name) filter = filter.ilike('employee_name', `%${input.employee_name}%`);
        filter = filter.limit(15);
        const { data } = await filter;
        if (!data?.length) return `No ${input.filter} leave requests found.`;
        const icon = input.filter === 'pending' ? '⏳' : '📋';
        return `${icon} *Leave Requests — ${input.filter}* (${data.length})\n\n` +
          data.map(l => `*${l.employee_name}* | ${l.status}\n${l.leave_type} | ${l.from_date} to ${l.to_date} (${l.days} days)\nReason: ${l.reason || '-'}`).join('\n\n');
      }

      case 'get_vendor_bills': {
        const today = istToday();
        const weekEnd = new Date(new Date(today).getTime() + 7 * 86400000).toISOString().slice(0, 10);
        let filter = supabase.from('vendor_bills').select('vendor_name,bill_no,bill_date,due_date,amount,gst_amount,paid_amount,status')
          .is('deleted_at', null).order('due_date', { ascending: true });
        if (input.filter === 'unpaid') filter = filter.in('status', ['unpaid', 'partial']);
        else if (input.filter === 'overdue') filter = filter.in('status', ['unpaid', 'partial']).lt('due_date', today);
        else if (input.filter === 'due_this_week') filter = filter.in('status', ['unpaid', 'partial']).lte('due_date', weekEnd);
        else if (input.filter === 'partial') filter = filter.eq('status', 'partial');
        if (input.vendor) filter = filter.ilike('vendor_name', `%${input.vendor}%`);
        filter = filter.limit(20);
        const { data } = await filter;
        if (!data?.length) return `No ${input.filter} vendor bills found.`;
        const totalDue = data.reduce((s, b) => s + (parseFloat(b.amount) || 0) - (parseFloat(b.paid_amount) || 0), 0);
        let msg = `📄 *Vendor Bills — ${input.filter}* (${data.length})\n*Total Outstanding: ₹${fmtINR(totalDue)}*\n\n`;
        msg += data.map(b => {
          const outstanding = (parseFloat(b.amount) || 0) - (parseFloat(b.paid_amount) || 0);
          const overdue = b.due_date < today && b.status !== 'paid' ? ' 🔴 OVERDUE' : '';
          return `*${b.vendor_name}*${overdue}\n${b.bill_no || '-'} | Due: ${b.due_date} | ₹${fmtINR(outstanding)} outstanding`;
        }).join('\n\n');
        return msg;
      }

      case 'get_finance_summary': {
        const now = new Date();
        const period = input.period || 'month';
        let fromDate;
        if (period === 'today') fromDate = istToday();
        else if (period === 'week') { const d = new Date(now); d.setDate(d.getDate() - 7); fromDate = d.toISOString().slice(0, 10); }
        else { const d = new Date(now); d.setDate(1); fromDate = d.toISOString().slice(0, 10); }

        if (input.report === 'receivables') {
          const { data } = await supabase.from('webstore_orders').select('order_no,customer,total,payment_status,date')
            .in('payment_status', ['pending', 'cod']).order('date', { ascending: false }).limit(20);
          if (!data?.length) return 'No outstanding receivables.';
          const total = data.reduce((s, o) => s + (parseFloat(o.total) || 0), 0);
          return `💰 *Receivables (AR)* — ${data.length} orders\n*Total: ₹${fmtINR(total)}*\n\n` +
            data.slice(0, 10).map(o => { decryptOrder(o); return `${o.order_no} | ${o.customer?.name || '?'} | ₹${fmtINR(o.total)} | ${o.payment_status}`; }).join('\n');
        }

        if (input.report === 'payables') {
          const { data } = await supabase.from('vendor_bills').select('vendor_name,amount,paid_amount,due_date,status').is('deleted_at', null).in('status', ['unpaid', 'partial']);
          if (!data?.length) return 'No outstanding payables.';
          const total = data.reduce((s, b) => s + (parseFloat(b.amount) || 0) - (parseFloat(b.paid_amount) || 0), 0);
          return `📄 *Payables (AP)* — ${data.length} bills\n*Total Outstanding: ₹${fmtINR(total)}*\n\n` +
            data.slice(0, 10).map(b => `${b.vendor_name} | ₹${fmtINR((parseFloat(b.amount)||0) - (parseFloat(b.paid_amount)||0))} | Due: ${b.due_date}`).join('\n');
        }

        if (input.report === 'gst') {
          const { data: orders } = await supabase.from('webstore_orders').select('gst_amount,total,date').gte('date', fromDate).eq('payment_status', 'paid');
          const gstCollected = (orders || []).reduce((s, o) => s + (parseFloat(o.gst_amount) || 0), 0);
          const { data: purchases } = await supabase.from('procurements').select('gst,total_amount,date').gte('date', fromDate);
          const gstPaid = (purchases || []).reduce((s, p) => s + ((parseFloat(p.total_amount) || 0) * (parseFloat(p.gst) || 0) / (100 + (parseFloat(p.gst) || 0))), 0);
          const netGST = gstCollected - gstPaid;
          return `🧾 *GST Summary — ${period}*\n\nOutput GST (collected): ₹${fmtINR(gstCollected)}\nInput GST (paid): ₹${fmtINR(gstPaid)}\n*Net Payable: ₹${fmtINR(netGST)}*\n\nCGST: ₹${fmtINR(netGST/2)} | SGST: ₹${fmtINR(netGST/2)}`;
        }

        // P&L or dashboard
        const [ordersRes, expensesRes, billsRes] = await Promise.all([
          supabase.from('webstore_orders').select('total,gst_amount,payment_status,date').gte('date', fromDate),
          supabase.from('company_expenses').select('amount,date').gte('date', fromDate).is('deleted_at', null),
          supabase.from('vendor_bills').select('amount,paid_amount,status').is('deleted_at', null).in('status', ['unpaid', 'partial']),
        ]);
        const revenue = (ordersRes.data || []).filter(o => o.payment_status === 'paid').reduce((s, o) => s + (parseFloat(o.total) || 0), 0);
        const expenses = (expensesRes.data || []).reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
        const apTotal = (billsRes.data || []).reduce((s, b) => s + (parseFloat(b.amount) || 0) - (parseFloat(b.paid_amount) || 0), 0);
        const profit = revenue - expenses;
        const margin = revenue > 0 ? (profit / revenue * 100).toFixed(1) : 0;

        return `📊 *Finance ${input.report === 'dashboard' ? 'Dashboard' : 'P&L'} — ${period}*\n\n💰 Revenue: ₹${fmtINR(revenue)}\n💸 Expenses: ₹${fmtINR(expenses)}\n${profit >= 0 ? '📈' : '📉'} *Net Profit: ₹${fmtINR(profit)}* (${margin}%)\n\n📄 AP Outstanding: ₹${fmtINR(apTotal)}\n📦 Orders: ${(ordersRes.data || []).length}`;
      }

      case 'get_delivery_tracking': {
        const today = istToday();
        let filter = supabase.from('webstore_orders').select('order_no,date,customer,total,status,tracking_no,courier,created_at');
        if (input.filter === 'shipped') {
          filter = filter.eq('status', 'shipped');
        } else if (input.filter === 'delivered_today') {
          filter = filter.eq('status', 'delivered').eq('date', today);
        } else {
          filter = filter.in('status', ['shipped', 'confirmed', 'packed']);
        }
        filter = filter.order('created_at', { ascending: false }).limit(20);
        const { data } = await filter;
        if (!data?.length) return `No ${input.filter} orders found.`;
        return `🚚 *${input.filter === 'delivered_today' ? 'Delivered Today' : 'In Transit'}* (${data.length})\n\n` +
          data.map(o => {
            decryptOrder(o);
            return `*${o.order_no}* | ${o.status}\n${o.customer?.name || '?'} | ₹${fmtINR(o.total)}${o.tracking_no ? `\n🔗 ${o.courier || ''}: ${o.tracking_no}` : '\n⚠️ No tracking yet'}`;
          }).join('\n\n');
      }

      case 'get_tasks': {
        const today = istToday();
        let filter = supabase.from('staff_tasks').select('title,assigned_name,due_date,priority,status,category,notes')
          .order('due_date', { ascending: true });
        if (input.filter === 'pending') filter = filter.in('status', ['open', 'in-progress']);
        else if (input.filter === 'overdue') filter = filter.in('status', ['open', 'in-progress']).lt('due_date', today);
        else if (input.filter === 'completed_today') filter = filter.eq('status', 'done').gte('completed_at', today);
        if (input.assigned_to) filter = filter.ilike('assigned_name', `%${input.assigned_to}%`);
        filter = filter.limit(15);
        const { data } = await filter;
        if (!data?.length) return `No ${input.filter} tasks found.`;
        const icon = input.filter === 'overdue' ? '🔴' : '📝';
        return `${icon} *Tasks — ${input.filter}* (${data.length})\n\n` +
          data.map(t => {
            const overdue = t.due_date < today && t.status !== 'done' ? ' 🔴' : '';
            const prio = t.priority === 'high' ? '🔴' : t.priority === 'medium' ? '🟡' : '🟢';
            return `${prio} *${t.title}*${overdue}\n→ ${t.assigned_name || '-'} | Due: ${t.due_date || '-'} | ${t.status}`;
          }).join('\n\n');
      }

      case 'get_maintenance': {
        const today = istToday();
        let filter = supabase.from('machine_maintenance').select('machine_name,machine_type,maintenance_type,date,next_due_date,cost,status,description')
          .order('next_due_date', { ascending: true });
        if (input.filter === 'due') filter = filter.gte('next_due_date', today).lte('next_due_date', new Date(new Date(today).getTime() + 30*86400000).toISOString().slice(0,10));
        else if (input.filter === 'overdue') filter = filter.lt('next_due_date', today).neq('status', 'completed');
        else if (input.filter === 'recent') filter = filter.order('date', { ascending: false });
        filter = filter.limit(15);
        const { data } = await filter;
        if (!data?.length) return `No ${input.filter} maintenance records found.`;
        return `🔧 *Maintenance — ${input.filter}* (${data.length})\n\n` +
          data.map(m => {
            const overdue = m.next_due_date && m.next_due_date < today ? ' 🔴 OVERDUE' : '';
            return `*${m.machine_name}*${overdue}\n${m.maintenance_type || '-'} | Last: ${m.date || '-'} | Next: ${m.next_due_date || '-'}${m.cost ? ` | Cost: ₹${fmtINR(m.cost)}` : ''}`;
          }).join('\n\n');
      }

      case 'get_analytics': {
        const now = new Date();
        const period = input.period || 'today';
        let fromDate;
        if (period === 'today') fromDate = istToday();
        else if (period === 'week') { const d = new Date(now); d.setDate(d.getDate() - 7); fromDate = d.toISOString().slice(0, 10); }
        else { const d = new Date(now); d.setDate(1); fromDate = d.toISOString().slice(0, 10); }

        // Get orders for conversion data
        const { data: orders } = await supabase.from('webstore_orders').select('id,date,total,status,payment_status').gte('date', fromDate);
        const orderCount = (orders || []).length;
        const revenue = (orders || []).filter(o => o.payment_status === 'paid').reduce((s, o) => s + (parseFloat(o.total) || 0), 0);

        // Try analytics data
        const { data: analytics } = await supabase.from('store_analytics').select('key,data').ilike('key', `visits_%`).limit(30);
        let totalVisits = 0;
        for (const a of (analytics || [])) {
          const dateStr = (a.key || '').replace('visits_', '');
          if (dateStr >= fromDate) totalVisits += (a.data?.count || 0);
        }

        const convRate = totalVisits > 0 ? (orderCount / totalVisits * 100).toFixed(1) : '-';
        const aov = orderCount > 0 ? Math.round(revenue / orderCount) : 0;

        return `📈 *Analytics — ${period}*\n\n👥 Visitors: ${totalVisits || 'N/A'}\n🛒 Orders: ${orderCount}\n💰 Revenue: ₹${fmtINR(revenue)}\n📊 Conversion: ${convRate}%\n🧾 Avg Order Value: ₹${fmtINR(aov)}`;
      }

      case 'get_low_stock_alerts': {
        const [rawRes, packRes] = await Promise.all([
          supabase.from('raw_materials').select('name,current_stock,min_stock,unit').eq('active', true).not('min_stock', 'is', null),
          supabase.from('packing_materials').select('name,current_stock,min_stock,unit').eq('active', true).not('min_stock', 'is', null),
        ]);
        const lowRaw = (rawRes.data || []).filter(r => r.current_stock < r.min_stock);
        const lowPack = (packRes.data || []).filter(r => r.current_stock < r.min_stock);

        // Finished goods — check stock ledger for items below threshold
        const { data: ledger } = await supabase.from('stock_ledger').select('product_name,qty,type').limit(500);
        const fgStocks = {};
        for (const r of (ledger || [])) {
          if (!fgStocks[r.product_name]) fgStocks[r.product_name] = 0;
          fgStocks[r.product_name] += r.type === 'IN' ? r.qty : -r.qty;
        }
        const lowFG = Object.entries(fgStocks).filter(([, qty]) => qty < 10 && qty >= 0).map(([name, qty]) => ({ name, qty }));

        const total = lowRaw.length + lowPack.length + lowFG.length;
        if (total === 0) return '✅ All stock levels are OK — nothing below minimum.';

        let msg = `⚠️ *Low Stock Alert* — ${total} items below minimum\n\n`;
        if (lowRaw.length) {
          msg += `🌾 *Raw Materials (${lowRaw.length}):*\n` +
            lowRaw.map(r => `🔴 ${r.name}: ${r.current_stock} ${r.unit || 'kg'} (min: ${r.min_stock})`).join('\n') + '\n\n';
        }
        if (lowPack.length) {
          msg += `📦 *Packing Materials (${lowPack.length}):*\n` +
            lowPack.map(r => `🔴 ${r.name}: ${r.current_stock} ${r.unit || 'pcs'} (min: ${r.min_stock})`).join('\n') + '\n\n';
        }
        if (lowFG.length) {
          msg += `🛢️ *Finished Goods (${lowFG.length}):*\n` +
            lowFG.map(r => `🟡 ${r.name}: ${r.qty} units`).join('\n');
        }
        return msg.trim();
      }

      case 'get_payroll': {
        const month = input.month || istToday().slice(0, 7);
        let filter = supabase.from('employees').select('id,name,role,daily_rate,pay_type,monthly_salary,phone,active').eq('active', true).order('name');
        if (input.employee_name) filter = filter.ilike('name', `%${input.employee_name}%`);
        const { data: employees } = await filter;
        if (!employees?.length) return input.employee_name ? `No employee found matching "${input.employee_name}".` : 'No active employees found.';

        // Get attendance for the month
        const monthStart = month + '-01';
        const monthEnd = month + '-31';
        const { data: attendance } = await supabase.from('attendance').select('employee_id,status')
          .gte('date', monthStart).lte('date', monthEnd);
        const attMap = {};
        for (const a of (attendance || [])) {
          if (!attMap[a.employee_id]) attMap[a.employee_id] = { present: 0, absent: 0, halfDay: 0 };
          if (a.status === 'present') attMap[a.employee_id].present++;
          else if (a.status === 'absent') attMap[a.employee_id].absent++;
          else if (a.status === 'half-day') attMap[a.employee_id].halfDay++;
        }

        let totalPayable = 0;
        let msg = `💰 *Payroll — ${month}*\n\n`;
        msg += employees.map(e => {
          const att = attMap[e.id] || { present: 0, absent: 0, halfDay: 0 };
          const workDays = att.present + att.halfDay * 0.5;
          let payable;
          if (e.pay_type === 'monthly') {
            payable = parseFloat(e.monthly_salary) || 0;
          } else {
            payable = workDays * (parseFloat(e.daily_rate) || 0);
          }
          totalPayable += payable;
          return `*${e.name}* (${e.role || '-'})\n${e.pay_type === 'monthly' ? 'Monthly' : 'Daily'}: ₹${fmtINR(e.pay_type === 'monthly' ? e.monthly_salary : e.daily_rate)} | Days: ${workDays} | *Payable: ₹${fmtINR(payable)}*`;
        }).join('\n\n');
        msg += `\n\n💰 *Total Payable: ₹${fmtINR(totalPayable)}*`;
        return msg;
      }

      case 'get_compliance': {
        const today = istToday();
        let filter = supabase.from('compliance_items').select('name,type,frequency,next_due_date,last_completed_date,license_no,active')
          .eq('active', true).order('next_due_date', { ascending: true });
        if (input.filter === 'overdue') filter = filter.lt('next_due_date', today);
        else if (input.filter === 'due') {
          const in30 = new Date(new Date(today).getTime() + 30*86400000).toISOString().slice(0,10);
          filter = filter.lte('next_due_date', in30);
        }
        filter = filter.limit(20);
        const { data } = await filter;
        if (!data?.length) return `No ${input.filter} compliance items found.`;
        return `📋 *Compliance — ${input.filter}* (${data.length})\n\n` +
          data.map(c => {
            const overdue = c.next_due_date && c.next_due_date < today ? ' 🔴 OVERDUE' : '';
            return `*${c.name}*${overdue}\nType: ${c.type || '-'} | ${c.frequency || '-'}\nDue: ${c.next_due_date || '-'} | Last: ${c.last_completed_date || 'Never'}${c.license_no ? `\nLicense: ${c.license_no}` : ''}`;
          }).join('\n\n');
      }

      case 'get_whatsapp_stats': {
        const now = new Date();
        let fromDate;
        if (input.period === 'today') fromDate = istToday();
        else if (input.period === 'week') { const d = new Date(now); d.setDate(d.getDate() - 7); fromDate = d.toISOString().slice(0, 10); }
        else { const d = new Date(now); d.setDate(1); fromDate = d.toISOString().slice(0, 10); }
        const fromTs = fromDate + 'T00:00:00';

        const { data: msgs } = await supabase.from('whatsapp_messages').select('direction,status,sent_by,delivery_error,timestamp')
          .gte('timestamp', fromTs).limit(2000);
        if (!msgs?.length) return `No WhatsApp messages found for ${input.period}.`;

        const inbound = msgs.filter(m => m.direction === 'inbound').length;
        const outbound = msgs.filter(m => m.direction === 'outbound').length;
        const failed = msgs.filter(m => ['failed', 'noAccount', 'notInGroup'].includes(m.status)).length;
        const aiReplies = msgs.filter(m => m.sent_by === 'ai' || m.sent_by === 'bot').length;
        const humanReplies = msgs.filter(m => m.direction === 'outbound' && m.sent_by && m.sent_by !== 'ai' && m.sent_by !== 'bot' && m.sent_by !== 'system').length;

        return `💬 *WhatsApp Stats — ${input.period}*\n\n📥 Received: ${inbound}\n📤 Sent: ${outbound}\n❌ Failed: ${failed}\n🤖 AI Replies: ${aiReplies}\n👤 Human Replies: ${humanReplies}\n📊 Total: ${msgs.length}`;
      }

      case 'get_production_plan': {
        const { data } = await supabase.from('demand_forecasts').select('forecasts,notes,forecast_weeks,forecast_date')
          .order('forecast_date', { ascending: false }).limit(1);
        if (!data?.length) return 'No production plan/forecast found.';
        const plan = data[0];
        const forecasts = plan.forecasts || {};
        let msg = `📋 *Production Plan*\nForecast Date: ${plan.forecast_date || '-'}\nWeeks: ${plan.forecast_weeks || '-'}\n\n`;
        for (const [product, details] of Object.entries(forecasts)) {
          if (typeof details === 'object') {
            msg += `*${product}*: ${details.forecast_qty || details.qty || '-'} units${details.notes ? ` (${details.notes})` : ''}\n`;
          } else {
            msg += `*${product}*: ${details}\n`;
          }
        }
        if (plan.notes) msg += `\n_Notes: ${plan.notes}_`;
        return msg.trim();
      }

      case 'get_blog_stats': {
        const { data: sends } = await supabase.from('blog_wa_sends').select('blog_id,blog_title,blog_lang,status')
          .order('sent_at', { ascending: false }).limit(500);
        if (!sends?.length) return 'No blog WhatsApp shares found.';
        const blogMap = {};
        let totalSent = 0, totalFailed = 0;
        for (const s of sends) {
          const key = s.blog_id;
          if (!blogMap[key]) blogMap[key] = { title: s.blog_title, lang: s.blog_lang, sent: 0, failed: 0 };
          if (s.status === 'sent') { blogMap[key].sent++; totalSent++; }
          else { blogMap[key].failed++; totalFailed++; }
        }
        let msg = `📝 *Blog WA Share Stats*\n*Total Sent: ${totalSent}* | Failed: ${totalFailed}\n\n`;
        msg += Object.values(blogMap).map(b =>
          `*${b.title}* (${b.lang})\n✅ ${b.sent} sent | ❌ ${b.failed} failed`
        ).join('\n\n');
        return msg;
      }

      case 'get_pending_b2b_claims': {
        const { data: pmtRow } = await supabase.from('settings').select('value').eq('key', 'b2b_payments').single();
        const allPmts = pmtRow?.value || {};
        const pending = [];
        for (const [orderId, pmt] of Object.entries(allPmts)) {
          const claims = [];
          if (pmt.customer_advance_claim?.status === 'pending_verification')
            claims.push({ type: 'advance', ...pmt.customer_advance_claim });
          if (pmt.customer_balance_claim?.status === 'pending_verification')
            claims.push({ type: 'balance', ...pmt.customer_balance_claim });
          if (pmt.customer_logistics_claim?.status === 'pending_verification')
            claims.push({ type: 'logistics', ...pmt.customer_logistics_claim });
          if (claims.length) pending.push({ orderId, claims });
        }
        if (!pending.length) return 'No pending B2B payment claims found.';
        // Fetch order details for each
        const orderIds = pending.map(p => p.orderId);
        const { data: orders } = await supabase.from('b2b_orders').select('id,order_no,customer_name,buyer_name').in('id', orderIds);
        const orderMap = {};
        for (const o of (orders || [])) orderMap[o.id] = o;
        let msg = `📋 *Pending B2B Payment Claims*\n\n`;
        for (const p of pending) {
          const o = orderMap[p.orderId] || {};
          for (const c of p.claims) {
            msg += `*${o.order_no || p.orderId}* · ${o.buyer_name || o.customer_name || '?'}\n`;
            msg += `Type: ${c.type === 'balance' ? '🏦 Balance' : c.type === 'advance' ? '💰 Advance' : '🚛 Logistics'}\n`;
            msg += `Amount: ₹${fmtINR(c.amount)} | Ref: ${c.txnRef || '—'} | Date: ${c.date || '—'}\n\n`;
          }
        }
        msg += `_Reply with order number to verify & record._`;
        return msg;
      }

      case 'record_b2b_payment': {
        // Find the B2B order by order_no
        const { data: order } = await supabase.from('b2b_orders')
          .select('id,order_no,customer_name,buyer_name,customer_id,total_value,logistics_charge,other_charges')
          .ilike('order_no', `%${input.order_no}%`).limit(1).single();
        if (!order) return `No B2B order found matching "${input.order_no}".`;

        const pmtType = input.type; // advance | remaining | logistics
        const SETTINGS_KEY = 'b2b_payments';
        const { data: existing } = await supabase.from('settings').select('value').eq('key', SETTINGS_KEY).single();
        const allPayments = existing?.value || {};
        const orderPayment = allPayments[order.id] || {};

        // Check for pending customer claim and use its data as fallback
        const claimKey = pmtType === 'advance' ? 'customer_advance_claim'
          : pmtType === 'remaining' ? 'customer_balance_claim'
          : 'customer_logistics_claim';
        const claim = orderPayment[claimKey];

        const pmtAmount = input.amount || (claim ? parseFloat(claim.amount) : 0);
        if (!pmtAmount || pmtAmount <= 0) return `Amount is required. ${claim ? `Customer claimed ₹${fmtINR(claim.amount)} — provide amount to confirm.` : 'No pending claim found for this order.'}`;

        const pmtDate = input.date || (claim?.date) || istToday();
        const pmtRef = input.ref || (claim?.txnRef) || '';
        const pmtNotes = input.notes || '';

        // Record the payment (same logic as POST /api/b2b/orders/:id/payment)
        if (pmtType === 'advance') {
          if (!Array.isArray(orderPayment.advance_entries)) {
            orderPayment.advance_entries = orderPayment.advance_paid > 0
              ? [{ amount: orderPayment.advance_paid, date: orderPayment.advance_date||'', ref: orderPayment.advance_ref||'', notes: orderPayment.advance_notes||'' }]
              : [];
          }
          orderPayment.advance_entries.push({ amount: pmtAmount, date: pmtDate, ref: pmtRef, notes: pmtNotes });
          orderPayment.advance_paid = orderPayment.advance_entries.reduce((s,e) => s + (parseFloat(e.amount)||0), 0);
          orderPayment.advance_date = pmtDate;
          orderPayment.advance_ref = pmtRef;
          orderPayment.advance_notes = pmtNotes;
          if (orderPayment.payment_status !== 'fully_paid') orderPayment.payment_status = 'advance_paid';
          if (orderPayment.customer_advance_claim) orderPayment.customer_advance_claim.status = 'verified';
        } else if (pmtType === 'remaining') {
          if (!Array.isArray(orderPayment.remaining_entries)) {
            orderPayment.remaining_entries = orderPayment.remaining_paid > 0
              ? [{ amount: orderPayment.remaining_paid, date: orderPayment.remaining_date||'', ref: orderPayment.remaining_ref||'', notes: orderPayment.remaining_notes||'' }]
              : [];
          }
          orderPayment.remaining_entries.push({ amount: pmtAmount, date: pmtDate, ref: pmtRef, notes: pmtNotes });
          orderPayment.remaining_paid = orderPayment.remaining_entries.reduce((s,e) => s + (parseFloat(e.amount)||0), 0);
          orderPayment.remaining_date = pmtDate;
          orderPayment.remaining_ref = pmtRef;
          orderPayment.remaining_notes = pmtNotes;
          // Auto-detect fully_paid
          const _advPaid = parseFloat(orderPayment.advance_paid)||0;
          const _remPaid = orderPayment.remaining_paid;
          const _logiPaid = parseFloat(orderPayment.logistics_paid)||0;
          const _totalPaid = _advPaid + _remPaid + _logiPaid;
          const _totalDue = (parseFloat(order.total_value)||0) + (parseFloat(order.logistics_charge)||0) + (parseFloat(order.other_charges)||0);
          orderPayment.payment_status = _totalPaid >= _totalDue && _totalDue > 0 ? 'fully_paid' : 'advance_paid';
          if (orderPayment.customer_balance_claim) orderPayment.customer_balance_claim.status = 'verified';
        } else {
          orderPayment.logistics_paid = pmtAmount;
          orderPayment.logistics_date = pmtDate;
          orderPayment.logistics_ref = pmtRef;
          orderPayment.logistics_notes = pmtNotes;
          if (orderPayment.customer_logistics_claim) orderPayment.customer_logistics_claim.status = 'verified';
        }

        allPayments[order.id] = orderPayment;
        const { error: saveErr } = await supabase.from('settings').upsert({ key: SETTINGS_KEY, value: allPayments });
        if (saveErr) return `Failed to save payment: ${saveErr.message}`;

        // Insert money ledger entry
        const subcatMap = { advance: 'b2b_advance', remaining: 'b2b_balance', logistics: 'b2b_logistics' };
        insertLedger({
          txn_date: pmtDate,
          direction: pmtType === 'logistics' ? 'out' : 'in',
          amount: pmtAmount,
          category: pmtType === 'logistics' ? 'expense' : 'sales',
          subcategory: subcatMap[pmtType] || 'b2b',
          party: order.buyer_name || order.customer_name || 'B2B Customer',
          party_type: pmtType === 'logistics' ? 'vendor' : 'customer',
          payment_mode: 'bank_transfer',
          narration: `B2B ${pmtType} payment — ${order.order_no} (via WhatsApp)`,
          reference_no: pmtRef,
          source_table: 'b2b_orders',
          source_id: order.id,
          created_by: 'WhatsApp Admin Agent',
        }).catch(() => {});

        // Send WhatsApp confirmation to B2B customer
        setImmediate(async () => {
          try {
            const { data: cust } = await supabase.from('b2b_customers').select('phone,contact_name').eq('id', order.customer_id).maybeSingle();
            if (cust?.phone) {
              const typeLabel = pmtType === 'advance' ? 'Advance Payment' : pmtType === 'remaining' ? 'Final Payment' : 'Logistics Payment';
              const msg = `🌿 *Sathvam Organics – Payment Received*\n\nDear ${cust.contact_name || order.buyer_name || 'Customer'},\n\nWe have received your *${typeLabel}* of *₹${fmtINR(pmtAmount)}* for order *${order.order_no}*.\n\nReference: ${pmtRef || 'N/A'} · Date: ${pmtDate}\n\nThank you!\n_sathvam.in_`;
              await gaSendText(cust.phone, msg);
            }
          } catch(_) {}
        });

        const typeLabel = pmtType === 'advance' ? 'Advance' : pmtType === 'remaining' ? 'Balance/Final' : 'Logistics';
        const totalDue = (parseFloat(order.total_value)||0) + (parseFloat(order.logistics_charge)||0) + (parseFloat(order.other_charges)||0);
        const totalPaid = (parseFloat(orderPayment.advance_paid)||0) + (parseFloat(orderPayment.remaining_paid)||0) + (parseFloat(orderPayment.logistics_paid)||0);
        return `✅ *${typeLabel} Payment Recorded*\n\nOrder: *${order.order_no}* · ${order.buyer_name || order.customer_name}\nAmount: *₹${fmtINR(pmtAmount)}*\nRef: ${pmtRef || 'N/A'}\nDate: ${pmtDate}\nStatus: *${orderPayment.payment_status}*\n\nTotal Due: ₹${fmtINR(totalDue)} | Total Paid: ₹${fmtINR(totalPaid)}${claim ? '\n\n_Customer portal claim verified ✓_' : ''}`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Error executing ${name}: ${e.message}`;
  }
}

// ── Main Handler ─────────────────────────────────────────────────────────────
async function handleAdminWhatsApp(phone, message) {
  try {
    // Send typing indicator
    const { sendTyping } = require('../lib/greenapi');
    await sendTyping(phone).catch(() => {});

    // Run Claude with tools
    let messages = [{ role: 'user', content: message }];

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      thinking: { type: 'adaptive' },
      system: `You are Sathvam's admin WhatsApp assistant. You help the business owner manage ALL operations via WhatsApp.

RULES:
- Keep responses SHORT — this is WhatsApp, max 3-4 paragraphs
- Use WhatsApp formatting: *bold*, _italic_, ~strikethrough~
- Always use tools to get real data — never guess
- For order status: search by order number, name, or phone
- For pricing: show procurement cost vs selling price
- For cancel/refund: ALWAYS confirm before executing (ask "Are you sure?")
- Format numbers in Indian style (₹1,23,456)
- Be concise and professional

SECURITY — STRICTLY FOLLOW:
- NEVER share API keys, passwords, secrets, tokens, or .env contents
- NEVER share database connection strings, Razorpay keys, Zoho tokens, SMTP credentials
- NEVER expose encryption keys, JWT secrets, webhook secrets
- NEVER share full customer email/phone — mask as ****3555 or k***@gmail.com
- NEVER share bank account numbers — mask as ****0399
- NEVER run DROP, TRUNCATE, or DELETE on tables without explicit confirmation
- If someone asks for secrets/keys/passwords, refuse and say "Security policy prevents sharing credentials"
- Only the registered admin phones can access this agent — if somehow bypassed, share nothing sensitive

CONTEXT:
- Sathvam Oils & Spices — cold-pressed oil manufacturer
- Products: oils (groundnut, sesame, coconut), spices, millets, powders
- Channels: sathvam.in webstore, B2B wholesale, POS retail
- Payment: Razorpay (online), COD, UPI
- Order format: SAT-YYYYMMDD-XXXX

AVAILABLE CAPABILITIES — use the right tool for each query:
- Orders: search, track, cancel/refund, pending, delivery tracking
- B2B: search orders, RECORD PAYMENTS (advance/balance/logistics) — when admin says "mark as received" or "record payment" for a B2B order, use record_b2b_payment tool. If the message is a reply to a payment claim notification, extract order number and payment type from context.
- Products: pricing, stock (finished/raw/packing), low stock alerts
- Finance: revenue, expenses, P&L, GST, receivables, payables, bank balance, vendor bills
- HR: attendance, leave requests, payroll
- Production: oil batches, flour batches, production plan
- Procurement: PO status, vendor tracking
- Operations: tasks, maintenance, compliance
- Marketing: analytics, WhatsApp stats, blog share stats
- Server: health, docker, services, SSL

PAYMENT CLAIM CONTEXT:
When the admin replies to a notification like "🏦 Balance Payment Claim / B2B-XXXXXX · COMPANY / Amount: ₹X,XX,XXX", understand that "mark as received", "received", "verify", "confirm" means they want to record that payment. Extract the order number and use record_b2b_payment with type='remaining' for balance claims, type='advance' for advance claims, type='logistics' for logistics claims.`,
      tools: TOOLS,
      messages,
    });

    // Handle tool use loop (max 5 iterations)
    let result = response;
    for (let i = 0; i < 5 && result.stop_reason === 'tool_use'; i++) {
      const toolBlocks = result.content.filter(b => b.type === 'tool_use');
      messages.push({ role: 'assistant', content: result.content });

      const toolResults = [];
      for (const tb of toolBlocks) {
        const output = await executeTool(tb.name, tb.input);
        toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: output });
      }
      messages.push({ role: 'user', content: toolResults });

      result = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: messages[0]?.role === 'user' ? undefined : messages[0].content,
        tools: TOOLS,
        messages,
      });
    }

    // Extract text response
    const textBlocks = result.content.filter(b => b.type === 'text');
    const reply = textBlocks.map(b => b.text).join('\n').trim();

    if (reply) {
      // Split long messages (WhatsApp limit ~4096 chars)
      if (reply.length > 4000) {
        const parts = reply.match(/.{1,3900}/gs) || [reply];
        for (const part of parts) {
          await gaSendText(phone, part, { priority: true });
        }
      } else {
        await gaSendText(phone, reply, { priority: true });
      }
    }

    return reply;
  } catch (e) {
    console.error('[wa-admin-agent] Error:', e.message);
    const errMsg = '❌ Agent error: ' + e.message.slice(0, 200);
    await gaSendText(phone, errMsg, { priority: true }).catch(() => {});
    return errMsg;
  }
}

module.exports = { handleAdminWhatsApp };
