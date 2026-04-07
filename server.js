require('dotenv').config();

// ── Startup: fail fast on missing/default secrets ─────────────────────────────
['JWT_SECRET','MAGIC_LINK_SECRET'].forEach(k => {
  if (!process.env[k]) { console.error(`FATAL: ${k} env var is not set`); process.exit(1); }
});

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const app = express();
app.set('trust proxy', 1);
app.use(helmet());

// CORS — localhost only in non-production
const allowedOrigins = [
  'https://admin.sathvam.in',
  'https://sathvam.in',
  'https://www.sathvam.in',
  'https://store.sathvam.in',
  ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:5173', 'http://localhost:3000'] : []),
];
app.use(cors({ origin: allowedOrigins, credentials: true }));

const rateLimitOpts = { validate: { xForwardedForHeader: false } };

// General rate limit — 1000 req/15min per IP
app.use(rateLimit({ windowMs: 15*60*1000, max: 1000, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests, please try again later' }, ...rateLimitOpts }));

// Auth limiter — 200 req/15min per IP (prevents brute force while allowing normal staff use)
const authLimiter = rateLimit({
  windowMs: 15*60*1000, max: 200,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
  ...rateLimitOpts,
});

app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('combined'));

const { products, procurement, vendors, sales, settings, users } = require('./routes/core');
const { b2bCustomers, b2bOrders, projects, b2bItemProgress } = require('./routes/b2b');
const b2bAuth = require('./routes/b2bAuth');
const purchases = require('./routes/purchases');
const flourBatches = require('./routes/flourBatches');
const webstoreOrders = require('./routes/webstoreOrders');

app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.2.0', time: new Date().toISOString() }));
app.use('/api/public', require('./routes/public'));
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
app.use('/api/customer',       require('./routes/customer'));
app.use('/api/payments',      require('./routes/payments'));
app.use('/api/b2b/auth',      authLimiter, b2bAuth);
app.use('/api/b2b/customers', b2bCustomers);
app.use('/api/b2b/orders',    b2bOrders);
app.use('/api/projects',      projects);
app.use('/api/b2b/item-progress', b2bItemProgress);
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/upload',   require('./routes/upload'));
app.use('/api/chat',     require('./routes/chat'));
app.use('/api/social',   require('./routes/social'));

app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.path} not found` }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Server error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`\n🫙 Sathvam API v1.1.0 on port ${PORT}\n`));
