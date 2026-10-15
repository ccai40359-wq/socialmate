// Growth-follow lane acceptance: AC-1..AC-8 offline checks.
// Pure logic + mock page only - no browser, no real queue/state writes.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
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

const xbot = await import('../src/xbot.mjs');
const run = await import('../src/run.mjs');
const gate = await import('../src/gate.mjs');
const verified = await import('../src/perceive/verified.mjs');

// ---- AC-1: follow() exists and starts with guard -----------------------
check('AC-1', 'xbot exports follow(page, handleOrUrl) starting with await guard(page)', () => {
  if (typeof xbot.follow !== 'function') return 'follow not exported';
  const src = readFileSync('src/xbot.mjs', 'utf8');
  const m = src.match(/export async function follow\(page, handleOrUrl\) \{([\s\S]*?)\n\}/);
  if (!m) return 'follow signature not found';
  if (!/^\s*await guard\(page\);/.test(m[1])) return 'follow body does not start with await guard(page)';
  return pass('signature + guard ok');
});

// ---- AC-2: follow() already-following / no-button ----------------------
function mkLocatorPage() {
  const followState = { visible: false, clicks: 0, isVisible: async () => followState.visible };
  const unfollowState = { visible: false, clicks: 0, isVisible: async () => unfollowState.visible };
  const generic = { visible: false, clicks: 0, isVisible: async () => false };
  const loc = (st) => ({ first: () => st, isVisible: () => st.isVisible(), click: async () => { st.clicks++; }, getAttribute: async () => null, count: async () => 0, innerText: async () => '', waitFor: async () => {} });
  return {
    followState, unfollowState,
    async goto() {},
    async waitForTimeout() {},
    locator(sel) {
      if (String(sel).endsWith('-follow"]')) return loc(followState);
      if (String(sel).endsWith('-unfollow"]')) return loc(unfollowState);
      return loc(generic);
    },
  };
}
check('AC-2a', 'already following -> {ok:true, already:true}, no click', async () => {
  const page = mkLocatorPage();
  page.unfollowState.visible = true;
  const r = await xbot.follow(page, '@bluev');
  if (!r.ok || r.already !== true) return 'expected ok+already, got ' + JSON.stringify(r);
  if (page.followState.clicks) return 'clicked although already following';
  return pass(JSON.stringify(r));
});
check('AC-2b', 'no button / timeout -> {ok:false, reason:"no-button"} without throw', async () => {
  const page = mkLocatorPage();
  const r = await xbot.follow(page, '@ghost');
  if (r.ok !== false || r.reason !== 'no-button') return 'expected no-button, got ' + JSON.stringify(r);
  return pass(JSON.stringify(r));
});

// ---- AC-3: qualifiesAsGrowthTarget -------------------------------------
check('AC-3', 'qualifiesAsGrowthTarget verified+5000 -> true', () =>
  verified.qualifiesAsGrowthTarget({ verified: true, followers: 5000 }) === true ? pass('true') : 'not true');
check('AC-3', 'qualifiesAsGrowthTarget verified+20000 -> false', () =>
  verified.qualifiesAsGrowthTarget({ verified: true, followers: 20000 }) === false ? pass('false') : 'not false');
check('AC-3', 'qualifiesAsGrowthTarget verified=false -> false', () =>
  verified.qualifiesAsGrowthTarget({ verified: false, followers: 5000 }) === false ? pass('false') : 'not false');
check('AC-3', 'qualifiesAsGrowthTarget followers missing -> false (no throw)', () =>
  verified.qualifiesAsGrowthTarget({ verified: true }) === false ? pass('false') : 'not false');

// ---- AC-4: parseFollowerCount ------------------------------------------
check('AC-4', "parseFollowerCount('45.6K Followers') -> 45600", () =>
  verified.parseFollowerCount('45.6K Followers') === 45600 ? pass('45600') : 'got ' + verified.parseFollowerCount('45.6K Followers'));
check('AC-4', "parseFollowerCount('1,234') -> 1234", () =>
  verified.parseFollowerCount('1,234') === 1234 ? pass('1234') : 'got ' + verified.parseFollowerCount('1,234'));
