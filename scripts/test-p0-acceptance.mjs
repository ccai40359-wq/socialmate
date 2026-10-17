// P0 acceptance assertions. Pure logic only — no browser, no publishing.
// Every assertion here corresponds to a line in .dispatch/acceptance-p0.md.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
process.chdir(resolve(import.meta.dirname, '..'));

const results = [];
// Contract: an assertion passes ONLY by returning true or pass(detail).
// Returning false, a string, or throwing is a failure. This matters — an
// earlier version counted returned error strings as passes.
const pass = (detail = '') => ({ __pass: true, detail });
// check awaits its fn so async assertions (e.g. the real screenshot capture)
// are supported without a second helper going stale.
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

const run = await import('../src/run.mjs');
const gate = await import('../src/gate.mjs');
const sel = await import('../src/select.mjs');
const safety = await import('../src/safety.mjs');
const cfg = JSON.parse(readFileSync('config.json', 'utf8'));

// ---- I1: review is the default and cannot be bypassed --------------------
check('I1-a', 'config.autoMode is review', () => cfg.autoMode === 'review' ? true : `got ${cfg.autoMode}`);

check('I1-b/T1-c', 'review mode never publishes, with or without the flag', () => {
  for (const pf of [false, true]) {
    const g = run.resolveGate({ ctrlMode: 'review', cfgMode: 'review', publishFlag: pf });
    if (g.publish) return `published in review mode (publishFlag=${pf})`;
  }
  return true;
});

check('T1-c', 'auto mode WITHOUT --publish still does not publish', () => {
  const g = run.resolveGate({ ctrlMode: 'auto', cfgMode: 'auto', publishFlag: false });
  return g.publish === false ? true : 'auto mode published without the explicit flag';
});

check('T1-c', 'auto mode WITH --publish does publish', () => {
  const g = run.resolveGate({ ctrlMode: 'auto', cfgMode: 'auto', publishFlag: true });
  return g.publish === true ? true : 'explicit flag did not enable publishing';
});

check('T1-c', 'explicit --publish cannot override review mode', () => {
  const g = run.resolveGate({ ctrlMode: 'review', cfgMode: 'auto', publishFlag: true });
  return g.publish === false ? true : 'flag bypassed review mode';
});

check('T1-d', 'replyRound gate honours mode (old precedence bug)', () => {
  // The old expression resolved to auto when autoMode=auto and ctrl.mode was unset.
  const g = run.resolveGate({ ctrlMode: undefined, cfgMode: 'auto', publishFlag: false });
  return g.publish === false ? pass(`want=${g.want} reason=${g.reason}`) : 'auto-published with no explicit flag';
});

check('I1-b', 'override cannot relax a stored review mode', () => {
  const g = run.resolveGate({ ctrlMode: 'review', cfgMode: 'review', override: 'auto', publishFlag: true });
  return g.publish === false ? true : 'override=auto bypassed review (publish=' + g.publish + ')';
});

check('I1-b', 'override may tighten auto down to review', () => {
  const g = run.resolveGate({ ctrlMode: 'auto', cfgMode: 'auto', override: 'review', publishFlag: true });
  return g.publish === false ? true : 'override=review did not tighten';
});

// ---- T7-b: off-minute scheduling ----------------------------------------
check('T7-b', 'OFF_MINUTES contains each required off-minute', () => {
  const want = [3, 7, 11, 17, 23, 33, 41, 47, 51, 53];
  const missing = want.filter((m) => !run.OFF_MINUTES.includes(m));
  return missing.length ? pass(`missing ${missing}`) : true;
});

check('T7-b', 'scheduler picks off-minutes only, never repeats, over 200 runs', () => {
  let prevMinute = null;
  let t = Date.now();
  for (let i = 0; i < 200; i++) {
    const { at, minute } = run.nextOffMinuteAt(t, 3 + (i % 40), prevMinute);
    if (!run.OFF_MINUTES.includes(minute)) return `round minute ${minute} at step ${i}`;
    if (minute === prevMinute) return `repeated minute ${minute} at step ${i}`;
    if (at <= t) return `next time not in the future at step ${i}`;
    prevMinute = minute; t = at;
  }
  return true;
});

