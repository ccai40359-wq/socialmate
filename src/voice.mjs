// LLM-backed copywriter that writes in the account owner's voice.
// Posts, quote comments and replies are distinct registers: replies are
// explicitly shorter and more colloquial, with a hard character cap.
// All generation goes through src/llm.mjs; templates are used only as an
// explicit degradation path and every degradation is marked DEGRADED.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { appendLog } from './log.mjs';
import { complete, isConfigured, loadProviderConfig } from './llm.mjs';
import { recentFeedback } from './feedback.mjs';

const VOICE_FILE = resolve('queue/voice-profile.json');

// Replies are capped far tighter than posts (5-25 in posts, 18 max here).
const REPLY_MAX_LEN = 18;

// Spam/scam terms that must never appear in generated copy.
const BANNED = /(彩票|代理|博彩|赌博|加微|私聊|兼职|刷单|返利|投资群|荐股|开户|贷款|色情|约炮|代购)/;

function sanitize(text, { multiline = false } = {}) {
  if (!text) return null;
  let t = String(text).replace(/^["「『]|["」』]$/g, '').replace(/https?:\/\/\S+/g, '');
  if (multiline) {
    // Original posts are explicitly asked for 2-4 sentences and may use line
    // breaks. Keeping only the first line silently discarded the analysis and
    // collapsed a ~130-char three-sentence post into a 50-char one-liner,
    // which is why the "有内容" original lane came out as a bare hottake.
    t = t.split('\n').map((l) => l.replace(/[ \t]+$/, '').trim()).filter(Boolean).join('\n');
  } else {
    t = t.split('\n')[0].trim();
  }
  // The user explicitly does not want the word "原文" in the body; the model
  // occasionally echoes the material label it was handed. Strip only the
  // label form so genuine prose that happens to contain 原文 is left alone.
  t = t.replace(/^原文\s*[:：]\s*/,'');
  if (!t || BANNED.test(t)) return null;
  return t;
}

// The user asked (repeatedly) that posts carry an emoji, and their favourites
// are 🤣😀😭😂. The prompt asks for one, but the model returned none in 3/3
// observed samples, so a deterministic post-process guarantees at least one
// instead of relying on the model. Not random: the same text always gets the
// same emoji, which keeps output stable for tests and re-runs.
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
const FAVORITE_EMOJI = ['🤣', '😀', '😭', '😂'];
export function ensureEmoji(text) {
  const t = (text || '').trim();
  if (!t || EMOJI_RE.test(t)) return t;
  let h = 0;
  for (const ch of t) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return t + FAVORITE_EMOJI[h % FAVORITE_EMOJI.length];
}

// The user rejected the "一句话吐槽 + 链接" shape: a 12-char hottake is exactly
// the 纯扯淡 they do not want in the ORIGINAL lane, and they then asked for
// longer, opinionated analysis. The model is asked for 150-260 chars / 4-6
// sentences; this is the enforcement. Too-short output is re-asked, and a
// degenerate result (<40 chars) returns null so the caller falls back to the
// informative template (title + summary + source link) rather than putting a
// contentless blurb in the queue. Pure + exported so it is directly testable.
const POST_MIN_CHARS = 90;
const POST_MIN_SENTENCES = 3;
const POST_HARD_FLOOR = 40;
export function isSubstantivePost(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const stripped = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '').trim();
  const chars = [...stripped].length;
  const segments = stripped.split(/[。！？!?.\n]+/).map((s) => s.trim()).filter((s) => [...s].length >= 6);
  return chars >= POST_MIN_CHARS && segments.length >= POST_MIN_SENTENCES;
}
export function postFloorOk(text) {
  const stripped = String(text || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '').trim();
  return [...stripped].length >= POST_HARD_FLOOR;
}

let voiceCache = null;
function voice() {
  if (voiceCache) return voiceCache;
  try { voiceCache = JSON.parse(readFileSync(VOICE_FILE, 'utf8')); }
  catch { voiceCache = null; }
  return voiceCache;
}

// Copy generation goes through src/llm.mjs so the app has exactly one model
// configuration (provider.json + secrets.json + env/.env) and one place that
// knows about reasoning-token budgets. Never talk to a provider directly.
function voiceConfig() {
  let model = process.env.VOICE_MODEL || null;
  if (!model) {
    try { model = JSON.parse(readFileSync(resolve('config.json'), 'utf8')).voiceModel; } catch {}
  }
  return { model: model || null };
}

