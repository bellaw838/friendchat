/* global io */
const $ = (id) => document.getElementById(id);

let me = null;
let chats = [];
let currentRoom = null;
let socket = null;
const online = new Set();
const mediaStore = new Map();   // markerId -> {mediaType, mime, data}
const pendingMedia = new Map(); // tempId -> media payload awaiting its marker id
let viewerTimer = null;
let viewerOpenFor = null;

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
  if (m.kind === 'media_note' || m.kind === 'image') {
    const label = m.kind === 'image' ? '📷 photo' : m.body;
    bubble.dataset.markerId = m.id || '';
    bubble.dataset.label = label;
    bubble.dataset.sender = m.sender_username;
    if (m.id && mediaStore.has(m.id)) {
      styleBubbleViewable(bubble);
    } else if (extraClass === 'pending') {
      bubble.textContent = label;
    } else {
      styleBubbleExpired(bubble);
    }
  } else {
    bubble.textContent = m.body; // textContent = no HTML injection
  }
  div.append(who, bubble);
  $('messages').append(div);
  $('messages').scrollTop = $('messages').scrollHeight;
  return div;
}

function styleBubbleViewable(bubble) {
  bubble.classList.add('media-view');
  bubble.classList.remove('media-expired');
  bubble.textContent = `${bubble.dataset.label} — tap to view`;
  bubble.onclick = () => openViewer(Number(bubble.dataset.markerId), bubble.dataset.sender);
}

function styleBubbleExpired(bubble) {
  bubble.classList.add('media-expired');
  bubble.classList.remove('media-view');
  bubble.textContent = `${bubble.dataset.label} — expired`;
  bubble.onclick = null;
}

function findBubble(markerId) {
  return document.querySelector(`#messages .bubble[data-marker-id="${markerId}"]`);
}

function openViewer(markerId, sender) {
  const item = mediaStore.get(markerId);
  if (!item || !/^data:(image|video)\//.test(item.data)) return;
  const content = $('viewer-content');
  content.innerHTML = '';
  let el;
  if (item.mediaType === 'video') {
    el = document.createElement('video');
    el.src = item.data;
    el.autoplay = true;
    el.loop = true;
    el.playsInline = true;
    el.muted = true;
    el.onclick = () => { el.muted = !el.muted; }; // tap to unmute
  } else {
    el = document.createElement('img');
    el.src = item.data;
  }
  content.append(el);
  $('viewer-sender').textContent = `from ${sender}`;
  $('media-viewer').classList.remove('hidden');
  viewerOpenFor = markerId;

  const RING = 100.53; // circumference of the r=16 circle
  const TOTAL = 30;
  const started = performance.now();
  $('ring-fg').style.strokeDashoffset = '0';
  $('ring-secs').textContent = String(TOTAL);
  clearInterval(viewerTimer);
  viewerTimer = setInterval(() => {
    const left = TOTAL - (performance.now() - started) / 1000;
    if (left <= 0) { closeViewer(); return; }
    $('ring-fg').style.strokeDashoffset = String(RING * (1 - left / TOTAL));
    $('ring-secs').textContent = String(Math.ceil(left));
  }, 100);
}

function closeViewer() {
  if (viewerOpenFor === null) return;
  const markerId = viewerOpenFor;
  viewerOpenFor = null;
  clearInterval(viewerTimer);
  viewerTimer = null;
  mediaStore.delete(markerId); // gone for good — no re-viewing
  $('viewer-content').innerHTML = '';
  $('media-viewer').classList.add('hidden');
  const bubble = findBubble(markerId);
  if (bubble) styleBubbleExpired(bubble);
}

$('viewer-close').addEventListener('click', closeViewer);
$('viewer-content').addEventListener('contextmenu', (e) => e.preventDefault());

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
    if (file.type.startsWith('image/')) {
      sendMedia('photo', await resizeImage(file));
    } else if (file.type.startsWith('video/')) {
      if (file.size > 10 * 1024 * 1024) throw new Error('Video is over 10 MB — record a shorter one');
      const seconds = await videoDuration(file);
      if (!Number.isFinite(seconds) || seconds > 15.5) throw new Error('Videos can be at most 15 seconds');
      sendMedia('video', await readAsDataURL(file));
    } else {
      throw new Error('Pick a photo or a video');
    }
  } catch (err) {
    alert(err.message || 'Could not read that file');
  }
});

function videoDuration(file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => { URL.revokeObjectURL(v.src); resolve(v.duration); };
    v.onerror = () => reject(new Error('Could not read that video'));
    v.src = URL.createObjectURL(file);
  });
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.readAsDataURL(file);
  });
}

function sendMedia(mediaType, dataUrl) {
  if (dataUrl.length > 14000000) { alert('Too big even after shrinking'); return; }
  const tempId = `t${++tempCounter}`;
  const body = mediaType === 'photo' ? '📷 photo' : '📹 video';
  const el = appendMessage({ sender_id: me.id, sender_username: me.username, kind: 'media_note', body }, 'pending');
  pending.set(tempId, el);
  pendingMedia.set(tempId, { mediaType, mime: null, data: dataUrl });
  socket.emit('send_media', { roomId: currentRoom.id, mediaType, mime: null, data: dataUrl, tempId }, (resp) => {
    if (!resp || resp.error) {
      pendingMedia.delete(tempId);
      el.classList.remove('pending');
      el.classList.add('failed');
      el.title = (resp && resp.error) || 'Failed';
    }
  });
}

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
  socket.on('chat_added', () => {
    socket.emit('sync_rooms');
    loadChats();
  });
  socket.on('new_message', (m) => {
    if (m.temp_id && m.sender_id === me.id && pendingMedia.has(m.temp_id)) {
      mediaStore.set(m.id, pendingMedia.get(m.temp_id)); // sender's own copy, same 30s rules
      pendingMedia.delete(m.temp_id);
    }
    if (m.temp_id && m.sender_id === me.id && pending.has(m.temp_id)) {
      pending.get(m.temp_id).remove();
      pending.delete(m.temp_id);
    }
    if (currentRoom && m.room_id === currentRoom.id) appendMessage(m);
  });
  socket.on('media', (p) => {
    if (!/^data:(image|video)\//.test(p.data || '')) return;
    mediaStore.set(p.markerId, { mediaType: p.mediaType, mime: p.mime, data: p.data });
    const bubble = findBubble(p.markerId);
    if (bubble) styleBubbleViewable(bubble); // marker may render before or after media arrives
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
