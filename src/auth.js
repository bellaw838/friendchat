const express = require('express');
const bcrypt = require('bcryptjs');
const verify = require('./verify');

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

function requireLogin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  next();
}

function authRoutes(db) {
  const router = express.Router();

  router.post('/api/signup', async (req, res) => {
    try {
      if (verify.isRequired()) {
        return res.status(503).json({ error: 'Sign-up verification is enabled but not configured yet' });
      }
      const { username, password } = req.body || {};
      if (!USERNAME_RE.test(username || '')) {
        return res.status(400).json({ error: 'Username must be 3-20 letters, numbers or _' });
      }
      if (typeof password !== 'string' || password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      if (await db.getUserByUsername(username)) {
        return res.status(409).json({ error: 'That username is taken' });
      }
      let user;
      try {
        user = await db.createUser(username, bcrypt.hashSync(password, 10));
      } catch {
        // unique-constraint race: two signups for the same name at once
        return res.status(409).json({ error: 'That username is taken' });
      }
      req.session.userId = user.id;
      req.session.username = user.username;
      res.json({ id: user.id, username: user.username });
    } catch (err) {
      console.error('signup failed:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.post('/api/login', async (req, res) => {
    try {
      const { username, password } = req.body || {};
      const user = await db.getUserByUsername((username || '').trim());
      if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
        return res.status(401).json({ error: 'Wrong username or password' });
      }
      req.session.userId = user.id;
      req.session.username = user.username;
      res.json({ id: user.id, username: user.username });
    } catch (err) {
      console.error('login failed:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  router.get('/api/me', requireLogin, (req, res) => {
    res.json({ id: req.session.userId, username: req.session.username });
  });

  return router;
}

module.exports = { authRoutes, requireLogin };
