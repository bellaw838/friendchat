# Ephemeral Media + AI-Agent Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pictures/videos become relay-only ephemeral media (per-viewer 30-second tap-to-view, never stored anywhere), plus the plumbing seam for a future per-room AI agent.

**Architecture:** Media rides a new `send_media`/`media` socket event pair that forwards through server memory without ever touching the database; history keeps only content-free `media_note` marker messages. A startup migration extends the schema (`media_note` kind, `users.is_bot`). A no-op `src/agents.js` hook is called after every persisted text message. The web client gains a fullscreen tap-to-view viewer with an SVG countdown ring.

**Tech Stack:** unchanged — Node 18+, Express 4, Socket.IO 4, better-sqlite3, vanilla JS frontend, `node --test` + supertest + socket.io-client.

**Spec:** `docs/superpowers/specs/2026-08-11-ephemeral-media-design.md`

## Global Constraints

- Media data-URL max length: **14,000,000 chars** (≈10 MB binary). Must start with `data:image/` or `data:video/`. Socket.IO `maxHttpBufferSize: 15_000_000`.
- Video limits enforced client-side: file size ≤ 10 MB (`10 * 1024 * 1024`), duration ≤ 15 s (accept up to 15.5 s for metadata rounding).
- Marker messages: `kind: 'media_note'`, body exactly `📷 photo` or `📹 video`.
- `send_message` accepts ONLY `kind: 'text'` now (max 2000 chars unchanged). Legacy `image` rows stay readable but their bodies are masked to `📷 photo` by the history query.
- Per-viewer countdown: 30 seconds, starts at open, no re-viewing (media deleted from the client's `mediaStore` on close/expiry).
- Server never writes media bytes to DB, disk, or logs (error logs print `err`, never payloads).
- The `media` broadcast goes to room members' sockets EXCLUDING the sender (`socket.to(...)`); the marker `new_message` goes to ALL members (`io.to(...)`) with `temp_id` passthrough.
- Bot users: `users.is_bot` INTEGER 0/1, default 0. Agent hook: `agents.onMessage(db, io, msg)` called after every persisted text message, wrapped in try/catch, invoked as a property lookup (`agents.onMessage(...)`, never destructured) so tests can monkey-patch it.
- CommonJS throughout; tests run with `npm test` (`node --test`, auto-discovery).

---

### Task 1: Database — migration to media_note + is_bot, image masking

**Files:**
- Modify: `src/db.js`
- Test: `tests/db.test.js` (append)

**Interfaces:**
- Consumes: existing `createDb(filename)` and its methods.
- Produces: same object; `createMessage` now accepts `kind: 'media_note'`; `getUserByUsername` rows include `is_bot`; `listMessages` masks `kind='image'` bodies to `📷 photo`. Fresh databases get the new schema; v1 database files are migrated in place on open.

- [ ] **Step 1: Append failing tests to `tests/db.test.js`** (add these requires at the top of the file if not present: `const path = require('node:path'); const os = require('node:os'); const fs = require('node:fs'); const Database = require('better-sqlite3');`)

```js
test('fresh db: media_note kind and is_bot column exist', () => {
  const db = createDb(':memory:');
  const a = db.createUser('alice', 'x');
  const room = db.createRoom({ isDirect: true });
  db.addMember(room.id, a.id);
  const marker = db.createMessage({ roomId: room.id, senderId: a.id, kind: 'media_note', body: '📷 photo' });
  assert.equal(marker.kind, 'media_note');
  assert.equal(marker.body, '📷 photo');
  assert.equal(db.getUserByUsername('alice').is_bot, 0);
});

test('v1 database migrates: image bodies masked, media_note insertable', () => {
  const file = path.join(os.tmpdir(), `bellachat-migrate-${process.pid}-${Math.floor(Math.random() * 1e9)}.db`);
  const raw = new Database(file);
  raw.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      code TEXT UNIQUE,
      is_direct INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE room_members (
      room_id INTEGER NOT NULL REFERENCES rooms(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      PRIMARY KEY (room_id, user_id)
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL REFERENCES rooms(id),
      sender_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL CHECK (kind IN ('text','image')),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_messages_room ON messages(room_id, id);
  `);
  raw.prepare("INSERT INTO users (username, password_hash) VALUES ('alice','x')").run();
  raw.prepare('INSERT INTO rooms (is_direct) VALUES (1)').run();
  raw.prepare('INSERT INTO room_members (room_id, user_id) VALUES (1, 1)').run();
  raw.prepare("INSERT INTO messages (room_id, sender_id, kind, body) VALUES (1, 1, 'image', 'data:image/jpeg;base64,AAAA')").run();
  raw.prepare("INSERT INTO messages (room_id, sender_id, kind, body) VALUES (1, 1, 'text', 'hello')").run();
  raw.close();

  const db = createDb(file);
  const msgs = db.listMessages(1, 50);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].kind, 'image');
  assert.equal(msgs[0].body, '📷 photo'); // masked — raw data never leaves the db layer
  assert.equal(msgs[1].body, 'hello');
  const marker = db.createMessage({ roomId: 1, senderId: 1, kind: 'media_note', body: '📹 video' });
  assert.equal(marker.kind, 'media_note');

  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
});
```

- [ ] **Step 2: Run tests** — `npm test` — Expected: both new tests FAIL (CHECK constraint / masking missing).

- [ ] **Step 3: Update `src/db.js`**

3a. In `SCHEMA`, change the `users` table definition to include `is_bot`:

```sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_bot INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

