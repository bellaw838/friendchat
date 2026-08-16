const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { io } = require('socket.io-client');
const { createServer } = require('../src/server');
const { withSchema, dropSchema } = require('../src/pool');
const agents = require('../src/agents');

const SCHEMA = `test_media_${process.pid}`;
let pool;
before(async () => { pool = await withSchema(SCHEMA); });
after(async () => { await pool.end(); await dropSchema(SCHEMA); });

async function freshServer() {
  await pool.query('TRUNCATE room_reads, friendships, messages, room_members, rooms, users RESTART IDENTITY CASCADE');
  return createServer({ pool });
}

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
  const { app, httpServer, db } = await freshServer();
  await new Promise((r) => httpServer.listen(0, r));
  const port = httpServer.address().port;
  const agentA = request.agent(app);
  const agentB = request.agent(app);
  const resA = await agentA.post('/api/signup').send({ username: 'alice', password: 'password123' }).expect(200);
  const resB = await agentB.post('/api/signup').send({ username: 'bob', password: 'password123' }).expect(200);
  const cookieA = resA.headers['set-cookie'][0].split(';')[0];
  const cookieB = resB.headers['set-cookie'][0].split(';')[0];
  await db.requestFriend(resA.body.id, resB.body.id);
  await db.respondFriend(resB.body.id, resA.body.id, true);
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

    const history = await db.listMessages(room.id, 50);
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
