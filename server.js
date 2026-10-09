// ---------------------------------------------------------------
// Kamand Chat - server
// Express (web server + REST API) + Socket.IO (real-time) + SQLite (database)
// ---------------------------------------------------------------
require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const cookie = require('cookie');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { DatabaseSync: Database } = require('node:sqlite');
const { Server } = require('socket.io');
const { askAI, friendlyError } = require('./llm');
const {
  BOT_USERNAME, CONTEXT_MESSAGES, SUMMARY_MESSAGES, CHAT_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT,
  buildChatMessages, buildTranscript, parseCommand, createRateLimiter,
} = require('./ai');

const PORT = process.env.PORT || 3000;
// The secret signs login tokens. It must come from .env, never from the code.
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('WARNING: JWT_SECRET not set in .env. Using a temporary one; everyone gets logged out on restart.');
}

// ---------- Database ----------
const db = new Database(path.join(__dirname, 'chat.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- One row per pair of users. user_a is always the smaller id, so a pair is stored once.
  CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a     INTEGER NOT NULL REFERENCES users(id),
    user_b     INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_a, user_b)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    sender_id       INTEGER NOT NULL REFERENCES users(id),
    content         TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    is_read         INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversation_id, id);
`);

// ---------- Kamand AI (the assistant is a special user in the database) ----------
// Older databases do not have the is_bot column yet, so add it if it is missing.
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'is_bot')) {
  db.exec('ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0');
}
let botRow = db.prepare('SELECT id FROM users WHERE username = ?').get(BOT_USERNAME);
if (!botRow) {
  const info = db.prepare('INSERT INTO users (username, password_hash, is_bot) VALUES (?, ?, 1)').run(BOT_USERNAME, '!');
  botRow = { id: info.lastInsertRowid };
} else {
  db.prepare('UPDATE users SET is_bot = 1, password_hash = ? WHERE id = ?').run('!', botRow.id);
}
const BOT_ID = botRow.id; // '!' is not a valid password hash, so nobody can log in as the bot

function getOrCreateConversation(userX, userY) {
  const a = Math.min(userX, userY);
  const b = Math.max(userX, userY);
  let conv = db.prepare('SELECT * FROM conversations WHERE user_a = ? AND user_b = ?').get(a, b);
  if (!conv) {
    const info = db.prepare('INSERT INTO conversations (user_a, user_b) VALUES (?, ?)').run(a, b);
    conv = { id: info.lastInsertRowid, user_a: a, user_b: b };
  }
  return conv;
}

// ---------- App setup ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Auth helpers ----------
function setLoginCookie(res, user) {
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, {
    httpOnly: true,          // JavaScript in the browser cannot read it (safer)
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function readToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // A valid signature is not enough: if the user no longer exists (for example after the
    // database was reset), treat the session as expired so callers reject it instead of
    // using a stale id, which would break foreign keys downstream.
    if (!db.prepare('SELECT id FROM users WHERE id = ?').get(payload.id)) return null;
    return payload;
  } catch {
    return null;
  }
}

// Middleware: blocks the request unless the user is logged in.
function requireAuth(req, res, next) {
  const payload = readToken(req.cookies.token);
  if (!payload) return res.status(401).json({ error: 'Please log in.' });
  req.user = { id: payload.id, username: payload.username };
  next();
}

// ---------- REST API ----------
app.post('/api/signup', (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers or underscore.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (/^kamand[_ ]?ai$/i.test(username)) {
    return res.status(400).json({ error: 'That name is reserved. Try another.' });
  }
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'That username is taken. Try another.' });
  }
  const hash = bcrypt.hashSync(password, 10);
  let info;
  try {
    info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
  } catch (err) {
    // The UNIQUE constraint is the final guard if two signup requests race.
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'That username is taken. Try another.' });
    }
    throw err;
  }
  const user = { id: info.lastInsertRowid, username };
  setLoginCookie(res, user);
  io.emit('users:changed'); // tell everyone to refresh their people list
  res.json(user);
});

app.post('/api/login', (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!row || row.is_bot || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  const user = { id: row.id, username: row.username };
  setLoginCookie(res, user);
  res.json(user);
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json(req.user));

// Everyone except me, with online status, unread count and last message time.
app.get('/api/users', requireAuth, (req, res) => {
  const me = req.user.id;
  const rows = db.prepare(`
    SELECT u.id, u.username, u.is_bot,
      (SELECT COUNT(*) FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.sender_id = u.id AND m.is_read = 0
          AND ((c.user_a = u.id AND c.user_b = @me) OR (c.user_b = u.id AND c.user_a = @me))
      ) AS unread,
      (SELECT MAX(m.created_at) FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE (c.user_a = u.id AND c.user_b = @me) OR (c.user_b = u.id AND c.user_a = @me)
      ) AS last_at
    FROM users u WHERE u.id != @me
    ORDER BY u.is_bot DESC, last_at IS NULL, last_at DESC, u.username COLLATE NOCASE
  `).all({ me });
  res.json(rows.map((r) => ({ ...r, is_bot: !!r.is_bot, online: r.is_bot ? true : onlineCount.has(r.id) })));
});

// Chat history with one other user (creates the conversation if it is new).
app.get('/api/messages/:userId', requireAuth, (req, res) => {
  const other = Number(req.params.userId);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(other) || other === req.user.id) {
    return res.status(404).json({ error: 'User not found.' });
  }
  const conv = getOrCreateConversation(req.user.id, other);
  const messages = db.prepare(
    'SELECT id, sender_id, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id'
  ).all(conv.id);
  res.json(messages);
});

// ---------- Kamand AI logic ----------
const allowAi = createRateLimiter(10, 60000); // max 10 AI messages per user per minute
const aiQueues = new Map();                   // userId -> promise of the last AI task

function queueAi(userId, task) {
  const prev = aiQueues.get(userId) || Promise.resolve();
  const next = prev.then(task).catch((e) => console.error('AI task failed:', e.message));
  aiQueues.set(userId, next);
  next.finally(() => { if (aiQueues.get(userId) === next) aiQueues.delete(userId); });
}

function botTyping(userId, on) {
  io.to(`user:${userId}`).emit('typing', { fromUserId: BOT_ID, isTyping: on });
}

// Saves a message from the bot and delivers it to the user in real time.
function botSay(userId, convId, text) {
  const info = db.prepare('INSERT INTO messages (conversation_id, sender_id, content) VALUES (?, ?, ?)')
    .run(convId, BOT_ID, text);
  const msg = db.prepare('SELECT id, sender_id, content, created_at FROM messages WHERE id = ?')
    .get(info.lastInsertRowid);
  io.to(`user:${userId}`).emit('message:new', { ...msg, receiver_id: userId });
}

// /summarize <username>: summarizes the logged-in user's OWN chat with that person.
async function summarizeChat(userId, username, arg) {
  const name = arg.split(/\s+/)[0];
  if (!name) return 'Type /summarize followed by a username, for example: /summarize bob';
  const other = db.prepare('SELECT id, username FROM users WHERE username = ? AND is_bot = 0').get(name);
  if (!other || other.id === userId) return `I could not find a user named "${name.slice(0, 30)}".`;
  const conv = db.prepare('SELECT id FROM conversations WHERE user_a = ? AND user_b = ?')
    .get(Math.min(userId, other.id), Math.max(userId, other.id));
  const rows = conv
    ? db.prepare('SELECT sender_id, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
        .all(conv.id, SUMMARY_MESSAGES).reverse()
    : [];
  if (!rows.length) return `You have no messages with ${other.username} yet, so there is nothing to summarize.`;
  const transcript = buildTranscript(rows, { [userId]: username, [other.id]: other.username });
  const text = await askAI({
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Chat between ${username} and ${other.username}:\n${transcript}` }],
    maxTokens: 500,
  });
  return `Summary of your chat with ${other.username}:\n${text}`;
}