3b. In `SCHEMA`, change the `messages` CHECK to `CHECK (kind IN ('text','image','media_note'))`.

3c. Add a `migrate` function above `createDb`, and call it right after `db.exec(SCHEMA);` inside `createDb` (`migrate(db);`):

```js
function migrate(db) {
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (userCols.length && !userCols.includes('is_bot')) {
    db.exec("ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0");
  }
  const tbl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'").get();
  if (tbl && !tbl.sql.includes('media_note')) {
    db.exec(`
      BEGIN;
      CREATE TABLE messages_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id INTEGER NOT NULL REFERENCES rooms(id),
        sender_id INTEGER NOT NULL REFERENCES users(id),
        kind TEXT NOT NULL CHECK (kind IN ('text','image','media_note')),
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO messages_migrated (id, room_id, sender_id, kind, body, created_at)
        SELECT id, room_id, sender_id, kind, body, created_at FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_migrated RENAME TO messages;
      CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, id);
      COMMIT;
    `);
  }
}
```

3d. In `listMessages`, mask legacy image bodies — replace the inner select with:

```js
    listMessages(roomId, limit = 50) {
      return db.prepare(`
        SELECT * FROM (
          SELECT m.id, m.room_id, m.sender_id, m.kind,
                 CASE WHEN m.kind = 'image' THEN '📷 photo' ELSE m.body END AS body,
                 m.created_at, u.username AS sender_username
          FROM messages m JOIN users u ON u.id = m.sender_id
          WHERE m.room_id = ? ORDER BY m.id DESC LIMIT ?
        ) ORDER BY id ASC
      `).all(roomId, limit);
    },
```

- [ ] **Step 4: Run tests** — `npm test` — Expected: all pass (18 total).

- [ ] **Step 5: Commit**

```bash
git add src/db.js tests/db.test.js
git commit -m "feat: media_note kind, is_bot column, image masking + v1 migration"
```

---

### Task 2: Server — send_media relay, image send removal, agent hook

**Files:**
- Create: `src/agents.js`
- Modify: `src/socket.js`
- Test: `tests/media.test.js` (new)

**Interfaces:**
- Consumes: db methods (`isMember`, `createMessage`); `attachSocket(httpServer, sessionMiddleware, db)` shape unchanged.
- Produces:
  - Socket event `send_media` `{roomId, mediaType:'photo'|'video', mime, data, tempId}` → ack `{ok, id}` (marker id) or `{error}`; broadcasts `media` `{mediaId, markerId, roomId, sender_id, sender_username, mediaType, mime, data}` to room sockets excluding sender, and marker `new_message` (kind `media_note`) to all members.
  - `send_message` rejects any `kind` other than `'text'`.
  - `src/agents.js` exports `{ onMessage(db, io, msg) }` — no-op with wiring recipe in comments; called (property-lookup style) after every persisted text message.

