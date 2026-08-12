const crypto = require('crypto');
const { Server } = require('socket.io');
const agents = require('./agents');

const MAX_TEXT = 2000;
const MAX_MEDIA = 14000000; // data-URL chars, ≈10 MB binary

function attachSocket(httpServer, sessionMiddleware, db) {
  const io = new Server(httpServer, { maxHttpBufferSize: 15000000 });
  io.engine.use(sessionMiddleware);

  const online = new Map(); // userId -> open socket count

  io.on('connection', (socket) => {
    const session = socket.request.session;
    const userId = session && session.userId;
    if (!userId) {
      socket.disconnect(true);
      return;
    }

    socket.join('user:' + userId);

    online.set(userId, (online.get(userId) || 0) + 1);
    if (online.get(userId) === 1) io.emit('presence', { userId, online: true });
    socket.emit('online_list', [...online.keys()]);

    const joinRooms = () => {
      for (const room of db.listRoomsForUser(userId)) socket.join(`room:${room.id}`);
    };
    joinRooms();
    socket.on('sync_rooms', joinRooms);

    socket.on('send_message', (payload, ack = () => {}) => {
      try {
        const { roomId, kind, body, tempId } = payload || {};
        if (!db.isMember(roomId, userId)) return ack({ error: 'Not a member of this chat' });
        if (kind !== 'text') return ack({ error: 'Unknown message type' });
        if (typeof body !== 'string' || !body.trim()) return ack({ error: 'Empty message' });
        if (body.length > MAX_TEXT) return ack({ error: 'Message too long' });
        const msg = db.createMessage({ roomId, senderId: userId, kind, body });
        io.to(`room:${roomId}`).emit('new_message', { ...msg, temp_id: tempId || null });
        ack({ ok: true, id: msg.id });
        try {
          agents.onMessage(db, io, msg);
        } catch (err) {
          console.error('agent hook failed:', err);
        }
      } catch (err) {
        console.error('send_message failed:', err);
        ack({ error: 'Server error, try again' });
      }
    });

    socket.on('send_media', (payload, ack = () => {}) => {
      try {
        const { roomId, mediaType, mime, data, tempId } = payload || {};
        if (!db.isMember(roomId, userId)) return ack({ error: 'Not a member of this chat' });
        if (mediaType !== 'photo' && mediaType !== 'video') return ack({ error: 'Unknown media type' });
        if (typeof data !== 'string' || (!data.startsWith('data:image/') && !data.startsWith('data:video/'))) {
          return ack({ error: 'Bad media data' });
        }
        if ((mediaType === 'photo') !== data.startsWith('data:image/')) {
          return ack({ error: 'Media type mismatch' });
        }
        if (data.length > MAX_MEDIA) return ack({ error: 'Too big — max 10 MB' });
        const marker = db.createMessage({
          roomId, senderId: userId, kind: 'media_note',
          body: mediaType === 'photo' ? '📷 photo' : '📹 video',
        });
        socket.to(`room:${roomId}`).emit('media', {
          mediaId: crypto.randomUUID(), markerId: marker.id, roomId,
          sender_id: userId, sender_username: marker.sender_username,
          mediaType, mime: mime || null, data,
        });
        io.to(`room:${roomId}`).emit('new_message', { ...marker, temp_id: tempId || null });
        ack({ ok: true, id: marker.id });
      } catch (err) {
        console.error('send_media failed:', err); // err only — never the payload
        ack({ error: 'Server error, try again' });
      }
    });

    socket.on('disconnect', () => {
      const count = (online.get(userId) || 1) - 1;
      if (count <= 0) {
        online.delete(userId);
        io.emit('presence', { userId, online: false });
      } else {
        online.set(userId, count);
      }
    });
  });

  return io;
}

module.exports = { attachSocket };
