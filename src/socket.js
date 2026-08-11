const { Server } = require('socket.io');

const MAX_TEXT = 2000;
const MAX_IMAGE = 700000; // data-URL chars, ~500 KB

function attachSocket(httpServer, sessionMiddleware, db) {
  const io = new Server(httpServer, { maxHttpBufferSize: 1e6 });
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
        if (kind !== 'text' && kind !== 'image') return ack({ error: 'Unknown message type' });
        if (typeof body !== 'string' || !body.trim()) return ack({ error: 'Empty message' });
        if (kind === 'text' && body.length > MAX_TEXT) return ack({ error: 'Message too long' });
        if (kind === 'image' && (!body.startsWith('data:image/') || body.length > MAX_IMAGE)) {
          return ack({ error: 'Image too big' });
        }
        const msg = db.createMessage({ roomId, senderId: userId, kind, body });
        io.to(`room:${roomId}`).emit('new_message', { ...msg, temp_id: tempId || null });
        ack({ ok: true, id: msg.id });
      } catch (err) {
        console.error('send_message failed:', err);
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