- [ ] **Step 1: Write failing tests** — `tests/media.test.js` (helpers mirror `tests/socket.test.js`)

```js
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { io } = require('socket.io-client');
const { createServer } = require('../src/server');
const agents = require('../src/agents');

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

async function twoUsersInDirect() {
  const { app, httpServer, db } = createServer({ dbFile: ':memory:' });
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
  await Promise.all([waitFor(sockA, 'connect'), waitFor(sockB, 'connect')]);
  return { httpServer, db, room, sockA, sockB };
}

function closeAll(httpServer, ...socks) {
  for (const s of socks) s.close();
  httpServer.closeAllConnections?.(); // idle polling keep-alives otherwise block close
  return new Promise((r) => httpServer.close(r));
}

test('photo relays to online member, marker persists, media bytes never stored', async () => {
  const { httpServer, db, room, sockA, sockB } = await twoUsersInDirect();
  try {
    let senderGotMedia = false;
    sockA.once('media', () => { senderGotMedia = true; });
    const incomingMedia = waitFor(sockB, 'media');
    const incomingMarker = waitFor(sockB, 'new_message');

    const ack = await new Promise((resolve) =>
      sockA.emit('send_media', {
        roomId: room.id, mediaType: 'photo', mime: 'image/jpeg',
        data: 'data:image/jpeg;base64,AAAABBBB', tempId: 'm1',
      }, resolve));
    assert.equal(ack.ok, true);

    const media = await incomingMedia;
    assert.equal(media.markerId, ack.id);
    assert.equal(media.mediaType, 'photo');
    assert.equal(media.data, 'data:image/jpeg;base64,AAAABBBB');
    assert.equal(media.sender_username, 'alice');
    assert.ok(media.mediaId);

    const marker = await incomingMarker;
    assert.equal(marker.kind, 'media_note');
    assert.equal(marker.body, '📷 photo');
    assert.equal(marker.temp_id, 'm1');

    await new Promise((r) => setTimeout(r, 200));
    assert.equal(senderGotMedia, false, 'sender must not receive media echo');

    const history = db.listMessages(room.id, 50);
    assert.equal(history.length, 1);
    assert.equal(history[0].body, '📷 photo');
    assert.ok(!JSON.stringify(history).includes('base64'), 'no media bytes in db');
  } finally {
    await closeAll(httpServer, sockA, sockB);
  }
});

test('send_media validation: size, prefix, type mismatch, membership', async () => {
  const { httpServer, room, sockA, sockB } = await twoUsersInDirect();
  try {
    const send = (payload) => new Promise((resolve) => sockA.emit('send_media', payload, resolve));
    assert.ok((await send({ roomId: room.id, mediaType: 'video', data: 'data:video/mp4;base64,' + 'A'.repeat(14000001) })).error, 'oversized');
    assert.ok((await send({ roomId: room.id, mediaType: 'photo', data: 'data:text/html;base64,AAAA' })).error, 'bad prefix');
    assert.ok((await send({ roomId: room.id, mediaType: 'photo', data: 'data:video/mp4;base64,AAAA' })).error, 'type mismatch');
    assert.ok((await send({ roomId: 9999, mediaType: 'photo', data: 'data:image/jpeg;base64,AAAA' })).error, 'not a member');
    assert.ok((await send({ roomId: room.id, mediaType: 'gif', data: 'data:image/gif;base64,AAAA' })).error, 'unknown mediaType');
  } finally {
    await closeAll(httpServer, sockA, sockB);
  }
});

test('send_message no longer accepts kind image; agent hook fires for text', async () => {
  const { httpServer, room, sockA, sockB } = await twoUsersInDirect();
  const original = agents.onMessage;
  const calls = [];
  agents.onMessage = (db, io, msg) => calls.push(msg);
  try {
    const imgAck = await new Promise((resolve) =>
      sockA.emit('send_message', { roomId: room.id, kind: 'image', body: 'data:image/jpeg;base64,AAAA' }, resolve));
    assert.ok(imgAck.error);

    const received = waitFor(sockB, 'new_message');
    const ack = await new Promise((resolve) =>
      sockA.emit('send_message', { roomId: room.id, kind: 'text', body: 'hi @ai' }, resolve));
    assert.equal(ack.ok, true);
    await received;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body, 'hi @ai');
    assert.equal(calls[0].kind, 'text');
  } finally {
    agents.onMessage = original;
    await closeAll(httpServer, sockA, sockB);
  }
});
```

