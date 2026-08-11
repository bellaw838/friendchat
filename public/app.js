/* global io */
const $ = (id) => document.getElementById(id);

let me = null;
let chats = [];
let currentRoom = null;
let socket = null;
const online = new Set();

// ---------- helpers ----------
async function api(path, body) {
  const opts = body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
  $(id).classList.remove('hidden');
}

function chatLabel(chat) {
  return chat.is_direct ? chat.other_username : chat.name;
}

// ---------- auth ----------
async function handleAuth(path) {
  $('auth-error').textContent = '';
  try {
    me = await api(path, {
      username: $('auth-username').value.trim(),
      password: $('auth-password').value,
    });
    enterApp();
  } catch (err) {
    $('auth-error').textContent = err.message;
  }
}
$('auth-form').addEventListener('submit', (e) => { e.preventDefault(); handleAuth('/api/login'); });
$('btn-signup').addEventListener('click', () => handleAuth('/api/signup'));
$('btn-logout').addEventListener('click', async () => {
  await api('/api/logout', {});
  location.reload();
});

// ---------- home ----------
async function enterApp() {
  $('home-me').textContent = me.username;
  showScreen('screen-home');
  connectSocket();
  await loadChats();
}

async function loadChats() {
  chats = await api('/api/chats');
  renderChats();
}

function renderChats() {
  const directs = $('list-directs');
  const rooms = $('list-rooms');
  directs.innerHTML = '';
  rooms.innerHTML = '';
  for (const chat of chats) {
    const li = document.createElement('li');
    if (chat.is_direct) {
      const dot = document.createElement('span');
      dot.className = 'dot' + (online.has(chat.other_user_id) ? ' online' : '');
      li.append(dot);
    }
    const label = document.createElement('span');
    label.textContent = chatLabel(chat) || '(room)';
    li.append(label);
    if (!chat.is_direct && chat.code) {
      const code = document.createElement('span');
      code.className = 'muted';
      code.textContent = chat.code;
      li.append(code);
    }
    li.addEventListener('click', () => openChat(chat));
    (chat.is_direct ? directs : rooms).append(li);
  }
}

async function homeAction(fn) {
  $('home-error').textContent = '';
  try {
    await fn();
  } catch (err) {
    $('home-error').textContent = err.message;
  }
}

$('form-new-direct').addEventListener('submit', (e) => {
  e.preventDefault();
  homeAction(async () => {
    const room = await api('/api/directs', { username: $('new-direct-username').value.trim() });
    $('new-direct-username').value = '';
    socket.emit('sync_rooms');
    await loadChats();
    openChat({ ...room, is_direct: 1 });
  });
});

$('form-new-room').addEventListener('submit', (e) => {
  e.preventDefault();
  homeAction(async () => {
    const room = await api('/api/rooms', { name: $('new-room-name').value.trim() });
    $('new-room-name').value = '';
    socket.emit('sync_rooms');
    await loadChats();
    openChat(room);
  });
});

$('form-join-room').addEventListener('submit', (e) => {
  e.preventDefault();
  homeAction(async () => {
    const room = await api('/api/rooms/join', { code: $('join-room-code').value.trim() });
    $('join-room-code').value = '';
    socket.emit('sync_rooms');
    await loadChats();
    openChat(room);
  });
});

// ---------- chat ----------
const pending = new Map(); // tempId -> message element
let tempCounter = 0;

async function openChat(chat) {
  currentRoom = chat;
  $('chat-title').textContent = chatLabel(chat) || '(room)';
  $('chat-code').textContent = chat.code ? `code: ${chat.code}` : '';
  $('messages').innerHTML = '';
  $('emoji-picker').classList.add('hidden');
  showScreen('screen-chat');
  try {
    const history = await api(`/api/rooms/${chat.id}/messages`);
    for (const m of history) appendMessage(m);
  } catch (err) {
    $('chat-title').textContent = err.message;
  }
}

$('btn-back').addEventListener('click', () => {
  currentRoom = null;
  showScreen('screen-home');
  loadChats();
});

