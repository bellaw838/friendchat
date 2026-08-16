const http = require('http');
const path = require('path');
const express = require('express');
const session = require('express-session');
const { createDb } = require('./db');
const { getPool, initSchema } = require('./pool');
const { authRoutes } = require('./auth');
const { roomRoutes } = require('./rooms');
const { friendRoutes } = require('./friends');
const { attachSocket } = require('./socket');

async function createServer({ pool = getPool() } = {}) {
  await initSchema(pool);
  const db = createDb(pool);
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'dev-only-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 30 * 24 * 3600 * 1000 },
  });
  app.use(sessionMiddleware);
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(authRoutes(db));

  const httpServer = http.createServer(app);
  const io = attachSocket(httpServer, sessionMiddleware, db);
  app.use(roomRoutes(db, io));
  app.use(friendRoutes(db, io));
  return { app, httpServer, db, sessionMiddleware };
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  createServer()
    .then(({ httpServer }) => httpServer.listen(port, () => {
      console.log(`FriendsChat running on http://localhost:${port}`);
    }))
    .catch((err) => {
      console.error('Failed to start:', err.message);
      process.exit(1);
    });
}

module.exports = { createServer };
