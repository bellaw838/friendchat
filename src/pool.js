const { Pool } = require('pg');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_bot BOOLEAN NOT NULL DEFAULT FALSE,
  email TEXT,
  phone TEXT,
  verified BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS rooms (
  id SERIAL PRIMARY KEY,
  name TEXT,
  code TEXT UNIQUE,
  is_direct BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS room_members (
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (room_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('text','image','media_note')),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, id);
CREATE TABLE IF NOT EXISTS friendships (
  user_lo INTEGER NOT NULL REFERENCES users(id),
  user_hi INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('pending','accepted')),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_lo, user_hi)
);
CREATE TABLE IF NOT EXISTS room_reads (
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, user_id)
);
`;

let shared = null;

function getPool({ fresh = false, schema = null } = {}) {
  if (shared && !fresh) return shared;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set — FriendsChat needs a PostgreSQL connection string');
  }
  const pool = new Pool({
    connectionString,
    max: 10,
    // Managed providers require TLS; a local server does not offer it.
    ssl: /\bsslmode=require\b/.test(connectionString) ? { rejectUnauthorized: false } : false,
  });
  if (schema) {
    pool.on('connect', (client) => client.query(`SET search_path TO ${schema}, public`));
  }
  if (!fresh) shared = pool;
  return pool;
}

async function initSchema(pool) {
  await pool.query(SCHEMA);
}

async function withSchema(name) {
  const admin = getPool({ fresh: true });
  await admin.query(`CREATE SCHEMA IF NOT EXISTS ${name}`);
  await admin.end();
  const pool = getPool({ fresh: true, schema: name });
  await initSchema(pool);
  return pool;
}

async function dropSchema(name) {
  const admin = getPool({ fresh: true });
  await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  await admin.end();
}

async function closePool() {
  if (shared) { await shared.end(); shared = null; }
}

module.exports = { getPool, initSchema, withSchema, dropSchema, closePool, SCHEMA };
