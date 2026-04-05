require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'https://admin.sathvam.in',
    'https://admin.sathvam.in',
    'https://sathvam.in',
    'https://www.sathvam.in',
    'http://localhost:5173',
    'http://localhost:3000',
  ],
  credentials: true,
}));
app.use(rateLimit({ windowMs: 15*60*1000, max: 1000 }));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined'));

const { products, procurement, vendors, sales, settings, users } = require('./routes/core');
const { b2bCustomers, b2bOrders, projects } = require('./routes/b2b');

app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.1.0', time: new Date().toISOString() }));
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/batches',       require('./routes/batches'));
app.use('/api/products',      products);
app.use('/api/procurement',   procurement);
app.use('/api/vendors',       vendors);
app.use('/api/sales',         sales);
app.use('/api/settings',      settings);
app.use('/api/users',         users);
app.use('/api/b2b/customers', b2bCustomers);
app.use('/api/b2b/orders',    b2bOrders);
app.use('/api/projects',      projects);

app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.path} not found` }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Server error' : err.message });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`\n🫙 Sathvam API v1.1.0 on port ${PORT}\n`));
