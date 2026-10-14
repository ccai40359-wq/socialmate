// Gate: the last checkpoint before anything is published.
// Sources: DESIGN.md §7 (gates), §9.3 (content layer), §10 (risk gradient).
// Depends on safety.mjs, but degrades to a local implementation so the daemon
// survives a workstream landing late.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { saveJson } from './store.mjs';

const HISTORY_FILE = resolve('queue/history.json');

let safety = null;
try { safety = await import('./safety.mjs'); }
catch { safety = null; }

// Fallback mirrors src/safety.mjs: URLs count 23, CJK counts 2.
export function weightedLen(text) {
  if (typeof safety?.weightedLen === 'function') return safety.weightedLen(text);
  const urlRe = /https?:\/\/[^\s]+/g;
  let urls = 0;
  for (const _ of (text || '').matchAll(urlRe)) urls++;
  let len = urls * 23;
  for (const ch of (text || '').replace(urlRe, '')) len += ch.codePointAt(0) >= 0x1100 ? 2 : 1;
  return len;
}

export function screenContent(text, cfg) {
  if (typeof safety?.screenContent === 'function') return safety.screenContent(text, cfg);
  return { ok: true };
}

export function loadHistory() {
  try { return JSON.parse(readFileSync(HISTORY_FILE, 'utf8')); }
  catch { return { entries: [] }; }
}
export function saveHistory(h) { saveJson(HISTORY_FILE, h); }

// Character-bigram similarity. Catches near-duplicate reposts of the same
// headline — how a fleet of accounts gets linked together.
export function similarity(a, b) {
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, '').replace(/[^\p{L}\p{N}]/gu, '');
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s) => { const out = new Set(); for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2)); return out; };
  const gx = grams(x), gy = grams(y);
  let inter = 0;
  for (const g of gx) if (gy.has(g)) inter++;
  return (2 * inter) / (gx.size + gy.size || 1);
}

// Template rotation: one fixed prefix on every post is a detectable pattern.
const TEMPLATES = [
  (v, link) => (link ? `${v}\n\n${link}` : v),
  (v, link) => (link ? `${v}\n${link}` : v),
  (v, link) => (link ? `${v}\n\n— ${link}` : v),
  (v, link) => (link ? `${v} ${link}` : v),
];
// Degenerate-repetition detector (pure). A generated post occasionally
// collapses into a keyboard-mash wall ("啊啊啊...") which is
// long enough to pass minLength but carries no content. Conservative on
// purpose: long texts are only rejected when their character variety is
// genuinely degenerate, and an ultra-long same-char run is caught only when
// it dominates the post, so normal prose (incl. 哈哈哈 emoji spam) is
// untouched. Disable with cfg.gate.degenerateCheck === false.
export function degenerateRepetition(text, cfg = {}) {
  if (cfg.gate && cfg.gate.degenerateCheck === false) return false;
  const stripped = String(text || '').replace(/https?:\/\/\S+/g, '');
  if (stripped.length < 30) return false;
  const runs = stripped.match(/(.)\1{11,}/gs) || [];
  const runChars = runs.reduce((n, r) => n + r.length, 0);
  if (runChars >= 30 && runChars / stripped.length >= 0.5) return true;
  if (stripped.length >= 80) {
    const uniq = new Set([...stripped]).size;
    if (uniq / stripped.length < 0.2) return true;
  }
  return false;
}

let templateIdx = 0;
export function nextTemplate() { return TEMPLATES[templateIdx++ % TEMPLATES.length]; }
export function resetTemplate(i = 0) { templateIdx = i; }
export function templateCount() { return TEMPLATES.length; }

