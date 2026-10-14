// Local control server for the SocialMate desktop app.
// Binds 127.0.0.1 only. Serves the renderer and a small JSON API over the
// same modules the CLI uses — one brain, two faces.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, extname, join, normalize, relative, isAbsolute } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { appendLog } from './log.mjs';
import { loadConfig } from './aihot.mjs';
import { loadDrafts, removeDraft, saveDrafts } from './drafts.mjs';
import { loadPending, freshPending } from './publish-queue.mjs';
import { readControl, writeControl } from './control.mjs';
import { loadState, saveJson } from './store.mjs';
import { recordFeedback } from './feedback.mjs';
import { readAccount, readAvatar } from './account.mjs';
import { summarize, describeNow } from './activity.mjs';
import { loadStatsRing, todayStats as todayStatsAgg } from './store.mjs';

const PORT = Number(process.env.PORT || 4173);
const HOST = '127.0.0.1';
// Runtime data root: packaged builds run with cwd = userData (set by
// app/main.mjs), but env is the explicit contract for child processes.
const ROOT = process.env.SOCIALMATE_DATA_DIR || process.cwd();
// Renderer lives inside the asar in packaged builds; never resolve it from
// the data root (which is where cwd points in a packaged build).
const RENDERER = process.env.SOCIALMATE_RENDERER || resolve(ROOT, 'app', 'renderer');
// Packaged builds hand this over from app/main.mjs so the daemon can respawn
// itself in node mode without depending on cwd.
const CODE_ROOT = process.env.SOCIALMATE_CODE_ROOT || null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

let daemonChild = null;

// ---- helpers -----------------------------------------------------------
function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolvePromise) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolvePromise({});
      try { resolvePromise(JSON.parse(data)); } catch { resolvePromise(null); }
    });
  });
}

function readJsonSafe(file, fallback) {
  try { return JSON.parse(readFileSync(resolve(ROOT, file), 'utf8')); }
  catch { return fallback; }
}

function configPath() { return resolve(ROOT, 'config.json'); }
function providerPath() { return resolve(ROOT, 'provider.json'); }

// Only these keys may be written through the API — never arbitrary fields.
const CONFIG_WHITELIST = ['dailyTarget', 'quoteRatio', 'activeHours', 'autoMode', 'voiceEnabled',
  'voiceModel', 'cheapModel', 'replyScan', 'humanize', 'safety', 'gate', 'topicSeeds', 'minGapMinutes', 'maxGapMinutes', 'othersReply', 'features', 'browse', 'laneRules', 'schedule', 'topicPostRequiresSource'];

function clampNumber(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, lo), hi);
}