// A voice model that the account cannot access (403 / MODEL_NOT_IN_PLAN)
// must not take down copywriting. Try the configured voice model, then fall
// back to the provider's own model before giving up.
// 3072, not 800: this model bills reasoning into the budget, so a small start
// truncated on most calls and the widen path re-ran the whole request
// (measured: 9 retries at "512 -> 1536" on the reply lane alone).
async function chat(messages, { maxTokens = 3072, temperature = 0.9 } = {}) {
  if (!isConfigured()) return null;
  const base = loadProviderConfig();
  const { model } = voiceConfig();
  const primary = model || base.model;
  try {
    const text = await complete(messages, { cfg: base, model: primary, maxTokens, temperature });
    return (text || '').trim();
  } catch (e) {
    const unreachable = /\b(403|404|MODEL_NOT_IN_PLAN|permission_error|model_not_found|does not exist)\b/i.test(e.message);
    if (!unreachable || primary === base.model) throw e;
    appendLog(`voice: ${primary} unavailable (${e.message.slice(0, 90)}), falling back to ${base.model}`);
    const text = await complete(messages, { cfg: base, model: base.model, maxTokens, temperature });
    return (text || '').trim();
  }
}

// Per-tier sample counts for the voice profile (tiny / short / medium).
export function sampleCounts(v) {
  const by = {};
  for (const tier of ['tiny', 'short', 'medium']) {
    by[tier] = Array.isArray(v?.samples?.[tier]) ? v.samples[tier].length : 0;
  }
  by.total = by.tiny + by.short + by.medium;
  return by;
}

// D1: style profile draws on ALL three sample tiers — tiny → short → medium
// (shortest first, longer samples at the end). queue/voice-profile.json's
// medium holds the owner's own longer posts (verified against the file), so it
// is a genuine voice sample and belongs in the set. The injection cap widens
// from 30 to 60 (cost widening was explicitly requested); tiny/short
// semantics are unchanged, medium is merely appended after them.
export function styleBlock(v) {
  const by = sampleCounts(v);
  const samples = [
    ...(v.samples?.tiny || []),
    ...(v.samples?.short || []),
    ...(v.samples?.medium || []),
  ].slice(0, 60);
  return [
    `账号：${v.displayName} (@${v.handle})`,
    `身份：${(v.identity || []).join('；')}`,
    `语言：${v.language}`,
    `长度：平均 ${v.length?.average} 字，${v.length?.rule}`,
    `语气：${(v.tone || []).join('；')}`,
    `常用开头：${(v.openers || []).join(' / ')}`,
    `绝对不要：${(v.never || []).join('；')}`,
    '',
    `本人的真实发言样本（tiny ${by.tiny} / short ${by.short} / medium ${by.medium}，共 ${by.total} 条，注入前 ${samples.length} 条；模仿这个语感，不要照抄内容）：`,
    ...samples.map((s) => `- ${s}`),
  ].join('\n');
}

// E3: review feedback as prompt CONTEXT only — negative examples injected
// into the prompt. Hard semantic boundary: feedback must never gate a
// publish; publishing decisions live in gate.mjs / run.mjs / server.mjs.
// Graceful degradation is mandatory: a missing, empty, unparsable or
// reject-less feedback store yields '' and never throws.
const FEEDBACK_LIMIT = 5;
const FEEDBACK_CLIP = 60;
const FEEDBACK_REASON_CLIP = 40;