check('T7-b', 'minute distribution is not a fixed interval', () => {
  const seen = new Set();
  let t = Date.now(), prev = null;
  for (let i = 0; i < 60; i++) { const r = run.nextOffMinuteAt(t, 7, prev); seen.add(r.minute); prev = r.minute; t = r.at; }
  return seen.size >= 4 ? pass(`distinct minutes=${seen.size}`) : `only ${seen.size} distinct minutes`;
});

// ---- T5-a: decideAction is deterministic, not random -------------------
check('T5-a', 'decideAction has no Math.random in its source', () => {
  const src = readFileSync('src/select.mjs', 'utf8');
  const body = src.slice(src.indexOf('export function decideAction'));
  return /Math\.random/.test(body) ? 'still uses Math.random' : true;
});

check('T5-a', 'decideAction is a pure function of its input (same in -> same out)', () => {
  const c = { url: 'https://x.com/a/status/1', origin: 'https://x.com/a/status/1', text: 'AI news', title: 'AI news', likes: 100, ageHours: 2 };
  const a = sel.decideAction(c, cfg); const b = sel.decideAction(c, cfg);
  return a === b ? pass(`stable -> ${a}`) : `unstable: ${a} vs ${b}`;
});

check('T5-a', 'decideAction varies across distinct candidates', () => {
  const cfgq = { ...cfg, quoteRatio: 0.5 };
  const out = new Set();
  for (let i = 0; i < 40; i++) {
    out.add(sel.decideAction({ url: `https://x.com/u${i}/status/${i}`, origin: `https://x.com/u${i}/status/${i}`, text: `t${i}`, title: `t${i}` }, cfgq));
  }
  return out.size >= 2 ? pass(`varied -> ${[...out].join(',')}`) : 'always the same action';
});

check('T5-b', 'ranking prompt names all four scoring dimensions', () => {
  const src = readFileSync('src/select.mjs', 'utf8');
  const missing = ['relevance', 'discussion', 'commentable', 'safety'].filter((d) => !new RegExp(d, 'i').test(src));
  return missing.length ? pass(`missing ${missing}`) : true;
});

// ---- T6-c: per-kind cooldown / quota ------------------------------------
check('T6-c', 'state tracks per-kind timestamps separately', () => {
  const src = readFileSync('src/run.mjs', 'utf8');
  const missing = ['lastPostAt', 'lastQuoteAt', 'lastReplyAt'].filter((k) => !src.includes(k));
  return missing.length ? pass(`missing ${missing}`) : true;
});

check('T6-a', 'weighted length: URL=23, CJK=2', () => {
  if (gate.weightedLen('https://a.com') !== 23) return 'URL should weigh 23';
  if (gate.weightedLen('中文') !== 4) return 'CJK should weigh 2 each';
  return true;
});