// Config writes reject out-of-range numbers instead of silently clamping:
// the caller should learn its value was wrong, not get a different one back.
function strictNumber(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) return null;
  return n;
}

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function daemonRunning() {
  if (daemonChild && daemonChild.exitCode === null && !daemonChild.killed) return true;
  const pidFile = resolve(ROOT, 'run.pid');
  if (!existsSync(pidFile)) return false;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function startDaemon(opts = {}) {
  if (daemonRunning()) return { ok: true, already: true };
  const extra = opts.publish === true ? ['--publish'] : [];
  let scriptArgs;
  let spawnCwd = ROOT;
  const env = { ...process.env };
  if (CODE_ROOT) {
    // Packaged: process.execPath is electron.exe, so the daemon must be
    // respawned in node mode, with the module inside the asar and the data
    // root as its writable cwd. Everything it writes (queue/**, shots/**,
    // state.json, control.json, log.txt, feedback, history, ...) resolves
    // under the data root because modules resolve relative paths against
    // process.cwd().
    scriptArgs = [resolve(CODE_ROOT, 'src/run.mjs'), ...extra];
    spawnCwd = ROOT;
    env.ELECTRON_RUN_AS_NODE = '1';
  } else {
    // Dev mode: plain `node src/run.mjs` from the repo root, unchanged.
    scriptArgs = ['src/run.mjs', ...extra];
  }
  const child = spawn(process.execPath, scriptArgs, { cwd: spawnCwd, env, detached: false, stdio: 'ignore' });
  daemonChild = child;
  try { writeFileSync(resolve(ROOT, 'run.pid'), String(child.pid), 'utf8'); } catch {}
  appendLog('server: daemon started pid=' + child.pid + (opts.publish === true ? ' publish=--publish' : ' publish=no'));
  return { ok: true, pid: child.pid };
}

function stopDaemon() {
  const pidFile = resolve(ROOT, 'run.pid');
  let pid = daemonChild?.pid;
  if (!pid && existsSync(pidFile)) pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (!pid) return { ok: true, already: true };
  try {
    // Synchronous on Windows: taskkill can take a couple of seconds under
    // load, and callers immediately assert the process is gone. Returning
    // before the tree is dead made 'stop' a lie.
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGTERM');
  } catch (e) {
    appendLog('server: stop daemon failed ' + e.message);
    return { ok: false, error: e.message };
  }
  daemonChild = null;
  try { writeFileSync(pidFile, '', 'utf8'); } catch {}
  appendLog('server: daemon stopped pid=' + pid);
  return { ok: true, pid };
}

// ---- API ---------------------------------------------------------------
async function api(req, res, url) {
  const p = url.pathname;
  const cfg = loadConfig();

  if (req.method === 'GET' && p === '/api/status') {
    const ctrl = readControl();
    const state = loadState(resolve(ROOT, cfg.stateFile || 'state.json'), () => ({
      units: 0, postsPublished: 0, quotesPublished: 0, repliesPublished: 0, draftsToday: 0, nextAllowedAt: 0,
    }));
    const pool = readJsonSafe('queue/internal-links.json', []);
    const drafts = loadDrafts();
    const poolWithX = pool.filter((x) => x.originalUrl && /(?:^https?:\/\/)(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/.test(x.originalUrl)).length;
    return json(res, 200, {
      ok: true,
      account: (await readAccount(cfg)).account,
      mode: ctrl.mode || cfg.autoMode || 'review',
      paused: !!ctrl.paused,
      pauseReason: ctrl.pauseReason || null,
      today: {
        units: state.units, postsPublished: state.postsPublished, quotesPublished: state.quotesPublished,
        repliesPublished: state.repliesPublished, draftsToday: state.draftsToday,
        followsPublished: state.followsPublished || 0, lastFollowAt: state.lastFollowAt || 0,
        // 互关评论区互动 / 回关 are their own lanes; without these the dashboard
        // showed 0 even right after 5 real comments went out.
        othersRepliesPublished: state.othersRepliesPublished || 0, lastOthersReplyAt: state.lastOthersReplyAt || 0,
        followBacksPublished: state.followBacksPublished || 0, lastFollowBackAt: state.lastFollowBackAt || 0,
      },
      dailyTarget: cfg.dailyTarget ?? 20,
      quoteRatio: cfg.quoteRatio ?? 0.4,
      minGapMinutes: cfg.minGapMinutes ?? 60,
      pool: { total: pool.length, withXOriginal: poolWithX },
      drafts: { pending: drafts.length },
      publishing: freshPending(loadPending()),
      daemon: { running: daemonRunning() },
      nextAllowedAt: state.nextAllowedAt || 0,
    });
  }

  if (req.method === 'GET' && p === '/api/avatar') {
    const av = await readAvatar(cfg);
    return json(res, 200, { ok: true, url: av.url, fetchedAt: av.fetchedAt });
  }

  if (req.method === 'GET' && p === '/api/drafts') return json(res, 200, { ok: true, drafts: loadDrafts() });

  // Recently published actions (auto mode + approved drafts), newest first.
  // This is what makes 全自动 observable: the queue page shows the last N
  // items the agent actually sent, with kind / target / time.
  if (req.method === 'GET' && p === '/api/published') {
    const n = Math.min(200, Math.max(1, Number(url.searchParams.get('n') || 40)));
    let entries = [];
    try {
      const h = JSON.parse(readFileSync(resolve(ROOT, 'queue', 'history.json'), 'utf8'));
      entries = Array.isArray(h.entries) ? h.entries : [];
    } catch { entries = []; }
    return json(res, 200, { ok: true, published: entries.slice(-n).reverse() });
  }

  if (req.method === 'POST' && /^\/api\/drafts\/\d+\/reject$/.test(p)) {
    const id = p.split('/')[3];
    const body = await readBody(req);
    // Capture the human's judgement before the draft disappears: this is the
    // only labelled signal we get about what they did not want.
    const draft = loadDrafts().find((d) => String(d.id) === String(id));
    if (draft) {
      try {
        recordFeedback({ action: 'reject', kind: draft.kind, text: draft.text, targetUrl: draft.targetUrl,
          originalText: draft.originalText, reason: (body && typeof body.reason === 'string') ? body.reason : undefined }); } catch (e) { appendLog('feedback: write failed ' + e.message); }
    }
    const e = removeDraft(id);
    return json(res, e ? 200 : 404, e ? { ok: true } : { ok: false, error: 'draft not found' });
  }

  if (req.method === 'POST' && /^\/api\/drafts\/\d+\/update$/.test(p)) {
    const id = p.split('/')[3];
    const body = await readBody(req);
    if (!body || typeof body.text !== 'string' || !body.text.trim()) return json(res, 400, { ok: false, error: 'text required' });
    const drafts = loadDrafts();
    const d = drafts.find((x) => String(x.id) === String(id));
    if (!d) return json(res, 404, { ok: false, error: 'draft not found' });
    const before = d.text;
    d.text = body.text;
    saveDrafts(drafts);
    try {
      recordFeedback({ action: 'edit', kind: d.kind, text: before, editedText: body.text,
        targetUrl: d.targetUrl, originalText: d.originalText }); } catch (e) { appendLog('feedback: write failed ' + e.message); }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && (p === '/api/drafts/approve-all' || /^\/api\/drafts\/\d+\/approve$/.test(p))) {
    const all = p === '/api/drafts/approve-all';
    const id = all ? null : p.split('/')[3];
    const drafts = loadDrafts();
    const targets = all ? drafts : drafts.filter((d) => String(d.id) === String(id));
    if (!targets.length) return json(res, 404, { ok: false, error: 'no drafts to publish' });

    let mod;
    try { mod = await import('./xbot.mjs'); }
    catch (e) { return json(res, 500, { ok: false, error: 'xbot unavailable: ' + e.message }); }

    const results = [];
    let connection = null;
    try {
      const edge = await import('./edge.mjs');
      connection = await edge.connect(cfg);
      const page = await edge.workPage(connection.ctx);
      for (const d of targets) {
        try {
          // Re-run the gate at publish time. Approval is a separate human step
          // and the draft may have been edited since it was queued, so the
          // checks that ran at enqueue time are not evidence about this text.
          const { checkPost, checkKindBudget } = await import('./gate.mjs');
          const state = loadState(resolve(ROOT, cfg.stateFile || 'state.json'), () => ({ postsPublished: 0, quotesPublished: 0, repliesPublished: 0, lastPostAt: 0, lastQuoteAt: 0, lastReplyAt: 0 }));
          // AC-13: a growth-follow draft carries an EMPTY body on purpose (the
          // action is follow(), not a post). Running the text gate on "" would
          // always die as too-short:0, so this kind is gated by its own
          // quota/cooldown budget instead. Every other kind keeps checkPost.
          // P1-2: a review-mode 回关 draft keeps kind 'growthFollow' and
          // carries lane:'followBack' instead, so the lane marker (not the
          // kind) decides routing. `d.kind` is still honoured for any draft
          // written before this field existed.
          const isFollowBack = d.lane === 'followBack' || d.kind === 'followBack';
          const isFollow = d.kind === 'follow' || d.kind === 'growthFollow' || isFollowBack;
          // P1: the lane can be switched off between enqueue and approval, so
          // the follow switch is re-checked here exactly like run.mjs does.
          const laneOff = isFollowBack
            ? (cfg.features && cfg.features.followBack === false)
            : (cfg.features && cfg.features.follow === false);
          if (isFollow && laneOff) {
            try { recordFeedback({ action: 'approve', kind: d.kind, text: d.text, targetUrl: d.targetUrl, originalText: d.originalText, gateReason: 'gate: features.follow=false' }); } catch (e) { appendLog('feedback: write failed ' + e.message); }
            results.push({ id: d.id, ok: false, error: 'gate: features.follow=false' });
            continue;
          }
          const verdict = isFollow
            ? checkKindBudget({ kind: isFollowBack ? 'followBack' : 'follow', state, cfg: { gate: cfg.gate, features: cfg.features } })
            : checkPost({ text: d.text, cfg, kind: d.kind, state });
          if (!verdict.ok) {
            try { recordFeedback({ action: 'approve', kind: d.kind, text: d.text, targetUrl: d.targetUrl, originalText: d.originalText, gateReason: 'gate: ' + verdict.reasons.join(',') }); } catch (e) { appendLog('feedback: write failed ' + e.message); }
            results.push({ id: d.id, ok: false, error: 'gate: ' + verdict.reasons.join(',') });
            continue;
          }
          // AC-12: dispatch by kind. othersReply is a REPLY to someone else's
          // post and growthFollow is a FOLLOW — neither may degrade to post().
          if (d.kind === 'reply') await mod.reply(page, d.targetUrl, d.text);
          else if (d.kind === 'othersReply') await mod.reply(page, d.targetUrl, d.text);
          else if (d.kind === 'quote') await mod.quote(page, d.targetUrl, d.text);
          else if (isFollow) {
            // P1: follow() reports failure as {ok:false} WITHOUT throwing, so a
            // 'no-button' result must NOT be reported as a successful publish.
            const fr = await mod.follow(page, d.targetUrl);
            if (!fr || fr.ok !== true) {
              try { recordFeedback({ action: 'approve', kind: d.kind, text: d.text, targetUrl: d.targetUrl, originalText: d.originalText, gateReason: 'follow: ' + ((fr && fr.reason) || 'failed') }); } catch (e) { appendLog('feedback: write failed ' + e.message); }
              results.push({ id: d.id, ok: false, error: 'follow: ' + ((fr && fr.reason) || 'failed') });
              continue;
            }
            // P1: a follow must count against the daily quota. run.mjs persists
            // the counter; the approve path must do the same or the budget
            // never moves and #stFollows never reflects approved follows.
            if (isFollowBack) { state.followBacksPublished = (state.followBacksPublished || 0) + 1; state.lastFollowBackAt = Date.now(); }
            else { state.followsPublished = (state.followsPublished || 0) + 1; state.lastFollowAt = Date.now(); }
            try { saveJson(resolve(ROOT, cfg.stateFile || 'state.json'), state); } catch (e) { appendLog('state: write failed ' + e.message); }
            // P2: an approved follow must land in the seen set too, or the next
            // auto round would follow the same account again.
            try {
              const seenPath = resolve(ROOT, 'queue', 'follow-seen.json');
              const seen = JSON.parse(readFileSync(seenPath, 'utf8'));
              const ids = new Set(Array.isArray(seen.ids) ? seen.ids : []);
              const handle = String(d.author || '').replace(/^@/, '').toLowerCase();
              if (handle) ids.add(handle);
              seen.ids = [...ids].slice(-800);
              saveJson(seenPath, seen);
            } catch (e) { appendLog('follow-seen: write failed ' + e.message); }
          }
          else await mod.post(page, d.text);
          removeDraft(d.id);
          try { recordFeedback({ action: 'approve', kind: d.kind, text: d.text, targetUrl: d.targetUrl, originalText: d.originalText }); } catch (e) { appendLog('feedback: write failed ' + e.message); }
          try {
            const { remember } = await import('./gate.mjs');
            // P2: keep the published-feed entry consistent with the auto path:
            // a follow is recorded as kind 'follow' with a human line, so one
            // canonical renderer handles both.
            if (isFollow) remember({ id: (isFollowBack ? 'fb' : 'f') + (d.author || d.id), text: (isFollowBack ? '回关了 @' : '关注了 @') + (d.author || ''), kind: (isFollowBack ? 'followBack' : 'follow'), url: d.targetUrl });
            else remember({ id: d.id, text: d.text, kind: d.kind, url: d.targetUrl });
          } catch {}
          results.push({ id: d.id, ok: true });
        } catch (e) {
          try { recordFeedback({ action: 'approve', kind: d.kind, text: d.text, targetUrl: d.targetUrl, originalText: d.originalText, gateReason: e.message }); } catch (e) { appendLog('feedback: write failed ' + e.message); }
          results.push({ id: d.id, ok: false, error: e.message });
        }
        await new Promise((r) => setTimeout(r, 4000));
      }
    } catch (e) {
      return json(res, 500, { ok: false, error: 'browser connection failed: ' + e.message });
    } finally {
      try { if (connection) await connection.browser.close(); } catch {}
    }
    return json(res, 200, { ok: results.some((r) => r.ok), results });
  }

  if (req.method === 'GET' && p === '/api/config') {
    const c = { ...cfg };
    delete c.apiKey;
    return json(res, 200, { ok: true, config: c, editable: CONFIG_WHITELIST });
  }

  if (req.method === 'POST' && p === '/api/config') {
    const body = await readBody(req);
    if (!body || typeof body !== 'object') return json(res, 400, { ok: false, error: 'invalid body' });
    const next = { ...cfg };
    const rejected = [];
    for (const [k, v] of Object.entries(body)) {
      if (!CONFIG_WHITELIST.includes(k)) { rejected.push(k); continue; }
      if (k === 'dailyTarget') { const n = strictNumber(v, 1, 200); if (n === null) return json(res, 400, { ok: false, error: 'dailyTarget must be a number 1-200' }); next[k] = n; continue; }
      if (k === 'quoteRatio') { const n = strictNumber(v, 0, 1); if (n === null) return json(res, 400, { ok: false, error: 'quoteRatio must be 0-1' }); next[k] = n; continue; }
      if (k === 'minGapMinutes') { const n = strictNumber(v, 1, 720); if (n === null) return json(res, 400, { ok: false, error: 'minGapMinutes must be 1-720' }); next[k] = n; continue; }
      if (k === 'maxGapMinutes') { const n = strictNumber(v, 1, 720); if (n === null) return json(res, 400, { ok: false, error: 'maxGapMinutes must be 1-720' }); next[k] = n; continue; }
      if (k === 'othersReply') {
        if (!isPlainObject(v)) return json(res, 400, { ok: false, error: 'othersReply must be an object' });
        if ('maxPerRound' in v) { const n = strictNumber(v.maxPerRound, 1, 50); if (n === null) return json(res, 400, { ok: false, error: 'othersReply.maxPerRound must be 1-50' }); }
        next[k] = { ...(next.othersReply || {}), ...v };
        continue;
      }
      if (k === 'activeHours') {
        if (!isPlainObject(v)) return json(res, 400, { ok: false, error: 'activeHours must be an object' });
        const start = strictNumber(v.start, 0, 23), end = strictNumber(v.end, 1, 24);
        if (start === null || end === null) return json(res, 400, { ok: false, error: 'activeHours start 0-23, end 1-24' });
        if (start >= end) return json(res, 400, { ok: false, error: 'activeHours start must be earlier than end' });
        next[k] = { ...next.activeHours, start, end };
        continue;
      }
      if (k === 'humanize') {
        if (!isPlainObject(v)) return json(res, 400, { ok: false, error: 'humanize must be an object' });
        next[k] = { ...next.humanize, ...v };
        continue;
      }
      if (k === 'safety') {
        if (!isPlainObject(v)) return json(res, 400, { ok: false, error: 'safety must be an object' });
        next[k] = { ...next.safety, ...v };
        continue;
      }
      if (k === 'features') {
        if (!isPlainObject(v)) return json(res, 400, { ok: false, error: 'features must be an object' });
        const keys = ['post', 'quote', 'muse', 'reply', 'like', 'browse', 'othersReply', 'follow', 'followBack'];
        for (const key of keys) {
          if (key in v && typeof v[key] !== 'boolean') return json(res, 400, { ok: false, error: 'features.' + key + ' must be a boolean' });
        }
        next[k] = { ...(next.features || {}), ...v };
        continue;
      }
      if (k === 'gate') {
        if (!isPlainObject(v)) return json(res, 400, { ok: false, error: 'gate must be an object' });
        if ('perKind' in v) {
          const pk = v.perKind;
          if (!isPlainObject(pk)) return json(res, 400, { ok: false, error: 'gate.perKind must be an object' });
          // T4: each DailyMax / CooldownMinutes must be a non-negative
          // integer, with 0 legal (DailyMax=0 blocks the lane forever,
          // CooldownMinutes=0 means no cooldown). Invalid values are a hard
          // 400 — never silently truncated or dropped.
          for (const [key, val] of Object.entries(pk)) {
            if (!/(?:DailyMax|CooldownMinutes)$/.test(key)) continue;
            const n = Number(val);
            if (!Number.isInteger(n) || n < 0) return json(res, 400, { ok: false, error: 'gate.perKind.' + key + ' must be a non-negative integer' });
          }
        }
        // Deep merge: perKind is replaced per-key so keys the UI does not
        // submit (engageDailyMax / engageCooldownMinutes / reply / muse
        // cooldowns...) survive a save, exactly like features/humanize/
        // safety/browse/laneRules preserve sibling keys (T4 / H11-3).
        next.gate = { ...(next.gate || {}), ...(('perKind' in v) ? {} : v) };
        if ('perKind' in v) next.gate.perKind = { ...(next.gate.perKind || {}), ...v.perKind };
        continue;
      }
      if (k === 'laneRules') {
        if (!isPlainObject(v)) return json(res, 400, { ok: false, error: 'laneRules must be an object' });
        const laneKeys = ['growthNeverQuote', 'growthNeverMuse', 'replyPrefersGrowth'];
        for (const key of laneKeys) {
          if (key in v && typeof v[key] !== 'boolean') return json(res, 400, { ok: false, error: 'laneRules.' + key + ' must be a boolean' });
        }
        next[k] = { ...(next.laneRules || {}), ...v };
        continue;
      }
      if (k === 'topicPostRequiresSource') {
        if (typeof v !== 'boolean') return json(res, 400, { ok: false, error: 'topicPostRequiresSource must be a boolean' });
        next[k] = v;
        continue;
      }
      if (k === 'schedule') {
        if (!isPlainObject(v)) return json(res, 400, { ok: false, error: 'schedule must be an object' });
        // T3: off-minute snapping switch. 0-30 keeps the cap meaningful; the
        // pair is validated strictly so a bad save never silently changes
        // pacing semantics.
        if ('offMinutesOnly' in v && typeof v.offMinutesOnly !== 'boolean') return json(res, 400, { ok: false, error: 'schedule.offMinutesOnly must be a boolean' });
        if ('maxSnapMinutes' in v) { const n = strictNumber(v.maxSnapMinutes, 0, 30); if (n === null) return json(res, 400, { ok: false, error: 'schedule.maxSnapMinutes must be 0-30' }); }
        if ('jitterSeconds' in v) { const n = strictNumber(v.jitterSeconds, 0, 120); if (n === null) return json(res, 400, { ok: false, error: 'schedule.jitterSeconds must be 0-120' }); }
        next[k] = { ...(next.schedule || {}), ...v };
        continue;
      }
      if (k === 'browse') {
        if (!isPlainObject(v)) return json(res, 400, { ok: false, error: 'browse must be an object' });
        if ('minutes' in v) { const n = strictNumber(v.minutes, 1, 60); if (n === null) return json(res, 400, { ok: false, error: 'browse.minutes must be 1-60' }); }
        if ('maxScrolls' in v) { const n = strictNumber(v.maxScrolls, 1, 30); if (n === null) return json(res, 400, { ok: false, error: 'browse.maxScrolls must be 1-30' }); }
        if ('likeWhileBrowsing' in v && typeof v.likeWhileBrowsing !== 'boolean') return json(res, 400, { ok: false, error: 'browse.likeWhileBrowsing must be a boolean' });
        next[k] = { ...(next.browse || {}), ...v };
        continue;
      }
      if (k === 'autoMode' && !['review', 'auto'].includes(v)) return json(res, 400, { ok: false, error: 'autoMode must be review or auto' });
      if (k === 'voiceEnabled' && typeof v !== 'boolean') return json(res, 400, { ok: false, error: 'voiceEnabled must be a boolean' });
      next[k] = v;
    }
    if (rejected.length) return json(res, 400, { ok: false, error: 'unknown keys rejected: ' + rejected.join(',') });

    // T1: the random-window cadence only means anything when the ceiling sits
    // above the floor. When the SAME request submits both and they contradict,
    // it is rejected outright (never stored unclearably). When only the floor is
    // raised past the stored ceiling the ceiling is dropped instead of silently
    // rewritten, so the cadence falls back to the documented fixed-interval
    // behaviour rather than erroring a save that only meant to change one field.
    if (next.maxGapMinutes != null && next.minGapMinutes != null && Number(next.maxGapMinutes) <= Number(next.minGapMinutes)) {
      const submittedBoth = 'maxGapMinutes' in body && 'minGapMinutes' in body;
      if (submittedBoth) return json(res, 400, { ok: false, error: 'maxGapMinutes must be greater than minGapMinutes' });
      delete next.maxGapMinutes;
    }

    // T1: path-class / boot-time keys cannot be hot-reloaded by the running
    // daemon (they are cached at module scope in run.mjs). When a save touches
    // one of them, tell the UI a restart is required. Too-restart keys mirror
    // the restart-only list in src/run.mjs reloadCfg().
    const RESTART_KEYS = ['profileDir', 'cdpPort', 'edgePath', 'stateFile', 'seenFile', 'seenRepliesFile',
      'othersReplySeenFile', 'failedFile', 'logFile', 'screenShotDir', 'voiceModel', 'cheapModel'];
    const touchedRestart = Object.keys(body).some((k) => RESTART_KEYS.includes(k));
    writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8');
    return json(res, 200, { ok: true, restartRequired: touchedRestart });
  }

  if (req.method === 'GET' && p === '/api/provider') {
    const pv = readJsonSafe('provider.json', {});
    const sec = readJsonSafe('secrets.json', {});
    return json(res, 200, { ok: true, provider: { protocol: pv.protocol || 'openai', baseURL: pv.baseURL || '', model: pv.model || '', cheapModel: pv.cheapModel || '' }, hasKey: !!sec.apiKey });
  }

  if (req.method === 'POST' && p === '/api/provider') {
    const body = await readBody(req);
    if (!body || typeof body !== 'object') return json(res, 400, { ok: false, error: 'invalid body' });
    const next = {
      protocol: ['openai', 'anthropic', 'openai-responses'].includes(body.protocol) ? body.protocol : 'openai',
      baseURL: typeof body.baseURL === 'string' ? body.baseURL.trim() : '',
      model: typeof body.model === 'string' ? body.model.trim() : '',
      cheapModel: typeof body.cheapModel === 'string' ? body.cheapModel.trim() : '',
    };
    if (!next.baseURL) return json(res, 400, { ok: false, error: 'baseURL required' });
    if (!next.model) return json(res, 400, { ok: false, error: 'model required' });
    writeFileSync(providerPath(), JSON.stringify(next, null, 2), 'utf8');
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      writeFileSync(resolve(ROOT, 'secrets.json'), JSON.stringify({ apiKey: body.apiKey.trim() }, null, 2), 'utf8');
    }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && p === '/api/provider/test') {
    let llm;
    try { llm = await import('./llm.mjs'); }
    catch { return json(res, 200, { ok: false, error: 'llm module not ready' }); }
    const result = await llm.testConnection().catch((e) => ({ ok: false, error: e.message }));
    return json(res, 200, result);
  }

  // T6: round stats — today's reads/pool/drops, drop reasons, per-source
  // distribution and the last 24h by-hour activity. All numbers come from
  // queue/stats.json aggregation; no invented values.
  if (req.method === 'GET' && p === '/api/stats') {
    const stats = loadStatsRing();
    const agg = todayStatsAgg();
    const dropReasons = agg.dropReasons;
    const topReasons = Object.entries(dropReasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason, n]) => ({ reason, n }));
    return json(res, 200, {
      ok: true,
      today: { read: agg.read, kept: agg.kept, dropped: agg.dropped, acted: agg.acted },
      bySource: agg.bySource,
      topDropReasons: topReasons,
      byHour: agg.byHour,
      recent: stats.slice(-10).reverse(),
    });
  }

  // Beginner-facing view of the same log: plain-language sentences, plus a
  // one-line "what is it doing right now" derived only from /api/status data.
  if (req.method === 'GET' && p === '/api/activity') {
    const n = clampNumber(url.searchParams.get('n') || 60, 1, 400);
    const cfg = loadConfig();
    const ctrl = readControl();
    const state = loadState(resolve(ROOT, cfg.stateFile || 'state.json'), () => ({
      units: 0, postsPublished: 0, quotesPublished: 0, repliesPublished: 0, draftsToday: 0, nextAllowedAt: 0,
    }));
    const drafts = loadDrafts();
    const todayStats = (() => {
      try { return todayStatsAgg(); } catch { return { read: 0, kept: 0, dropped: 0, acted: 0 }; }
    })();
    const now = describeNow({
      ok: true,
      daemon: { running: daemonRunning() },
      paused: !!ctrl.paused,
      today: state,
      dailyTarget: cfg.dailyTarget ?? 20,
      drafts: { pending: drafts.length },
      nextAllowedAt: state.nextAllowedAt || 0,
      // T6/CON-5: numbers come from queue/stats.json only; describeNow falls
      // back to the old wording when stats are missing.
      stats: {
        read: todayStats.read, kept: todayStats.kept, dropped: todayStats.dropped,
      },
    });
    let lines = [];
    try { lines = readFileSync(resolve(ROOT, 'log.txt'), 'utf8').split('\n'); } catch {}
    return json(res, 200, { ok: true, now, items: summarize(lines).slice(0, n) });
  }

  if (req.method === 'GET' && p === '/api/logs') {
    const n = clampNumber(url.searchParams.get('lines') || 200, 1, 2000);
    try {
      const all = readFileSync(resolve(ROOT, 'log.txt'), 'utf8').split('\n');
      return json(res, 200, { ok: true, lines: all.slice(-n) });
    } catch {
      return json(res, 200, { ok: true, lines: [] });
    }
  }

  if (req.method === 'POST' && p === '/api/daemon/start') {
    const body = await readBody(req);
    const ctrl = readControl();
    const mode = ctrl.mode || cfg.autoMode || 'review';
    const publish = body && typeof body.publish === 'boolean' ? body.publish : mode === 'auto';
    return json(res, 200, startDaemon({ publish: publish === true }));
  }
  if (req.method === 'POST' && p === '/api/daemon/stop') return json(res, 200, stopDaemon());

  // T5: "run once" — the --once path, NEVER --publish. A running daemon
  // refuses so there is never a concurrent second pass (hard boundary).
  if (req.method === 'POST' && p === '/api/daemon/run-once') {
    if (daemonRunning()) return json(res, 409, { ok: false, conflict: true, error: 'daemon is running' });
    // Reuses the same src/run.mjs --once path; publish flag is hard-set to
    // absent so this endpoint can never publish even in auto mode.
    let scriptArgs;
    let spawnCwd = ROOT;
    const env = { ...process.env };
    if (CODE_ROOT) {
      scriptArgs = [resolve(CODE_ROOT, 'src/run.mjs'), '--once'];
      spawnCwd = ROOT;
      env.ELECTRON_RUN_AS_NODE = '1';
    } else {
      scriptArgs = ['src/run.mjs', '--once'];
    }
    const child = spawn(process.execPath, scriptArgs, { cwd: spawnCwd, env, detached: true, stdio: 'ignore' });
    child.on('error', (e) => appendLog('server: run-once spawn failed: ' + e.message));
    const pid = child.pid;
    appendLog('server: run-once started pid=' + pid + ' (--once, no --publish)');
    return json(res, 200, { ok: true, pid, publish: false });
  }

  // Desktop manual single-round triggers (dashboard 互动 buttons). Publishing
  // rounds require an explicit {"publish":true} on THIS call; read-only rounds
  // never pass --publish no matter what the body says (hard invariant I1).
  if (req.method === 'POST' && /^\/api\/round\/[a-z]+$/.test(p)) {
    const name = p.split('/')[3];
    const READONLY = ['collect', 'like', 'browse'];
    const PUBLISHING = ['reply', 'others', 'content', 'follow'];
    if (![...READONLY, ...PUBLISHING].includes(name)) return json(res, 400, { ok: false, error: 'unknown round: ' + name });
    if (daemonRunning()) return json(res, 409, { ok: false, conflict: true, error: 'daemon is running' });
    const body = await readBody(req);
    const wantsPublish = !!(body && body.publish === true);
    // 只读轮永不加 --publish；发布轮必须本次调用显式 publish:true
    if (PUBLISHING.includes(name) && !wantsPublish) {
      return json(res, 400, { ok: false, error: 'round "' + name + '" publishes; pass {"publish":true} to confirm this call' });
    }
    const publish = PUBLISHING.includes(name);   // READONLY -> false
    let scriptArgs;
    let spawnCwd = ROOT;
    const env = { ...process.env };
    if (CODE_ROOT) {
      scriptArgs = [resolve(CODE_ROOT, 'src/run.mjs'), '--once', '--round=' + name, ...(publish ? ['--publish'] : [])];
      spawnCwd = ROOT;
      env.ELECTRON_RUN_AS_NODE = '1';
    } else {
      scriptArgs = ['src/run.mjs', '--once', '--round=' + name, ...(publish ? ['--publish'] : [])];
    }
    const child = spawn(process.execPath, scriptArgs, { cwd: spawnCwd, env, detached: true, stdio: 'ignore' });
    child.on('error', (e) => appendLog('server: round ' + name + ' spawn failed: ' + e.message));
    const pid = child.pid;
    appendLog('server: round ' + name + ' started pid=' + pid + (publish ? ' publish=--publish' : ' publish=no'));
    return json(res, 200, { ok: true, pid, round: name, publish });
  }

  if (req.method === 'POST' && p === '/api/control') {
    const body = await readBody(req);
    if (!body || typeof body !== 'object') return json(res, 400, { ok: false, error: 'invalid body' });
    const patch = {};
    if (typeof body.paused === 'boolean') patch.paused = body.paused;
    if (typeof body.mode === 'string') {
      if (!['review', 'auto'].includes(body.mode)) return json(res, 400, { ok: false, error: 'mode must be review or auto' });
      patch.mode = body.mode;
    }
    if (body.paused === false) patch.pauseReason = null;
    const next = writeControl(patch);
    return json(res, 200, { ok: true, control: next });
  }

  return json(res, 404, { ok: false, error: 'not found' });
}

// ---- static ------------------------------------------------------------
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = normalize(join(RENDERER, rel));
  // startsWith() is not containment: "/..%2frendererX/x" normalises to a
  // sibling directory that still shares the prefix. Compare the relative path
  // instead, so anything climbing out of the renderer root is refused.
  const relFromRoot = relative(RENDERER, full);
  if (relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) { res.writeHead(403); return res.end('forbidden'); }
  if (!existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(full));
}

export function startServer({ port = PORT, host = HOST } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + host);
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      return serveStatic(req, res, url);
    } catch (e) {
      appendLog('server error: ' + e.message);
      if (!res.headersSent) json(res, 500, { ok: false, error: e.message });
    }
  });
  return new Promise((resolvePromise) => {
    server.listen(port, host, () => {
      appendLog('server: listening on http://' + host + ':' + port);
      resolvePromise(server);
    });
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await startServer();
  console.log('SocialMate server on http://' + HOST + ':' + PORT);
}
