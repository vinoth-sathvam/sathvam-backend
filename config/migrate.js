/**
 * Auto-migration runner — executes on backend startup.
 *
 * Runs all sql/migrate_*.sql files that haven't been applied yet.
 * Tracks applied migrations in a `schema_migrations` table.
 *
 * Usage: await require('./config/migrate')();
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const SQL_DIR = path.join(__dirname, '..', 'sql');

async function runMigrations() {
  const password = process.env.POSTGRES_PASSWORD;
  if (!password) {
    console.log('[migrate] POSTGRES_PASSWORD not set — skipping auto-migration');
    return;
  }

  // Inside Docker: postgres:5432, outside: localhost:5433
  const host = process.env.DOCKER_ENV ? 'postgres' : '127.0.0.1';
  const port = process.env.DOCKER_ENV ? 5432 : 5433;

  const client = new Client({
    host,
    port,
    database: 'sathvam',
    user: 'sathvam_app',
    password,
    connectionTimeoutMillis: 5000,
  });

  try {
    await client.connect();

    // Create tracking table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    // Get already-applied migrations
    const { rows: applied } = await client.query('SELECT name FROM schema_migrations ORDER BY name');
    const appliedSet = new Set(applied.map(r => r.name));

    // Find all migration files
    if (!fs.existsSync(SQL_DIR)) {
      console.log('[migrate] No sql/ directory found — skipping');
      return;
    }

    const files = fs.readdirSync(SQL_DIR)
      .filter(f => f.startsWith('migrate_') && f.endsWith('.sql'))
      .sort();

    const pending = files.filter(f => !appliedSet.has(f));

    if (pending.length === 0) {
      console.log(`[migrate] All ${files.length} migrations already applied`);
      return;
    }

    console.log(`[migrate] ${pending.length} pending migration(s) to apply...`);

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(SQL_DIR, file), 'utf8').trim();
      if (!sql) continue;

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[migrate] ✓ ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[migrate] ✗ ${file} — ${err.message}`);
        // Don't halt startup — log and continue with remaining migrations
      }
    }

    console.log('[migrate] Done');
  } catch (err) {
    console.error(`[migrate] Connection failed — ${err.message}`);
    // Don't crash the server if DB is temporarily unreachable
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = runMigrations;
