// AI-agent seam. onMessage is called once per persisted text message, after
// it has been broadcast. It is a no-op today.
//
// To wire a real agent later (DeepSeek / MiMo-style chat-completions API):
//   1. Create the bot once: a normal users row with is_bot = 1 (any unused
//      username, random password hash), then addMember(roomId, botId) to
//      invite it to a room.
//   2. Here in onMessage: if msg.body mentions '@ai' and the room has a bot
//      member, gather context with db.listMessages(msg.room_id, 20), call
//      the LLM API (key from an environment variable — never in code), then:
//        const reply = db.createMessage({ roomId: msg.room_id,
//          senderId: botId, kind: 'text', body: replyText });
//        io.to('room:' + msg.room_id).emit('new_message', { ...reply, temp_id: null });
//      The reply rides the normal pipeline, so every client renders it with
//      zero extra work. Media never reaches this hook by design.
function onMessage(db, io, msg) {
  // no-op for now
}

module.exports = { onMessage };
