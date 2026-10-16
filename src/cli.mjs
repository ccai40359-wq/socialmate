// CLI entry: node src/cli.mjs <command>
// SocialMate's command-line face. The desktop app uses the same modules.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { connect, workPage, closeBrowser } from './edge.mjs';
import { post, quote, reply, verify, follow } from './xbot.mjs';
import { buildPost, buildQuoteComment, xOriginalOf } from './planner.mjs';
import { scanReplies, draftReplyFor, selectOthersReplyCandidates, draftOthersReplyFor } from './replies.mjs';
import { loadConfig, aihotGet } from './aihot.mjs';
import { parseAihotMarkdown } from './aihot-parse.mjs';
import { loadJson, saveJson, loadState, todayKey } from './store.mjs';
import { loadDrafts, removeDraft, addDraft } from './drafts.mjs';
import { checkPost, remember, hollowQuote, othersReplyCountForAuthorToday, checkKindBudget } from './gate.mjs';
import { appendLog } from './log.mjs';
import { recordFeedback } from './feedback.mjs';
import { generatePostText, generateReply } from './voice.mjs';

const cfg = loadConfig();
const state = loadState(resolve(cfg.stateFile || 'state.json'), () => ({ units: 0, postsPublished: 0, quotesPublished: 0, repliesPublished: 0, draftsToday: 0 }));
const cmd = process.argv[2];
const args = process.argv.slice(3);

let control = null;
try { control = await import('./control.mjs'); } catch { control = null; }

function readControl() {
  if (control?.readControl) { try { return control.readControl(); } catch {} }
  try { return JSON.parse(readFileSync(resolve('control.json'), 'utf8')); }
  catch { return { paused: false, mode: cfg.autoMode || 'review' }; }
}
function writeControl(patch) {
  if (control?.writeControl) { try { return control.writeControl(patch); } catch {} }
  const cur = readControl();
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  saveJson(resolve('control.json'), next);
  return next;
}
function saveConfig(patch) {
  const next = { ...cfg, ...patch };
  saveJson(resolve('config.json'), next);
  return next;
}
async function withPage(fn) {
  const { browser, ctx } = await connect(cfg);
  const page = await workPage(ctx);
  try { return await fn(page); } finally { await closeBrowser(browser); }
}
function loadPool() {
  const f = resolve('queue/internal-links.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
}

// Publish gate, mirrored from run.mjs so both faces behave identically.
// In review mode a manual post/quote/reply becomes a draft instead of going
// out — same as the daemon — unless --publish is passed explicitly.
const PUBLISH_FLAG = args.includes('--publish');
// Read the value that follows a named flag (--media <path> / --text <lit>).
function flagValue(name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) return null;
  return v;
}
function cliGate() {
  const c = readControl();
  const want = c.mode || cfg.autoMode || 'review';
  const requested = want === 'auto';
  const publish = requested && PUBLISH_FLAG;
  return { publish, want, reason: !requested ? 'mode-review' : (publish ? 'auto+explicit-flag' : 'auto-but-no-explicit-flag') };
}

// Queue an action instead of performing it, and say so on stdout.
function queueInstead(kind, targetUrl, text, extra = {}) {
  const d = addDraft({ kind, targetUrl, text, ...extra });
  console.log(`[review] queued draft #${d.id} (${kind}). Nothing was published.`);
  console.log(`         text: ${text.replace(/\n/g, ' ')}`);
  console.log('         approve with: node src/cli.mjs approve ' + d.id);
  return d;
}

