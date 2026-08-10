const http = require('http');
const path = require('path');
const express = require('express');
const session = require('express-session');
const { createDb } = require('./db');
const { authRoutes } = require('./auth');

function createServer({ dbFile } = {}) {
  const db = createDb(dbFile);
  const app = express();
  app.set('trust proxy', 1); // Render sits behind a proxy
  app.use(express.json({ limit: '1mb' }));

  const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'dev-only-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 },
  });
  app.use(sessionMiddleware);

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(authRoutes(db));

  const httpServer = http.createServer(app);
  return { app, httpServer, db, sessionMiddleware };
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  createServer().httpServer.listen(port, () => {
    console.log(`BellaChat running on http://localhost:${port}`);
  });
}

module.exports = { createServer };
