// Turn AIHOT items into post text, quote comments, and X search keywords.
// Display links point at the ORIGINAL source — AIHOT is only the radar.
// When voice generation is enabled, the body is written in the owner's voice.
import { loadConfig } from './aihot.mjs';

const cfg = loadConfig();

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

export function officialLinkOf(item) {
  const u = (item && item.originalUrl) || '';
  if (!u || /aihot\.news/.test(u)) return null;
  return u;
}

export function takeFor(item) {
  if (item.summary) return clip(item.summary, 110);
  if (item.reason) return clip(item.reason, 110);
  return '值得留意的 AI 动态。';
}

// `voice` (optional) is one sentence written in the owner's voice.
export function buildPost(item, voice = null) {
  const link = officialLinkOf(item);
  const variants = [
    [voice, link ? `\n原文 ${link}` : ''],
    [`${cfg.postPrefix}｜${clip(item.title, 80)}`, '', takeFor(item), link ? `\n原文 ${link}` : ''],
    [`${cfg.postPrefix}｜${clip(item.title, 80)}`, '', link ? `原文 ${link}` : ''],
    [`${cfg.postPrefix}｜${clip(item.title, 60)}`, link ? `\n原文 ${link}` : ''],
    [`${clip(item.title, 60)}`, link ? `\n${link}` : ''],
  ];
  for (const parts of variants) {
    const text = parts.filter((p) => p !== null && p !== undefined && p !== '').join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) continue;
    if (weightedLen(text) <= 280) return text;
  }
  return clip(item.title, 120);
}

export function buildQuoteComment(item, voice = null) {
  if (voice) return clip(voice, 140);
  const take = item.summary || item.reason || '';
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
