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
