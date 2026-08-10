# BellaChat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A private chat website for a friend group: username/password accounts, 1-on-1 chats, group rooms with join codes, real-time text + emoji + picture messages.

**Architecture:** One Node.js service. Express serves a plain HTML/CSS/JS frontend and REST endpoints for auth/rooms/history; Socket.IO delivers messages and presence in real time; better-sqlite3 stores everything in one SQLite file. 1-on-1 chats are rooms with `is_direct = 1`, so message handling is identical for both chat styles.

**Tech Stack:** Node.js 20+, Express 4, express-session, Socket.IO 4, better-sqlite3, bcryptjs. Tests: `node:test` + supertest + socket.io-client. Frontend: vanilla HTML/CSS/JS, no frameworks, no CDNs (the Socket.IO client script is served by our own server at `/socket.io/socket.io.js`).

**Spec:** `docs/superpowers/specs/2026-08-10-bellachat-design.md`

## Global Constraints

- Username rule: `/^[A-Za-z0-9_]{3,20}$/`. Password: minimum 8 characters, bcrypt-hashed (10 rounds).
- Text messages: max 2000 characters. Image messages: JPEG data-URL, client resizes to max 1280px, server rejects bodies over 700,000 chars (~500 KB) or not starting with `data:image/`.
- Room codes: 6 chars from alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no confusing 0/O/1/I/L).
- Every message read/write checks room membership. No public user directory.
- Env vars: `PORT` (default 3000), `SESSION_SECRET` (default `dev-only-secret`), `DB_PATH` (default `data.db`).
- No TypeScript, no build step, no frontend frameworks. CommonJS (`require`) throughout.
- Run tests with `npm test` (which runs `node --test` — no path argument; Node auto-discovers `tests/**`).

---

### Task 1: Project scaffolding + database module (users)

**Files:**
- Create: `package.json`, `.gitignore`, `src/db.js`
- Test: `tests/db.test.js`

**Interfaces:**
- Produces: `createDb(filename)` from `src/db.js` → object with `createUser(username, passwordHash) → {id, username}` and `getUserByUsername(username) → row | undefined`. Later tasks add more methods to this same object.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "bellachat",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "better-sqlite3": "^11.3.0",
    "express": "^4.19.2",
    "express-session": "^1.18.0",
    "socket.io": "^4.7.5"
  },
  "devDependencies": {
    "socket.io-client": "^4.7.5",
    "supertest": "^7.0.0"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
data.db
data.db-*
.omc/
.DS_Store
```

- [ ] **Step 3: Install dependencies**

Run: `npm install` (background it; better-sqlite3 compiles a native module and can take a minute)
Expected: exits 0.

- [ ] **Step 4: Write the failing test** — `tests/db.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { createDb } = require('../src/db');

test('creates and finds users', () => {
  const db = createDb(':memory:');
  const user = db.createUser('bella', 'fakehash');
  assert.equal(user.username, 'bella');
  assert.ok(user.id > 0);

  const found = db.getUserByUsername('bella');
  assert.equal(found.id, user.id);
  assert.equal(found.password_hash, 'fakehash');
  assert.equal(db.getUserByUsername('nobody'), undefined);
});

test('rejects duplicate usernames', () => {
  const db = createDb(':memory:');
  db.createUser('bella', 'x');
  assert.throws(() => db.createUser('bella', 'y'));
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find module `../src/db`.

- [ ] **Step 6: Write `src/db.js`** (full schema now; only user methods yet)

```js
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
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
  kind TEXT NOT NULL CHECK (kind IN ('text','image')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, id);
`;

function createDb(filename = process.env.DB_PATH || 'data.db') {
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

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
  };
}

module.exports = { createDb };
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm test` — Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .gitignore src/db.js tests/db.test.js
git commit -m "feat: project scaffolding and users table"
```

---

### Task 2: Database module — rooms, members, messages

**Files:**
- Modify: `src/db.js` (add methods inside the returned object)
- Test: `tests/db.test.js` (append tests)

**Interfaces:**
- Consumes: `createDb`, `createUser` from Task 1.
- Produces (all on the object returned by `createDb`):
  - `createRoom({name, code, isDirect}) → room row` (`{id, name, code, is_direct, created_at}`)
  - `getRoomByCode(code) → row | undefined`
  - `addMember(roomId, userId)` (idempotent)
  - `isMember(roomId, userId) → boolean`
  - `findDirectRoom(userIdA, userIdB) → room row | undefined`
  - `listRoomsForUser(userId) → rows` with extra `other_username`, `other_user_id` columns (meaningful only when `is_direct = 1`; for group rooms clients must ignore them)
  - `createMessage({roomId, senderId, kind, body}) → message row incl. sender_username`
  - `listMessages(roomId, limit) → rows ascending by id, incl. sender_username` (most recent `limit`)

- [ ] **Step 1: Append failing tests to `tests/db.test.js`**

```js
test('rooms, codes and membership', () => {
  const db = createDb(':memory:');
  const a = db.createUser('alice', 'x');
  const b = db.createUser('bob', 'x');
  const room = db.createRoom({ name: 'homework', code: 'X7K2PQ', isDirect: false });
  assert.equal(room.code, 'X7K2PQ');
  db.addMember(room.id, a.id);
  db.addMember(room.id, a.id); // idempotent
  assert.equal(db.isMember(room.id, a.id), true);
  assert.equal(db.isMember(room.id, b.id), false);
  assert.equal(db.getRoomByCode('X7K2PQ').id, room.id);
  assert.equal(db.getRoomByCode('NOPE99'), undefined);
});

test('direct rooms are found for either member order', () => {
  const db = createDb(':memory:');
  const a = db.createUser('alice', 'x');
  const b = db.createUser('bob', 'x');
  assert.equal(db.findDirectRoom(a.id, b.id), undefined);
  const room = db.createRoom({ isDirect: true });
  db.addMember(room.id, a.id);
  db.addMember(room.id, b.id);
  assert.equal(db.findDirectRoom(a.id, b.id).id, room.id);
  assert.equal(db.findDirectRoom(b.id, a.id).id, room.id);
  const list = db.listRoomsForUser(a.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].other_username, 'bob');
  assert.equal(list[0].other_user_id, b.id);
});

test('messages save and load in order with sender name', () => {
  const db = createDb(':memory:');
  const a = db.createUser('alice', 'x');
  const room = db.createRoom({ isDirect: true });
  db.addMember(room.id, a.id);
  const m1 = db.createMessage({ roomId: room.id, senderId: a.id, kind: 'text', body: 'hi 👋' });
  db.createMessage({ roomId: room.id, senderId: a.id, kind: 'text', body: 'second' });
  assert.equal(m1.sender_username, 'alice');
  const msgs = db.listMessages(room.id, 50);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].body, 'hi 👋');
  assert.equal(msgs[1].body, 'second');
  assert.equal(db.listMessages(room.id, 1).length, 1);
  assert.equal(db.listMessages(room.id, 1)[0].body, 'second'); // most recent kept
});
```

- [ ] **Step 2: Run tests** — `npm test` — Expected: 3 new FAILs (`db.createRoom is not a function`).

- [ ] **Step 3: Add methods to the returned object in `src/db.js`** (before the closing `};` of `return {`)

```js
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
          SELECT m.*, u.username AS sender_username
          FROM messages m JOIN users u ON u.id = m.sender_id
          WHERE m.room_id = ? ORDER BY m.id DESC LIMIT ?
        ) ORDER BY id ASC
      `).all(roomId, limit);
    },
