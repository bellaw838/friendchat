/* global io */
const $ = (id) => document.getElementById(id);

let me = null;
let chats = [];
let friendsData = { friends: [], incoming: [], outgoing: [] };
let currentRoom = null;
let socket = null;
let searchTerm = '';
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

async function apiDelete(path) {
  const res = await fetch(path, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
  $(id).classList.remove('hidden');
}

function chatLabel(chat) {
  return (chat.is_direct ? chat.other_username : chat.name) || 'Chat';
}

const AVATAR_COLORS = ['#128c7e', '#7f66ff', '#e5793b', '#d6417a', '#0aa2c0', '#5b8c00', '#c0392b', '#6d4c41'];
function avatarFor(name, userId) {
  const el = document.createElement('div');
  el.className = 'avatar';
  const label = (name || '?').trim();
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  el.style.background = AVATAR_COLORS[hash % AVATAR_COLORS.length];
  el.textContent = label.charAt(0).toUpperCase();
  if (userId != null) {
    const dot = document.createElement('span');
    dot.className = 'presence' + (online.has(userId) ? ' online' : '');
    el.append(dot);
  }
  return el;
}

// "14:32" today, "Mon" this week, else "3/8/26"
function shortTime(iso) {
  if (!iso) return '';
  const then = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(then.getTime())) return '';
  const now = new Date();
  if (then.toDateString() === now.toDateString()) {
    return then.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if ((now - then) / 86400000 < 7) return then.toLocaleDateString([], { weekday: 'short' });
  return then.toLocaleDateString([], { day: 'numeric', month: 'numeric', year: '2-digit' });
}

function previewOf(chat) {
  if (!chat.last_body) return 'Tap to start chatting';
  const mine = chat.last_sender_id === me.id;
  const who = mine ? 'You: ' : (chat.is_direct ? '' : `${chat.last_sender}: `);
  return who + chat.last_body;
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
$('btn-account').addEventListener('click', async () => {
  if (!confirm(`Logged in as ${me.username}.\n\nLog out?`)) return;
  await api('/api/logout', {});
  location.reload();
});

// ---------- home ----------
async function enterApp() {
  $('btn-account').textContent = me.username.charAt(0).toUpperCase();
  $('sheet-me').textContent = me.username;
  showScreen('screen-home');
  connectSocket();
  await Promise.all([loadChats(), loadFriends()]);
}

async function loadChats() {
  chats = await api('/api/chats');
  renderHome();
}

async function loadFriends() {
  friendsData = await api('/api/friends');
  renderHome();
}

$('search-chats').addEventListener('input', (e) => {
  searchTerm = e.target.value.trim().toLowerCase();
  renderConversations();
});

function renderHome() {
  renderRequests();
  renderConversations();
}

function renderRequests() {
  const banner = $('requests-banner');
  banner.innerHTML = '';
  banner.classList.toggle('hidden', friendsData.incoming.length === 0);
  for (const r of friendsData.incoming) {
    const row = document.createElement('div');
    row.className = 'req-row';
    const text = document.createElement('span');
    text.className = 'grow';
    text.textContent = `${r.username} wants to be friends`;
    const yes = document.createElement('button');
    yes.className = 'req-yes';
    yes.textContent = 'Accept';
    yes.addEventListener('click', () => homeAction(async () => {
      await api('/api/friends/respond', { userId: r.id, accept: true });
      await Promise.all([loadFriends(), loadChats()]);
    }));
    const no = document.createElement('button');
    no.className = 'req-no';
    no.textContent = 'Decline';
    no.addEventListener('click', () => homeAction(async () => {
      await api('/api/friends/respond', { userId: r.id, accept: false });
      await loadFriends();
    }));
    row.append(text, yes, no);
    banner.append(row);
  }
}

// One list: real chats first (newest activity first), then friends you haven't messaged yet.
function conversationRows() {
  const rows = chats.map((chat) => ({
    name: chatLabel(chat),
    userId: chat.is_direct ? chat.other_user_id : null,
    preview: previewOf(chat),
    time: shortTime(chat.last_at),
    unread: chat.unread || 0,
    open: () => openChat(chat),
  }));
  const chattedWith = new Set(chats.filter((c) => c.is_direct).map((c) => c.other_user_id));
  for (const f of friendsData.friends) {
    if (chattedWith.has(f.id)) continue;
    rows.push({
      name: f.username,
      userId: f.id,
      preview: 'Tap to start chatting',
      time: '',
      unread: 0,
      open: () => openFriendChat(f),
    });
  }
  return rows;
}

function renderConversations() {
  const list = $('chat-list');
  list.innerHTML = '';
  const rows = conversationRows().filter((r) => !searchTerm || r.name.toLowerCase().includes(searchTerm));
  $('empty-state').classList.toggle('hidden', rows.length > 0);

  for (const row of rows) {
    const li = document.createElement('li');
    li.append(avatarFor(row.name, row.userId));

    const main = document.createElement('div');
    main.className = 'conv-main';
    const top = document.createElement('div');
    top.className = 'conv-top';
    const name = document.createElement('span');
    name.className = 'conv-name';
    name.textContent = row.name;
    const time = document.createElement('span');
    time.className = 'conv-time' + (row.unread ? ' unread' : '');
    time.textContent = row.time;
    top.append(name, time);

    const bottom = document.createElement('div');
    bottom.className = 'conv-bottom';
    const preview = document.createElement('span');
    preview.className = 'conv-preview';
    preview.textContent = row.preview;
    bottom.append(preview);
    if (row.unread) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = row.unread > 99 ? '99+' : String(row.unread);
      bottom.append(badge);
    }

    main.append(top, bottom);
    li.append(main);
    li.addEventListener('click', row.open);
    list.append(li);
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

async function openFriendChat(f) {
  const existing = chats.find((c) => c.is_direct && c.other_user_id === f.id);
  if (existing) return openChat(existing);
  homeAction(async () => {
    const room = await api('/api/directs', { username: f.username });
    socket.emit('sync_rooms');
    await loadChats();
    openChat({ ...room, is_direct: 1 });
  });
}

// ---------- the + sheet ----------
const SHEET_ACTIONS = {
  friend: {
    title: 'Add a friend',
    placeholder: "friend's exact username",
    submit: 'Send request',
    maxlength: 20,
    run: async (value) => {
      await api('/api/friends/request', { username: value });
      await Promise.all([loadFriends(), loadChats()]);
      return 'Request sent ✓';
    },
  },
  group: {
    title: 'Create a group',
    placeholder: 'group name',
    submit: 'Create',
    maxlength: 40,
    run: async (value) => {
      const room = await api('/api/rooms', { name: value });
      socket.emit('sync_rooms');
      await loadChats();
      closeSheet();
      openChat(room);
    },
  },
  join: {
    title: 'Join with a code',
    placeholder: 'e.g. X7K2PQ',
    submit: 'Join',
    maxlength: 6,
    run: async (value) => {
      const room = await api('/api/rooms/join', { code: value });
      socket.emit('sync_rooms');
      await loadChats();
      closeSheet();
      openChat(room);
    },
  },
};
let sheetAction = null;

function openSheet() {
  sheetAction = null;
  $('sheet-menu').classList.remove('hidden');
  $('sheet-form').classList.add('hidden');
  $('sheet').classList.remove('hidden');
  $('sheet-backdrop').classList.remove('hidden');
}

function closeSheet() {
  $('sheet').classList.add('hidden');
  $('sheet-backdrop').classList.add('hidden');
  $('sheet-error').textContent = '';
  $('sheet-input').value = '';
}

function openSheetAction(key) {
  sheetAction = key;
  const cfg = SHEET_ACTIONS[key];
  $('sheet-title').textContent = cfg.title;
  $('sheet-input').placeholder = cfg.placeholder;
  $('sheet-input').maxLength = cfg.maxlength;
  $('sheet-input').value = '';
  $('sheet-submit').textContent = cfg.submit;
  $('sheet-error').textContent = '';
  $('sheet-menu').classList.add('hidden');
  $('sheet-form').classList.remove('hidden');
  renderSheetFriends();
  $('sheet-input').focus();
}

// On "Add a friend", also list requests you've sent, so they can be cancelled.
function renderSheetFriends() {
  const list = $('sheet-friends');
  list.innerHTML = '';
  if (sheetAction !== 'friend') return;
  for (const o of friendsData.outgoing) {
    const li = document.createElement('li');
    li.append(avatarFor(o.username, o.id));
    const main = document.createElement('div');
    main.className = 'conv-main';
    const name = document.createElement('div');
    name.className = 'conv-name';
    name.textContent = o.username;
    const sub = document.createElement('div');
    sub.className = 'conv-preview';
    sub.textContent = 'Request sent — waiting';
    main.append(name, sub);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'req-no';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', async () => {
      try {
        await apiDelete(`/api/friends/${o.id}`);
        await loadFriends();
        renderSheetFriends();
      } catch (err) {
        $('sheet-error').textContent = err.message;
      }
    });
    li.append(main, cancel);
    list.append(li);
  }
}

$('fab').addEventListener('click', openSheet);
$('sheet-backdrop').addEventListener('click', closeSheet);
$('sheet-back').addEventListener('click', openSheet);
for (const btn of document.querySelectorAll('.sheet-item')) {
  btn.addEventListener('click', () => openSheetAction(btn.dataset.action));
}
$('btn-copy-me').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(me.username);
    $('btn-copy-me').textContent = 'copied ✓';
    setTimeout(() => { $('btn-copy-me').textContent = 'copy'; }, 1500);
  } catch {
    $('btn-copy-me').textContent = me.username;
  }
});
$('sheet-action').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = $('sheet-input').value.trim();
  if (!value || !sheetAction) return;
  $('sheet-error').textContent = '';
  try {
    const note = await SHEET_ACTIONS[sheetAction].run(value);
    if (note) {
      $('sheet-input').value = '';
      $('sheet-error').style.color = '#128c7e';
      $('sheet-error').textContent = note;
      setTimeout(() => { $('sheet-error').style.color = ''; $('sheet-error').textContent = ''; }, 2000);
      renderSheetFriends();
    }
  } catch (err) {
    $('sheet-error').style.color = '';
    $('sheet-error').textContent = err.message;
  }
});

