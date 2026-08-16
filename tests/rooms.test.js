const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createServer } = require('../src/server');
const { withSchema, dropSchema } = require('../src/pool');

const SCHEMA = `test_rooms_${process.pid}`;
let pool;
before(async () => { pool = await withSchema(SCHEMA); });
after(async () => { await pool.end(); await dropSchema(SCHEMA); });

async function freshServer() {
  await pool.query('TRUNCATE room_reads, friendships, messages, room_members, rooms, users RESTART IDENTITY CASCADE');
  return createServer({ pool });
}

async function signedUpAgent(app, username) {
  const agent = request.agent(app);
  await agent.post('/api/signup').send({ username, password: 'password123' }).expect(200);
  return agent;
}

test('chat endpoints require login', async () => {
  const { app } = await freshServer();
  await request(app).get('/api/chats').expect(401);
  await request(app).post('/api/rooms').send({ name: 'x' }).expect(401);
});

test('create room, join by code', async () => {
  const { app } = await freshServer();
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
  const { app, db } = await freshServer();
  const alice = await signedUpAgent(app, 'alice');
  await signedUpAgent(app, 'bob');

  await alice.post('/api/directs').send({ username: 'ghost' }).expect(404);
  await alice.post('/api/directs').send({ username: 'alice' }).expect(400);

  const aliceId = (await db.getUserByUsername('alice')).id;
  const bobId = (await db.getUserByUsername('bob')).id;
  await db.requestFriend(aliceId, bobId);
  await db.respondFriend(bobId, aliceId, true);

  const first = (await alice.post('/api/directs').send({ username: 'bob' }).expect(200)).body;
  assert.equal(first.other_username, 'bob');
  const second = (await alice.post('/api/directs').send({ username: 'bob' }).expect(200)).body;
  assert.equal(second.id, first.id);
});

test('message history is members-only', async () => {
  const { app, db } = await freshServer();
  const alice = await signedUpAgent(app, 'alice');
  const bob = await signedUpAgent(app, 'bob');
  const room = (await alice.post('/api/rooms').send({ name: 'secret' }).expect(200)).body;

  await bob.get(`/api/rooms/${room.id}/messages`).expect(403);
  const empty = (await alice.get(`/api/rooms/${room.id}/messages`).expect(200)).body;
  assert.deepEqual(empty, []);

  const aliceId = (await db.getUserByUsername('alice')).id;
  await db.createMessage({ roomId: room.id, senderId: aliceId, kind: 'text', body: 'hello 🎉' });
  const msgs = (await alice.get(`/api/rooms/${room.id}/messages`).expect(200)).body;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].body, 'hello 🎉');
});