- [ ] **Step 2: Run tests** — `npm test` — Expected: the three new tests FAIL (no `send_media`, image still accepted, no agents module).

- [ ] **Step 3: Create `src/agents.js`**

```js
// AI-agent seam. onMessage is called once per persisted text message, after
// it has been broadcast. It is a no-op today.
//
// To wire a real agent later (DeepSeek / MiMo-style chat-completions API):
//   1. Create the bot once: a normal users row with is_bot = 1 (any unused
//      username, random password hash), then addMember(roomId, botId) to
//      invite it to a room.
//   2. Here in onMessage: if msg.body mentions '@ai' and the room has a bot
//      member, gather context with db.listMessages(msg.room_id, 20), call
//      the LLM API (key from an environment variable — never in code), then:
//        const reply = db.createMessage({ roomId: msg.room_id,
//          senderId: botId, kind: 'text', body: replyText });
//        io.to('room:' + msg.room_id).emit('new_message', { ...reply, temp_id: null });
//      The reply rides the normal pipeline, so every client renders it with
//      zero extra work. Media never reaches this hook by design.
function onMessage(db, io, msg) {
  // no-op for now
}

module.exports = { onMessage };
```

- [ ] **Step 4: Update `src/socket.js`**

4a. Top of file:

```js
const crypto = require('crypto');
const { Server } = require('socket.io');
const agents = require('./agents');

const MAX_TEXT = 2000;
const MAX_MEDIA = 14000000; // data-URL chars, ≈10 MB binary
```

(remove `MAX_IMAGE`.)

4b. Server construction: `new Server(httpServer, { maxHttpBufferSize: 15000000 })`.

4c. In the `send_message` handler: replace the kind/size validation and image branch with text-only —

```js
        if (kind !== 'text') return ack({ error: 'Unknown message type' });
        if (typeof body !== 'string' || !body.trim()) return ack({ error: 'Empty message' });
        if (body.length > MAX_TEXT) return ack({ error: 'Message too long' });
```

and after the existing `io.to(...).emit('new_message', ...)` + `ack(...)` lines, add:

```js
        try {
          agents.onMessage(db, io, msg);
        } catch (err) {
          console.error('agent hook failed:', err);
        }
```

(call via `agents.onMessage(...)` — do not destructure the import; tests monkey-patch the property.)

4d. Add the `send_media` handler next to `send_message`:

```js
    socket.on('send_media', (payload, ack = () => {}) => {
      try {
        const { roomId, mediaType, mime, data, tempId } = payload || {};
        if (!db.isMember(roomId, userId)) return ack({ error: 'Not a member of this chat' });
        if (mediaType !== 'photo' && mediaType !== 'video') return ack({ error: 'Unknown media type' });
        if (typeof data !== 'string' || (!data.startsWith('data:image/') && !data.startsWith('data:video/'))) {
          return ack({ error: 'Bad media data' });
        }
        if ((mediaType === 'photo') !== data.startsWith('data:image/')) {
          return ack({ error: 'Media type mismatch' });
        }
        if (data.length > MAX_MEDIA) return ack({ error: 'Too big — max 10 MB' });
        const marker = db.createMessage({
          roomId, senderId: userId, kind: 'media_note',
          body: mediaType === 'photo' ? '📷 photo' : '📹 video',
        });
        socket.to(`room:${roomId}`).emit('media', {
          mediaId: crypto.randomUUID(), markerId: marker.id, roomId,
          sender_id: userId, sender_username: marker.sender_username,
          mediaType, mime: mime || null, data,
        });
        io.to(`room:${roomId}`).emit('new_message', { ...marker, temp_id: tempId || null });
        ack({ ok: true, id: marker.id });
      } catch (err) {
        console.error('send_media failed:', err); // err only — never the payload
        ack({ error: 'Server error, try again' });
      }
    });
```