```

- [ ] **Step 4: Run tests** — `npm test` — Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db.js tests/db.test.js
git commit -m "feat: rooms, membership and messages in db module"
```

---

### Task 3: Auth routes + server assembly

**Files:**
- Create: `src/auth.js`, `src/server.js`
- Test: `tests/auth.test.js`

**Interfaces:**
- Consumes: `createDb` from `src/db.js`.
- Produces:
  - `src/auth.js` exports `{ authRoutes(db) → express.Router, requireLogin(req,res,next) }`. Routes set `req.session.userId` and `req.session.username`.
  - `src/server.js` exports `{ createServer({ dbFile }) → { app, httpServer, db, sessionMiddleware } }`. Serves static files from `public/`, mounts auth routes. (Task 4 mounts room routes; Task 5 attaches sockets.)
  - REST: `POST /api/signup {username,password}` → `{id,username}` (400 invalid, 409 taken); `POST /api/login` → `{id,username}` (401 `Wrong username or password`); `POST /api/logout` → `{ok:true}`; `GET /api/me` → `{id,username}` or 401. Errors are always `{error: "message"}` JSON.

- [ ] **Step 1: Write failing tests** — `tests/auth.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createServer } = require('../src/server');

function freshApp() {
  return createServer({ dbFile: ':memory:' }).app;
}

test('signup then me', async () => {
  const agent = request.agent(freshApp());
  const res = await agent.post('/api/signup')
    .send({ username: 'bella', password: 'password123' }).expect(200);
  assert.equal(res.body.username, 'bella');
  const me = await agent.get('/api/me').expect(200);
  assert.equal(me.body.username, 'bella');
});

test('signup validation', async () => {
  const agent = request.agent(freshApp());
  await agent.post('/api/signup').send({ username: 'ab', password: 'password123' }).expect(400);
  await agent.post('/api/signup').send({ username: 'has space', password: 'password123' }).expect(400);
  await agent.post('/api/signup').send({ username: 'bella', password: 'short' }).expect(400);
});

test('duplicate username is 409', async () => {
  const app = freshApp();
  await request.agent(app).post('/api/signup').send({ username: 'bella', password: 'password123' }).expect(200);
  const res = await request.agent(app).post('/api/signup')
    .send({ username: 'bella', password: 'password456' }).expect(409);
  assert.match(res.body.error, /taken/i);
});

test('login right and wrong password, logout', async () => {
  const app = freshApp();
  await request.agent(app).post('/api/signup').send({ username: 'bella', password: 'password123' }).expect(200);
  const agent = request.agent(app);
  await agent.post('/api/login').send({ username: 'bella', password: 'wrongwrong' }).expect(401);
  await agent.post('/api/login').send({ username: 'bella', password: 'password123' }).expect(200);
  await agent.get('/api/me').expect(200);
  await agent.post('/api/logout').expect(200);
  await agent.get('/api/me').expect(401);
});
```