async function handleAi(userId, username, convId, content) {
  botTyping(userId, true);
  try {
    if (!allowAi(userId)) {
      botSay(userId, convId, 'You are sending messages very fast. Please wait a moment and try again.');
      return;
    }
    const cmd = parseCommand(content);
    let reply;
    if (cmd && cmd.command === 'summarize') {
      reply = await summarizeChat(userId, username, cmd.arg);
    } else {
      // Normal question: Claude sees the last 20 messages of THIS conversation only.
      const rows = db.prepare('SELECT sender_id, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
        .all(convId, CONTEXT_MESSAGES).reverse();
      reply = await askAI({ system: CHAT_SYSTEM_PROMPT, messages: buildChatMessages(rows, BOT_ID) });
    }
    botSay(userId, convId, reply);
  } catch (err) {
    console.error('AI error:', err.message); // never logs the API key
    botSay(userId, convId, friendlyError(err));
  } finally {
    botTyping(userId, false);
  }
}

// ---------- Real-time (Socket.IO) ----------
// userId -> number of open tabs/devices. A user is "online" if they have at least one.
const onlineCount = new Map();

// Runs once for every new socket connection: reads the login cookie.
io.use((socket, next) => {
  const cookies = cookie.parse(socket.handshake.headers.cookie || '');
  const payload = readToken(cookies.token);
  if (!payload) return next(new Error('unauthorized'));
  socket.user = { id: payload.id, username: payload.username };
  next();
});

io.on('connection', (socket) => {
  const me = socket.user.id;
  socket.join(`user:${me}`); // a private "room" so we can message this user on all their tabs

  onlineCount.set(me, (onlineCount.get(me) || 0) + 1);
  if (onlineCount.get(me) === 1) io.emit('presence', { userId: me, online: true });

  // Send a message to another user.
  socket.on('message:send', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const to = Number(data && data.toUserId);
    const content = String((data && data.content) || '').trim();
    if (!content || content.length > 2000) return reply({ error: 'Message must be 1-2000 characters.' });
    if (to === me || !db.prepare('SELECT id FROM users WHERE id = ?').get(to)) {
      return reply({ error: 'User not found.' });
    }
    const conv = getOrCreateConversation(me, to);
    const info = db.prepare('INSERT INTO messages (conversation_id, sender_id, content) VALUES (?, ?, ?)')
      .run(conv.id, me, content);
    const msg = db.prepare('SELECT id, sender_id, content, created_at FROM messages WHERE id = ?')
      .get(info.lastInsertRowid);
    const payload = { ...msg, receiver_id: to };
    io.to(`user:${to}`).to(`user:${me}`).emit('message:new', payload); // both people get it instantly
    reply({ ok: true });
    // If the message was for Kamand AI, answer it (one at a time per user, so replies stay in order).
    if (to === BOT_ID) queueAi(me, () => handleAi(me, socket.user.username, conv.id, content));
  });

  // "Lakshay is typing..." indicator
  socket.on('typing', (data = {}) => {
    const other = Number(data.toUserId);
    if (other === me || !db.prepare('SELECT id FROM users WHERE id = ?').get(other)) return;
    io.to(`user:${other}`).emit('typing', { fromUserId: me, isTyping: !!data.isTyping });
  });

  // I have read everything that `withUserId` sent me.
  socket.on('messages:read', (data = {}) => {
    const other = Number(data.withUserId);
    // Ignore malformed/self/unknown targets rather than creating invalid conversations.
    if (other === me || !db.prepare('SELECT id FROM users WHERE id = ?').get(other)) return;
    const conv = getOrCreateConversation(me, other);
    db.prepare('UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND sender_id = ? AND is_read = 0')
      .run(conv.id, other);
    io.to(`user:${other}`).emit('messages:seen', { byUserId: me });
  });

  socket.on('disconnect', () => {
    const left = (onlineCount.get(me) || 1) - 1;
    if (left <= 0) {
      onlineCount.delete(me);
      io.emit('presence', { userId: me, online: false });
    } else {
      onlineCount.set(me, left);
    }
  });
});

server.listen(PORT, () => console.log(`Kamand Chat running at http://localhost:${PORT}`));
