// CLI entry: node src/cli.mjs <command>
//   status                      account + counters + queue summary
//   pool                        refresh AIHOT content pool
//   post                        publish one AIHOT post immediately
//   quote <url> <text>          quote a tweet with your text
//   reply <url> <text>          reply to a tweet / reply
//   scan-replies                list new replies to my posts
//   drafts                      list pending drafts (review mode queue)
//   approve <id>                publish a specific draft
//   approve-all                 publish every pending draft
//   reject <id>                 discard a draft
//   mode                        show current mode
//   mode auto|review            switch publishing mode
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { connect, workPage, closeBrowser } from './edge.mjs';
import { post, quote, reply, verify } from './xbot.mjs';
import { buildPost, buildQuoteComment, xOriginalOf } from './planner.mjs';
import { scanReplies, draftReplyFor } from './replies.mjs';
import { loadConfig, aihotGet } from './aihot.mjs';
import { parseAihotMarkdown } from './aihot-parse.mjs';
import { loadJson, saveJson, loadState, saveState, todayKey } from './store.mjs';
import { loadDrafts, removeDraft } from './drafts.mjs';

const cfg = loadConfig();
const cmd = process.argv[2];
const args = process.argv.slice(3);

function saveConfig(patch) {
  const next = { ...cfg, ...patch };
  saveJson(resolve('config.json'), next);
  return next;
}

async function withPage(fn) {
  const { browser, ctx } = await connect(cfg);
  const page = await workPage(ctx);
  try { return await fn(page); }
  finally { await closeBrowser(browser); }
}

function loadPool() {
  const f = resolve('queue/internal-links.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
}

if (cmd === 'status') {
  const state = loadState(resolve(cfg.stateFile), () => ({ posts: 0, quotes: 0, replies: 0, draftCount: 0, nextAllowedAt: 0 }));
  const pool = loadPool();
  const drafts = loadDrafts();
  const who = await withPage(async (page) => verify(page).catch((e) => 'ERR ' + e.message));
  console.log('account     :', who);
  console.log('mode        :', cfg.autoMode || 'review');
  console.log('date        :', todayKey());
  console.log('published   :', state.posts, '/', cfg.dailyTarget, '| auto-replies', state.replies || 0);
  console.log('drafts      :', drafts.length, 'pending');
  console.log('pool        :', pool.length, 'items |', pool.filter(xOriginalOf).length, 'with X originals');
} else if (cmd === 'drafts') {
  const drafts = loadDrafts();
  if (!drafts.length) { console.log('no pending drafts'); }
  for (const d of drafts) {
    console.log(`#${d.id} [${d.kind}] ${d.createdAt}`);
    if (d.title) console.log(`    topic : ${d.title}`);
    if (d.author) console.log(`    to    : @${d.author} — "${(d.originalText || '').slice(0, 60)}"`);
    if (d.targetUrl) console.log(`    target: ${d.targetUrl}`);
    console.log(`    text  : ${(d.text || '').replace(/\n/g, '\n            ')}`);
    console.log();
  }
} else if (cmd === 'approve' || cmd === 'approve-all') {
  const drafts = loadDrafts();
  const targets = cmd === 'approve-all' ? drafts : drafts.filter((d) => String(d.id) === String(args[0]));
  if (!targets.length) { console.log('nothing to approve'); process.exit(1); }
  await withPage(async (page) => {
    for (const d of targets) {
      try {
        if (d.kind === 'reply') await reply(page, d.targetUrl, d.text);
        else if (d.kind === 'quote') await quote(page, d.targetUrl, d.text);
        else await post(page, d.text);
        removeDraft(d.id);
        console.log(`published draft #${d.id} (${d.kind})`);
      } catch (e) {
        console.log(`draft #${d.id} failed: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  });
} else if (cmd === 'reject') {
  const entry = removeDraft(args[0]);
  console.log(entry ? `discarded draft #${entry.id}` : `draft #${args[0]} not found`);
} else if (cmd === 'mode') {
  if (!args[0]) { console.log('current mode:', cfg.autoMode || 'review'); }
  else {
    if (!['auto', 'review'].includes(args[0])) { console.log('usage: mode auto|review'); process.exit(1); }
    saveConfig({ autoMode: args[0] });
    console.log('mode set to:', args[0]);
  }
} else if (cmd === 'scan-replies') {
  await withPage(async (page) => {
    const replies = await scanReplies(page, { maxAgeHours: cfg.replyScan?.maxAgeHours ?? 48 });
    for (const r of replies) {
      console.log(`- @${r.author} | ${r.when}`);
      console.log(`  "${r.text}"`);
      console.log(`  ${r.url}`);
      console.log(`  draft: "${draftReplyFor(r)}"`);
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
  const pool = loadPool();
  const item = pool[Math.floor(Math.random() * pool.length)];
  await withPage(async (page) => { await post(page, buildPost(item)); });
  console.log('posted:', item.title);
} else if (cmd === 'quote') {
  const [url, ...rest] = args;
  await withPage(async (page) => { await quote(page, url, rest.join(' ')); });
} else if (cmd === 'reply') {
  const [url, ...rest] = args;
  await withPage(async (page) => { await reply(page, url, rest.join(' ')); });
} else {
  console.log(`Usage: node src/cli.mjs <command>
  status | pool | drafts | scan-replies
  post | quote <url> <text> | reply <url> <text>
  approve <id> | approve-all | reject <id>
  mode [auto|review]`);
}
process.exit(0);