- [ ] **Step 5: Run tests** — `npm test` — Expected: all pass (21 total).

- [ ] **Step 6: Commit**

```bash
git add src/agents.js src/socket.js tests/media.test.js
git commit -m "feat: relay-only send_media, text-only send_message, agent seam"
```

---

### Task 3: Web — media composer, tap-to-view viewer with countdown ring

**Files:**
- Modify: `public/index.html`, `public/style.css`, `public/app.js`

**Interfaces:**
- Consumes: `send_media` / `media` / `new_message` contract from Task 2; existing globals in app.js (`me`, `currentRoom`, `pending`, `tempCounter`, `appendMessage`, `resizeImage`, `connectSocket`).
- Produces: full ephemeral-media UX on web. New globals: `mediaStore` (Map markerId → media), `pendingMedia` (Map tempId → media), `openViewer`/`closeViewer`.

- [ ] **Step 1: `public/index.html`** — change the file input to `accept="image/*,video/*"` (same `id="image-input"`), and add the viewer overlay just before the `<script>` tags:

```html
  <div id="media-viewer" class="hidden">
    <div id="viewer-top">
      <span id="viewer-sender"></span>
      <svg id="ring" viewBox="0 0 36 36" width="44" height="44" aria-hidden="true">
        <circle cx="18" cy="18" r="16" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="3"/>
        <circle id="ring-fg" cx="18" cy="18" r="16" fill="none" stroke="#fff" stroke-width="3"
                stroke-linecap="round" stroke-dasharray="100.53" stroke-dashoffset="0"
                transform="rotate(-90 18 18)"/>
      </svg>
      <span id="ring-secs">30</span>
      <button id="viewer-close" class="secondary" type="button">✕</button>
    </div>
    <div id="viewer-content"></div>
  </div>
```

- [ ] **Step 2: `public/style.css`** — append:

```css
#media-viewer { position: fixed; inset: 0; background: rgba(10, 14, 25, .96); z-index: 50; display: flex; flex-direction: column; }
#viewer-top { display: flex; align-items: center; gap: 10px; padding: 12px; }
#viewer-sender { color: #cfd6ea; flex: 1; }
#ring-secs { color: #fff; font-variant-numeric: tabular-nums; min-width: 2ch; text-align: center; }
#viewer-content { flex: 1; display: flex; align-items: center; justify-content: center; padding: 12px; min-height: 0; }
#viewer-content img, #viewer-content video { max-width: 100%; max-height: 100%; border-radius: 12px; }
.msg .bubble.media-view { cursor: pointer; font-weight: 600; }
.msg .bubble.media-expired { opacity: .65; font-style: italic; }
```

- [ ] **Step 3: `public/app.js`** — the media logic.

3a. Near the top (after `const online = new Set();`):

```js
const mediaStore = new Map();   // markerId -> {mediaType, mime, data}
const pendingMedia = new Map(); // tempId -> media payload awaiting its marker id
let viewerTimer = null;
let viewerOpenFor = null;
```

3b. Replace the whole `$('image-input').addEventListener('change', ...)` block with:

