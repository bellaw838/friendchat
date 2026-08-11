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

// ---------- chat (completed in the next task) ----------
function openChat(chat) {
  currentRoom = chat;
}

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
