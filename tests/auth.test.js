const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createServer } = require('../src/server');

function freshApp() {
  return createServer({ dbFile: ':memory:' }).app;
}

test('signup then me', async () => {
  const agent = request.agent(freshApp());
  const res = await agent.post('/api/signup')
    .send({ username: 'bella', password: 'password123' }).expect(200);
  assert.equal(res.body.username, 'bella');
  const me = await agent.get('/api/me').expect(200);
  assert.equal(me.body.username, 'bella');
});

test('signup validation', async () => {
  const agent = request.agent(freshApp());
  await agent.post('/api/signup').send({ username: 'ab', password: 'password123' }).expect(400);
  await agent.post('/api/signup').send({ username: 'has space', password: 'password123' }).expect(400);
  await agent.post('/api/signup').send({ username: 'bella', password: 'short' }).expect(400);
});

test('duplicate username is 409', async () => {
  const app = freshApp();
  await request.agent(app).post('/api/signup').send({ username: 'bella', password: 'password123' }).expect(200);
  const res = await request.agent(app).post('/api/signup')
    .send({ username: 'bella', password: 'password456' }).expect(409);
  assert.match(res.body.error, /taken/i);
});

test('login right and wrong password, logout', async () => {
  const app = freshApp();
  await request.agent(app).post('/api/signup').send({ username: 'bella', password: 'password123' }).expect(200);
  const agent = request.agent(app);
  await agent.post('/api/login').send({ username: 'bella', password: 'wrongwrong' }).expect(401);
  await agent.post('/api/login').send({ username: 'bella', password: 'password123' }).expect(200);
  await agent.get('/api/me').expect(200);
  await agent.post('/api/logout').expect(200);
  await agent.get('/api/me').expect(401);
});
