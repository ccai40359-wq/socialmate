// Feature-switch acceptance (F1-F6): config fallback, decideAction lanes,
// contentRound downgrade semantics, reply/engage feature gates, browse
// budget/dedupe/never-publish, and server /api/config validation.
// Pure + mock page only — no browser, no publishing.
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
process.chdir(ROOT);

const results = [];
const pass = (d = '') => ({ __pass: true, detail: d });
const pending = [];
const check = (id, desc, fn) => {
  pending.push((async () => {
    try {
      const r = await fn();
      if (r === true) results.push({ id, desc, ok: true, detail: '' });
      else if (r && r.__pass === true) results.push({ id, desc, ok: true, detail: r.detail });
      else results.push({ id, desc, ok: false, detail: typeof r === 'string' ? r : String(r) });
    } catch (e) { results.push({ id, desc, ok: false, detail: e.message }); }
  })());
};

const cfgNow = JSON.parse(readFileSync('config.json', 'utf8'));

// ---- F1-c: default fallback ---------------------------------------------
check('F1-c', 'browseCfg falls back when features/browse are missing', async () => {
  const { browseCfg } = await import('../src/browse.mjs');
  const c = browseCfg({});
  if (c.features.post !== true) return 'features.post fallback != true';
  if (c.features.browse !== false) return 'features.browse fallback != false';
  if (c.browse.minutes !== 3) return 'browse.minutes fallback != 3';
  if (c.browse.maxScrolls !== 8) return 'browse.maxScrolls fallback != 8';
  if (c.browse.likeWhileBrowsing !== true) return 'likeWhileBrowsing fallback != true';
  return pass('defaults applied');
});

check('F1-c2', 'real config.json carries six boolean features', () => {
  const f = cfgNow.features;
  const keys = ['post', 'quote', 'muse', 'reply', 'like', 'browse'];
  const missing = keys.filter((k) => typeof f?.[k] !== 'boolean');
  return missing.length === 0 ? pass(JSON.stringify(f)) : 'missing/invalid: ' + missing.join(',');
});

check('F1-b', 'real config.json carries browse triple with right types', () => {
  const b = cfgNow.browse;
  if (typeof b?.minutes !== 'number' || typeof b?.maxScrolls !== 'number' || typeof b?.likeWhileBrowsing !== 'boolean') {
    return 'bad browse shape: ' + JSON.stringify(b);
  }
  return pass(JSON.stringify(b));
});

// ---- decideAction lanes ---------------------------------------------------
const sel = await import('../src/select.mjs');
const timelineC = { url: 'https://x.com/a/status/1', source: 'x-home', origin: 'https://x.com/a/status/1', text: 't', title: 't', likes: 100, lang: 'zh' };
const nativeC = { url: 'https://x.com/a/status/2', origin: 'https://x.com/a/status/2', text: 't2', title: 't2', likes: 100, lang: 'en' };

check('F2-a', 'features.quote=false never returns quote (timeline + native)', () => {
  const f = { quote: false };
  for (let i = 0; i < 80; i++) {
    const c = { ...timelineC, url: timelineC.url + '?i=' + i };
    const a = sel.decideAction(c, { quoteRatio: 0.9, museRatio: 0.5, features: f });
    if (a === 'quote') return 'decideAction returned quote with quote=false';
  }
  for (let i = 0; i < 80; i++) {
    const c = { ...nativeC, url: nativeC.url + '?i=' + i };
    if (sel.decideAction(c, { quoteRatio: 0.9, features: f }) === 'quote') return 'native quote with quote=false';
  }
  return true;
});

check('F2-b', 'features.muse=false never returns muse', () => {
  for (let i = 0; i < 80; i++) {
    const c = { ...timelineC, url: timelineC.url + '?i=' + i };
    if (sel.decideAction(c, { quoteRatio: 0.4, museRatio: 0.8, features: { muse: false } }) === 'muse') return 'returned muse with muse=false';
  }
  return true;
});

