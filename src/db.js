const { getPool } = require('./pool');

// Postgres returns real booleans; the web client expects 0/1 as SQLite gave it.
function toInt(row, fields) {
  if (!row) return row;
  for (const f of fields) if (typeof row[f] === 'boolean') row[f] = row[f] ? 1 : 0;
  return row;
}
const roomOut = (r) => toInt(r, ['is_direct']);
const userOut = (r) => toInt(r, ['is_bot', 'verified']);

function createDb(pool = getPool()) {
  const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];
  const many = async (sql, params = []) => (await pool.query(sql, params)).rows;

  return {
    async createUser(username, passwordHash) {
      const row = await one(
        'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
        [username, passwordHash]
      );
      return { id: Number(row.id), username: row.username };
    },
    async getUserByUsername(username) {
      return userOut(await one('SELECT * FROM users WHERE username = $1', [username]));
    },
    async createRoom({ name = null, code = null, isDirect = false } = {}) {
      return roomOut(await one(
        'INSERT INTO rooms (name, code, is_direct) VALUES ($1, $2, $3) RETURNING *',
        [name, code, !!isDirect]
      ));
    },
    async getRoomByCode(code) {
      return roomOut(await one('SELECT * FROM rooms WHERE code = $1', [code]));
    },
    async addMember(roomId, userId) {
      await pool.query(
        'INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [roomId, userId]
      );
    },
    async isMember(roomId, userId) {
      if (!Number.isInteger(Number(roomId))) return false; // NaN room ids must not throw
      return !!(await one('SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, userId]));
    },
    async findDirectRoom(userIdA, userIdB) {
      return roomOut(await one(`
        SELECT r.* FROM rooms r
        JOIN room_members m1 ON m1.room_id = r.id AND m1.user_id = $1
        JOIN room_members m2 ON m2.room_id = r.id AND m2.user_id = $2
        WHERE r.is_direct = TRUE
      `, [userIdA, userIdB]));
    },
    async listRoomsForUser(userId) {
      const rows = await many(`
        SELECT r.id, r.name, r.code, r.is_direct,
          (SELECT u.username FROM room_members m JOIN users u ON u.id = m.user_id
             WHERE m.room_id = r.id AND m.user_id <> $1 LIMIT 1) AS other_username,
          (SELECT m2.user_id FROM room_members m2
             WHERE m2.room_id = r.id AND m2.user_id <> $1 LIMIT 1) AS other_user_id,
          last.id AS last_message_id,
          CASE WHEN last.kind = 'image' THEN '📷 photo' ELSE last.body END AS last_body,
          last.kind AS last_kind,
          last.created_at AS last_at,
          lu.username AS last_sender,
          last.sender_id AS last_sender_id,
          (SELECT COUNT(*) FROM messages un
             WHERE un.room_id = r.id AND un.sender_id <> $1
               AND un.id > COALESCE((SELECT rr.last_read_id FROM room_reads rr
                                       WHERE rr.room_id = r.id AND rr.user_id = $1), 0)
          )::int AS unread
        FROM rooms r
        JOIN room_members rm ON rm.room_id = r.id
        LEFT JOIN messages last ON last.id =
          (SELECT m3.id FROM messages m3 WHERE m3.room_id = r.id ORDER BY m3.id DESC LIMIT 1)
        LEFT JOIN users lu ON lu.id = last.sender_id
        WHERE rm.user_id = $1
        ORDER BY COALESCE(last.id, 0) DESC, r.id DESC
      `, [userId]);
      return rows.map(roomOut);
    },
    async markRoomRead(roomId, userId) {
      await pool.query(`
        INSERT INTO room_reads (room_id, user_id, last_read_id)
        VALUES ($1, $2, COALESCE((SELECT MAX(id) FROM messages WHERE room_id = $1), 0))
        ON CONFLICT (room_id, user_id)
        DO UPDATE SET last_read_id = EXCLUDED.last_read_id
      `, [roomId, userId]);
    },
    async createMessage({ roomId, senderId, kind, body }) {
      const row = await one(
        'INSERT INTO messages (room_id, sender_id, kind, body) VALUES ($1, $2, $3, $4) RETURNING id',
        [roomId, senderId, kind, body]
      );
      return one(`
        SELECT m.*, u.username AS sender_username
        FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = $1
      `, [row.id]);
    },
    async listMessages(roomId, limit = 50) {
      return many(`
        SELECT * FROM (
          SELECT m.id, m.room_id, m.sender_id, m.kind,
                 CASE WHEN m.kind = 'image' THEN '📷 photo' ELSE m.body END AS body,
                 m.created_at, u.username AS sender_username
          FROM messages m JOIN users u ON u.id = m.sender_id
          WHERE m.room_id = $1 ORDER BY m.id DESC LIMIT $2
        ) recent ORDER BY id ASC
      `, [roomId, limit]);
    },
    async requestFriend(fromId, toId) {
      if (fromId === toId) throw new Error('cannot friend yourself');
      const [lo, hi] = fromId < toId ? [fromId, toId] : [toId, fromId];
      const row = await one('SELECT * FROM friendships WHERE user_lo = $1 AND user_hi = $2', [lo, hi]);
      if (!row) {
        await pool.query(
          "INSERT INTO friendships (user_lo, user_hi, status, requested_by) VALUES ($1, $2, 'pending', $3)",
          [lo, hi, fromId]
        );
        return { status: 'pending' };
      }
      if (row.status === 'accepted') return { status: 'accepted', already: true };
      if (row.requested_by === fromId) return { status: 'pending', already: true };
      await pool.query("UPDATE friendships SET status = 'accepted' WHERE user_lo = $1 AND user_hi = $2", [lo, hi]);
      return { status: 'accepted' };
    },
    async respondFriend(userId, otherId, accept) {
      const [lo, hi] = userId < otherId ? [userId, otherId] : [otherId, userId];
      const row = await one(
        "SELECT * FROM friendships WHERE user_lo = $1 AND user_hi = $2 AND status = 'pending'", [lo, hi]
      );
      if (!row || row.requested_by === userId) return false;
      if (accept) {
        await pool.query("UPDATE friendships SET status = 'accepted' WHERE user_lo = $1 AND user_hi = $2", [lo, hi]);
      } else {
        await pool.query('DELETE FROM friendships WHERE user_lo = $1 AND user_hi = $2', [lo, hi]);
      }
      return true;
    },
    async removeFriend(userId, otherId) {
      const [lo, hi] = userId < otherId ? [userId, otherId] : [otherId, userId];
      const res = await pool.query('DELETE FROM friendships WHERE user_lo = $1 AND user_hi = $2', [lo, hi]);
      return res.rowCount > 0;
    },
    async areFriends(a, b) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      return !!(await one(
        "SELECT 1 FROM friendships WHERE user_lo = $1 AND user_hi = $2 AND status = 'accepted'", [lo, hi]
      ));
    },
    async listFriends(userId) {
      return many(`
        SELECT CASE WHEN f.user_lo = $1 THEN f.user_hi ELSE f.user_lo END AS user_id,
               u.username, f.status, f.requested_by
        FROM friendships f
        JOIN users u ON u.id = CASE WHEN f.user_lo = $1 THEN f.user_hi ELSE f.user_lo END
        WHERE f.user_lo = $1 OR f.user_hi = $1
        ORDER BY u.username
      `, [userId]);
    },
  };
}

module.exports = { createDb };
