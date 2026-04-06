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
  ...(process.env.NODE_ENV !== 'production' ? ['http://localhost:5173', 'http://localhost:3000'] : []),
];
app.use(cors({ origin: allowedOrigins, credentials: true }));

const rateLimitOpts = { validate: { xForwardedForHeader: false } };

// General rate limit — 300 req/15min per IP
app.use(rateLimit({ windowMs: 15*60*1000, max: 300, standardHeaders: true, legacyHeaders: false, ...rateLimitOpts }));

// Strict limiter for auth endpoints — 50 req/15min per IP
const authLimiter = rateLimit({
  windowMs: 15*60*1000, max: 50,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
  ...rateLimitOpts,
});

app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('combined'));

const { products, procurement, vendors, sales, settings, users } = require('./routes/core');
const { b2bCustomers, b2bOrders, projects } = require('./routes/b2b');
const b2bAuth = require('./routes/b2bAuth');

app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.1.0', time: new Date().toISOString() }));
app.use('/api/auth',          authLimiter, require('./routes/auth'));
app.use('/api/batches',       require('./routes/batches'));
app.use('/api/products',      products);
app.use('/api/procurement',   procurement);
app.use('/api/vendors',       vendors);
app.use('/api/sales',         sales);
app.use('/api/settings',      settings);
app.use('/api/users',         users);
app.use('/api/b2b/auth',      authLimiter, b2bAuth);
app.use('/api/b2b/customers', b2bCustomers);
app.use('/api/b2b/orders',    b2bOrders);
app.use('/api/projects',      projects);

app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.path} not found` }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Server error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`\n🫙 Sathvam API v1.1.0 on port ${PORT}\n`));
