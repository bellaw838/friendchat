// Seed test accounts for trying FriendsChat out. Safe to re-run: existing users are left alone.
// Usage: DATABASE_URL=... node scripts/seed.js
const bcrypt = require('bcryptjs');
const { getPool, initSchema } = require('../src/pool');
const { createDb } = require('../src/db');

const PASSWORD = 'test1234';
const NAMES = ['amy', 'ben', 'chloe', 'dan', 'ella', 'finn', 'grace', 'hugo', 'iris', 'jack'];
const OWNER = process.env.SEED_OWNER || 'bella';

(async () => {
  const pool = getPool();
  await initSchema(pool);
  const db = createDb(pool);

  const owner = await db.getUserByUsername(OWNER);
  if (!owner) {
    console.error(`No "${OWNER}" account — sign up first, or set SEED_OWNER.`);
    process.exit(1);
  }
  console.log(`seeding around ${OWNER} (id ${owner.id})\n`);

  const hash = bcrypt.hashSync(PASSWORD, 10);
  const made = [];
  for (const name of NAMES) {
    const existing = await db.getUserByUsername(name);
    if (existing) { console.log(`  ${name} already exists`); made.push(existing); continue; }
    const user = await db.createUser(name, hash);
    console.log(`  created ${name}`);
    made.push(user);
  }

  // 7 accepted friends, 2 incoming requests, 1 stranger (to test the friends-only rule).
  for (let i = 0; i < made.length; i++) {
    const u = made[i];
    if (i < 7) {
      await db.requestFriend(owner.id, u.id);
      await db.respondFriend(u.id, owner.id, true);
    } else if (i < 9) {
      await db.requestFriend(u.id, owner.id);
    }
  }

  // Three conversations with messages, so previews and unread badges have something to show.
  const scripts = [
    ['Hey! Are you coming tomorrow?', 'Yes! What time?'],
    ['did you finish the homework 😅'],
    ['look at this 😂', 'haha that is so funny', 'send more later'],
  ];
  for (let i = 0; i < 3; i++) {
    const friend = made[i];
    let room = await db.findDirectRoom(owner.id, friend.id);
    if (!room) {
      room = await db.createRoom({ isDirect: true });
      await db.addMember(room.id, owner.id);
      await db.addMember(room.id, friend.id);
      for (const body of scripts[i]) {
        await db.createMessage({ roomId: room.id, senderId: friend.id, kind: 'text', body });
      }
    }
  }

  // A group room.
  if (!(await db.getRoomByCode('HW2K9P'))) {
    const group = await db.createRoom({ name: 'Homework Crew', code: 'HW2K9P', isDirect: false });
    await db.addMember(group.id, owner.id);
    for (const u of made.slice(0, 4)) await db.addMember(group.id, u.id);
    await db.createMessage({ roomId: group.id, senderId: made[1].id, kind: 'text', body: 'anyone got question 4?' });
  }

  console.log(`\n7 friends accepted, 2 requests pending, 1 stranger (jack)`);
  console.log(`group "Homework Crew" code HW2K9P`);
  console.log(`\nall test accounts use password: ${PASSWORD}`);
  await pool.end();
})().catch((err) => { console.error(err.message); process.exit(1); });
