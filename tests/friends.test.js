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