export function checkPost({ text, history, cfg = {}, kind = 'post', state = null, now = Date.now() }) {
  const h = history || loadHistory();
  const reasons = [];

  // Per-kind cooldown/quota runs first: it is about timing, not the text.
  if (state) {
    const budget = checkKindBudget({ kind, state, cfg, now });
    if (!budget.ok) reasons.push(...budget.reasons);
  }

  const len = weightedLen(text);
  if (len > (cfg.gate?.maxLength ?? 280)) reasons.push(`too-long:${len}`);
  const minLen = cfg.gate?.minLength ?? 8;
  if ((text || '').trim().length < minLen) reasons.push(`too-short:${(text || '').trim().length}`);

  const screened = screenContent(text, cfg);
  if (!screened.ok) reasons.push(`content:${screened.reason}`);

  if (degenerateRepetition(text, cfg)) reasons.push('degenerate-repeat');

  const maxSim = cfg.gate?.maxSimilarity ?? 0.75;
  for (const e of h.entries || []) {
    const s = similarity(text, e.text);
    if (s >= maxSim) { reasons.push(`duplicate:${s.toFixed(2)}`); break; }
  }

  if (cfg.gate?.maxLinkRatio != null) {
    const recent = (h.entries || []).slice(-20);
    if (recent.length >= 5) {
      const withLinks = recent.filter((e) => /https?:\/\//.test(e.text)).length;
      const ratio = withLinks / recent.length;
      if (/https?:\/\//.test(text) && ratio >= cfg.gate.maxLinkRatio) reasons.push(`link-ratio:${ratio.toFixed(2)}`);
    }
  }


  // Muse guardrails (T4-e / T4-f / T4-g): muse has no material backstop —
  // anything fabricated would be a false statement. URLs, specific numbers,
  // quoted claims, and proper-noun/event patterns are all rejected here, and
  // the text must pass the shared content screen.
  if (kind === 'muse') {
    if (/https?:\/\/\S+|www\.\S+/i.test(text)) reasons.push('muse-url');
    if (/[0-9]/.test(text)) reasons.push('muse-number');
    if (/["“”‘’「」『』]/.test(text)) reasons.push('muse-quote');
    if (/([A-Z][a-z]+){2,}|马斯克|OpenAI|Anthropic|Google|Microsoft|英伟达|特朗普|拜登|普京|美联储|台积电|三星|华为|腾讯|阿里|字节|发布会|开幕|签约|峰会|论坛|颁奖|任命|辞职|弹劾|选举|大选|战争|袭击|爆炸|地震|台风|事故|灾难|财报|裁员|破产|并购|收购|上市|IPO|监管|罚款|起诉|判决|立法|法案/.test(text)) reasons.push('muse-propernoun');
  }

  return { ok: reasons.length === 0, reasons };
}

// T5-d: a quote comment with zero token overlap against the original tweet
// body is a hollow quote — nothing is actually being said about the tweet.
// Pure so it is directly assertable.
//
// Latin scripts split on non-alphanumerics. CJK does not use spaces, so a
// whole Chinese sentence is one "word" token under that rule and every Chinese
// quote looked hollow. For runs of CJK we fall back to single characters with
// high-frequency function characters filtered out, so overlap reflects shared
// content ("模型" inside "这个模型很强") rather than grammar words like "的"/"是".
export function hollowQuote(comment, originalText) {
  const CJK_STOP = new Set('的了是在我你他她它们这那有和就不也人一个上下都很会要想说去来把被给对从到与及或而并但啊吧呢嘛呀哦之其於与而');
  const toks = (s) => {
    const out = new Set();
    const t = (s || '').toLowerCase();
    // Latin/digit words: split on non-alphanumerics.
    for (const w of t.split(/[^\p{L}\p{N}]+/u)) {
      if (!w) continue;
      if (/^[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+$/.test(w)) {
        // CJK has no spaces: use characters, dropping high-frequency function
        // characters so overlap reflects content, not grammar.
        for (const ch of w) if (!CJK_STOP.has(ch)) out.add(ch);
      } else {
        out.add(w);
      }
    }
    return out;
  };
  const qt = toks(originalText);
  if (!qt.size) return false;
  for (const w of toks(comment)) if (qt.has(w)) return false;
  return true;
}

// T5-e: same author may be quoted at most once per day. Pure, keyed by state.
export function quoteCountForAuthorToday(state, author, now = Date.now()) {
  if (!author) return 0;
  const todayKey = new Date(now).toISOString().slice(0, 10);
  const list = (state && state.quotedAuthorsByDay && state.quotedAuthorsByDay[todayKey]) || [];
  return list.filter((a) => String(a).toLowerCase() === String(author).toLowerCase()).length;
}

// T5-e style: same author may be replied to (othersReply lane) at most once
// per day. Pure, keyed by state so the daily cap survives restarts.
export function othersReplyCountForAuthorToday(state, author, now = Date.now()) {
  if (!author) return 0;
  const todayKey = new Date(now).toISOString().slice(0, 10);
  const list = (state && state.othersRepliedAuthorsByDay && state.othersRepliedAuthorsByDay[todayKey]) || [];
  return list.filter((a) => String(a).toLowerCase() === String(author).toLowerCase()).length;
}
// Per-kind cooldown + quota (T6-c). Publishing a quote should not consume the
// original-post budget, and replying to a comment should never be blocked by
// either. Pure so it is directly testable.
export function checkKindBudget({ kind = 'post', state = {}, cfg = {}, now = Date.now() } = {}) {
  const k = kind === 'quote' ? 'quote' : kind === 'reply' ? 'reply' : kind === 'muse' ? 'muse' : kind === 'engage' ? 'engage' : kind === 'browse' ? 'browse' : kind === 'othersReply' ? 'othersReply' : kind === 'follow' ? 'follow' : kind === 'followBack' ? 'followBack' : 'post';
  const reasons = [];

  const perKind = (cfg.gate && cfg.gate.perKind) || {};
  // Keys are namespaced by kind: postDailyMax / quoteDailyMax / ...
  const limit = perKind[k + 'DailyMax'] ?? perKind[k] ?? null;
  // A5: the othersReply lane persists its counters under the plural 'othersReplies'
  // (state.othersRepliesPublished / lastOthersReplyAt). The generic read above
  // would look up 'othersReplysPublished' for the normalized kind, so the
  // counters are read explicitly here to keep the quota real (R3-5).
  const used = k === 'othersReply' ? (state.othersRepliesPublished ?? 0) : (state[k + 'sPublished'] ?? 0);
  const lastAt = k === 'othersReply' ? (state.lastOthersReplyAt ?? 0) : (state['last' + k[0].toUpperCase() + k.slice(1) + 'At'] ?? 0);

  if (limit != null && used >= limit) reasons.push(`quota-${k}:used=${used}/max=${limit}`);

  const cooldownMin = perKind[k + 'CooldownMinutes'] ?? null;

  if (cooldownMin != null && lastAt) {
    const waitMs = cooldownMin * 60_000;
    const elapsed = now - lastAt;
    if (elapsed < waitMs) reasons.push(`cooldown-${k}:need=${Math.ceil((waitMs - elapsed) / 60_000)}min`);
  }

  return { ok: reasons.length === 0, reasons, kind: k, limit, used };
}

export function remember({ id, text, kind, url }) {
  const h = loadHistory();
  h.entries = [...(h.entries || []), { id, text, kind, url, at: new Date().toISOString() }].slice(-500);
  saveHistory(h);
  return h;
}