```js
$('image-input').addEventListener('change', async () => {
  const file = $('image-input').files[0];
  $('image-input').value = '';
  if (!file || !currentRoom) return;
  try {
    if (file.type.startsWith('image/')) {
      sendMedia('photo', await resizeImage(file));
    } else if (file.type.startsWith('video/')) {
      if (file.size > 10 * 1024 * 1024) throw new Error('Video is over 10 MB — record a shorter one');
      const seconds = await videoDuration(file);
      if (seconds > 15.5) throw new Error('Videos can be at most 15 seconds');
      sendMedia('video', await readAsDataURL(file));
    } else {
      throw new Error('Pick a photo or a video');
    }
  } catch (err) {
    alert(err.message || 'Could not read that file');
  }
});

function videoDuration(file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => { URL.revokeObjectURL(v.src); resolve(v.duration); };
    v.onerror = () => reject(new Error('Could not read that video'));
    v.src = URL.createObjectURL(file);
  });
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.readAsDataURL(file);
  });
}

function sendMedia(mediaType, dataUrl) {
  if (dataUrl.length > 14000000) { alert('Too big even after shrinking'); return; }
  const tempId = `t${++tempCounter}`;
  const body = mediaType === 'photo' ? '📷 photo' : '📹 video';
  const el = appendMessage({ sender_id: me.id, sender_username: me.username, kind: 'media_note', body }, 'pending');
  pending.set(tempId, el);
  pendingMedia.set(tempId, { mediaType, mime: null, data: dataUrl });
  socket.emit('send_media', { roomId: currentRoom.id, mediaType, mime: null, data: dataUrl, tempId }, (resp) => {
    if (!resp || resp.error) {
      pendingMedia.delete(tempId);
      el.classList.remove('pending');
      el.classList.add('failed');
      el.title = (resp && resp.error) || 'Failed';
    }
  });
}
```

3c. In `appendMessage`, replace the bubble-content branch (`if (m.kind === 'image' ...) ... else ...`) with:

```js
  if (m.kind === 'media_note' || m.kind === 'image') {
    const label = m.kind === 'image' ? '📷 photo' : m.body;
    bubble.dataset.markerId = m.id || '';
    bubble.dataset.label = label;
    bubble.dataset.sender = m.sender_username;
    if (m.id && mediaStore.has(m.id)) {
      styleBubbleViewable(bubble);
    } else if (extraClass === 'pending') {
      bubble.textContent = label;
    } else {
      styleBubbleExpired(bubble);
    }
  } else {
    bubble.textContent = m.body; // textContent = no HTML injection
  }
```

3d. Add the bubble/viewer helpers (after `appendMessage`):

```js
function styleBubbleViewable(bubble) {
  bubble.classList.add('media-view');
  bubble.classList.remove('media-expired');
  bubble.textContent = `${bubble.dataset.label} — tap to view`;
  bubble.onclick = () => openViewer(Number(bubble.dataset.markerId), bubble.dataset.sender);
}

function styleBubbleExpired(bubble) {
  bubble.classList.add('media-expired');
  bubble.classList.remove('media-view');
  bubble.textContent = `${bubble.dataset.label} — expired`;
  bubble.onclick = null;
}

function findBubble(markerId) {
  return document.querySelector(`#messages .bubble[data-marker-id="${markerId}"]`);
}

