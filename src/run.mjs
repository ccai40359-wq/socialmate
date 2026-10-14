// SocialMate scheduler (integration layer).
// Flow: control -> perceive -> rank -> decide -> generate (voice) -> gate -> publish/draft.
// Every optional module degrades gracefully so the daemon never dies because
// one workstream has not landed yet.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { connect, workPage, closeBrowser } from './edge.mjs';
import { post, quote, reply, like, follow, verify, dismissComposer } from './xbot.mjs';
import { loadConfig, aihotGet } from './aihot.mjs';
import { parseAihotMarkdown } from './aihot-parse.mjs';
import { appendLog } from './log.mjs';
import { loadJson, saveJson, loadState, saveState, ensureDir } from './store.mjs';
import { addDraft } from './drafts.mjs';
import { recordRound } from './store.mjs';
import { scanReplies, draftReplyFor, selectOthersReplyCandidates, draftOthersReplyFor } from './replies.mjs';
import { buildPost, buildQuoteComment, sourceLinkOf, withSourceLink, xOriginalOf } from './planner.mjs';
import { generatePostText, generateQuoteComment, generateReply, generateMuseText } from './voice.mjs';
import { rankCandidates, decideAction, heuristicScore } from './select.mjs';
import { detectLane } from './perceive/lang.mjs';
import { browseRound, browseCfg } from './browse.mjs';
import { markPublishing, clearPublishing } from './publish-queue.mjs';
import { checkPost, remember, hollowQuote, quoteCountForAuthorToday, checkKindBudget, screenContent, othersReplyCountForAuthorToday } from './gate.mjs';
import { parseFollowerCount, qualifiesAsGrowthTarget } from './perceive/verified.mjs';
import { collectCommentersFromPost, handleFromStatusUrl } from './perceive/commenters.mjs';
import { collectFollowBacks } from './perceive/notifications.mjs';


// T7: nothing may block the loop for more than five minutes. The user
// explicitly capped every wait/timeout at 5 min so the daemon always
// re-checks control.json / config.json within a bounded window.
const MAX_WAIT_MS = 5 * 60_000;
const DATA_ROOT = process.env.SOCIALMATE_DATA_DIR || process.cwd();
// cfg is reloaded every scheduler loop (T1). The path-class keys below are
// cached ONCE at module scope and must never be hot-reloaded: a live config
// change to stateFile/seenFile/seenRepliesFile/othersReplySeenFile (or
// voiceModel/cheapModel/profileDir/cdpPort/edgePath) would silently move
// the state/seen/pool files or the model used. Restart-only (T1).
let cfg = loadConfig();
const stateFile = resolve(DATA_ROOT, cfg.stateFile || 'state.json');
const seenFile = resolve(DATA_ROOT, cfg.seenFile || 'queue/seen.json');
const seenRepliesFile = resolve(DATA_ROOT, cfg.seenRepliesFile || 'queue/seen-replies.json');
const othersReplySeenFile = resolve(DATA_ROOT, cfg.othersReplySeenFile || 'queue/others-reply-seen.json');
const poolFile = resolve(DATA_ROOT, 'queue/internal-links.json');
const candidatesFile = resolve(DATA_ROOT, 'queue/candidates.json');

ensureDir('queue');
ensureDir('shots');

const state = loadState(stateFile, () => ({
  units: 0, postsPublished: 0, quotesPublished: 0, repliesPublished: 0, musesPublished: 0, draftsToday: 0,
  nextAllowedAt: 0, lastOffMinute: null, lastPostAt: 0, lastQuoteAt: 0, lastReplyAt: 0, lastMuseAt: 0, engagesPublished: 0, lastEngageAt: 0, browsesPublished: 0, lastBrowseAt: 0, othersRepliesPublished: 0, lastOthersReplyAt: 0, othersRepliedAuthorsByDay: {}, followsPublished: 0, lastFollowAt: 0,
}));
const seen = loadJson(seenFile, { topics: [] });
const seenSet = new Set(seen.topics);
const seenReplies = loadJson(seenRepliesFile, { ids: [] });
const seenReplySet = new Set(seenReplies.ids);
const othersReplySeen = loadJson(othersReplySeenFile, { ids: [] });
const othersReplySeenSet = new Set(othersReplySeen.ids);
const followSeenFile = resolve(DATA_ROOT, 'queue/follow-seen.json');
const followSeen = loadJson(followSeenFile, { ids: [] });
const followSeenSet = new Set(followSeen.ids);

// ---- optional modules --------------------------------------------------
const opt = {
  control: null, perceive: null, humanize: null, safety: null,
};
for (const [key, path] of [
  ['control', './control.mjs'], ['perceive', './perceive/index.mjs'],
  ['humanize', './humanize.mjs'], ['safety', './safety.mjs'],
]) {
  try { opt[key] = await import(path); }
  catch { appendLog(`optional module not ready: ${path}`); }
}

function readControlSafe() {
  if (opt.control?.readControl) {
    try { return opt.control.readControl(); } catch { /* fall through */ }
  }
  try { return JSON.parse(readFileSync(resolve(DATA_ROOT, 'control.json'), 'utf8')); }
  catch { return { paused: false, mode: cfg.autoMode || 'review' }; }
}

// T1 hot reload: re-read config.json at the top of every scheduler loop so a
// config save applies to the next round without a daemon restart. A broken or
// partial file keeps the previous good cfg and is logged — never a crash.
// Hot-swappable keys: dailyTarget, quoteRatio, minGapMinutes, activeHours,
// features.*, gate.perKind.*, browse.*, safety.*, humanize.*, voiceEnabled,
// laneRules.*, jitter, replyScan.*, collect.*, topicSeeds, preferredAuthors.
// Restart-only keys (path-class or boot-time): profileDir, cdpPort, edgePath,
// stateFile/seenFile/seenRepliesFile/othersReplySeenFile, voiceModel/cheapModel.
function reloadCfg() {
  try {
    const next = loadConfig();
    if (next && typeof next === 'object') { cfg = next; return cfg; }
  } catch (e) {
    appendLog(`config reload failed, keeping previous cfg: ${e.message}`);
  }
  return cfg;
}

// ---- helpers -----------------------------------------------------------
function rand(a, b) { return Math.random() * (b - a) + a; }
function randInt(a, b) { return Math.floor(rand(a, b + 1)); }
function chinaHour() {
  return Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit' }));
}
function inActiveHours() {
  const { start = 0, end = 24 } = cfg.activeHours || {};
  const h = chinaHour();
  return h >= start && h < end;
}

// ---- publish gate (hard invariant I1) ----------------------------------
// Review is the default and the only safe default: generated content goes to
// the draft queue and waits for the human. Publishing therefore requires an
// explicit opt-in ON THIS INVOCATION. A stored preference alone — control.json
// mode or config.autoMode — is never sufficient, because a stale preference
// quietly turning into real posts is exactly the bug this gate prevents.
// The desktop app passes --publish only when the user picked 全自动 in the UI.
export const PUBLISH_FLAG = process.argv.includes('--publish');

// Round-name dispatch for `--once --round=<name>` (desktop manual triggers).
// Valid names match the scheduler rounds; anything else is a caller error and
// must abort before any browser work happens.
const ROUND_NAMES = ['collect', 'like', 'browse', 'reply', 'others', 'content', 'follow'];
const roundArg = (process.argv.find((a) => a.startsWith('--round=')) || '').split('=')[1] || null;

// Resolve whether this round may publish, and say why. Pure and exported so the
// behaviour is asserted directly instead of inferred from a live run.
export function resolveGate({ ctrlMode, cfgMode, override, publishFlag = PUBLISH_FLAG } = {}) {
  // `override` may only TIGHTEN toward review; it can never relax a stored review.
  // The live switch is control.json's mode, falling back to config.autoMode.
  const stored = ctrlMode || cfgMode || 'review';
  const want = override === 'review' ? 'review' : stored;
  const requested = want === 'auto';
  const publish = requested && !!publishFlag;
  return {
    publish,
    want,
    reason: !requested ? 'mode-review' : (publish ? 'auto+explicit-flag' : 'auto-but-no-explicit-flag'),
  };
}

// §9.2 off-minute scheduling: never a round minute, never a repeat of the
// previous minute, always jittered. Pure, so it is directly assertable.
export const OFF_MINUTES = [3, 7, 11, 17, 23, 33, 41, 47, 51, 53];
export function nextOffMinuteAt(fromMs, minGapMinutes, lastMinute = null, opts = {}) {
  const gap = Math.max(1, Math.round(minGapMinutes));
  // Default path (opts.maxSnapMinutes == null) keeps the legacy linear scan
  // byte-for-byte: the minute is ALWAYS inside OFF_MINUTES and never repeats.
  // T3: when opts.maxSnapMinutes is a number we instead snap to the nearest
  // allowed off-minute within [gap, gap + maxSnapMinutes] minutes ahead; if
  // none exists we yield to the user interval (minute may leave OFF_MINUTES).
  const maxSnap = opts && typeof opts.maxSnapMinutes === 'number' && Number.isFinite(opts.maxSnapMinutes) ? Math.max(0, opts.maxSnapMinutes) : null;
  if (maxSnap == null) {
    let t = fromMs + gap * 60_000;
    for (let i = 0; i < 24 * 60; i++) {
      const m = new Date(t).getMinutes();
      if (OFF_MINUTES.includes(m) && m !== lastMinute) return { at: t, minute: m, snapped: false, snapMinutes: 0 };
      t += 60_000;
    }
    return { at: t, minute: new Date(t).getMinutes(), snapped: false, snapMinutes: 0 };
  }
  // Snap mode: scan the bounded window for the nearest allowed minute.
  const base = fromMs + gap * 60_000;
  const limit = fromMs + (gap + maxSnap) * 60_000;
  let best = null;
  for (let t = base; t <= limit; t += 60_000) {
    const m = new Date(t).getMinutes();
    if (OFF_MINUTES.includes(m) && m !== lastMinute) { best = { at: t, minute: m, snapped: true, snapMinutes: Math.round((t - base) / 60_000) }; break; }
  }
  if (best) return best;
  // Window exhausted: yield to the user-configured interval (CON-1).
  return { at: base, minute: new Date(base).getMinutes(), snapped: false, snapMinutes: 0 };
}

