const express = require('express');
const router  = express.Router();
const { auth } = require('../middleware/auth');
const supabase  = require('../config/supabase');

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'get_sales_summary',
    description: 'Get sales totals, revenue, and order counts. Use for questions about revenue, how much we sold, sales performance.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD (optional)' },
        end_date:   { type: 'string', description: 'End date YYYY-MM-DD (optional)' },
        channel:    { type: 'string', enum: ['website','b2b','retail','wholesale','all'], description: 'Sales channel' },
      },
    },
  },
  {
    name: 'get_orders',
    description: 'List orders with details. Use for questions about specific orders, order status, recent orders, pending orders.',
    input_schema: {
      type: 'object',
      properties: {
        limit:      { type: 'number', description: 'Number of orders (default 10, max 50)' },
        status:     { type: 'string', description: 'Filter: pending, confirmed, processing, shipped, delivered, cancelled' },
        channel:    { type: 'string', description: 'Filter: website, b2b, retail, wholesale' },
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
        end_date:   { type: 'string', description: 'End date YYYY-MM-DD' },
        search:     { type: 'string', description: 'Search by customer name or order number' },
      },
    },
  },
  {
    name: 'get_stock_levels',
    description: 'Get current stock levels for products. Use for inventory, stock, availability questions.',
    input_schema: {
      type: 'object',
      properties: {
        product_name:   { type: 'string', description: 'Filter by product name (partial match)' },
        low_stock_only: { type: 'boolean', description: 'Only show products with stock below 10 units' },
        category:       { type: 'string', description: 'Filter by category: oil, spice, flour, millet, etc.' },
      },
    },
  },
  {
    name: 'get_top_products',
    description: 'Get best-selling products ranked by revenue or quantity.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
        end_date:   { type: 'string', description: 'End date YYYY-MM-DD' },
        limit:      { type: 'number', description: 'Number of products (default 10)' },
        sort_by:    { type: 'string', enum: ['revenue','qty'], description: 'Sort by revenue or quantity' },
      },
    },
  },
  {
    name: 'update_order_status',
    description: 'Update the status of an order. Use when asked to mark an order as shipped, delivered, cancelled, etc.',
    input_schema: {
      type: 'object',
      required: ['order_no', 'status'],
      properties: {
        order_no: { type: 'string', description: 'Order number e.g. SW-1234' },
        status:   { type: 'string', enum: ['pending','confirmed','processing','shipped','delivered','cancelled'], description: 'New status' },
        notes:    { type: 'string', description: 'Optional note to append' },
      },
    },
  },
  {
    name: 'add_stock',
    description: 'Add stock inventory for a product. Use when asked to add stock, receive goods, update inventory.',
    input_schema: {
      type: 'object',
      required: ['product_name', 'qty'],
      properties: {
        product_name: { type: 'string', description: 'Product name (partial match ok)' },
        qty:          { type: 'number', description: 'Quantity to add' },
        notes:        { type: 'string', description: 'Optional notes e.g. batch number, supplier' },
      },
    },
  },
  {
    name: 'get_customers',
    description: 'Search or list customers.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search by name, phone, or email' },
        limit:  { type: 'number', description: 'Number of customers (default 20)' },
      },
    },
  },
  {
    name: 'get_revenue_trend',
    description: 'Get daily/monthly revenue trend for a period. Use for charts, trends, growth analysis.',
    input_schema: {
      type: 'object',
      properties: {
        start_date:  { type: 'string', description: 'Start date YYYY-MM-DD' },
        end_date:    { type: 'string', description: 'End date YYYY-MM-DD' },
        group_by:    { type: 'string', enum: ['day','month'], description: 'Group by day or month' },
      },
    },
  },
];

