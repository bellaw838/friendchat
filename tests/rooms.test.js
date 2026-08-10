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
