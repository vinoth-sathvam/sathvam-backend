const express = require('express');
const { Pool } = require('pg');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Direct PG connection (inside Docker network)
const pool = new Pool({
  host: process.env.PG_HOST || 'postgres',
  port: parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DB || 'sathvam',
  user: process.env.PG_USER || 'sathvam_app',
  password: process.env.POSTGRES_PASSWORD,
  max: 5,
  idleTimeoutMillis: 30000,
});

// All routes require admin role
router.use(auth, requireRole('admin'));

// ── List all tables with row counts ────────────────────────────────────
router.get('/tables', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        t.tablename AS name,
        pg_size_pretty(pg_total_relation_size(quote_ident(t.tablename))) AS size,
        COALESCE(s.n_live_tup, 0) AS row_count,
        obj_description((quote_ident(t.schemaname) || '.' || quote_ident(t.tablename))::regclass) AS comment
      FROM pg_tables t
      LEFT JOIN pg_stat_user_tables s ON s.relname = t.tablename AND s.schemaname = t.schemaname
      WHERE t.schemaname = 'public'
      ORDER BY t.tablename
    `);
    res.json({ tables: rows });
  } catch (e) {
    console.error('[database] tables:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Table schema (columns, types, constraints) ────────────────────────
router.get('/tables/:name/schema', async (req, res) => {
  const { name } = req.params;
  try {
    // Columns
    const { rows: columns } = await pool.query(`
      SELECT
        c.column_name AS name,
        c.data_type AS type,
        c.udt_name AS udt,
        c.column_default AS default_value,
        c.is_nullable AS nullable,
        c.character_maximum_length AS max_length,
        c.numeric_precision,
        c.numeric_scale
      FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = $1
      ORDER BY c.ordinal_position
    `, [name]);

    // Primary key
    const { rows: pks } = await pool.query(`
      SELECT a.attname AS column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary
    `, [name]);

    // Indexes
    const { rows: indexes } = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = $1 AND schemaname = 'public'
    `, [name]);

    // Foreign keys
    const { rows: fks } = await pool.query(`
      SELECT
        kcu.column_name,
        ccu.table_name AS foreign_table,
        ccu.column_name AS foreign_column,
        tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      WHERE tc.table_name = $1 AND tc.constraint_type = 'FOREIGN KEY'
    `, [name]);

    res.json({ columns, primaryKeys: pks.map(p => p.column_name), indexes, foreignKeys: fks });
  } catch (e) {
    console.error('[database] schema:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Browse table rows (paginated, sortable, searchable) ───────────────
router.get('/tables/:name/rows', async (req, res) => {
  const { name } = req.params;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  const sort = req.query.sort || 'id';
  const order = (req.query.order || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const search = req.query.search || '';
  const column = req.query.column || '';

  try {
    // Validate table exists
    const { rows: tableCheck } = await pool.query(
      `SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = $1`, [name]
    );
    if (!tableCheck.length) return res.status(404).json({ error: 'Table not found' });

    // Get columns for search
    const { rows: cols } = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [name]
    );
    const colNames = cols.map(c => c.column_name);

    // Validate sort column
    const safeSort = colNames.includes(sort) ? sort : (colNames.includes('id') ? 'id' : colNames[0]);

    // Build search clause
    let whereClause = '';
    const params = [];
    if (search && column && colNames.includes(column)) {
      const colType = cols.find(c => c.column_name === column)?.data_type || '';
      if (['integer', 'bigint', 'smallint', 'numeric', 'real', 'double precision'].includes(colType)) {
        const num = parseFloat(search);
        if (!isNaN(num)) {
          params.push(num);
          whereClause = `WHERE "${column}" = $1`;
        }
      } else {
        params.push(`%${search}%`);
        whereClause = `WHERE "${column}"::text ILIKE $1`;
      }
    } else if (search) {
      // Search across all text-castable columns
      const textCols = cols.filter(c => !['jsonb', 'json', 'bytea'].includes(c.data_type));
      if (textCols.length) {
        params.push(`%${search}%`);
        const clauses = textCols.map(c => `"${c.column_name}"::text ILIKE $1`);
        whereClause = `WHERE (${clauses.join(' OR ')})`;
      }
    }

    // Count
    const countRes = await pool.query(`SELECT COUNT(*) AS total FROM "${name}" ${whereClause}`, params);
    const total = parseInt(countRes.rows[0].total);

    // Rows
    const { rows } = await pool.query(
      `SELECT * FROM "${name}" ${whereClause} ORDER BY "${safeSort}" ${order} LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    res.json({ rows, total, page, limit, pages: Math.ceil(total / limit), columns: cols });
  } catch (e) {
    console.error('[database] rows:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Run SQL query (SELECT only) ───────────────────────────────────────
router.post('/sql', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Query required' });

  // Safety: block dangerous operations
  const normalized = query.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().toLowerCase();
  const dangerous = ['drop ', 'truncate ', 'alter ', 'grant ', 'revoke ', 'create role', 'create user'];
  for (const d of dangerous) {
    if (normalized.includes(d)) {
      return res.status(403).json({ error: `Blocked: "${d.trim()}" operations not allowed from UI` });
    }
  }

  try {
    const startMs = Date.now();
    const result = await pool.query(query);
    const ms = Date.now() - startMs;

    res.json({
      rows: result.rows || [],
      rowCount: result.rowCount,
      fields: (result.fields || []).map(f => ({ name: f.name, dataTypeID: f.dataTypeID })),
      ms,
      command: result.command,
    });
  } catch (e) {
    console.error('[database] sql:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// ── Update a row ──────────────────────────────────────────────────────
router.put('/tables/:name/rows', async (req, res) => {
  const { name } = req.params;
  const { pkColumn, pkValue, updates } = req.body;
  if (!pkColumn || pkValue === undefined || !updates || !Object.keys(updates).length) {
    return res.status(400).json({ error: 'pkColumn, pkValue, and updates required' });
  }

  try {
    const setClauses = [];
    const params = [pkValue];
    let i = 2;
    for (const [col, val] of Object.entries(updates)) {
      setClauses.push(`"${col}" = $${i}`);
      params.push(val);
      i++;
    }

    const { rowCount, rows } = await pool.query(
      `UPDATE "${name}" SET ${setClauses.join(', ')} WHERE "${pkColumn}" = $1 RETURNING *`,
      params
    );
    res.json({ updated: rowCount, row: rows[0] || null });
  } catch (e) {
    console.error('[database] update:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// ── Insert a row ──────────────────────────────────────────────────────
router.post('/tables/:name/rows', async (req, res) => {
  const { name } = req.params;
  const { data } = req.body;
  if (!data || !Object.keys(data).length) return res.status(400).json({ error: 'data required' });

  try {
    const cols = Object.keys(data);
    const vals = Object.values(data);
    const placeholders = vals.map((_, i) => `$${i + 1}`);

    const { rows } = await pool.query(
      `INSERT INTO "${name}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      vals
    );
    res.json({ row: rows[0] });
  } catch (e) {
    console.error('[database] insert:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// ── Delete a row ──────────────────────────────────────────────────────
router.delete('/tables/:name/rows', async (req, res) => {
  const { pkColumn, pkValue } = req.body;
  const { name } = req.params;
  if (!pkColumn || pkValue === undefined) return res.status(400).json({ error: 'pkColumn and pkValue required' });

  try {
    const { rowCount } = await pool.query(`DELETE FROM "${name}" WHERE "${pkColumn}" = $1`, [pkValue]);
    res.json({ deleted: rowCount });
  } catch (e) {
    console.error('[database] delete:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// ── Database stats ────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [dbSize, connInfo, activity] = await Promise.all([
      pool.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size, current_database() AS name, version() AS version`),
      pool.query(`SELECT count(*) AS total, count(*) FILTER (WHERE state = 'active') AS active, count(*) FILTER (WHERE state = 'idle') AS idle FROM pg_stat_activity WHERE datname = current_database()`),
      pool.query(`SELECT schemaname, count(*) AS tables FROM pg_tables WHERE schemaname = 'public' GROUP BY schemaname`),
    ]);

    res.json({
      database: dbSize.rows[0]?.name,
      size: dbSize.rows[0]?.size,
      version: dbSize.rows[0]?.version,
      connections: connInfo.rows[0],
      tableCount: activity.rows[0]?.tables || 0,
    });
  } catch (e) {
    console.error('[database] stats:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
