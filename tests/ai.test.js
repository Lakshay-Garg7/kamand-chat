const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildChatMessages,
  buildTranscript,
  parseCommand,
  createRateLimiter,
} = require('../ai');

test('parseCommand recognizes summarize commands and normal text', () => {
  assert.deepEqual(parseCommand('  /summarize bob  '), { command: 'summarize', arg: 'bob' });
  assert.deepEqual(parseCommand('/SUMMARIZE   alice extra'), { command: 'summarize', arg: 'alice extra' });
  assert.equal(parseCommand('hello there'), null);
});

test('buildChatMessages starts with user and merges adjacent roles', () => {
  const messages = buildChatMessages([
    { sender_id: 7, content: 'old bot answer' },
    { sender_id: 4, content: 'hello' },
    { sender_id: 4, content: 'another thought' },
    { sender_id: 7, content: 'reply' },
  ], 7);
  assert.deepEqual(messages, [
    { role: 'user', content: 'hello\nanother thought' },
    { role: 'assistant', content: 'reply' },
  ]);
});

test('buildTranscript labels speakers and caps individual messages', () => {
  const transcript = buildTranscript([
    { sender_id: 4, content: 'hello' },
    { sender_id: 99, content: 'unknown speaker' },
  ], { 4: 'alice' });
  assert.equal(transcript, 'alice: hello\nUnknown: unknown speaker');
});

test('rate limiter allows max hits then blocks until window expires', () => {
  const allow = createRateLimiter(2, 1000);
  assert.equal(allow(1, 100), true);
  assert.equal(allow(1, 200), true);
  assert.equal(allow(1, 300), false);
  assert.equal(allow(2, 300), true, 'limits are per user');
  assert.equal(allow(1, 1201), true, 'old hits expire outside the window');
});