async function main() {
if (cmd === 'status') {
  const c = readControl();
  const drafts = loadDrafts();
  const pool = loadPool();
  const who = await withPage((page) => verify(page).catch((e) => 'ERR ' + e.message));
  console.log('account   :', who);
  console.log('mode      :', c.mode, '| paused:', !!c.paused);
  // The live switch above comes from control.json. The stored safety baseline
  // (config.autoMode) is a separate thing and must always be visible here: it
  // is what survives a control.json reset, and an explicit --publish is still
  // required on every invocation regardless of either value.
  console.log('baseline  :', cfg.autoMode || 'review', '(config.autoMode; every call still needs --publish)');
  console.log('date      :', todayKey());
  console.log('today     :', state.units, '/', cfg.dailyTarget, '| posted', state.postsPublished, 'quoted', state.quotesPublished, 'replied', state.repliesPublished, 'drafts', state.draftsToday);
  console.log('pending   :', drafts.length, 'drafts');
  console.log('pool      :', pool.length, 'items |', pool.filter(xOriginalOf).length, 'with X originals');
} else if (cmd === 'pause' || cmd === 'resume') {
  const r = writeControl({ paused: cmd === 'pause' });
  console.log('paused =', r.paused);
} else if (cmd === 'mode') {
  if (!args[0]) console.log('current mode:', readControl().mode);
  else if (!['auto', 'review'].includes(args[0])) { console.log('usage: mode auto|review'); return 1; }
  else { writeControl({ mode: args[0] }); saveConfig({ autoMode: args[0] }); console.log('mode =', args[0]); }
} else if (cmd === 'drafts') {
  const drafts = loadDrafts();
  if (!drafts.length) console.log('no pending drafts');
  for (const d of drafts) {
    console.log(`#${d.id} [${d.kind}] ${d.createdAt}${d.score ? ` score=${d.score}` : ''}`);
    if (d.title) console.log(`    topic : ${d.title}`);
    if (d.author) console.log(`    to    : @${d.author} — "${(d.originalText || '').slice(0, 60)}"`);
    if (d.targetUrl) console.log(`    target: ${d.targetUrl}`);
    console.log(`    text  : ${(d.text || '').replace(/\n/g, '\n            ')}`);
  }
} else if (cmd === 'approve' || cmd === 'approve-all') {
  const drafts = loadDrafts();
  const targets = cmd === 'approve-all' ? drafts : drafts.filter((d) => String(d.id) === String(args[0]));
  if (!targets.length) { console.log('nothing to approve'); return 1; }
  await withPage(async (page) => {
    for (const d of targets) {
      try {
        // Approval is an explicit human act, so it publishes. But the text may
        // have been edited since it was queued, so re-run the gate first.
        // A growth-follow draft is a FOLLOW plus a COMMENT, not a post, and
        // its text may be legitimately empty (follow-only target). Gating it
        // with checkPost('') would die as too-short:0, and — now that the
        // draft carries real comment text — falling through to post() would
        // publish the comment as a standalone tweet. Both are wrong, so this
        // kind is budgeted as a follow and then replies to commentUrl.
        const isFollowBack = d.lane === 'followBack' || d.kind === 'followBack';
        const isFollow = d.kind === 'follow' || d.kind === 'growthFollow' || isFollowBack;
        if (isFollow) {
          // The lane can be switched off between enqueue and approval, exactly
          // like server.mjs re-checks it. Approving a draft must not be a
          // backdoor around the feature switch.
          const laneOff = isFollowBack
            ? (cfg.features && cfg.features.followBack === false)
            : (cfg.features && cfg.features.follow === false);
          if (laneOff) { console.log(`draft #${d.id} blocked: features.${isFollowBack ? 'followBack' : 'follow'}=false`); continue; }
          const budget = checkKindBudget({ kind: isFollowBack ? 'followBack' : 'follow', state, cfg });
          if (!budget.ok) { console.log(`draft #${d.id} blocked by gate: ${budget.reasons.join(',')}`); continue; }
          const fr = await follow(page, d.targetUrl);
          if (!fr || fr.ok !== true) { console.log(`draft #${d.id} follow failed: ${(fr && fr.reason) || 'failed'}`); continue; }
          if (isFollowBack) { state.followBacksPublished = (state.followBacksPublished || 0) + 1; state.lastFollowBackAt = Date.now(); }
          else { state.followsPublished = (state.followsPublished || 0) + 1; state.lastFollowAt = Date.now(); }
          try { saveJson(resolve(cfg.stateFile || 'state.json'), state); } catch (e) { appendLog('state: write failed ' + e.message); }
          // The comment half. Same gates as the auto path; a comment failure
          // never rolls back the follow that already landed.
          const commentText = String(d.text || '').trim();
          const commentUrl = String(d.commentUrl || '').trim();
          if (commentText && commentUrl) {
            const cBudget = checkKindBudget({ kind: 'othersReply', state, cfg });
            const cVerdict = cBudget.ok ? checkPost({ text: commentText, cfg, kind: 'othersReply', state }) : cBudget;
            const isHollow = hollowQuote(commentText, d.sourceText || '');
            if (cVerdict.ok && !isHollow) {
              // The comment is its own write, and its failure must not undo the
              // follow that already landed: without this catch a reply() throw
              // would skip removeDraft() below and leave the draft queued, so
              // approving it again would follow the same account twice.
              try {
                await reply(page, commentUrl, commentText);
                state.othersRepliesPublished = (state.othersRepliesPublished || 0) + 1;
                state.lastOthersReplyAt = Date.now();
                try { saveJson(resolve(cfg.stateFile || 'state.json'), state); } catch (e) { appendLog('state: write failed ' + e.message); }
                try { remember({ id: 'gr' + d.id, text: commentText, kind: 'othersReply', url: commentUrl }); } catch (e) { appendLog('comment remember failed: ' + e.message); }
              } catch (e) {
                console.log(`draft #${d.id} comment failed (no rollback): ${e.message}`);
              }
            } else {
              console.log(`draft #${d.id} comment skipped by gate: ${(cVerdict.reasons || []).join(',')}${isHollow ? ',hollow' : ''}`);
            }
          }
          removeDraft(d.id);
          remember({ id: (isFollowBack ? 'fb' : 'f') + (d.author || d.id), text: (isFollowBack ? '回关了 @' : '关注了 @') + (d.author || ''), kind: (isFollowBack ? 'followBack' : 'follow'), url: d.targetUrl });
          console.log(`published draft #${d.id} (${isFollowBack ? 'followBack' : 'follow'})`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        const verdict = checkPost({ text: d.text, cfg, kind: d.kind, state });
        if (!verdict.ok) { console.log(`draft #${d.id} blocked by gate: ${verdict.reasons.join(',')}`); continue; }
        if (d.kind === 'reply') await reply(page, d.targetUrl, d.text);
        else if (d.kind === 'quote') await quote(page, d.targetUrl, d.text);
        else await post(page, d.text, d.mediaPath || undefined);
        removeDraft(d.id);
        remember({ id: 'd' + d.id, text: d.text, kind: d.kind, url: d.targetUrl });
        console.log(`published draft #${d.id} (${d.kind})`);
      } catch (e) { console.log(`draft #${d.id} failed: ${e.message}`); }
      await new Promise((r) => setTimeout(r, 5000));
    }
  });
} else if (cmd === 'reject') {
  const draft = loadDrafts().find((d) => String(d.id) === String(args[0]));
  if (draft) {
    try { recordFeedback({ action: 'reject', kind: draft.kind, text: draft.text, targetUrl: draft.targetUrl, originalText: draft.originalText, reason: args[1] || undefined }); } catch (e) { appendLog('feedback: write failed ' + e.message); }
  }
  const e = removeDraft(args[0]);
  console.log(e ? `discarded draft #${e.id}` : `draft #${args[0]} not found`);
} else if (cmd === 'scan-replies') {
  await withPage(async (page) => {
    const replies = await scanReplies(page, { maxAgeHours: cfg.replyScan?.maxAgeHours ?? 48 });
    for (const r of replies) {
      let draft = await draftReplyFor(r);
      if (!draft) draft = await generateReply(r);
      const mark = draft ? '[voice]' : '[UNAVAILABLE: no reply generated]';
      console.log(`- @${r.author} | ${r.when}\n  "${r.text}"\n  ${r.url}\n  draft: "${draft || ''}" ${mark}`);
    }
    console.log(`total: ${replies.length}`);
  });
} else if (cmd === 'pool') {
  const paths = ['/latest?limit=30', '/latest?limit=30&mode=all', '/latest?window=7d&limit=30'];
  const byUrl = new Map(loadPool().map((x) => [x.url, x]));
  for (const p of paths) {
    try {
      for (const it of parseAihotMarkdown(await aihotGet(cfg, p))) byUrl.set(it.url, it);
      await new Promise((r) => setTimeout(r, 500));
    } catch (e) { console.log('skip', p, e.message); }
  }
  const all = [...byUrl.values()];
  saveJson(resolve('queue/internal-links.json'), all);
  console.log('pool:', all.length, 'items;', all.filter(xOriginalOf).length, 'with X originals');
} else if (cmd === 'post') {
  const gate = cliGate();
  const mediaRequested = args.includes('--media');
  const mediaPath = flagValue('--media');
  if (mediaRequested && !mediaPath) { console.log('usage: post [--text "<literal>"] [--media <path>] [--publish] (--media needs a path)'); return 1; }
  const literalText = flagValue('--text');
  const verbatim = literalText !== null;
  const pool = loadPool();
  // The default behaviour is unchanged: pull a random pool item and generate
  // its body. An explicit --text replaces the whole body AND drops the pool
  // item entirely, so no unrelated title is attached to the literal text.
  const item = verbatim ? null : pool[Math.floor(Math.random() * pool.length)];
  if (!item && !verbatim) { console.log('pool is empty; run: node src/cli.mjs pool'); return 1; }
  const voiced = !verbatim ? await generatePostText(item) : null;
  const text = verbatim ? literalText : buildPost(item, voiced);
  const verdict = checkPost({ text, cfg, kind: 'post', state });
  if (!verdict.ok) { console.log('gate rejected (' + verdict.reasons.join(',') + '):', text.slice(0, 80)); return 1; }
  if (!gate.publish) {
    const extra = { title: item ? (item.title || '') : '' };
    if (mediaPath) extra.mediaPath = mediaPath;
    queueInstead('post', null, text, extra);
    return 0;
  }
  await withPage((page) => post(page, text, mediaPath || undefined));
  console.log('posted:', verbatim ? '(literal text)' : (item ? item.title : ''), voiced ? `[voice: ${voiced}]` : '[template]', mediaPath ? '[media: yes]' : '');
} else if (cmd === 'quote') {
  const gate = cliGate();
  const [url, ...rest] = args;
  const text = rest.join(' ');
  const verdict = checkPost({ text, cfg, kind: 'quote', state });
  if (!verdict.ok) { console.log('gate rejected (' + verdict.reasons.join(',') + ')'); return 1; }
  if (!gate.publish) { queueInstead('quote', url, text); return 0; }
  await withPage((page) => quote(page, url, text));
} else if (cmd === 'reply') {
  const gate = cliGate();
  const [url, ...rest] = args;
  const text = rest.join(' ');
  const verdict = checkPost({ text, cfg, kind: 'reply', state });
  if (!verdict.ok) { console.log('gate rejected (' + verdict.reasons.join(',') + ')'); return 1; }
  if (!gate.publish) { queueInstead('reply', url, text); return 0; }
  await withPage((page) => reply(page, url, text));
} else if (cmd === 'others-reply') {
  const gate = cliGate();
  const once = args.includes('--once');
  const dry = args.includes('--dry-run');
  // Drafting/rehearsal is the only behaviour: this command NEVER publishes.
  // autoMode stays review in this checkout; --publish is rejected outright so
  // a future flag change cannot make an audit command destructive by accident.
  if (args.includes('--publish')) {
    console.log('others-reply is a collect/draft command; publishing is not allowed here.');
    return 1;
  }
  const seenOthersFile = resolve(cfg.othersReplySeenFile || 'queue/others-reply-seen.json');
  const seenOthers = loadJson(seenOthersFile, { ids: [] });
  const seenOthersSet = new Set(seenOthers.ids || []);
  const pool = loadJson(resolve('queue/candidates.json'), []);
  const candidates = selectOthersReplyCandidates(pool, { minLikes: cfg.perceive?.minLikes ?? 10, myHandle: cfg.myHandle || '' });
  const maxPerRound = cfg.othersReply?.maxPerRound ?? 3;
  const budget = checkKindBudget({ kind: 'othersReply', state, cfg });
  if (!budget.ok) { console.log('others-reply skipped: ' + budget.reasons.join(',')); return 0; }
  let checked = 0;
  let drafted = 0;
  for (const cand of candidates) {
    if (checked >= maxPerRound) break;
    const tweetId = String(cand.tweetId || (cand.url || '').match(/status\/(\d+)/)?.[1] || '');
    if (!tweetId || seenOthersSet.has(tweetId)) continue;
    const author = String(cand.author || '').replace(/^@/, '').toLowerCase();
    if (!author || othersReplyCountForAuthorToday(state, author) > 0) continue;
    checked++;
    const text = await draftOthersReplyFor(cand);
    if (!text) { console.log('  skip (no voice draft): @' + author); continue; }
    const verdict = checkPost({ text, cfg, kind: 'othersReply', state });
    if (!verdict.ok) { console.log('  skip (gate ' + verdict.reasons.join(',') + '): @' + author); continue; }
    if (hollowQuote(text, String(cand.text || ''))) { console.log('  skip (hollow quote): @' + author); continue; }
    const url = cand.url || '';
    console.log('DRAFT othersReply -> @' + author + ' :: ' + text.replace(/\n/g, ' '));
    console.log('  ' + url);
    if (!dry) {
      const d = addDraft({ kind: 'othersReply', targetUrl: url, text, author, originalText: cand.text || '', tweetId });
      seenOthersSet.add(tweetId);
      drafted++;
      console.log('  queued draft #' + d.id + ' (nothing published)');
    } else {
      console.log('  dry-run: draft not queued');
    }
  }
  if (once) {
    seenOthers.ids = [...seenOthersSet].slice(-800);
    if (!dry) saveJson(seenOthersFile, seenOthers);
  }
  console.log('others-reply: checked=' + checked + ' drafted=' + drafted + ' (mode review, nothing published)');
} else {
  console.log(`SocialMate CLI
  status                    账号、模式、今日计数、草稿数、内容池
  pause | resume            全局暂停/恢复
  mode [auto|review]        查看/切换发布模式
  drafts                    查看待审草稿
  approve <id> | approve-all
  reject <id>
  scan-replies              扫描自己帖子的新评论并给建议回复
  pool                      刷新 AIHOT 内容池
  post | quote <url> <text> | reply <url> <text>
  others-reply [--once] [--dry-run]    从 x-home/x-following 候选池采他人帖草稿（绝不发布）

  node src/run.mjs          启动调度器（守护进程）
  npm run app               启动桌面应用`);
}
return 0;
}

main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exitCode = 1; });