function appendMessage(m, extraClass = '') {
  const div = document.createElement('div');
  div.className = `msg ${m.sender_id === me.id ? 'mine' : ''} ${extraClass}`.trim();
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = m.sender_username;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (m.kind === 'image' && m.body.startsWith('data:image/')) {
    const img = document.createElement('img');
    img.src = m.body;
    bubble.append(img);
  } else {
    bubble.textContent = m.body; // textContent = no HTML injection
  }
  div.append(who, bubble);
  $('messages').append(div);
  $('messages').scrollTop = $('messages').scrollHeight;
  return div;
}

function sendMessage(kind, body) {
  const tempId = `t${++tempCounter}`;
  const el = appendMessage(
    { sender_id: me.id, sender_username: me.username, kind, body },
    'pending'
  );
  pending.set(tempId, el);
  emitSend(tempId, kind, body, el);
}

function emitSend(tempId, kind, body, el) {
  el.classList.remove('failed');
  el.classList.add('pending');
  socket.emit('send_message', { roomId: currentRoom.id, kind, body, tempId }, (resp) => {
    if (!resp || resp.error) {
      el.classList.remove('pending');
      el.classList.add('failed');
      el.title = (resp && resp.error) || 'Failed — tap to retry';
      el.onclick = () => emitSend(tempId, kind, body, el);
    }
    // on success the new_message broadcast replaces this element (see connectSocket)
  });
}

$('form-send').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('message-input').value.trim();
  if (!text || !currentRoom) return;
  $('message-input').value = '';
  sendMessage('text', text);
});

// ---------- images ----------
$('image-input').addEventListener('change', async () => {
  const file = $('image-input').files[0];
  $('image-input').value = '';
  if (!file || !currentRoom) return;
  try {
    const dataUrl = await resizeImage(file);
    if (dataUrl.length > 700000) throw new Error('Image is too big even after shrinking');
    sendMessage('image', dataUrl);
  } catch (err) {
    alert(err.message || 'Could not read that image');
  }
});

function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = URL.createObjectURL(file);
  });
}

// ---------- emoji picker ----------
const EMOJIS = ('😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😍 🥰 😘 😜 🤪 😎 🤩 🥳 😏 😴 🤔 🤗 🤭 🤫 😬 🙄 😱 😭 🥺 😡 🤯 🤠 🥶 😈 👻 🤖 💩 ' +
  '👍 👎 👏 🙌 🙏 💪 🤝 ✌️ 🤞 👀 ❤️ 🧡 💛 💚 💙 💜 🖤 💯 🔥 ⭐ ✨ 🎉 🎂 🎁 ⚽ 🏀 🎮 🎧 🍕 🍟 🍦 🍩 🐶 🐱 🦄 🌈 ☀️ 🌙 💤').split(' ');

const picker = $('emoji-picker');
for (const emoji of EMOJIS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = emoji;
  b.addEventListener('click', () => {
    $('message-input').value += emoji;
    $('message-input').focus();
  });
  picker.append(b);
}
$('btn-emoji').addEventListener('click', () => picker.classList.toggle('hidden'));

// ---------- socket ----------
function connectSocket() {
  if (socket) return;
  socket = io();
  socket.on('connect', () => $('conn-banner').classList.add('hidden'));
  socket.on('disconnect', () => $('conn-banner').classList.remove('hidden'));
  socket.on('online_list', (ids) => {
    online.clear();
    ids.forEach((id) => online.add(id));
    renderChats();
  });
  socket.on('presence', ({ userId, online: isOnline }) => {
    if (isOnline) online.add(userId); else online.delete(userId);
    renderChats();
  });
  socket.on('new_message', (m) => {
    if (m.temp_id && pending.has(m.temp_id)) {
      pending.get(m.temp_id).remove(); // replace optimistic bubble with the real one
      pending.delete(m.temp_id);
    }
    if (currentRoom && m.room_id === currentRoom.id) appendMessage(m);
  });
}

// ---------- boot ----------
(async () => {
  try {
    me = await api('/api/me');
    enterApp();
  } catch {
    showScreen('screen-auth');
  }
})();
