# Kamand Chat

A real-time, web-based one-to-one chat app built for the **First Commit** hackathon (KamandPrompt, IIT Mandi).

## Features
- Sign up, log in, log out (passwords hashed with bcrypt, login kept in a secure httpOnly cookie via JWT)
- Private one-to-one chat with real-time delivery (WebSockets via Socket.IO)
- Messages saved in SQLite, linked to a conversation and its two users, with timestamps
- Chat history loads when you open a conversation
- Online/offline status, typing indicator, unread badges, people search
- **Kamand AI**: an AI assistant, always online at the top of the people list
  - Free and keyless out of the box: it tries several public AI endpoints in turn, so a reply gets through even if one is busy. Set `LLM_API_KEY` to use Claude instead.
  - Remembers the last 20 messages of your conversation with it (context-aware, separate for every user)
  - `/summarize <username>` summarizes your own recent chat (last 50 messages) with that user
  - Rate limited (10 AI messages per user per minute), 20-second timeout, friendly error messages
- Works on phones (one panel at a time) and desktops

## Architecture
```
Browser (HTML/CSS/JS)  <-- HTTP (REST: signup, login, history) -->  Express server
        ^                                                                 |
        +------------- WebSocket (Socket.IO: messages, typing) -----------+
                                                                          |
                                                                      SQLite (chat.db)
```
- `server.js` - Express REST API, Socket.IO events, SQLite tables (users, conversations, messages) via Node's built-in `node:sqlite`
- `llm.js` - the only file that calls the AI provider (a chain of free, keyless APIs by default; Claude if `LLM_API_KEY` is set). Any key is read from `.env` on the server, never sent to the browser.
- `ai.js` - helper functions for the assistant (context building, `/summarize` parsing, rate limiter)
- `public/` - frontend (`index.html`, `style.css`, `app.js`)

## Setup (clean machine)
Requires Node.js 22.5 or newer. SQLite is Node's built-in `node:sqlite` module, so there is no native dependency to compile and no extra build tools to install.

```bash
npm run setup:env   # creates .env with a random JWT_SECRET; never prints the secret
npm install
npm start
```

`setup:env` does not overwrite an existing `.env`; it is safe to re-run. Keep `.env` private and never upload it or commit it to Git.

On Windows, make sure the terminal is open in the folder that directly contains `package.json`. Run `dir` and confirm that file is listed before running `npm install`. If npm reports `ENOENT` for `package.json`, you are in the wrong folder or the ZIP was not extracted completely.

This project has no native dependencies. Database access uses Node's built-in `node:sqlite` module, which requires Node.js 22.5 or newer. If `npm run check:sqlite` fails, check your Node version with `node -v`.
Open http://localhost:3000

## Environment variables
| Name | Purpose |
|------|---------|
| `JWT_SECRET` | Secret used to sign login tokens. Never commit it. |
| `PORT` | Port to run on (default 3000) |
| `LLM_API_KEY` | Optional. Leave blank to use the free keyless AI provider; set it to use Claude (Anthropic) instead. Server only, never commit. |
| `LLM_MODEL` | Optional, and only used for Claude: the model name to request (default `claude-haiku-4-5-20251001`). |

## Automated tests

Run unit tests, including a SQLite smoke test (these use Node's built-in test runner):

```bash
npm test
```

Run browser end-to-end tests (first time only, install the Chromium browser):

```bash
npx playwright install chromium
npm run test:e2e
```

The E2E server uses port 3100 and a test-only JWT secret. It also disables the external AI key so the test checks the friendly no-key response without making paid API calls. E2E tests create uniquely named test accounts in `chat.db`; delete the local database only when you are certain you do not need its data.

## Manual smoke test
1. Open http://localhost:3000 in a normal window and sign up as `alice`.
2. Open a private/incognito window and sign up as `bob`.
3. Click each other in the list and send messages. They appear instantly on both sides.
4. Refresh: history is still there. Log out and back in: still there.

5. Open the **Kamand AI** chat, say hello, and ask a follow-up that depends on your first message (tests context).
6. Chat with `bob`, then in the Kamand AI chat type `/summarize bob`.
Without any key the AI works out of the box using a free keyless provider.
