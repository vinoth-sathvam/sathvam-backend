/**
 * WhatsApp Admin Agent — Process admin commands via WhatsApp
 *
 * When an admin sends a WhatsApp message, this handler:
 * 1. Detects business intent (order status, cancel, refund, pricing, stock, etc.)
 * 2. Queries the database with the right tools
 * 3. Replies with formatted results on WhatsApp
 *
 * Supports: order lookup, cancel+refund, pricing check, stock check,
 * revenue summary, pending orders, customer lookup, B2B order status
 */

const Anthropic = require('@anthropic-ai/sdk');
const supabase  = require('../config/supabase');
const { sendText: gaSendText } = require('../lib/greenapi');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
    description: 'Check current stock levels for finished goods or raw materials.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['finished', 'raw'], description: 'finished = finished goods (bottled products), raw = raw materials (seeds, commodities)' },
        product_name: { type: 'string', description: 'Product or material name to search' },
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

async function executeTool(name, input) {
  try {
    switch (name) {

      case 'search_orders': {
        const q = input.query || '';
        let filter = supabase.from('webstore_orders').select('id,order_no,date,customer,items,subtotal,gst_amount,shipping,total,payment_status,status,tracking_no,courier,payment_id,notes,created_at');
        if (/^SAT-/i.test(q)) {
          filter = filter.ilike('order_no', `%${q}%`);
        } else {
          // Search in customer JSONB or order_no
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
          filter = filter.eq('active', true).limit(15);
          const { data } = await filter;
          if (!data?.length) return 'No raw materials found.';
          return data.map(r => {
            const status = r.min_stock && r.current_stock < r.min_stock ? '🔴 LOW' : '🟢';
            return `${status} *${r.name}*: ${r.current_stock} ${r.unit || 'kg'}${r.min_stock ? ` (min: ${r.min_stock})` : ''}`;
          }).join('\n');
        } else {
          let filter = supabase.from('stock_ledger').select('product_name,qty,type,date').order('date', { ascending: false });
          if (input.product_name) filter = filter.ilike('product_name', `%${input.product_name}%`);
          filter = filter.limit(50);
          const { data } = await filter;
          if (!data?.length) return 'No stock movements found.';
          // Calculate net stock per product
          const stocks = {};
          for (const r of data) {
            if (!stocks[r.product_name]) stocks[r.product_name] = 0;
            stocks[r.product_name] += r.type === 'IN' ? r.qty : -r.qty;
          }
          return Object.entries(stocks).map(([name, qty]) => {
            const status = qty <= 0 ? '🔴 OUT' : qty < 10 ? '🟡 LOW' : '🟢';
            return `${status} *${name}*: ${qty} units`;
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

        return `📊 *${input.period.toUpperCase()} Summary*\nTotal Orders: ${orders.length}\nPaid Orders: ${paid.length}\nRevenue: ₹${totalRevenue.toLocaleString('en-IN')}\nPending Dispatch: ${pending.length}\nDelivered: ${orders.filter(o => o.status === 'delivered').length}\nCancelled: ${orders.filter(o => o.status === 'cancelled').length}`;
      }

      case 'cancel_and_refund': {
        const { data: order } = await supabase.from('webstore_orders').select('*').eq('order_no', input.order_no).single();
        if (!order) return `Order ${input.order_no} not found.`;
        if (['cancelled', 'refunded'].includes(order.status)) return `Order ${input.order_no} is already ${order.status}.`;

        // Update status to cancelled
        await supabase.from('webstore_orders').update({
          status: 'cancelled',
          notes: `${order.notes || ''}\nCancelled via WhatsApp admin: ${input.reason || 'No reason'}`.trim(),
        }).eq('id', order.id);

        // Try Razorpay refund if payment exists
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
          `*${a.name}* (${a.bank_name})\n${a.type} | ₹${parseFloat(a.current_balance || 0).toLocaleString('en-IN')}`
        ).join('\n\n') + `\n\n💰 *Total: ₹${total.toLocaleString('en-IN')}*`;
      }

      case 'server_health': {
        const { execSync } = require('child_process');
        let cmd;
        switch (input.check) {
          case 'cpu':
            cmd = `top -bn1 | head -5 && echo "\\nLoad avg:" && cat /proc/loadavg`;
            break;
          case 'memory':
            cmd = 'free -h';
            break;
          case 'disk':
            cmd = 'df -h /';
            break;
          case 'docker':
            cmd = 'sudo docker ps --format "{{.Names}}: {{.Status}}" 2>&1';
            break;
          case 'services':
            cmd = 'systemctl list-units --type=service --all 2>&1 | grep sathvam | head -30';
            break;
          case 'ssl':
            cmd = 'sudo /home/ubuntu/sathvam-frontend/sathvam-vercel/scripts/ssl-cert-monitor.sh --check-only 2>&1 | tail -10';
            break;
          default: // overview
            cmd = `echo "=== CPU ===" && top -bn1 | grep "Cpu\\|load" | head -2 && echo "\\n=== Memory ===" && free -h | head -2 && echo "\\n=== Disk ===" && df -h / | tail -1 && echo "\\n=== Docker ===" && sudo docker ps --format "{{.Names}}: {{.Status}}" 2>&1`;
        }
        try {
          const output = execSync(cmd, { timeout: 15000, encoding: 'utf8' });
          return output;
        } catch (e) {
          return `Error: ${e.message}`;
        }
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
      system: `You are Sathvam's admin WhatsApp assistant. You help the business owner manage operations via WhatsApp.

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
- Order format: SAT-YYYYMMDD-XXXX`,
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
