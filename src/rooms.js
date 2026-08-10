const express = require('express');
const { requireLogin } = require('./auth');

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

function roomRoutes(db) {
  const router = express.Router();
  router.use('/api', requireLogin);

  router.get('/api/chats', (req, res) => {
    res.json(db.listRoomsForUser(req.session.userId));
  });

  router.post('/api/rooms', (req, res) => {
    const name = ((req.body || {}).name || '').trim();
    if (!name || name.length > 40) {
      return res.status(400).json({ error: 'Room name must be 1-40 characters' });
    }
    let code;
    do { code = makeCode(); } while (db.getRoomByCode(code));
    const room = db.createRoom({ name, code, isDirect: false });
    db.addMember(room.id, req.session.userId);
    res.json(room);
  });

  router.post('/api/rooms/join', (req, res) => {
    const code = (((req.body || {}).code) || '').trim().toUpperCase();
    const room = db.getRoomByCode(code);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    db.addMember(room.id, req.session.userId);
    res.json(room);
  });

  router.post('/api/directs', (req, res) => {
    const username = (((req.body || {}).username) || '').trim();
    const other = db.getUserByUsername(username);
    if (!other) return res.status(404).json({ error: 'No user with that name' });
    if (other.id === req.session.userId) {
      return res.status(400).json({ error: "That's you! Enter a friend's username" });
    }
    let room = db.findDirectRoom(req.session.userId, other.id);
    if (!room) {
      room = db.createRoom({ isDirect: true });
      db.addMember(room.id, req.session.userId);
      db.addMember(room.id, other.id);
    }
    res.json({ ...room, other_username: other.username, other_user_id: other.id });
  });

  router.get('/api/rooms/:id/messages', (req, res) => {
    const roomId = Number(req.params.id);
    if (!db.isMember(roomId, req.session.userId)) {
      return res.status(403).json({ error: 'Not a member of this chat' });
    }
    res.json(db.listMessages(roomId, 50));
  });

  return router;
}

module.exports = { roomRoutes };
