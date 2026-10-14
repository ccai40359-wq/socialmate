// Build the voice profile from collected posts: style rules + real examples
// used as few-shot anchors for the LLM.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const posts = JSON.parse(readFileSync(resolve('queue/my-posts.json'), 'utf8'));
const mine = posts
  .filter((p) => p.text && p.text.trim().length > 2 && !/^AI 快讯/.test(p.text.trim()))
  .map((p) => ({ text: p.text.replace(/\n+/g, ' ').trim(), when: p.when, hasQuote: p.hasQuote, isReply: p.isReply }));

// Keep short/low-noise examples as style anchors; drop link-only posts.
const anchors = mine.filter((p) => !/^https?:\/\//.test(p.text) && p.text.length <= 60 && p.text.length >= 4);

const byLength = { tiny: [], short: [], medium: [] };
for (const p of anchors) {
  if (p.text.length <= 12) byLength.tiny.push(p.text);
  else if (p.text.length <= 25) byLength.short.push(p.text);
  else byLength.medium.push(p.text);
}

// Emoji usage is MEASURED from the collected corpus, never hard-coded. X renders
// emoji as <img alt>, so the collector substitutes alt text back into the body;
// an earlier collector dropped them and the profile wrongly said "no emoji".
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;
const emojiPosts = mine.filter((p) => EMOJI_RE.test(p.text));
const emojiRate = mine.length ? emojiPosts.length / mine.length : 0;
const emojiHits = {};
for (const p of emojiPosts) {
  for (const ch of p.text.match(new RegExp(EMOJI_RE.source, 'gu')) || []) emojiHits[ch] = (emojiHits[ch] || 0) + 1;
}
const topEmoji = Object.entries(emojiHits).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([e]) => e);
const emojiLine = emojiRate >= 0.15
  ? `爱用 emoji（约 ${Math.round(emojiRate * 100)}% 的帖子里有），常用 ${topEmoji.join('')}，放在句尾或句末情绪词后，不要每句都加`
  : `emoji 用得少（约 ${Math.round(emojiRate * 100)}%），需要时偶尔加一个，不要堆`;
const EMOJI_RULE = emojiRate >= 0.15
  ? `适度用 emoji（常用 ${topEmoji.join('')}），一句话最多一个，放在情绪最强的地方`
  : 'emoji 尽量少用，必要时最多一个';
// Persona fields come from a user-owned seed file so this script ships no one
// else's identity. Copy voice.seed.example.json -> voice.seed.json and fill in
// YOUR display name, identity, tone and topics; the SAMPLES below are still
// measured from your own collected posts, never from the seed.
const SEED_FILE = resolve('voice.seed.json');
let seed = {};
try { seed = JSON.parse(readFileSync(SEED_FILE, 'utf8')); } catch {}
if (!seed.handle) {
  console.warn('voice.seed.json not found - using a GENERIC placeholder persona.');
  console.warn('Copy voice.seed.example.json to voice.seed.json and describe YOUR voice.');
}
const profile = {
  handle: seed.handle || 'your_handle',
  displayName: seed.displayName || '你的昵称',
  identity: seed.identity || ['在 voice.seed.json 里填写你的身份 / 领域'],
  language: seed.language || `中文为主，夹少量英文词；${emojiLine}`,
  length: seed.length || { average: 19, rule: '绝大多数 5-25 字，一句话说完；长内容最多 2-3 行' },
  tone: seed.tone || ['口语、直接（在 voice.seed.json 里细化你的语气）'],
  openers: seed.openers || [],
  closers: seed.closers || [],
  never: [...(seed.never || ['不做长篇大论的科普，不写营销文案腔']), EMOJI_RULE],
  topics: seed.topics || [],
  samples: {
    tiny: byLength.tiny.slice(0, 25),
    short: byLength.short.slice(0, 30),
    medium: byLength.medium.slice(0, 20),
  },
  stats: { collected: mine.length, anchors: anchors.length, emojiPosts: emojiPosts.length, emojiRate: Math.round(emojiRate * 100), topEmoji, avgLen: Math.round(mine.reduce((s, p) => s + p.text.length, 0) / mine.length) },
};

writeFileSync(resolve('queue/voice-profile.json'), JSON.stringify(profile, null, 2), 'utf8');
console.log(`Voice profile built: ${profile.stats.collected} human posts, ${profile.stats.anchors} style anchors`);
console.log('avg length:', profile.stats.avgLen);
console.log('\ntiny samples:', byLength.tiny.slice(0, 8).join(' | '));
console.log('short samples:', byLength.short.slice(0, 8).join(' | '));
