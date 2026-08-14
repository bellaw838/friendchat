const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const verify = require('../src/verify');
const { createServer } = require('../src/server');

test('verification is off by default and honors the env flag', () => {
  delete process.env.REQUIRE_VERIFICATION;
  assert.equal(verify.isRequired(), false);
  for (const on of ['1', 'true', 'TRUE', 'True']) {
    process.env.REQUIRE_VERIFICATION = on;
    assert.equal(verify.isRequired(), true, `expected on for ${on}`);
  }
  for (const off of ['', '0', 'false', 'no']) {
    process.env.REQUIRE_VERIFICATION = off;
    assert.equal(verify.isRequired(), false, `expected off for ${JSON.stringify(off)}`);
  }
  delete process.env.REQUIRE_VERIFICATION;
});

test('signup works normally with the flag off, 503 with it on', async () => {
  delete process.env.REQUIRE_VERIFICATION;
  const { app } = createServer({ dbFile: ':memory:' });
  await request.agent(app).post('/api/signup')
    .send({ username: 'bella', password: 'password123' }).expect(200);
  try {
    process.env.REQUIRE_VERIFICATION = '1';
    const res = await request.agent(app).post('/api/signup')
      .send({ username: 'friend', password: 'password123' }).expect(503);
    assert.match(res.body.error, /not configured/i);
  } finally {
    delete process.env.REQUIRE_VERIFICATION;
  }
});
