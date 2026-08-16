const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createServer } = require('../src/server');
const { withSchema, dropSchema } = require('../src/pool');

const SCHEMA = `test_auth_${process.pid}`;
let pool;
before(async () => { pool = await withSchema(SCHEMA); });
after(async () => { await pool.end(); await dropSchema(SCHEMA); });

async function freshApp() {
  await pool.query('TRUNCATE room_reads, friendships, messages, room_members, rooms, users RESTART IDENTITY CASCADE');
  return (await createServer({ pool })).app;
}

test('signup then me', async () => {
  const agent = request.agent(await freshApp());
  const res = await agent.post('/api/signup')
    .send({ username: 'bella', password: 'password123' }).expect(200);
  assert.equal(res.body.username, 'bella');
  const me = await agent.get('/api/me').expect(200);
  assert.equal(me.body.username, 'bella');
});

test('signup validation', async () => {
  const agent = request.agent(await freshApp());
  await agent.post('/api/signup').send({ username: 'ab', password: 'password123' }).expect(400);
  await agent.post('/api/signup').send({ username: 'has space', password: 'password123' }).expect(400);
  await agent.post('/api/signup').send({ username: 'bella', password: 'short' }).expect(400);
});

test('duplicate username is 409', async () => {
  const app = await freshApp();
  await request.agent(app).post('/api/signup').send({ username: 'bella', password: 'password123' }).expect(200);
  const res = await request.agent(app).post('/api/signup')
    .send({ username: 'bella', password: 'password456' }).expect(409);
  assert.match(res.body.error, /taken/i);
});

test('login right and wrong password, logout', async () => {
  const app = await freshApp();
  await request.agent(app).post('/api/signup').send({ username: 'bella', password: 'password123' }).expect(200);
  const agent = request.agent(app);
  await agent.post('/api/login').send({ username: 'bella', password: 'wrongwrong' }).expect(401);
  await agent.post('/api/login').send({ username: 'bella', password: 'password123' }).expect(200);
  await agent.get('/api/me').expect(200);
  await agent.post('/api/logout').expect(200);
  await agent.get('/api/me').expect(401);
});