// ── Tool implementations ──────────────────────────────────────────────────────
async function executeTool(name, input) {
  try {
    switch (name) {

      case 'get_sales_summary': {
        let q = supabase.from('sales').select('channel,status,final_amount,amount_paid,date');
        if (input.start_date) q = q.gte('date', input.start_date);
        if (input.end_date)   q = q.lte('date', input.end_date);
        if (input.channel && input.channel !== 'all') q = q.eq('channel', input.channel);
        const { data, error } = await q;
        if (error) return { error: error.message };

        const totalRevenue  = data.reduce((s, r) => s + (r.final_amount || 0), 0);
        const totalPaid     = data.reduce((s, r) => s + (r.amount_paid  || 0), 0);
        const outstanding   = totalRevenue - totalPaid;
        const byChannel = {};
        const byStatus  = {};
        for (const r of data) {
          byChannel[r.channel] = (byChannel[r.channel] || 0) + (r.final_amount || 0);
          byStatus[r.status]   = (byStatus[r.status]   || 0) + 1;
        }
        return { total_orders: data.length, total_revenue: Math.round(totalRevenue), total_paid: Math.round(totalPaid), outstanding: Math.round(outstanding), by_channel: byChannel, by_status: byStatus };
      }

      case 'get_orders': {
        const limit = Math.min(input.limit || 10, 50);
        let q = supabase.from('sales')
          .select('order_no,date,channel,status,customer_name,customer_phone,final_amount,payment_method')
          .order('date', { ascending: false })
          .limit(limit);
        if (input.status)     q = q.eq('status', input.status);
        if (input.channel)    q = q.eq('channel', input.channel);
        if (input.start_date) q = q.gte('date', input.start_date);
        if (input.end_date)   q = q.lte('date', input.end_date);
        if (input.search)     q = q.or(`customer_name.ilike.%${input.search}%,order_no.ilike.%${input.search}%`);
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { orders: data, count: data.length };
      }

      case 'get_stock_levels': {
        let pq = supabase.from('products').select('id,name,cat,unit').eq('active', true);
        if (input.category) pq = pq.ilike('cat', `%${input.category}%`);
        const { data: products } = await pq;
        const { data: ledger }   = await supabase.from('stock_ledger').select('product_id,type,qty');

        const stock = {};
        for (const row of ledger || []) {
          if (!stock[row.product_id]) stock[row.product_id] = 0;
          stock[row.product_id] += row.type === 'in' ? (+row.qty || 0) : -(+row.qty || 0);
        }

        let result = (products || []).map(p => ({
          name: p.name, category: p.cat, unit: p.unit,
          stock: Math.max(0, stock[p.id] || 0),
        }));
        if (input.product_name) {
          const term = input.product_name.toLowerCase();
          result = result.filter(p => p.name.toLowerCase().includes(term));
        }
        if (input.low_stock_only) result = result.filter(p => p.stock < 10);
        result.sort((a, b) => a.stock - b.stock);
        return { products: result, count: result.length };
      }

      case 'get_top_products': {
        const limit  = input.limit  || 10;
        const sortBy = input.sort_by || 'revenue';
        let q = supabase.from('sale_items').select('product_name,qty,total');
        if (input.start_date || input.end_date) {
          let sq = supabase.from('sales').select('id');
          if (input.start_date) sq = sq.gte('date', input.start_date);
          if (input.end_date)   sq = sq.lte('date', input.end_date);
          const { data: sales } = await sq;
          const ids = (sales || []).map(s => s.id);
          if (ids.length > 0) q = q.in('sale_id', ids);
          else return { top_products: [] };
        }
        const { data, error } = await q;
        if (error) return { error: error.message };

        const agg = {};
        for (const row of data || []) {
          if (!agg[row.product_name]) agg[row.product_name] = { qty: 0, revenue: 0 };
          agg[row.product_name].qty     += row.qty   || 0;
          agg[row.product_name].revenue += row.total || 0;
        }
        const sorted = Object.entries(agg)
          .map(([name, d]) => ({ name, qty: Math.round(d.qty), revenue: Math.round(d.revenue) }))
          .sort((a, b) => b[sortBy] - a[sortBy])
          .slice(0, limit);
        return { top_products: sorted };
      }

      case 'update_order_status': {
        const update = { status: input.status };
        if (input.notes) update.notes = input.notes;
        const { error: e1 } = await supabase.from('sales').update(update).eq('order_no', input.order_no);
        await supabase.from('webstore_orders').update({ status: input.status }).eq('order_no', input.order_no);
        if (e1) return { error: e1.message };
        return { success: true, order_no: input.order_no, new_status: input.status };
      }

      case 'add_stock': {
        const { data: products } = await supabase.from('products')
          .select('id,name').ilike('name', `%${input.product_name}%`).eq('active', true);
        if (!products || products.length === 0)
          return { error: `No product found matching "${input.product_name}"` };
        if (products.length > 1)
          return { matches: products.map(p => p.name), error: `Multiple matches — be more specific: ${products.map(p=>p.name).join(', ')}` };

        const product = products[0];
        const { error } = await supabase.from('stock_ledger').insert({
          product_id: product.id,
          type:       'in',
          qty:        input.qty,
          date:       new Date().toISOString().slice(0, 10),
          notes:      input.notes || 'Added via AI assistant',
        });
        if (error) return { error: error.message };
        return { success: true, product: product.name, qty_added: input.qty };
      }

      case 'get_customers': {
        const limit = Math.min(input.limit || 20, 100);
        let q = supabase.from('customers')
          .select('name,email,phone,city,state,created_at')
          .order('created_at', { ascending: false })
          .limit(limit);
        if (input.search) q = q.or(`name.ilike.%${input.search}%,phone.ilike.%${input.search}%,email.ilike.%${input.search}%`);
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { customers: data, count: data.length };
      }

      case 'get_revenue_trend': {
        const { start_date, end_date, group_by = 'day' } = input;
        let q = supabase.from('sales').select('date,final_amount,channel');
        if (start_date) q = q.gte('date', start_date);
        if (end_date)   q = q.lte('date', end_date);
        const { data, error } = await q;
        if (error) return { error: error.message };

        const trend = {};
        for (const r of data || []) {
          const key = group_by === 'month' ? r.date.slice(0, 7) : r.date;
          if (!trend[key]) trend[key] = { revenue: 0, orders: 0 };
          trend[key].revenue += r.final_amount || 0;
          trend[key].orders  += 1;
        }
        const series = Object.entries(trend)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, d]) => ({ date, revenue: Math.round(d.revenue), orders: d.orders }));
        return { trend: series, total_points: series.length };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// ── POST /api/admin-chat ──────────────────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'AI service not configured' });

  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'No messages provided' });

  const today = new Date().toISOString().slice(0, 10);

  const systemPrompt = `You are an intelligent admin assistant for Sathvam Natural Products — a factory-direct natural products company in Karur, Tamil Nadu.
Today's date: ${today}

You help the admin team by:
- Answering questions about sales, revenue, orders, stock, customers
- Taking actions: update order status, add stock
- Providing business insights and summaries

Always use tools to get real data before answering. Never guess numbers.
Be concise and business-like. Use ₹ for amounts, format large numbers with commas (e.g. ₹1,23,456).
When showing lists keep them short and readable — use line breaks, not markdown tables.
For action confirmations, be clear about what was done.`;

  let apiMessages = messages.slice(-12).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }));

  const toolSteps = [];

  try {
    for (let i = 0; i < 6; i++) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model:      'claude-sonnet-4-6',
          max_tokens: 1024,
          system:     systemPrompt,
          tools:      TOOLS,
          messages:   apiMessages,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        console.error('Admin chat Anthropic error:', err);
        return res.status(502).json({ error: 'AI service error' });
      }

      const data = await response.json();

      if (data.stop_reason === 'tool_use') {
        apiMessages.push({ role: 'assistant', content: data.content });
        const toolResults = [];
        for (const block of data.content) {
          if (block.type !== 'tool_use') continue;
          const result = await executeTool(block.name, block.input);
          toolSteps.push({ tool: block.name, input: block.input, result });
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
        }
        apiMessages.push({ role: 'user', content: toolResults });
        continue;
      }

      const reply = data.content?.find(b => b.type === 'text')?.text ?? 'Done.';
      return res.json({ reply, toolSteps });
    }

    return res.json({ reply: 'Reached maximum reasoning depth. Please try a simpler question.', toolSteps });
  } catch (err) {
    console.error('Admin chat error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