function openViewer(markerId, sender) {
  const item = mediaStore.get(markerId);
  if (!item || !/^data:(image|video)\//.test(item.data)) return;
  const content = $('viewer-content');
  content.innerHTML = '';
  let el;
  if (item.mediaType === 'video') {
    el = document.createElement('video');
    el.src = item.data;
    el.autoplay = true;
    el.loop = true;
    el.playsInline = true;
    el.muted = true;
    el.onclick = () => { el.muted = !el.muted; }; // tap to unmute
  } else {
    el = document.createElement('img');
    el.src = item.data;
  }
  content.append(el);
  $('viewer-sender').textContent = `from ${sender}`;
  $('media-viewer').classList.remove('hidden');
  viewerOpenFor = markerId;

  const RING = 100.53; // circumference of the r=16 circle
  const TOTAL = 30;
  const started = performance.now();
  $('ring-fg').style.strokeDashoffset = '0';
  $('ring-secs').textContent = String(TOTAL);
  clearInterval(viewerTimer);
  viewerTimer = setInterval(() => {
    const left = TOTAL - (performance.now() - started) / 1000;
    if (left <= 0) { closeViewer(); return; }
    $('ring-fg').style.strokeDashoffset = String(RING * (1 - left / TOTAL));
    $('ring-secs').textContent = String(Math.ceil(left));
  }, 100);
}

function closeViewer() {
  if (viewerOpenFor === null) return;
  const markerId = viewerOpenFor;
  viewerOpenFor = null;
  clearInterval(viewerTimer);
  viewerTimer = null;
  mediaStore.delete(markerId); // gone for good — no re-viewing
  $('viewer-content').innerHTML = '';
  $('media-viewer').classList.add('hidden');
  const bubble = findBubble(markerId);
  if (bubble) styleBubbleExpired(bubble);
}

$('viewer-close').addEventListener('click', closeViewer);
```

3e. In `connectSocket()`, extend the `new_message` handler and add the `media` handler. The `new_message` handler becomes:

```js
  socket.on('new_message', (m) => {
    if (m.temp_id && pendingMedia.has(m.temp_id)) {
      mediaStore.set(m.id, pendingMedia.get(m.temp_id)); // sender's own copy, same 30s rules
      pendingMedia.delete(m.temp_id);
    }
    if (m.temp_id && pending.has(m.temp_id)) {
      pending.get(m.temp_id).remove();
      pending.delete(m.temp_id);
    }
    if (currentRoom && m.room_id === currentRoom.id) appendMessage(m);
  });
  socket.on('media', (p) => {
    if (!/^data:(image|video)\//.test(p.data || '')) return;
    mediaStore.set(p.markerId, { mediaType: p.mediaType, mime: p.mime, data: p.data });
    const bubble = findBubble(p.markerId);
    if (bubble) styleBubbleViewable(bubble); // marker may render before or after media arrives
  });
```

- [ ] **Step 4: Verify**

Run: `node --check public/app.js`, then `npm test` (all 21 pass — backend untouched by this task), then `PORT=3196 npm start` in background, `curl -s http://localhost:3196/app.js | grep -c 'send_media'` ≥ 1, stop server.

- [ ] **Step 5: Manual verification (two browser windows)**

1. Send a photo from window 1 → both windows show "📷 photo — tap to view"; tapping in window 2 opens fullscreen with the ring counting 30 → 0, then the bubble greys to "expired"; tapping again does nothing.
2. Sender taps their own bubble → same viewer, own copy, expires independently.
3. Send a short video → plays looped, tap toggles sound, expires at ring end.
4. Close the viewer at ~20s left → bubble expires immediately (no second view).
5. Reload window 2 before tapping → bubble shows "expired" (memory wiped).
6. Third account offline during the send → logs in later → "📷 photo — expired" in history.
7. Try a >15s or >10MB video → clear error, nothing sent.
8. Old chats with v1 stored pictures → show "📷 photo — expired", no image data.

- [ ] **Step 6: Commit**

```bash
git add public/
git commit -m "feat: ephemeral tap-to-view media with 30s countdown on web"
```

---

### Task 4: README + docs

**Files:**
- Modify: `README.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Update `README.md`** — in the intro line, change "emoji, and pictures" to "emoji, and disappearing photos/videos". After the "## Run the tests" section, add:

```markdown
## Disappearing photos & videos

Photos and videos are never stored — not on the server, not in the
database, not in chat history. They are relayed live to friends who are
online at that moment, and each viewer gets one 30-second look (with a
countdown ring) before the media is wiped from their device's memory.
History only records that "📷 a photo" was shared.

Honest fine print:
- If you're offline when a photo is sent, you missed it — that's the point.
- A viewer can still screenshot or screen-record during their 30 seconds.
  No chat app can prevent that; make sure your friends know.
- Videos: up to 15 seconds and 10 MB.
```

- [ ] **Step 2: Full check** — `npm test` (21/21), eyeball `README.md` rendering (`cat README.md`).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe disappearing media and its honest limits"
```
