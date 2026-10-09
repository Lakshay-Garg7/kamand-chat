// ---------------------------------------------------------------
// llm.js - the ONLY file that talks to the AI provider.
//
// Default: a chain of free, KEYLESS, OpenAI-compatible text APIs. No signup,
// no API key, nothing to configure. Any single provider can be rate-limited or
// down at a given moment, so we try several in order until one answers.
// Optional: set LLM_API_KEY in .env to use Claude (Anthropic) instead.
// Any key is read from the server environment, never sent to the browser.
// ---------------------------------------------------------------
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const TIMEOUT_MS = 15000; // per attempt

// Free keyless providers, tried in order. Each is OpenAI-compatible and needs no auth header.
const FREE_PROVIDERS = [
  { chatUrl: 'https://text.pollinations.ai/openai', model: 'openai' },                              // gpt-oss-20b
  { chatUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions', model: 'gpt-oss-120b' },
  { chatUrl: 'https://gateway.vlm.run/v1/openai/chat/completions', model: 'qwen/qwen3.8-27b' },
];

// Runs one attempt under a timeout, turning an abort into a clear error.
async function withTimeout(fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('AI request timed out');
      e.code = 'timeout';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// One OpenAI-style provider (request and response).
async function askOpenAICompatible({ chatUrl, model, system, messages, maxTokens, signal }) {
  const res = await fetch(chatUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' }, // deliberately no Authorization: these are keyless lanes
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    }),
    signal,
  });
  if (!res.ok) {
    const err = new Error(`AI request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = String(data.choices?.[0]?.message?.content || '').trim();
  if (!text) {
    const err = new Error('AI returned an empty answer');
    err.code = 'empty';
    throw err;
  }
  return text;
}

// Claude (Anthropic), used only when LLM_API_KEY is set.
async function askAnthropic({ system, messages, maxTokens, signal }) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.LLM_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system,
      messages,
    }),
    signal,
  });
  if (!res.ok) {
    let type = '';
    try { type = (await res.json()).error?.type || ''; } catch { /* ignore */ }
    const err = new Error(`AI request failed (${res.status} ${type})`);
    err.status = res.status;
    err.type = type;
    throw err;
  }
  const data = await res.json();
  const text = (data.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  if (!text) {
    const err = new Error('AI returned an empty answer');
    err.code = 'empty';
    throw err;
  }
  return text;
}

// Ask the AI. `messages` looks like [{ role: 'user' | 'assistant', content: '...' }]
async function askAI({ system, messages, maxTokens = 600 }) {
  if (process.env.LLM_API_KEY) {
    return withTimeout((signal) => askAnthropic({ system, messages, maxTokens, signal }));
  }
  let lastError;
  for (const provider of FREE_PROVIDERS) {
    try {
      return await withTimeout((signal) => askOpenAICompatible({ ...provider, system, messages, maxTokens, signal }));
    } catch (err) {
      lastError = err; // this provider failed; try the next one
    }
  }
  throw lastError;
}

// Turns any error into a short, friendly message shown inside the chat.
// (It never includes the API key or technical details.)
function friendlyError(err) {
  if (err.code === 'timeout') return 'The AI took too long to answer. Please try again.';
  if (err.code === 'empty') return 'I could not come up with an answer. Please rephrase and try again.';
  if (err.status === 401 || err.status === 403) return 'The AI key was rejected. The app owner needs to check LLM_API_KEY.';
  if (err.status === 404) return 'The AI model name looks wrong. The app owner needs to check LLM_MODEL.';
  if (err.status === 429) return 'The AI is busy right now. Please wait a few seconds and try again.';
  if (err.status >= 500) return 'The AI service is having trouble. Please try again in a moment.';
  return 'Something went wrong while asking the AI. Please try again.';
}

module.exports = { askAI, friendlyError };
