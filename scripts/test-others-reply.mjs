// A5 acceptance: othersReply lane (R1-R8 offline checks).
// Pure logic + mock page only - no browser, no real config/queue writes.
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
const replies = await import('../src/replies.mjs');
const realCfg = JSON.parse(readFileSync('config.json', 'utf8'));

const today = new Date().toISOString().slice(0, 10);
const baseCfg = {
  autoMode: 'review',
  features: {},
  perceive: { minLikes: 10 },
  gate: { perKind: { othersReplyDailyMax: 6, othersReplyCooldownMinutes: 30, postDailyMax: 8, postCooldownMinutes: 45 } },
};
const emptyState = () => ({ postsPublished: 0, lastPostAt: 0, othersRepliesPublished: 0, lastOthersReplyAt: 0, othersRepliedAuthorsByDay: {} });

const cand = (id, author, opts = {}) => ({
  url: 'https://x.com/' + author + '/status/' + id,
  tweetId: String(id),
  author,
  likes: opts.likes ?? 100,
  lang: opts.lang ?? 'en',
  source: opts.source ?? 'x-home',
  text: opts.text ?? 'Great thread about AI models today',
});

const mkPage = () => ({ replyCalls: 0, async reply() { this.replyCalls++; } });

// ---- R1 source whitelist / normalization --------------------------------
check('R1-1', 'only x-home/x-following survive; search/trends/aihot rejected', () => {
  const pool = [
    cand(1, 'alice', { source: 'x-home' }),
    cand(2, 'bob', { source: 'x-following' }),
    cand(3, 'carol', { source: 'search' }),
    cand(4, 'dave', { source: 'trends' }),
    cand(5, 'erin', { source: 'aihot' }),
    { url: 'https://aihot.news/items/1', author: 'ai', likes: 99, lang: 'zh', source: 'aihot', text: 'x' },
  ];
  const out = replies.selectOthersReplyCandidates(pool, {});
  const got = out.map((c) => c.tweetId).join(',');
  return got === '1,2' ? pass('kept ' + got) : 'kept ' + got + ' but expected 1,2';
});

