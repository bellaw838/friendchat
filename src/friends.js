const express = require('express');
const { requireLogin } = require('./auth');

function friendRoutes(db, io) {
  const router = express.Router();
  router.use('/api/friends', requireLogin);

  const notifyBoth = (a, b) => {
    io.to(`user:${a}`).emit('friends_changed', {});
    io.to(`user:${b}`).emit('friends_changed', {});
  };

  router.get('/api/friends', (req, res) => {
    const uid = req.session.userId;
    const rows = db.listFriends(uid);
    const pick = (r) => ({ id: r.user_id, username: r.username });
    res.json({
      friends: rows.filter((r) => r.status === 'accepted').map(pick),
      incoming: rows.filter((r) => r.status === 'pending' && r.requested_by !== uid).map(pick),
      outgoing: rows.filter((r) => r.status === 'pending' && r.requested_by === uid).map(pick),
    });
  });

  router.post('/api/friends/request', (req, res) => {
    const username = (((req.body || {}).username) || '').trim();
    const other = db.getUserByUsername(username);
    if (!other) return res.status(404).json({ error: 'No user with that name' });
    if (other.id === req.session.userId) {
      return res.status(400).json({ error: "That's you! Enter a friend's username" });
    }
    const result = db.requestFriend(req.session.userId, other.id);
    if (result.already && result.status === 'accepted') {
      return res.status(409).json({ error: 'Already friends' });
    }
    if (!result.already) notifyBoth(req.session.userId, other.id);
    res.json({ status: result.status });
  });

  router.post('/api/friends/respond', (req, res) => {
    const { userId, accept } = req.body || {};
    const otherId = Number(userId);
    if (!db.respondFriend(req.session.userId, otherId, !!accept)) {
      return res.status(404).json({ error: 'No pending request from that user' });
    }
    notifyBoth(req.session.userId, otherId);
    res.json({ ok: true });
  });

  router.delete('/api/friends/:userId', (req, res) => {
    const otherId = Number(req.params.userId);
    const removed = db.removeFriend(req.session.userId, otherId);
    if (removed) notifyBoth(req.session.userId, otherId);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { friendRoutes };
