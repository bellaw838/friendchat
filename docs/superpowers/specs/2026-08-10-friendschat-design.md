# FriendsChat — Design Spec

**Date:** 2026-08-10
**Status:** Approved by user (pending spec review)

## Purpose

A simple, private chat website for a small group of friends. No third-party
chat platform involved — the whole thing is our own code. Must be easy to use:
open a link in any browser (computer or phone), log in, and chat.

## Core features

- **Accounts:** sign up / log in with username + password only (no email).
  Passwords stored hashed with bcrypt, never plain text.
- **1-on-1 chats:** find a friend by their exact username and open a private
  chat. There is no public user directory — you must already know the name.
- **Group rooms:** create a room to get a random 6-character join code
  (e.g. `X7K2PQ`). Friends enter the code to join. Only members can read a
  room's messages.
- **Messages:** text with full emoji support, including a built-in emoji
  picker button. Messages appear instantly for everyone online (WebSockets).
- **Pictures:** pick an image from your device; the browser resizes it
  (max ~1280px, JPEG) before upload so it stays small. Shown inline in chat.
  Server rejects uploads over 500 KB after resize.
- **History:** messages are saved; opening a chat loads recent history
  (most recent 50, "load older" on scroll-up can come later — YAGNI for v1:
  just the most recent 50).
- **Presence:** green dot next to friends/members who are currently online.

## Architecture

One Node.js app, deployed as a single service:

- **Server:** Express (serves static frontend + auth/REST endpoints) and
  Socket.IO (real-time messaging and presence).
- **Frontend:** plain HTML/CSS/JavaScript, no frameworks. Three screens:
  1. Login / sign-up
  2. Home — two lists: 1-on-1 chats and group rooms; buttons for
     "new chat" (enter username), "create room", "join room" (enter code)
  3. Chat view — message list, text input, emoji picker button, image button
- **Database:** SQLite (via `better-sqlite3`), one file on disk.

### Data model

| Table | Columns |
|-------|---------|
| `users` | id, username (unique), password_hash, created_at |
| `rooms` | id, name, code (unique, null for 1-on-1 rooms), is_direct (0/1), created_at |
| `room_members` | room_id, user_id |
| `messages` | id, room_id, sender_id, kind (`text` \| `image`), body (text or image data-URL), created_at |

A 1-on-1 chat is just a room with `is_direct = 1`, exactly two members, and
no join code. This keeps message handling identical for both chat styles.

Images are stored as data-URLs in the `messages.body` column. Simple, and
fine at friend-group scale; can move to file storage later if ever needed.

### Auth & sessions

- Sign-up: username (3–20 chars, letters/numbers/underscore) + password
  (min 8 chars). bcrypt hash stored.
- Session: signed session cookie (`express-session`). Socket.IO connections
  reuse the same session to know who the user is.
- All chat endpoints and socket events require a logged-in session.
- Authorization rule: every message read/write checks the sender is a member
  of the target room.

### Message flow

1. Client emits `send_message` (room id, kind, body) over Socket.IO.
2. Server validates membership + size, saves to SQLite, then broadcasts
   `new_message` to all connected members of that room.
3. Sender renders the message as "sending" immediately and confirms it when
   the broadcast echoes back; if the socket is down, it is marked failed
   with a tap-to-retry.

## Error handling

- Wrong password / taken username → clear inline error messages.
- Unknown username for new 1-on-1 chat → "no user with that name."
- Bad room code → "room not found."
- Server asleep or unreachable (free-tier cold start) → "connecting…"
  banner; Socket.IO auto-reconnects and the page retries.
- Oversized image after resize → friendly error, message not sent.

## Deployment

- Host: Render free tier (or equivalent). Single web service, share the URL.
- Known trade-off (accepted): free-tier disk is ephemeral — chat history and
  accounts reset on redeploy/restart of the host. If this becomes annoying,
  swap SQLite for a free hosted database later; the data layer is kept in
  one module so the swap is contained.
- Config via environment variables: `PORT`, `SESSION_SECRET`.

## Testing

- Automated (node:test + supertest): sign-up/login validation, auth
  required on endpoints, room create/join by code, direct-chat creation,
  membership authorization on send/read, message save + history fetch.
- Manual: two browser windows chatting with each other — text, emoji,
  image, presence dot, reconnect after killing the server.

## Out of scope for v1 (YAGNI)

Read receipts, typing indicators, message editing/deleting, push
notifications, blocking, avatars, "load older messages" pagination,
password reset (an admin — Bella — can delete a row so a friend can
re-register if they forget).
