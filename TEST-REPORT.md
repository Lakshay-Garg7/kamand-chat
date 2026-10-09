# Kamand Chat — Test Report

Date: 2026-10-09

## Status: verified working end to end

## Environment
- Node.js 24.19.0, npm 11.17.0, Windows 10
- Database: Node's built-in `node:sqlite` module (no native build; requires Node 22.5+)

## Change made since the previous report
The previous report was blocked because `better-sqlite3@11.10.0` had no prebuilt binary for
Node 24 and could not be compiled without Visual Studio C++ build tools. That native
dependency has been removed: the app now uses Node's built-in `node:sqlite`, which needs no
compilation and no install-script approval. The `allowScripts` block was removed from
`package.json`.

The AI assistant works out of the box with a chain of free, keyless providers: it tries several
public APIs in turn, so a reply gets through even when one is busy or rate-limited. No
`LLM_API_KEY` is required; setting one routes to Claude (Anthropic) instead.

## Results

| Check | Command | Result |
|-------|---------|--------|
| SQLite smoke | `npm run check:sqlite` | pass |
| Unit tests | `npm test` | 6 pass / 0 fail |
| End-to-end (Playwright + Chromium) | `npm run test:e2e` | 6 pass / 0 fail |
| REST API smoke (manual) | see below | pass |

End-to-end coverage: signup creates a persistent session; logout clears it; wrong password
rejected; duplicate username rejected without replacing the active account; two users exchange
real-time messages with online presence; history survives a page reload; typing indicator on
and off; empty message creates nothing; the AI assistant replies to a message using the free
keyless provider chain.

REST API smoke: signup 200, session (`/api/me`) 200, duplicate signup 409, short password 400,
invalid username 400, wrong password 401, unauthenticated `/api/users` 401.

## Not verified
- Browsers other than Chromium, more than two simultaneous users, and deployment.
- The optional Claude path is used only when `LLM_API_KEY` is set; it is not exercised by the
  default test run.

## Setup (clean machine)
```bash
npm run setup:env
npm install
npm start
```
Open http://localhost:3000
