# 💬 FriendsChat

A private chat website for friends. Username + password accounts, 1-on-1
chats, group rooms with join codes, emoji, and disappearing photos/videos — all your own code.

## Run it on your computer

You need PostgreSQL once:

```bash
brew install postgresql@16 && brew services start postgresql@16
createdb friendschat
```

Then:

```bash
cp .env.example .env     # then edit DATABASE_URL if your setup differs
npm install
npm start
```

Open http://localhost:3000. To chat with yourself for testing, open a
second private/incognito window and sign up as a different user.

Want some test accounts to play with? `node scripts/seed.js` creates ten
friends (password `test1234`) with a few conversations already going.

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

## Put it on the internet

FriendsChat runs on its own Ubuntu server: Node for the app, PostgreSQL for
storage, Nginx in front. Accounts, chats and logins survive restarts and
reboots.

Step-by-step instructions are in [`docs/server-setup.html`](docs/server-setup.html) —
open it in a browser. In short: install Node, PostgreSQL and Nginx, create
the database, clone this repo, write `.env`, register the systemd service so
it restarts itself, then point Nginx at port 3000 and add HTTPS with certbot.

Two things that live outside the server: a domain name (about £10/year) for a
proper web address, and backups — the nightly dump must be copied off the
machine, or it dies with the machine.

## Settings (`.env`)

| Variable | What it does |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. Required — the app won't start without it. |
| `SESSION_SECRET` | Signs login cookies. Generate with `openssl rand -hex 32`. |
| `PORT` | Port to listen on (default 3000). |
| `REQUIRE_VERIFICATION` | Leave unset. Reserved for email/phone sign-up confirmation, which isn't wired to a provider yet. |

Never commit `.env` — it holds real secrets and is already in `.gitignore`.

## Updating a running server

```bash
ssh you@your-server
cd ~/friendchat && git pull && npm install --omit=dev
sudo systemctl restart friendschat
```

## Forgot password?

There's no reset flow yet (keeps things simple). An admin with database
access can set a new password, or the friend can sign up under a new name.
