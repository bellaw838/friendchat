# Friends System + Verification Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Friend requests (exact-username add → accept/decline), friends-gated 1-on-1 chats, WhatsApp-style friends UI on web, and a dormant sign-up verification seam (OFF during testing).

**Architecture:** A `friendships` table stores one row per user pair (always `user_lo < user_hi`) with `status` and `requested_by`. `src/friends.js` exposes the REST endpoints and emits `friends_changed` to both users' `user:<id>` socket rooms after every change; clients respond by refetching. `POST /api/directs` gains an `areFriends` gate. `src/verify.js` reads `REQUIRE_VERIFICATION` (default off) so sign-up is untouched today.

**Tech Stack:** unchanged — Node 18+, Express 4, Socket.IO 4, better-sqlite3, vanilla JS frontend, `node --test` + supertest + socket.io-client.

**Spec:** `docs/superpowers/specs/2026-08-13-friends-verification-design.md`

## Global Constraints

- Friendships: one row per pair, `user_lo < user_hi` ALWAYS (normalize in every method); `status` in (`pending`,`accepted`); `requested_by` records the asker. Mutual pending auto-accepts. Only the addressee (`requested_by !== userId`) can respond.
- Exact-username lookup only (reuse `db.getUserByUsername`); no partial search anywhere.
- `POST /api/directs`: creating a NEW direct room requires `areFriends`; if the room already exists, members keep access regardless (403 message exactly `You need to be friends first`).
- `friends_changed` is an empty-payload poke to both users' `user:<id>` rooms; clients refetch `GET /api/friends`.
- `users` gains `email` TEXT NULL, `phone` TEXT NULL, `verified` INTEGER NOT NULL DEFAULT 1. `REQUIRE_VERIFICATION` env: `'1'`/`'true'` (case-insensitive) = on; anything else = off. With it on but unconfigured, signup returns 503 `{error}`; with it off (default), signup behavior is byte-identical to today.
- Errors always `{error: "message"}` JSON. CommonJS. Tests via `npm test` (`node --test`).
- **Commits:** each task ends with a commit step; if the controller has been told not to commit, the implementer skips ONLY the `git` commands and says so in its report.

---

### Task 1: DB — friendships table, user columns, friend methods

**Files:**
- Modify: `src/db.js`
- Test: `tests/db.test.js` (append + one edit to the existing migration test)

**Interfaces:**
- Consumes: existing `createDb`.
- Produces (on the createDb object): `requestFriend(fromId, toId) → {status, already?}`, `respondFriend(userId, otherId, accept) → boolean`, `removeFriend(userId, otherId)`, `areFriends(a, b) → boolean`, `listFriends(userId) → [{user_id, username, status, requested_by}]`. `users` rows now include `email`, `phone`, `verified`.

- [ ] **Step 1: Append failing tests to `tests/db.test.js`**

