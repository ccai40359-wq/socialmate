// Turn AIHOT items into post text, quote comments, and X search keywords.
// Display links point at the ORIGINAL source — AIHOT is only the radar.
// When voice generation is enabled, the body is written in the owner's voice.
import { loadConfig } from './aihot.mjs';
import { appendLog } from './log.mjs';

const cfg = loadConfig();

// E3 说明：审核反馈（queue/feedback.json 的 reject 记录）已在 src/voice.mjs 的
// generatePostText / generateQuoteComment / generateMuseText 中作为负例注入提示词
// （见 voice.mjs 的 rejectedExamples，仅作上下文参考、绝不作为发布硬闸门）。
// 本文件的 buildPost / buildQuoteComment 是模板降级路径：它们不调用 LLM，只做
// 字符串拼装与长度裁剪，没有"提示词"可注入，因此这里不再重复接入；一旦降级路径
// 未来接入 LLM 生成，应复用 voice.mjs 的 rejectedExamples 同一入口。

function clip(s, n) {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n - 1).replace(/[，。、；：,.;: ]+$/, '') + '…';
}

// X weights: URLs count as 23, most CJK codepoints as 2, ASCII as 1.
export function weightedLen(text) {
  const urlRe = /https?:\/\/[^\s]+/g;
  let withoutUrls = text.replace(urlRe, '');
  let urls = 0;
  for (const _ of text.matchAll(urlRe)) urls++;
  let len = urls * 23;
  for (const ch of withoutUrls) len += ch.codePointAt(0) >= 0x1100 ? 2 : 1;
  return len;
}

// Source link for a candidate. The pool stores the ORIGINAL source in
// different fields depending on the collector: AIHOT rows put the official
// article/tweet in `origin`, timeline/search rows put the tweet in `url`, and
// older cached rows used `originalUrl`. Try all three in that order and never
// return an aihot.news interstitial — that is the radar, not the source.
export function sourceLinkOf(item) {
  for (const v of [item && item.origin, item && item.originalUrl, item && item.url]) {
    const u = (v || '').trim();
    if (!u) continue;
    if (!/^https?:\/\//i.test(u)) continue;
    if (/aihot\.news/i.test(u)) continue;
    return u;
  }
  return null;
}

// Kept for callers that ask for the "official" link specifically; it now
// understands every field the pool actually uses.
export function officialLinkOf(item) {
  return sourceLinkOf(item);
}

// The pre-T1 behaviour, kept so `topicPostRequiresSource:false` can genuinely
// restore it for A/B comparison: only originalUrl counts, and an aihot.news
// interstitial is never returned.
function legacyOriginalUrlOf(item) {
  const u = (item && item.originalUrl) || '';
  if (!u || /aihot\.news/.test(u)) return null;
  return u;
}

// Whether the topic-post source rule is on. Read from the same config the rest
// of the planner uses; default true (the user-facing behaviour).
function topicSourceRequired() {
  try { return cfg.topicPostRequiresSource !== false; } catch { return true; }
}

// Append the source link to a post body without exceeding X's weighted length.
// The bare link is enough: X renders a standalone tweet URL as a quote card on
// its own, so no "原文" label is needed (and the user asked for none). The body
// is trimmed only when the link would otherwise push the post over the limit.
// X allows the account far more than 280 weighted units (verified live: a
// 1280-char body kept the post button enabled), and the user explicitly asked
// for LONGER, opinionated originals. The cut-off therefore follows
// cfg.gate.maxLength instead of a hard 280 — but only when the source-link
// rule appends to a body we generated; templates keep the same behaviour.
export function xTextLimit() {
  try { return Number(cfg.gate?.maxLength) > 0 ? Number(cfg.gate.maxLength) : 280; } catch { return 280; }
}

export function withSourceLink(text, link, max = xTextLimit()) {
  const body = (text || '').trim();
  if (!link) return body;
  if (body.includes(link)) return body;
  const bare = (body ? '\n\n' : '') + link;
  if (weightedLen(body + bare) <= max) return (body + bare).trim();
  // Body has to give way: shrink it until the link fits.
  const budget = max - weightedLen(bare);
  let trimmed = body;
  while (trimmed && weightedLen(trimmed) > budget) trimmed = trimmed.slice(0, -1);
  trimmed = trimmed.replace(/[\s\u3000]+$/, '').replace(/[\uff0c\u3002\u3001\uff1b\uff1a,.;: ]+$/, '');
  return (trimmed + bare).trim();
}

export function takeFor(item) {
  if (item.summary) return clip(item.summary, 110);
  if (item.reason) return clip(item.reason, 110);
  return '值得留意的 AI 动态。';
}

// `voice` (optional) is one sentence written in the owner's voice.
export function buildPost(item, voice = null) {
  if (!voice) appendLog('planner: DEGRADED template variant used (voice unavailable)');
  // When the rule is switched off we reproduce the old link behaviour exactly
  // (originalUrl only) so the flag is a real rollback, not a cosmetic one.
  const link = topicSourceRequired() ? sourceLinkOf(item) : legacyOriginalUrlOf(item);
  const variants = [
    [voice, link ? `\n${link}` : ''],
    [`${cfg.postPrefix}｜${clip(item.title, 80)}`, '', takeFor(item), link ? `\n${link}` : ''],
    [`${cfg.postPrefix}｜${clip(item.title, 80)}`, '', link || ''],
    [`${cfg.postPrefix}｜${clip(item.title, 60)}`, link ? `\n${link}` : ''],
    [`${clip(item.title, 60)}`, link ? `\n${link}` : ''],
  ];
  for (const parts of variants) {
    const text = parts.filter((p) => p !== null && p !== undefined && p !== '').join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) continue;
    // A long voice body must not be discarded just because it exceeds the old
    // 280 assumption; the limit follows config so the analysis survives.
    if (weightedLen(text) <= xTextLimit()) return text;
  }
  return clip(item.title, 120);
}

export function buildQuoteComment(item, voice = null) {
  if (voice) return clip(voice, 140);
  // Quote comment feeds the FULL tweet body (T5-b) plus author and
  // engagement (T5-c); the truncated 80-char title is no longer used.
  const take = item.text || item.summary || item.reason || '';
  const short = clip(take, 140);
  return short || clip(item.title, 120);
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'has', 'have', 'how', 'why', 'new', 'its', 'via', 'after', 'into', 'over', 'out', 'can', 'will', 'not', 'but', 'you', 'your', 'about', 'more', 'than', 'first', 'next', 'now']);

export function keywordsFor(item, max = 3) {
  const out = [];
  const push = (w) => {
    const k = w.trim();
    if (!k || k.length < 3) return;
    if (STOP.has(k.toLowerCase())) return;
    if (out.some((x) => x.toLowerCase() === k.toLowerCase())) return;
    if (out.length < max) out.push(k);
  };
  for (const m of item.title.matchAll(/[A-Z][A-Za-z0-9.+#-]{2,}/g)) push(m[0]);
  for (const m of item.title.matchAll(/[\u4e00-\u9fa5]{3,6}/g)) push(m[0]);
  if (!out.length) push(item.title.slice(0, 10));
  return out;
}

export function xOriginalOf(item) {
  const u = (item && item.originalUrl) || '';
  const m = u.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/\/]+)\/status\/(\d+)/);
  return m ? `https://x.com/${m[1]}/status/${m[2]}` : null;
}

export { clip };