export function rejectedExamples(kind, { limit = FEEDBACK_LIMIT, clipLen = FEEDBACK_CLIP, file } = {}) {
  try {
    const recs = recentFeedback({ kind, action: 'reject', n: limit }, file);
    const lines = [];
    for (const r of recs) {
      const text = String(r.text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const clipped = text.length <= clipLen ? text : text.slice(0, clipLen).replace(/[，。、；：,.;:！？!? ]+$/, '') + '…';
      const reason = r.reason ? `（${String(r.reason).replace(/\s+/g, ' ').trim().slice(0, FEEDBACK_REASON_CLIP)}）` : '';
      lines.push(`- ${clipped}${reason}`);
    }
    return lines.length
      ? `\n\n最近被拒绝的内容（不要重犯这些毛病；仅作上下文参考，不作发布限制）：\n${lines.join('\n')}`
      : '';
  } catch {
    return '';
  }
}

// The user-content prefix actually sent to the model: style block + optional
// rejected-example context + prompt. Exported so tests can assert the exact
// model input without calling the LLM.
export function userContentFor(v, kind, prompt = '', opts = {}) {
  return `${styleBlock(v)}${rejectedExamples(kind, opts)}\n\n${prompt}`;
}

// T5-c: numbers/facts only from the supplied material; restrained style.
const SOURCE_RULE = '数字与事实只能来自所给素材，不许自己编造；风格收敛、宁可平淡。';

const SYSTEM = `你在为一个中文推特账号代笔，必须完全模仿其主人的语气。
规则：
- 只用中文（可夹常用英文词），不用书面语。每条原创帖至少带一个 emoji（常用 🤣😀😭😂），放在情绪最强的地方，不要每句都加。
- 原创帖要有分量：150-260 字，4-6 句，可以分行。这是"观点/分析"，不是一句吐槽或转述。
- 结构：①一句话点出这件事到底是什么；②为什么重要/和什么冲突；③我的判断（明确站队，敢下结论）；④对做 AI 的人意味着什么，或一个反问收尾。
- 必须给出具体的判断、影响或对比，让读者看完知道"这条到底说了什么、我该怎么看"。
- 不要为了凑字而水；不要空话（"厉害""有意思""未来可期"这类不要单独成句）。
- 直接、口语、有观点，可以玩梗或自嘲，但不要脏话、不要涉黄、不要政治。
- 只输出推文正文本身，不要解释、不要引号、不要加"以下是"、不要标题。
- ${SOURCE_RULE}`;

// Dedicated reply register: shorter and more colloquial than original posts.
const REPLY_SYSTEM = `你在为一个中文推特账号代笔，现在要回复别人留在你帖子下的留言。
规则：
- 只用中文，不用书面语、不用客套话。回复可以带一个 emoji（🤣😀😭😂 都行），最多一个。
- 比原创推文更短更口语：一句话，最多 ${REPLY_MAX_LEN} 个字，宁短勿长。
- 顺着对方留言的内容回应，可以玩梗或自嘲；不要复述对方原话。
- 只输出回复正文本身，不要解释、不要引号。
- ${SOURCE_RULE}`;

export async function generatePostText(item) {
  const v = voice();
  if (!v) return null;
  const prompt = `根据这条 AI 资讯，用我的语气发一条有观点、有分析的长原创推文。

资讯标题：${item.title}
资讯摘要：${item.summary || item.reason || ''}
素材正文：${(item.text || '').slice(0, 400)}

 要求：
- 先一句话点出这件事"到底是什么"，再说"为什么重要/和什么冲突"
- 必须明确给出我的判断：赞成还是反对、哪条路会赢、哪一步是真正的瓶颈；敢下结论，不要骑墙
- 再说它对做 AI 的人意味着什么（影响/对比/下一步）
- 150-260 字，4-6 句，可以分行；不要复述标题内容
- 结尾必须带一个 emoji（我的常用：🤣😀😭😂），放在情绪最强的位置；正文不出现"原文"两个字
- 结尾可以留一个真问题，让人愿意回一句（但不要写"求关注/求互动"这类话）
- 数字与事实只能来自上面给的素材，不许自己编造
- 不要加链接（链接会由系统追加）
- ${SOURCE_RULE}`;
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const extra = attempt > 1
        ? '\n\n（上一条太短、太空，等于没内容。这次必须写满 2-4 句、至少 50 字：先说这件事是什么/为什么重要，再给你的判断或影响。不要只写一句感叹。）'
        : '';
      const out = await chat([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userContentFor(v, 'post', prompt) + extra },
      ]);
      const clean = sanitize(out, { multiline: true });
      if (!clean) { last = null; continue; }
      const withEmoji = ensureEmoji(clean);
      if (isSubstantivePost(withEmoji)) return withEmoji;
      last = withEmoji;
    } catch (e) {
      appendLog(`voice: DEGRADED generatePostText failed (${e.message}); caller must fall back to a template`);
      return null;
    }
  }
  // Two full attempts still produced nothing substantive. A degenerate blurb is
  // dropped so the template path (which carries the real title + summary) wins;
  // a merely-short one is kept rather than losing the whole round.
  if (last && postFloorOk(last)) {
    appendLog('voice: DEGRADED post stayed short after retry; publishing anyway (>= hard floor)');
    return last;
  }
  appendLog('voice: DEGRADED post too short after retry; falling back to template');
  return null;
}

