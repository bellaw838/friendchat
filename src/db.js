const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_bot INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  code TEXT UNIQUE,
  is_direct INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS room_members (
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (room_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('text','image','media_note')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, id);
`;

function migrate(db) {
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (userCols.length && !userCols.includes('is_bot')) {
    db.exec("ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0");
  }
  const tbl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'").get();
  if (tbl && !tbl.sql.includes('media_note')) {
    db.exec(`
      BEGIN;
      CREATE TABLE messages_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL REFERENCES rooms(id),
        sender_id INTEGER NOT NULL REFERENCES users(id),
        kind TEXT NOT NULL CHECK (kind IN ('text','image','media_note')),
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO messages_migrated (id, room_id, sender_id, kind, body, created_at)
        SELECT id, room_id, sender_id, kind, body, created_at FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_migrated RENAME TO messages;
      CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, id);
      COMMIT;
    `);
  }
}

function createDb(filename = process.env.DB_PATH || 'data.db') {
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  migrate(db);

  return {
    createUser(username, passwordHash) {
      const info = db
        .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
        .run(username, passwordHash);
      return { id: Number(info.lastInsertRowid), username };
    },
    getUserByUsername(username) {
      return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    },
    createRoom({ name = null, code = null, isDirect = false } = {}) {
      const info = db
        .prepare('INSERT INTO rooms (name, code, is_direct) VALUES (?, ?, ?)')
        .run(name, code, isDirect ? 1 : 0);
      return db.prepare('SELECT * FROM rooms WHERE id = ?').get(info.lastInsertRowid);
    },
    getRoomByCode(code) {
      return db.prepare('SELECT * FROM rooms WHERE code = ?').get(code);
    },
    addMember(roomId, userId) {
      db.prepare('INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)').run(roomId, userId);
    },
    isMember(roomId, userId) {
      return !!db.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, userId);
    },
    findDirectRoom(userIdA, userIdB) {
      return db.prepare(`
        SELECT r.* FROM rooms r
        JOIN room_members m1 ON m1.room_id = r.id AND m1.user_id = ?
        JOIN room_members m2 ON m2.room_id = r.id AND m2.user_id = ?
        WHERE r.is_direct = 1
      `).get(userIdA, userIdB);
    },
    listRoomsForUser(userId) {
      return db.prepare(`
        SELECT r.id, r.name, r.code, r.is_direct,
          (SELECT u.username FROM room_members m JOIN users u ON u.id = m.user_id
             WHERE m.room_id = r.id AND m.user_id != ? LIMIT 1) AS other_username,
          (SELECT m2.user_id FROM room_members m2
             WHERE m2.room_id = r.id AND m2.user_id != ? LIMIT 1) AS other_user_id
        FROM rooms r JOIN room_members rm ON rm.room_id = r.id
        WHERE rm.user_id = ?
        ORDER BY r.id DESC
      `).all(userId, userId, userId);
    },
    createMessage({ roomId, senderId, kind, body }) {
      const info = db
        .prepare('INSERT INTO messages (room_id, sender_id, kind, body) VALUES (?, ?, ?, ?)')
        .run(roomId, senderId, kind, body);
      return db.prepare(`
        SELECT m.*, u.username AS sender_username
        FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?
      `).get(info.lastInsertRowid);
    },
    listMessages(roomId, limit = 50) {
      return db.prepare(`
        SELECT * FROM (
          SELECT m.id, m.room_id, m.sender_id, m.kind,
                 CASE WHEN m.kind = 'image' THEN '📷 photo' ELSE m.body END AS body,
                 m.created_at, u.username AS sender_username
          FROM messages m JOIN users u ON u.id = m.sender_id
          WHERE m.room_id = ? ORDER BY m.id DESC LIMIT ?
        ) ORDER BY id ASC
      `).all(roomId, limit);
    },
  };
}

module.exports = { createDb };