```js
test('friend requests: pair normalization and mutual-pending auto-accept', () => {
  const db = createDb(':memory:');
  const a = db.createUser('alice', 'x');
  const b = db.createUser('bob', 'x');
  assert.deepEqual(db.requestFriend(b.id, a.id), { status: 'pending' });
  assert.equal(db.areFriends(a.id, b.id), false);
  // duplicate request from same side: still pending, flagged already
  assert.equal(db.requestFriend(b.id, a.id).already, true);
  // reverse request = mutual pending -> auto-accept
  assert.deepEqual(db.requestFriend(a.id, b.id), { status: 'accepted' });
  assert.equal(db.areFriends(a.id, b.id), true);
  assert.equal(db.areFriends(b.id, a.id), true);
  // requesting an accepted friend: already accepted
  const again = db.requestFriend(a.id, b.id);
  assert.equal(again.status, 'accepted');
  assert.equal(again.already, true);
  assert.throws(() => db.requestFriend(a.id, a.id));
});

test('respondFriend: only the addressee can accept or decline', () => {
  const db = createDb(':memory:');
  const a = db.createUser('alice', 'x');
  const b = db.createUser('bob', 'x');
  db.requestFriend(a.id, b.id);
  assert.equal(db.respondFriend(a.id, b.id, true), false); // asker cannot self-accept
  assert.equal(db.respondFriend(b.id, a.id, true), true);
  assert.equal(db.areFriends(a.id, b.id), true);
  // decline path
  const c = db.createUser('cara', 'x');
  db.requestFriend(a.id, c.id);
  assert.equal(db.respondFriend(c.id, a.id, false), true);
  assert.equal(db.areFriends(a.id, c.id), false);
  assert.equal(db.respondFriend(c.id, a.id, false), false); // nothing left to respond to
});

test('removeFriend, listFriends buckets, and new user columns', () => {
  const db = createDb(':memory:');
  const a = db.createUser('alice', 'x');
  const b = db.createUser('bob', 'x');
  const c = db.createUser('cara', 'x');
  db.requestFriend(a.id, b.id);
  db.respondFriend(b.id, a.id, true);
  db.requestFriend(c.id, a.id);
  const list = db.listFriends(a.id);
  assert.equal(list.length, 2);
  const bob = list.find((r) => r.user_id === b.id);
  assert.equal(bob.status, 'accepted');
  assert.equal(bob.username, 'bob');
  const cara = list.find((r) => r.user_id === c.id);
  assert.equal(cara.status, 'pending');
  assert.equal(cara.requested_by, c.id);
  db.removeFriend(b.id, a.id);
  assert.equal(db.areFriends(a.id, b.id), false);
  db.removeFriend(b.id, a.id); // idempotent
  assert.equal(db.getUserByUsername('alice').verified, 1);
  assert.equal(db.getUserByUsername('alice').email, null);
  assert.equal(db.getUserByUsername('alice').phone, null);
});
```

- [ ] **Step 2: Extend the existing migration test** — in `'v1 database migrates: image bodies masked, media_note insertable'`, just before the cleanup `for (const suffix ...)` loop, add:

```js
  // Phase 2a migration: new user columns arrive with sane defaults, friendships usable
  assert.equal(db.getUserByUsername('alice').verified, 1);
  const b2 = db.createUser('bob2', 'x');
  db.requestFriend(1, b2.id);
  assert.equal(db.respondFriend(b2.id, 1, true), true);
  assert.equal(db.areFriends(1, b2.id), true);
```

- [ ] **Step 3: Run tests** — `npm test` — Expected: new tests FAIL (`db.requestFriend is not a function`; missing columns).

- [ ] **Step 4: Update `src/db.js`**

4a. In `SCHEMA`, extend the `users` table definition (after `is_bot`):

```sql
  is_bot INTEGER NOT NULL DEFAULT 0,
  email TEXT,
  phone TEXT,
  verified INTEGER NOT NULL DEFAULT 1,
```

4b. In `SCHEMA`, add after the `messages` index line:

```sql
CREATE TABLE IF NOT EXISTS friendships (
  user_lo INTEGER NOT NULL REFERENCES users(id),
  user_hi INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('pending','accepted')),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_lo, user_hi)
);
```

(`CREATE TABLE IF NOT EXISTS` in SCHEMA covers old database files too — no table-rebuild migration needed for friendships.)

4c. In `migrate`, after the `is_bot` block, add the new column back-fills (reuses the `userCols` array already computed above):

```js
  const userAdds = [
    ['email', 'ALTER TABLE users ADD COLUMN email TEXT'],
    ['phone', 'ALTER TABLE users ADD COLUMN phone TEXT'],
    ['verified', 'ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 1'],
  ];
  for (const [col, ddl] of userAdds) {
    if (userCols.length && !userCols.includes(col)) db.exec(ddl);
  }
```

4d. Add the friend methods to the returned object (before the closing `};`):

