const test = require('node:test');
const assert = require('node:assert/strict');

test('askAI falls through to the next free provider when one fails', async () => {
  const realFetch = global.fetch;
  delete process.env.LLM_API_KEY;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 429, json: async () => ({}) }; // first provider rate-limited
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'hi from provider two' } }] }) };
  };
  try {
    delete require.cache[require.resolve('../llm')];
    const { askAI } = require('../llm');
    const reply = await askAI({ messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(reply, 'hi from provider two');
    assert.equal(calls, 2, 'should have tried the second provider after the first failed');
  } finally {
    global.fetch = realFetch;
  }
});