- [ ] **Step 2: Run tests** — `npm test` — Expected: FAIL (cannot find `../src/server`).

- [ ] **Step 3: Write `src/auth.js`**

```js
const express = require('express');
const bcrypt = require('bcryptjs');

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

function requireLogin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  next();
}

function authRoutes(db) {
  const router = express.Router();

  router.post('/api/signup', (req, res) => {
    const { username, password } = req.body || {};
    if (!USERNAME_RE.test(username || '')) {
      return res.status(400).json({ error: 'Username must be 3-20 letters, numbers or _' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (db.getUserByUsername(username)) {
      return res.status(409).json({ error: 'That username is taken' });
    }
    const user = db.createUser(username, bcrypt.hashSync(password, 10));
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ id: user.id, username: user.username });
  });

  router.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    const user = db.getUserByUsername((username || '').trim());
    if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
      return res.status(401).json({ error: 'Wrong username or password' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ id: user.id, username: user.username });
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
```

- [ ] **Step 4: Write `src/server.js`**

```js
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
```

Note: the default in-memory session store logs a warning about production use; at friend-group scale this is fine and accepted (sessions reset when the server restarts, same as the free-tier database trade-off in the spec).

- [ ] **Step 5: Run tests** — `npm test` — Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add src/auth.js src/server.js tests/auth.test.js
git commit -m "feat: signup/login/logout with sessions"
```

---

### Task 4: Room and chat REST routes

**Files:**
- Create: `src/rooms.js`
- Modify: `src/server.js` (mount router)
- Test: `tests/rooms.test.js`

**Interfaces:**
- Consumes: db methods from Tasks 1–2; `requireLogin` from `src/auth.js`.
- Produces: `src/rooms.js` exports `{ roomRoutes(db) → express.Router }` with (all login-required, errors as `{error}`):
  - `GET /api/chats` → array from `db.listRoomsForUser` for the session user
  - `POST /api/rooms {name}` → room row incl. `code` (400 if name empty/over 40 chars)
  - `POST /api/rooms/join {code}` → room row (404 `Room not found`; code is upper-cased/trimmed first)
  - `POST /api/directs {username}` → room row + `other_username`, `other_user_id` (404 `No user with that name`, 400 for self)
  - `GET /api/rooms/:id/messages` → last 50 messages ascending (403 if not a member)

- [ ] **Step 1: Write failing tests** — `tests/rooms.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createServer } = require('../src/server');

async function signedUpAgent(app, username) {
  const agent = request.agent(app);
  await agent.post('/api/signup').send({ username, password: 'password123' }).expect(200);
  return agent;
}

test('chat endpoints require login', async () => {
  const { app } = createServer({ dbFile: ':memory:' });
  await request(app).get('/api/chats').expect(401);
  await request(app).post('/api/rooms').send({ name: 'x' }).expect(401);
});

test('create room, join by code', async () => {
  const { app } = createServer({ dbFile: ':memory:' });
  const alice = await signedUpAgent(app, 'alice');
  const bob = await signedUpAgent(app, 'bob');

  const room = (await alice.post('/api/rooms').send({ name: 'homework' }).expect(200)).body;
  assert.match(room.code, /^[A-HJ-KM-NP-Z2-9]{6}$/);
  await alice.post('/api/rooms').send({ name: '' }).expect(400);

  await bob.post('/api/rooms/join').send({ code: 'ZZZZZZ' }).expect(404);
  const joined = (await bob.post('/api/rooms/join').send({ code: room.code.toLowerCase() }).expect(200)).body;
  assert.equal(joined.id, room.id);
  const bobChats = (await bob.get('/api/chats').expect(200)).body;
  assert.equal(bobChats.length, 1);
  assert.equal(bobChats[0].name, 'homework');
});

test('direct chats: create once, reuse after', async () => {
  const { app } = createServer({ dbFile: ':memory:' });
  const alice = await signedUpAgent(app, 'alice');
  await signedUpAgent(app, 'bob');

  await alice.post('/api/directs').send({ username: 'ghost' }).expect(404);
  await alice.post('/api/directs').send({ username: 'alice' }).expect(400);
  const first = (await alice.post('/api/directs').send({ username: 'bob' }).expect(200)).body;
  assert.equal(first.other_username, 'bob');
  const second = (await alice.post('/api/directs').send({ username: 'bob' }).expect(200)).body;
  assert.equal(second.id, first.id);
});