```js
    requestFriend(fromId, toId) {
      if (fromId === toId) throw new Error('cannot friend yourself');
      const [lo, hi] = fromId < toId ? [fromId, toId] : [toId, fromId];
      const row = db.prepare('SELECT * FROM friendships WHERE user_lo = ? AND user_hi = ?').get(lo, hi);
      if (!row) {
        db.prepare("INSERT INTO friendships (user_lo, user_hi, status, requested_by) VALUES (?, ?, 'pending', ?)")
          .run(lo, hi, fromId);
        return { status: 'pending' };
      }
      if (row.status === 'accepted') return { status: 'accepted', already: true };
      if (row.requested_by === fromId) return { status: 'pending', already: true };
      db.prepare("UPDATE friendships SET status = 'accepted' WHERE user_lo = ? AND user_hi = ?").run(lo, hi);
      return { status: 'accepted' };
    },
    respondFriend(userId, otherId, accept) {
      const [lo, hi] = userId < otherId ? [userId, otherId] : [otherId, userId];
      const row = db.prepare("SELECT * FROM friendships WHERE user_lo = ? AND user_hi = ? AND status = 'pending'").get(lo, hi);
      if (!row || row.requested_by === userId) return false;
      if (accept) {
        db.prepare("UPDATE friendships SET status = 'accepted' WHERE user_lo = ? AND user_hi = ?").run(lo, hi);
      } else {
        db.prepare('DELETE FROM friendships WHERE user_lo = ? AND user_hi = ?').run(lo, hi);
      }
      return true;
    },
    removeFriend(userId, otherId) {
      const [lo, hi] = userId < otherId ? [userId, otherId] : [otherId, userId];
      db.prepare('DELETE FROM friendships WHERE user_lo = ? AND user_hi = ?').run(lo, hi);
    },
    areFriends(a, b) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      return !!db.prepare("SELECT 1 FROM friendships WHERE user_lo = ? AND user_hi = ? AND status = 'accepted'").get(lo, hi);
    },
    listFriends(userId) {
      return db.prepare(`
        SELECT CASE WHEN f.user_lo = ? THEN f.user_hi ELSE f.user_lo END AS user_id,
               u.username, f.status, f.requested_by
        FROM friendships f
        JOIN users u ON u.id = CASE WHEN f.user_lo = ? THEN f.user_hi ELSE f.user_lo END
        WHERE f.user_lo = ? OR f.user_hi = ?
        ORDER BY u.username
      `).all(userId, userId, userId, userId);
    },
```

- [ ] **Step 5: Run tests** — `npm test` — Expected: all pass (24 total).

- [ ] **Step 6: Commit** (skip if the controller said no commits — note it in your report)

```bash
git add src/db.js tests/db.test.js
git commit -m "feat: friendships table and friend methods, user contact columns"
```

---

### Task 2: Verification seam (dormant)

**Files:**
- Create: `src/verify.js`
- Modify: `src/auth.js`
- Test: `tests/verify.test.js` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `src/verify.js` exports `{ isRequired() → boolean, sendCode(destination), checkCode(destination, code) }` (the latter two throw until wired). `POST /api/signup` returns 503 `{error}` when `isRequired()` is true; unchanged otherwise.

- [ ] **Step 1: Write failing tests** — `tests/verify.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const verify = require('../src/verify');
const { createServer } = require('../src/server');

test('verification is off by default and honors the env flag', () => {
  delete process.env.REQUIRE_VERIFICATION;
  assert.equal(verify.isRequired(), false);
  for (const on of ['1', 'true', 'TRUE', 'True']) {
    process.env.REQUIRE_VERIFICATION = on;
    assert.equal(verify.isRequired(), true, `expected on for ${on}`);
  }
  for (const off of ['', '0', 'false', 'no']) {
    process.env.REQUIRE_VERIFICATION = off;
    assert.equal(verify.isRequired(), false, `expected off for ${JSON.stringify(off)}`);
  }
  delete process.env.REQUIRE_VERIFICATION;
});

test('signup works normally with the flag off, 503 with it on', async () => {
  delete process.env.REQUIRE_VERIFICATION;
  const { app } = createServer({ dbFile: ':memory:' });
  await request.agent(app).post('/api/signup')
    .send({ username: 'bella', password: 'password123' }).expect(200);
  try {
    process.env.REQUIRE_VERIFICATION = '1';
    const res = await request.agent(app).post('/api/signup')
      .send({ username: 'friend', password: 'password123' }).expect(503);
    assert.match(res.body.error, /not configured/i);
  } finally {
    delete process.env.REQUIRE_VERIFICATION;
  }
});
```

- [ ] **Step 2: Run tests** — `npm test` — Expected: FAIL (no `../src/verify`).

- [ ] **Step 3: Create `src/verify.js`**

