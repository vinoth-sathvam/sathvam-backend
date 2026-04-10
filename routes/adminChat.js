const express    = require('express');
const router     = express.Router();
const nodemailer = require('nodemailer');
const { auth, requireRole } = require('../middleware/auth');
const adminOnly = [auth, requireRole('admin','manager')];
const supabase   = require('../config/supabase');
const { checkDailyTasks, sendReminders } = require('../config/scheduler');

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'get_sales_summary',
    description: 'Get sales totals, revenue, order counts, and outstanding payments. Use for revenue, sales performance, how much we sold, outstanding amounts.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
        end_date:   { type: 'string', description: 'End date YYYY-MM-DD' },
        channel:    { type: 'string', enum: ['website','b2b','retail','wholesale','all'], description: 'Sales channel' },
      },
    },
  },
  {
    name: 'get_orders',
    description: 'List domestic/retail/webstore orders. Use for order status, recent orders, pending orders, customer orders.',
    input_schema: {
      type: 'object',
      properties: {
        limit:      { type: 'number', description: 'Number of orders (default 10, max 50)' },
        status:     { type: 'string', description: 'Filter: pending, confirmed, processing, shipped, delivered, cancelled' },
        channel:    { type: 'string', description: 'Filter: website, retail, wholesale' },
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
        end_date:   { type: 'string', description: 'End date YYYY-MM-DD' },
        search:     { type: 'string', description: 'Search by customer name or order number' },
      },
    },
  },
  {
    name: 'get_b2b_data',
    description: 'Get B2B export orders and customers.',
    input_schema: {
      type: 'object',
      properties: {
        type:       { type: 'string', enum: ['orders','customers','both'], description: 'What to fetch (default: both)' },
        stage:      { type: 'string', description: 'Filter orders by stage: order_placed, production, quality_check, shipped, delivered' },
        search:     { type: 'string', description: 'Search by buyer name or country' },
        limit:      { type: 'number', description: 'Number of records (default 10)' },
      },
    },
  },
  {
    name: 'get_stock_levels',
    description: 'Get current stock levels. Use for inventory, stock, availability, low-stock questions.',
    input_schema: {
      type: 'object',
      properties: {
        product_name:   { type: 'string', description: 'Filter by product name (partial match)' },
        low_stock_only: { type: 'boolean', description: 'Only products with stock below 10' },
        category:       { type: 'string', description: 'Filter by category' },
      },
    },
  },
  {
    name: 'get_top_products',
    description: 'Get best-selling products by revenue or quantity.',
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
    name: 'get_revenue_trend',
    description: 'Get daily or monthly revenue trend. Use for charts, growth, period comparisons.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
        end_date:   { type: 'string', description: 'End date YYYY-MM-DD' },
        group_by:   { type: 'string', enum: ['day','month'], description: 'Group by day or month' },
      },
    },
  },
  {
    name: 'compare_periods',
    description: 'Compare revenue and orders between two time periods (e.g. this month vs last month).',
    input_schema: {
      type: 'object',
      required: ['period1_start','period1_end','period2_start','period2_end'],
      properties: {
        period1_start: { type: 'string', description: 'Period 1 start YYYY-MM-DD' },
        period1_end:   { type: 'string', description: 'Period 1 end YYYY-MM-DD' },
        period2_start: { type: 'string', description: 'Period 2 start YYYY-MM-DD' },
        period2_end:   { type: 'string', description: 'Period 2 end YYYY-MM-DD' },
      },
    },
  },
  {
    name: 'get_procurement',
    description: 'Get raw material procurement records. Use for purchase history, supplier costs, material availability.',
    input_schema: {
      type: 'object',
      properties: {
        material:   { type: 'string', description: 'Filter by material name (partial match)' },
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
        end_date:   { type: 'string', description: 'End date YYYY-MM-DD' },
        limit:      { type: 'number', description: 'Number of records (default 20)' },
      },
    },
  },
  {
    name: 'get_vendors',
    description: 'Get supplier/vendor list.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search by vendor name' },
      },
    },
  },
  {
    name: 'get_customers',
    description: 'Search or list retail/webstore customers.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Search by name, phone, or email' },
        limit:  { type: 'number', description: 'Number of customers (default 20)' },
      },
    },
  },
  {
    name: 'get_products',
    description: 'Get product list with prices. Use for price lookup, product details.',
    input_schema: {
      type: 'object',
      properties: {
        search:   { type: 'string', description: 'Search by product name' },
        category: { type: 'string', description: 'Filter by category' },
        active_only: { type: 'boolean', description: 'Only active products (default true)' },
      },
    },
  },
  {
    name: 'update_order_status',
    description: 'Update the status of a domestic/retail order.',
    input_schema: {
      type: 'object',
      required: ['order_no','status'],
      properties: {
        order_no: { type: 'string', description: 'Order number e.g. SW-1234' },
        status:   { type: 'string', enum: ['pending','confirmed','processing','shipped','delivered','cancelled'] },
        notes:    { type: 'string', description: 'Optional note to append' },
      },
    },
  },
  {
    name: 'add_stock',
    description: 'Add stock inventory for a product.',
    input_schema: {
      type: 'object',
      required: ['product_name','qty'],
      properties: {
        product_name: { type: 'string', description: 'Product name (partial match ok)' },
        qty:          { type: 'number', description: 'Quantity to add' },
        notes:        { type: 'string', description: 'Optional notes e.g. batch number' },
      },
    },
  },
  {
    name: 'update_product_price',
    description: 'Update the price of a product (website price and/or factory price).',
    input_schema: {
      type: 'object',
      required: ['product_name'],
      properties: {
        product_name:  { type: 'string', description: 'Product name (partial match)' },
        website_price: { type: 'number', description: 'New website/retail price' },
        factory_price: { type: 'number', description: 'New factory/B2B price' },
      },
    },
  },
  {
    name: 'toggle_website_product',
    description: 'Enable or disable a product on the website store.',
    input_schema: {
      type: 'object',
      required: ['product_name','enabled'],
      properties: {
        product_name: { type: 'string', description: 'Product name (partial match)' },
        enabled:      { type: 'boolean', description: 'true = show on website, false = hide' },
      },
    },
  },
  {
    name: 'create_sale',
    description: 'Create a new sales order (retail/walk-in). Use when asked to record a sale.',
    input_schema: {
      type: 'object',
      required: ['customer_name','items','payment_method'],
      properties: {
        customer_name:  { type: 'string', description: 'Customer name' },
        customer_phone: { type: 'string', description: 'Customer phone (optional)' },
        channel:        { type: 'string', enum: ['retail','wholesale','website'], description: 'Channel (default: retail)' },
        payment_method: { type: 'string', enum: ['cash','upi','card','credit','online'], description: 'Payment method' },
        items: {
          type: 'array',
          description: 'List of items sold',
          items: {
            type: 'object',
            required: ['product_name','qty','rate'],
            properties: {
              product_name: { type: 'string' },
              qty:          { type: 'number' },
              rate:         { type: 'number', description: 'Price per unit' },
            },
          },
        },
        notes: { type: 'string', description: 'Optional notes' },
      },
    },
  },
  {
    name: 'send_whatsapp',
    description: 'Send a WhatsApp message to a customer or phone number.',
    input_schema: {
      type: 'object',
      required: ['phone','message'],
      properties: {
        phone:   { type: 'string', description: 'Phone number with country code e.g. 919876543210' },
        message: { type: 'string', description: 'Message text to send' },
      },
    },
  },
  {
    name: 'get_business_summary',
    description: 'Get a complete business summary: pending orders, low stock, today\'s revenue, recent activity. Use this for morning briefing or overview requests.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_margin_analysis',
    description: 'Get profit margin analysis for products — cost vs selling price, margin %. Use for profitability questions.',
    input_schema: {
      type: 'object',
      properties: {
        product_name: { type: 'string', description: 'Filter by product name (partial match)' },
        category:     { type: 'string', description: 'Filter by category' },
        sort_by:      { type: 'string', enum: ['margin_pct','price','name'], description: 'Sort order' },
      },
    },
  },
  {
    name: 'get_customer_history',
    description: 'Get full order history for a specific customer — all their past orders and items.',
    input_schema: {
      type: 'object',
      required: ['customer'],
      properties: {
        customer: { type: 'string', description: 'Customer name or phone number' },
      },
    },
  },
  {
    name: 'get_reorder_suggestions',
    description: 'Get products that need restocking — based on low current stock and recent sales velocity.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_production_batches',
    description: 'Get oil production batch records — input kg, oil output, cake output, efficiency.',
    input_schema: {
      type: 'object',
      properties: {
        oil_type:   { type: 'string', description: 'Filter by oil type: Groundnut, Sesame, Coconut' },
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
        end_date:   { type: 'string', description: 'End date YYYY-MM-DD' },
        limit:      { type: 'number', description: 'Number of records (default 20)' },
      },
    },
  },
  {
    name: 'get_anomaly_report',
    description: 'Detect unusual patterns — revenue drops/spikes, order count changes vs prior week.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_set_sales_target',
    description: 'Get or set the monthly sales revenue target.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get','set'], description: 'Get current target or set a new one' },
        target: { type: 'number', description: 'New target amount in ₹ (required for set)' },
        month:  { type: 'string', description: 'Month YYYY-MM (default: current month)' },
      },
    },
  },
  {
    name: 'send_email',
    description: 'Send an email to any address. Use for reports, summaries, or customer communication.',
    input_schema: {
      type: 'object',
      required: ['to','subject','body'],
      properties: {
        to:      { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject' },
        body:    { type: 'string', description: 'Email body (plain text or simple HTML)' },
      },
    },
  },
  {
    name: 'bulk_update_prices',
    description: 'Update prices for multiple products at once — by category or name pattern, by percentage or fixed amount.',
    input_schema: {
      type: 'object',
      required: ['change_pct'],
      properties: {
        category:     { type: 'string', description: 'Apply to all products in this category' },
        name_pattern: { type: 'string', description: 'Apply to products matching this name pattern' },
        change_pct:   { type: 'number', description: 'Percentage change e.g. 5 for +5%, -10 for -10%' },
        price_field:  { type: 'string', enum: ['website_price','price','both'], description: 'Which price to update (default: website_price)' },
      },
    },
  },
  {
    name: 'bulk_toggle_website',
    description: 'Enable or disable multiple products on the website at once — by category.',
    input_schema: {
      type: 'object',
      required: ['enabled'],
      properties: {
        category: { type: 'string', description: 'Category to enable/disable (e.g. oil, spice, millet)' },
        enabled:  { type: 'boolean', description: 'true = show on website, false = hide' },
      },
    },
  },
  {
    name: 'update_b2b_order',
    description: 'Update a B2B export order — stage, BL number, container number, ETD, ETA, notes.',
    input_schema: {
      type: 'object',
      required: ['order_no'],
      properties: {
        order_no:     { type: 'string', description: 'B2B order number' },
        stage:        { type: 'string', enum: ['order_placed','production','quality_check','shipped','delivered','cancelled'], description: 'New stage' },
        bl_no:        { type: 'string', description: 'Bill of lading number' },
        container_no: { type: 'string', description: 'Container number' },
        etd:          { type: 'string', description: 'Estimated departure date YYYY-MM-DD' },
        eta:          { type: 'string', description: 'Estimated arrival date YYYY-MM-DD' },
        notes:        { type: 'string', description: 'Notes' },
      },
    },
  },
  {
    name: 'get_expense_summary',
    description: 'Get company expense summary for any date range. Shows total spent, category breakdown, payment mode split, daily trend, top vendors, and opening/closing balance.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD (default: first of current month)' },
        end_date:   { type: 'string', description: 'End date YYYY-MM-DD (default: today)' },
        category:   { type: 'string', description: 'Filter by specific category name (optional)' },
      },
    },
  },
  {
    name: 'get_expense_details',
    description: 'Get individual expense entries for a date or range. Use to answer questions like "what did we spend on transport today?" or "show all cash expenses this week".',
    input_schema: {
      type: 'object',
      properties: {
        start_date:   { type: 'string', description: 'Start date YYYY-MM-DD' },
        end_date:     { type: 'string', description: 'End date YYYY-MM-DD' },
        category:     { type: 'string', description: 'Filter by category (optional)' },
        payment_mode: { type: 'string', enum: ['cash','upi','bank_transfer','cheque','credit_card'], description: 'Filter by payment mode (optional)' },
      },
    },
  },
  {
    name: 'get_expense_vs_revenue',
    description: 'Compare company expenses vs sales revenue for a period. Shows profit/loss after expenses, expense ratio, and net position.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD (default: first of current month)' },
        end_date:   { type: 'string', description: 'End date YYYY-MM-DD (default: today)' },
      },
    },
  },
  {
    name: 'get_opening_balance',
    description: 'Get the opening balance (petty cash / daily budget) for a specific date, or set a new one.',
    input_schema: {
      type: 'object',
      properties: {
        date:            { type: 'string', description: 'Date YYYY-MM-DD (default: today)' },
        action:          { type: 'string', enum: ['get','set'], description: 'Get or set opening balance (default: get)' },
        opening_balance: { type: 'number', description: 'New opening balance amount (required for set)' },
      },
    },
  },
  {
    name: 'check_daily_tasks',
    description: 'Check what daily tasks are completed or pending today: expenses logged, batch logged, attendance marked. Use this to monitor manager compliance and decide if a reminder is needed.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'send_manager_reminder',
    description: 'Send an immediate reminder to all active managers and admins via email and WhatsApp. Use when daily tasks are overdue or manager has not updated required data.',
    input_schema: {
      type: 'object',
      required: ['pending_tasks'],
      properties: {
        pending_tasks: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of pending task descriptions to include in the reminder message',
        },
        label: { type: 'string', description: 'Label for the reminder e.g. "Afternoon Check" (default: "AI Reminder")' },
      },
    },
  },
  {
    name: 'get_customer_issues',
    description: 'Get customer chat sessions where visitors reported ordering problems, payment failures, or checkout issues. Use when asked about customer complaints, chat issues, ordering problems, or to check if anyone needs help.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open','resolved','all'], description: 'Filter by status (default: open)' },
        limit:  { type: 'number', description: 'Max results (default 10)' },
      },
    },
  },
  {
    name: 'get_operations_status',
    description: 'Get a full cross-module operations snapshot: overdue staff tasks, pending leave requests, pending returns, quality failures, compliance expiry alerts, active delivery runs, pending product reviews. Use for "what needs attention", "operations overview", morning briefing, or any broad status question.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_staff_tasks',
    description: 'Get staff tasks. Use for task list, overdue tasks, who has what assigned, task progress.',
    input_schema: {
      type: 'object',
      properties: {
        status:      { type: 'string', enum: ['todo','in_progress','done','all'], description: 'Filter by status (default: all open)' },
        assigned_to: { type: 'string', description: 'Filter by assignee name (partial match)' },
        priority:    { type: 'string', enum: ['high','medium','low'], description: 'Filter by priority' },
      },
    },
  },
  {
    name: 'create_staff_task',
    description: 'Create a new staff task. Use when asked to assign a task or reminder to a team member.',
    input_schema: {
      type: 'object',
      required: ['title'],
      properties: {
        title:         { type: 'string', description: 'Task title' },
        description:   { type: 'string', description: 'Task details' },
        assigned_name: { type: 'string', description: 'Who to assign to' },
        due_date:      { type: 'string', description: 'Due date YYYY-MM-DD' },
        priority:      { type: 'string', enum: ['high','medium','low'], description: 'Priority (default: medium)' },
        category:      { type: 'string', description: 'Category: production, procurement, delivery, quality, admin, general' },
      },
    },
  },
  {
    name: 'get_leave_requests',
    description: 'Get employee leave requests. Use for pending approvals, who is on leave, leave history.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending','approved','rejected','all'], description: 'Filter by status (default: pending)' },
        limit:  { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'approve_leave',
    description: 'Approve or reject an employee leave request by ID.',
    input_schema: {
      type: 'object',
      required: ['leave_id','action'],
      properties: {
        leave_id: { type: 'number', description: 'Leave request ID' },
        action:   { type: 'string', enum: ['approved','rejected'], description: 'Approve or reject' },
        notes:    { type: 'string', description: 'Optional notes' },
      },
    },
  },
  {
    name: 'get_returns',
    description: 'Get return and refund requests. Use for returns overview, pending refunds, refund amounts.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending','approved','refunded','rejected','all'], description: 'Filter by status (default: all)' },
        limit:  { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'get_quality_status',
    description: 'Get quality control test results and pass/fail stats by product. Use for quality overview, fail rates, which products have issues.',
    input_schema: {
      type: 'object',
      properties: {
        product_name: { type: 'string', description: 'Filter by product name (partial match)' },
        result:       { type: 'string', enum: ['pass','fail','hold'], description: 'Filter by result' },
        limit:        { type: 'number', description: 'Max test records (default 20)' },
      },
    },
  },
  {
    name: 'get_compliance_status',
    description: 'Get compliance documents status — FSSAI, GST, trade licenses, certifications. Use for expiry alerts, document tracking.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['valid','expiring_soon','expired','all'], description: 'Filter by status (default: all non-valid)' },
      },
    },
  },
  {
    name: 'get_delivery_status',
    description: 'Get delivery runs and their status. Use for dispatch overview, pending deliveries, driver assignments.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending','in_transit','completed','all'], description: 'Filter by status' },
        limit:  { type: 'number', description: 'Max results (default 10)' },
      },
    },
  },
  {
    name: 'get_demand_forecast',
    description: 'Get demand forecast for the next N weeks based on 90 days of sales history. Use for production planning, what to make next.',
    input_schema: {
      type: 'object',
      properties: {
        weeks: { type: 'number', description: 'Forecast horizon in weeks (default 4)' },
        limit: { type: 'number', description: 'Top N products to show (default 10)' },
      },
    },
  },
  {
    name: 'get_reviews_summary',
    description: 'Get product review summary — pending approvals, average ratings, recent reviews.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending','approved','rejected','all'], description: 'Filter by status (default: all)' },
        limit:  { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'get_crm_summary',
    description: 'Get webstore customer CRM summary — top customers, total revenue, repeat customer count.',
    input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'Top N customers (default 10)' } } },
  },
  {
    name: 'get_coupon_performance',
    description: 'Get coupon usage stats — which coupons are used most, usage counts, active/inactive.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'write_seo_blog_post',
    description: 'Write and publish an SEO-optimised blog article for www.sathvam.in. The article targets a specific search keyword to bring organic Google traffic. Write 700–900 words, use Markdown headings, include practical tips. Auto-publishes to the blog. IMPORTANT: Every article must naturally weave in Sathvam\'s 4 brand pillars — (1) Purity: uncompromised purity, pure from source to bottle; (2) Healthy: real nutrition, nourish your family, healthier life; (3) Hygienic: hygienically processed, clean from farm to bottle, food-safe facility; (4) Quality Seeds for Grinding: hand-picked quality seeds, premium seeds for pressing, quality starts at the source. Make these feel natural and authentic, not like marketing.',
    input_schema: {
      type: 'object',
      required: ['keyword', 'title'],
      properties: {
        keyword:  { type: 'string', description: 'Target Google search keyword e.g. "benefits of cold pressed groundnut oil"' },
        title:    { type: 'string', description: 'Blog post title' },
        category: { type: 'string', enum: ['oils','millets','spices','health','recipes','farming'], description: 'Post category' },
        content:  { type: 'string', description: 'Full blog post content in Markdown (600–900 words). If not provided, the tool returns a template prompt.' },
      },
    },
  },
  {
    name: 'get_blog_posts',
    description: 'Get list of published blog posts on www.sathvam.in',
    input_schema: { type: 'object', properties: {} },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getStockMap() {
  const { data } = await supabase.from('stock_ledger').select('product_id,type,qty');
  const stock = {};
  for (const row of data || []) {
    if (!stock[row.product_id]) stock[row.product_id] = 0;
    stock[row.product_id] += row.type === 'in' ? (+row.qty||0) : -(+row.qty||0);
  }
  for (const id of Object.keys(stock)) if (stock[id] < 0) stock[id] = 0;
  return stock;
}

function uid() { return 'sale_' + Date.now() + '_' + Math.random().toString(36).slice(2,7); }

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
        const totalRevenue = data.reduce((s,r) => s+(r.final_amount||0), 0);
        const totalPaid    = data.reduce((s,r) => s+(r.amount_paid||0), 0);
        const byChannel = {}, byStatus = {};
        for (const r of data) {
          byChannel[r.channel] = (byChannel[r.channel]||0) + (r.final_amount||0);
          byStatus[r.status]   = (byStatus[r.status]||0) + 1;
        }
        return { total_orders: data.length, total_revenue: Math.round(totalRevenue), total_paid: Math.round(totalPaid), outstanding: Math.round(totalRevenue-totalPaid), by_channel: byChannel, by_status: byStatus };
      }

      case 'get_orders': {
        const limit = Math.min(input.limit||10, 50);
        let q = supabase.from('sales')
          .select('order_no,date,channel,status,customer_name,customer_phone,final_amount,amount_paid,payment_method')
          .order('date', { ascending: false }).limit(limit);
        if (input.status)     q = q.eq('status', input.status);
        if (input.channel)    q = q.eq('channel', input.channel);
        if (input.start_date) q = q.gte('date', input.start_date);
        if (input.end_date)   q = q.lte('date', input.end_date);
        if (input.search)     q = q.or(`customer_name.ilike.%${input.search}%,order_no.ilike.%${input.search}%`);
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { orders: data, count: data.length };
      }

      case 'get_b2b_data': {
        const type = input.type || 'both';
        const result = {};
        if (type === 'customers' || type === 'both') {
          let q = supabase.from('b2b_customers').select('company_name,contact_name,email,country,currency,phone,active').eq('active', true).limit(input.limit||50);
          if (input.search) q = q.or(`company_name.ilike.%${input.search}%,contact_name.ilike.%${input.search}%,country.ilike.%${input.search}%`);
          const { data } = await q;
          result.customers = data || [];
        }
        if (type === 'orders' || type === 'both') {
          let q = supabase.from('b2b_orders').select('order_no,date,buyer_name,stage,total_value,notes').order('date', { ascending: false }).limit(input.limit||10);
          if (input.stage) q = q.eq('stage', input.stage);
          if (input.search) q = q.or(`buyer_name.ilike.%${input.search}%`);
          const { data } = await q;
          result.orders = data || [];
        }
        return result;
      }

      case 'get_stock_levels': {
        let pq = supabase.from('products').select('id,name,cat,unit').eq('active', true);
        if (input.category) pq = pq.ilike('cat', `%${input.category}%`);
        const { data: products } = await pq;
        const stock = await getStockMap();
        let result = (products||[]).map(p => ({ name:p.name, category:p.cat, unit:p.unit, stock: stock[p.id]||0 }));
        if (input.product_name) { const t = input.product_name.toLowerCase(); result = result.filter(p => p.name.toLowerCase().includes(t)); }
        if (input.low_stock_only) result = result.filter(p => p.stock < 10);
        result.sort((a,b) => a.stock - b.stock);
        return { products: result, count: result.length };
      }

      case 'get_top_products': {
        const limit  = input.limit||10;
        const sortBy = input.sort_by||'revenue';
        let q = supabase.from('sale_items').select('product_name,qty,total');
        if (input.start_date || input.end_date) {
          let sq = supabase.from('sales').select('id');
          if (input.start_date) sq = sq.gte('date', input.start_date);
          if (input.end_date)   sq = sq.lte('date', input.end_date);
          const { data: sales } = await sq;
          const ids = (sales||[]).map(s => s.id);
          if (ids.length === 0) return { top_products: [] };
          q = q.in('sale_id', ids);
        }
        const { data, error } = await q;
        if (error) return { error: error.message };
        const agg = {};
        for (const row of data||[]) {
          if (!agg[row.product_name]) agg[row.product_name] = { qty:0, revenue:0 };
          agg[row.product_name].qty     += row.qty||0;
          agg[row.product_name].revenue += row.total||0;
        }
        const sorted = Object.entries(agg).map(([name,d]) => ({ name, qty:Math.round(d.qty), revenue:Math.round(d.revenue) })).sort((a,b) => b[sortBy]-a[sortBy]).slice(0,limit);
        return { top_products: sorted };
      }

      case 'get_revenue_trend': {
        let q = supabase.from('sales').select('date,final_amount');
        if (input.start_date) q = q.gte('date', input.start_date);
        if (input.end_date)   q = q.lte('date', input.end_date);
        const { data, error } = await q;
        if (error) return { error: error.message };
        const groupBy = input.group_by || 'day';
        const trend = {};
        for (const r of data||[]) {
          const key = groupBy === 'month' ? r.date.slice(0,7) : r.date;
          if (!trend[key]) trend[key] = { revenue:0, orders:0 };
          trend[key].revenue += r.final_amount||0;
          trend[key].orders  += 1;
        }
        const series = Object.entries(trend).sort(([a],[b]) => a.localeCompare(b)).map(([date,d]) => ({ date, revenue:Math.round(d.revenue), orders:d.orders }));
        return { trend: series };
      }

      case 'compare_periods': {
        async function periodSummary(start, end) {
          const { data } = await supabase.from('sales').select('final_amount,channel').gte('date', start).lte('date', end);
          const revenue = (data||[]).reduce((s,r) => s+(r.final_amount||0), 0);
          return { orders: (data||[]).length, revenue: Math.round(revenue) };
        }
        const [p1, p2] = await Promise.all([
          periodSummary(input.period1_start, input.period1_end),
          periodSummary(input.period2_start, input.period2_end),
        ]);
        const revGrowth = p1.revenue > 0 ? Math.round(((p2.revenue-p1.revenue)/p1.revenue)*100) : null;
        const ordGrowth = p1.orders  > 0 ? Math.round(((p2.orders -p1.orders )/p1.orders )*100) : null;
        return {
          period1: { dates: `${input.period1_start} to ${input.period1_end}`, ...p1 },
          period2: { dates: `${input.period2_start} to ${input.period2_end}`, ...p2 },
          revenue_change_pct: revGrowth,
          orders_change_pct:  ordGrowth,
        };
      }

      case 'get_procurement': {
        const limit = Math.min(input.limit||20, 100);
        let q = supabase.from('procurements').select('date,material_type,vendor,ordered_qty,received_qty,price_per_kg,gst,total_cost,notes').order('date', { ascending: false }).limit(limit);
        if (input.material)   q = q.ilike('material_type', `%${input.material}%`);
        if (input.start_date) q = q.gte('date', input.start_date);
        if (input.end_date)   q = q.lte('date', input.end_date);
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { procurements: data, count: data.length };
      }

      case 'get_vendors': {
        let q = supabase.from('vendors').select('display_name,company_name,mobile,email,city,state,gstin').eq('active', true).order('display_name');
        if (input.search) q = q.or(`display_name.ilike.%${input.search}%,company_name.ilike.%${input.search}%`);
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { vendors: data, count: data.length };
      }

      case 'get_customers': {
        const limit = Math.min(input.limit||20, 100);
        let q = supabase.from('customers').select('name,email,phone,city,state,created_at').order('created_at', { ascending: false }).limit(limit);
        if (input.search) q = q.or(`name.ilike.%${input.search}%,phone.ilike.%${input.search}%,email.ilike.%${input.search}%`);
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { customers: data, count: data.length };
      }

      case 'get_products': {
        let q = supabase.from('products').select('name,cat,unit,price,website_price,retail_price,active,featured');
        if (input.active_only !== false) q = q.eq('active', true);
        if (input.category) q = q.ilike('cat', `%${input.category}%`);
        if (input.search)   q = q.ilike('name', `%${input.search}%`);
        q = q.order('name');
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { products: data, count: data.length };
      }

      case 'update_order_status': {
        const update = { status: input.status };
        if (input.notes) update.notes = input.notes;
        const { error } = await supabase.from('sales').update(update).eq('order_no', input.order_no);
        await supabase.from('webstore_orders').update({ status: input.status }).eq('order_no', input.order_no);
        if (error) return { error: error.message };
        return { success: true, order_no: input.order_no, new_status: input.status };
      }

      case 'add_stock': {
        const { data: products } = await supabase.from('products').select('id,name').ilike('name', `%${input.product_name}%`).eq('active', true);
        if (!products || products.length === 0) return { error: `No product found matching "${input.product_name}"` };
        if (products.length > 1) return { error: `Multiple matches, be more specific: ${products.map(p=>p.name).join(', ')}` };
        const { error } = await supabase.from('stock_ledger').insert({ product_id: products[0].id, type:'in', qty: input.qty, date: new Date().toISOString().slice(0,10), notes: input.notes||'Added via AI assistant' });
        if (error) return { error: error.message };
        return { success: true, product: products[0].name, qty_added: input.qty };
      }

      case 'update_product_price': {
        const { data: products } = await supabase.from('products').select('id,name,price,website_price').ilike('name', `%${input.product_name}%`).eq('active', true);
        if (!products || products.length === 0) return { error: `No product found matching "${input.product_name}"` };
        if (products.length > 1) return { error: `Multiple matches: ${products.map(p=>p.name).join(', ')}` };
        const updates = {};
        if (input.website_price != null) updates.website_price = input.website_price;
        if (input.factory_price != null) updates.price = input.factory_price;
        const { error } = await supabase.from('products').update(updates).eq('id', products[0].id);
        if (error) return { error: error.message };
        return { success: true, product: products[0].name, updated: updates };
      }

      case 'toggle_website_product': {
        const { data: products } = await supabase.from('products').select('id,name').ilike('name', `%${input.product_name}%`).eq('active', true);
        if (!products || products.length === 0) return { error: `No product found matching "${input.product_name}"` };
        if (products.length > 1) return { error: `Multiple matches: ${products.map(p=>p.name).join(', ')}` };
        const productId = products[0].id;
        // Update website_enabled_products in settings
        const { data: setting } = await supabase.from('settings').select('value').eq('key','website_enabled_products').single();
        let enabled = Array.isArray(setting?.value) ? [...setting.value] : [];
        if (input.enabled) {
          if (!enabled.includes(productId)) enabled.push(productId);
        } else {
          enabled = enabled.filter(id => id !== productId);
        }
        await supabase.from('settings').upsert({ key:'website_enabled_products', value: enabled, updated_at: new Date() });
        return { success: true, product: products[0].name, enabled: input.enabled };
      }

      case 'create_sale': {
        const orderNo = 'SALE-' + Date.now();
        const total = input.items.reduce((s,i) => s + (i.qty * i.rate), 0);
        const { data: sale, error: sErr } = await supabase.from('sales').insert({
          order_no:       orderNo,
          date:           new Date().toISOString().slice(0,10),
          channel:        input.channel || 'retail',
          status:         'confirmed',
          customer_name:  input.customer_name,
          customer_phone: input.customer_phone || '',
          total_amount:   total,
          discount:       0,
          final_amount:   total,
          amount_paid:    total,
          payment_method: input.payment_method,
          notes:          input.notes || 'Created via AI assistant',
        }).select().single();
        if (sErr) return { error: sErr.message };
        // Insert items
        const itemRows = input.items.map(i => ({
          sale_id:      sale.id,
          product_name: i.product_name,
          qty:          i.qty,
          rate:         i.rate,
          total:        i.qty * i.rate,
          unit:         'pcs',
        }));
        await supabase.from('sale_items').insert(itemRows);
        return { success: true, order_no: orderNo, total, items_count: input.items.length };
      }

      case 'send_whatsapp': {
        const phoneId  = process.env.WA_PHONE_NUMBER_ID;
        const token    = process.env.WA_ACCESS_TOKEN;
        if (!phoneId || !token) return { error: 'WhatsApp not configured (WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN missing)' };
        const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product:'whatsapp', to: input.phone, type:'text', text:{ body: input.message } }),
        });
        if (!res.ok) { const e = await res.text(); return { error: 'WhatsApp API error: ' + e }; }
        return { success: true, sent_to: input.phone };
      }

      case 'get_business_summary': {
        const today = new Date().toISOString().slice(0,10);
        const monthStart = today.slice(0,7) + '-01';
        const [ordersRes, stockRes, monthRes, pendingRes] = await Promise.all([
          supabase.from('sales').select('order_no,customer_name,final_amount,status,channel').eq('date', today),
          supabase.from('stock_ledger').select('product_id,type,qty'),
          supabase.from('sales').select('final_amount').gte('date', monthStart).lte('date', today),
          supabase.from('sales').select('order_no,customer_name,final_amount').eq('status','pending').order('date', { ascending: false }).limit(5),
        ]);
        const todayOrders   = ordersRes.data || [];
        const todayRevenue  = todayOrders.reduce((s,r) => s+(r.final_amount||0), 0);
        const monthRevenue  = (monthRes.data||[]).reduce((s,r) => s+(r.final_amount||0), 0);
        // Compute stock
        const { data: products } = await supabase.from('products').select('id,name').eq('active',true);
        const stock = {};
        for (const row of stockRes.data||[]) {
          if (!stock[row.product_id]) stock[row.product_id] = 0;
          stock[row.product_id] += row.type==='in' ? (+row.qty||0) : -(+row.qty||0);
        }
        const lowStock = (products||[]).filter(p => (stock[p.id]||0) < 5).map(p => p.name);
        return {
          today: { date: today, orders: todayOrders.length, revenue: Math.round(todayRevenue) },
          month_revenue: Math.round(monthRevenue),
          pending_orders: pendingRes.data || [],
          low_stock_products: lowStock,
          low_stock_count: lowStock.length,
        };
      }

      case 'get_margin_analysis': {
        let q = supabase.from('products').select('name,cat,unit,price,website_price,retail_price,label_cost,web_profit_pct,retail_profit_pct,pack_size,pack_unit').eq('active',true);
        if (input.category)     q = q.ilike('cat', `%${input.category}%`);
        if (input.product_name) q = q.ilike('name', `%${input.product_name}%`);
        const { data, error } = await q.order('name');
        if (error) return { error: error.message };
        const result = (data||[]).map(p => {
          const sellPrice  = p.website_price || p.price || 0;
          const labelCost  = p.label_cost || 0;
          const profitPct  = p.web_profit_pct || p.retail_profit_pct || 0;
          // Estimated cost = sellPrice / (1 + profitPct/100) if profit pct known
          const estCost    = profitPct > 0 ? Math.round(sellPrice / (1 + profitPct/100)) : null;
          const margin     = estCost ? Math.round(sellPrice - estCost) : null;
          const marginPct  = profitPct || null;
          return { name:p.name, category:p.cat, website_price:sellPrice, estimated_cost:estCost, margin, margin_pct:marginPct, label_cost:labelCost };
        }).filter(p => p.website_price > 0);
        const sortBy = input.sort_by || 'margin_pct';
        result.sort((a,b) => sortBy==='name' ? a.name.localeCompare(b.name) : (b[sortBy]||0)-(a[sortBy]||0));
        return { products: result, count: result.length };
      }

      case 'get_customer_history': {
        const term = input.customer;
        const { data: sales, error } = await supabase.from('sales')
          .select('id,order_no,date,channel,status,final_amount,payment_method,notes')
          .or(`customer_name.ilike.%${term}%,customer_phone.ilike.%${term}%`)
          .order('date', { ascending: false });
        if (error) return { error: error.message };
        if (!sales || sales.length === 0) return { message: `No orders found for "${term}"` };
        const saleIds = sales.map(s => s.id);
        const { data: items } = await supabase.from('sale_items').select('sale_id,product_name,qty,rate,total').in('sale_id', saleIds);
        const itemsBySale = {};
        for (const item of items||[]) {
          if (!itemsBySale[item.sale_id]) itemsBySale[item.sale_id] = [];
          itemsBySale[item.sale_id].push(item);
        }
        const totalSpent = sales.reduce((s,r) => s+(r.final_amount||0), 0);
        return {
          customer: term,
          order_count: sales.length,
          total_spent: Math.round(totalSpent),
          orders: sales.map(s => ({ ...s, items: itemsBySale[s.id] || [] })),
        };
      }

      case 'get_reorder_suggestions': {
        const { data: products } = await supabase.from('products').select('id,name,cat,unit').eq('active',true);
        const stock = await getStockMap();
        // Get sales in last 30 days for velocity
        const thirtyDaysAgo = new Date(Date.now()-30*24*60*60*1000).toISOString().slice(0,10);
        const { data: recentSales } = await supabase.from('sales').select('id').gte('date', thirtyDaysAgo);
        const recentIds = (recentSales||[]).map(s=>s.id);
        let velocity = {};
        if (recentIds.length > 0) {
          const { data: items } = await supabase.from('sale_items').select('product_name,qty').in('sale_id', recentIds);
          for (const i of items||[]) { velocity[i.product_name] = (velocity[i.product_name]||0) + (i.qty||0); }
        }
        const suggestions = (products||[])
          .map(p => ({ name:p.name, cat:p.cat, unit:p.unit, stock: stock[p.id]||0, sold_last_30d: velocity[p.name]||0 }))
          .filter(p => p.stock < 20 && p.sold_last_30d > 0)
          .sort((a,b) => (b.sold_last_30d/Math.max(1,b.stock)) - (a.sold_last_30d/Math.max(1,a.stock)));
        return { suggestions, count: suggestions.length };
      }

      case 'get_production_batches': {
        const limit = Math.min(input.limit||20, 100);
        let q = supabase.from('batches').select('date,oil_type,input_kg,oil_output,cake_output,raw_price_per_kg,notes,logged_by').order('date', { ascending: false }).limit(limit);
        if (input.oil_type)   q = q.ilike('oil_type', `%${input.oil_type}%`);
        if (input.start_date) q = q.gte('date', input.start_date);
        if (input.end_date)   q = q.lte('date', input.end_date);
        const { data, error } = await q;
        if (error) return { error: error.message };
        const result = (data||[]).map(b => ({
          ...b,
          yield_pct: b.input_kg > 0 ? Math.round((b.oil_output/b.input_kg)*100*10)/10 : null,
        }));
        const totalInput  = result.reduce((s,b) => s+(b.input_kg||0), 0);
        const totalOutput = result.reduce((s,b) => s+(b.oil_output||0), 0);
        return { batches: result, count: result.length, total_input_kg: Math.round(totalInput), total_oil_output: Math.round(totalOutput) };
      }

      case 'get_anomaly_report': {
        const today = new Date().toISOString().slice(0,10);
        const d7 = new Date(Date.now()-7*24*60*60*1000).toISOString().slice(0,10);
        const d14 = new Date(Date.now()-14*24*60*60*1000).toISOString().slice(0,10);
        const [thisWeek, lastWeek] = await Promise.all([
          supabase.from('sales').select('final_amount,channel').gte('date',d7).lte('date',today),
          supabase.from('sales').select('final_amount,channel').gte('date',d14).lt('date',d7),
        ]);
        const tw = thisWeek.data||[], lw = lastWeek.data||[];
        const twRev = tw.reduce((s,r) => s+(r.final_amount||0), 0);
        const lwRev = lw.reduce((s,r) => s+(r.final_amount||0), 0);
        const revChange = lwRev > 0 ? Math.round(((twRev-lwRev)/lwRev)*100) : null;
        const ordChange = lw.length > 0 ? Math.round(((tw.length-lw.length)/lw.length)*100) : null;
        const alerts = [];
        if (revChange !== null && Math.abs(revChange) >= 20) alerts.push(`Revenue ${revChange>0?'up':'down'} ${Math.abs(revChange)}% vs last week`);
        if (ordChange !== null && Math.abs(ordChange) >= 20) alerts.push(`Orders ${ordChange>0?'up':'down'} ${Math.abs(ordChange)}% vs last week`);
        if (alerts.length === 0) alerts.push('No significant anomalies detected');
        return { this_week: { orders:tw.length, revenue:Math.round(twRev) }, last_week: { orders:lw.length, revenue:Math.round(lwRev) }, revenue_change_pct:revChange, orders_change_pct:ordChange, alerts };
      }

      case 'get_set_sales_target': {
        const month = input.month || new Date().toISOString().slice(0,7);
        const key   = `sales_target_${month}`;
        if (input.action === 'set') {
          await supabase.from('settings').upsert({ key, value: input.target, updated_at: new Date() });
          return { success:true, month, target: input.target };
        }
        // get target + actual
        const { data: setting } = await supabase.from('settings').select('value').eq('key', key).single();
        const target = setting?.value || null;
        const monthStart = month + '-01';
        const monthEnd   = month + '-31';
        const { data: sales } = await supabase.from('sales').select('final_amount').gte('date', monthStart).lte('date', monthEnd);
        const actual = (sales||[]).reduce((s,r) => s+(r.final_amount||0), 0);
        const progress = target ? Math.round((actual/target)*100) : null;
        return { month, target, actual: Math.round(actual), progress_pct: progress };
      }

      case 'send_email': {
        if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return { error: 'Email not configured (SMTP_USER / SMTP_PASS missing in .env)' };
        try {
          await mailer.sendMail({
            from: process.env.SMTP_FROM || 'Sathvam <noreply@sathvam.in>',
            to:   input.to,
            subject: input.subject,
            html: input.body.includes('<') ? input.body : `<pre style="font-family:sans-serif;white-space:pre-wrap">${input.body}</pre>`,
          });
          return { success:true, sent_to: input.to };
        } catch(e) { return { error: 'Email send failed: ' + e.message }; }
      }

      case 'bulk_update_prices': {
        let q = supabase.from('products').select('id,name,cat,price,website_price').eq('active',true);
        if (input.category)     q = q.ilike('cat', `%${input.category}%`);
        if (input.name_pattern) q = q.ilike('name', `%${input.name_pattern}%`);
        const { data: products, error } = await q;
        if (error) return { error: error.message };
        if (!products || products.length === 0) return { error: 'No products found matching criteria' };
        const pct    = input.change_pct / 100;
        const field  = input.price_field || 'website_price';
        let updated  = 0;
        for (const p of products) {
          const updates = {};
          if (field === 'website_price' || field === 'both') {
            const cur = p.website_price || p.price;
            if (cur) updates.website_price = Math.round(cur * (1 + pct));
          }
          if (field === 'price' || field === 'both') {
            if (p.price) updates.price = Math.round(p.price * (1 + pct));
          }
          if (Object.keys(updates).length > 0) {
            await supabase.from('products').update(updates).eq('id', p.id);
            updated++;
          }
        }
        return { success:true, updated, change_pct: input.change_pct, category: input.category || input.name_pattern };
      }

      case 'bulk_toggle_website': {
        const { data: products } = await supabase.from('products').select('id,name,cat').eq('active',true).ilike('cat', `%${input.category}%`);
        if (!products || products.length === 0) return { error: `No products found in category "${input.category}"` };
        const { data: setting } = await supabase.from('settings').select('value').eq('key','website_enabled_products').single();
        let enabled = Array.isArray(setting?.value) ? [...setting.value] : [];
        const ids = products.map(p => p.id);
        if (input.enabled) {
          for (const id of ids) if (!enabled.includes(id)) enabled.push(id);
        } else {
          enabled = enabled.filter(id => !ids.includes(id));
        }
        await supabase.from('settings').upsert({ key:'website_enabled_products', value:enabled, updated_at:new Date() });
        return { success:true, category: input.category, enabled: input.enabled, products_affected: products.length, product_names: products.map(p=>p.name) };
      }

      case 'update_b2b_order': {
        const { data: orders } = await supabase.from('b2b_orders').select('id,order_no,stage').ilike('order_no', `%${input.order_no}%`);
        if (!orders || orders.length === 0) return { error: `B2B order "${input.order_no}" not found` };
        const order = orders[0];
        const updates = {};
        if (input.stage)        updates.stage        = input.stage;
        if (input.bl_no)        updates.bl_no        = input.bl_no;
        if (input.container_no) updates.container_no = input.container_no;
        if (input.etd)          updates.etd          = input.etd;
        if (input.eta)          updates.eta          = input.eta;
        if (input.notes)        updates.notes        = input.notes;
        const { error } = await supabase.from('b2b_orders').update(updates).eq('id', order.id);
        if (error) return { error: error.message };
        // Log stage change
        if (input.stage) {
          await supabase.from('b2b_order_stages').insert({ order_id: order.id, stage: input.stage, date: new Date().toISOString().slice(0,10), note: input.notes || `Stage updated to ${input.stage}`, updated_by: 'AI Assistant' });
        }
        return { success:true, order_no: order.order_no, updated: updates };
      }

      case 'get_expense_summary': {
        const today      = new Date().toISOString().slice(0,10);
        const monthStart = today.slice(0,7) + '-01';
        const start = input.start_date || monthStart;
        const end   = input.end_date   || today;

        let q = supabase.from('company_expenses').select('*').gte('date', start).lte('date', end).is('deleted_at', null);
        if (input.category) q = q.eq('category', input.category);
        const { data: rows } = await q;
        const expenses = rows || [];
        const total = expenses.reduce((s,r) => s + parseFloat(r.amount||0), 0);

        const byCat = {}, byDate = {}, byPM = {}, byVendor = {};
        for (const r of expenses) {
          byCat[r.category] = (byCat[r.category]||0) + parseFloat(r.amount||0);
          byDate[r.date]    = (byDate[r.date]||0)    + parseFloat(r.amount||0);
          const pm = r.payment_mode||'cash';
          byPM[pm]          = (byPM[pm]||0)          + parseFloat(r.amount||0);
          if (r.vendor_name?.trim()) byVendor[r.vendor_name] = (byVendor[r.vendor_name]||0) + parseFloat(r.amount||0);
        }

        const daysWithData = Object.keys(byDate).length;
        const totalDays    = Math.round((new Date(end) - new Date(start)) / (1000*60*60*24)) + 1;
        const highestDay   = Object.entries(byDate).sort((a,b) => b[1]-a[1])[0];

        // Opening balance for today (if range includes today)
        let openingBalance = null;
        if (end === today) {
          const { data: ob } = await supabase.from('expense_opening_balance').select('*').eq('date', today).maybeSingle();
          openingBalance = ob ? parseFloat(ob.opening_balance||0) : 0;
        }

        return {
          period: `${start} to ${end}`,
          total_spent:    Math.round(total*100)/100,
          entry_count:    expenses.length,
          days_with_data: daysWithData,
          total_days:     totalDays,
          avg_per_day:    daysWithData > 0 ? Math.round((total/daysWithData)*100)/100 : 0,
          highest_day:    highestDay ? { date:highestDay[0], amount:Math.round(highestDay[1]*100)/100 } : null,
          opening_balance: openingBalance,
          closing_balance: openingBalance !== null ? Math.round((openingBalance - total)*100)/100 : null,
          by_category:    Object.entries(byCat).map(([k,v])=>({ category:k, amount:Math.round(v*100)/100, pct: total>0?Math.round((v/total)*1000)/10:0 })).sort((a,b)=>b.amount-a.amount),
          by_payment_mode:Object.entries(byPM).map(([k,v])=>({ mode:k, amount:Math.round(v*100)/100 })).sort((a,b)=>b.amount-a.amount),
          top_vendors:    Object.entries(byVendor).map(([k,v])=>({ vendor:k, amount:Math.round(v*100)/100 })).sort((a,b)=>b.amount-a.amount).slice(0,5),
          daily_trend:    Object.entries(byDate).map(([d,v])=>({ date:d, amount:Math.round(v*100)/100 })).sort((a,b)=>a.date.localeCompare(b.date)),
        };
      }

      case 'get_expense_details': {
        const today = new Date().toISOString().slice(0,10);
        const start = input.start_date || today;
        const end   = input.end_date   || today;
        let q = supabase.from('company_expenses').select('date,category,description,amount,payment_mode,vendor_name,reference_no,notes,created_by')
          .gte('date', start).lte('date', end).is('deleted_at', null).order('date').order('created_at');
        if (input.category)     q = q.eq('category', input.category);
        if (input.payment_mode) q = q.eq('payment_mode', input.payment_mode);
        const { data: rows } = await q;
        const expenses = rows || [];
        const total = expenses.reduce((s,r) => s + parseFloat(r.amount||0), 0);
        return { period:`${start} to ${end}`, total:Math.round(total*100)/100, count:expenses.length, expenses };
      }

      case 'get_expense_vs_revenue': {
        const today      = new Date().toISOString().slice(0,10);
        const monthStart = today.slice(0,7) + '-01';
        const start = input.start_date || monthStart;
        const end   = input.end_date   || today;

        const [{ data: sales }, { data: expRows }] = await Promise.all([
          supabase.from('sales').select('final_amount,status').gte('date', start).lte('date', end),
          supabase.from('company_expenses').select('amount').gte('date', start).lte('date', end).is('deleted_at', null),
        ]);

        const revenue  = (sales||[]).filter(s=>s.status!=='cancelled').reduce((s,r) => s + parseFloat(r.final_amount||0), 0);
        const expenses = (expRows||[]).reduce((s,r) => s + parseFloat(r.amount||0), 0);
        const profit   = revenue - expenses;
        const expenseRatio = revenue > 0 ? Math.round((expenses/revenue)*1000)/10 : 0;

        return {
          period:         `${start} to ${end}`,
          total_revenue:  Math.round(revenue*100)/100,
          total_expenses: Math.round(expenses*100)/100,
          net_profit:     Math.round(profit*100)/100,
          expense_ratio:  `${expenseRatio}%`,
          status:         profit >= 0 ? 'profitable' : 'loss',
        };
      }

      case 'get_opening_balance': {
        const date = input.date || new Date().toISOString().slice(0,10);
        if (input.action === 'set') {
          const { data, error } = await supabase.from('expense_opening_balance').upsert({
            date, opening_balance: parseFloat(input.opening_balance)||0,
            updated_at: new Date().toISOString(),
          }, { onConflict:'date' }).select().single();
          if (error) return { error: error.message };
          return { success:true, date, opening_balance: data.opening_balance };
        }
        const { data } = await supabase.from('expense_opening_balance').select('*').eq('date', date).maybeSingle();
        const { data: dayExp } = await supabase.from('company_expenses').select('amount').eq('date', date).is('deleted_at', null);
        const totalSpent = (dayExp||[]).reduce((s,r) => s + parseFloat(r.amount||0), 0);
        const ob = parseFloat(data?.opening_balance||0);
        return { date, opening_balance:ob, total_spent:Math.round(totalSpent*100)/100, closing_balance:Math.round((ob-totalSpent)*100)/100 };
      }

      case 'check_daily_tasks': {
        const tasks = await checkDailyTasks();
        const pending = [];
        if (!tasks.expenses_logged)   pending.push('Daily expenses not logged');
        if (!tasks.batch_logged)      pending.push('Production batch not logged');
        if (!tasks.attendance_marked) pending.push('Attendance not marked');
        return {
          date:              tasks.date,
          expenses_logged:   tasks.expenses_logged,
          batch_logged:      tasks.batch_logged,
          attendance_marked: tasks.attendance_marked,
          all_complete:      pending.length === 0,
          pending_tasks:     pending,
          summary:           pending.length === 0
            ? 'All daily tasks are up to date.'
            : `${pending.length} task(s) pending: ${pending.join(', ')}`,
        };
      }

      case 'send_manager_reminder': {
        const pending = input.pending_tasks || [];
        if (pending.length === 0) return { error: 'pending_tasks array is required and must not be empty' };
        await sendReminders(pending, input.label || 'AI Reminder');
        // Count how many contacts notified
        const { data: contacts } = await supabase.from('users').select('name,email,phone,role').in('role',['admin','manager']).eq('active',true);
        const notified = (contacts||[]).filter(u => u.email || u.phone).map(u => u.name || u.email);
        return {
          success:       true,
          notified:      notified,
          message_count: notified.length,
          tasks_sent:    pending,
          note:          `Reminder sent to ${notified.length} manager(s) via email and WhatsApp`,
        };
      }

      case 'get_customer_issues': {
        const status = input.status || 'open';
        const limit  = input.limit  || 10;
        let q = supabase.from('chat_sessions').select('id,lead_name,lead_phone,has_issue,issue_type,status,created_at,updated_at').order('updated_at', { ascending: false }).limit(limit);
        if (status !== 'all') q = q.eq('status', status);
        const { data, error } = await q;
        if (error) return { error: error.message };
        const issues  = (data || []).filter(s => s.has_issue);
        const regular = (data || []).filter(s => !s.has_issue);
        return {
          total_sessions: (data||[]).length,
          flagged_issues: issues.length,
          issues: issues.map(s => ({ name: s.lead_name||'Anonymous', phone: s.lead_phone||'—', issue: s.issue_type||'unknown', status: s.status, time: s.updated_at?.slice(0,16) })),
          other_chats: regular.length,
          summary: issues.length > 0
            ? `${issues.length} customer(s) reported issues: ${issues.map(s=>`${s.lead_name||'Anonymous'} (${s.issue_type||'problem'})`).join(', ')}`
            : 'No flagged issues. All chats look normal.',
        };
      }

      case 'get_operations_status': {
        const today = new Date().toISOString().slice(0,10);
        const [
          { data: tasks },
          { data: leaves },
          { data: returns },
          { data: qTests },
          { data: compliance },
          { data: deliveries },
          { data: reviews },
        ] = await Promise.all([
          supabase.from('staff_tasks').select('id,title,status,priority,due_date,assigned_name').neq('status','done'),
          supabase.from('leave_requests').select('id,employee_name,leave_type,from_date,to_date,days,status').eq('status','pending'),
          supabase.from('return_requests').select('id,customer_name,refund_amount,status,created_at').eq('status','pending'),
          supabase.from('quality_tests').select('id,product_name,result,tested_at').in('result',['fail','hold']).gte('tested_at', new Date(Date.now()-7*86400000).toISOString()),
          supabase.from('compliance_documents').select('id,title,category,expiry_date,status').in('status',['expired','expiring_soon']),
          supabase.from('delivery_runs').select('id,delivery_date,driver_name,total_orders,status').in('status',['pending','in_transit']),
          supabase.from('product_reviews').select('id,reviewer_name,product_name,rating,created_at').eq('status','pending'),
        ]);

        const overdueTasks  = (tasks||[]).filter(t=>t.due_date&&t.due_date<today);
        const highPriority  = (tasks||[]).filter(t=>t.priority==='high');
        const alerts = [];
        if (overdueTasks.length)       alerts.push(`${overdueTasks.length} overdue task(s)`);
        if (highPriority.length)       alerts.push(`${highPriority.length} high-priority task(s) open`);
        if ((leaves||[]).length)       alerts.push(`${leaves.length} leave request(s) pending approval`);
        if ((returns||[]).length)      alerts.push(`${returns.length} return/refund request(s) pending`);
        if ((qTests||[]).length)       alerts.push(`${qTests.length} quality fail/hold in the last 7 days`);
        if ((compliance||[]).filter(c=>c.status==='expired').length) alerts.push(`${(compliance||[]).filter(c=>c.status==='expired').length} compliance document(s) EXPIRED`);
        if ((compliance||[]).filter(c=>c.status==='expiring_soon').length) alerts.push(`${(compliance||[]).filter(c=>c.status==='expiring_soon').length} compliance document(s) expiring soon`);
        if ((deliveries||[]).length)   alerts.push(`${deliveries.length} delivery run(s) in progress`);
        if ((reviews||[]).length)      alerts.push(`${reviews.length} product review(s) awaiting approval`);

        return {
          alerts,
          alert_count:       alerts.length,
          overdue_tasks:     overdueTasks.map(t=>({ id:t.id, title:t.title, due:t.due_date, assigned:t.assigned_name, priority:t.priority })),
          open_tasks:        (tasks||[]).length,
          pending_leaves:    leaves||[],
          pending_returns:   (returns||[]).map(r=>({ id:r.id, customer:r.customer_name, amount:r.refund_amount, created:r.created_at?.slice(0,10) })),
          quality_issues:    (qTests||[]).map(q=>({ product:q.product_name, result:q.result, date:q.tested_at?.slice(0,10) })),
          compliance_alerts: compliance||[],
          active_deliveries: deliveries||[],
          pending_reviews:   (reviews||[]).length,
          summary: alerts.length===0 ? 'All operations are clear. No pending alerts.' : `${alerts.length} item(s) need attention: ${alerts.join(', ')}.`,
        };
      }

      case 'get_staff_tasks': {
        const status = input.status || 'open';
        let q = supabase.from('staff_tasks').select('id,title,description,assigned_name,due_date,priority,category,status,created_at').order('due_date',{ascending:true}).limit(50);
        if (status === 'open') { q = q.neq('status','done'); }
        else if (status !== 'all') { q = q.eq('status', status); }
        if (input.assigned_to) q = q.ilike('assigned_name', `%${input.assigned_to}%`);
        if (input.priority)    q = q.eq('priority', input.priority);
        const { data, error } = await q;
        if (error) return { error: error.message };
        const today = new Date().toISOString().slice(0,10);
        const tasks = (data||[]).map(t=>({ ...t, overdue: t.status!=='done'&&t.due_date&&t.due_date<today }));
        return { tasks, count:tasks.length, overdue_count: tasks.filter(t=>t.overdue).length };
      }

      case 'create_staff_task': {
        const { data, error } = await supabase.from('staff_tasks').insert({
          title:         input.title,
          description:   input.description || '',
          assigned_name: input.assigned_name || '',
          due_date:      input.due_date || null,
          priority:      input.priority || 'medium',
          category:      input.category || 'general',
          status:        'todo',
        }).select().single();
        if (error) return { error: error.message };
        return { success:true, task: data, message: `Task "${input.title}" created${input.assigned_name?` and assigned to ${input.assigned_name}`:''}${input.due_date?`, due ${input.due_date}`:''}` };
      }

      case 'get_leave_requests': {
        const status = input.status || 'pending';
        let q = supabase.from('leave_requests').select('*').order('created_at',{ascending:false}).limit(input.limit||20);
        if (status !== 'all') q = q.eq('status', status);
        const { data, error } = await q;
        if (error) return { error: error.message };
        return { requests: data||[], count:(data||[]).length, pending_count:(data||[]).filter(r=>r.status==='pending').length };
      }

      case 'approve_leave': {
        const { data, error } = await supabase.from('leave_requests').update({ status:input.action, notes:input.notes||'', updated_at:new Date().toISOString() }).eq('id', input.leave_id).select().single();
        if (error) return { error: error.message };
        return { success:true, action:input.action, employee:data.employee_name, days:data.days, leave_type:data.leave_type, message:`Leave ${input.action} for ${data.employee_name} (${data.days} day${data.days!==1?'s':''} ${data.leave_type})` };
      }

      case 'get_returns': {
        const status = input.status || 'all';
        let q = supabase.from('return_requests').select('*').order('created_at',{ascending:false}).limit(input.limit||20);
        if (status !== 'all') q = q.eq('status', status);
        const { data, error } = await q;
        if (error) return { error: error.message };
        const totalPending  = (data||[]).filter(r=>r.status==='pending').length;
        const totalRefunded = (data||[]).filter(r=>r.status==='refunded').reduce((s,r)=>s+(r.refund_amount||0),0);
        return { returns:data||[], count:(data||[]).length, pending_count:totalPending, total_refunded:Math.round(totalRefunded), summary:`${totalPending} pending, ₹${Math.round(totalRefunded).toLocaleString('en-IN')} refunded so far` };
      }

      case 'get_quality_status': {
        let q = supabase.from('quality_tests').select('id,product_name,batch_number,test_type,result,tested_by,notes,tested_at').order('tested_at',{ascending:false}).limit(input.limit||20);
        if (input.result) q = q.eq('result', input.result);
        if (input.product_name) q = q.ilike('product_name', `%${input.product_name}%`);
        const { data, error } = await q;
        const { data: stats } = await supabase.from('quality_tests').select('product_name,result');
        const byProduct = {};
        for (const t of stats||[]) {
          if (!byProduct[t.product_name]) byProduct[t.product_name] = { pass:0, fail:0, hold:0 };
          byProduct[t.product_name][t.result] = (byProduct[t.product_name][t.result]||0)+1;
        }
        const failProducts = Object.entries(byProduct).filter(([,s])=>s.fail>0).map(([p,s])=>({ product:p, fails:s.fail, passes:s.pass, rate:Math.round(s.pass/(s.pass+s.fail+s.hold)*100)+'%' }));
        return { recent_tests:(data||[]), fail_summary:failProducts, total_tests:(stats||[]).length, recent_fails:(data||[]).filter(t=>t.result==='fail').length };
      }

      case 'get_compliance_status': {
        const status = input.status || 'non_valid';
        let q = supabase.from('compliance_documents').select('*').order('expiry_date',{ascending:true});
        if (status === 'non_valid') { q = q.in('status',['expired','expiring_soon']); }
        else if (status !== 'all') { q = q.eq('status', status); }
        const { data, error } = await q;
        if (error) return { error: error.message };
        const expired  = (data||[]).filter(d=>d.status==='expired');
        const expiring = (data||[]).filter(d=>d.status==='expiring_soon');
        const summary = expired.length===0&&expiring.length===0 ? 'All compliance documents are valid.' : `${expired.length} expired, ${expiring.length} expiring soon.`;
        return { documents:data||[], expired_count:expired.length, expiring_soon_count:expiring.length, summary, urgent: expired.map(d=>({ title:d.title, category:d.category, expired_on:d.expiry_date })) };
      }

      case 'get_delivery_status': {
        const status = input.status;
        let q = supabase.from('delivery_runs').select('id,delivery_date,driver_name,driver_phone,vehicle_number,total_orders,status,created_at').order('delivery_date',{ascending:false}).limit(input.limit||10);
        if (status && status !== 'all') q = q.eq('status', status);
        const { data, error } = await q;
        if (error) return { error: error.message };
        const active = (data||[]).filter(d=>['pending','in_transit'].includes(d.status));
        return { runs:data||[], active_count:active.length, active_runs:active, summary: active.length>0 ? `${active.length} delivery run(s) active` : 'No active deliveries' };
      }

      case 'get_demand_forecast': {
        const weeks = input.weeks || 4;
        const limit = input.limit || 10;
        const since = new Date(); since.setDate(since.getDate()-90);
        const [{ data: wsOrders }, { data: b2bOrders }] = await Promise.all([
          supabase.from('webstore_orders').select('items,created_at,status').gte('created_at',since.toISOString()).neq('status','cancelled'),
          supabase.from('b2b_orders').select('items,created_at,status').gte('created_at',since.toISOString()).neq('status','cancelled'),
        ]);
        const salesMap = {}, productNames = {};
        const addItems = (items, createdAt) => {
          for (const item of (items||[])) {
            const id = item.product_id||item.id||item.name; if(!id) continue;
            productNames[id] = item.product_name||item.name||id;
            salesMap[id] = (salesMap[id]||0) + parseFloat(item.quantity||item.qty||0);
          }
        };
        for (const o of wsOrders||[]) addItems(Array.isArray(o.items)?o.items:[], o.created_at);
        for (const o of b2bOrders||[]) addItems(Array.isArray(o.items)?o.items:[], o.created_at);
        const forecasts = Object.entries(salesMap).map(([id,total])=>({
          product: productNames[id], avg_weekly: Math.round(total/13*10)/10, forecast_qty: Math.ceil(total/13*weeks), weeks,
        })).sort((a,b)=>b.forecast_qty-a.forecast_qty).slice(0,limit);
        return { forecasts, forecast_weeks:weeks, top_product: forecasts[0]?.product||'N/A', summary: `Top ${forecasts.length} products forecast for ${weeks} weeks based on 90-day sales` };
      }

      case 'get_reviews_summary': {
        const status = input.status || 'all';
        let q = supabase.from('product_reviews').select('id,product_name,reviewer_name,rating,title,status,created_at').order('created_at',{ascending:false}).limit(input.limit||20);
        if (status !== 'all') q = q.eq('status', status);
        const { data, error } = await q;
        if (error) return { error: error.message };
        const pending  = (data||[]).filter(r=>r.status==='pending').length;
        const approved = (data||[]).filter(r=>r.status==='approved');
        const avgRating = approved.length ? Math.round(approved.reduce((s,r)=>s+r.rating,0)/approved.length*10)/10 : 0;
        return { reviews:data||[], total:(data||[]).length, pending_count:pending, approved_count:approved.length, avg_rating:avgRating, summary:`${pending} pending approval, avg rating ${avgRating}★ from ${approved.length} approved reviews` };
      }

      case 'get_crm_summary': {
        const { data: orders, error } = await supabase.from('webstore_orders').select('customer_name,customer_phone,customer_email,total_amount,status,created_at').neq('status','cancelled');
        if (error) return { error: error.message };
        const map = {};
        for (const o of orders||[]) {
          const key = o.customer_phone||o.customer_email||o.customer_name; if(!key) continue;
          if(!map[key]) map[key]={ name:o.customer_name, phone:o.customer_phone, orders:0, total_spent:0 };
          map[key].orders++; map[key].total_spent+=(o.total_amount||0);
        }
        const customers = Object.values(map).sort((a,b)=>b.total_spent-a.total_spent);
        const top = customers.slice(0, input.limit||10);
        const repeat = customers.filter(c=>c.orders>1).length;
        const totalRevenue = customers.reduce((s,c)=>s+c.total_spent,0);
        return { top_customers:top, total_customers:customers.length, repeat_customers:repeat, total_revenue:Math.round(totalRevenue), avg_ltv: customers.length?Math.round(totalRevenue/customers.length):0, summary:`${customers.length} customers, ${repeat} repeat, ₹${Math.round(totalRevenue/1000)}K total revenue` };
      }

      case 'get_coupon_performance': {
        const { data, error } = await supabase.from('coupons').select('*').order('uses_count',{ascending:false});
        if (error) return { error: error.message };
        const active   = (data||[]).filter(c=>c.active);
        const inactive = (data||[]).filter(c=>!c.active);
        const totalUses = (data||[]).reduce((s,c)=>s+(c.uses_count||0),0);
        return { coupons:data||[], active_count:active.length, inactive_count:inactive.length, total_uses:totalUses, top_coupons:(data||[]).slice(0,5).map(c=>({ code:c.code, type:c.type, value:c.value, uses:c.uses_count })), summary:`${active.length} active coupons, ${totalUses} total uses` };
      }

      case 'write_seo_blog_post': {
        const { keyword, title, category, content } = input;
        if (!content) {
          return { status: 'needs_content', message: `Please write a 600-900 word Markdown article titled "${title}" targeting the keyword "${keyword}". Then call write_seo_blog_post again with the content field filled in.` };
        }
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
        const excerpt = content.replace(/[#*>\n`]/g, ' ').replace(/\s+/g,' ').trim().slice(0, 200);
        const readTime = Math.max(1, Math.ceil(content.split(' ').length / 200));
        const { data, error } = await supabase.from('blog_posts').insert({
          title, slug, excerpt, content,
          keywords: [keyword],
          category: category || 'health',
          author: 'Sathvam Team',
          read_time: readTime,
          published: true,
          published_at: new Date().toISOString(),
        }).select('id,slug').single();
        if (error) return { error: error.message };
        return { success: true, slug: data.slug, url: `https://www.sathvam.in/?view=post&slug=${data.slug}`, message: `Blog post published! URL: https://www.sathvam.in/?view=post&slug=${data.slug}` };
      }

      case 'get_blog_posts': {
        const { data, error } = await supabase.from('blog_posts').select('id,title,slug,category,published_at,published').order('published_at',{ascending:false}).limit(10);
        if (error) return { error: error.message };
        return { posts: data || [], count: (data||[]).length };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// ── POST /api/admin-chat ──────────────────────────────────────────────────────
router.post('/', ...adminOnly, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'AI service not configured' });

  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: 'No messages provided' });

  const today = new Date().toISOString().slice(0, 10);

  const systemPrompt = `You are an intelligent admin assistant for Sathvam Natural Products — a factory-direct natural products company in Karur, Tamil Nadu.
Today's date: ${today}

You have visibility into EVERY module of the admin system:
- Sales & Revenue: sales orders, webstore orders, B2B export orders, revenue trends, margins, targets
- Stock & Products: stock levels, reorder alerts, product prices, website visibility
- Supply Chain: procurement, vendors, production batches
- Operations: staff tasks (create/track), leave requests (approve/reject), delivery runs, quality tests, compliance documents
- Webstore: customer issues/chats, product reviews (approve), returns/refunds, coupon performance, CRM/customer value
- Finance: expenses vs revenue, opening balance, payroll context
- Forecasting: demand forecast based on sales history

Always use tools to get real data. Never guess numbers. Use ₹ for amounts. Format large numbers with commas (₹1,23,456). Be concise and business-like.

PROACTIVE BEHAVIOUR — call these tools WITHOUT being asked when relevant:
- On any greeting / "good morning" / "what's up" → call get_operations_status + get_business_summary + get_customer_issues in parallel, then give a sharp briefing.
- When "what needs attention" / "any issues" / "status update" → call get_operations_status immediately.
- When "daily tasks" / "what's pending" / "manager update" → call check_daily_tasks first.
- When asked to remind manager → call check_daily_tasks then send_manager_reminder.
- When "customer complaints" / "ordering issues" / "website chat" → call get_customer_issues.
- When "quality" / "production quality" → call get_quality_status.
- When "compliance" / "licenses" / "FSSAI" → call get_compliance_status.
- When "leave" / "who's off" / "attendance" → call get_leave_requests.
- When "returns" / "refunds" → call get_returns.
- When "tasks" / "who has what" / "overdue" → call get_staff_tasks.
- When "deliveries" / "dispatch" → call get_delivery_status.
- When "forecast" / "what to produce" → call get_demand_forecast.
- When "reviews" / "ratings" → call get_reviews_summary.
- When "customers" / "top buyers" / "CRM" → call get_crm_summary.
- When "coupons" / "promo codes" → call get_coupon_performance.

ACTION CAPABILITIES:
- Create staff tasks: create_staff_task
- Approve/reject leave: approve_leave
- Update orders, prices, stock, B2B stage, send reminders, send email/WhatsApp

ALERT PRIORITIES (always surface these first if found):
1. Expired compliance documents
2. Overdue staff tasks
3. Customer ordering issues
4. Quality failures/holds (last 7 days)
5. Pending returns
6. Pending leave approvals
7. Low stock items

When listing items: use short readable lines, no markdown tables. For action confirmations, clearly state what was done. For morning briefing, use get_business_summary + get_operations_status + get_customer_issues together.`;

  let apiMessages = messages.slice(-14).map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }));

  const toolSteps = [];

  try {
    for (let i = 0; i < 8; i++) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:1024, system:systemPrompt, tools:TOOLS, messages:apiMessages }),
      });
      if (!response.ok) { const err = await response.text(); console.error('Admin chat error:', err); return res.status(502).json({ error: 'AI service error' }); }
      const data = await response.json();

      if (data.stop_reason === 'tool_use') {
        apiMessages.push({ role:'assistant', content: data.content });
        const toolResults = [];
        for (const block of data.content) {
          if (block.type !== 'tool_use') continue;
          const result = await executeTool(block.name, block.input);
          toolSteps.push({ tool: block.name, input: block.input, result });
          toolResults.push({ type:'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
        }
        apiMessages.push({ role:'user', content: toolResults });
        continue;
      }

      const reply = data.content?.find(b => b.type==='text')?.text ?? 'Done.';
      return res.json({ reply, toolSteps });
    }
    return res.json({ reply: 'Reached maximum reasoning depth.', toolSteps });
  } catch (err) {
    console.error('Admin chat error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET /api/admin-chat/briefing — auto morning summary ──────────────────────
router.get('/briefing', ...adminOnly, async (req, res) => {
  const [summary, expenses, customerIssues, operations] = await Promise.all([
    executeTool('get_business_summary', {}),
    executeTool('get_expense_summary', {}),
    executeTool('get_customer_issues', { status: 'open', limit: 10 }),
    executeTool('get_operations_status', {}),
  ]);
  res.json({ ...summary, expenses, customerIssues, operations });
});

module.exports = router;
module.exports.executeTool = executeTool;
module.exports.TOOLS = TOOLS;