// T1: the publish cadence is a RANDOM interval, not a fixed one. When the user
// configures both a floor and a ceiling (minGapMinutes < maxGapMinutes) every
// round draws its own minute gap uniformly inside [min, max]; the previous
// behaviour only ever added a <=120s sub-minute jitter on top of a single
// floor value, so a "30-50min" setting really produced 30-32min. Exported and
// pure (randFn injectable) so the spread is asserted directly instead of being
// inferred from a live daemon. Returns a float; the caller rounds to whole
// minutes. Degrades to the legacy single-floor value when the ceiling is
// missing or not above the floor (never NaN, never a surprise interval).
export function drawGapMinutes(minGapMinutes, maxGapMinutes, randFn = Math.random) {
  const floor = Number(minGapMinutes);
  const ceiling = Number(maxGapMinutes);
  const hasFloor = Number.isFinite(floor) && floor > 0;
  const hasCeiling = Number.isFinite(ceiling) && Number.isFinite(floor) && ceiling > floor;
  if (hasFloor && hasCeiling) return floor + (ceiling - floor) * randFn();
  if (hasFloor) return floor;
  return null;
}

// T8: a block must leave evidence we can inspect after the fact. The real
// implementation lives in safety.mjs so it is directly testable; the local
// fallback only runs if the safety module failed to load.
async function captureBlock(page, reason) {
  if (opt.safety?.captureBlock) {
    return opt.safety.captureBlock(page, reason, { dir: cfg.screenShotDir || "shots" });
  }
  try {
    const dir = resolve(DATA_ROOT, cfg.screenShotDir || "shots");
    ensureDir(dir);
    const file = resolve(dir, "blocked-" + new Date().toISOString().replace(/[:.]/g, "-") + ".png");
    await page.screenshot({ path: file, fullPage: false });
    appendLog("BLOCKED screenshot: " + file);
    return file;
  } catch (e) {
    appendLog("BLOCKED screenshot failed: " + e.message);
    return null;
  }
}
// T8-b: pause via the shared control writer so scheduler and tests agree.
function pause(reason) {
  if (opt.control?.pause) { try { opt.control.pause(reason); return; } catch { /* fall through */ } }
  if (opt.control?.writeControl) {
    try { opt.control.writeControl({ paused: true, pauseReason: reason }); return; } catch { /* fall through */ }
  }
  saveJson(resolve(DATA_ROOT, "control.json"), { ...readControlSafe(), paused: true, pauseReason: reason, updatedAt: new Date().toISOString() });
}
function loadPool() {
  try { return JSON.parse(readFileSync(poolFile, 'utf8')); } catch { return []; }
}
async function refreshPool() {
  const paths = ['/latest?limit=30', '/latest?limit=30&mode=all', '/latest?window=7d&limit=30'];
  const byUrl = new Map(loadPool().map((x) => [x.url, x]));
  for (const p of paths) {
    try {
      for (const it of parseAihotMarkdown(await aihotGet(cfg, p))) byUrl.set(it.url, it);
      await new Promise((r) => setTimeout(r, 500));
    } catch (e) { appendLog(`pool refresh skip ${p}: ${e.message}`); }
  }
  const all = [...byUrl.values()];
  saveJson(poolFile, all);
  return all;
}

// Normalize an AIHOT pool item into the shared Candidate shape.
function poolToCandidate(it) {
  return {
    text: it.summary || it.title, title: it.title, author: it.source || '',
    likes: null, ageHours: null, url: it.url, lang: 'zh',
    source: 'aihot', origin: it.originalUrl || null,
  };
}

function loadCandidatePool() { try { return JSON.parse(readFileSync(candidatesFile, 'utf8')); } catch { return []; } }
function saveCandidatePool(list) { saveJson(candidatesFile, list); }

// I2: the content round NEVER reads X. It consumes the pool that collectRound
// filled. If the pool is empty it falls back to the cached AIHOT pool (HTTP
// only, no X session read).
function gatherCandidates() {
  const pool = loadCandidatePool();
  if (pool.length) return pool;
  appendLog('content round: candidate pool empty (run collectRound first); using AIHOT HTTP cache');
  return loadPool().map(poolToCandidate);
}

function pickFresh(ranked) {
  const fresh = ranked.filter((c) => !seenSet.has(c.url));
  const list = fresh.length ? fresh : ranked;
  if (!list.length) return null;
  const item = list[0];
  seenSet.add(item.url);
  seen.topics = [...seenSet].slice(-500);
  saveJson(seenFile, seen);
  return item;
}

export async function pickQuoteTarget(page, candidate) {
  const native = candidate.origin && /(?:^https?:\/\/)(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/.test(candidate.origin);
  if (!native) return null;
  const m = candidate.origin.match(/^(https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+)/);
  const url = m ? m[1].replace('twitter.com', 'x.com') : candidate.origin;
  // A2b: never quote a dead original. The native URL must actually resolve to
  // a live tweet article — one navigation, read-only, and any failure (timeout,
  // login wall, deleted/private post, non-tweet page) degrades to null so the
  // caller falls back to a plain post.
  // Includes X's own 404 copy ("Hmm...this page doesn't exist") measured on a
  // deleted/private post, so a dead link fails fast instead of polling out the
  // whole budget. Curly and straight apostrophes both occur.
  const DEAD_TEXT = /This post is unavailable|this post was deleted|no longer available|此帖不可用|该帖子已被删除|页面不存在|Sorry, you are not authorized|page doesn[’']?t exist|Hmm\.\.\./i;
  try {
    // T7-5: a dead/lost connection used to downgrade to post on the FIRST
    // timeout. Retry once (1.5s apart, total still far under the 5 min cap)
    // so transient net::ERR_TIMEOUT does not silently kill the quote lane.
    let navErr = null;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) {
      navErr = e;
      appendLog('quote target check failed (attempt 1: ' + e.message + '); retrying once');
      await new Promise((r) => setTimeout(r, 1500));
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } catch (e2) {
        navErr = e2;
        appendLog('quote target check failed (attempt 2: ' + e2.message + '); downgrading to post');
      }
    }
    if (navErr) return null;
    await page.waitForTimeout(2500);
    // P0 (quote-reliability): Playwright's isVisible({timeout}) does NOT poll —
    // it reports the state at call time and returns immediately (measured 92ms),
    // while X's SPA needs 0.4-4s to mount the article. On the live pool that
    // made the quote lane fail ~5x more often than it succeeded, and every
    // failure silently downgraded to a plain post. Poll isVisible() instead of
    // trusting a single read; a genuinely dead link still exhausts the budget
    // and degrades, and the dead-text check below still bails out early.
    const article = page.locator('article[data-testid="tweet"]').first();
    let hasTweet = false;
    let dead = false;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      hasTweet = await article.isVisible().catch(() => false);
      if (hasTweet) break;
      // A deleted/private post renders X's own "page doesn't exist" copy with
      // no article. Checking it inside the loop means a truly dead link fails fast
      // instead of burning the whole budget.
      const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
      if (DEAD_TEXT.test(bodyText)) { dead = true; break; }
      await page.waitForTimeout(400);
    }
    if (dead || !hasTweet) return null;
    const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    if (DEAD_TEXT.test(bodyText)) return null;
    return { url, how: 'native' };
  } catch (e) {
    appendLog('quote target check failed (' + e.message + '); downgrading to post');
    return null;
  }
}

// ---- rounds ------------------------------------------------------------
// I2: collection is its own round. It only READS X and writes the candidate
// pool; it never posts. Publishing consumes this pool in a later round.
export async function collectRound(page, { onStats } = {}) {
  let got = [];
  let perceiveStats = null;
  if (opt.perceive?.collectCandidates) {
    try { got = (await opt.perceive.collectCandidates({ page, cfg, limit: 40, onStats: (st) => { perceiveStats = st; } })) || []; }
    catch (e) { appendLog('collect: perceive failed (' + e.message + ')'); }
  }
  if (!got.length) {
    try { got = (await refreshPool()).map(poolToCandidate); } catch (e) { appendLog('collect: aihot fallback failed (' + e.message + ')'); }
  }
  const byUrl = new Map(loadCandidatePool().filter((c) => c && c.url).map((c) => [c.url, c]));
  // Self-heal legacy rows: any row without an intent field was written before
  // lane marking landed, so it gets one now from its own text/title before it
  // can reach the quote/muse branches (growth rows must never be quoted).
  for (const c of byUrl.values()) {
    if (c && typeof c.intent !== 'string') {
      c.intent = detectLane(String(c.text || '') + ' ' + String(c.title || ''));
    }
  }
  for (const c of got) {
    if (c && c.url && !byUrl.has(c.url)) {
      if (typeof c.intent !== 'string') {
        c.intent = detectLane(String(c.text || '') + ' ' + String(c.title || ''));
      }
      byUrl.set(c.url, c);
    }
  }
  // Re-run the perceive-layer quality gate over the merged pool so legacy
  // dirty rows (likes=0, bad lang, irrelevant) do not linger after the first
  // cleaned collect (T1-c / T5-a).
  const mergedAll = [...byUrl.values()];
  const gated = [];
  for (const c of mergedAll) {
    const q = (opt.perceive?.qualityGate ? opt.perceive.qualityGate(c, cfg) : { ok: true });
    if (!q.ok) { appendLog('collect/drop legacy ' + c.source + ':' + q.reason); continue; }
    gated.push(c);
  }
  const merged = gated.slice(-200);
  saveCandidatePool(merged);
  appendLog('collect: +' + got.length + ' new, pool=' + merged.length + ' (gated ' + mergedAll.length + ' -> ' + gated.length + ')');
  if (typeof onStats === 'function') {
    try {
      onStats({
        kind: 'collect',
        read: perceiveStats?.read ?? got.length,
        kept: perceiveStats?.kept ?? merged.length,
        dropped: perceiveStats?.dropped ?? Math.max(0, mergedAll.length - gated.length),
        dropReasons: perceiveStats?.dropReasons || {},
        bySource: perceiveStats?.bySource || {},
        acted: 0,
        note: 'collect round',
      });
    } catch { /* stats must never break collection */ }
  }
  return { ok: true, collected: got.length, pool: merged.length, stats: perceiveStats || null };
}

