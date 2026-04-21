require('dotenv').config();

// ── Startup: fail fast on missing/default secrets ─────────────────────────────
['JWT_SECRET','MAGIC_LINK_SECRET'].forEach(k => {
  if (!process.env[k]) { console.error(`FATAL: ${k} env var is not set`); process.exit(1); }
});

const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');
const cookieParser= require('cookie-parser');
const compression = require('compression');

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(compression());

// CORS — Capacitor Android apps use capacitor://localhost and http://localhost
const allowedOrigins = [
  'https://admin.sathvam.in',
  'https://sathvam.in',
  'https://www.sathvam.in',
  'https://store.sathvam.in',
  'capacitor://localhost',   // Capacitor Android/iOS store app
  'http://localhost',        // Capacitor fallback origin
  ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:5173', 'http://localhost:3000'] : []),
];
app.use(cors({ origin: allowedOrigins, credentials: true }));

const rateLimitOpts = { validate: { xForwardedForHeader: false } };

// General rate limit — 1200 req/15min per IP (admin panel has polling + bulk init calls)
app.use(rateLimit({ windowMs: 15*60*1000, max: 1200, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests, please try again later' }, ...rateLimitOpts }));

// Auth limiter — 10 attempts/15min per IP (brute force protection)
const authLimiter = rateLimit({
  windowMs: 15*60*1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again in 15 minutes' },
  ...rateLimitOpts,
});

// Public API limiter — 120 req/min per IP (prevents scraping / DoS)
const publicLimiter = rateLimit({
  windowMs: 60*1000, max: 120,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests' },
  ...rateLimitOpts,
});

// Payments limiter — 20 req/min per IP
const paymentsLimiter = rateLimit({
  windowMs: 60*1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many payment requests' },
  ...rateLimitOpts,
});

// Signup limiter — 5 signups/hour per IP (prevents mass account creation)
const signupLimiter = rateLimit({
  windowMs: 60*60*1000, max: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many signup attempts. Please try again in an hour.' },
  ...rateLimitOpts,
});

// Referral validate limiter — 10 attempts/hour (prevents brute-force code guessing)
const referralLimiter = rateLimit({
  windowMs: 60*60*1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many referral attempts. Please try again later.' },
  ...rateLimitOpts,
});

app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('combined'));

const { products, procurement, vendors, sales, settings, users } = require('./routes/core');
const { b2bCustomers, b2bOrders, projects, b2bItemProgress, b2bStatement, b2bStock, b2bCustomPrices, b2bQuotes, b2bDocs, b2bSamples, b2bMessages, b2bAnalytics, b2bProfile, b2bNotifications } = require('./routes/b2b');
const b2bAuth = require('./routes/b2bAuth');
const purchases = require('./routes/purchases');
const flourBatches = require('./routes/flourBatches');
const webstoreOrders = require('./routes/webstoreOrders');

app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.2.0', time: new Date().toISOString() }));
app.use('/api/public', publicLimiter, require('./routes/public'));
app.use('/api/auth',          authLimiter, require('./routes/auth'));
app.use('/api/batches',       require('./routes/batches'));
app.use('/api/products',      products);
app.use('/api/procurement',   procurement);
app.use('/api/vendors',       vendors);
app.use('/api/sales',         sales);
app.use('/api/settings',      settings);
app.use('/api/users',         users);
app.use('/api/purchases',     purchases);
app.use('/api/flour-batches', flourBatches);
app.use('/api/webstore-orders', webstoreOrders);
app.use('/api/customer/signup',             signupLimiter);
app.use('/api/customer/login',             authLimiter);
app.use('/api/customer/referral/validate', referralLimiter);
app.use('/api/customer',                   require('./routes/customer'));
app.use('/api/payments',      paymentsLimiter, require('./routes/payments'));
app.use('/api/webhooks',      require('./routes/payments')); // alias — Razorpay webhook (no rate limit, verified by signature)
app.use('/api/b2b/auth',          authLimiter, b2bAuth);
app.use('/api/b2b/customers',     b2bCustomers);
app.use('/api/b2b/orders',        b2bOrders);
app.use('/api/projects',          projects);
app.use('/api/b2b/item-progress', b2bItemProgress);
app.use('/api/b2b/statement',     b2bStatement);
app.use('/api/b2b/stock',         b2bStock);
app.use('/api/b2b/custom-prices', b2bCustomPrices);
app.use('/api/b2b/quotes',        b2bQuotes);
app.use('/api/b2b/docs',          b2bDocs);
app.use('/api/b2b/samples',       b2bSamples);
app.use('/api/b2b/messages',      b2bMessages);
app.use('/api/b2b/analytics',     b2bAnalytics);
app.use('/api/b2b/profile',       b2bProfile);
app.use('/api/b2b/notifications', b2bNotifications);
app.use('/api/admin/init',     require('./routes/adminInit'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/zoho-customers', require('./routes/zohoCustomers'));
app.use('/api/upload',   require('./routes/upload'));
app.use('/api/chat',     require('./routes/chat'));
app.use('/api/social',      require('./routes/social'));
app.use('/api/admin-chat', require('./routes/adminChat'));
app.use('/api/monitor-agent', require('./routes/monitorAgent'));
app.use('/api/payroll',    require('./routes/payroll'));
app.use('/api/expenses',   require('./routes/expenses'));
app.use('/api/tts',              require('./routes/tts'));
app.use('/api/packing-inventory', require('./routes/packingInventory'));
app.use('/api/packing-procurement', require('./routes/packingProcurement'));
app.use('/api/raw-stock',         require('./routes/rawStock'));
app.use('/api/finished-goods',    require('./routes/finishedGoods'));
app.use('/api/maintenance',       require('./routes/maintenance'));
app.use('/api/production-plan',   require('./routes/productionPlan'));
app.use('/api/inventory-valuation',  require('./routes/inventoryValuation'));
app.use('/api/recurring-expenses',   require('./routes/recurringExpenses'));
app.use('/api/compliance',           require('./routes/compliance'));
app.use('/api/finance',           require('./routes/finance'));
app.use('/api/leave',             require('./routes/leave'));
app.use('/api/returns',           require('./routes/returns'));
app.use('/api/delivery',          require('./routes/delivery'));
app.use('/api/coupons',           require('./routes/coupons'));
app.use('/api/quality',           require('./routes/quality'));
app.use('/api/tasks',             require('./routes/tasks'));
app.use('/api/compliance',        require('./routes/compliance'));
app.use('/api/payouts',           require('./routes/payouts'));
app.use('/api/campaigns',         require('./routes/campaigns'));
app.use('/api/messages',          require('./routes/messages'));
app.use('/api/calls',             rateLimit({ windowMs: 60*1000, max: 200, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests' }, ...rateLimitOpts }), require('./routes/calls'));
app.use('/api/blog',              require('./routes/blog'));
app.use('/api/notifications',     require('./routes/notifications'));
app.use('/api/whatsapp',          require('./routes/whatsapp'));      // WhatsApp Business API (Meta direct)
app.use('/api/botsailor',         require('./routes/botsailor'));     // BotSailor WhatsApp middleware
app.use('/api/thirukural',        require('./routes/thirukural').router); // Daily Thirukkural broadcast
app.use('/api/broadcasts',        require('./routes/broadcasts'));          // All daily WA broadcasts
app.use('/api/competitor-prices', require('./routes/competitorPrices'));
app.use('/api/security',         require('./routes/security'));
app.use('/api/restock-reminders', require('./routes/restockReminder'));
app.use('/api/ca-agent',          require('./routes/caAgent'));
app.use('/api/google-ads',        require('./routes/googleAds'));
app.use('/api/deploy-notify',     require('./routes/deployNotify'));

// ── Weekly report manual trigger ──────────────────────────────────────────────
const { startScheduler, buildWeeklyReport } = require('./config/scheduler');
startScheduler();

// ── Abandoned cart + failed-payment automation (cron every 2h) ────────────────
try { require('./scripts/automation-service'); } catch(e) { console.error('[AUTOMATION] Failed to load:', e.message); }
app.post('/api/send-weekly-report', require('./middleware/auth').auth, async (req, res) => {
  try {
    const nodemailer = require('nodemailer');
    const mailer = nodemailer.createTransport({ host: process.env.SMTP_HOST||'smtp.gmail.com', port: parseInt(process.env.SMTP_PORT||'465'), secure: process.env.SMTP_PORT !== '587', auth:{ user:process.env.SMTP_USER, pass:process.env.SMTP_PASS } });
    const html   = await buildWeeklyReport();
    const to     = req.body?.to || 'vinoth@sathvam.in';
    await mailer.sendMail({ from: process.env.SMTP_FROM||'Sathvam <noreply@sathvam.in>', to, subject: `Sathvam Weekly Report — ${new Date().toISOString().slice(0,10)}`, html });
    res.json({ ok: true, sent_to: to });
  } catch(e) { console.error('Weekly report error:', e); res.status(500).json({ error: 'Failed to send report' }); }
});

app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.path} not found` }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Server error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`\n🫙 Sathvam API v1.1.0 on port ${PORT}\n`));