check('AC-4', "parseFollowerCount('3.2万') -> 32000", () =>
  verified.parseFollowerCount('3.2万') === 32000 ? pass('32000') : 'got ' + verified.parseFollowerCount('3.2万'));

// ---- AC-5: features.follow=false skips the whole round -----------------
check('AC-5', 'features.follow=false -> {skipped:true} and follow() never called', async () => {
  let gotoCalls = 0;
  const page = { async goto() { gotoCalls++; }, async waitForTimeout() {}, async evaluate() { return {}; } };
  const r = await run.growthFollowRound(page, {
    state: {}, cfg: { autoMode: 'review', features: { follow: false, followBack: false } }, pool: [], seenFile: 'queue/follow-seen.json',
  });
  if (!r.skipped) return 'not skipped: ' + JSON.stringify(r);
  if (gotoCalls !== 0) return 'page.goto called ' + gotoCalls + ' times on a disabled lane';
  return pass('skipped, no browser touch');
});

// ---- AC-6: review mode never calls follow(), only drafts ----------------
check('AC-6', 'review (gate.publish=false) -> follow() not called, draft written', async () => {
  const dir = mkdtempSync(resolve(os.tmpdir(), 'sm-follow-'));
  const seenFile = resolve(dir, 'follow-seen.json');
  const stateFile = resolve(dir, 'state.json');
  const draftsFile = resolve(dir, 'drafts.json');
  let followCalls = 0;
  const page = {
    async goto() {},
    async waitForTimeout() {},
    async evaluate() { return { text: '5K Followers', verified: true, latestTweet: 'hello world' }; },
    locator() { return { first: () => ({ isVisible: async () => false, click: async () => { followCalls++; } }) }; },
  };
  const cfg = {
    autoMode: 'review',
    features: { follow: true },
    gate: { perKind: { followDailyMax: 30, followCooldownMinutes: 0 } },
    growthFollow: { maxPerRound: 6, maxFollowers: 10000 },
    myHandle: '',
  };
  const s = { draftsToday: 0, followsPublished: 0, lastFollowAt: 0, othersRepliesPublished: 0, lastOthersReplyAt: 0 };
  const r = await run.growthFollowRound(page, {
    seenFile, state: s, cfg, pool: [{ author: 'bluev', verified: true, followers: 5000 }], draftsFile, stateFile, gap: [0, 0],
  });
  const drafts = JSON.parse(readFileSync(draftsFile, 'utf8'));
  rmSync(dir, { recursive: true, force: true });
  if (followCalls !== 0) return 'follow() called in review mode: ' + followCalls;
  if (!drafts.some((d) => d.kind === 'growthFollow' && d.pendingFollow === true)) return 'no growthFollow draft written';
  if ((r.pending || 0) < 1) return 'pending not counted: ' + JSON.stringify(r);
  return pass('followCalls=0, draft id=' + drafts.find((d) => d.kind === 'growthFollow').id);
});

// ---- AC-7: checkKindBudget follow reads followDailyMax -----------------
check('AC-7', "checkKindBudget({kind:'follow'}) -> kind 'follow' + reads followDailyMax", () => {
  const cfg = { gate: { perKind: { followDailyMax: 30, postDailyMax: 8 } } };
  const r = gate.checkKindBudget({ kind: 'follow', state: { followsPublished: 3 }, cfg });
  if (r.kind !== 'follow') return 'kind=' + r.kind;
  if (r.limit !== 30) return 'limit=' + r.limit + ' (must be followDailyMax 30, not postDailyMax 8)';
  if (r.ok !== true) return 'unexpected not-ok: ' + r.reasons.join(',');
  return pass('kind=follow limit=30 ok');
});
check('AC-7', 'followsPublished at cap -> ok=false with quota-follow', () => {
  const cfg = { gate: { perKind: { followDailyMax: 30, postDailyMax: 8 } } };
  const r = gate.checkKindBudget({ kind: 'follow', state: { followsPublished: 30 }, cfg });
  if (r.ok !== false) return 'still ok';
  if (!r.reasons.some((x) => x.startsWith('quota-follow'))) return 'no quota-follow reason: ' + r.reasons.join(',');
  return pass('quota-follow: ' + r.reasons.join(','));
});

