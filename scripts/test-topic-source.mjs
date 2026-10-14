// Acceptance for "topic posts must carry a source" (brief-topic-post-source T1-T4).
// Pure-function coverage first (sourceLinkOf / buildPost), then an isolated
// subprocess hit on contentRound so the skip/draft branches are exercised for
// real without touching the live queue.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sourceLinkOf, buildPost, officialLinkOf } from '../src/planner.mjs';

const ROOT = resolve(import.meta.dirname, '..');
process.chdir(ROOT);

const results = [];
const check = (id, desc, ok, detail = '') => { results.push({ id, desc, ok: !!ok, detail: String(detail || '') }); };

// ---- 1. sourceLinkOf field resolution -----------------------------------
check('1a', 'origin wins and is returned for a tweet source',
  sourceLinkOf({ origin: 'https://x.com/a/status/1' }) === 'https://x.com/a/status/1');
check('1b', 'falls back to url when origin is absent',
  sourceLinkOf({ url: 'https://x.com/b/status/2' }) === 'https://x.com/b/status/2');
check('1c', 'skips the aihot.news interstitial and uses the real source',
  sourceLinkOf({ origin: 'https://aihot.news/items/x', url: 'https://x.com/c/status/3' }) === 'https://x.com/c/status/3');
check('1d', 'returns null when nothing usable is present', sourceLinkOf({}) === null);
check('1e', 'officialLinkOf now understands origin (delegates)',
  officialLinkOf({ origin: 'https://x.com/d/status/4' }) === 'https://x.com/d/status/4');