check('R1-2', 'replies.mjs imports no perceive/search or perceive/trends', () => {
  const src = readFileSync('src/replies.mjs', 'utf8');
  return /from\s*['"]\.\.?\/?perceive\/(?:search|trends)/.test(src)
    ? 'perceive/search|trends imported'
    : pass('no perceive search/trends import');
});

check('R1-3', 'likes<10 filtered, lang=ja filtered, own author excluded', () => {
  const pool = [
    cand(1, 'alice', { likes: 9 }),
    cand(2, 'bob', { lang: 'ja' }),
    cand(3, 'Me', { source: 'x-home' }),
    cand(4, 'dave', { likes: 50, lang: 'zh' }),
  ];
  const out = replies.selectOthersReplyCandidates(pool, { minLikes: 10, myHandle: 'me' });
  const got = out.map((c) => c.tweetId).join(',');
  return got === '4' ? pass('kept ' + got) : 'kept ' + got + ' but expected 4';
});

// ---- R2 full text -------------------------------------------------------
check('R2-1', 'no slice(0,80) truncation in replies.mjs code', () => {
  const src = readFileSync('src/replies.mjs', 'utf8')
    .split(/\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
  return /slice\(\s*0\s*,\s*80\s*\)/.test(src) ? 'slice(0,80) found in code' : pass('no 80-char truncation');
});

check('R2-2', 'full text+author+likes reach the generation layer', async () => {
  const longText = 'x'.repeat(150) + ' plus a unique tail';
  const item = { ...cand(9, 'grace'), text: longText };
  let seen = null;
  const draftFn = async (it) => { seen = it; return 'I agree with the AI models point'; };
  const dir = mkdtempSync(resolve(os.tmpdir(), 'sm-others-'));
  const seenFile = resolve(dir, 'seen.json');
  const stateFile = resolve(dir, 'state.json');
  const draftsFile = resolve(dir, 'drafts.json');
  const page = mkPage();
  await run.othersReplyRound(page, { seenFile, state: emptyState(), cfg: baseCfg, pool: [item], draftsFile, stateFile, gap: [0, 0], draftFn });
  rmSync(dir, { recursive: true, force: true });
  if (!seen) return 'generation layer never called';
  if (seen.text !== longText) return 'text truncated: len=' + seen.text.length;
  if (!seen.author || seen.likes == null) return 'author/likes not passed together';
  return pass('text len=' + seen.text.length + ' author=' + seen.author + ' likes=' + seen.likes);
});

check('R2-3', 'extractText cap stays >= 200', () => {
  const src = readFileSync('src/replies.mjs', 'utf8');
  const m = src.match(/slice\(\s*0\s*,\s*(\d+)\s*\)/);
  const cap = m ? Number(m[1]) : 0;
  return cap >= 200 ? pass('cap=' + cap) : 'cap=' + cap + ' < 200';
});

// ---- R3 independent quota / cooldown ------------------------------------
check('R3-3', 'post quota exhausted -> othersReply still ok', () => {
  const state = { postsPublished: 999, lastPostAt: 0, othersRepliesPublished: 0, lastOthersReplyAt: 0 };
  const r = gate.checkKindBudget({ kind: 'othersReply', state, cfg: baseCfg, now: Date.now() });
  return r.ok === true ? pass('othersReply still ok') : 'blocked by post quota: ' + r.reasons.join(',');
});

check('R3-4', 'lastPostAt recent -> othersReply not blocked by post cooldown', () => {
  const state = { postsPublished: 1, lastPostAt: Date.now() - 1000, othersRepliesPublished: 0, lastOthersReplyAt: 0 };
  const r = gate.checkKindBudget({ kind: 'othersReply', state, cfg: baseCfg, now: Date.now() });
  if (r.ok !== true) return 'blocked after a fresh post: ' + r.reasons.join(',');
  const postR = gate.checkKindBudget({ kind: 'post', state, cfg: baseCfg, now: Date.now() });
  if (!/cooldown-post/.test(postR.reasons.join(','))) return 'post cooldown not triggered in same state';
  return pass('post just published; othersReply still ok');
});

check('R3-5', 'reads state.othersRepliesPublished (not the misspelled plural)', () => {
  const cfgQ = { gate: { perKind: { othersReplyDailyMax: 6, othersReplyCooldownMinutes: 30 } } };
  const atQuota = { othersRepliesPublished: 6, lastOthersReplyAt: 0 };
  const r1 = gate.checkKindBudget({ kind: 'othersReply', state: atQuota, cfg: cfgQ, now: Date.now() });
  const wrongKey = { othersReplysPublished: 999, lastOthersReplyAt: 0 };
  const r2 = gate.checkKindBudget({ kind: 'othersReply', state: wrongKey, cfg: cfgQ, now: Date.now() });
  if (r1.ok !== false || !/quota-othersReply/.test(r1.reasons.join(','))) return 'quota not enforced on correct key: ' + r1.reasons.join(',');
  if (r2.ok !== true) return 'misspelled plural wrongly read as usage';
  return pass('used=' + r1.used + '/max=' + r1.limit + '; wrong-key state untouched');
});

check('R3-6', 'othersReply cooldown is own (lastOthersReplyAt)', () => {
  const cfgQ = { gate: { perKind: { othersReplyDailyMax: 6, othersReplyCooldownMinutes: 30 } } };
  const state = { othersRepliesPublished: 0, lastOthersReplyAt: Date.now() - 1000 };
  const r = gate.checkKindBudget({ kind: 'othersReply', state, cfg: cfgQ, now: Date.now() });
  return r.ok === false && /cooldown-othersReply/.test(r.reasons.join(','))
    ? pass(r.reasons.join(','))
    : 'own cooldown not enforced';
});

// ---- R4 same-author limits ----------------------------------------------
check('R4-1', 'same author at most once per round', async () => {
  const dir = mkdtempSync(resolve(os.tmpdir(), 'sm-others2-'));
  const seenFile = resolve(dir, 'seen.json');
  const stateFile = resolve(dir, 'state.json');
  const draftsFile = resolve(dir, 'drafts.json');
  const page = mkPage();
  const pool = [cand(11, 'alice'), cand(12, 'alice'), cand(13, 'bob')];
  const r = await run.othersReplyRound(page, { seenFile, state: emptyState(), cfg: baseCfg, pool, draftsFile, stateFile, gap: [0, 0], draftFn: async () => 'I agree with the AI models point' });
  const drafts = JSON.parse(readFileSync(draftsFile, 'utf8'));
  const authors = [...new Set(drafts.map((d) => d.author))].sort().join(',');
  rmSync(dir, { recursive: true, force: true });
  if (r.acted !== 2) return 'acted ' + r.acted + ' but expected 2 (alice once + bob once)';
  return authors === 'alice,bob' ? pass('acted=2 authors=' + authors) : 'authors=' + authors;
});

check('R4-2', 'same author second same-day rejected', async () => {
  const dir = mkdtempSync(resolve(os.tmpdir(), 'sm-others3-'));
  const seenFile = resolve(dir, 'seen.json');
  const stateFile = resolve(dir, 'state.json');
  const draftsFile = resolve(dir, 'drafts.json');
  const page = mkPage();
  const state = emptyState();
  const draftFn = async () => 'I agree with the AI models point';
  const r1 = await run.othersReplyRound(page, { seenFile, state, cfg: baseCfg, pool: [cand(21, 'bob')], draftsFile, stateFile, gap: [0, 0], draftFn });
  const r2 = await run.othersReplyRound(page, { seenFile, state, cfg: baseCfg, pool: [cand(22, 'bob')], draftsFile, stateFile, gap: [0, 0], draftFn });
  const dayList = state.othersRepliedAuthorsByDay && state.othersRepliedAuthorsByDay[today];
  rmSync(dir, { recursive: true, force: true });
  if (r1.acted !== 1) return 'first round acted ' + r1.acted + ' but expected 1';
  if (r2.acted !== 0) return 'second round acted ' + r2.acted + ' but the same-author daily cap should block';
  if (!dayList || !dayList.includes('bob')) return 'state.othersRepliedAuthorsByDay missing bob';
  return pass('round1=1 round2=0; bob recorded in state');
});

check('R4-3', 'tweetId seen once (others-reply-seen.json style dedupe)', async () => {
  const dir = mkdtempSync(resolve(os.tmpdir(), 'sm-others4-'));
  const seenFile = resolve(dir, 'seen.json');
  const stateFile = resolve(dir, 'state.json');
  const draftsFile = resolve(dir, 'drafts.json');
  const page = mkPage();
  const pool = [cand(31, 'carol')];
  const r1 = await run.othersReplyRound(page, { seenFile, state: emptyState(), cfg: baseCfg, pool, draftsFile, stateFile, gap: [0, 0], draftFn: async () => 'I agree with the AI models point' });
  const r2 = await run.othersReplyRound(page, { seenFile, state: emptyState(), cfg: baseCfg, pool, draftsFile, stateFile, gap: [0, 0], draftFn: async () => 'I agree with the AI models point' });
  rmSync(dir, { recursive: true, force: true });
  if (r1.acted !== 1) return 'first pass acted ' + r1.acted;
  if (r2.acted !== 0) return 'second pass re-drafted a seen tweetId';
  return pass('first=1 second=0');
});

// ---- R5 gates on the draft ----------------------------------------------
check('R5-2', 'finance text rejected via screenContent in the round', async () => {
  const dir = mkdtempSync(resolve(os.tmpdir(), 'sm-others5-'));
  const seenFile = resolve(dir, 'seen.json');
  const stateFile = resolve(dir, 'state.json');
  const draftsFile = resolve(dir, 'drafts.json');
  const page = mkPage();
  const cfgFin = { ...baseCfg, safety: { allowFinance: false, allowPolitics: false } };
  const r = await run.othersReplyRound(page, { seenFile, state: emptyState(), cfg: cfgFin, pool: [cand(41, 'dave')], draftsFile, stateFile, gap: [0, 0], draftFn: async () => '建议关注这只股票的买入信号' });
  rmSync(dir, { recursive: true, force: true });
  return r.acted === 0 ? pass('finance draft blocked') : 'finance draft slipped through';
});

check('R5-3', 'hollow quote (zero overlap) rejected', async () => {
  const dir = mkdtempSync(resolve(os.tmpdir(), 'sm-others6-'));
  const seenFile = resolve(dir, 'seen.json');
  const stateFile = resolve(dir, 'state.json');
  const draftsFile = resolve(dir, 'drafts.json');
  const page = mkPage();
  const r = await run.othersReplyRound(page, { seenFile, state: emptyState(), cfg: baseCfg, pool: [cand(51, 'erin')], draftsFile, stateFile, gap: [0, 0], draftFn: async () => '明天天气不错哦' });
  rmSync(dir, { recursive: true, force: true });
  return r.acted === 0 ? pass('zero-overlap draft rejected') : 'hollow draft slipped through';
});

// ---- R6 review + explicit publish gate ----------------------------------
check('R6-1', 'round resolves the shared gate (exported, review default)', () => {
  return typeof run.othersReplyRound === 'function' && typeof run.resolveGate === 'function'
    ? pass('othersReplyRound + resolveGate exported')
    : 'exported symbols missing';
});

check('R6-2', 'review mode -> addDraft called, reply() not called', async () => {
  const dir = mkdtempSync(resolve(os.tmpdir(), 'sm-others7-'));
  const seenFile = resolve(dir, 'seen.json');
  const stateFile = resolve(dir, 'state.json');
  const draftsFile = resolve(dir, 'drafts.json');
  const page = mkPage();
  const r = await run.othersReplyRound(page, { seenFile, state: emptyState(), cfg: baseCfg, pool: [cand(61, 'frank')], draftsFile, stateFile, gap: [0, 0], draftFn: async () => 'I agree with the AI models point' });
  const drafts = JSON.parse(readFileSync(draftsFile, 'utf8'));
  rmSync(dir, { recursive: true, force: true });
  if (drafts.length !== 1 || drafts[0].kind !== 'othersReply') return 'draft not queued with kind=othersReply';
  if (page.replyCalls !== 0) return 'reply() called in review mode';
  return pass('draft #' + drafts[0].id + ' queued, replyCalls=0');
});

check('R6-3', 'resolveGate: no flag -> publish=false, with flag -> true', () => {
  const r1 = run.resolveGate({ cfgMode: 'auto', publishFlag: false });
  const r2 = run.resolveGate({ cfgMode: 'auto', publishFlag: true });
  return r1.publish === false && r2.publish === true ? pass('no-flag=false with-flag=true') : 'r1=' + r1.publish + ' r2=' + r2.publish;
});

check('R6-4', 'scheduler gates othersReply on collectedThisLoop; --once on !publish', () => {
  const src = readFileSync('src/run.mjs', 'utf8');
  const calls = [...src.matchAll(/await othersReplyRound\(page\)\.catch/g)].map((m) => m.index);
  if (calls.length !== 2) return 'expected 2 scheduler calls (once + loop), got ' + calls.length;
  const [onceIdx, loopIdx] = calls;
  const gateOpen = src.indexOf('if (!gate.publish) {');
  const gateEnd = src.indexOf("appendLog('engage/browse (once) skipped");
  if (gateOpen < 0 || gateEnd <= gateOpen || onceIdx <= gateOpen || onceIdx >= gateEnd) return '--once othersReply not inside !gate.publish branch';
  const loopOpen = src.indexOf('if (collectedThisLoop) {', gateEnd);
  if (loopOpen < 0 || loopIdx <= loopOpen) return 'loop othersReply not inside collectedThisLoop branch';
  return pass('--once inside !publish branch; loop inside collectedThisLoop branch');
});

check('R8-1', 'config carries browseDailyMax and browseCooldownMinutes (positive ints)', () => {
  const pk = realCfg.gate?.perKind || {};
  const d = Number(pk.browseDailyMax), c = Number(pk.browseCooldownMinutes);
  return Number.isInteger(d) && d > 0 && Number.isInteger(c) && c > 0
    ? pass('daily=' + d + ' cool=' + c)
    : 'daily=' + d + ' cool=' + c;
});

check('R8-2', 'checkKindBudget browse has positive limit and ok=true', () => {
  const r = gate.checkKindBudget({ kind: 'browse', state: { browsesPublished: 0 }, cfg: realCfg, now: Date.now() });
  return Number.isInteger(r.limit) && r.limit > 0 && r.ok === true
    ? pass('limit=' + r.limit + ' ok=true')
    : 'limit=' + r.limit + ' ok=' + r.ok;
});

check('R8-3', 'browse quota exhausted -> ok=false with quota-browse', () => {
  const r = gate.checkKindBudget({ kind: 'browse', state: { browsesPublished: 9999 }, cfg: realCfg, now: Date.now() });
  return r.ok === false && /quota-browse/.test(r.reasons.join(','))
    ? pass(r.reasons.join(','))
    : 'ok=' + r.ok + ' reasons=' + r.reasons.join(',');
});

await Promise.all(pending);
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(7)} ${r.desc}${r.detail ? '  :: ' + r.detail : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
