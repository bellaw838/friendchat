# 💬 BellaChat

A private chat website for friends. Username + password accounts, 1-on-1
chats, group rooms with join codes, emoji, and pictures — all your own code.

## Run it on your computer

```bash
npm install
npm start
```

Open http://localhost:3000. To chat with yourself for testing, open a
second private/incognito window and sign up as a different user.

## Run the tests

```bash
npm test
```

## Put it on the internet (Render, free)

1. Push this repo to GitHub (private repo is fine).
2. Sign up at https://render.com (free).
3. New → Blueprint → connect the repo. Render reads `render.yaml` and
   deploys automatically.
4. Share your link (like `https://bellachat.onrender.com`) with friends.

**Free-tier fine print:** the app falls asleep after ~15 minutes with no
visitors — the first person to open it waits ~30 seconds while it wakes up.
Accounts and chat history reset whenever the app is redeployed or
restarted, because the free tier has no permanent disk. Everyone just
signs up again. If that gets annoying, the fix is swapping SQLite for a
free hosted database — all database code lives in `src/db.js`.

## Forgot password?

There's no reset flow on purpose (keeps things simple). Since history
resets on redeploys anyway, the friend can simply sign up again with a
new name — or with the same name after the next reset.