check('F2-d', 'post=false but quote=true still allows quote', () => {
  let sawQuote = false;
  for (let i = 0; i < 120; i++) {
    const c = { ...timelineC, url: timelineC.url + '?i=' + i };
    const a = sel.decideAction(c, { quoteRatio: 0.9, museRatio: 0.5, features: { post: false, quote: true, muse: true } });
    if (a === 'quote') { sawQuote = true; break; }
  }
  if (!sawQuote) return 'never produced quote with post=false/quote=true';
  // native too
  for (let i = 0; i < 120; i++) {
    const c = { ...nativeC, url: nativeC.url + '?i=' + i };
    if (sel.decideAction(c, { quoteRatio: 0.9, features: { post: false, quote: true } }) === 'quote') return true;
  }
  return true;
});

// ---- contentRound feature gates (isolated subprocess in a temp cwd) ----
function runContentCase(patch, { candidates = null, quoteLive = false } = {}) {
  const runUrl = 'file:///' + resolve('src/run.mjs').replace(/\\/g, '/');
  const dir = mkdtempSync(resolve(tmpdir(), 'sm-feat-case-'));
  mkdirSync(dir, { recursive: true });
  try {
    const cfg = JSON.parse(readFileSync('config.json', 'utf8'));
    Object.assign(cfg, patch);
    writeFileSync(resolve(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
    if (candidates) { mkdirSync(resolve(dir, 'queue'), { recursive: true }); writeFileSync(resolve(dir, 'queue', 'candidates.json'), JSON.stringify(candidates, null, 2), 'utf8'); }
    const script = [
      "const runUrl = '" + runUrl + "';",
      "const { contentRound } = await import(runUrl);",
      "const page = { url: () => 'https://x.com/home', async goto() {}, async waitForTimeout() {}, locator: () => ({ first: () => ({ isVisible: async () => " + (quoteLive ? 'true' : 'false') + " }) }), async evaluate() { return " + (quoteLive ? "'live tweet body'" : "''") + "; } };",
      "const r = await contentRound(page, { dryRun: true });",
      "console.log(JSON.stringify({ ok: r.ok, reason: r.reason, kind: r.kind, dryRun: r.dryRun }));",
    ].join('\n');
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8', timeout: 60000 });
    const last = (out.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    return { code: out.status, stdout: out.stdout, stderr: out.stderr, parsed: last ? JSON.parse(last) : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

check('F2-a-round', 'contentRound with quote=false produces a post draft (dryRun)', () => {
  const cand = [{ url: 'https://x.com/a/status/42', origin: 'https://x.com/a/status/42', title: 'plain post', text: 'plain post body', author: '@a', likes: 100, lang: 'en', source: 'aihot' }];
  const r = runContentCase({ voiceEnabled: false, features: { ...cfgNow.features, quote: false, muse: true } }, { candidates: cand });
  if (r.code !== 0) return 'subprocess failed: ' + r.stderr + r.stdout;
  if (!r.parsed || r.parsed.ok !== true || r.parsed.dryRun !== true) return 'round not ok: ' + JSON.stringify(r.parsed);
  if (r.parsed.kind !== 'post') return 'kind=' + r.parsed.kind + ', want post';
  return pass('kind=post dryRun');
});

check('F2-c', 'post/quote/muse all false -> contentRound skips, no draft', () => {
  const r = runContentCase({ voiceEnabled: false, features: { ...cfgNow.features, post: false, quote: false, muse: false } });
  if (r.code !== 0) return 'subprocess failed: ' + r.stderr + r.stdout;
  if (!r.parsed || r.parsed.ok !== false) return 'round should be ok:false, got ' + JSON.stringify(r.parsed);
  if (!/content-features-disabled/.test(r.parsed.reason || '')) return 'reason=' + r.parsed.reason;
  return pass('skipped');
});

check('F2-e', 'post=false + quote downgrade (pool gate) -> skip: post lane disabled', () => {
  const cand = [{ url: 'https://x.com/x/status/9001', origin: 'https://x.com/x/status/9001', title: 'low likes', text: 'low likes post', author: '@x', likes: 3, lang: 'en', source: 'aihot' }];
  const r = runContentCase(
    { voiceEnabled: false, features: { ...cfgNow.features, post: false, quote: true, muse: false } },
    { candidates: cand }
  );
  if (r.code !== 0) return 'subprocess failed: ' + r.stderr + r.stdout;
  if (!r.parsed || r.parsed.ok !== false) return 'expected skip, got ' + JSON.stringify(r.parsed);
  if (!/post-lane-disabled/.test(r.parsed.reason || '')) return 'reason=' + r.parsed.reason + ' (want post-lane-disabled)';
  return pass('blocked');
});

check('F2-d-round', 'post=false + quote=true + live target -> quote draft', () => {
  const cand = [{ url: 'https://x.com/x/status/9002', origin: 'https://x.com/x/status/9002', title: 'live', text: 'live original', author: '@x', likes: 100, lang: 'en', source: 'aihot' }];
  const r = runContentCase(
    { voiceEnabled: false, features: { ...cfgNow.features, post: false, quote: true, muse: false } },
    { candidates: cand, quoteLive: true }
  );
  if (r.code !== 0) return 'subprocess failed: ' + r.stderr + r.stdout;
  if (!r.parsed || r.parsed.ok !== true) return 'expected quote draft, got ' + JSON.stringify(r.parsed);
  if (r.parsed.kind !== 'quote') return 'kind=' + r.parsed.kind;
  return pass('quote dryRun');
});

// ---- reply / engage feature gates ---------------------------------------
check('F2-f', 'reply=false -> replyRound skips scan, logs, returns 0', () => {
  const runUrl = 'file:///' + resolve('src/run.mjs').replace(/\\/g, '/');
  const dir = mkdtempSync(resolve(tmpdir(), 'sm-feat-reply-'));
  mkdirSync(dir, { recursive: true });
  try {
    const cfg = JSON.parse(readFileSync('config.json', 'utf8'));
    cfg.features = { ...cfg.features, reply: false, like: false, browse: false };
    cfg.voiceEnabled = false;
    writeFileSync(resolve(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
    const script = [
      "const runUrl = '" + runUrl + "';",
      "const { replyRound } = await import(runUrl);",
      "const page = { url: () => 'https://x.com/home', async goto() {}, async waitForTimeout() {}, locator: () => ({ first: () => ({ isVisible: async () => false }) }), async evaluate() { return ''; } };",
      "const r = await replyRound(page);",
      "console.log(JSON.stringify(r));",
    ].join('\n');
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8', timeout: 60000 });
    if (out.status !== 0) return 'subprocess failed: ' + out.stderr + out.stdout;
    const last = (out.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    const r = last ? JSON.parse(last) : null;
    if (!r || r.checked !== 0 || r.acted !== 0) return 'replyRound did not skip: ' + JSON.stringify(r);
    if (r.skipped !== true) return 'skipped flag missing';
    return pass(JSON.stringify(r));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

check('F2-g', 'like=false -> engageRound skips, no like() calls', async () => {
  const { engageRound } = await import('../src/run.mjs');
  const calls = [];
  const page = { url: () => 'https://x.com/home', async goto(u) { calls.push('goto:' + u); }, async waitForTimeout() {}, locator() { return { first() { return { isVisible: async () => true, click: async () => {} }; } }; }, async evaluate() { return ''; } };
  const r = await engageRound(page, { cfg: { ...cfgNow, features: { ...cfgNow.features, like: false } }, pool: [{ url: 'https://x.com/a/status/1', likes: 100, lang: 'en' }], state: { engagesPublished: 0 }, stateFile: resolve(tmpdir(), 'sm-feat-state-' + Date.now() + '.json') });
  if (r.liked !== 0 || r.skipped !== true) return 'engage did not skip: ' + JSON.stringify(r);
  if (calls.some((c) => /status/.test(c))) return 'engage called goto for a like: ' + calls.join(',');
  return true;
});

// ---- browse --------------------------------------------------------------
check('F3-a', 'browseRound is a function', async () => {
  const { browseRound } = await import('../src/browse.mjs');
  return typeof browseRound === 'function' ? true : 'not a function';
});

const mkBrowsePage = () => {
  const calls = [];
  let tweets = [];
  return {
    calls,
    setTweets(rows) { tweets = rows; },
    async goto(u) { calls.push('goto:' + u); },
    async waitForTimeout() {},
    async evaluate(fn) { return tweets; },
    async mouse() { return { wheel: async () => { calls.push('wheel'); } }; },
    locator() {
      return {
        first() { return { async isVisible() { return true; }, async click() { calls.push('like-click'); } }; },
      };
    },
  };
};

check('F3-b', 'browseRound never calls a publish primitive', async () => {
  const src = readFileSync('src/browse.mjs', 'utf8');
  for (const prim of ['post(', 'quote(', 'reply(']) {
    if (src.includes(prim)) return 'publish primitive in browse.mjs: ' + prim;
  }
  const page = mkBrowsePage();
  page.setTweets([{ href: 'https://x.com/a/status/1', liked: false }]);
  const dir = mkdtempSync(resolve(tmpdir(), 'sm-feat-seen-'));
  mkdirSync(dir, { recursive: true });
  const r = await (await import('../src/browse.mjs')).browseRound(page, {
    cfg: { features: { browse: true }, browse: { minutes: 1, maxScrolls: 1, likeWhileBrowsing: true }, gate: { perKind: { engageDailyMax: 20 } } },
    state: { engagesPublished: 0 }, seenFile: resolve(dir, 'seen-likes.json'), maxLikes: 1,
  });
  rmSync(dir, { recursive: true, force: true });
  const bad = page.calls.filter((c) => /post|quote|reply/.test(c));
  return bad.length ? 'publish-ish call: ' + bad.join(',') : pass('browsed=' + r.browsed + ' liked=' + r.liked);
});

check('F3-c', 'browse budget over -> no browsing (no goto)', async () => {
  const { browseRound } = await import('../src/browse.mjs');
  const page = mkBrowsePage();
  const r = await browseRound(page, {
    cfg: { features: { browse: true }, browse: { minutes: 1, maxScrolls: 3 }, gate: { perKind: { browseDailyMax: 1 } } },
    state: { browsesPublished: 1, lastBrowseAt: Date.now(), engagesPublished: 0, lastEngageAt: 0 }, maxScrolls: 3,
  });
  if (r.skipped !== true) return 'not skipped';
  if (page.calls.some((c) => c.startsWith('goto:'))) return 'goto happened despite budget';
  return pass(r.reasons.join(','));
});

check('F3-d', 'checkKindBudget maps kind=browse to browseDailyMax', async () => {
  const { checkKindBudget } = await import('../src/gate.mjs');
  const r = checkKindBudget({ kind: 'browse', state: { browsesPublished: 5 }, cfg: { gate: { perKind: { browseDailyMax: 3 } } } });
  if (r.ok !== false) return 'browse quota not enforced';
  if (!/quota-browse/.test(r.reasons.join(','))) return 'wrong kind in reasons: ' + r.reasons.join(',');
  return pass('kind=' + r.kind);
});

check('F3-g', 'browse likes share the engage daily quota (dedupe + count)', async () => {
  const { browseRound } = await import('../src/browse.mjs');
  const dir = mkdtempSync(resolve(tmpdir(), 'sm-feat-seen2-'));
  mkdirSync(dir, { recursive: true });
  const seenFile = resolve(dir, 'seen-likes.json');
  writeFileSync(seenFile, JSON.stringify({ urls: [] }), 'utf8');
  const page = mkBrowsePage();
  page.setTweets([
    { href: 'https://x.com/a/status/10', liked: false },
    { href: 'https://x.com/b/status/11', liked: false },
  ]);
  const state = { engagesPublished: 0, lastEngageAt: 0 };
  const r = await browseRound(page, {
    cfg: { features: { browse: true }, browse: { minutes: 1, maxScrolls: 1, likeWhileBrowsing: true }, gate: { perKind: { engageDailyMax: 20 } } },
    state, seenFile, maxLikes: 5,
  });
  if (r.liked !== 2) return 'liked ' + r.liked + ', want 2';
  if (state.engagesPublished !== 2) return 'engagesPublished not incremented';
  const seen = JSON.parse(readFileSync(seenFile, 'utf8'));
  if ((seen.urls || []).length !== 2) return 'seen-likes not persisted';
  // second round must not like the same tweets again
  const page2 = mkBrowsePage();
  page2.setTweets([
    { href: 'https://x.com/a/status/10', liked: false },
    { href: 'https://x.com/b/status/11', liked: false },
  ]);
  const state2 = { engagesPublished: 2, lastEngageAt: 0 };
  const r2 = await browseRound(page2, {
    cfg: { features: { browse: true }, browse: { minutes: 1, maxScrolls: 1, likeWhileBrowsing: true }, gate: { perKind: { engageDailyMax: 20 } } },
    state: state2, seenFile, maxLikes: 5,
  });
  if (r2.liked !== 0) return 'second round liked already-seen tweets: ' + r2.liked;
  if (state2.engagesPublished !== 2) return 'engagesPublished grew on dedupe round';
  rmSync(dir, { recursive: true, force: true });
  return pass('shared quota + dedupe');
});

check('F3-g2', 'browse stops liking when engageDailyMax reached', async () => {
  const { browseRound } = await import('../src/browse.mjs');
  const dir = mkdtempSync(resolve(tmpdir(), 'sm-feat-seen3-'));
  mkdirSync(dir, { recursive: true });
  const seenFile = resolve(dir, 'seen-likes.json');
  writeFileSync(seenFile, JSON.stringify({ urls: [] }), 'utf8');
  const page = mkBrowsePage();
  page.setTweets([{ href: 'https://x.com/a/status/20', liked: false }]);
  const state = { engagesPublished: 20, lastEngageAt: 0 };
  const r = await browseRound(page, {
    cfg: { features: { browse: true }, browse: { minutes: 1, maxScrolls: 1, likeWhileBrowsing: true }, gate: { perKind: { engageDailyMax: 20 } } },
    state, seenFile, maxLikes: 5,
  });
  rmSync(dir, { recursive: true, force: true });
  if (r.liked !== 0) return 'liked past engageDailyMax: ' + r.liked;
  return pass('capped');
});

check('F3-b2', 'browse adds no drafts and never publishes', async () => {
  const src = readFileSync('src/browse.mjs', 'utf8');
  if (/addDraft|drafts\.mjs|post\(|quote\(|reply\(/.test(src)) return 'browse touches draft/publish';
  return true;
});

// ---- server /api/config validation (isolated: server cwd is a temp dir) ----
async function postConfigTemp(body, port) {
  const dir = mkdtempSync(resolve(tmpdir(), 'sm-feat-api-'));
  // Minimal config for server.mjs loadConfig
  writeFileSync(resolve(dir, 'config.json'), JSON.stringify({ autoMode: 'review' }, null, 2), 'utf8');
  const script = [
    "const { startServer } = await import('" + runUrl + "');",
    "const server = await startServer({ port: " + port + " });",
    "const r = await fetch('http://127.0.0.1:" + port + "/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: " + JSON.stringify(JSON.stringify(body)) + " });",
    "console.log('STATUS=' + r.status);",
    "server.close();",
  ].join('\n');
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8', timeout: 60000 });
  rmSync(dir, { recursive: true, force: true });
  if (out.status !== 0) return { status: -1, err: out.stderr + out.stdout };
  const m = /STATUS=(\d+)/.exec(out.stdout || '');
  return { status: m ? Number(m[1]) : -1, err: out.stdout + out.stderr };
}

check('F1-d', 'POST features:{post:"yes"} -> 400', async () => {
  const r = await postConfigTemp({ features: { post: 'yes' } }, 4233);
  return r.status === 400 ? true : 'status=' + r.status + (r.err ? ' :: ' + r.err : '');
});

check('F1-d2', 'POST features:[] (non-object) -> 400', async () => {
  const r = await postConfigTemp({ features: [] }, 4234);
  return r.status === 400 ? true : 'status=' + r.status + (r.err ? ' :: ' + r.err : '');
});

check('F1-e', 'POST browse:{minutes:0} / maxScrolls:999 / likeWhileBrowsing:"yes"} -> 400', async () => {
  for (const body of [{ browse: { minutes: 0 } }, { browse: { maxScrolls: 999 } }, { browse: { likeWhileBrowsing: 'yes' } }]) {
    const r = await postConfigTemp(body, 4235 + Math.floor(Math.random() * 100));
    if (r.status !== 400) return 'status=' + r.status + ' for ' + JSON.stringify(body);
  }
  return true;
});

check('F1-e2', 'POST browse:{minutes:60,maxScrolls:30} accepted', async () => {
  const r = await postConfigTemp({ browse: { minutes: 60, maxScrolls: 30 } }, 4236);
  return r.status === 200 ? true : 'status=' + r.status + (r.err ? ' :: ' + r.err : '');
});

check('F1-f', 'unknown config key still 400', async () => {
  const r = await postConfigTemp({ evilField: 1 }, 4237);
  return r.status === 400 ? true : 'status=' + r.status + (r.err ? ' :: ' + r.err : '');
});

// ---- F6 static invariants ------------------------------------------------
check('F6-a', 'features.* does not touch resolveGate / PUBLISH_FLAG', () => {
  const src = readFileSync('src/run.mjs', 'utf8');
  const gateRegion = src.slice(src.indexOf('export const PUBLISH_FLAG'), src.indexOf('// §9.2 off-minute scheduling'));
  if (/features/.test(gateRegion)) return 'features referenced inside the publish gate region';
  return true;
});

check('F6-b', 'browseRound sits inside the collectedThisLoop branch before the I2 skip', () => {
  const src = readFileSync('src/run.mjs', 'utf8');
  const first = src.indexOf('if (collectedThisLoop) {');
  const last = src.indexOf('let r = { ok: false };', first);
  if (first < 0 || last < 0) return 'collect/skip regions not found';
  const window = src.slice(first, last);
  if (!/browseRound/.test(window)) return 'browseRound not inside the collect branch';
  if (!/engageRound/.test(window)) return 'engageRound not in the same collect branch';
  if (!/continue/.test(window)) return 'I2 skip continue missing after browse';
  if (window.indexOf('browseRound') > window.indexOf('continue')) return 'browseRound runs AFTER the I2 skip';
  return pass('browse + engage before the I2 skip');
});

check('F6-e', 'CONFIG_WHITELIST contains features and browse', () => {
  const src = readFileSync('src/server.mjs', 'utf8');
  const line = src.slice(src.indexOf('CONFIG_WHITELIST'), src.indexOf('];', src.indexOf('CONFIG_WHITELIST')));
  if (!/features/.test(line)) return 'features missing from whitelist';
  if (!/browse/.test(line)) return 'browse missing from whitelist';
  return true;
});

check('F6-c', 'package.json dependencies unchanged', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  return Object.keys(pkg.dependencies || {}).join(',') === 'playwright' ? true : 'deps changed';
});

for (const p of pending) { await p; }