// ---- AC-8: cooldown reads lastFollowAt ---------------------------------
check('AC-8', "follow cooldown reads lastFollowAt -> ok=false with cooldown-follow", () => {
  const cfg = { gate: { perKind: { followDailyMax: 30, followCooldownMinutes: 2 } } };
  const now = Date.now();
  const r = gate.checkKindBudget({ kind: 'follow', state: { followsPublished: 1, lastFollowAt: now - 30_000 }, cfg, now });
  if (r.ok !== false) return 'still ok';
  if (!r.reasons.some((x) => x.startsWith('cooldown-follow'))) return 'no cooldown-follow reason: ' + r.reasons.join(',');
  return pass('cooldown-follow: ' + r.reasons.join(','));
});

// ---- Checklist AC-1..AC-6: comment-section discovery + follow visibility ---
const commenters = await import('../src/perceive/commenters.mjs');

// AC-1: extractCommenters dedupes, drops bad handles, removes selfHandle.
check('AC-C1', 'extractCommenters dedupes by handle + drops invalid handles', () => {
  const rows = [
    { handle: '@Alice', verified: true }, { handle: 'alice', verified: false },
    { handle: 'bob' }, { handle: 'not a handle!' }, { handle: '' }, { handle: 'x'.repeat(16) },
  ];
  const out = commenters.extractCommenters(rows, { selfHandle: 'alice' });
  const names = out.map((r) => r.author).sort().join(',');
  if (names !== 'bob') return 'expected only bob, got ' + names;
  return pass('dedupe+filter+self removal -> ' + names);
});

// AC-4: the thread owner is removed even when they reply to themselves later.
check('AC-C4', 'selfHandle removes the owner wherever it appears in the thread', () => {
  const rows = [
    { handle: 'owner' }, { handle: 'friend' }, { handle: 'owner' }, { handle: 'other' },
  ];
  const out = commenters.extractCommenters(rows, { selfHandle: 'owner', myHandle: 'me' });
  const names = out.map((r) => r.author).sort().join(',');
  if (names !== 'friend,other') return 'expected friend,other got ' + names;
  return pass('owner removed at every position -> ' + names);
});

// AC-1/3: my own handle is removed and a missing canFollow is NOT 'already followed'.
check('AC-C1', 'myHandle removed; missing canFollow stays false (never a gate)', () => {
  const out = commenters.extractCommenters([{ handle: 'me' }, { handle: 'pal' }], { myHandle: 'me' });
  if (out.length !== 1 || out[0].author !== 'pal') return 'wrong set: ' + JSON.stringify(out);
  if (out[0].canFollow !== false) return 'canFollow default should be false, got ' + out[0].canFollow;
  return pass('myHandle removed, canFollow=false default');
});

// AC-1: garbage input never throws.
check('AC-C1', 'extractCommenters never throws on bad input', () => {
  for (const bad of [null, undefined, 42, 'x', [null], [{ handle: {} }]]) {
    const out = commenters.extractCommenters(bad, {});
    if (!Array.isArray(out)) return 'not an array for ' + JSON.stringify(bad);
  }
  return pass('all bad inputs -> []');
});

// AC-2/15: the I/O wrapper degrades to [] and never throws.
check('AC-C2', 'collectCommentersFromPost degrades to [] when the page throws', async () => {
  const page = { async goto() { throw new Error('boom'); }, async evaluate() { throw new Error('boom'); }, async waitForTimeout() {} };
  const out = await commenters.collectCommentersFromPost(page, 'https://x.com/a/status/1', { selfHandle: 'a' });
  if (!Array.isArray(out) || out.length !== 0) return 'expected [] got ' + JSON.stringify(out);
  return pass('page error -> [] (no throw)');
});
check('AC-C2', 'collectCommentersFromPost returns [] for a non-page argument', async () => {
  const out = await commenters.collectCommentersFromPost(null, 'https://x.com/a/status/1', {});
  if (!Array.isArray(out) || out.length !== 0) return 'expected [] got ' + JSON.stringify(out);
  return pass('no page -> [] (no throw)');
});

