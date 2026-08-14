# FriendsChat Phase 1 — Ephemeral Media + AI-Agent Seam (server + web)

**Date:** 2026-08-11
**Status:** Approved by user (pending spec review)
**Follows:** `2026-08-10-friendschat-design.md` (v1, built and deployed)
**Followed by:** Phase 2 — FriendsChat iOS app (separate spec; consumes this contract)

## Purpose

Replace stored pictures with ephemeral pictures/videos that are never stored
anywhere, and lay the plumbing so an AI agent can be added to any chat later
with minimal work. Applies to the server and the web app; the future iOS app
uses the same contract.

## Core rules (the contract)

- **Media is relay-only.** A photo or video travels: sender's device →
  server memory (milliseconds, forward-only) → online room members' device
  memory. It is never written to the database, disk, or logs.
- **Only members online at send time receive media.** Everyone else — and
  everyone's history — sees only a content-free marker.
- **Per-viewer 30-second countdown.** Media arrives as a "tap to view"
  bubble held in device memory. Tapping opens a fullscreen viewer with a
  circular 30s countdown ring. When the ring ends or the viewer is closed,
  the media is wiped from memory and the bubble becomes "expired." No
  re-viewing. Each member's 30 seconds are independent.
- **Limits:** photos client-resized as in v1 (max 1280px JPEG); videos max
  15 seconds duration and 10 MB file size, common formats (`video/mp4`,
  `video/quicktime`, `video/webm`). On the wire media travels as a base64
  data-URL (~1.34× the file size), so the server rejects data-URLs over
  14,000,000 characters (≈10 MB of binary) or with a non-`data:image/` /
  `data:video/` prefix.
- **Text messages are unchanged** — still persisted, still in history.

## Protocol changes

### New socket events

- Client → server: `send_media`
  `{ roomId, mediaType: 'photo'|'video', mime, data (base64 data-URL), tempId }`
  Server validates session, membership, size (≤ 10 MB payload), MIME prefix
  (`data:image/` or `data:video/`), then:
  1. Broadcasts `media` to the room (see below).
  2. Persists a marker message (`kind: 'media_note'`,
     `body: '📷 photo'` or `'📹 video'`) via the normal message pipeline
     and broadcasts it as a `new_message` like any other (with `temp_id`
     passthrough for the sender's optimistic bubble).
  3. Acks `{ ok, id }` (marker's message id) or `{ error }`.
- Server → room members: `media`
  `{ mediaId (random uuid, ephemeral), markerId, roomId, sender_id,
  sender_username, mediaType, mime, data }` — sent only to sockets
  currently in the room. Clients pair the `media` payload with the
  `media_note` marker via `markerId` and hold the data in memory only.
  The sender's client keeps its own local copy paired to its marker (same
  tap-to-view and 30-second rules apply to the sender); the server does not
  echo `media` back to the sending socket.

### Removed

- `send_message` no longer accepts `kind: 'image'` (server rejects with
  `{error}`). The image path in the web composer is replaced by the media
  flow.

### Socket.IO server config

- `maxHttpBufferSize` raised to 15,000,000 bytes (14M-char data-URL + framing headroom).

## Database changes

- `messages.kind` gains `'media_note'`. SQLite's CHECK constraint cannot be
  altered in place, so a small startup migration rebuilds the `messages`
  table with the new CHECK (`'text','image','media_note'` — `'image'` stays
  legal so old rows load) and copies existing rows.
- Old `kind:'image'` rows are no longer rendered as images by clients —
  they render as expired markers. The server never sends their bodies to
  clients (history endpoint replaces `image` bodies with `'📷 photo'`).
- `users.is_bot INTEGER NOT NULL DEFAULT 0` — added by the same migration
  (plain `ALTER TABLE ADD COLUMN`). (🤖 badge rendering deferred — see the
  AI-agent seam section.)

## Web UI changes

- Composer: the 🖼️ button becomes a media button accepting images and
  videos (`accept="image/*,video/*"`). Photos: resized exactly as v1.
  Videos: duration checked via a temporary `<video>` element (≤ 15s) and
  size checked (≤ 10 MB); clear error otherwise. No client transcoding on
  web (the iOS app will compress properly in Phase 2).
- Chat bubbles: `media_note` markers render as "📷 Photo — tap to view"
  when the paired media is present in memory; "📷 photo — expired" when
  not (missed it, already viewed it, or reloaded the page).
- Viewer: fullscreen overlay, media centered, circular 30-second countdown
  ring (SVG stroke animation), sender name shown. Video plays looped and
  muted-by-default with a tap-to-unmute control. Closing early or the ring
  reaching zero: media blob revoked/nulled, overlay closes, bubble flips to
  expired. No download button; context menu suppressed in the viewer;
  media travels as data: URLs and is wiped from memory after viewing (a
  determined viewer can still screenshot — accepted).
- History load: markers appear like any message; media itself is never in
  history.

## AI-agent seam (plumbing only — no live agent in this phase)

- `src/agents.js`: exports `onMessage(db, io, msg)`. The message pipeline
  (socket `send_message` handler) calls it after persisting/broadcasting
  each **text** message. It is a documented no-op today. The file carries a
  recipe comment for later: detect `@ai` mentions, call an LLM API
  (DeepSeek/MiMo-style chat-completions), insert the reply via
  `db.createMessage` as a bot user and broadcast it through the normal
  pipeline — so agent replies work in every client with zero client work.
- Bot users are ordinary `users` rows with `is_bot = 1` (the 🤖 badge
  rendering is deferred to the phase that first creates bots — no API
  response exposes is_bot yet); a future
  "add agent to room" feature is just `addMember` with a bot user. No
  routes, API keys, or UI for agents are built in this phase.
- Agents never receive media (relay-only media bypasses `onMessage` by
  design — nothing to hand an API anyway).

## Error handling

- Oversized/overlong/wrong-type media → inline error before or at send;
  ack `{error}` from server as backstop.
- Non-member or unauthenticated `send_media` → rejected exactly like
  `send_message`.
- Send while disconnected → composer blocked with the existing
  "connecting…" banner behavior.
- Mid-view disconnect: viewing continues (data is already local).
- Page reload wipes unviewed media — by design.

## Honest limitations (documented in README)

- A viewer can screenshot or screen-record during their 30 seconds. No
  chat app can prevent this; friends should know.
- "Never stored" applies to our server and clients. Networks in between
  (ISPs) see only encrypted HTTPS/WSS traffic.

## Testing

- Socket tests: media relayed to an online member with correct payload;
  the database provably contains only the marker (no media bytes);
  oversized payload rejected; wrong MIME rejected; non-member rejected;
  `kind:'image'` on `send_message` now rejected; history endpoint masks
  old image bodies.
- Migration test: v1 database file (with image rows) migrates cleanly;
  old rows readable as markers.
- Agent seam test: `onMessage` is invoked once per persisted text message
  with the message row.
- Manual two-window pass: tap-to-view, countdown ring, expiry, missed-photo
  marker for an offline third account, video length/size rejection.

## Out of scope (YAGNI)

Screenshot detection, read receipts for media, resend/replay, media in
history, agent implementation/keys/UI, WebRTC, end-to-end encryption,
web-side video compression.
