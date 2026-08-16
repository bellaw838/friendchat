const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { withSchema, dropSchema } = require('../src/pool');
const { createDb } = require('../src/db');

const SCHEMA = `test_db_${process.pid}`;
let pool; let db;

before(async () => { pool = await withSchema(SCHEMA); db = createDb(pool); });
after(async () => { await pool.end(); await dropSchema(SCHEMA); });

// Each test cleans up after itself so order never matters.
async function reset() {
  await pool.query('TRUNCATE room_reads, friendships, messages, room_members, rooms, users RESTART IDENTITY CASCADE');
}

test('creates and finds users', async () => {
  await reset();
  const user = await db.createUser('bella', 'fakehash');
  assert.equal(user.username, 'bella');
  assert.ok(user.id > 0);

  const found = await db.getUserByUsername('bella');
  assert.equal(found.id, user.id);
  assert.equal(found.password_hash, 'fakehash');
  assert.equal(await db.getUserByUsername('nobody'), undefined);
});

test('rejects duplicate usernames', async () => {
  await reset();
  await db.createUser('bella', 'x');
  await assert.rejects(() => db.createUser('bella', 'y'));
});

test('rooms, codes and membership', async () => {
  await reset();
  const a = await db.createUser('alice', 'x');
  const b = await db.createUser('bob', 'x');
  const room = await db.createRoom({ name: 'homework', code: 'X7K2PQ', isDirect: false });
  assert.equal(room.code, 'X7K2PQ');
  await db.addMember(room.id, a.id);
  await db.addMember(room.id, a.id); // idempotent
  assert.equal(await db.isMember(room.id, a.id), true);
  assert.equal(await db.isMember(room.id, b.id), false);
  assert.equal((await db.getRoomByCode('X7K2PQ')).id, room.id);
  assert.equal(await db.getRoomByCode('NOPE99'), undefined);
});

test('direct rooms are found for either member order', async () => {
  await reset();
  const a = await db.createUser('alice', 'x');
  const b = await db.createUser('bob', 'x');
  assert.equal(await db.findDirectRoom(a.id, b.id), undefined);
  const room = await db.createRoom({ isDirect: true });
  await db.addMember(room.id, a.id);
  await db.addMember(room.id, b.id);
  assert.equal((await db.findDirectRoom(a.id, b.id)).id, room.id);
  assert.equal((await db.findDirectRoom(b.id, a.id)).id, room.id);
  const list = await db.listRoomsForUser(a.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].other_username, 'bob');
  assert.equal(list[0].other_user_id, b.id);
});

test('messages save and load in order with sender name', async () => {
  await reset();
  const a = await db.createUser('alice', 'x');
  const room = await db.createRoom({ isDirect: true });
  await db.addMember(room.id, a.id);
  const m1 = await db.createMessage({ roomId: room.id, senderId: a.id, kind: 'text', body: 'hi 👋' });
  await db.createMessage({ roomId: room.id, senderId: a.id, kind: 'text', body: 'second' });
  assert.equal(m1.sender_username, 'alice');
  const msgs = await db.listMessages(room.id, 50);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].body, 'hi 👋');
  assert.equal(msgs[1].body, 'second');
  assert.equal((await db.listMessages(room.id, 1)).length, 1);
  assert.equal((await db.listMessages(room.id, 1))[0].body, 'second'); // most recent kept
});

test('fresh db: media_note kind and is_bot column exist', async () => {
  await reset();
  const a = await db.createUser('alice', 'x');
  const room = await db.createRoom({ isDirect: true });
  await db.addMember(room.id, a.id);
  const marker = await db.createMessage({ roomId: room.id, senderId: a.id, kind: 'media_note', body: '📷 photo' });
  assert.equal(marker.kind, 'media_note');
  assert.equal(marker.body, '📷 photo');
  assert.equal((await db.getUserByUsername('alice')).is_bot, 0);
});

test('image bodies are masked in listMessages', async () => {
  await reset();
  const a = await db.createUser('alice', 'x');
  const room = await db.createRoom({ isDirect: true });
  await db.addMember(room.id, a.id);
  await db.createMessage({ roomId: room.id, senderId: a.id, kind: 'image', body: 'data:image/jpeg;base64,AAAA' });
  await db.createMessage({ roomId: room.id, senderId: a.id, kind: 'text', body: 'hello' });
  const msgs = await db.listMessages(room.id, 50);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].kind, 'image');
  assert.equal(msgs[0].body, '📷 photo'); // masked — raw data never leaves the db layer
  assert.equal(msgs[1].body, 'hello');
  const marker = await db.createMessage({ roomId: room.id, senderId: a.id, kind: 'media_note', body: '📹 video' });
  assert.equal(marker.kind, 'media_note');
});

test('friend requests: pair normalization and mutual-pending auto-accept', async () => {
  await reset();
  const a = await db.createUser('alice', 'x');
  const b = await db.createUser('bob', 'x');
  assert.deepEqual(await db.requestFriend(b.id, a.id), { status: 'pending' });
  assert.equal(await db.areFriends(a.id, b.id), false);
  // duplicate request from same side: still pending, flagged already
  assert.equal((await db.requestFriend(b.id, a.id)).already, true);
  // reverse request = mutual pending -> auto-accept
  assert.deepEqual(await db.requestFriend(a.id, b.id), { status: 'accepted' });
  assert.equal(await db.areFriends(a.id, b.id), true);
  assert.equal(await db.areFriends(b.id, a.id), true);
  // requesting an accepted friend: already accepted
  const again = await db.requestFriend(a.id, b.id);
  assert.equal(again.status, 'accepted');
  assert.equal(again.already, true);
  await assert.rejects(() => db.requestFriend(a.id, a.id));
});

test('respondFriend: only the addressee can accept or decline', async () => {
  await reset();
  const a = await db.createUser('alice', 'x');
  const b = await db.createUser('bob', 'x');
  await db.requestFriend(a.id, b.id);
  assert.equal(await db.respondFriend(a.id, b.id, true), false); // asker cannot self-accept
  assert.equal(await db.respondFriend(b.id, a.id, true), true);
  assert.equal(await db.areFriends(a.id, b.id), true);
  // decline path
  const c = await db.createUser('cara', 'x');
  await db.requestFriend(a.id, c.id);
  assert.equal(await db.respondFriend(c.id, a.id, false), true);
  assert.equal(await db.areFriends(a.id, c.id), false);
  assert.equal(await db.respondFriend(c.id, a.id, false), false); // nothing left to respond to
});

test('removeFriend, listFriends buckets, and new user columns', async () => {
  await reset();
  const a = await db.createUser('alice', 'x');
  const b = await db.createUser('bob', 'x');
  const c = await db.createUser('cara', 'x');
  await db.requestFriend(a.id, b.id);
  await db.respondFriend(b.id, a.id, true);
  await db.requestFriend(c.id, a.id);
  const list = await db.listFriends(a.id);
  assert.equal(list.length, 2);
  const bob = list.find((r) => r.user_id === b.id);
  assert.equal(bob.status, 'accepted');
  assert.equal(bob.username, 'bob');
  const cara = list.find((r) => r.user_id === c.id);
  assert.equal(cara.status, 'pending');
  assert.equal(cara.requested_by, c.id);
  await db.removeFriend(b.id, a.id);
  assert.equal(await db.areFriends(a.id, b.id), false);
  await db.removeFriend(b.id, a.id); // idempotent
  assert.equal((await db.getUserByUsername('alice')).verified, 1);
  assert.equal((await db.getUserByUsername('alice')).email, null);
  assert.equal((await db.getUserByUsername('alice')).phone, null);
});
