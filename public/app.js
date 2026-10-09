// ---------------------------------------------------------------
// Kamand Chat - browser code
// ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);

let me = null;            // { id, username } of the logged-in user
let socket = null;        // the real-time connection
let users = [];           // everyone except me
let activeUser = null;    // the person whose chat is open
let isSignup = false;     // is the auth form in "sign up" mode?
let typingTimer = null;
let peerTypingTimer = null;
let loadingHistoryUserId = null;
const pendingLiveMessages = new Map();

// ---------- Small helpers ----------
async function api(url, method = 'GET', body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayOf = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

// ---------- Login / sign up ----------
$('auth-toggle').addEventListener('click', () => {
  isSignup = !isSignup;
  $('auth-submit').textContent = isSignup ? 'Create account' : 'Log in';
  $('auth-toggle').textContent = isSignup ? 'Have an account? Log in' : 'New here? Create an account';
  $('password').autocomplete = isSignup ? 'new-password' : 'current-password';
  $('auth-error').textContent = '';
});

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('auth-error').textContent = '';
  try {
    const user = await api(isSignup ? '/api/signup' : '/api/login', 'POST', {
      username: $('username').value,
      password: $('password').value,
    });
    $('password').value = '';
    startApp(user);
  } catch (err) {
    $('auth-error').textContent = err.message;
  }
});

$('logout').addEventListener('click', async () => {
  await api('/api/logout', 'POST');
  location.reload(); // simplest way to reset everything
});

// ---------- Start the chat screen ----------
async function startApp(user) {
  me = user;
  $('me-name').textContent = me.username;
  $('auth-screen').classList.add('hidden');
  $('app-screen').classList.remove('hidden');
  connectSocket();
  await loadUsers();
}

function connectSocket() {
  socket = io(); // the login cookie is sent automatically

  socket.on('message:new', (msg) => {
    const peerId = msg.sender_id === me.id ? msg.receiver_id : msg.sender_id;
    if (activeUser && peerId === activeUser.id) {
      // Buffer live events while history is loading, then merge by message id.
      if (loadingHistoryUserId === activeUser.id) {
        if (!pendingLiveMessages.has(activeUser.id)) pendingLiveMessages.set(activeUser.id, new Map());
        pendingLiveMessages.get(activeUser.id).set(msg.id, msg);
      } else {
        addMessage(msg);
      }
      if (msg.sender_id !== me.id) socket.emit('messages:read', { withUserId: peerId });
    }
    loadUsers(); // refresh unread badges and ordering
  });

  socket.on('presence', ({ userId, online }) => {
    const u = users.find((x) => x.id === userId);
    if (u) u.online = online;
    renderUsers();
    updatePeerStatus();
  });

  socket.on('typing', ({ fromUserId, isTyping }) => {
    const u = users.find((x) => x.id === fromUserId);
    if (u) { u.typing = isTyping; renderUsers(); }
    if (activeUser && fromUserId === activeUser.id) {
      $('peer-status').textContent = isTyping ? 'typing...' : statusText(activeUser);
      clearTimeout(peerTypingTimer);
      if (isTyping) peerTypingTimer = setTimeout(updatePeerStatus, 4000); // safety reset
    }
  });

  socket.on('users:changed', loadUsers);
  socket.on('connect_error', () => { location.reload(); }); // login expired
}

// ---------- People list ----------
async function loadUsers() {
  users = await api('/api/users');
  renderUsers();
}

function renderUsers() {
  const q = $('search').value.trim().toLowerCase();
  const list = $('user-list');
  list.innerHTML = '';
  const shown = users.filter((u) => u.username.toLowerCase().includes(q));
  if (!shown.length) {
    const li = document.createElement('li');
    li.className = 'no-results';
    li.textContent = users.length ? 'No one matches that search.' : 'No one else has joined yet. Invite a friend!';
    list.appendChild(li);
    return;
  }
  for (const u of shown) {
    const li = document.createElement('li');
    if (activeUser && activeUser.id === u.id) li.className = 'active';
    const dot = document.createElement('span');
    dot.className = 'dot' + (u.online ? ' on' : '');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = u.username + (u.typing ? ' is typing...' : ''); // textContent (not innerHTML) keeps it safe from HTML injection
    li.append(dot, name);
    if (u.is_bot) {
      const tag = document.createElement('span');
      tag.className = 'ai-tag';
      tag.textContent = 'AI';
      li.appendChild(tag);
    }
    if (u.unread > 0 && !(activeUser && activeUser.id === u.id)) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = u.unread;
      li.appendChild(b);
    }
    li.addEventListener('click', () => openChat(u));
    list.appendChild(li);
  }
}
$('search').addEventListener('input', renderUsers);

