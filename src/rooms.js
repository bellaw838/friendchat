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

function roomRoutes(db, io) {
  const router = express.Router();
  router.use('/api', requireLogin);

  router.get('/api/chats', async (req, res) => {
    try {
      res.json(await db.listRoomsForUser(req.session.userId));
    } catch (err) {
      console.error('list chats failed:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.post('/api/rooms', async (req, res) => {
    try {
      const name = ((req.body || {}).name || '').trim();
      if (!name || name.length > 40) {
        return res.status(400).json({ error: 'Room name must be 1-40 characters' });
      }
      let code;
      do { code = makeCode(); } while (await db.getRoomByCode(code));
      const room = await db.createRoom({ name, code, isDirect: false });
      await db.addMember(room.id, req.session.userId);
      res.json(room);
    } catch (err) {
      console.error('create room failed:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.post('/api/rooms/join', async (req, res) => {
    try {
      const code = (((req.body || {}).code) || '').trim().toUpperCase();
      const room = await db.getRoomByCode(code);
      if (!room) return res.status(404).json({ error: 'Room not found' });
      await db.addMember(room.id, req.session.userId);
      res.json(room);
    } catch (err) {
      console.error('join room failed:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.post('/api/directs', async (req, res) => {
    try {
      const username = (((req.body || {}).username) || '').trim();
      const other = await db.getUserByUsername(username);
      if (!other) return res.status(404).json({ error: 'No user with that name' });
      if (other.id === req.session.userId) {
        return res.status(400).json({ error: "That's you! Enter a friend's username" });
      }
      let room = await db.findDirectRoom(req.session.userId, other.id);
      if (!room) {
        if (!(await db.areFriends(req.session.userId, other.id))) {
          return res.status(403).json({ error: 'You need to be friends first' });
        }
        room = await db.createRoom({ isDirect: true });
        await db.addMember(room.id, req.session.userId);
        await db.addMember(room.id, other.id);
        io.to('user:' + other.id).emit('chat_added');
      }
      res.json({ ...room, other_username: other.username, other_user_id: other.id });
    } catch (err) {
      console.error('create direct failed:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.get('/api/rooms/:id/messages', async (req, res) => {
    try {
      const roomId = Number(req.params.id);
      if (!(await db.isMember(roomId, req.session.userId))) {
        return res.status(403).json({ error: 'Not a member of this chat' });
      }
      const messages = await db.listMessages(roomId, 50);
      await db.markRoomRead(roomId, req.session.userId); // opening a chat clears its badge
      res.json(messages);
    } catch (err) {
      console.error('list messages failed:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
}

module.exports = { roomRoutes };
