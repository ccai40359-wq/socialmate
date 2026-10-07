// Scheduler: posts + quotes + own-post reply handling.
// config.autoMode:
//   "review" (default) - content and replies land in queue/drafts.json for approval
//   "auto"             - publish directly
// Content comes from AIHOT; display links always point at the ORIGINAL source.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { connect, workPage, closeBrowser } from './edge.mjs';
import { post, quote, verify } from './xbot.mjs';
import { buildPost, buildQuoteComment, keywordsFor, xOriginalOf } from './planner.mjs';
import { scanReplies, draftReplyFor } from './replies.mjs';
import { findTweetByQuery } from './xbot.mjs';
import { loadConfig, aihotGet } from './aihot.mjs';
import { parseAihotMarkdown } from './aihot-parse.mjs';
import { appendLog } from './log.mjs';
import { loadJson, saveJson, loadState, saveState, ensureDir } from './store.mjs';
import { addDraft } from './drafts.mjs';
import { generatePostText, generateQuoteComment, generateReply } from './voice.mjs';

const cfg = loadConfig();
const MODE = cfg.autoMode || 'review';
const stateFile = resolve(cfg.stateFile);
const seenFile = resolve(cfg.seenFile);
const seenRepliesFile = resolve(cfg.seenRepliesFile || 'queue/seen-replies.json');
const poolFile = resolve('queue/internal-links.json');

ensureDir('queue');
ensureDir('shots');

const state = loadState(stateFile, () => ({ units: 0, postsPublished: 0, quotesPublished: 0, repliesPublished: 0, draftsToday: 0, nextAllowedAt: 0 }));

const seen = loadJson(seenFile, { topics: [] });
const seenSet = new Set(seen.topics);
const seenReplies = loadJson(seenRepliesFile, { ids: [] });
const seenReplySet = new Set(seenReplies.ids);