// ---------- Open a chat ----------
const statusText = (u) => (u.is_bot ? 'AI assistant' : u.online ? 'Online' : 'Offline');
function updatePeerStatus() {
  if (!activeUser) return;
  const fresh = users.find((u) => u.id === activeUser.id);
  if (fresh) activeUser = fresh;
  $('peer-status').textContent = statusText(activeUser);
}

async function openChat(user) {
  activeUser = user;
  $('empty-state').classList.add('hidden');
  $('chat-panel').classList.remove('hidden');
  $('app-screen').classList.add('in-chat');
  $('peer-name').textContent = user.username;
  updatePeerStatus();

  const box = $('messages');
  box.innerHTML = '';
  lastDay = null;
  loadingHistoryUserId = user.id;
  pendingLiveMessages.set(user.id, new Map());
  let history;
  try {
    history = await api('/api/messages/' + user.id);
  } catch (err) {
    if (activeUser === user) $('peer-status').textContent = 'Could not load history';
    if (loadingHistoryUserId === user.id) loadingHistoryUserId = null;
    pendingLiveMessages.delete(user.id);
    return;
  }
  if (activeUser !== user) {
    if (loadingHistoryUserId === user.id) loadingHistoryUserId = null;
    pendingLiveMessages.delete(user.id);
    return; // user clicked someone else meanwhile
  }
  const combined = new Map(history.map((msg) => [msg.id, msg]));
  for (const [id, msg] of (pendingLiveMessages.get(user.id) || new Map())) combined.set(id, msg);
  [...combined.values()].sort((a, b) => a.id - b.id).forEach(addMessage);
  pendingLiveMessages.delete(user.id);
  if (loadingHistoryUserId === user.id) loadingHistoryUserId = null;
  $('message-input').placeholder = user.is_bot ? 'Ask anything, or type /summarize username' : 'Write a message';
  if (user.is_bot && history.length === 0) {
    const tip = document.createElement('div');
    tip.className = 'day';
    tip.textContent = 'Ask me anything. To recap a chat, type /summarize followed by a username.';
    box.appendChild(tip);
  }
  socket.emit('messages:read', { withUserId: user.id });
  user.unread = 0;
  renderUsers();
  $('message-input').focus();
}

$('back').addEventListener('click', () => {
  $('app-screen').classList.remove('in-chat');
  activeUser = null;
  $('chat-panel').classList.add('hidden');
  $('empty-state').classList.remove('hidden');
  renderUsers();
});

// ---------- Messages ----------
let lastDay = null;
function addMessage(msg) {
  const box = $('messages');
  const day = dayOf(msg.created_at);
  if (day !== lastDay) {
    const d = document.createElement('div');
    d.className = 'day';
    d.textContent = day;
    box.appendChild(d);
    lastDay = day;
  }
  // Guard against a history/live-event overlap showing the same message twice.
  if (msg.id && box.querySelector(`[data-message-id="${msg.id}"]`)) return;
  const div = document.createElement('div');
  if (msg.id) div.dataset.messageId = String(msg.id);
  div.className = 'msg' + (msg.sender_id === me.id ? ' mine' : '');
  const text = document.createElement('span');
  text.textContent = msg.content;
  const t = document.createElement('time');
  t.textContent = timeOf(msg.created_at);
  div.append(text, t);
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('message-input');
  const content = input.value.trim();
  if (!content || !activeUser) return;
  socket.emit('message:send', { toUserId: activeUser.id, content }, (res) => {
    if (res && res.error) alert(res.error);
  });
  socket.emit('typing', { toUserId: activeUser.id, isTyping: false });
  input.value = '';
});

// Tell the other person we are typing (stops 1.5s after the last key press)
$('message-input').addEventListener('input', () => {
  if (!activeUser) return;
  socket.emit('typing', { toUserId: activeUser.id, isTyping: true });
  clearTimeout(typingTimer);
  const target = activeUser.id;
  typingTimer = setTimeout(() => socket.emit('typing', { toUserId: target, isTyping: false }), 1500);
});

// ---------- On page load: am I already logged in? ----------
api('/api/me').then(startApp).catch(() => {}); // not logged in -> stay on the login screen
