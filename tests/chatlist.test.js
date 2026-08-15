const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createServer } = require('../src/server');

async function signedUpAgent(app, username) {
  const agent = request.agent(app);
  const res = await agent.post('/api/signup').send({ username, password: 'password123' }).expect(200);
  agent.id = res.body.id;
  return agent;
}

// alice and bob, friends, with a direct room between them
async function twoFriends() {
  const { app, db } = createServer({ dbFile: ':memory:' });
  const alice = await signedUpAgent(app, 'alice');
  const bob = await signedUpAgent(app, 'bob');
  await alice.post('/api/friends/request').send({ username: 'bob' }).expect(200);
  await bob.post('/api/friends/respond').send({ userId: alice.id, accept: true }).expect(200);
  const room = (await alice.post('/api/directs').send({ username: 'bob' }).expect(200)).body;
  return { app, db, alice, bob, room };
}

const chatsOf = async (agent) => (await agent.get('/api/chats').expect(200)).body;

test('chat list carries last-message preview, sender and time', async () => {
  const { db, alice, bob, room } = await twoFriends();

  const empty = (await chatsOf(bob))[0];
  assert.equal(empty.last_body, null, 'a room with no messages has no preview');
  assert.equal(empty.unread, 0);

  db.createMessage({ roomId: room.id, senderId: alice.id, kind: 'text', body: 'first' });
  db.createMessage({ roomId: room.id, senderId: alice.id, kind: 'text', body: 'hello bob!' });

  const chat = (await chatsOf(bob))[0];
  assert.equal(chat.last_body, 'hello bob!', 'preview is the newest message');
  assert.equal(chat.last_sender, 'alice');
  assert.equal(chat.last_sender_id, alice.id);
  assert.ok(chat.last_at, 'preview carries a timestamp');
});

test('unread counts only the other person messages, and clears on opening', async () => {
  const { db, alice, bob, room } = await twoFriends();

  db.createMessage({ roomId: room.id, senderId: alice.id, kind: 'text', body: 'one' });
  db.createMessage({ roomId: room.id, senderId: alice.id, kind: 'text', body: 'two' });

  assert.equal((await chatsOf(bob))[0].unread, 2, 'bob has two unread');
  assert.equal((await chatsOf(alice))[0].unread, 0, 'your own messages are never unread');

  await bob.get(`/api/rooms/${room.id}/messages`).expect(200); // opening the chat
  assert.equal((await chatsOf(bob))[0].unread, 0, 'opening clears the badge');

  db.createMessage({ roomId: room.id, senderId: alice.id, kind: 'text', body: 'three' });
  assert.equal((await chatsOf(bob))[0].unread, 1, 'later messages count again');
});

test('chat list is ordered by most recent activity', async () => {
  const { db, alice, bob, room } = await twoFriends();
  const group = (await alice.post('/api/rooms').send({ name: 'Homework' }).expect(200)).body;

  db.createMessage({ roomId: room.id, senderId: bob.id, kind: 'text', body: 'in the direct' });
  assert.equal((await chatsOf(alice))[0].is_direct, 1, 'direct chat is on top after its message');

  db.createMessage({ roomId: group.id, senderId: alice.id, kind: 'text', body: 'in the group' });
  const list = await chatsOf(alice);
  assert.equal(list[0].id, group.id, 'group jumps to the top after newer activity');
  assert.equal(list[1].id, room.id);
});

test('media markers preview without leaking media, legacy images stay masked', async () => {
  const { db, alice, bob, room } = await twoFriends();

  db.createMessage({ roomId: room.id, senderId: alice.id, kind: 'media_note', body: '📷 photo' });
  assert.equal((await chatsOf(bob))[0].last_body, '📷 photo');

  db.createMessage({
    roomId: room.id, senderId: alice.id, kind: 'image',
    body: 'data:image/jpeg;base64,SECRETBYTES',
  });
  const chat = (await chatsOf(bob))[0];
  assert.equal(chat.last_body, '📷 photo', 'legacy image bodies are masked in the preview');
  assert.ok(!JSON.stringify(chat).includes('SECRETBYTES'), 'no media bytes reach the chat list');
});

test('marking read is per-user and per-room', async () => {
  const { db, alice, bob, room } = await twoFriends();
  const group = (await alice.post('/api/rooms').send({ name: 'Homework' }).expect(200)).body;
  await alice.post('/api/friends/request').send({ username: 'bob' }).catch(() => {});
  db.addMember(group.id, bob.id);

  db.createMessage({ roomId: room.id, senderId: alice.id, kind: 'text', body: 'direct msg' });
  db.createMessage({ roomId: group.id, senderId: alice.id, kind: 'text', body: 'group msg' });

  await bob.get(`/api/rooms/${room.id}/messages`).expect(200); // opens only the direct
  const bobList = await chatsOf(bob);
  assert.equal(bobList.find((c) => c.id === room.id).unread, 0, 'the opened room is read');
  assert.equal(bobList.find((c) => c.id === group.id).unread, 1, 'the other room is untouched');

  // alice never opened the group, so her own badge there is unaffected by bob reading his
  const aliceGroup = (await chatsOf(alice)).find((c) => c.id === group.id);
  assert.equal(aliceGroup.unread, 0, "alice wrote it, so it is not unread for her");
});