```js
// Sign-up verification seam — OFF by default during the testing period.
//
// To enable later:
//   1. Set REQUIRE_VERIFICATION=1 in the environment.
//   2. Implement sendCode/checkCode against a provider. Email is the cheap
//      path (SMTP or an email API); SMS costs real money per message.
//      Generate a 6-digit code, store it with a short expiry (an in-memory
//      Map is fine at friend scale), email/text it to `destination`.
//   3. In the signup route: collect email or phone, create the account with
//      verified = 0, call sendCode; add a /api/verify route that calls
//      checkCode and flips users.verified to 1; block login while
//      verified = 0. Existing users (verified = 1) are unaffected.
function isRequired() {
  const v = String(process.env.REQUIRE_VERIFICATION || '').toLowerCase();
  return v === '1' || v === 'true';
}

function sendCode(destination) {
  throw new Error('Verification is not wired to a provider yet');
}

function checkCode(destination, code) {
  throw new Error('Verification is not wired to a provider yet');
}

module.exports = { isRequired, sendCode, checkCode };
```

- [ ] **Step 4: Wire into `src/auth.js`** — add `const verify = require('./verify');` under the bcrypt require, and as the FIRST statement inside the `/api/signup` handler:

```js
    if (verify.isRequired()) {
      return res.status(503).json({ error: 'Sign-up verification is enabled but not configured yet' });
    }
```

- [ ] **Step 5: Run tests** — `npm test` — Expected: all pass (26 total).

- [ ] **Step 6: Commit** (skip if the controller said no commits — note it in your report)

```bash
git add src/verify.js src/auth.js tests/verify.test.js
git commit -m "feat: dormant sign-up verification seam (off by default)"
```

---

### Task 3: Friends REST + friends_changed socket + directs gating

**Files:**
- Create: `src/friends.js`
- Modify: `src/rooms.js`, `src/server.js`
- Test: `tests/friends.test.js` (new)

**Interfaces:**
- Consumes: db friend methods (Task 1); `requireLogin`; `io` (`user:<id>` rooms already exist from the v1 fix).
- Produces: `src/friends.js` exports `{ friendRoutes(db, io) → express.Router }` with `GET /api/friends`, `POST /api/friends/request {username}`, `POST /api/friends/respond {userId, accept}`, `DELETE /api/friends/:userId` — all as specified in the spec, all emitting `friends_changed` `{}` to both users' `user:` rooms on change. `POST /api/directs` 403s (`You need to be friends first`) when creating a NEW room between non-friends.

- [ ] **Step 1: Write failing tests** — `tests/friends.test.js`

