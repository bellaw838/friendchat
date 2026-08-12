# 💬 BellaChat

A private chat website for friends. Username + password accounts, 1-on-1
chats, group rooms with join codes, emoji, and disappearing photos/videos — all your own code.

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

## Disappearing photos & videos

Photos and videos are never stored — not on the server, not in the
database, not in chat history. They are relayed live to friends who are
online at that moment, and each viewer gets one 30-second look (with a
countdown ring) before the media is wiped from their device's memory.
History only records that "📷 a photo" was shared.

Honest fine print:
- If you're offline when a photo is sent, you missed it — that's the point.
- A viewer can still screenshot or screen-record during their 30 seconds.
  No chat app can prevent that; make sure your friends know.
- Videos: up to 15 seconds and 10 MB.

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