test('message history is members-only', async () => {
  const { app, db } = createServer({ dbFile: ':memory:' });
  const alice = await signedUpAgent(app, 'alice');
  const bob = await signedUpAgent(app, 'bob');
  const room = (await alice.post('/api/rooms').send({ name: 'secret' }).expect(200)).body;

  await bob.get(`/api/rooms/${room.id}/messages`).expect(403);
  const empty = (await alice.get(`/api/rooms/${room.id}/messages`).expect(200)).body;
  assert.deepEqual(empty, []);

  db.createMessage({ roomId: room.id, senderId: 1, kind: 'text', body: 'hello 🎉' });
  const msgs = (await alice.get(`/api/rooms/${room.id}/messages`).expect(200)).body;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].body, 'hello 🎉');
});
```

- [ ] **Step 2: Run tests** — `npm test` — Expected: new tests FAIL (404s where 401/200 expected — router not mounted).

- [ ] **Step 3: Write `src/rooms.js`**

```js
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
```

Note: `router.use('/api', requireLogin)` runs after `authRoutes` is mounted, so signup/login/logout stay public — mount order in `server.js` matters (auth first).

- [ ] **Step 4: Mount in `src/server.js`** — add import and mount after `authRoutes`:

```js
const { roomRoutes } = require('./rooms');
// ... after app.use(authRoutes(db)):
app.use(roomRoutes(db));
```

- [ ] **Step 5: Run tests** — `npm test` — Expected: PASS (13 tests).

- [ ] **Step 6: Commit**

```bash
git add src/rooms.js src/server.js tests/rooms.test.js
git commit -m "feat: room, join-code and direct-chat endpoints"
```

---

### Task 5: Real-time messaging + presence (Socket.IO)

**Files:**
- Create: `src/socket.js`
- Modify: `src/server.js` (attach sockets)
- Test: `tests/socket.test.js`

**Interfaces:**
- Consumes: db methods; `sessionMiddleware` and `httpServer` from `createServer`.
- Produces: `src/socket.js` exports `{ attachSocket(httpServer, sessionMiddleware, db) → io }`.
  - Server events emitted: `online_list` (array of user ids, sent on connect), `presence` (`{userId, online}`), `new_message` (message row + `temp_id` passthrough).
  - Client events handled: `sync_rooms` (re-join socket rooms after creating/joining via REST), `send_message` (`{roomId, kind, body, tempId}`, ack `{ok, id}` or `{error}`).
  - Unauthenticated sockets are disconnected immediately.

- [ ] **Step 1: Write failing test** — `tests/socket.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { io } = require('socket.io-client');
const { createServer } = require('../src/server');