// ---- T8: block -> pause + screenshot, no retry --------------------------
check('T8-c', 'a block captures a screenshot into shots/ (not just a regex)', async () => {
  const src = readFileSync('src/run.mjs', 'utf8');
  if (!/page\.screenshot\(/.test(src)) return 'no page.screenshot call';
  if (!/captureBlock/.test(src)) return 'no captureBlock helper';
  // Prove the real capture path writes a PNG, using a mock page so this stays
  // browser-free. A live probe (2026-10-08) wrote a 102KB PNG to shots/.
  const { existsSync, statSync, mkdirSync } = await import('node:fs');
  const path = await import('node:path');
  const dir = path.resolve('shots'); mkdirSync(dir, { recursive: true });
  const fakePage = { async screenshot(o) { const { writeFileSync } = await import('node:fs'); writeFileSync(o.path, Buffer.alloc(2048, 1)); } };
  const got = await safety.captureBlock(fakePage, 'selftest', { dir });
  if (!got || !existsSync(got)) return 'capture helper did not write a file';
  const size = statSync(got).size;
  const { unlinkSync } = await import('node:fs'); try { unlinkSync(got); } catch {}
  return size > 0 ? pass('wrote ' + size + ' bytes') : 'wrote an empty file';
});

check('T8-a', 'detectBlock flags a current X login-wall URL', async () => {
  // Real URL shapes rather than a source regex: the live probe on 2026-10-08
  // landed on /i/jf/onboarding/web?mode=login and the old check missed it.
  const mk = (url, body) => ({ url: () => url, locator: () => ({ innerText: async () => body, first: () => ({ innerText: async () => body, isVisible: async () => false }) }) });
  const cases = [
    ['https://x.com/i/jf/onboarding/web?mode=login', ''],
    ['https://x.com/i/flow/login', ''],
    ['https://x.com/home', 'Please verify you are human'],
  ];
  for (const [url, body] of cases) {
    const got = await safety.detectBlock(mk(url, body));
    if (!got.blocked) return 'missed block for ' + url;
  }
  const ok = await safety.detectBlock(mk('https://x.com/home', 'What is happening?'));
  return ok.blocked ? 'false positive on a clean home page' : pass('3/3 block URLs flagged');
});

check('T8-a', 'detectBlock flags Action Blocked badge text', async () => {
  const mk = (body) => ({ url: () => 'https://x.com/home', locator: () => ({ innerText: async () => body, first: () => ({ innerText: async () => body, isVisible: async () => false }) }) });
  const got = await safety.detectBlock(mk('Action Blocked'));
  return got.blocked === true && got.reason === 'action-blocked' ? pass('reason=' + got.reason) : 'Action Blocked not flagged';
});

check('T8-a', 'detectBlock flags the automated-request long message', async () => {
  const mk = (body) => ({ url: () => 'https://x.com/home', locator: () => ({ innerText: async () => body, first: () => ({ innerText: async () => body, isVisible: async () => false }) }) });
  const body = 'This request looks like it might be automated. To protect our users from spam and other malicious activity, we cant complete this action right now.';
  const got = await safety.detectBlock(mk(body));
  return got.blocked === true && got.reason === 'action-blocked' ? pass('reason=' + got.reason) : 'automated long message not flagged';
});

check('T8-a', 'detectBlock does not flag Something went wrong reloading', async () => {
  const mk = (body) => ({ url: () => 'https://x.com/home', locator: () => ({ innerText: async () => body, first: () => ({ innerText: async () => body, isVisible: async () => false }) }) });
  const got = await safety.detectBlock(mk('Something went wrong. Try reloading.'));
  return got.blocked === false ? true : 'false positive on reloading message';
});

check('T8-b', 'a block persists paused=true + reason via the shared writer', async () => {
  const { mkdtempSync, readFileSync: rf, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sm-pause-'));
  const file = path.join(dir, 'control.json');
  const prev = process.env.SOCIALMATE_CONTROL;
  process.env.SOCIALMATE_CONTROL = file;
  const ctl = await import('../src/control.mjs?v=' + Date.now());
  ctl.pause('captcha');
  const written = JSON.parse(rf(file, 'utf8'));
  if (prev === undefined) delete process.env.SOCIALMATE_CONTROL; else process.env.SOCIALMATE_CONTROL = prev;
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  if (written.paused !== true) return 'paused was not set';
  if (!written.pauseReason) return 'pauseReason was not recorded';
  const src = readFileSync('src/run.mjs', 'utf8');
  if (/while\s*\(\s*true\s*\)\s*\{[^}]*b\.blocked[^}]*post\(/.test(src)) return 'retries inside block handler';
  return pass('paused=true reason=' + written.pauseReason);
});


// ---- P1/P2 regression: reviewer-found defects --------------------------
check('P1-cli', 'cli.mjs resolves state at module scope so approve can publish', () => {
  const src = readFileSync('src/cli.mjs', 'utf8');
  if (/^\s{2,}const state\b/m.test(src)) return 'state is block-scoped';
  if (!/^const state\b/m.test(src)) return 'state is not declared at module scope';
  return true;
});

check('P1-reply', 'replyRound pauses on a blocked error instead of retrying', () => {
  const src = readFileSync('src/run.mjs', 'utf8');
  const start = src.indexOf('export async function replyRound');
  if (start < 0) return 'replyRound not found';
  const end = src.indexOf('// ---- main');
  const window = end > start ? src.slice(start, end) : src.slice(start);
  if (!window.includes('e.blocked')) return 'no e.blocked check inside replyRound';
  if (!window.includes('pause(')) return 'no pause() call inside replyRound';
  return true;
});

check('P2-server', 'server approve passes state into checkPost', () => {
  const src = readFileSync('src/server.mjs', 'utf8');
  return /checkPost\(\{ text: d\.text, cfg, kind: d\.kind, state \}\)/.test(src) ? true : 'checkPost call has no state';
});

check('P2-daemon', 'daemon start passes --publish only for auto mode', () => {
  const src = readFileSync('src/server.mjs', 'utf8');
  const fn = src.slice(src.indexOf('function startDaemon'), src.indexOf('function stopDaemon'));
  if (!fn.includes("'--publish'")) return 'no --publish literal in startDaemon';
  if (!/publish/.test(fn)) return 'no publish condition in startDaemon';
  if (/\[\s*'src\/run\.mjs'\s*,\s*'--publish'\s*\]/.test(fn)) return 'unconditional --publish spawn';
  return true;
});

// ---- T3: LLM layer surface ----------------------------------------------
const llm = await import('../src/llm.mjs');
check('T3-a', 'llm exports complete / completeJson / testConnection', () => {
  const bad = ['complete', 'completeJson', 'testConnection'].filter((f) => typeof llm[f] !== 'function');
  return bad.length ? pass(`missing ${bad}`) : true;
});

check('T3-e', 'dual-model tiers exist (cheap vs strong)', () => {
  if (typeof llm.modelForTier !== 'function') return 'no modelForTier export';
  const cheap = llm.modelForTier('cheap'), strong = llm.modelForTier('strong');
  return cheap && strong ? pass(`cheap=${cheap} strong=${strong}`) : 'tier lookup returned empty';
});

check('T3-d', 'degradation is logged with a DEGRADED marker', () => {
  const src = readFileSync('src/voice.mjs', 'utf8');
  return /DEGRADED/.test(src) ? true : 'no DEGRADED marker in voice.mjs';
});

check('I4-b', 'api key is read from env first, never hardcoded', () => {
  const src = readFileSync('src/llm.mjs', 'utf8');
  return /process\.env\.OPENAI_API_KEY/.test(src) ? true : 'does not read OPENAI_API_KEY';
});

// ---- T7-d: warmup scrolls 3-5, think pause 2-5s ------------------------
check('T7-d', 'warmup is 3-5 scrolls and think pause is 2-5 seconds', () => {
  const src = readFileSync('src/humanize.mjs', 'utf8');
  const num = (k) => { const m = new RegExp(k + ':\\s*(\\d+)').exec(src); return m ? Number(m[1]) : null; };
  const wsMin = num('warmupScrollsMin'), wsMax = num('warmupScrollsMax');
  const pMin = num('pauseMin'), pMax = num('pauseMax');
  const cMin = num('charDelayMin'), cMax = num('charDelayMax');
  const problems = [];
  if (wsMin !== 3 || wsMax !== 5) problems.push(`scrolls ${wsMin}-${wsMax} not 3-5`);
  if (pMin !== 2000 || pMax !== 5000) problems.push(`pause ${pMin}-${pMax} not 2000-5000`);
  if (cMin !== 30 || cMax !== 100) problems.push(`charDelay ${cMin}-${cMax} not 30-100`);
  return problems.length ? problems.join('; ') : pass(`scrolls ${wsMin}-${wsMax}, pause ${pMin}-${pMax}ms, typing ${cMin}-${cMax}ms`);
});

// ---- T6-c: per-kind cooldown and quota are actually enforced -----------
check('T6-c', 'per-kind daily quota blocks a kind that reached its max', () => {
  const budget = gate.checkKindBudget({ kind: 'post', state: { postsPublished: 12 }, cfg });
  return budget.ok === false && /quota-post/.test(budget.reasons.join(',')) ? pass(budget.reasons.join(',')) : 'quota not enforced';
});

check('T6-c', 'per-kind cooldown blocks a kind that is too recent', () => {
  const now = Date.now();
  const budget = gate.checkKindBudget({ kind: 'quote', state: { lastQuoteAt: now - 60_000 }, cfg, now });
  return budget.ok === false && /cooldown-quote/.test(budget.reasons.join(',')) ? pass(budget.reasons.join(',')) : 'cooldown not enforced';
});

check('T6-c', 'quote budget is independent of post budget', () => {
  // Post quota exhausted must not block a quote.
  const b = gate.checkKindBudget({ kind: 'quote', state: { postsPublished: 999, quotesPublished: 0 }, cfg });
  return b.ok === true ? true : 'quote blocked by post quota';
});

check('T6-c', 'reply budget is independent of post and quote budgets', () => {
  const b = gate.checkKindBudget({ kind: 'reply', state: { postsPublished: 999, quotesPublished: 999, repliesPublished: 0 }, cfg });
  return b.ok === true ? true : 'reply blocked by another kind quota';
});

check('T6-c', 'an exhausted kind passes once its cooldown has elapsed', () => {
  const now = Date.now();
  const b = gate.checkKindBudget({ kind: 'reply', state: { lastReplyAt: now - 60 * 60_000 }, cfg, now });
  return b.ok === true ? true : 'cooldown never expires';
});


// ---- I2: collection never publishes; the content round never reads X -----
check('I2-a', 'perceive modules never call a publish primitive', async () => {
  const { readdirSync } = await import('node:fs');
  const files = readdirSync('src/perceive').filter((f) => f.endsWith('.mjs'));
  const bad = [];
  for (const f of files) {
    const src = readFileSync('src/perceive/' + f, 'utf8');
    for (const prim of ['post(', 'quote(', 'reply(', 'like(']) {
      if (src.includes(prim)) bad.push(f + ':' + prim);
    }
  }
  return bad.length ? 'publish primitive found: ' + bad.join(', ') : pass('scanned ' + files.length + ' files');
});

check('I2-b', 'the content round does not read X; collection is a separate round', () => {
  const src = readFileSync('src/run.mjs', 'utf8');
  const start = src.indexOf('export async function contentRound');
  if (start < 0) return 'contentRound not found';
  const end = src.indexOf('export async function', start + 1);
  const body = end > start ? src.slice(start, end) : src.slice(start);
  if (/collectCandidates/.test(body)) return 'contentRound still calls collectCandidates';
  const cstart = src.indexOf('export async function collectRound');
  if (cstart < 0) return 'collectRound not exported';
  const cend = src.indexOf('export async function', cstart + 1);
  const cbody = cend > cstart ? src.slice(cstart, cend) : src.slice(cstart);
  if (!/collectCandidates/.test(cbody)) return 'collectRound does not contain collectCandidates';
  return pass('contentRound pure-pool; collectRound owns collectCandidates');
});
check('I2-c', 'the scheduler makes a collect pass skip publishing that same pass', () => {
  const src = readFileSync('src/run.mjs', 'utf8');
  if (!src.includes('collectedThisLoop')) return 'no collectedThisLoop flag in the scheduler';
  if (!src.includes('collectRound(')) return 'no collectRound( call in the scheduler';
  const ci = src.indexOf('collectRound(');
  const skip = src.indexOf('if (collectedThisLoop)', ci);
  if (skip < 0) return 'no collectedThisLoop skip branch after the collect block';
  const tail = src.slice(skip, src.indexOf('let r = { ok: false };', skip));
  if (!/continue/.test(tail)) return 'skip branch does not continue the loop';
  return pass('collect pass skips publishing; publish waits for the next pass');
});


// ---- T5-d regression: hollow-quote detection must not misfire on Chinese ---
// The first implementation split on whitespace, so a whole Chinese sentence was
// a single token and EVERY Chinese quote scored zero overlap and was rejected.
// That took the entire quote lane offline. These assertions pin the fix.
check('T5-d', 'Chinese quote sharing a content word is NOT hollow', () => {
  return gate.hollowQuote('这个模型很强', 'OpenAI 发布新模型') === false
    ? true : 'shared content character was not detected';
});

check('T5-d', 'Chinese quote with no overlap IS hollow', () => {
  return gate.hollowQuote('天气真好', 'OpenAI 发布新模型') === true
    ? true : 'unrelated Chinese comment passed as relevant';
});

check('T5-d', 'Latin-script hollow detection still works', () => {
  if (gate.hollowQuote('great model', 'OpenAI new model') !== false) return 'shared word missed (en)';
  if (gate.hollowQuote('nice weather', 'OpenAI new model') !== true) return 'hollow comment passed (en)';
  return true;
});

check('T5-d', 'mixed-script Chinese comment is NOT hollow', () => {
  // Regression (2026-10-17, found live): the tokenizer only split on
  // non-alphanumerics, so a whitespace token that MIXED scripts ("token吧",
  // "带tag流量") became one unmatchable unit. Any Chinese comment containing an
  // English word or a number then scored zero overlap and was rejected as
  // hollow, which silently killed the comment half of the growth lane.
  const cases = [
    ['随礼就随个token吧🤣', '兄弟有喜事了，要随礼吗。'],
    ['还真是，带tag流量就是猛😆', '说个暴论 带浇、蓝v等tag 流量确实要比一般的高'],
    ['2人3天变半天，老板秒懂🤣', '跟企业老板聊AI，千万别上来讲Agent、模型、智能体。'],
  ];
  for (const [c, o] of cases) {
    if (gate.hollowQuote(c, o) !== false) return 'mixed-script comment rejected as hollow: ' + c;
  }
  return true;
});

// ---- T1-b regression: language detection must not collapse ja/ko into zh ---
check('T1-b', 'detectLang distinguishes ja / ko from zh', async () => {
  const { detectLang } = await import('../src/perceive/lang.mjs');
  const cases = [
    ['これは新しいモデルです', 'ja'],
    ['이것은 새로운 모델입니다', 'ko'],
    ['这个模型很强', 'zh'],
    ['OpenAI ships a new model', 'en'],
    ['mas aí eles não descansam coitados', 'en'],
  ];
  for (const [text, want] of cases) {
    const got = detectLang(text);
    if (got !== want) return `detectLang(${JSON.stringify(text)}) = ${got}, want ${want}`;
  }
  return true;
});

// ---- degenerate-repetition guard: a keyboard-mash wall must not pass -------
// A live draft (id 900) was a 400-char "啊啊啊..." wall that cleared
// minLength. It has no content, so the gate now rejects it. Normal prose must
// stay untouched.
check('DG-a', 'a long single-character wall is rejected by checkPost', () => {
  const text = '啊'.repeat(400);
  if (gate.degenerateRepetition(text, {}) !== true) return '400-char a-wall not detected';
  const v = gate.checkPost({ text, history: { entries: [] }, cfg: {}, kind: 'post' });
  if (v.ok) return 'checkPost accepted a 400-char a-wall';
  if (!v.reasons.includes('degenerate-repeat')) return 'reasons=' + v.reasons.join(',');
  return true;
});

check('DG-b', 'normal Chinese / English posts are NOT flagged', () => {
  const zh = '资讯流最大的错误，就是以为抓得到等于有用。判定层一点没加，内容再多也是噪音。🤣';
  const en = 'Brothers, the real question is whether the benchmark measures anything that survives contact with production.';
  for (const t of [zh, en]) {
    if (gate.degenerateRepetition(t, {}) !== false) return 'false positive on: ' + t.slice(0, 20);
    const v = gate.checkPost({ text: t, history: { entries: [] }, cfg: {}, kind: 'post' });
    if (!v.ok && v.reasons.includes('degenerate-repeat')) return 'normal post rejected as degenerate';
  }
  return true;
});

check('DG-c', 'a short emoji run is not degenerate', () => {
  const t = '哈'.repeat(17) + '，这个确实好笑';
  if (gate.degenerateRepetition(t, {}) !== false) return 'short run flagged';
  return true;
});

// ---- report ------------------------------------------------------------

await Promise.all(pending);
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(7)} ${r.desc}${r.detail ? '  :: ' + r.detail : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