export async function contentRound(page, { mode, publish, dryRun, collect = false } = {}) {
  if (collect) await collectRound(page).catch((e) => appendLog('collect (inline) failed: ' + e.message));
  const ctrl = readControlSafe();
  const gate = resolveGate({ ctrlMode: ctrl.mode, cfgMode: cfg.autoMode, override: mode, publishFlag: publish ?? PUBLISH_FLAG });
  const useVoice = cfg.voiceEnabled !== false;
  const features = browseCfg(cfg).features;

  // Feature switches: the content lane may only run when at least one of
  // post/quote/muse is enabled (main-session ruling, F2-a/F2-c). The gate
  // below is NOT a publish gate: publish still needs the explicit --publish
  // flag in review/auto. It only decides whether the round produces a draft.
  const contentEnabled = features.post || features.quote || features.muse;
  if (!contentEnabled) {
    appendLog('content round skipped: all content features disabled (features.post/quote/muse)');
    return { ok: false, reason: 'content-features-disabled' };
  }
  const candidates = gatherCandidates();
  if (!candidates.length) { appendLog('no candidates'); return { ok: false, reason: 'no-candidates' }; }

  // D3 (cost-open-up): the candidate window lives in cfg.select, not here.
  const ranked = await rankCandidates(candidates, cfg);
  // The ranking window is deliberately small (LLM scoring cost), but a daemon
  // that can ONLY see that window re-picks the same top row forever once the
  // window is exhausted — observed live as the identical tweet being chosen
  // every single round. Order the WHOLE pool by rank so a fresh candidate
  // exists as long as the pool holds any unseen row; the ranked head still wins
  // whenever it is fresh, so normal behaviour is unchanged.
  const rankedUrls = new Set(ranked.map((c) => c.url));
  const rest = candidates
    .filter((c) => !rankedUrls.has(c.url))
    .map((c) => ({ ...c, score: c.score ?? heuristicScore(c, cfg) }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const ordered = [...ranked, ...rest];
  // AI-topic preference (T1): a stable partition so an unseen AI-related
  // candidate wins over a higher-scored non-AI row (涨粉/F1/闲聊). It is NOT a
  // filter: nothing is dropped, and with no AI candidate the old order stands.
  let pickPool = ordered;
  if (cfg.perceive?.preferAiTopics !== false) {
    try {
      const ai = [];
      const restLane = [];
      for (const c of ordered) {
        if (opt.perceive?.looksAiRelevant?.(String(c.text || '') + ' ' + String(c.title || ''))) ai.push(c);
        else restLane.push(c);
      }
      pickPool = [...ai, ...restLane];
    } catch { pickPool = ordered; }
  }
  const picked = pickFresh(pickPool);
  if (!picked) { appendLog('no fresh candidate'); return { ok: false, reason: 'no-fresh' }; }

  appendLog(`Picked (score ${picked.score ?? '-'}): ${(picked.title || picked.text || '').slice(0, 70)}`);

  const action = decideAction(picked, cfg);
  let text = null;
  let kind = 'post';
  let targetUrl = null;

  // F2-d/F2-e: when the post lane is disabled, the plain-post lane is off
  // even if decideAction resolved to 'post' (hash missed quote/muse). Skip
  // the whole round rather than emitting a post draft.
  if (action === 'post' && !features.post) {
    appendLog('skip: post lane disabled (decideAction resolved to post)');
    return { ok: false, reason: 'post-lane-disabled' };
  }

  // Fundamentals on the pick: source/likes/author/lang. Quote targets must
  // come from the T1-cleaned pool — a likes=0 candidate never becomes a
  // quote target (T5-a).
  const candidatePoolOk = (picked.likes == null || picked.likes >= (cfg.perceive?.minLikes ?? 10)) && ['zh', 'en'].includes((picked.lang || '').toLowerCase());
  // Effective lane: legacy rows without an intent field are classified on the
  // fly from their own text/title, so growth rows can never be quoted even
  // before a collect self-heals the pool.
  const pickedLane = picked.intent || detectLane(String(picked.text || '') + ' ' + String(picked.title || ''));
  if (action === 'quote') {
    if (!candidatePoolOk) {
      if (!features.post) {
        appendLog('skip: post lane disabled (quote target rejected by pool gate)');
        return { ok: false, reason: 'post-lane-disabled' };
      }
      appendLog('quote target rejected by pool gate (likes/lang); downgrading to post');
    } else if (pickedLane === 'growth') {
      // Lane rule hard gate (T2): a growth-intent pick may never quote, even
      // if decideAction resolved to 'quote'. Degrade to a plain post.
      if (!features.post) {
        appendLog('skip: post lane disabled (quote target is growth lane)');
        return { ok: false, reason: 'post-lane-disabled' };
      }
      appendLog('quote target is growth lane; downgrading to post');
    } else {
      const target = await pickQuoteTarget(page, picked);
      if (!target) {
        if (!features.post) {
          appendLog('skip: post lane disabled (quote target unavailable)');
          return { ok: false, reason: 'post-lane-disabled' };
        }
        appendLog('quote target unavailable; downgrading to post');
      }
      else {
        kind = 'quote';
        targetUrl = target.url;
        text = buildQuoteComment(picked, useVoice ? await generateQuoteComment(picked) : null);
      }
    }
  } else if (action === 'muse' && ['x-home', 'x-following'].includes(picked.source) && pickedLane !== 'growth') {
    // Muse: inspired by a timeline tweet, but speaks the author's own words —
    // never calls quote() and carries no link (T3-c / T4-i).
    kind = 'muse';
    text = useVoice ? await generateMuseText(picked) : null;
    if (!text) {
      appendLog('muse: voice unavailable; downgrading to post');
      kind = 'post';
    }
  }
  if (!text && !features.post) {
    // F2-d/F2-e (main-session ruling): when the post lane is disabled, any
    // path that would normally degrade to a plain post must skip the whole
    // round instead. Quote/muse already succeeded above when they were
    // reachable; reaching here means they were unavailable and the fallback
    // is post, which is off.
    appendLog('skip: post lane disabled (quote/muse unavailable; no post fallback)');
    return { ok: false, reason: 'post-lane-disabled' };
  }
  if (!text) {
    kind = 'post';
    const drafted = useVoice ? await generatePostText(picked) : null;
    text = buildPost(picked, drafted);
  }

  // Quote-quality: a comment with zero token overlap against the original
  // tweet body is a hollow quote and must not publish (T5-d). The check runs
  // here, before the gate / publish (T5-f).
  if (kind === 'quote' && text && picked.text) {
    if (hollowQuote(text, picked.text)) {
      appendLog('quote rejected: hollow quote (no token overlap with original)');
      kind = 'post';
      targetUrl = null;
      if (!features.post) {
        appendLog('skip: post lane disabled (hollow quote downgrade blocked)');
        return { ok: false, reason: 'post-lane-disabled' };
      }
      const drafted = useVoice ? await generatePostText(picked) : null;
      text = buildPost(picked, drafted);
    }
  }

  // Quote-quality: one quote per author per day (T5-e). Tracked in state by
  // date so the same author cannot be quoted twice the same day.
  if (kind === 'quote' && picked.author) {
    if (quoteCountForAuthorToday(state, picked.author) > 0) {
      appendLog('quote rejected: author already quoted today (' + picked.author + ')');
      kind = 'post';
      targetUrl = null;
      if (!features.post) {
        appendLog('skip: post lane disabled (author already quoted today)');
        return { ok: false, reason: 'post-lane-disabled' };
      }
      const drafted = useVoice ? await generatePostText(picked) : null;
      text = buildPost(picked, drafted);
    }
  }

  // T2: a post carrying a "选题" (title) must also carry its source. The
  // reader has no idea what a naked one-liner refers to, so a topic post either
  // includes the source link in its body or it is skipped. Quote/muse are
  // exempt: a quote is its own source, and muse must never contain a URL.
  const sourceLink = sourceLinkOf(picked);
  const isTopicPost = kind === 'post' && !!String(picked.title || '').trim();
  const requireSource = cfg.topicPostRequiresSource !== false;
  if (isTopicPost && requireSource) {
    if (!sourceLink) {
      appendLog('skip: no source link for topic post :: ' + String(picked.title || '').slice(0, 50).replace(/\n/g, ' '));
      return { ok: false, reason: 'no-source-link' };
    }
    text = withSourceLink(text, sourceLink);
  }

  const verdict = checkPost({ text, cfg, kind, state });
  if (!verdict.ok) {
    appendLog(`Gate rejected (${verdict.reasons.join(', ')}): ${text.slice(0, 60)}`);
    return { ok: false, reason: 'gate', reasons: verdict.reasons };
  }

  if (!gate.publish) {
    // dryRun exists so the review path can be exercised without touching the
    // queue; the default path always leaves a human-reviewable draft behind.
    if (dryRun) {
      appendLog(`DRYRUN ${kind} (gate=${gate.reason}) :: ${text.slice(0, 60).replace(/\n/g, ' ')}`);
      return { ok: true, dryRun: true, kind, gate: gate.reason, text };
    }
    const d = addDraft({ kind, targetUrl, text, sourceUrl: kind === 'post' ? sourceLink : null, title: picked.title || '', score: picked.score ?? null, why: picked.why || '' });
    appendLog(`DRAFT #${d.id} [${kind}] queued (gate=${gate.reason}) :: ${text.slice(0, 60).replace(/\n/g, ' ')}`);
    state.draftsToday++;
    state.units++;
    saveState(stateFile, state);
    return { ok: true, drafted: true, id: d.id, gate: gate.reason };
  }

  // Per-kind accounting (T6-c / T3-d): publish/quote/muse/reply are counted
  // separately so each can carry its own cooldown and quota.
  // Live queue marker: written BEFORE the primitive runs and cleared after, so
  // the 队列 page can show what is publishing right now in 全自动 mode (where
  // nothing is ever left in drafts.json).
  const pvId = markPublishing({ kind, text, targetUrl: kind === 'quote' ? targetUrl : (picked.url || null), source: 'auto-round', intent: pickedLane });
  try {
  if (kind === 'quote') {
    await quote(page, targetUrl, text);
    state.quotesPublished++;
    state.lastQuoteAt = Date.now();
    if (picked.author) {
      const todayKey = new Date().toISOString().slice(0, 10);
      state.quotedAuthorsByDay = state.quotedAuthorsByDay || {};
      state.quotedAuthorsByDay[todayKey] = [...(state.quotedAuthorsByDay[todayKey] || []), picked.author].slice(-50);
    }
  } else if (kind === 'muse') {
    await post(page, text);
    state.musesPublished++;
    state.lastMuseAt = Date.now();
  } else {
    await post(page, text);
    state.postsPublished++;
    state.lastPostAt = Date.now();
  }
  } finally {
    clearPublishing(pvId.id);
  }
  state.units++;
  remember({ id: `p${Date.now()}`, text, kind, url: picked.url });
  saveState(stateFile, state);
  return { ok: true, published: true, kind };
}

export async function replyRound(page, { mode, publish } = {}) {
  if (browseCfg(cfg).features.reply === false) {
    appendLog('reply round skipped: features.reply=false');
    return { checked: 0, acted: 0, skipped: true };
  }
  const ctrl = readControlSafe();
  // The old expression here had an operator-precedence bug that could resolve
  // to 'auto' when autoMode was auto, publishing replies with no explicit
  // consent. Route it through the same gate as everything else.
  const gate = resolveGate({ ctrlMode: ctrl.mode, cfgMode: cfg.autoMode, override: mode, publishFlag: publish ?? PUBLISH_FLAG });
  if (opt.safety?.detectBlock) {
    const b = await opt.safety.detectBlock(page).catch(() => ({ blocked: false }));
    if (b.blocked) {
      appendLog(`BLOCKED (${b.reason}); pausing and skipping reply round`);
      pause(b.reason);
      await captureBlock(page, b.reason);
      return { checked: 0, acted: 0, blocked: true };
    }
  }

  let replies;
  try { replies = await scanReplies(page, { maxAgeHours: cfg.replyScan?.maxAgeHours ?? 48 }); }
  catch (e) { appendLog(`reply scan failed: ${e.message}`); return { checked: 0, acted: 0 }; }

  const fresh = replies.filter((r) => !seenReplySet.has(r.tweetId));
  appendLog(`Replies: found ${replies.length}, new ${fresh.length}`);
  if (!fresh.length) return { checked: replies.length, acted: 0 };

  let acted = 0;
  for (const r of fresh.slice(0, cfg.replyScan?.maxPerRound ?? 3)) {
    // draftReplyFor is voice-backed; it may return null when the model is
    // unavailable, in which case the caller falls back and says so.
    let text = await draftReplyFor(r);
    if (!text && cfg.voiceEnabled !== false) text = await generateReply(r);
    if (!text) {
      appendLog('DEGRADED reply: voice unavailable, skipping this reply rather than sending a canned line');
      continue;
    }
    const verdict = checkPost({ text, cfg, kind: 'reply', state });
    if (!verdict.ok) { appendLog(`reply gate rejected (${verdict.reasons.join(',')})`); continue; }

    if (!gate.publish) {
      const d = addDraft({ kind: 'reply', targetUrl: r.url, text, author: r.author, originalText: r.text, tweetId: r.tweetId });
      appendLog(`DRAFT reply #${d.id} -> @${r.author} (gate=${gate.reason}): ${text.slice(0, 40)}`);
      state.draftsToday++;
    } else {
      const pvId = markPublishing({ kind: 'reply', text, targetUrl: r.url, author: r.author, source: 'reply-round' });
      try {
        await reply(page, r.url, text);
        state.repliesPublished++;
        state.lastReplyAt = Date.now();
        remember({ id: `r${r.tweetId}`, text, kind: 'reply', url: r.url });
      } catch (e) {
        if (e.blocked) {
          appendLog(`BLOCKED during reply (${e.reason || e.message}); pausing, no auto-retry`);
          pause(e.reason || e.message);
          await captureBlock(page, e.reason || e.message);
          break;
        }
        appendLog(`reply failed: ${e.message}`);
        continue;
      } finally {
        clearPublishing(pvId.id);
      }
    }
    seenReplySet.add(r.tweetId);
    acted++;
    await new Promise((res) => setTimeout(res, randInt(4000, 9000)));
  }
  seenReplies.ids = [...seenReplySet].slice(-800);
  saveJson(seenRepliesFile, seenReplies);
  return { checked: replies.length, acted };
}


// A5: interact in OTHER people's comment sections. Targets come ONLY from
// the x-home / x-following timeline pools the collect round wrote (R1) — this
// round never reads a search/trends/AIHOT feed as a reply source. Like
// 涨粉 lane (T3): follow BlueV small accounts (followers <= 10k) and, when
// publishing, optionally leave a comment on one of their posts. Same skeleton
// as othersReplyRound: budget/cooldown via checkKindBudget, dedupe in
// queue/follow-seen.json, review mode only writes drafts, blocked pauses.
// Follow itself is a WRITE action and is only invoked when gate.publish is
// true (resolveGate); in review mode the comment lands in the draft queue and
// the follow is recorded as pending in state.
export async function growthFollowRound(page, { seenFile: seenFollowOpt, state: stateOpt, cfg: cfgOpt, pool: poolOpt, draftsFile, stateFile: stateFileOpt, gap, draftFn } = {}) {
  const c = cfgOpt || cfg;
  const s = stateOpt || state;
  const savePath = stateFileOpt || stateFile;
  const feat = browseCfg(c || {}).features;
  // The lane runs when EITHER proactive follow or follow-back is on; each has
  // its own budget (see Source 0 / the per-kind counters below).
  if (feat.follow === false && feat.followBack === false) {
    appendLog('growthFollow round skipped: features.follow=false and followBack=false');
    return { checked: 0, acted: 0, skipped: true };
  }
  const ctrl = readControlSafe();
  const gate = resolveGate({ ctrlMode: ctrl.mode, cfgMode: c.autoMode, override: undefined, publishFlag: PUBLISH_FLAG });
  // P0: proactive follow and 回关 are two independent lanes with their own
  // switches and budgets. `follow` off must stop Sources 1/2/3 outright; the
  // round only returns early when NEITHER lane can run.
  const followOn = feat.follow !== false;
  const followBackOn = feat.followBack !== false && c.growthFollow?.followBack !== false;
  const budget = followOn ? checkKindBudget({ kind: 'follow', state: s, cfg: c }) : { ok: false, reasons: ['features.follow=false'] };
  const followBackBudget = followBackOn ? checkKindBudget({ kind: 'followBack', state: s, cfg: c }) : { ok: false, reasons: ['features.followBack=false'] };
  if (!budget.ok && !followBackBudget.ok) {
    appendLog('growthFollow round: skipped (follow:' + budget.reasons.join(',') + ' | followBack:' + followBackBudget.reasons.join(',') + ')');
    return { checked: 0, acted: 0, skipped: true, reasons: [...budget.reasons, ...followBackBudget.reasons] };
  }
  const seenFollowPath = resolve(DATA_ROOT, seenFollowOpt || 'queue/follow-seen.json');
  const seenFollow = loadJson(seenFollowPath, { ids: [] });
  const seenFollowSet = new Set(seenFollow.ids || []);
  const pool = Array.isArray(poolOpt) ? poolOpt : loadCandidatePool();
  const maxPerRound = c.growthFollow?.maxPerRound ?? 6;
  const maxFollowers = c.growthFollow?.maxFollowers ?? 10000;
  const maxKeywords = c.growthFollow?.maxKeywords ?? 3;
  const keywords = (Array.isArray(c.growthFollow?.keywords) && c.growthFollow.keywords.length) ? c.growthFollow.keywords : (Array.isArray(c.topicSeeds) ? c.topicSeeds.slice(0, maxKeywords) : []);
  let checked = 0;
  let acted = 0;
  let pending = 0;
  let scannedBlue = 0;
  let seenCommenters = 0;
  let followerTotal = 0;
  let followerCounted = 0;
  const seenAuthors = new Set();
  const candidateHandles = [];

  // Candidate source order for the growth lane (AC-5). Every handle found by
  // any source is re-verified on its own profile page below, so an over-limit
  // account (16.8k, 14.4k, 62.7k...) is never followed, no matter where it
  // came from.
  const myHandle = String(c.myHandle || '').replace(/^@/, '').toLowerCase();
  const maxPosts = c.growthFollow?.maxPosts ?? 3;
  const maxPerPost = c.growthFollow?.maxPerPost ?? 8;

  // Source 0 (回关, highest priority): accounts that just followed me get
  // followed back. Read-only notifications scan; degrades to [] on failure so
  // a broken notification feed never blocks the rest of the lane.
  // 回关 must not starve the proactive lane: the two share one round's
  // candidate budget, and a busy notification feed would otherwise fill every
  // slot so Source 2 (interaction-post commenters) never ran. Reserve at least
  // half the round for proactive discovery.
  const followBackCap = Math.max(0, Math.min(maxPerRound, c.growthFollow?.followBackMaxPerRound ?? Math.ceil(maxPerRound / 2)));
  let followBackTaken = 0;
  if (followBackBudget.ok && followBackCap > 0 && candidateHandles.length < maxPerRound && page && typeof page.goto === 'function') {
    const backs = await collectFollowBacks(page, { myHandle, maxScrolls: c.growthFollow?.maxNotifScrolls ?? 6 });
    for (const person of backs) {
      if (candidateHandles.length >= maxPerRound) break;
      if (followBackTaken >= followBackCap) break;
      if (seenFollowSet.has(person.author) || seenAuthors.has(person.author)) continue;
      if (candidateHandles.some((h) => h.author === person.author)) continue;
      candidateHandles.push({ author: person.author, verified: false, followers: null, followBack: true });
      followBackTaken++;
    }
  }

  // Source 1: pool rows that already carry a confirmed verified+follower count.
  // Cheapest path, no navigation. proactive-follow ONLY: if features.follow
  // is off this source must not contribute anything (P0).
  for (const raw of (budget.ok ? pool || [] : [])) {
    const it = raw && typeof raw === 'object' ? raw : {};
    const author = String(it.author || '').replace(/^@/, '').toLowerCase();
    if (!author || !/^[a-z0-9_]{1,15}$/.test(author)) continue;
    if (myHandle && author === myHandle) continue;
    const verifiedFlag = it.verified === true || (it.verifiedBlue === true);
    if (!verifiedFlag && it.followers == null) continue;
    if (verifiedFlag && it.followers != null && qualifiesAsGrowthTarget({ verified: true, followers: it.followers, maxFollowers })) {
      candidateHandles.push({ author, verified: true, followers: Number(it.followers) });
    }
  }

  // Source 2 (growth-comment discovery): interaction posts ("互关 / 浇朋友 /
  // 涨粉") in the pool have comment sections full of BlueV small accounts.
  // This is a far better pool than keyword search, which mostly returns
  // over-limit accounts. Degrades to [] on any failure (commenters.mjs never
  // throws) so a dead comment feed can never empty the lane.
  if (budget.ok && candidateHandles.length < maxPerRound && page && typeof page.goto === 'function') {
    const growthPosts = (pool || [])
      .filter((it) => it && typeof it === 'object' && it.intent === 'growth' && it.url)
      .slice(0, maxPosts);
    for (const gp of growthPosts) {
      if (candidateHandles.length >= maxPerRound) break;
      const owner = handleFromStatusUrl(gp.url);
      const people = await collectCommentersFromPost(page, gp.url, { selfHandle: owner, myHandle, maxPerPost });
      for (const person of people) {
        if (candidateHandles.length >= maxPerRound) break;
        if (seenFollowSet.has(person.author) || seenAuthors.has(person.author)) continue;
        if (candidateHandles.some((h) => h.author === person.author)) continue;
        seenCommenters++;
        candidateHandles.push({ author: person.author, verified: person.verified === true, followers: null });
      }
    }
  }

  // Source 3 (fallback): keyword search. Only used when the pool has no
  // interaction posts to mine. <keyword> filter:verified lang:zh min_faves:5 —
  // max_followers: is inert, so followers are read on each profile page below.
  if (budget.ok && candidateHandles.length < maxPerRound && keywords.length && page && typeof page.goto === 'function') {
    for (const kw of keywords) {
      if (candidateHandles.length >= maxPerRound) break;
      const q = String(kw).trim() + ' filter:verified lang:zh min_faves:5';
      const url = 'https://x.com/search?q=' + encodeURIComponent(q) + '&src=typed_query&f=live';
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(5000);
        const rows = await page.evaluate(() => {
          const out = [];
          for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
            if (art.querySelector('[data-testid="socialContext"]')) continue;
            const nameBox = art.querySelector('[data-testid="User-Name"]');
            const author = nameBox ? ((nameBox.innerText || '').split('\n').find((l) => l.trim().startsWith('@')) || '').trim().replace(/^@/, '').toLowerCase() : '';
            if (!author) continue;
            const verified = !!art.querySelector('[data-testid="icon-verified"]');
            out.push({ author, verified });
          }
          return out;
        });
        for (const row of rows) {
          if (candidateHandles.length >= maxPerRound) break;
          if (seenFollowSet.has(row.author) || seenAuthors.has(row.author)) continue;
          if (row.verified && !candidateHandles.some((h) => h.author === row.author)) candidateHandles.push({ author: row.author, verified: true, followers: null });
        }
      } catch (e) {
        appendLog('growthFollow search "' + kw + '" failed: ' + e.message);
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  for (const target of candidateHandles) {
    if (checked >= maxPerRound) break;
    const author = target.author;
    if (seenFollowSet.has(author) || seenAuthors.has(author)) continue;
    seenAuthors.add(author);
    // Read followers on the profile page; only verified+<=max survive (the
    // search pre-filter only guarantees verified).
    let followers = target.followers;
    let verifiedOk = target.verified === true;
    let profile = null;
    if (page && typeof page.goto === 'function' && page.evaluate) {
      try {
        await page.goto('https://x.com/' + encodeURIComponent(author), { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3500);
        profile = await page.evaluate(() => {
          const el = document.querySelector('a[href$="/verified_followers"], a[href$="/followers"]');
          const text = el ? el.innerText : '';
          const verified = !!document.querySelector('[data-testid="icon-verified"]');
          // The reply composer only exists on a real status page. Walk the
          // author's own articles and take the first one that carries both a
          // status link and body text, so the comment step has a target.
          let latestTweet = '';
          let latestStatusUrl = '';
          for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
            const href = (art.querySelector('a[href*="/status/"]') || {}).getAttribute
              ? art.querySelector('a[href*="/status/"]').getAttribute('href') : '';
            if (!href) continue;
            if (!latestStatusUrl) latestStatusUrl = href;
            const te = art.querySelector('[data-testid="tweetText"]');
            const t = te ? te.innerText : '';
            if (t) { latestTweet = t; latestStatusUrl = href; break; }
          }
          return { text, verified, latestTweet, latestStatusUrl };

        });
        verifiedOk = profile.verified;
        if (profile.text) followers = parseFollowerCount(profile.text);
      } catch (e) {
        appendLog('growthFollow profile read failed ' + author + ' (' + e.message + ')');
        continue;
      }
    }
    const isFollowBack = target.followBack === true;
    // P0: the 回关 and proactive-follow lanes each need their own switch open.
    // A stale candidate from a lane that was switched off mid-run is dropped
    // here, so features.follow=false can never lead to a proactive follow.
    if (isFollowBack ? !followBackBudget.ok : !budget.ok) {
      appendLog('growthFollow skip :: lane closed ' + author + ' (followBack=' + isFollowBack + ')');
      continue;
    }
    if (!verifiedOk) {
      appendLog('growthFollow skip :: not verified ' + author + ' (followBack=' + isFollowBack + ')');
      continue;
    }
    if (!isFollowBack && (followers == null || !qualifiesAsGrowthTarget({ verified: true, followers, maxFollowers }))) {
      appendLog('growthFollow skip :: not qualified ' + author + ' (verified=' + verifiedOk + ' followers=' + followers + ')');
      continue;
    }
    scannedBlue++;
    // P3: a hui-guan target has no verified follower reading (null).
    // Number(null) is 0, which would silently drag avgFollowers toward zero,
    // so only count a real number.
    if (followers != null && Number.isFinite(Number(followers))) {
      followerTotal += Number(followers);
      followerCounted++;
    }
    checked++;
    const url = 'https://x.com/' + encodeURIComponent(author);
    if (!gate.publish) {
      // P1-2: keep the hui-guan lane on the draft. In review mode the kind
      // stays 'growthFollow' (both lanes share that draft shape), so the
      // approval path needs an explicit marker to route it to the followBack
      // budget, counter and published-feed entry.
      const d = addDraft({ kind: 'growthFollow', lane: (isFollowBack ? 'followBack' : 'follow'), targetUrl: url, text: '', author, followers, note: 'follow + comment (review)', pendingFollow: true, sourceText: (profile && profile.latestTweet) || '' }, draftsFile);
      appendLog('DRAFT growthFollow #' + d.id + ' -> @' + author + ' (gate=' + gate.reason + '): pending follow + comment');
      s.draftsToday = (s.draftsToday || 0) + 1;
      pending++;
    } else {
      // Follow is the write action. Failure is not fatal: no rollback, the
      // comment step is skipped on follow failure.
      let followOk = false;
      let alreadyFollowing = false;
      try {
        const fr = await follow(page, url);
        followOk = fr && fr.ok === true;
        // "already following" is not a new follow: it must not consume the
        // 回关/涨粉 daily budget nor write a fresh published-feed entry.
        alreadyFollowing = !!(fr && fr.already === true);
      } catch (e) {
        if (e.blocked) {
          appendLog('BLOCKED during follow (' + (e.reason || e.message) + '); pausing, no auto-retry');
          pause(e.reason || e.message);
          await captureBlock(page, e.reason || e.message);
          break;
        }
        appendLog('growthFollow follow failed: ' + e.message);
      }
      if (!followOk) continue;
      // 回关 and proactive follow are counted separately: each has its own
      // daily cap, and each shows up as its own kind in the published feed.
      // An already-followed account is NOT a new follow, so it must not move
      // the counter or add a feed entry — but interaction (the comment below)
      // is still worth doing.
      if (alreadyFollowing) {
        appendLog('growthFollow already-following, no follow counted ' + author + ' (followBack=' + isFollowBack + ')');
      } else {
        if (isFollowBack) {
          s.followBacksPublished = (s.followBacksPublished || 0) + 1;
          s.lastFollowBackAt = Date.now();
        } else {
          s.followsPublished = (s.followsPublished || 0) + 1;
          s.lastFollowAt = Date.now();
        }
        acted++;
        // AC-7: a follow is invisible unless it lands in the published feed.
        // remember() appends to queue/history.json, which /api/published reads.
        try { remember({ id: (isFollowBack ? 'fb' : 'f') + new Date().toISOString().slice(0, 10) + '-' + author, text: (isFollowBack ? '回关了 @' : '关注了 @') + author, kind: (isFollowBack ? 'followBack' : 'follow'), url }); } catch (e) { appendLog('growthFollow remember failed: ' + e.message); }
      }
      // Optional comment on the target's latest tweet (no rollback on
      // failure). The composer only mounts on a real status page, so this
      // needs profile.latestStatusUrl — a profile URL or /with_replies has no
      // reply box and would always time out.
      const latest = (profile && profile.latestTweet) || '';
      const targetStatus = (profile && profile.latestStatusUrl) || '';
      const commentUrl = targetStatus
        ? (/^https?:/i.test(targetStatus) ? targetStatus : 'https://x.com' + targetStatus)
        : '';
      if (commentUrl && latest) {
        try {
          const text = await (draftFn || draftOthersReplyFor)({ author, text: latest, likes: 0, lang: 'zh', url: commentUrl, source: 'x-home' });
          if (text) {
            const verdict = checkPost({ text, cfg: c, kind: 'othersReply', state: s });
            if (verdict.ok && !hollowQuote(text, latest)) {
              await reply(page, commentUrl, text);
              s.othersRepliesPublished = (s.othersRepliesPublished || 0) + 1;
              s.lastOthersReplyAt = Date.now();
            }
          }
        } catch (e) {
          appendLog('growthFollow comment failed (no rollback): ' + e.message);
        }
      } else {
        appendLog('growthFollow comment skipped ' + author + ' (no status target=' + !!commentUrl + ' text=' + !!latest + ')');
      }
    }
    seenFollowSet.add(author);
    if (checked < maxPerRound) {
      const gapMin = gap && gap[0] != null ? gap[0] : 4000;
      const gapMax = gap && gap[1] != null ? gap[1] : 9000;
      await new Promise((res) => setTimeout(res, randInt(gapMin, gapMax)));
    }
  }
  seenFollow.ids = [...seenFollowSet].slice(-800);
  saveJson(seenFollowPath, seenFollow);
  s.seenCommenters = (s.seenCommenters || 0) + seenCommenters;
  saveState(savePath, s);
  const stats = { checked, acted, candidates: candidateHandles.length, scannedBlue, seenCommenters, pending, avgFollowers: followerCounted ? Math.round(followerTotal / followerCounted) : 0 };
  appendLog('growthFollow round: ' + JSON.stringify(stats));
  return stats;
}
// engageRound it is a read-side, non-publishing round: the draft lands in the
// review queue, the reply() publish primitive is called only when the gate
// says this invocation may publish, and a collect pass never shares a pass
// with publishing (I2 / R6-4). Per-kind quota + cooldown and the same-author
// daily cap are enforced through checkKindBudget /
// othersReplyCountForAuthorToday, and tweetId dedupe persists in
// queue/others-reply-seen.json (first read/write tolerates a missing file).
export async function othersReplyRound(page, { seenFile: seenOthersOpt, state: stateOpt, cfg: cfgOpt, pool: poolOpt, draftsFile, stateFile: stateFileOpt, gap, draftFn } = {}) {
  const c = cfgOpt || cfg;
  const s = stateOpt || state;
  const savePath = stateFileOpt || stateFile;
  const feat = browseCfg(c || {}).features;
  if (feat.othersReply === false) {
    appendLog('othersReply round skipped: features.othersReply=false');
    return { checked: 0, acted: 0, skipped: true };
  }
  const ctrl = readControlSafe();
  const gate = resolveGate({ ctrlMode: ctrl.mode, cfgMode: c.autoMode, override: undefined, publishFlag: PUBLISH_FLAG });
  const budget = checkKindBudget({ kind: 'othersReply', state: s, cfg: c });
  if (!budget.ok) {
    appendLog('othersReply round: skipped (' + budget.reasons.join(',') + ')');
    return { checked: 0, acted: 0, skipped: true, reasons: budget.reasons };
  }
  const seenOthersPath = resolve(DATA_ROOT, seenOthersOpt || c.othersReplySeenFile || 'queue/others-reply-seen.json');
  const seenOthers = loadJson(seenOthersPath, { ids: [] });
  const seenOthersSet = new Set(seenOthers.ids || []);
  const pool = Array.isArray(poolOpt) ? poolOpt : loadCandidatePool();
  const candidates = selectOthersReplyCandidates(pool, { minLikes: c.perceive?.minLikes ?? 10, myHandle: c.myHandle || '', laneRules: c.laneRules });
  const maxPerRound = c.othersReply?.maxPerRound ?? 3;
  let checked = 0;
  let acted = 0;
  let attempted = 0;
  const seenAuthors = new Set();
  for (const cand of candidates) {
    if (checked >= maxPerRound) break;
    const tweetId = String(cand.tweetId || (cand.url || '').match(/status\/(\d+)/)?.[1] || '');
    if (!tweetId || seenOthersSet.has(tweetId)) continue;
    const author = String(cand.author || '').replace(/^@/, '').toLowerCase();
    if (!author || seenAuthors.has(author) || othersReplyCountForAuthorToday(s, author) > 0) continue;
    checked++;
    let text = await (draftFn || draftOthersReplyFor)(cand);
    if (!text && c.voiceEnabled !== false) text = await generateReply(cand);
    if (!text) { appendLog('othersReply: voice unavailable, skipping this target rather than sending a canned line'); continue; }
    const verdict = checkPost({ text, cfg: c, kind: 'othersReply', state: s });
    if (!verdict.ok) { appendLog('othersReply gate rejected (' + verdict.reasons.join(',') + ')'); continue; }
    if (hollowQuote(text, String(cand.text || ''))) { appendLog('othersReply hollow quote rejected: ' + text.slice(0, 40)); continue; }
    const url = cand.url || '';
    if (!gate.publish) {
      const d = addDraft({ kind: 'othersReply', targetUrl: url, text, author, originalText: cand.text || '', tweetId }, draftsFile);
      appendLog('DRAFT othersReply #' + d.id + ' -> @' + author + ' (gate=' + gate.reason + '): ' + text.slice(0, 40));
      s.draftsToday = (s.draftsToday || 0) + 1;
      // D1: a committed draft occupies the same-author same-day slot too, so
      // the cap (othersReplyCountForAuthorToday / R4-2) survives across
      // review rounds; saveState below persists it.
      const dayKey = new Date().toISOString().slice(0, 10);
      s.othersRepliedAuthorsByDay = s.othersRepliedAuthorsByDay || {};
      s.othersRepliedAuthorsByDay[dayKey] = s.othersRepliedAuthorsByDay[dayKey] || [];
      s.othersRepliedAuthorsByDay[dayKey].push(author);
    } else {
      const pvId = markPublishing({ kind: 'othersReply', text, targetUrl: url, author, source: 'others-reply-round' });
      try {
        await reply(page, url, text);
        s.othersRepliesPublished = (s.othersRepliesPublished || 0) + 1;
        s.lastOthersReplyAt = Date.now();
        const dayKey = new Date().toISOString().slice(0, 10);
        s.othersRepliedAuthorsByDay = s.othersRepliedAuthorsByDay || {};
        s.othersRepliedAuthorsByDay[dayKey] = s.othersRepliedAuthorsByDay[dayKey] || [];
        s.othersRepliedAuthorsByDay[dayKey].push(author);
        remember({ id: 'or' + tweetId, text, kind: 'othersReply', url });
      } catch (e) {
        if (e.blocked) {
          appendLog('BLOCKED during othersReply (' + (e.reason || e.message) + '); pausing, no auto-retry');
          pause(e.reason || e.message);
          await captureBlock(page, e.reason || e.message);
          break;
        }
        appendLog('othersReply failed: ' + e.message);
        continue;
      } finally {
        clearPublishing(pvId.id);
      }
    }
    seenOthersSet.add(tweetId);
    seenAuthors.add(author);
    acted++;
    if (checked < candidates.length) {
      const gapMin = gap && gap[0] != null ? gap[0] : 4000;
      const gapMax = gap && gap[1] != null ? gap[1] : 9000;
      await new Promise((res) => setTimeout(res, randInt(gapMin, gapMax)));
    }
  }
  seenOthers.ids = [...seenOthersSet].slice(-800);
  saveJson(seenOthersPath, seenOthers);
  saveState(savePath, s);
  appendLog('othersReply round: acted ' + acted + '/' + checked + ' (candidates ' + candidates.length + ')');
  return { checked, acted, candidates: candidates.length };
}

// B1/B2: like engagement is a read-side, non-publishing round. It consumes the
// candidate pool the collect round filled (never reads fresh X) and never
// calls a publish primitive. A per-kind daily budget + cooldown
// (gate.perKind.engageDailyMax / engageCooldownMinutes) is enforced through
// the same checkKindBudget used by the publish lanes, with state persisted so
// the daily cap survives restarts.
export async function engageRound(page, { max, seenFile: seenLikesOpt, state: stateOpt, cfg: cfgOpt, pool: poolOpt, stateFile: stateFileOpt, gap } = {}) {
  // Injectable overrides exist so the round is directly testable with a mock
  // page/state/cfg; the scheduler calls it with no overrides and the module
  // scope cfg/state/pool are used.
  const c = cfgOpt || cfg;
  const s = stateOpt || state;
  const savePath = stateFileOpt || stateFile;
  if (browseCfg(c || {}).features.like === false) {
    appendLog('engage round skipped: features.like=false');
    return { liked: 0, skipped: true };
  }
  const minLikes = c.perceive?.minLikes ?? 10;
  const perKind = (c.gate && c.gate.perKind) || {};
  const maxLikes = max ?? perKind.engageDailyMax ?? 20;
  const budget = checkKindBudget({ kind: 'engage', state: s, cfg: c });
  if (!budget.ok) {
    appendLog('engage round: skipped (' + budget.reasons.join(',') + ')');
    return { liked: 0, skipped: true, reasons: budget.reasons };
  }
  const seenLikesPath = resolve(DATA_ROOT, seenLikesOpt || c.seenLikesFile || 'queue/seen-likes.json');
  const seenLikes = loadJson(seenLikesPath, { urls: [] });
  const seenLikesSet = new Set(seenLikes.urls || []);

  const pool = Array.isArray(poolOpt) ? poolOpt : gatherCandidates();
  const X_STATUS = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/;
  const candidates = Array.isArray(pool) ? pool : [];
  const fresh = candidates.filter((cd) => cd && cd.url && X_STATUS.test(cd.url) && !seenLikesSet.has(cd.url));
  const remaining = Math.max(0, maxLikes - (s.engagesPublished || 0));
  const topN = Math.min(remaining, Math.max(1, perKind.engagePerRound ?? 3));
  const chosen = fresh.filter((cd) => (cd.likes == null || cd.likes >= minLikes) && ['zh', 'en'].includes(String(cd.lang || '').toLowerCase())).slice(0, topN);

  let liked = 0;
  let attempted = 0;
  for (const cand of chosen) {
    const url = cand.url || null;
    if (!url || seenLikesSet.has(url)) continue;
    attempted++;
    try {
      const ok = await like(page, url);
      if (ok) {
        seenLikesSet.add(url);
        s.engagesPublished = (s.engagesPublished || 0) + 1;
        s.lastEngageAt = Date.now();
        liked++;
      }
    } catch (e) {
      appendLog('engage like failed (' + String(cand.title || cand.text || url).slice(0, 40) + '): ' + e.message);
    }
    if (liked >= topN) break;
    if (attempted < chosen.length) {
      const gapMin = gap && gap[0] != null ? gap[0] : 4000;
      const gapMax = gap && gap[1] != null ? gap[1] : 9000;
      await new Promise((res) => setTimeout(res, randInt(gapMin, gapMax)));
    }
  }

  seenLikes.urls = [...seenLikesSet].slice(-800);
  saveJson(seenLikesPath, seenLikes);
  saveState(savePath, s);
  appendLog('engage round: liked ' + liked + '/' + topN + ' (fresh ' + candidates.length + ')');
  return { liked, attempted, fresh: candidates.length };
}
// ---- main --------------------------------------------------------------
async function main() {
  if (roundArg !== null && !ROUND_NAMES.includes(roundArg)) {
    process.stderr.write('unknown --round: ' + roundArg + ' (expected collect|like|browse|reply|others|content|follow)\n');
    process.exitCode = 1;
    return;
  }
  const { browser, ctx } = await connect(cfg);
  const page = await workPage(ctx);
  const who = await verify(page).catch(() => 'unknown');
  const ctrl = readControlSafe();
  const startedGate = resolveGate({ ctrlMode: ctrl.mode, cfgMode: cfg.autoMode });
  appendLog(`SocialMate up. account=${who} mode=${startedGate.want} publish=${startedGate.publish} (${startedGate.reason}) paused=${!!ctrl.paused} date=${state.date}`);
  if (!startedGate.publish) appendLog('publish gate: review — every action lands in the draft queue for human approval');

  if (process.argv.includes('--once')) {
    const gate = resolveGate({ ctrlMode: ctrl.mode, cfgMode: cfg.autoMode });
    // Desktop manual triggers: --round=<name> runs exactly one round and
    // exits. Without --round the original --once pipeline runs unchanged.
    if (roundArg !== null) {
      const feat = browseCfg(cfg).features;
      if (roundArg === 'collect') {
        await collectRound(page, {
          onStats: (st) => { try { recordRound({ ...st, kind: 'collect', note: 'collect (round)' }); } catch { /* stats must never break collection */ } },
        }).catch((e) => appendLog('collect (round) failed: ' + e.message));
        saveState(stateFile, state);
        appendLog(`--once --round=collect -> ${JSON.stringify({ ok: true })}`);
      } else if (roundArg === 'like') {
        if (feat.like) {
          const r = await engageRound(page).catch((e) => { appendLog('engage (round) failed: ' + e.message); return null; });
          appendLog(`--once --round=like -> ${JSON.stringify(r || { ok: false, error: 'failed' })}`);
        } else {
          appendLog('--once --round=like skipped: features.like=false');
        }
        saveState(stateFile, state);
      } else if (roundArg === 'browse') {
        if (feat.browse) {
          const br = await browseRound(page, { cfg, state }).catch((e) => { appendLog('browse (round) failed: ' + e.message); return null; });
          if (br) {
            try { recordRound({ kind: 'browse', read: br.browsed || 0, kept: 0, dropped: 0, dropReasons: {}, bySource: {}, acted: br.liked || 0, note: 'browse (round)' }); } catch { /* stats must never break a round */ }
            appendLog(`--once --round=browse -> ${JSON.stringify(br)}`);
          }
        } else {
          appendLog('--once --round=browse skipped: features.browse=false');
        }
        saveState(stateFile, state);
      } else if (roundArg === 'reply') {
        const r = await replyRound(page, { publish: gate.publish }).catch((e) => { appendLog('reply (round) failed: ' + e.message); return null; });
        saveState(stateFile, state);
        appendLog(`--once --round=reply -> ${JSON.stringify(r || { ok: false, error: 'failed' })}`);
      } else if (roundArg === 'others') {
        if (feat.othersReply) {
          let r = null;
          try { r = await othersReplyRound(page); } catch (e) { appendLog('othersReply (round) failed: ' + e.message); }
          appendLog(`--once --round=others -> ${JSON.stringify(r || { ok: false, error: 'failed' })}`);
        } else {
          appendLog('--once --round=others skipped: features.othersReply=false');
        }
        saveState(stateFile, state);
      } else if (roundArg === 'follow') {
        // Either switch opens the 涨粉 lane (see growthFollowRound's own gates).
        if (feat.follow !== false || feat.followBack !== false) {
          let r = null;
          try { r = await growthFollowRound(page); } catch (e) { appendLog('growthFollow (round) failed: ' + e.message); }
          appendLog(`--once --round=follow -> ${JSON.stringify(r || { ok: false, error: 'failed' })}`);
        } else {
          appendLog('--once --round=follow skipped: features.follow=false and features.followBack=false');
        }
        saveState(stateFile, state);
      } else if (roundArg === 'content') {
        const r = await contentRound(page, { publish: gate.publish, dryRun: process.argv.includes('--dry-run') }).catch((e) => { appendLog('content (round) failed: ' + e.message); return null; });
        saveState(stateFile, state);
        appendLog(`--once --round=content -> ${JSON.stringify(r || { ok: false, error: 'failed' })}`);
      }
      await closeBrowser(browser);
      return;
    }
    // --once used to queue a draft and then really publish it. It now drafts
    // unless --publish was passed explicitly. --dry-run exists so the review
    // path can be exercised without leaving a draft behind. The collect round
    // runs first and only fills the pool; review never publishes.
    await collectRound(page, {
      onStats: (st) => { try { recordRound({ ...st, kind: 'collect', note: 'collect (once)' }); } catch { /* stats must never break collection */ } },
    }).catch((e) => appendLog('collect (once) failed: ' + e.message));
    // B1/B2: --once may like only when this invocation cannot publish. With an
    // explicit --publish the pass would publish, so engagement is skipped to
    // keep likes and publishing in separate runs.
    if (!gate.publish) {
      const featOnce = browseCfg(cfg).features;
      if (featOnce.like) {
        await engageRound(page).catch((e) => appendLog('engage (once) failed: ' + e.message));
      } else {
        appendLog('engage (once) skipped: features.like=false');
      }
      if (featOnce.browse) {
        const br = await browseRound(page, { cfg, state }).catch((e) => { appendLog('browse (once) failed: ' + e.message); return null; });
        if (br) {
          try { recordRound({ kind: 'browse', read: br.browsed || 0, kept: 0, dropped: 0, dropReasons: {}, bySource: {}, acted: br.liked || 0, note: 'browse (once)' }); } catch { /* stats must never break a round */ }
        }
      } else {
        appendLog('browse (once) skipped: features.browse=false');
      }
      if (featOnce.othersReply) {
        await othersReplyRound(page).catch((e) => appendLog('othersReply (once) failed: ' + e.message));
      } else {
        appendLog('othersReply (once) skipped: features.othersReply=false');
      }
    } else {
      appendLog('engage/browse (once) skipped: this invocation may publish (--publish)');
    }
    const r = await contentRound(page, { publish: gate.publish, dryRun: process.argv.includes('--dry-run') });
    saveState(stateFile, state);
    appendLog(`--once (gate=${gate.reason}, publish=${gate.publish}) -> ${JSON.stringify(r)}`);
    await closeBrowser(browser);
    return;
  }

  let lastReplyScan = 0;
  const replyIntervalMs = (cfg.replyScan?.intervalMinutes ?? 45) * 60_000;
  let lastCollect = 0;
  const collectIntervalMs = (cfg.collect?.intervalMinutes ?? 30) * 60_000;

  while (true) {
    // T1: hot-reload config on every loop so a saved setting takes effect
    // without a daemon restart; broken file keeps the previous good cfg.
    reloadCfg();
    const c = readControlSafe();

    if (c.paused) { await new Promise((r) => setTimeout(r, 30_000)); continue; }
    if (!inActiveHours()) { await new Promise((r) => setTimeout(r, MAX_WAIT_MS)); continue; }

    if (opt.safety?.detectBlock) {
      const b = await opt.safety.detectBlock(page).catch(() => ({ blocked: false }));
      if (b.blocked) {
        // T8: pause globally, leave evidence, and do NOT auto-retry the action.
        appendLog(`BLOCKED: ${b.reason}. Pausing globally; no auto-retry.`);
        pause(b.reason);
        await captureBlock(page, b.reason);
        await new Promise((r) => setTimeout(r, MAX_WAIT_MS));
        continue;
      }
    }

    let collectedThisLoop = false;
    if (Date.now() - lastCollect > collectIntervalMs) {
      lastCollect = Date.now();
      const cr = await collectRound(page, {
        onStats: (st) => { try { recordRound({ ...st, kind: 'collect', note: 'collect (scheduler)' }); } catch { /* stats must never break collection */ } },
      }).catch((e) => { appendLog('collect round failed: ' + e.message); return null; });
      if (cr) { appendLog('Collect round: +' + cr.collected + ' (pool ' + cr.pool + ').'); collectedThisLoop = true; }
    }

    // B1/B2: likes are a non-publishing action and run in the collect pass ONLY.
    // Gating on collectedThisLoop is what makes B2 true: the I2 skip below
    // suppresses publishing on a collect pass, so a like can never share an
    // iteration with a publish.
    if (collectedThisLoop) {
      await engageRound(page).catch((e) => appendLog('engage round failed: ' + e.message));
      // F3-e: browse is a read/interact pass and runs only on a collect pass,
      // before the I2 skip below — it can never share a pass with publishing.
      // F3-f: the feature switch decides whether it runs at all.
      if (browseCfg(cfg).features.browse) {
        const br = await browseRound(page, { cfg, state }).catch((e) => { appendLog('browse round failed: ' + e.message); return null; });
        if (br) {
          try { recordRound({ kind: 'browse', read: br.browsed || 0, kept: 0, dropped: 0, dropReasons: {}, bySource: {}, acted: br.liked || 0, note: 'browse (scheduler)' }); } catch { /* stats must never break a round */ }
        }
      } else {
        appendLog('browse round skipped: features.browse=false');
      }
      if (browseCfg(cfg).features.othersReply) {
        await othersReplyRound(page).catch((e) => appendLog('othersReply round failed: ' + e.message));
      } else {
        appendLog('othersReply round skipped: features.othersReply=false');
      }
      // The lane owns two independent switches (涨粉关注 / 回关蓝V); it runs
      // whenever EITHER is on. growthFollowRound() re-checks each switch
      // internally, so a disabled lane still short-circuits safely.
      if (browseCfg(cfg).features.follow !== false || browseCfg(cfg).features.followBack !== false) {
        await growthFollowRound(page).catch((e) => appendLog('growthFollow round failed: ' + e.message));
      } else {
        appendLog('growthFollow round skipped: features.follow=false and features.followBack=false');
      }
    }

    if (Date.now() - lastReplyScan > replyIntervalMs) {
      lastReplyScan = Date.now();
      const rr = await replyRound(page);
      saveState(stateFile, state);
      if (rr.acted) appendLog(`Reply round: ${rr.acted} handled.`);
    }

    // I2: never read X and publish in the same pass. If we just collected, this
    // pass is collection-only; publishing waits for the next pass.
    // T4: this is the I2 isolation wait, NOT a schedule interval — the gap
    // between rounds still comes from nextOffMinuteAt/nextAllowedAt below.
    // The wait only has to be long enough that this pass cannot publish; it is
    // NOT a cadence interval. Pinning it at MAX_WAIT_MS stalled publishing for
    // 5 thrown-away minutes after every collect (observed: 892s between posts).
    // A short isolation gap keeps I2 intact (collect still never publishes)
    // while letting the 1-minute cadence resume immediately after.
    if (collectedThisLoop) { await new Promise((r) => setTimeout(r, 15_000)); continue; }

    if (state.units >= (cfg.dailyTarget ?? 20)) {
      appendLog(`Daily target consumed (${state.units}).`);
      await new Promise((r) => setTimeout(r, MAX_WAIT_MS));
      continue;
    }
    if (Date.now() < (state.nextAllowedAt || 0)) {
      // T4: sleep exactly until nextAllowedAt (poll cap 60s) — no more
      // fixed 5-minute over-wait between rounds.
      const wait = Math.min(60_000, Math.max(1000, (state.nextAllowedAt || 0) - Date.now()));
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    let r = { ok: false };
    // Cadence is measured from the START of the round, not from the moment the
    // round finished. A publish round costs 25-40s of humanised typing and
    // navigation; measuring from "now" (after the round) doubled the real
    // interval, so a configured 1-minute gap produced a 2-minute cadence.
    const roundStartedAt = Date.now();
    try { r = await contentRound(page); }
    catch (e) {
      if (e.blocked) {
        appendLog(`Blocked during action: ${e.message}. Pausing globally; no auto-retry.`);
        pause(e.reason || e.message);
        await captureBlock(page, e.reason || e.message);
      } else {
        appendLog(`Action failed: ${e.message}`);
        await dismissComposer(page).catch(() => {});
      }
    }

    const remaining = Math.max(1, (cfg.dailyTarget ?? 20) - state.units);
    const { end = 24 } = cfg.activeHours || {};
    const hoursLeft = Math.max(1, end - chinaHour());
    const ideal = (hoursLeft * 60) / remaining;
    const jitter = cfg.jitter ?? { min: 0.7, max: 1.3 };
    // T2: when minGapMinutes is explicitly configured it IS the real minimum
    // gap — the spread is only a fallback when it is absent. A user-entered
    // 1 is never raised to the daily pace again.
    const spread = Math.round(rand(ideal * jitter.min, ideal * jitter.max));
    // T1 (round N): a configured [minGapMinutes, maxGapMinutes] window is drawn
    // fresh every round so "30-50 min" really is a random interval in that band.
    // Before this, minGapMinutes was a single fixed floor and only the <=120s
    // sub-minute jitter moved, so the ceiling never applied (30 -> 30-32min).
    const gapIsRandom = Number.isFinite(Number(cfg.maxGapMinutes))
      && Number(cfg.maxGapMinutes) > Number(cfg.minGapMinutes);
    const drawnGap = cfg.minGapMinutes != null ? drawGapMinutes(cfg.minGapMinutes, cfg.maxGapMinutes) : null;
    const gapMin = drawnGap != null ? drawnGap : (cfg.minGapMinutes != null ? cfg.minGapMinutes : Math.max(6, spread));
    // §9.2: land on an off-minute, never repeating the previous one, then add
    // sub-minute jitter so two runs never share an exact timestamp.
    const schedule = (cfg.schedule && typeof cfg.schedule === 'object') ? cfg.schedule : {};
    // Sub-minute jitter is configurable; default stays 45s so nothing changes
    // for existing setups. A tight value (e.g. 6) is what makes a 1-minute gap
    // actually land near 1 minute instead of 1m45s.
    const jitterSec = Number.isFinite(Number(schedule.jitterSeconds)) ? Math.max(0, Math.min(120, Number(schedule.jitterSeconds))) : 45;
    // T3: off-minute snapping with an upper cap (default 2 min); enabled by
    // config schedule.offMinutesOnly — when off it follows the plain gap.
    const planned = schedule.offMinutesOnly === false
      ? (() => {
          const base = roundStartedAt + gapMin * 60_000;
          // When a real ceiling is configured the fractional draw already gives
          // a sub-minute offset, so the extra jitter is skipped to keep the
          // interval strictly inside [min, max] instead of overshooting it.
          const extra = gapIsRandom ? 0 : Math.round(rand(0, jitterSec * 1000));
          const t = base + extra;
          return { at: t, minute: new Date(t).getMinutes(), snapped: false, snapMinutes: 0 };
        })()
      : nextOffMinuteAt(Date.now(), gapMin, state.lastOffMinute ?? null, { maxSnapMinutes: schedule.maxSnapMinutes });
    // T1: in a real-window draw the fractional minute already places the round
    // inside [min, max]; adding the legacy <=120s jitter on top would push a
    // 50-minute ceiling out to ~52 and break the configured band, so it is
    // suppressed exactly when the window is active.
    const jittered = gapIsRandom ? planned.at : planned.at + Math.round(rand(0, jitterSec * 1000));
    state.nextAllowedAt = jittered;
    state.lastOffMinute = planned.minute;
    saveState(stateFile, state);
    const label = r.dryRun ? 'DRYRUN' : r.drafted ? 'DRAFTED' : r.published ? 'PUBLISHED' : 'SKIP';
    appendLog(`Round ${label}. ${state.units}/${cfg.dailyTarget} today. Next at :${String(planned.minute).padStart(2, '0')} (+jitter).`);
  }
}

const isMain = process.argv[1] && /run\.mjs$/.test(process.argv[1]);
if (isMain) main().catch((e) => { appendLog(`FATAL: ${e.stack || e.message}`); process.exit(1); });