// ---------- chat ----------
const pending = new Map(); // tempId -> message element
let tempCounter = 0;

async function openChat(chat) {
  currentRoom = chat;
  closeSheet();
  $('chat-title').textContent = chatLabel(chat);
  $('chat-sub').textContent = chat.is_direct
    ? (online.has(chat.other_user_id) ? 'online' : 'offline')
    : (chat.code ? `group · code ${chat.code}` : 'group');
  const avatar = avatarFor(chatLabel(chat), null);
  avatar.id = 'chat-avatar';
  $('chat-avatar').replaceWith(avatar);
  $('messages').innerHTML = '';
  $('emoji-picker').classList.add('hidden');
  showScreen('screen-chat');
  try {
    const history = await api(`/api/rooms/${chat.id}/messages`);
    for (const m of history) appendMessage(m);
  } catch (err) {
    $('chat-sub').textContent = err.message;
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

// ---------- photos & videos ----------
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
    renderHome();
    refreshChatSub();
  });
  socket.on('presence', ({ userId, online: isOnline }) => {
    if (isOnline) online.add(userId); else online.delete(userId);
    renderHome();
    refreshChatSub();
  });
  socket.on('chat_added', () => {
    socket.emit('sync_rooms');
    loadChats();
  });
  socket.on('friends_changed', () => {
    loadFriends();
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
    loadChats(); // keeps previews, ordering and unread badges current
  });
  socket.on('media', (p) => {
    if (!/^data:(image|video)\//.test(p.data || '')) return;
    mediaStore.set(p.markerId, { mediaType: p.mediaType, mime: p.mime, data: p.data });
    const bubble = findBubble(p.markerId);
    if (bubble) styleBubbleViewable(bubble); // marker may render before or after media arrives
  });
}

function refreshChatSub() {
  if (!currentRoom || !currentRoom.is_direct) return;
  $('chat-sub').textContent = online.has(currentRoom.other_user_id) ? 'online' : 'offline';
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