```js
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { io } = require('socket.io-client');
const { createServer } = require('../src/server');

async function signedUpAgent(app, username) {
  const agent = request.agent(app);
  const res = await agent.post('/api/signup').send({ username, password: 'password123' }).expect(200);
  agent.cookie = res.headers['set-cookie'][0].split(';')[0];
  return agent;
}

test('full friend flow: request, buckets, accept, unfriend', async () => {
  const { app } = createServer({ dbFile: ':memory:' });
  const alice = await signedUpAgent(app, 'alice');
  const bob = await signedUpAgent(app, 'bob');

  await alice.post('/api/friends/request').send({ username: 'ghost' }).expect(404);
  await alice.post('/api/friends/request').send({ username: 'alice' }).expect(400);

  const r1 = (await alice.post('/api/friends/request').send({ username: 'bob' }).expect(200)).body;
  assert.equal(r1.status, 'pending');

  const aliceView = (await alice.get('/api/friends').expect(200)).body;
  assert.deepEqual(aliceView.friends, []);
  assert.equal(aliceView.outgoing[0].username, 'bob');
  const bobView = (await bob.get('/api/friends').expect(200)).body;
  assert.equal(bobView.incoming[0].username, 'alice');

  const aliceId = bobView.incoming[0].id;
  await bob.post('/api/friends/respond').send({ userId: aliceId, accept: true }).expect(200);
  assert.equal((await alice.get('/api/friends').expect(200)).body.friends[0].username, 'bob');
  assert.equal((await bob.get('/api/friends').expect(200)).body.friends[0].username, 'alice');

  await alice.post('/api/friends/request').send({ username: 'bob' }).expect(409);

  const bobId = (await alice.get('/api/friends').expect(200)).body.friends[0].id;
  await alice.delete(`/api/friends/${bobId}`).expect(200);
  assert.deepEqual((await alice.get('/api/friends').expect(200)).body.friends, []);
});

test('decline and cancel', async () => {
  const { app } = createServer({ dbFile: ':memory:' });
  const alice = await signedUpAgent(app, 'alice');
  const bob = await signedUpAgent(app, 'bob');
  await alice.post('/api/friends/request').send({ username: 'bob' }).expect(200);
  const aliceId = (await bob.get('/api/friends')).body.incoming[0].id;
  await bob.post('/api/friends/respond').send({ userId: aliceId, accept: false }).expect(200);
  assert.deepEqual((await bob.get('/api/friends')).body.incoming, []);
  await bob.post('/api/friends/respond').send({ userId: aliceId, accept: true }).expect(404);
  // cancel an outgoing request via DELETE
  await alice.post('/api/friends/request').send({ username: 'bob' }).expect(200);
  const bobId = (await alice.get('/api/friends')).body.outgoing[0].id;
  await alice.delete(`/api/friends/${bobId}`).expect(200);
  assert.deepEqual((await bob.get('/api/friends')).body.incoming, []);
});

test('directs are friends-gated; existing rooms grandfathered', async () => {
  const { app, db } = createServer({ dbFile: ':memory:' });
  const alice = await signedUpAgent(app, 'alice');
  const bob = await signedUpAgent(app, 'bob');

  const blocked = await alice.post('/api/directs').send({ username: 'bob' }).expect(403);
  assert.equal(blocked.body.error, 'You need to be friends first');

  await alice.post('/api/friends/request').send({ username: 'bob' }).expect(200);
  const aliceId = (await bob.get('/api/friends')).body.incoming[0].id;
  await bob.post('/api/friends/respond').send({ userId: aliceId, accept: true }).expect(200);
  const room = (await alice.post('/api/directs').send({ username: 'bob' }).expect(200)).body;

  // unfriend: existing room still reachable, both members intact
  await alice.delete(`/api/friends/${room.other_user_id}`).expect(200);
  const again = (await alice.post('/api/directs').send({ username: 'bob' }).expect(200)).body;
  assert.equal(again.id, room.id);
  await bob.get(`/api/rooms/${room.id}/messages`).expect(200);
});

test('friends_changed pokes both users over sockets', async () => {
  const { app, httpServer } = createServer({ dbFile: ':memory:' });
  await new Promise((r) => httpServer.listen(0, r));
  const port = httpServer.address().port;
  const alice = await signedUpAgent(app, 'alice');
  const bob = await signedUpAgent(app, 'bob');
  const sockA = io(`http://localhost:${port}`, { extraHeaders: { Cookie: alice.cookie }, transports: ['polling'], forceNew: true });
  const sockB = io(`http://localhost:${port}`, { extraHeaders: { Cookie: bob.cookie }, transports: ['polling'], forceNew: true });
  try {
    await Promise.all([
      new Promise((r) => sockA.once('connect', r)),
      new Promise((r) => sockB.once('connect', r)),
    ]);
    const pokeA = new Promise((r) => sockA.once('friends_changed', r));
    const pokeB = new Promise((r) => sockB.once('friends_changed', r));
    await alice.post('/api/friends/request').send({ username: 'bob' }).expect(200);
    await Promise.all([pokeA, pokeB]);
    assert.ok(true);
  } finally {
    sockA.close();
    sockB.close();
    httpServer.closeAllConnections?.(); // idle polling keep-alives otherwise block close
    await new Promise((r) => httpServer.close(r));
  }
});
```

- [ ] **Step 2: Run tests** — `npm test` — Expected: friends tests FAIL (404s — no routes; directs not gated).

- [ ] **Step 3: Create `src/friends.js`**

```js
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
    notifyBoth(req.session.userId, other.id);
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
    db.removeFriend(req.session.userId, otherId);
    notifyBoth(req.session.userId, otherId);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { friendRoutes };
