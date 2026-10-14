// Server acceptance test: real HTTP against a real server on a test port.
// Asserts the API's security-relevant promises, not just liveness.
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
process.chdir(ROOT);

const PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const ok = (name, detail = '') => results.push({ name, ok: true, detail });
const bad = (name, detail) => results.push({ name, ok: false, detail: String(detail) });

function assert(name, cond, detail = '') {
  if (cond) ok(name, detail); else bad(name, 'ASSERT FAILED ' + detail);
}

const realKey = (() => {
  try { return JSON.parse(readFileSync(resolve('secrets.json'), 'utf8')).apiKey || ''; }
  catch { return ''; }
})();

// Snapshot the files the API is allowed to write so we can restore them.
const SNAPSHOT = {};
for (const f of ['config.json', 'provider.json', 'secrets.json', 'control.json', 'cache/account.json', 'cache/avatar.json']) {
  SNAPSHOT[f] = existsSync(resolve(f)) ? readFileSync(resolve(f), 'utf8') : null;
}

const { startServer } = await import('../src/server.mjs');
const server = await startServer({ port: PORT });
ok('server starts and listens', `http://127.0.0.1:${PORT}`);

const get = async (p) => {
  const r = await fetch(BASE + p);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
};
const post = async (p, body) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
};

try {
  // --- static renderer ---------------------------------------------------
  const index = await get('/');
  assert('GET / serves the renderer html', index.status === 200 && /SocialMate/.test(index.text));
  const css = await fetch(BASE + '/style.css');
  assert('GET /style.css served', css.status === 200 && (await css.text()).includes('.sidebar'));
  const appjs = await fetch(BASE + '/app.js');
  assert('GET /app.js served', appjs.status === 200);
  const escape = await get('/../src/llm.mjs');
  assert('path traversal blocked', escape.status === 403 || escape.status === 404, `status=${escape.status}`);

  // Encoded traversal survives URL normalisation and used to be served from a
  // sibling directory sharing the renderer prefix. Assert containment, not 404s.
  for (const probe of ['/..%2f%2e%2e/secrets.json', '/..%2fsrc%2fllm.mjs', '/..%2fpackage.json']) {
    const r = await get(probe);
    assert(`encoded traversal refused: ${probe}`, r.status === 403 || r.status === 404, `status=${r.status}`);
    assert('  ...and no content leaked', !/user_zf4v|apiKey|export function/.test(r.text));
  }
  // --- status ------------------------------------------------------------
  const st = await get('/api/status');
  assert('GET /api/status ok', st.status === 200 && st.json?.ok === true);
  assert('status exposes account + mode + daemon', !!st.json.account && !!st.json.mode && typeof st.json.daemon?.running === 'boolean');
  assert('status has no secret fields', !/apiKey|api_key|token/i.test(st.text), st.text.slice(0, 120));
  // --- avatar -----------------------------------------------------------
  const av = await get('/api/avatar');
  assert('GET /api/avatar ok', av.status === 200 && av.json?.ok === true);
  assert('avatar body has no secret fields', !/apiKey|api_key|sk-|token/i.test(av.text), av.text.slice(0, 120));
  assert('avatar url is a string or null', typeof av.json.url === 'string' || av.json.url === null);

  // I4: the log is not an API response, but a leaked key there is still a leak.
  const logText = existsSync(resolve('log.txt')) ? readFileSync(resolve('log.txt'), 'utf8') : '';
  assert('log.txt has no secret fields', !/apiKey|api_key|sk-[A-Za-z0-9]{8,}/i.test(logText) && (!realKey || !logText.includes(realKey)));


  // --- provider: never leaks the key ------------------------------------
  const pv = await get('/api/provider');
  assert('GET /api/provider ok', pv.status === 200 && pv.json?.ok === true);
  assert('provider reports hasKey boolean', typeof pv.json.hasKey === 'boolean');
  assert('provider body contains NO plaintext key', !realKey || !pv.text.includes(realKey));
  assert('provider body has no apiKey field', !("apiKey" in (pv.json.provider || {})));

  // --- config: whitelist + clamping -------------------------------------
  const cfg = await get('/api/config');
  assert('GET /api/config ok', cfg.status === 200 && cfg.json?.ok === true);
  assert('config never returns apiKey', !("apiKey" in (cfg.json.config || {})));
  assert('config advertises editable whitelist', Array.isArray(cfg.json.editable) && cfg.json.editable.includes('dailyTarget'));

  const badKey = await post('/api/config', { evilField: 1 });
  assert('unknown config key rejected (400)', badKey.status === 400 && /rejected/.test(badKey.json?.error || ''));

  const badRange = await post('/api/config', { dailyTarget: 9999 });
  assert('out-of-range dailyTarget rejected (400)', badRange.status === 400);

  const badMode = await post('/api/config', { autoMode: 'yolo' });
  assert('invalid autoMode in config -> 400', badMode.status === 400);
  const badHours = await post('/api/config', { activeHours: { start: 99, end: 5 } });
  assert('invalid activeHours -> 400', badHours.status === 400);
  const badVoice = await post('/api/config', { voiceEnabled: 'yes' });
  assert('non-boolean voiceEnabled -> 400', badVoice.status === 400);
  const inverted = await post('/api/config', { activeHours: { start: 23, end: 8 } });
  assert('inverted activeHours window -> 400', inverted.status === 400);  const mergedSafe = await post('/api/config', { safety: { allowPolitics: false } });
  assert('safety partial patch merges', mergedSafe.status === 200);
  const goodCfg = await post('/api/config', { dailyTarget: 20, quoteRatio: 0.4, minGapMinutes: 60, activeHours: { start: 8, end: 23 } });
  assert('valid config accepted', goodCfg.status === 200 && goodCfg.json?.ok === true);

  // --- control -----------------------------------------------------------
  const ctlBad = await post('/api/control', { mode: 'yolo' });
  assert('invalid mode rejected (400)', ctlBad.status === 400);
  const ctl = await post('/api/control', { paused: true, mode: 'review' });
  assert('control pause accepted', ctl.status === 200 && ctl.json?.control?.paused === true);
  const st2 = await get('/api/status');
  assert('status reflects paused=true', st2.json?.paused === true);
  const ctl2 = await post('/api/control', { paused: false });
  assert('control resume clears pauseReason', ctl2.json?.control?.paused === false && ctl2.json?.control?.pauseReason === null);
  const ctlAuto = await post('/api/control', { mode: 'auto' });
  assert('control auto mode accepted', ctlAuto.json?.control?.mode === 'auto');
  await post('/api/control', { mode: 'review' });

  // --- drafts ------------------------------------------------------------
  const dr = await get('/api/drafts');
  assert('GET /api/drafts ok', dr.status === 200 && dr.json?.ok === true && Array.isArray(dr.json.drafts));
  const miss = await post('/api/drafts/999999/reject');
  assert('reject unknown draft -> 404', miss.status === 404);
  const missUp = await post('/api/drafts/999999/update', { text: 'x' });
  assert('update unknown draft -> 404', missUp.status === 404);
  const noText = await post('/api/drafts/999999/update', {});
  assert('update without text -> 400', noText.status === 400);

  // --- provider write validation ----------------------------------------
  const noUrl = await post('/api/provider', { baseURL: '', model: 'x' });
  assert('provider without baseURL -> 400', noUrl.status === 400);
  const noModel = await post('/api/provider', { baseURL: 'https://a.b/v1', model: '' });
  assert('provider without model -> 400', noModel.status === 400);
  const badProto = await post('/api/provider', { protocol: 'hack', baseURL: 'https://a.b/v1', model: 'm' });
  const pvAfter = await get('/api/provider');
  assert('unknown protocol falls back to openai', badProto.status === 200 && pvAfter.json.provider.protocol === 'openai');

  // --- logs --------------------------------------------------------------
  const logs = await get('/api/logs?lines=5');
  assert('GET /api/logs ok', logs.status === 200 && logs.json?.ok === true && Array.isArray(logs.json.lines));
  assert('logs clamps senseless input', (await get('/api/logs?lines=abc')).status === 200);


  // --- offline account/avatar fallback (driver-injected, no live CDP) ----
  const acctMod = await import('../src/account.mjs');
  // stale in-memory caches would mask a live-read failure; force disk path
  // by importing a fresh instance with a distinct URL is not possible for
  // module singletons, so write the expected cache and verify the API
  // degrades to it only when no live read is available.
  const cacheDir = resolve('cache');
  try { mkdirSync(cacheDir, { recursive: true }); } catch {}
  writeFileSync(resolve('cache/account.json'), JSON.stringify({ name: '缓存用户', handle: '@cacheuser', fetchedAt: Date.now() }, null, 2), 'utf8');
  writeFileSync(resolve('cache/avatar.json'), JSON.stringify({ url: 'https://pbs.twimg.com/profile_images/1/cache_normal.jpg', fetchedAt: Date.now() }, null, 2), 'utf8');
  // Simulate CDP being down by injecting a failing driver via module cache.
  // The server module imports account.mjs once; instead of fighting that,
  // assert the pure read functions' offline behaviour directly.
  const pure = await import('../src/account.mjs');
  pure.resetCaches();
  const failDriver = { readAccountText: async () => { throw new Error('cdp down'); }, readAvatarSrc: async () => { throw new Error('cdp down'); } };
  const offlineAcct = await pure.readAccount({}, { driver: failDriver });
  assert('readAccount falls back to disk cache when live read fails', offlineAcct.account === '缓存用户 @cacheuser', offlineAcct.account);
  const offlineAv = await pure.readAvatar({}, { driver: failDriver });
  assert('readAvatar falls back to disk cache when live read fails', offlineAv.url === 'https://pbs.twimg.com/profile_images/1/cache_normal.jpg', offlineAv.url);
  rmSync(resolve('cache/account.json'), { force: true });
  pure.resetCaches();
  const noCacheAcct = await pure.readAccount({}, { driver: { readAccountText: async () => { throw new Error('down'); } } });
  assert('readAccount returns null when no cache either', noCacheAcct.account === null, String(noCacheAcct.account));

  // --- 404 ---------------------------------------------------------------
  const nf = await get('/api/nope');
  assert('unknown api route -> 404', nf.status === 404);
} finally {
  server.close();
  for (const [f, content] of Object.entries(SNAPSHOT)) {
    const abs = resolve(f);
    if (content === null) { try { rmSync(abs); } catch {} }
    else { const fs = await import('node:fs'); fs.writeFileSync(abs, content, 'utf8'); }
      try { fs.mkdirSync('cache', { recursive: true }); } catch {}
  }
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  :: ' + r.detail : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.error('FAILURES:', failed.length); process.exit(1); }
process.exit(0);
