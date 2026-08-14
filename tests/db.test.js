const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const Database = require('better-sqlite3');
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

  // Phase 2a migration: new user columns arrive with sane defaults, friendships usable
  assert.equal(db.getUserByUsername('alice').verified, 1);
  const b2 = db.createUser('bob2', 'x');
  db.requestFriend(1, b2.id);
  assert.equal(db.respondFriend(b2.id, 1, true), true);
  assert.equal(db.areFriends(1, b2.id), true);

  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
});

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
