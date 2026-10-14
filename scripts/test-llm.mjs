// LLM adapter conformance test (DoD D2b).
//
// Three protocols must each be exercised end-to-end: correct endpoint path,
// correct auth header style, correct request body shape, and correct response
// parsing. The hosted provider only speaks one protocol at a time, so the
// non-configured protocols are driven through a stubbed global fetch that
// records the outgoing request and replays a realistic provider response.
// Whatever protocol IS configured gets a real network round trip at the end.
import { loadProviderConfig, isConfigured, testConnection, complete, extractJson } from '../src/llm.mjs';

const results = [];
// Async-aware: every assertion is awaited so a stubbed fetch can never leak
// into the live round trip below (that leak silently broke an earlier draft).
async function check(name, fn) {
  try {
    const r = await fn();
    results.push({ name, ok: r === true, detail: r === true ? '' : String(r) });
  } catch (e) { results.push({ name, ok: false, detail: e.message }); }
}

const base = loadProviderConfig();
const KEY = 'test-key-not-a-secret';
const BODIES = {
  openai: { model: 'm', choices: [{ finish_reason: 'stop', message: { content: 'chat-ok' } }] },
  anthropic: { model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'anthropic-ok' }] },
  'openai-responses': { model: 'm', status: 'completed', output_text: 'responses-ok' },
};

// Drive complete() for one protocol behind a fetch stub, capturing the request.
async function drive(protocol, messages = [{ role: 'user', content: 'hi' }]) {
  const realFetch = globalThis.fetch;
  const seen = {};
  globalThis.fetch = async (url, init) => {
    seen.url = String(url);
    seen.headers = init.headers;
    seen.body = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify(BODIES[protocol]) };
  };
  try {
    const text = await complete(messages, {
      cfg: { protocol, baseURL: 'https://example.test/v1', model: 'm', apiKey: KEY, cheapModel: 'm' },
      model: 'm', maxTokens: 300, temperature: 0,
    });
    return { text, seen };
  } finally { globalThis.fetch = realFetch; }
}

// Capture the request only (for shape assertions that do not care about text).
async function capture(protocol, messages = [{ role: 'user', content: 'hi' }]) {
  const { seen } = await drive(protocol, messages);
  return seen;
}

await check('openai -> POST {base}/chat/completions', async () => {
  const d = await drive('openai');
  if (!/\/chat\/completions$/.test(d.seen.url)) return 'wrong url: ' + d.seen.url;
  if (!/^Bearer /.test(d.seen.headers.Authorization || '')) return 'missing Bearer auth header';
  if (!Array.isArray(d.seen.body.messages)) return 'body.messages missing';
  if (d.seen.body.model !== 'm') return 'model not passed through';
  if (d.text !== 'chat-ok') return 'parsed text wrong: ' + JSON.stringify(d.text);
  return true;
});

await check('anthropic -> POST {base}/v1/messages with x-api-key', async () => {
  const d = await drive('anthropic');
  if (!/\/v1\/messages$/.test(d.seen.url)) return 'wrong url: ' + d.seen.url;
  if (!d.seen.headers['x-api-key']) return 'missing x-api-key header';
  if (!d.seen.headers['anthropic-version']) return 'missing anthropic-version header';
  if (d.seen.headers.Authorization) return 'anthropic must not send Bearer auth';
  if (!Array.isArray(d.seen.body.messages)) return 'body.messages missing';
  if (d.seen.body.max_tokens == null) return 'anthropic body needs max_tokens';
  if (d.text !== 'anthropic-ok') return 'content[].text parsing wrong: ' + JSON.stringify(d.text);
  return true;
});

await check('openai-responses -> POST {base}/responses', async () => {
  const d = await drive('openai-responses');
  if (!/\/responses$/.test(d.seen.url)) return 'wrong url: ' + d.seen.url;
  if (!Array.isArray(d.seen.body.input)) return 'body.input missing';
  if (d.seen.body.messages) return 'responses body must not use chat messages';
  if (d.text !== 'responses-ok') return 'output_text parsing wrong: ' + JSON.stringify(d.text);
  return true;
});

await check('anthropic hoists system out of messages', async () => {
  const seen = await capture('anthropic', [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'u' }]);
  if (seen.body.system !== 'SYS') return 'system not hoisted: ' + JSON.stringify(seen.body.system);
  if (seen.body.messages.some((m) => m.role === 'system')) return 'system left inside messages';
  return true;
});

await check('openai keeps system inside messages', async () => {
  const seen = await capture('openai', [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'u' }]);
  if (!seen.body.messages.some((m) => m.role === 'system')) return 'system dropped for openai';
  return true;
});

await check('non-2xx response throws (no silent empty publish)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  try {
    await complete([{ role: 'user', content: 'hi' }], {
      cfg: { protocol: 'openai', baseURL: 'https://example.test/v1', model: 'm', apiKey: KEY }, model: 'm',
    });
    return 'expected a throw on HTTP 401';
  } catch (e) {
    return /401/.test(e.message) ? true : 'unexpected error: ' + e.message;
  } finally { globalThis.fetch = realFetch; }
});

await check('empty content throws instead of publishing nothing', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ model: 'm', choices: [{ finish_reason: 'stop', message: { content: '' } }] }),
  });
  try {
    await complete([{ role: 'user', content: 'hi' }], {
      cfg: { protocol: 'openai', baseURL: 'https://example.test/v1', model: 'm', apiKey: KEY }, model: 'm',
    });
    return 'expected a throw on empty content';
  } catch (e) {
    return /empty content/.test(e.message) ? true : 'unexpected error: ' + e.message;
  } finally { globalThis.fetch = realFetch; }
});

await check('missing apiKey -> honest failure, no throw', async () => {
  const r = await testConnection({ protocol: 'openai', baseURL: 'https://example.test/v1', model: 'm', apiKey: '' });
  if (r.ok !== false) return 'expected ok:false';
  if (!r.error) return 'expected an error message';
  return true;
});

await check('extractJson survives fenced / noisy / absent payloads', () => {
  if (JSON.stringify(extractJson('x\n```json\n{"a":1}\n```\ny')) !== '{"a":1}') return 'fenced failed';
  if (JSON.stringify(extractJson('r {"a":{"b":2}} z')) !== '{"a":{"b":2}}') return 'noisy failed';
  if (extractJson('no json here') !== null) return 'absent failed';
  return true;
});

// Live round trip on whichever protocol is actually configured. A provider
// that refuses its own configured protocol is a real finding, reported with
// the provider's own message rather than swallowed.
let live = null;
if (isConfigured(base)) {
  live = await testConnection();
  await check(`live testConnection on configured protocol (${base.protocol})`, () => {
    return live.ok ? true : 'provider rejected the configured protocol: ' + String(live.error).slice(0, 200);
  });
} else {
  await check('live testConnection skipped: no apiKey configured', () => true);
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  :: ' + r.detail : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
console.log(`live: ${live ? JSON.stringify(live) : 'skipped'}`);
process.exitCode = failed ? 1 : 0;