function waitFor(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

function connect(port, cookie) {
  return io(`http://localhost:${port}`, {
    extraHeaders: { Cookie: cookie },
    transports: ['polling'],
    forceNew: true,
  });
}

test('real-time message delivery between two users', async () => {
  const { app, httpServer } = createServer({ dbFile: ':memory:' });
  await new Promise((r) => httpServer.listen(0, r));
  const port = httpServer.address().port;

  const agentA = request.agent(app);
  const agentB = request.agent(app);
  const resA = await agentA.post('/api/signup').send({ username: 'alice', password: 'password123' }).expect(200);
  const resB = await agentB.post('/api/signup').send({ username: 'bob', password: 'password123' }).expect(200);
  const cookieA = resA.headers['set-cookie'][0].split(';')[0];
  const cookieB = resB.headers['set-cookie'][0].split(';')[0];
  const room = (await agentA.post('/api/directs').send({ username: 'bob' }).expect(200)).body;

  const sockA = connect(port, cookieA);
  const sockB = connect(port, cookieB);
  try {
    await Promise.all([waitFor(sockA, 'connect'), waitFor(sockB, 'connect')]);

    const incoming = waitFor(sockB, 'new_message');
    const ack = await new Promise((resolve) =>
      sockA.emit('send_message', { roomId: room.id, kind: 'text', body: 'hi bob 👋', tempId: 't1' }, resolve));
    assert.equal(ack.ok, true);
    const msg = await incoming;
    assert.equal(msg.body, 'hi bob 👋');
    assert.equal(msg.sender_username, 'alice');
    assert.equal(msg.temp_id, 't1');

    const badAck = await new Promise((resolve) =>
      sockA.emit('send_message', { roomId: 9999, kind: 'text', body: 'sneaky' }, resolve));
    assert.ok(badAck.error);
  } finally {
    sockA.close();
    sockB.close();
    await new Promise((r) => httpServer.close(r));
  }
});

test('unauthenticated sockets are rejected', async () => {
  const { httpServer } = createServer({ dbFile: ':memory:' });
  await new Promise((r) => httpServer.listen(0, r));
  const port = httpServer.address().port;
  const sock = io(`http://localhost:${port}`, { transports: ['polling'], forceNew: true });
  try {
    await waitFor(sock, 'disconnect');
    assert.ok(true);
  } finally {
    sock.close();
    await new Promise((r) => httpServer.close(r));
  }
});
```

- [ ] **Step 2: Run tests** — `npm test` — Expected: socket tests FAIL/time out (no Socket.IO server attached).

- [ ] **Step 3: Write `src/socket.js`**

```js
const { Server } = require('socket.io');

const MAX_TEXT = 2000;
const MAX_IMAGE = 700000; // data-URL chars, ~500 KB

function attachSocket(httpServer, sessionMiddleware, db) {
  const io = new Server(httpServer, { maxHttpBufferSize: 1e6 });
  io.engine.use(sessionMiddleware);

  const online = new Map(); // userId -> open socket count

  io.on('connection', (socket) => {
    const session = socket.request.session;
    const userId = session && session.userId;
    if (!userId) {
      socket.disconnect(true);
      return;
    }

    online.set(userId, (online.get(userId) || 0) + 1);
    if (online.get(userId) === 1) io.emit('presence', { userId, online: true });
    socket.emit('online_list', [...online.keys()]);

    const joinRooms = () => {
      for (const room of db.listRoomsForUser(userId)) socket.join(`room:${room.id}`);
    };
    joinRooms();
    socket.on('sync_rooms', joinRooms);

    socket.on('send_message', (payload, ack = () => {}) => {
      try {
        const { roomId, kind, body, tempId } = payload || {};
        if (!db.isMember(roomId, userId)) return ack({ error: 'Not a member of this chat' });
        if (kind !== 'text' && kind !== 'image') return ack({ error: 'Unknown message type' });
        if (typeof body !== 'string' || !body.trim()) return ack({ error: 'Empty message' });
        if (kind === 'text' && body.length > MAX_TEXT) return ack({ error: 'Message too long' });
        if (kind === 'image' && (!body.startsWith('data:image/') || body.length > MAX_IMAGE)) {
          return ack({ error: 'Image too big' });
        }
        const msg = db.createMessage({ roomId, senderId: userId, kind, body });
        io.to(`room:${roomId}`).emit('new_message', { ...msg, temp_id: tempId || null });
        ack({ ok: true, id: msg.id });
      } catch (err) {
        console.error('send_message failed:', err);
        ack({ error: 'Server error, try again' });
      }
    });

    socket.on('disconnect', () => {
      const count = (online.get(userId) || 1) - 1;
      if (count <= 0) {
        online.delete(userId);
        io.emit('presence', { userId, online: false });
      } else {
        online.set(userId, count);
      }
    });
  });

  return io;
}

module.exports = { attachSocket };
```

- [ ] **Step 4: Attach in `src/server.js`** — add import and, just after `const httpServer = http.createServer(app);`:

```js
const { attachSocket } = require('./socket');
// ...
attachSocket(httpServer, sessionMiddleware, db);
```

- [ ] **Step 5: Run tests** — `npm test` — Expected: PASS (15 tests).

- [ ] **Step 6: Commit**

```bash
git add src/socket.js src/server.js tests/socket.test.js
git commit -m "feat: real-time messages and presence over Socket.IO"
```

---

### Task 6: Frontend — login and home screens

**Files:**
- Create: `public/index.html`, `public/style.css`, `public/app.js`

**Interfaces:**
- Consumes: all REST endpoints from Tasks 3–4; socket events from Task 5.
- Produces: complete HTML for all three screens and full CSS (Task 7 only edits `app.js`). `app.js` globals Task 7 relies on: `me`, `chats`, `currentRoom`, `socket`, `online` (Set), helpers `api(path, body)`, `showScreen(id)`, `chatLabel(chat)`, `loadChats()`, `renderChats()`, `connectSocket()`, and a stub `openChat(chat)`.

- [ ] **Step 1: Write `public/index.html`** (all three screens now, including chat markup Task 7 will wire up)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BellaChat</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="conn-banner" class="hidden">connecting…</div>

  <div id="screen-auth" class="screen">
    <h1>💬 BellaChat</h1>
    <form id="auth-form" class="card">
      <input id="auth-username" placeholder="username" autocomplete="username" maxlength="20" required>
      <input id="auth-password" type="password" placeholder="password (8+ characters)" autocomplete="current-password" required>
      <p id="auth-error" class="error"></p>
      <button type="submit">Log in</button>
      <button type="button" id="btn-signup" class="secondary">Sign up</button>
    </form>
  </div>

  <div id="screen-home" class="screen hidden">
    <header>
      <h1>💬 BellaChat</h1>
      <div><b id="home-me"></b> <button id="btn-logout" class="secondary">Log out</button></div>
    </header>
    <p id="home-error" class="error"></p>
    <section class="card">
      <h2>Friends</h2>
      <ul id="list-directs" class="chat-list"></ul>
      <form id="form-new-direct" class="row">
        <input id="new-direct-username" placeholder="friend's exact username" maxlength="20">
        <button>Chat</button>
      </form>
    </section>
    <section class="card">
      <h2>Rooms</h2>
      <ul id="list-rooms" class="chat-list"></ul>
      <form id="form-new-room" class="row">
        <input id="new-room-name" placeholder="new room name" maxlength="40">
        <button>Create</button>
      </form>
      <form id="form-join-room" class="row">
        <input id="join-room-code" placeholder="room code (e.g. X7K2PQ)" maxlength="6">
        <button>Join</button>
      </form>
    </section>
  </div>

  <div id="screen-chat" class="screen hidden">
    <header>
      <button id="btn-back" class="secondary">←</button>
      <h2 id="chat-title"></h2>
      <span id="chat-code" class="muted"></span>
    </header>
    <div id="messages"></div>
    <div id="emoji-picker" class="hidden"></div>
    <form id="form-send" class="row">
      <button type="button" id="btn-emoji" class="secondary">😊</button>
      <label id="btn-image" class="secondary button-like">🖼️<input type="file" id="image-input" accept="image/*" hidden></label>
      <input id="message-input" placeholder="Type a message…" autocomplete="off" maxlength="2000">
      <button type="submit">Send</button>
    </form>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `public/style.css`**

```css
* { box-sizing: border-box; }
body {
  margin: 0; background: #eef1f7; color: #1c2333;
  font-family: -apple-system, "Segoe UI", Roboto, "Noto Color Emoji", sans-serif;
}
.screen { max-width: 560px; margin: 0 auto; padding: 16px; min-height: 100dvh; display: flex; flex-direction: column; gap: 12px; }
.hidden { display: none !important; }
h1 { font-size: 1.5rem; margin: 8px 0; }
h2 { font-size: 1.05rem; margin: 0 0 8px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.card { background: #fff; border-radius: 12px; padding: 14px; box-shadow: 0 1px 4px rgba(20,30,60,.08); display: flex; flex-direction: column; gap: 8px; }
.row { display: flex; gap: 6px; }
.row input { flex: 1; }
input { padding: 10px; border: 1px solid #c9d0e0; border-radius: 8px; font-size: 1rem; }
button, .button-like {
  padding: 10px 14px; border: 0; border-radius: 8px; font-size: 1rem; cursor: pointer;
  background: #4a63e7; color: #fff;
}
button.secondary, .button-like { background: #e4e8f5; color: #1c2333; }
.error { color: #c0392b; min-height: 1em; margin: 0; }
.muted { color: #7a86a3; font-size: .85rem; }
#conn-banner { position: fixed; top: 0; left: 0; right: 0; background: #f5a623; color: #fff; text-align: center; padding: 4px; z-index: 10; }
.chat-list { list-style: none; margin: 0; padding: 0; }
.chat-list li { display: flex; align-items: center; gap: 8px; padding: 10px 6px; border-bottom: 1px solid #eef1f7; cursor: pointer; }
.chat-list li:hover { background: #f5f7fc; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: #c9d0e0; flex-shrink: 0; }
.dot.online { background: #2ecc71; }
#screen-chat { height: 100dvh; }
#messages { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 4px; }
.msg { max-width: 80%; align-self: flex-start; }
.msg.mine { align-self: flex-end; text-align: right; }
.msg .who { font-size: .75rem; color: #7a86a3; margin-bottom: 2px; }
.msg .bubble { background: #fff; padding: 8px 12px; border-radius: 12px; box-shadow: 0 1px 3px rgba(20,30,60,.08); display: inline-block; text-align: left; overflow-wrap: anywhere; }
.msg.mine .bubble { background: #4a63e7; color: #fff; }
.msg.pending .bubble { opacity: .5; }
.msg.failed .bubble { background: #fdecea; color: #c0392b; cursor: pointer; }
.msg .bubble img { max-width: 100%; border-radius: 8px; display: block; }
#emoji-picker { background: #fff; border-radius: 12px; padding: 8px; display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px; max-height: 180px; overflow-y: auto; }
#emoji-picker button { background: none; font-size: 1.3rem; padding: 4px; }
```

- [ ] **Step 3: Write `public/app.js`** (auth + home + socket; `openChat` is a stub until Task 7)

```js
/* global io */
const $ = (id) => document.getElementById(id);

let me = null;
let chats = [];
let currentRoom = null;
let socket = null;
const online = new Set();

// ---------- helpers ----------
async function api(path, body) {
  const opts = body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
  $(id).classList.remove('hidden');
}

function chatLabel(chat) {
  return chat.is_direct ? chat.other_username : chat.name;
}

// ---------- auth ----------
async function handleAuth(path) {
  $('auth-error').textContent = '';
  try {
    me = await api(path, {
      username: $('auth-username').value.trim(),
      password: $('auth-password').value,
    });
    enterApp();
  } catch (err) {
    $('auth-error').textContent = err.message;
  }
}
$('auth-form').addEventListener('submit', (e) => { e.preventDefault(); handleAuth('/api/login'); });
$('btn-signup').addEventListener('click', () => handleAuth('/api/signup'));
$('btn-logout').addEventListener('click', async () => {
  await api('/api/logout', {});
  location.reload();
});

// ---------- home ----------
async function enterApp() {
  $('home-me').textContent = me.username;
  showScreen('screen-home');
  connectSocket();
  await loadChats();
}

async function loadChats() {
  chats = await api('/api/chats');
  renderChats();
}

function renderChats() {
  const directs = $('list-directs');
  const rooms = $('list-rooms');
  directs.innerHTML = '';
  rooms.innerHTML = '';
  for (const chat of chats) {
    const li = document.createElement('li');
    if (chat.is_direct) {
      const dot = document.createElement('span');
      dot.className = 'dot' + (online.has(chat.other_user_id) ? ' online' : '');
      li.append(dot);
    }
    const label = document.createElement('span');
    label.textContent = chatLabel(chat) || '(room)';
    li.append(label);
    if (!chat.is_direct && chat.code) {
      const code = document.createElement('span');
      code.className = 'muted';
      code.textContent = chat.code;
      li.append(code);
    }
    li.addEventListener('click', () => openChat(chat));
    (chat.is_direct ? directs : rooms).append(li);
  }
}

async function homeAction(fn) {
  $('home-error').textContent = '';
  try {
    await fn();
  } catch (err) {
    $('home-error').textContent = err.message;
  }
}

$('form-new-direct').addEventListener('submit', (e) => {
  e.preventDefault();
  homeAction(async () => {
    const room = await api('/api/directs', { username: $('new-direct-username').value.trim() });
    $('new-direct-username').value = '';
    socket.emit('sync_rooms');
    await loadChats();
    openChat({ ...room, is_direct: 1 });
  });
});

$('form-new-room').addEventListener('submit', (e) => {
  e.preventDefault();
  homeAction(async () => {
    const room = await api('/api/rooms', { name: $('new-room-name').value.trim() });
    $('new-room-name').value = '';
    socket.emit('sync_rooms');
    await loadChats();
    openChat(room);
  });
});

$('form-join-room').addEventListener('submit', (e) => {
  e.preventDefault();
  homeAction(async () => {
    const room = await api('/api/rooms/join', { code: $('join-room-code').value.trim() });
    $('join-room-code').value = '';
    socket.emit('sync_rooms');
    await loadChats();
    openChat(room);
  });
});

// ---------- chat (completed in the next task) ----------
function openChat(chat) {
  currentRoom = chat;
}

// ---------- socket ----------
function connectSocket() {
  if (socket) return;
  socket = io();
  socket.on('connect', () => $('conn-banner').classList.add('hidden'));
  socket.on('disconnect', () => $('conn-banner').classList.remove('hidden'));
  socket.on('online_list', (ids) => {
    online.clear();
    ids.forEach((id) => online.add(id));
    renderChats();
  });
  socket.on('presence', ({ userId, online: isOnline }) => {
    if (isOnline) online.add(userId); else online.delete(userId);
    renderChats();
  });
}

// ---------- boot ----------
(async () => {
  try {
    me = await api('/api/me');
    enterApp();
  } catch {
    showScreen('screen-auth');
  }
})();
```

- [ ] **Step 4: Manual verification**

Run: `npm start`, open `http://localhost:3000` in a browser.
Check: sign up as `bella` → lands on home showing the username; log out → back to login; wrong password → inline error; create room `test` → it appears under Rooms with a 6-char code (clicking it does nothing yet — that's Task 7); in a private window sign up as `friend`, start a chat with `bella` → `bella` appears under Friends with a green dot. Stop the server → orange "connecting…" banner appears; restart → banner disappears.

- [ ] **Step 5: Commit**

```bash
git add public/
git commit -m "feat: login and home screens"
```

---

### Task 7: Frontend — chat view, emoji picker, pictures

**Files:**
- Modify: `public/app.js` (replace the `openChat` stub; add chat-view code before the `// ---------- socket ----------` section; add one handler inside `connectSocket`)

**Interfaces:**
- Consumes: globals/helpers from Task 6; `GET /api/rooms/:id/messages`; socket `send_message` (with `tempId`) / `new_message` (with `temp_id`) from Task 5.
- Produces: working chat UI — history, live messages, pending/failed states with tap-to-retry, emoji picker, image sending with client-side resize.

- [ ] **Step 1: Replace the `openChat` stub in `public/app.js` with the full chat section**

```js
// ---------- chat ----------
const pending = new Map(); // tempId -> message element
let tempCounter = 0;

async function openChat(chat) {
  currentRoom = chat;
  $('chat-title').textContent = chatLabel(chat) || '(room)';
  $('chat-code').textContent = chat.code ? `code: ${chat.code}` : '';
  $('messages').innerHTML = '';
  $('emoji-picker').classList.add('hidden');
  showScreen('screen-chat');
  try {
    const history = await api(`/api/rooms/${chat.id}/messages`);
    for (const m of history) appendMessage(m);
  } catch (err) {
    $('chat-title').textContent = err.message;
  }
}

$('btn-back').addEventListener('click', () => {
  currentRoom = null;
  showScreen('screen-home');
  loadChats();
});

function appendMessage(m, extraClass = '') {
  const div = document.createElement('div');
  div.className = `msg ${m.sender_id === me.id ? 'mine' : ''} ${extraClass}`.trim();
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = m.sender_username;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (m.kind === 'image' && m.body.startsWith('data:image/')) {
    const img = document.createElement('img');
    img.src = m.body;
    bubble.append(img);
  } else {
    bubble.textContent = m.body; // textContent = no HTML injection
  }
  div.append(who, bubble);
  $('messages').append(div);
  $('messages').scrollTop = $('messages').scrollHeight;
  return div;
}

function sendMessage(kind, body) {
  const tempId = `t${++tempCounter}`;
  const el = appendMessage(
    { sender_id: me.id, sender_username: me.username, kind, body },
    'pending'
  );
  pending.set(tempId, el);
  emitSend(tempId, kind, body, el);
}

function emitSend(tempId, kind, body, el) {
  el.classList.remove('failed');
  el.classList.add('pending');
  socket.emit('send_message', { roomId: currentRoom.id, kind, body, tempId }, (resp) => {
    if (!resp || resp.error) {
      el.classList.remove('pending');
      el.classList.add('failed');
      el.title = (resp && resp.error) || 'Failed — tap to retry';
      el.onclick = () => emitSend(tempId, kind, body, el);
    }
    // on success the new_message broadcast replaces this element (see connectSocket)
  });
}

$('form-send').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('message-input').value.trim();
  if (!text || !currentRoom) return;
  $('message-input').value = '';
  sendMessage('text', text);
});

// ---------- images ----------
$('image-input').addEventListener('change', async () => {
  const file = $('image-input').files[0];
  $('image-input').value = '';
  if (!file || !currentRoom) return;
  try {
    const dataUrl = await resizeImage(file);
    if (dataUrl.length > 700000) throw new Error('Image is too big even after shrinking');
    sendMessage('image', dataUrl);
  } catch (err) {
    alert(err.message || 'Could not read that image');
  }
});

function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = URL.createObjectURL(file);
  });
}

// ---------- emoji picker ----------
const EMOJIS = ('😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😍 🥰 😘 😜 🤪 😎 🤩 🥳 😏 😴 🤔 🤗 🤭 🤫 😬 🙄 😱 😭 🥺 😡 🤯 🤠 🥶 😈 👻 🤖 💩 ' +
  '👍 👎 👏 🙌 🙏 💪 🤝 ✌️ 🤞 👀 ❤️ 🧡 💛 💚 💙 💜 🖤 💯 🔥 ⭐ ✨ 🎉 🎂 🎁 ⚽ 🏀 🎮 🎧 🍕 🍟 🍦 🍩 🐶 🐱 🦄 🌈 ☀️ 🌙 💤').split(' ');

const picker = $('emoji-picker');
for (const emoji of EMOJIS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = emoji;
  b.addEventListener('click', () => {
    $('message-input').value += emoji;
    $('message-input').focus();
  });
  picker.append(b);
}
$('btn-emoji').addEventListener('click', () => picker.classList.toggle('hidden'));
```

(Note for the implementer: the EMOJIS string must contain only real emoji separated by single spaces — type it carefully, roughly 80 common emoji covering faces, hands, hearts, activities, food, animals. If any entry renders as a broken character, remove it.)

- [ ] **Step 2: Add the `new_message` handler inside `connectSocket()`** (after the `presence` handler)

```js
  socket.on('new_message', (m) => {
    if (m.temp_id && pending.has(m.temp_id)) {
      pending.get(m.temp_id).remove(); // replace optimistic bubble with the real one
      pending.delete(m.temp_id);
    }
    if (currentRoom && m.room_id === currentRoom.id) appendMessage(m);
  });
```

- [ ] **Step 3: Manual verification (two browser windows)**

Run: `npm start`. Window 1: log in as `bella`; window 2 (private/incognito): log in as `friend`.
Check, in both directions:
1. Open the 1-on-1 chat on both sides; send text — it appears instantly on both sides, right-aligned blue for the sender.
2. Emoji button opens the picker; clicking an emoji inserts it into the input; send works.
3. Send a photo — it shows inline in both windows within a couple of seconds.
4. Create a room in window 1, join it by code in window 2, chat there.
5. History: reload a window, reopen the chat — old messages load.
6. Presence: close window 2 → green dot next to `friend` turns grey in window 1.
7. Failure path: stop the server, send a message → bubble turns red/failed; restart server, tap the bubble → it sends.
8. Injection check: send `<b>hi</b>` — it must display literally, not bold.

- [ ] **Step 4: Commit**

```bash
git add public/app.js
git commit -m "feat: chat view with emoji picker and pictures"
```

---

### Task 8: Deployment config + README

**Files:**
- Create: `render.yaml`, `README.md`

**Interfaces:**
- Consumes: `npm start` script and `PORT`/`SESSION_SECRET` env vars from earlier tasks.

- [ ] **Step 1: Create `render.yaml`**

```yaml
services:
  - type: web
    name: bellachat
    runtime: node
    plan: free
    buildCommand: npm install
    startCommand: npm start
    envVars:
      - key: SESSION_SECRET
        generateValue: true
```

- [ ] **Step 2: Create `README.md`**

```markdown
# 💬 BellaChat

A private chat website for friends. Username + password accounts, 1-on-1
chats, group rooms with join codes, emoji, and pictures — all your own code.

## Run it on your computer

```bash
npm install
npm start
```

Open http://localhost:3000. To chat with yourself for testing, open a
second private/incognito window and sign up as a different user.

## Run the tests

```bash
npm test
```

## Put it on the internet (Render, free)

1. Push this repo to GitHub (private repo is fine).
2. Sign up at https://render.com (free).
3. New → Blueprint → connect the repo. Render reads `render.yaml` and
   deploys automatically.
4. Share your link (like `https://bellachat.onrender.com`) with friends.

**Free-tier fine print:** the app falls asleep after ~15 minutes with no
visitors — the first person to open it waits ~30 seconds while it wakes up.
Accounts and chat history reset whenever the app is redeployed or
restarted, because the free tier has no permanent disk. Everyone just
signs up again. If that gets annoying, the fix is swapping SQLite for a
free hosted database — all database code lives in `src/db.js`.

## Forgot password?

There's no reset flow on purpose (keeps things simple). Since history
resets on redeploys anyway, the friend can simply sign up again with a
new name — or with the same name after the next reset.
```

- [ ] **Step 3: Full check**

Run: `npm test` — Expected: all tests PASS.
Run: `npm start`, open the site once more, click through login → home → a chat.

- [ ] **Step 4: Commit**

```bash
git add render.yaml README.md
git commit -m "feat: Render deployment config and README"
```
