// B1/B2 acceptance: engage budget isolation + engageRound like selection.
// Pure logic + mock page only — no browser, no publishing.
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import os from 'node:os';
process.chdir(resolve(import.meta.dirname, '..'));

const results = [];
const pass = (detail = '') => ({ __pass: true, detail });
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
const realCfg = JSON.parse(readFileSync('config.json', 'utf8'));

const engageCfg = {
  perceive: { minLikes: 10 },
  gate: { perKind: { engageDailyMax: 20, engageCooldownMinutes: 20 } },
};
const emptyState = () => ({ engagesPublished: 0, lastEngageAt: 0 });

// ---- B2: per-kind budget isolation ---------------------------------------
check('B1/B2-1', 'engage within quota passes', () => {
  const r = gate.checkKindBudget({ kind: 'engage', state: emptyState(), cfg: engageCfg });
  return r.ok === true ? pass(`kind=${r.kind}`) : 'engage did not pass within quota';
});

check('B1/B2-2', 'engage over daily quota fails', () => {
  const r = gate.checkKindBudget({ kind: 'engage', state: { engagesPublished: 20, lastEngageAt: 0 }, cfg: engageCfg });
  return r.ok === false && /quota-engage/.test(r.reasons.join(',')) ? pass(r.reasons.join(',')) : 'engage quota not enforced';
});

check('B1/B2-3', 'post quota exhausted does NOT block engage', () => {
  const state = { postsPublished: 999, engagesPublished: 0, lastPostAt: Date.now(), lastEngageAt: 0 };
  const r = gate.checkKindBudget({ kind: 'engage', state, cfg: engageCfg, now: Date.now() });
  return r.ok === true ? pass('engage still ok') : 'engage blocked by post quota';
});

check('B1/B2-4', 'engage cooldown is independent of post/quote/reply', () => {
  const cfgFull = {
    gate: { perKind: {
      engageDailyMax: 20, engageCooldownMinutes: 20,
      postDailyMax: 8, postCooldownMinutes: 45,
      quoteDailyMax: 7, quoteCooldownMinutes: 30,
      replyDailyMax: 10, replyCooldownMinutes: 15,
    } },
  };
  const state = { engagesPublished: 0, lastEngageAt: 0, postsPublished: 1, lastPostAt: Date.now() - 1000 };
  const now = Date.now();
  const r = gate.checkKindBudget({ kind: 'engage', state, cfg: cfgFull, now });
  const postR = gate.checkKindBudget({ kind: 'post', state, cfg: cfgFull, now });
  if (r.ok !== true) return 'engage blocked although only post was just published';
  if (!/cooldown-post/.test(postR.reasons.join(','))) return 'post cooldown not triggered in the same state';
  return pass('post just published; engage still ok');
});

check('B1/B2-5', 'engage cooldown blocks when engage was recent', () => {
  const state = { engagesPublished: 1, lastEngageAt: Date.now() - 5 * 60_000 };
  const r = gate.checkKindBudget({ kind: 'engage', state, cfg: engageCfg, now: Date.now() });
  return r.ok === false && /cooldown-engage/.test(r.reasons.join(',')) ? pass(r.reasons.join(',')) : 'engage cooldown not enforced';
});

// ---- B1: engageRound selection via mock page ------------------------------
const mkPool = () => [
  { url: 'https://x.com/a/status/101', likes: 100, lang: 'en', title: 'good en' },
  { url: 'https://x.com/b/status/102', likes: 3, lang: 'en', title: 'low likes' },
  { url: 'https://x.com/c/status/103', likes: 100, lang: 'ja', title: 'bad lang' },
  { url: 'https://x.com/d/status/104', likes: 50, lang: 'zh', title: 'good zh' },
  { url: 'https://aihot.news/items/xxx', likes: 99, lang: 'zh', title: 'not x status' },
];
const expectEligible = mkPool().filter((c) =>
  c.likes >= (engageCfg.perceive.minLikes) &&
  ['en', 'zh'].includes(c.lang) &&
  /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/.test(c.url)
);

const mkMockPage = () => {
  const visited = [];
  return {
    visited,
    // xbot.like() calls guard() first, which runs safety.detectBlock(page)
    // (page.url + body innerText). Provide those stubs so the real like()
    // path is exercised end to end; the like button is always visible so
    // every visited URL is actually liked.
    url: () => 'https://x.com/home',
    async goto(u) { visited.push(u); },
    async waitForTimeout() {},
    async evaluate() { return ''; },
    locator() {
      return {
        first() {
          return {
            async isVisible() { return true; },
            async click() {},
          };
        },
        async innerText() { return ''; },
        async count() { return 1; },
      };
    },
  };
};

