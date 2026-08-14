# BellaChat Phase 2a — Friends System + Sign-up Verification Seam (server + web)

**Date:** 2026-08-13
**Status:** Approved by user (pending spec review)
**Follows:** `2026-08-11-ephemeral-media-design.md` (built; final fixes pending commit)
**Followed by:** Phase 2b — BellaChat iOS app (separate spec; consumes this contract)

## Purpose

Add a real friends system (add / request / accept, WhatsApp-style lists) and
gate 1-on-1 chats behind friendship, plus a dormant sign-up verification
seam (email/phone confirmation, OFF by default during the testing period).
Server + web app now; the iOS app consumes the same contract in Phase 2b.

## Core rules

- **Friend requests, not instant adds.** You find someone only by their
  EXACT username (no browsing, no partial search — the v1 "no public user
  directory" rule stands). They must accept before you are friends.
- **Mutual pending = friends.** Requesting someone whose request to you is
  already pending accepts it (no awkward double-request state).
- **1-on-1 chats are friends-only.** Creating a direct chat requires an
  accepted friendship (server-enforced). Direct rooms that already exist
  keep working regardless (members stay members). Group rooms are
  unchanged: join code admits anyone, friend or not.
- **Verification is a seam, not a feature, and is OFF now.** With
  `REQUIRE_VERIFICATION` unset/off (the default during testing), sign-up
  is exactly today's flow. The schema, config flag, and a documented no-op
  module exist so switching it on later is a small project, not a rework.

## Database changes (extends the existing migration path in `src/db.js`)

- New table:

  | Table | Columns |
  |---|---|
  | `friendships` | `user_lo` INTEGER, `user_hi` INTEGER (the pair, always stored lo < hi), `status` TEXT CHECK in (`pending`,`accepted`), `requested_by` INTEGER, `created_at` — PRIMARY KEY (`user_lo`,`user_hi`) |

  One row per pair regardless of direction; `requested_by` says who asked.
- `users` gains nullable `email` TEXT, `phone` TEXT, and
  `verified` INTEGER NOT NULL DEFAULT 1 (default 1 because verification is
  off; when the feature is enabled later, new signups start at 0 until
  confirmed — existing users stay 1).
- Migration: `ALTER TABLE ADD COLUMN` for the user columns,
  `CREATE TABLE IF NOT EXISTS` for `friendships` (both idempotent; fresh
  databases get them straight from SCHEMA).

## New db methods

- `requestFriend(fromId, toId)` → `{status}` — creates pending row, or
  flips to `accepted` if the reverse request was pending; no-op if already
  accepted; rejects self.
- `respondFriend(userId, otherId, accept)` → boolean — accept flips status;
  decline deletes the row. Only valid on a pending request addressed TO
  `userId` (i.e. `requested_by !== userId`).
- `removeFriend(userId, otherId)` — deletes the row whatever its state.
- `listFriends(userId)` → rows `{user_id, username, status, requested_by}`
  covering accepted friends AND pending requests in both directions.
- `areFriends(a, b)` → boolean (accepted only).

## REST endpoints (all login-required, errors `{error}` as everywhere)

- `GET /api/friends` → `{ friends: [{id, username}], incoming: [{id, username}], outgoing: [{id, username}] }`
- `POST /api/friends/request` `{username}` → `{status: 'pending'|'accepted'}`
  (404 `No user with that name`, 400 for self, 409 `Already friends`)
- `POST /api/friends/respond` `{userId, accept}` → `{ok}` — `userId` is
  the requester whose pending request you are answering (404 if no pending
  request from that user)
- `DELETE /api/friends/:userId` → `{ok}` (unfriend / cancel outgoing)
- `POST /api/directs` now returns 403 `You need to be friends first` unless
  `areFriends` (or the direct room already exists).

## Socket events

- Server → user: `friends_changed` `{}` — emitted to both affected users'
  `user:<id>` rooms after any request/accept/decline/unfriend. Clients
  respond by refetching `GET /api/friends` (dumb-but-reliable; no payload
  to keep in sync).

## Web UI

Home screen, Friends card (WhatsApp-style list → tap into chat):
1. **Requests** (only when nonempty): "bella wants to be friends —
   ✓ Accept / ✕ Decline" rows.
2. **Friends list**: green presence dot + username; tapping opens (or
   creates) the 1-on-1 chat. Replaces the old chats-derived friends list as
   the way to start chats; existing direct chats still appear.
3. **Add a friend**: input + button ("friend's exact username") → sends the
   request; shows "Request sent ✓" or the error. Outgoing pending requests
   render greyed with a "cancel" ✕.
The old "type a username to open a chat" form is removed (replaced by the
friend flow). Rooms card unchanged.

## Verification seam (dormant)

- `src/verify.js`: exports `isRequired()` (reads `REQUIRE_VERIFICATION`
  env, default false) and a documented no-op `sendCode(destination)` /
  `checkCode(destination, code)` pair. Comments carry the enable-later
  recipe: collect email or phone at sign-up, `sendCode` via a provider
  (email via SMTP/Resend is the cheap path; SMS costs real money), create
  the account with `verified = 0`, block login until `checkCode` passes,
  then set `verified = 1`.
- Signup route change now: none visible. It calls `verify.isRequired()`
  and proceeds exactly as today when false (which it is).

## Error handling

- Friend request to unknown username → 404; to self → 400; duplicate
  accepted friendship → 409; respond to nonexistent request → 404.
- Direct-chat attempt without friendship → 403 with a friendly message the
  clients surface ("You need to be friends first").
- All friendship writes are idempotent-safe (re-accepting, re-declining a
  gone request, unfriending twice → clean errors or no-ops, never crashes).

## Testing

- db tests: pair normalization (lo/hi), mutual-pending auto-accept,
  respond-only-addressee rule, unfriend, areFriends.
- REST tests: full request→accept flow between two users; decline; cancel;
  409/404/400 cases; directs blocked pre-friendship (403), allowed after
  accept; existing direct rooms still usable by members.
- Socket test: `friends_changed` reaches both users on request and accept.
- Verification seam: signup unchanged with flag off (explicit test);
  `verify.isRequired()` false by default, true when env set.
- Manual two-window pass: request → live notification → accept → chat.

## Out of scope (YAGNI)

Partial-name search, friend suggestions, blocking (declining is enough at
friend-group scale), verification provider integration (email/SMS sending),
push notifications, iOS work (Phase 2b).