```

- [ ] **Step 4: Gate directs in `src/rooms.js`** — inside `POST /api/directs`, replace the `if (!room) { ... }` block with:

```js
    let room = db.findDirectRoom(req.session.userId, other.id);
    if (!room) {
      if (!db.areFriends(req.session.userId, other.id)) {
        return res.status(403).json({ error: 'You need to be friends first' });
      }
      room = db.createRoom({ isDirect: true });
      db.addMember(room.id, req.session.userId);
      db.addMember(room.id, other.id);
      io.to('user:' + other.id).emit('chat_added');
    }
```

- [ ] **Step 5: Mount in `src/server.js`** — add `const { friendRoutes } = require('./friends');` with the other requires, and after `app.use(roomRoutes(db, io));` add `app.use(friendRoutes(db, io));`

- [ ] **Step 6: Run tests** — `npm test` — Expected: all pass (30 total). Run twice — clean exit both times.

- [ ] **Step 7: Commit** (skip if the controller said no commits — note it in your report)

```bash
git add src/friends.js src/rooms.js src/server.js tests/friends.test.js
git commit -m "feat: friend requests, friends-gated directs, live friends_changed"
```

---

### Task 4: Web UI — WhatsApp-style friends card

**Files:**
- Modify: `public/index.html`, `public/style.css`, `public/app.js`

**Interfaces:**
- Consumes: Task 3's endpoints and `friends_changed`; existing app.js globals (`chats`, `online`, `homeAction`, `openChat`, `renderChats`, `connectSocket`).
- Produces: friends card = incoming requests (✓/✕) → friends list (tap to chat) + grandfathered non-friend directs → outgoing pendings (greyed, cancellable) → add-friend form. Old `form-new-direct` flow removed.

- [ ] **Step 1: `public/index.html`** — replace the entire Friends `<section class="card">…</section>` with:

```html
    <section class="card">
      <h2>Friends</h2>
      <ul id="list-requests" class="chat-list"></ul>
      <ul id="list-friends" class="chat-list"></ul>
      <form id="form-add-friend" class="row">
        <input id="add-friend-username" placeholder="friend's exact username" maxlength="20">
        <button>Add</button>
      </form>
    </section>
