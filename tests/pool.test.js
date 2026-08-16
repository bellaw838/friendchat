const { test } = require('node:test');
const assert = require('node:assert');
const { getPool, initSchema, closePool } = require('../src/pool');

test('pool connects and creates the schema idempotently', async () => {
  const pool = getPool();
  await initSchema(pool);
  await initSchema(pool); // twice must be safe
  const { rows } = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() ORDER BY table_name
  `);
  const names = rows.map((r) => r.table_name);
  for (const t of ['friendships', 'messages', 'room_members', 'room_reads', 'rooms', 'users']) {
    assert.ok(names.includes(t), `missing table: ${t}`);
  }
  await closePool();
});

test('missing DATABASE_URL fails loudly', () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    assert.throws(() => getPool({ fresh: true }), /DATABASE_URL/);
  } finally {
    process.env.DATABASE_URL = saved;
  }
});
