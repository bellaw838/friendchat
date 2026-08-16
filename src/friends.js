const express = require('express');
const { requireLogin } = require('./auth');

function friendRoutes(db, io) {
  const router = express.Router();
  router.use('/api/friends', requireLogin);

  const notifyBoth = (a, b) => {
    io.to(`user:${a}`).emit('friends_changed', {});
    io.to(`user:${b}`).emit('friends_changed', {});
  };

  router.get('/api/friends', async (req, res) => {
    try {
      const uid = req.session.userId;
      const rows = await db.listFriends(uid);
      const pick = (r) => ({ id: r.user_id, username: r.username });
      res.json({
        friends: rows.filter((r) => r.status === 'accepted').map(pick),
        incoming: rows.filter((r) => r.status === 'pending' && r.requested_by !== uid).map(pick),
        outgoing: rows.filter((r) => r.status === 'pending' && r.requested_by === uid).map(pick),
      });
    } catch (err) {
      console.error('list friends failed:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.post('/api/friends/request', async (req, res) => {
    try {
      const username = (((req.body || {}).username) || '').trim();
      const other = await db.getUserByUsername(username);
      if (!other) return res.status(404).json({ error: 'No user with that name' });
      if (other.id === req.session.userId) {
        return res.status(400).json({ error: "That's you! Enter a friend's username" });
      }
      const result = await db.requestFriend(req.session.userId, other.id);
      if (result.already && result.status === 'accepted') {
        return res.status(409).json({ error: 'Already friends' });
      }
      if (!result.already) notifyBoth(req.session.userId, other.id);
      res.json({ status: result.status });
    } catch (err) {
      console.error('friend request failed:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.post('/api/friends/respond', async (req, res) => {
    try {
      const { userId, accept } = req.body || {};
      const otherId = Number(userId);
      if (!(await db.respondFriend(req.session.userId, otherId, !!accept))) {
        return res.status(404).json({ error: 'No pending request from that user' });
      }
      notifyBoth(req.session.userId, otherId);
      res.json({ ok: true });
    } catch (err) {
      console.error('friend respond failed:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.delete('/api/friends/:userId', async (req, res) => {
    try {
      const otherId = Number(req.params.userId);
      const removed = await db.removeFriend(req.session.userId, otherId);
      if (removed) notifyBoth(req.session.userId, otherId);
      res.json({ ok: true });
    } catch (err) {
      console.error('friend remove failed:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  return router;
}

module.exports = { friendRoutes };
