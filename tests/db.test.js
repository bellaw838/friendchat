const { test } = require('node:test');
const assert = require('node:assert');
const { createDb } = require('../src/db');

test('creates and finds users', () => {
  const db = createDb(':memory:');
  const user = db.createUser('bella', 'fakehash');
  assert.equal(user.username, 'bella');
  assert.ok(user.id > 0);

  const found = db.getUserByUsername('bella');
  assert.equal(found.id, user.id);
  assert.equal(found.password_hash, 'fakehash');
  assert.equal(db.getUserByUsername('nobody'), undefined);
});

test('rejects duplicate usernames', () => {
  const db = createDb(':memory:');
  db.createUser('bella', 'x');
  assert.throws(() => db.createUser('bella', 'y'));
});