// ---- 2. buildPost carries the source link -------------------------------
const bp = buildPost({ origin: 'https://x.com/a/status/1', title: 'Topic T', text: 'body' }, '\u6b63\u6587');
check('2a', 'buildPost output contains the source link', bp.includes('https://x.com/a/status/1'), bp);
check('2b', 'buildPost still omits a link when the candidate has none',
  !/https?:\/\//.test(buildPost({ title: 'No source', text: 'body' }, '\u6b63\u6587')));

// ---- 3/4. contentRound skip vs draft (isolated subprocess) ---------------
function runCase(candidates, patch = {}) {
  const runUrl = 'file:///' + resolve('src/run.mjs').replace(/\\/g, '/');
  const dir = mkdtempSync(resolve(tmpdir(), 'sm-topic-'));
  try {
    const cfg = JSON.parse(readFileSync('config.json', 'utf8'));
    Object.assign(cfg, { voiceEnabled: false }, patch);
    writeFileSync(resolve(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
    mkdirSync(resolve(dir, 'queue'), { recursive: true });
    writeFileSync(resolve(dir, 'queue', 'candidates.json'), JSON.stringify(candidates, null, 2), 'utf8');
    const script = [
      "const { contentRound } = await import('" + runUrl + "');",
      "const page = { url: () => 'https://x.com/home', async goto() {}, async waitForTimeout() {}, locator: () => ({ first: () => ({ isVisible: async () => false }) }), async evaluate() { return ''; } };",
      "const r = await contentRound(page, {});",
      "const fs = await import('node:fs');",
      "let drafts = []; try { drafts = JSON.parse(fs.readFileSync('queue/drafts.json', 'utf8') || '[]'); } catch {}",
      "const d0 = drafts[0] || null;",
      "console.log(JSON.stringify({ ok: r.ok, reason: r.reason, kind: d0 ? d0.kind : r.kind, text: d0 ? d0.text : (r.text || null), sourceUrl: d0 ? d0.sourceUrl : null, draftCount: drafts.length }));",
    ].join('\n');
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8', timeout: 90000 });
    const last = (out.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    return { code: out.status, parsed: last ? JSON.parse(last) : null, raw: (out.stdout || '') + (out.stderr || '') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


// buildPost reads config at module load, so the flag tests need a fresh module
// graph with topicPostRequiresSource=false.
function buildPostWithFlag(item, flag) {
  const url = 'file:///' + resolve('src/planner.mjs').replace(/\\/g, '/');
  const dir = mkdtempSync(resolve(tmpdir(), 'sm-flag-'));
  try {
    const cfg = JSON.parse(readFileSync('config.json', 'utf8'));
    cfg.topicPostRequiresSource = flag;
    writeFileSync(resolve(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
    const script = "const m = await import('" + url + "'); console.log(JSON.stringify(m.buildPost(" + JSON.stringify(item) + ", 'v')));";
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8', timeout: 60000 });
    const line = (out.stdout || '').trim().split('\n').filter((l) => l.startsWith('"')).pop();
    return line ? JSON.parse(line) : '';
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const FEAT = { post: true, quote: true, muse: false, reply: true, like: true, browse: false, othersReply: true };

// 3: topic title but no usable source -> skip, no draft written.
const noSrc = [{ url: 'https://aihot.news/items/only', origin: null, title: 'Topic without source', text: 'body', author: '@x', likes: 100, lang: 'zh', source: 'aihot', intent: 'content' }];
const r3 = runCase(noSrc, { quoteRatio: 0, museRatio: 0, features: FEAT });
check('3a', 'topic post with no source is skipped (no-source-link)',
  r3.parsed && r3.parsed.ok === false && r3.parsed.reason === 'no-source-link', JSON.stringify(r3.parsed) + ' :: ' + r3.raw.slice(-200));
check('3b', 'skip writes no draft', r3.parsed && r3.parsed.draftCount === 0, JSON.stringify(r3.parsed));

// 4: topic title WITH source -> draft text contains the link + sourceUrl stored.
const withSrc = [{ url: 'https://aihot.news/items/x', origin: 'https://x.com/src/status/77', title: 'Topic with source', text: 'body', author: '@src', likes: 100, lang: 'zh', source: 'aihot', intent: 'content' }];
const r4 = runCase(withSrc, { quoteRatio: 0, museRatio: 0, features: FEAT });
check('4a', 'topic post with a source produces a post draft',
  r4.parsed && r4.parsed.ok === true && r4.parsed.kind === 'post', JSON.stringify(r4.parsed) + ' :: ' + r4.raw.slice(-200));
check('4b', 'draft body carries the source link',
  r4.parsed && typeof r4.parsed.text === 'string' && r4.parsed.text.includes('https://x.com/src/status/77'), r4.parsed && r4.parsed.text);
check('4c', 'draft records sourceUrl for the queue UI',
  r4.parsed && r4.parsed.sourceUrl === 'https://x.com/src/status/77', JSON.stringify(r4.parsed));

// ---- 5. flag really rolls back (P3 fix) ---------------------------------
check('5a', 'topicPostRequiresSource=true (default) -> buildPost uses origin',
  buildPost({ origin: 'https://x.com/e/status/5', title: 'T' }, 'v').includes('https://x.com/e/status/5'));

// 5b: with the rule off, buildPost must fall back to the OLD link behaviour
// (originalUrl only), so an origin-only candidate yields no link — a genuine
// rollback, not a cosmetic flag.
check('5b', 'topicPostRequiresSource=false -> origin ignored in buildPost',
  !/https?:\/\//.test(buildPostWithFlag({ origin: 'https://x.com/e/status/5', title: 'T' }, false)),
  buildPostWithFlag({ origin: 'https://x.com/e/status/5', title: 'T' }, false));
check('5c', 'topicPostRequiresSource=false -> originalUrl still honoured in buildPost',
  buildPostWithFlag({ originalUrl: 'https://x.com/f/status/6', title: 'T' }, false).includes('https://x.com/f/status/6'));

// ---- report -------------------------------------------------------------
let pass = 0, fail = 0;
for (const r of results) {
  console.log((r.ok ? 'PASS' : 'FAIL') + '  [' + r.id + '] ' + r.desc + (r.ok ? '' : '  :: ' + r.detail));
  r.ok ? pass++ : fail++;
}
console.log('\n' + pass + '/' + results.length + ' passed');
process.exit(fail ? 1 : 0);
