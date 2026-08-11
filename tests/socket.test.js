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
