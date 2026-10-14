// A2b: a quote target must be a LIVE original tweet.
//
// pickQuoteTarget used to hand back any native x.com/status URL found in a
// candidate's origin. If that post had been deleted or made private, quote()
// would fail at publish time. It now navigates to the URL first and degrades
// to null (caller falls back to a plain post) when the tweet is not there.
//
// No browser needed: the page surface pickQuoteTarget touches is tiny
// (goto / waitForTimeout / locator().first().isVisible() / evaluate), so a
// mock pins the contract exactly.
import { pickQuoteTarget } from '../src/run.mjs';

const results = [];
// Async-aware: pickQuoteTarget is async, so every assertion is awaited
// (a sync helper here silently records a Promise as a failure).
const check = async (name, fn) => {
  try {
    const r = await fn();
    results.push({ name, ok: r === true, detail: r === true ? '' : String(r) });
  } catch (e) { results.push({ name, ok: false, detail: e.message }); }
};

function mockPage({ tweetVisible = true, bodyText = '', throwOnGoto = false } = {}) {
  return {
    visited: null,
    async goto(url) { if (throwOnGoto) throw new Error('net::ERR_TIMEOUT'); this.visited = url; },
    async waitForTimeout() {},
    locator() {
      return { first() { return { async isVisible() { return tweetVisible; } }; } };
    },
    async evaluate() { return bodyText; },
  };
}

const LIVE = 'https://x.com/OpenRouter/status/2107929204142874759';
const base = { origin: LIVE, text: 'original body', author: '@OpenRouter' };

await check('live tweet -> native target, x.com normalised', async () => {
  const p = mockPage({ tweetVisible: true, bodyText: 'some tweet body' });
  const t = await pickQuoteTarget(p, base);
  if (!t) return 'returned null for a live tweet';
  if (t.how !== 'native') return 'how=' + t.how;
  if (!/^https:\/\/x\.com\/[^/]+\/status\/\d+$/.test(t.url)) return 'bad url: ' + t.url;
  if (p.visited !== t.url) return 'did not navigate to the target url';
  return true;
});

await check('missing tweet article -> null (dead original)', async () => {
  const p = mockPage({ tweetVisible: false, bodyText: 'something else entirely' });
  const t = await pickQuoteTarget(p, base);
  return t === null ? true : 'returned ' + JSON.stringify(t) + ' for a page with no tweet article';
});

await check('tweet article present but "此帖不可用" -> null', async () => {
  const p = mockPage({ tweetVisible: true, bodyText: '此帖不可用，可能已被删除' });
  const t = await pickQuoteTarget(p, base);
  return t === null ? true : 'dead-text page was accepted: ' + JSON.stringify(t);
});

await check('"This post is unavailable" -> null', async () => {
  const p = mockPage({ tweetVisible: true, bodyText: 'This post is unavailable.' });
  const t = await pickQuoteTarget(p, base);
  return t === null ? true : 'english dead-text page was accepted';
});

await check('navigation failure -> null, never throws', async () => {
  const p = mockPage({ throwOnGoto: true });
  const t = await pickQuoteTarget(p, base);
  return t === null ? true : 'threw or returned ' + JSON.stringify(t) + ' on a navigation error';
});

await check('non-native origin (blog/aihot url) -> null', async () => {
  for (const origin of ['https://vllm.ai/blog/2026-10-07-deepseek-v41-flash', 'https://aihot.news/items/abc', '']) {
    const p = mockPage({});
    const t = await pickQuoteTarget(p, { origin, text: 'x' });
    if (t !== null) return 'accepted non-native origin ' + JSON.stringify(origin);
    if (p.visited) return 'navigated for non-native origin ' + JSON.stringify(origin);
  }
  return true;
});

await check('twitter.com origin is normalised to x.com', async () => {
  const p = mockPage({ tweetVisible: true, bodyText: 'body' });
  const t = await pickQuoteTarget(p, { origin: 'https://twitter.com/someone/status/123456789' });
  if (!t) return 'returned null';
  if (!t.url.startsWith('https://x.com/')) return 'not normalised: ' + t.url;
  return true;
});

await check('no publish primitive is reachable from pickQuoteTarget', async () => {
  const src = (await import('node:fs')).readFileSync('src/run.mjs', 'utf8');
  const start = src.indexOf('export async function pickQuoteTarget');
  const end = src.indexOf('\n}', start);
  const body = src.slice(start, end);
  for (const prim of ['post(', 'quote(', 'reply(', 'like(']) {
    if (body.includes(prim)) return 'publish primitive ' + prim + ' inside pickQuoteTarget';
  }
  return true;
});

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  :: ' + r.detail : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