// AC-4: the owner handle is parsed out of the status URL.
check('AC-C4', 'handleFromStatusUrl parses <handle>/status/<id>', () => {
  if (commenters.handleFromStatusUrl('https://x.com/100_btc_holder/status/2109264876002738385') !== '100_btc_holder') return 'plain URL failed';
  if (commenters.handleFromStatusUrl('https://x.com/Foo/status/1?ref=abc') !== 'foo') return 'query string failed';
  if (commenters.handleFromStatusUrl('not a url') !== '') return 'garbage should be empty';
  return pass('url -> owner handle');
});

// AC-6: comment-section candidates still face the follower ceiling.
check('AC-C6', 'a commenter over the follower ceiling is not a growth target', () => {
  if (verified.qualifiesAsGrowthTarget({ verified: true, followers: 16800, maxFollowers: 10000 }) !== false) return '16800 wrongly qualified';
  if (verified.qualifiesAsGrowthTarget({ verified: true, followers: 8652, maxFollowers: 10000 }) !== true) return '8652 wrongly rejected';
  return pass('16800 rejected / 8652 accepted');
});

// AC-7: a successful follow lands in the published history (kind='follow').
check('AC-C7', 'growthFollowRound records a successful follow via remember()', async () => {
  const src = readFileSync('src/run.mjs', 'utf8');
  const m = src.match(/const fr = await follow\(page, url\);([\s\S]{0,9000}?)seenFollowSet\.add\(author\);/);
  if (!m) return 'follow success block not found';
  if (!/remember\(\{ id: \(isFollowBack \? 'fb' : 'f'\) \+ new Date/.test(m[1])) return 'remember({ id: \'f\' + author }) missing after a successful follow';
  if (!/kind: \(isFollowBack \? 'followBack' : 'follow'\)/.test(m[1])) return "remember() is not tagged with the per-kind follow kind";
  return pass('follow -> remember(kind=follow)');
});

// AC-13: an empty growth-follow draft is never text-gated (too-short:0 trap).
check('AC-C13', 'server approve gates growthFollow by kind budget, not checkPost on ""', () => {
  const src = readFileSync('src/server.mjs', 'utf8');
  if (!/isFollow/.test(src)) return 'isFollow branch missing';
  if (!/checkKindBudget\(\{ kind: isFollowBack \? 'followBack' : 'follow'/.test(src)) return 'growthFollow not gated by checkKindBudget(follow)';
  if (!/mod\.follow\(page, d\.targetUrl\)/.test(src)) return 'approve does not call mod.follow for growthFollow';
  if (!/d\.kind === 'othersReply'\) await mod\.reply/.test(src)) return 'othersReply is not dispatched as a reply';
  return pass('approve dispatches follow/reply correctly');
});

// ---- Follow-back (回关) lane: notifications discovery + own budget -------
const notices = await import('../src/perceive/notifications.mjs');

// AC-FB1: extractFollowBacks keeps only 'followed you' cells, dedupes, drops me.
check('AC-FB1', 'extractFollowBacks reads followed-you cells and dedupes', () => {
  const cells = [
    { text: 'Ann followed you', links: ['/ann'] },
    { text: 'Bob and 2 others followed you', links: ['/bob', '/carl', '/dana'] },
    { text: 'Someone liked your post', links: ['/noise'] },
    { text: 'Ann followed you', links: ['/ann'] },
  ];
  const out = notices.extractFollowBacks(cells, { myHandle: 'carl' });
  const names = out.map((r) => r.author).sort().join(',');
  if (names !== 'ann,bob,dana') return 'expected ann,bob,dana got ' + names;
  return pass('followed-you only + dedupe + self removal -> ' + names);
});

// AC-FB2: aggregated 'and N others' links are all captured.
check('AC-FB2', 'aggregated follow notification yields every linked handle', () => {
  const links = ['/a1','/a2','/a3','/a4'];
  const out = notices.extractFollowBacks([{ text: 'X and 34 others followed you', links }], {});
  if (out.length !== 4) return 'expected 4 got ' + out.length;
  return pass('4 handles from one aggregated cell');
});

// AC-FB3: bad input never throws.
check('AC-FB3', 'extractFollowBacks never throws on bad input', () => {
  for (const bad of [null, undefined, 7, 'x', [null], [{ text: null, links: null }]]) {
    const out = notices.extractFollowBacks(bad, {});
    if (!Array.isArray(out)) return 'not an array for ' + JSON.stringify(bad);
  }
  return pass('bad inputs -> []');
});

// AC-FB4: the collector degrades to [] (never throws) on a broken page.
check('AC-FB4', 'collectFollowBacks degrades to [] when the page throws', async () => {
  const page = { async goto() { throw new Error('boom'); }, async evaluate() { throw new Error('boom'); }, async waitForTimeout() {} };
  const out = await notices.collectFollowBacks(page, { myHandle: 'me' });
  if (!Array.isArray(out) || out.length !== 0) return 'expected [] got ' + JSON.stringify(out);
  return pass('page error -> [] (no throw)');
});

// AC-FB5: 回关 has its own daily cap, separate from proactive follow.
check('AC-FB5', "checkKindBudget({kind:'followBack'}) reads followBackDailyMax", () => {
  const cfg = { gate: { perKind: { followDailyMax: 200, followBackDailyMax: 100 } } };
  const r = gate.checkKindBudget({ kind: 'followBack', state: { followBacksPublished: 5 }, cfg });
  if (r.kind !== 'followBack') return 'kind=' + r.kind;
  if (r.limit !== 100) return 'limit=' + r.limit + ' (must be followBackDailyMax 100, not followDailyMax 200)';
  const cap = gate.checkKindBudget({ kind: 'followBack', state: { followBacksPublished: 100 }, cfg });
  if (cap.ok !== false || !cap.reasons.some((x) => x.startsWith('quota-followBack'))) return 'cap not enforced: ' + cap.reasons.join(',');
  return pass('kind=followBack limit=100 + cap enforced');
});

// AC-FB6: proactive follow and 回关 counters are independent.
check('AC-FB6', 'follow and followBack quotas do not interfere', () => {
  const cfg = { gate: { perKind: { followDailyMax: 200, followBackDailyMax: 100 } } };
  const r = gate.checkKindBudget({ kind: 'follow', state: { followBacksPublished: 100, followsPublished: 0 }, cfg });
  if (r.ok !== true) return 'proactive follow wrongly blocked by the followBack cap';
  return pass('follow stays open when followBack is maxed');
});

// AC-FB10: the daemon and the manual 涨粉 button must invoke the lane when
// EITHER switch is on. Gating on features.follow alone made 回关 unreachable
// whenever 涨粉关注 was off.
check('AC-FB10', 'lane runs when follow=false but followBack=true (call sites)', () => {
  const src = readFileSync('src/run.mjs', 'utf8');
  const daemonOk = /features\.follow !== false \|\| browseCfg\(cfg\)\.features\.followBack !== false/.test(src);
  const roundOk = /feat\.follow !== false \|\| feat\.followBack !== false/.test(src);
  if (!daemonOk) return 'daemon loop still gates growthFollowRound on features.follow alone';
  if (!roundOk) return '--round=follow still gates on features.follow alone';
  return pass('both call sites honour either switch');
});

// AC-FB7 (P1-2 regression): a review-mode 回关 draft must stay on the 回关
// lane. The kind is shared with proactive follow, so the lane marker is what
// the approval path switches on.
check('AC-FB7', 'review 回关 draft carries lane=followBack (not bare growthFollow)', () => {
  const src = readFileSync('src/run.mjs', 'utf8');
  if (!/kind: 'growthFollow', lane: \(isFollowBack \? 'followBack' : 'follow'\)/.test(src)) return "draft is not tagged with lane: isFollowBack ? 'followBack' : 'follow'";
  return pass('draft lane marker present');
});

// AC-FB8 (P1-2 regression): server approve must route on the lane marker,
// not only on the legacy kind, or a reviewed 回关 follows the wrong budget.
check('AC-FB8', "server approves 回关 by lane marker, not kind alone", () => {
  const src = readFileSync('src/server.mjs', 'utf8');
  if (!/const isFollowBack = d\.lane === 'followBack' \|\| d\.kind === 'followBack';/.test(src)) return "server does not treat lane==='followBack' as a 回关";
  return pass("approve reads d.lane === 'followBack'");
});

// AC-FB9 (P3 regression): a null follower count must not be counted as 0 in
// avgFollowers. Structural check keeps this honest without a live browser.
check('AC-FB9', 'null follower count does not dilute avgFollowers', () => {
  const src = readFileSync('src/run.mjs', 'utf8');
  if (/scannedBlue\+\+;\n\s*followerTotal \+= Number\(followers\);\n\s*followerCounted\+\+;/.test(src)) return 'followerTotal still adds Number(followers) unconditionally';
  if (!/if \(followers != null && Number\.isFinite\(Number\(followers\)\)\)/.test(src)) return 'null-guard for avgFollowers missing';
  return pass('avgFollowers only counts real numbers');
});

// AC-FB11 (P0 functional): with 涨粉关注 OFF and 回关蓝V ON, a pool row that
// would qualify for a proactive follow must NOT become a draft, while the
// follow-back lane still drafts the account that just followed me.
check('AC-FB11', 'follow=false + followBack=true: no proactive draft, 回关 still drafts', async () => {
  const dir = mkdtempSync(resolve(os.tmpdir(), 'sm-fb-'));
  const seenFile = resolve(dir, 'follow-seen.json');
  const stateFile = resolve(dir, 'state.json');
  const draftsFile = resolve(dir, 'drafts.json');
  let url = '';
  const page = {
    async goto(u) { url = String(u); },
    async waitForTimeout() {},
    async evaluate(fn) {
      if (/notifications/.test(url)) return [{ text: 'NewFan followed you', links: ['/newfan'] }];
      // profile page read
      return { text: '5K Followers', verified: true, latestTweet: 'hello' };
    },
    locator() { return { first: () => ({ isVisible: async () => false, click: async () => {} }) }; },
    mouse: { wheel: async () => {} },
  };
  const cfg = {
    autoMode: 'review',
    features: { follow: false, followBack: true },
    gate: { perKind: { followDailyMax: 200, followBackDailyMax: 100, followCooldownMinutes: 0, followBackCooldownMinutes: 0 } },
    growthFollow: { maxPerRound: 6, maxFollowers: 10000, followBack: true },
    myHandle: 'me',
  };
  const s = { draftsToday: 0, followsPublished: 0, lastFollowAt: 0, followBacksPublished: 0, lastFollowBackAt: 0 };
  await run.growthFollowRound(page, {
    seenFile, state: s, cfg, pool: [{ author: 'poolguy', verified: true, followers: 5000 }], draftsFile, stateFile, gap: [0, 0],
  });
  const drafts = JSON.parse(readFileSync(draftsFile, 'utf8'));
  rmSync(dir, { recursive: true, force: true });
  const authors = drafts.map((d) => d.author);
  if (authors.includes('poolguy')) return 'proactive follow ran while features.follow=false: ' + JSON.stringify(authors);
  const fb = drafts.find((d) => d.author === 'newfan');
  if (!fb) return 'no 回关 draft written: ' + JSON.stringify(authors);
  if (fb.lane !== 'followBack') return "回关 draft lane=" + fb.lane;
  return pass('pool row suppressed, 回关 draft lane=followBack');
});

// AC-FB12 (live regression): the comment step must reply to the target's real
// status URL, not <profile>/with_replies (which has no composer and timed out
// on every target in the live run).
check('AC-FB12', 'comment step targets a real status URL, never /with_replies', () => {
  const src = readFileSync('src/run.mjs', 'utf8');
  if (/reply\(page, url \+ '\/with_replies'/.test(src)) return "still replies to url + '/with_replies'";
  if (!/latestStatusUrl/.test(src)) return 'profile eval does not capture a status URL';
  if (!/const commentUrl = targetStatus/.test(src)) return 'comment URL is not derived from the status URL';
  return pass('comment targets profile.latestStatusUrl');
});

// AC-FB13: 回关 must not consume the whole round, or Source 2 never runs.
check('AC-FB13', 'follow-back candidates are capped so the proactive lane runs', () => {
  const src = readFileSync('src/run.mjs', 'utf8');
  if (!/followBackCap/.test(src)) return 'no followBackCap';
  if (!/c\.growthFollow\?\.followBackMaxPerRound \?\? Math\.ceil\(maxPerRound \/ 2\)/.test(src)) return 'cap default is not half the round';
  if (!/followBackTaken >= followBackCap/.test(src)) return 'cap is not enforced in the loop';
  return pass('回关 reserves at least half the round');
});

// AC-FB14: an already-followed account must not inflate the follow counters.
check('AC-FB14', 'already-following does not count as a fresh follow', () => {
  const src = readFileSync('src/run.mjs', 'utf8');
  if (!/alreadyFollowing = !!\(fr && fr\.already === true\)/.test(src)) return 'already flag not read from follow()';
  if (!/if \(alreadyFollowing\) \{/.test(src)) return 'no already-following branch';
  if (!/growthFollow already-following, no follow counted/.test(src)) return 'no log for the suppress path';
  return pass('already-following is booked as no-op');
});

// AC-FB15 (2026-10-15 live regression): the authoritative /verified_followers
// source must run BEFORE the notification source. The notification feed is a
// superset of "everyone who ever followed me" and cannot tell whether I already
// follow back, so when it ran first it consumed followBackCap and the genuinely
// pending people were never reached (and already-followed ones were drafted).
check('AC-FB15', 'authoritative verified-followers source runs before notifications', () => {
  const s = readFileSync('src/run.mjs', 'utf8');
  const v = s.indexOf('collectVerifiedFollowBacks(page, { myHandle');
  const n = s.indexOf('collectFollowBacks(page, { myHandle');
  if (v < 0) return 'verified-followers source missing';
  if (n < 0) return 'notifications source missing';
  if (v > n) return 'notifications source is still first (regression)';
  return pass('verified-followers at ' + v + ' precedes notifications at ' + n);
});

// AC-FB16: an account we already follow must never be drafted as a 回关.
// The notification source cannot know the current relationship, so the
// decision is made right after the profile read.
check('AC-FB16', 'a follow-back candidate we already follow is dropped', () => {
  const s = readFileSync('src/run.mjs', 'utf8');
  if (!/isFollowing/.test(s)) return 'profile eval does not read the follow state';
  if (!/if \(isFollowBack && profile && profile\.isFollowing === true\)/.test(s)) return 'no already-following guard for follow-back';
  if (!/already following ' \+ author \+ ' \(no follow-back needed\)/.test(s)) return 'guard has no log line';
  return pass('already-followed follow-back targets are dropped');
});

// AC-FB17: myHandle is NOT in the shipped config, and the authoritative source
// needs it. Leaving it to config silently disabled the whole source, so it must
// be resolved from the live session and degrade to config on failure.
check('AC-FB17', 'myHandle is resolved from the live session when config omits it', () => {
  const s = readFileSync('src/run.mjs', 'utf8');
  if (!/let myHandle = String\(c\.myHandle/.test(s)) return 'myHandle is not reassignable';
  if (!/SideNav_AccountSwitcher_Button/.test(s)) return 'no live handle read';
  if (!/resolved myHandle from the live session/.test(s)) return 'no log for the resolved handle';
  const cfg = JSON.parse(readFileSync('config.example.json', 'utf8'));
  if (cfg.myHandle) return 'config.example.json now ships myHandle; the auto-detect regression test is moot';
  return pass('handle auto-detected; config.example.json still omits it');
});
await Promise.all(pending);

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.desc}${r.detail ? '  :: ' + r.detail : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.error('FAILURES:', failed.length); process.exit(1); }
process.exit(0);