```

(`list-directs` and `form-new-direct` are gone.)

- [ ] **Step 2: `public/style.css`** — append:

```css
.chat-list li button { padding: 4px 10px; flex-shrink: 0; }
.chat-list li.outgoing { opacity: .65; cursor: default; }
.chat-list li .grow { flex: 1; }
```

- [ ] **Step 3: `public/app.js`**

3a. Add global near the top (after `let chats = [];`): `let friendsData = { friends: [], incoming: [], outgoing: [] };`

3b. Add below `api()`:

```js
async function apiDelete(path) {
  const res = await fetch(path, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
```

3c. In `enterApp`, replace `await loadChats();` with `await Promise.all([loadChats(), loadFriends()]);`

3d. Add after `loadChats`:

```js
async function loadFriends() {
  friendsData = await api('/api/friends');
  renderFriends();
}
```

3e. In `renderChats`, delete the `list-directs` handling: remove the `const directs = ...` and `directs.innerHTML = ''` lines, change the loop to `for (const chat of chats) { if (chat.is_direct) continue; ... }` keeping only the rooms branch (`rooms.append(li)`), and add `renderFriends();` as the last line of `renderChats` (so presence updates refresh friend dots too — `renderFriends` reads `chats` for the grandfathered entries).

Concretely, `renderChats` becomes:

```js
function renderChats() {
  const rooms = $('list-rooms');
  rooms.innerHTML = '';
  for (const chat of chats) {
    if (chat.is_direct) continue;
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = chatLabel(chat) || '(room)';
    li.append(label);
    if (chat.code) {
      const code = document.createElement('span');
      code.className = 'muted';
      code.textContent = chat.code;
      li.append(code);
    }
    li.addEventListener('click', () => openChat(chat));
    rooms.append(li);
  }
  renderFriends();
}
```

3f. Add the friends rendering + actions (place where the removed `form-new-direct` handler was):

```js
function friendRow(userId, username, onClick) {
  const li = document.createElement('li');
  const dot = document.createElement('span');
  dot.className = 'dot' + (online.has(userId) ? ' online' : '');
  const label = document.createElement('span');
  label.className = 'grow';
  label.textContent = username;
  li.append(dot, label);
  li.addEventListener('click', onClick);
  return li;
}

function renderFriends() {
  const reqs = $('list-requests');
  const list = $('list-friends');
  reqs.innerHTML = '';
  list.innerHTML = '';

  for (const r of friendsData.incoming) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'grow';
    label.textContent = `${r.username} wants to be friends`;
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.textContent = '✓';
    yes.addEventListener('click', () => homeAction(async () => {
      await api('/api/friends/respond', { userId: r.id, accept: true });
      await Promise.all([loadFriends(), loadChats()]);
    }));
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'secondary';
    no.textContent = '✕';
    no.addEventListener('click', () => homeAction(async () => {
      await api('/api/friends/respond', { userId: r.id, accept: false });
      await loadFriends();
    }));
    li.append(label, yes, no);
    reqs.append(li);
  }

  const friendIds = new Set(friendsData.friends.map((f) => f.id));
  for (const f of friendsData.friends) {
    list.append(friendRow(f.id, f.username, () => openFriendChat(f)));
  }
  for (const chat of chats) {
    if (chat.is_direct && !friendIds.has(chat.other_user_id)) {
      list.append(friendRow(chat.other_user_id, chat.other_username, () => openChat(chat)));
    }
  }
  for (const o of friendsData.outgoing) {
    const li = document.createElement('li');
    li.className = 'outgoing';
    const label = document.createElement('span');
    label.className = 'grow';
    label.textContent = `${o.username} — request sent`;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary';
    cancel.textContent = '✕';
    cancel.addEventListener('click', () => homeAction(async () => {
      await apiDelete(`/api/friends/${o.id}`);
      await loadFriends();
    }));
    li.append(label, cancel);
    list.append(li);
  }
}

async function openFriendChat(f) {
  const existing = chats.find((c) => c.is_direct && c.other_user_id === f.id);
  if (existing) return openChat(existing);
  homeAction(async () => {
    const room = await api('/api/directs', { username: f.username });
    socket.emit('sync_rooms');
    await loadChats();
    openChat({ ...room, is_direct: 1 });
  });
}

$('form-add-friend').addEventListener('submit', (e) => {
  e.preventDefault();
  homeAction(async () => {
    await api('/api/friends/request', { username: $('add-friend-username').value.trim() });
    $('add-friend-username').value = '';
    await Promise.all([loadFriends(), loadChats()]);
  });
});
```

3g. DELETE the old `$('form-new-direct').addEventListener(...)` block entirely.

3h. In `connectSocket()`, after the `chat_added` handler, add:

```js
  socket.on('friends_changed', () => {
    loadFriends();
    loadChats();
  });
```

- [ ] **Step 4: Verify**

`node --check public/app.js`; `npm test` (30/30 — backend untouched by this task); start server on a spare port, curl `/app.js` for `friends_changed` and `/` for `list-friends`, stop it. Cross-check every new id (`list-requests`, `list-friends`, `form-add-friend`, `add-friend-username`) exists in index.html; confirm no reference to `list-directs`/`form-new-direct`/`new-direct-username` remains in app.js.

- [ ] **Step 5: Manual verification (two browser windows)**

1. Window 1 (bella) adds `friend` → "friend — request sent" appears greyed; window 2 sees "bella wants to be friends" pop in WITHOUT refreshing (socket poke).
2. Window 2 taps ✓ → both windows' friends lists update live; tap the friend → chat opens; messages flow.
3. Decline path: third account requests bella, bella taps ✕ → row vanishes both sides.
4. Cancel path: bella requests someone and taps ✕ on the greyed row → gone on both sides.
5. Sign up a fresh account and try `POST`ing a direct by tapping nothing — confirm there's no UI path to chat a non-friend; (optional curl check: `/api/directs` with a non-friend returns 403 "You need to be friends first").
6. Presence dots still go green/grey on the friends list.

- [ ] **Step 6: Commit** (skip if the controller said no commits — note it in your report)

```bash
git add public/
git commit -m "feat: friends card with requests, accept/decline and add-friend"
```