function rand(a, b) { return Math.random() * (b - a) + a; }
function randInt(a, b) { return Math.floor(rand(a, b + 1)); }
function chinaHour() {
  return Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit' }));
}
function inActiveHours() {
  const h = chinaHour();
  return h >= cfg.activeHours.start && h < cfg.activeHours.end;
}
function loadPool() {
  return existsSync(poolFile) ? JSON.parse(readFileSync(poolFile, 'utf8')) : [];
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
  appendLog(`Pool refreshed: ${all.length} items`);
  return all;
}
function nextTopic(pool) {
  const fresh = pool.filter((x) => !seenSet.has(x.url));
  const candidates = fresh.length ? fresh : pool;
  if (!candidates.length) return null;
  const item = candidates[randInt(0, candidates.length - 1)];
  seenSet.add(item.url);
  seen.topics = [...seenSet].slice(-500);
  saveJson(seenFile, seen);
  return item;
}
async function pickQuoteTarget(page, item) {
  const native = xOriginalOf(item);
  if (native) return { url: native, how: 'aihot-original' };
  for (const kw of keywordsFor(item, cfg.quoteSearch.maxKeywords)) {
    try {
      const t = await findTweetByQuery(page, kw, { minLikes: cfg.quoteSearch.minLikes, maxScrolls: cfg.quoteSearch.maxScrolls });
      if (t) return { url: t, how: `search:${kw}` };
    } catch (e) { appendLog(`quote search "${kw}" failed: ${e.message}`); }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return null;
}

export async function contentRound(page, { mode = MODE } = {}) {
  let pool = loadPool();
  if (pool.length < 5) pool = await refreshPool();
  const item = nextTopic(pool);
  if (!item) { appendLog('No topics available.'); return { ok: false }; }

  const asQuote = Math.random() < cfg.quoteRatio;
  const useVoice = cfg.voiceEnabled !== false;

  if (mode === 'review') {
    if (asQuote) {
      const target = await pickQuoteTarget(page, item);
      if (!target) return { ok: false };
      const drafted = useVoice ? await generateQuoteComment(item) : null;
      const d = addDraft({ kind: 'quote', targetUrl: target.url, text: buildQuoteComment(item, drafted), title: item.title, source: target.how, voiced: !!drafted });
      appendLog(`DRAFT quote #${d.id} queued (${target.how})${drafted ? ' [voice]' : ''} :: ${item.title.slice(0, 50)}`);
    } else {
      const drafted = useVoice ? await generatePostText(item) : null;
      const d = addDraft({ kind: 'post', text: buildPost(item, drafted), title: item.title, voiced: !!drafted });
      appendLog(`DRAFT post #${d.id} queued${drafted ? ' [voice]' : ''} :: ${item.title.slice(0, 50)}`);
    }
    state.draftsToday++;
    state.units++;
    return { ok: true, drafted: true };
  }

  if (asQuote) {
    const target = await pickQuoteTarget(page, item);
    if (!target) return { ok: false };
    const drafted = useVoice ? await generateQuoteComment(item) : null;
    await quote(page, target.url, buildQuoteComment(item, drafted));
    appendLog(`Quote source: ${target.how}${drafted ? ' [voice]' : ''}`);
    state.quotesPublished++;
    state.units++;
    return { ok: true };
  }
  const drafted = useVoice ? await generatePostText(item) : null;
  await post(page, buildPost(item, drafted));
  state.postsPublished++;
  state.units++;
  return { ok: true };
}

export async function replyRound(page, { mode = MODE } = {}) {
  let replies;
  try {
    replies = await scanReplies(page, { maxAgeHours: cfg.replyScan?.maxAgeHours ?? 48 });
  } catch (e) {
    appendLog(`reply scan failed: ${e.message}`);
    return { checked: 0, acted: 0 };
  }
  const fresh = replies.filter((r) => !seenReplySet.has(r.tweetId));
  appendLog(`Replies found: ${replies.length}, new: ${fresh.length}`);
  if (!fresh.length) return { checked: replies.length, acted: 0 };

  const limit = cfg.replyScan?.maxPerRound ?? 3;
  let acted = 0;
  for (const r of fresh.slice(0, limit)) {
    let text = draftReplyFor(r);
    if (cfg.voiceEnabled !== false) {
      const voiced = await generateReply(r);
      if (voiced) text = voiced;
    }
    if (mode === 'review') {
      const d = addDraft({ kind: 'reply', targetUrl: r.url, text, author: r.author, originalText: r.text, tweetId: r.tweetId });
      appendLog(`DRAFT reply #${d.id} to @${r.author} :: "${r.text.slice(0, 40)}" -> "${text.slice(0, 40)}"`);
      state.draftsToday++;
    } else {
      const { reply } = await import('./xbot.mjs');
      try {
        await reply(page, r.url, text);
        state.repliesPublished++;
      } catch (e) {
        appendLog(`reply to ${r.url} failed: ${e.message}`);
        continue;
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

async function main() {
  const { browser, ctx } = await connect(cfg);
  const page = await workPage(ctx);
  const who = await verify(page).catch(() => 'unknown');
  appendLog(`Signed in as: ${who} | mode=${MODE} | ${state.date}`);

  if (process.argv.includes('--once')) {
    const r = await contentRound(page);
    saveState(stateFile, state);
    appendLog(`--once -> ${r.ok ? (r.drafted ? 'drafted' : 'published') : 'skipped'}`);
    await closeBrowser(browser);
    return;
  }

  appendLog(`Daemon start. ${cfg.dailyTarget}/day, quoteRatio=${cfg.quoteRatio}, mode=${MODE}, active ${cfg.activeHours.start}-${cfg.activeHours.end}`);

  let lastReplyScan = 0;
  const replyIntervalMs = (cfg.replyScan?.intervalMinutes ?? 45) * 60_000;

  while (true) {
    if (!inActiveHours()) { await new Promise((r) => setTimeout(r, 15 * 60_000)); continue; }

    if (Date.now() - lastReplyScan > replyIntervalMs) {
      lastReplyScan = Date.now();
      const rr = await replyRound(page);
      saveState(stateFile, state);
      if (rr.acted > 0) appendLog(`Reply round: ${rr.acted} handled (${MODE}).`);
    }

    if (state.units >= cfg.dailyTarget) {
      appendLog(`Daily target consumed (${state.units}/${cfg.dailyTarget}; published ${state.postsPublished + state.quotesPublished}, drafts ${state.draftsToday}).`);
      await new Promise((r) => setTimeout(r, 20 * 60_000));
      continue;
    }
    if (Date.now() < state.nextAllowedAt) { await new Promise((r) => setTimeout(r, 5 * 60_000)); continue; }

    let r = { ok: false };
    try { r = await contentRound(page); }
    catch (e) { appendLog(`Action failed: ${e.message}`); }

    const remaining = Math.max(1, cfg.dailyTarget - state.units);
    const hoursLeft = Math.max(1, cfg.activeHours.end - chinaHour());
    const ideal = (hoursLeft * 60) / remaining;
    const gapMin = Math.max(6, Math.round(rand(ideal * 0.7, ideal * 1.3)));
    state.nextAllowedAt = Date.now() + gapMin * 60_000;
    saveState(stateFile, state);
    appendLog(`Round ${r.ok ? (r.drafted ? 'DRAFTED' : 'PUBLISHED') : 'SKIP'}. Today ${state.units}/${cfg.dailyTarget}. Next ~${gapMin} min.`);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]).endsWith('run.mjs');
if (isMain) main().catch((e) => { appendLog(`FATAL: ${e.stack || e.message}`); process.exit(1); });