export async function generateQuoteComment(item) {
  const v = voice();
  if (!v) return null;
  const prompt = `我要引用下面这条推文并加一句评论。

原推文主题：${item.title}
原文全文：${item.text || item.title || ''}
作者：@${item.author || 'unknown'}（likes=${item.likes ?? 'n/a'}）

要求：
- 写我引用时会加的那句评论，5-30 字
- 有观点或玩梗，不要复述原帖内容
- 不要加链接、不要加话题标签
- ${SOURCE_RULE}`;
  try {
    const out = await chat([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userContentFor(v, 'quote', prompt) },
    ]);
    return sanitize(out);
  } catch (e) {
    appendLog(`voice: DEGRADED generateQuoteComment failed (${e.message}); caller must fall back to a template`);
    return null;
  }
}


// Muse register: a loose, off-the-cuff remark inspired by a timeline tweet —
// the author's own thought, not a quote, no link, no numbers, no named
// people/events (muse has no material backstop: a fabricated fact is a false
// statement). Distinct system prompt from post/quote (T3-a / T3-b).
const MUSE_SYSTEM = `你在为一个中文推特账号代笔，随手写一条即兴感慨（muse）。
规则：
- 只用中文（可夹常用英文词），不用书面语。muse 尽量克制：最多一个 emoji（🤣😀😭😂），也可以完全不用。
- 极简：一句话为主，通常 5-30 字，最多两行。
- 直接、口语、有观点，可以自嘲或玩梗；不要脏话、不要涉黄、不要政治。
- 不要出现任何数字、百分比、年份；不要提具体人名、机构名、公司名、事件名。
- 不要写链接，不要 @ 任何人，不要加话题标签，不要引用或复述别人的话。
- 只能表达自己的感受和看法，不编造事实、不给出数据或断言。
- 只输出推文正文本身，不要解释、不要引号。
- ${SOURCE_RULE}`;

export async function generateMuseText(item) {
  const v = voice();
  if (!v) return null;
  const prompt = `刷到一条推文，有感而发，用我的语气随手写一条自己的感慨。

灵感推文：${item.text || item.title || ''}
作者：@${item.author || 'unknown'}

要求：
- 是我自己的即兴想法，不引用、不转载、不评论原推
- 5-30 字，一句话，口语
- 不出现数字/人名/机构/事件，不带链接
- ${SOURCE_RULE}`;
  try {
    const out = await chat([
      { role: 'system', content: MUSE_SYSTEM },
      { role: 'user', content: userContentFor(v, 'muse', prompt) },
    ]);
    return sanitize(out);
  } catch (e) {
    appendLog(`voice: DEGRADED generateMuseText failed (${e.message}); caller must fall back to a template`);
    return null;
  }
}

// Neutral, minimal, voice-neutral degradation utterance (not a cozy canned
// phrase). Only used when the LLM path failed or overshot the reply cap.
const FALLBACK_REPLY = '收到，晚点回复。';

export async function generateReply(item) {
  const v = voice();
  if (!v) {
    appendLog('voice: DEGRADED generateReply no voice profile; using neutral fallback');
    return FALLBACK_REPLY;
  }
  const prompt = `有人在我的帖子下面留言，我要回复他。

对方的留言：${item.text}
对方账号：@${item.author}

要求：
- 顺着留言内容用我的语气回一句，最多 ${REPLY_MAX_LEN} 个字
- 友好、自然、口语化，可以玩梗
- 如果对方是提问，简短回应并表示之后展开说
- ${SOURCE_RULE}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const extra = attempt > 1 ? '\n\n（上一条超长了，这次务必控制在 18 个字以内）' : '';
      const out = await chat([
        { role: 'system', content: REPLY_SYSTEM },
        { role: 'user', content: `${styleBlock(v)}\n\n${prompt}${extra}` },
      ], { maxTokens: 3072, temperature: 0.8 });
      const t = sanitize(out);
      if (t && t.length <= REPLY_MAX_LEN) return t;
      if (attempt === 2) {
        appendLog(`voice: DEGRADED generateReply overshot ${REPLY_MAX_LEN}-char cap after retries; using neutral fallback`);
        return FALLBACK_REPLY;
      }
    } catch (e) {
      appendLog(`voice: DEGRADED generateReply failed (${e.message}); using neutral fallback`);
      return FALLBACK_REPLY;
    }
  }
  return FALLBACK_REPLY;
}