check('B1/B2-6', 'engageRound likes only eligible candidates (mock page)', async () => {
  const dir = mkdtempSync(resolve(os.tmpdir(), 'sm-engage-'));
  const seenFile = resolve(dir, 'seen-likes.json');
  const stateFile = resolve(dir, 'state.json');
  const state = emptyState();
  const page = mkMockPage();
  const r = await run.engageRound(page, { seenFile, state, cfg: engageCfg, pool: mkPool(), stateFile, gap: [0, 0] });
  const seen = JSON.parse(readFileSync(seenFile, 'utf8') || '{"urls":[]}');
  const persisted = seen.urls || [];
  const want = expectEligible.slice(0, 3).map((c) => c.url);
  if (r.liked !== want.length) return `liked ${r.liked} but expected ${want.length}`;
  const visitedSort = [...(page.visited)].sort();
  const wantSort = [...want].sort();
  if (visitedSort.join() !== wantSort.join()) return 'like() visited ' + visitedSort.join(',') + ' but expected ' + wantSort.join(',');
  const missing = want.filter((u) => !persisted.includes(u));
  if (missing.length) return 'seen-likes missing ' + missing.join(',');
  const extra = persisted.filter((u) => !want.includes(u));
  if (extra.length) return 'seen-likes includes unliked ' + extra.join(',');
  rmSync(dir, { recursive: true, force: true });
  return pass('liked ' + r.liked + ' persisted=' + persisted.join('|'));
});

check('B1/B2-7', 'seen-likes dedupe: a URL is not liked twice', async () => {
  const dir = mkdtempSync(resolve(os.tmpdir(), 'sm-engage-'));
  const seenFile = resolve(dir, 'seen-likes.json');
  const stateFile = resolve(dir, 'state.json');
  const state1 = emptyState();
  const pool = [
    { url: 'https://x.com/a/status/101', likes: 100, lang: 'en', title: 'first' },
    { url: 'https://x.com/b/status/102', likes: 100, lang: 'en', title: 'second' },
  ];
  const page = mkMockPage();
  const r1 = await run.engageRound(page, { seenFile, state: state1, cfg: engageCfg, pool, stateFile, gap: [0, 0] });
  // Fresh state so the engage cooldown cannot mask the dedupe check: the
  // second round must skip both URLs purely because they are in seen-likes.
  const r2 = await run.engageRound(page, { seenFile, state: emptyState(), cfg: engageCfg, pool, stateFile, gap: [0, 0] });
  const seen = JSON.parse(readFileSync(seenFile, 'utf8') || '{"urls":[]}');
  if (r1.liked !== 2) return 'first pass did not like both';
  if (r2.liked !== 0) return 'second pass liked a URL it had already liked';
  if (page.visited.length !== 2) return 'first pass visited ' + page.visited.length + ' URLs, want 2';
  if (seen.urls.length !== 2) return 'seen file has ' + seen.urls.length + ' urls, want 2';
  rmSync(dir, { recursive: true, force: true });
  return pass('dedupe ok: first=2 second=0');
});

check('B1/B2-8', 'engageRound source has no publish primitives (I2-a style)', () => {
  const src = readFileSync('src/run.mjs', 'utf8');
  const start = src.indexOf('export async function engageRound');
  const end = src.indexOf('// ---- main');
  if (start < 0) return 'engageRound not found';
  const body = end > start ? src.slice(start, end) : src.slice(start);
  const bad = [];
  for (const prim of ['post(', 'quote(', 'reply(']) if (body.includes(prim)) bad.push(prim);
  return bad.length ? 'publish primitive found: ' + bad.join(', ') : pass('no publish primitives');
});

check('B1/B2-9', 'config carries engageDailyMax and engageCooldownMinutes', () => {
  const pk = realCfg.gate?.perKind || {};
  if (pk.engageDailyMax !== 20) return 'engageDailyMax != 20';
  if (pk.engageCooldownMinutes !== 20) return 'engageCooldownMinutes != 20';
  return pass('engageDailyMax=' + pk.engageDailyMax + ' engageCooldownMinutes=' + pk.engageCooldownMinutes);
});

// B2 (strong form): a like must never share a pass with a publish. The
// scheduler gates engageRound on collectedThisLoop (the same flag whose I2 skip
// suppresses publishing) and --once gates it on !gate.publish. Asserted
// statically so a refactor cannot silently reintroduce a like+publish pass.
check('B2-10', 'scheduler gates likes on collectedThisLoop (no like+publish pass)', () => {
  const src = readFileSync('src/run.mjs', 'utf8');
  // lastIndexOf, not indexOf: the scheduler call comes after the --once call.
  const call = src.lastIndexOf('await engageRound(page).catch');
  if (call === -1) return 'no engageRound call in run.mjs';
  const before = src.slice(Math.max(0, call - 400), call);
  return /if \(collectedThisLoop\) \{/.test(before)
    ? pass('engage runs only on a collect pass')
    : 'engageRound is not gated on collectedThisLoop';
});

check('B2-11', '--once skips likes when the invocation may publish', () => {
  const src = readFileSync('src/run.mjs', 'utf8');
  const a = src.indexOf("includes('--once')");
  const b = src.indexOf('let lastReplyScan');
  const block = a >= 0 && b > a ? src.slice(a, b) : '';
  if (!block) return '--once block not found';
  return /if \(!gate\.publish\) \{[\s\S]*engageRound/.test(block)
    ? pass('likes only on non-publishing invocations')
    : '--once likes regardless of publish capability';
});

await Promise.all(pending);
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(9)} ${r.desc}${r.detail ? '  :: ' + r.detail : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
