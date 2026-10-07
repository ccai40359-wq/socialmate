// LLM-backed copywriter that writes in the account owner's voice.
// Falls back to template text when no API key / request fails.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { appendLog } from './log.mjs';

const VOICE_FILE = resolve('queue/voice-profile.json');

// Spam/scam terms that must never appear in generated copy.
const BANNED = /(彩票|代理|博彩|赌博|加微|私聊|兼职|刷单|返利|投资群|荐股|开户|贷款|色情|约炮|代购)/;

function sanitize(text) {
  if (!text) return null;
  let t = text.replace(/^["「『]|["」』]$/g, '').split('\n')[0].trim();
  t = t.replace(/https?:\/\/\S+/g, '').trim();
  if (!t || BANNED.test(t)) return null;
  return t;
}

let voiceCache = null;
function voice() {
  if (voiceCache) return voiceCache;
  try { voiceCache = JSON.parse(readFileSync(VOICE_FILE, 'utf8')); }
  catch { voiceCache = null; }
  return voiceCache;
}

function apiConfig() {
  const key = process.env.OPENAI_API_KEY;
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  let model = process.env.VOICE_MODEL || null;
  if (!model) {
    try { model = JSON.parse(readFileSync(resolve('config.json'), 'utf8')).voiceModel; } catch {}
  }
  model = model || 'gpt-5.6-terra';
  return key ? { key, base, model } : null;
}

async function chat(messages, { maxTokens = 220, temperature = 0.9 } = {}) {
  const cfg = apiConfig();
  if (!cfg) return null;
  const res = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({ model: cfg.model, messages, max_tokens: maxTokens, temperature }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return (j.choices?.[0]?.message?.content || '').trim();
}

function styleBlock(v) {
  const samples = [...(v.samples?.tiny || []), ...(v.samples?.short || [])].slice(0, 30);
  return [
    `账号：${v.displayName} (@${v.handle})`,
    `身份：${(v.identity || []).join('；')}`,
    `语言：${v.language}`,
    `长度：平均 ${v.length?.average} 字，${v.length?.rule}`,
    `语气：${(v.tone || []).join('；')}`,
    `常用开头：${(v.openers || []).join(' / ')}`,
    `绝对不要：${(v.never || []).join('；')}`,
    '',
    '本人的真实发言样本（模仿这个语感，不要照抄内容）：',
    ...samples.map((s) => `- ${s}`),
  ].join('\n');
}

const SYSTEM = `你在为一个中文推特账号代笔，必须完全模仿其主人的语气。
规则：
- 只用中文（可夹常用英文词），不用 emoji，不用书面语。
- 极简：一句话为主，通常 5-30 字，最多两行。
- 直接、口语、有观点，可以玩梗或自嘲，但不要脏话、不要涉黄、不要政治。
- 只输出推文正文本身，不要解释、不要引号、不要加"以下是"。`;

export async function generatePostText(item) {
  const v = voice();
  if (!v) return null;
  const prompt = `根据这条 AI 资讯，用我的语气发一条推文。

资讯标题：${item.title}
资讯摘要：${item.summary || item.reason || ''}

要求：
- 用我的口吻点评这条 AI 资讯，不要复述标题
- 5-30 字，一句话
- 不要加链接（链接会由系统追加）`;
  try {
    const out = await chat([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `${styleBlock(v)}\n\n${prompt}` },
    ]);
    return sanitize(out);
  } catch (e) {
    appendLog(`generatePostText failed: ${e.message}`);
    return null;
  }
}

export async function generateQuoteComment(item) {
  const v = voice();
  if (!v) return null;
  const prompt = `我要引用下面这条推文并加一句评论。

原推文主题：${item.title}
相关内容：${item.summary || item.reason || ''}

要求：
- 写我引用时会加的那句评论，5-30 字
- 有观点或玩梗，不要复述原帖内容
- 不要加链接、不要加话题标签`;
  try {
    const out = await chat([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `${styleBlock(v)}\n\n${prompt}` },
    ]);
    return sanitize(out);
  } catch (e) {
    appendLog(`generateQuoteComment failed: ${e.message}`);
    return null;
  }
}

export async function generateReply(item) {
  const v = voice();
  if (!v) return null;
  const prompt = `有人在我的帖子下面留言，我要回复他。

对方的留言：${item.text}
对方账号：@${item.author}

要求：
- 用我的语气回一句，5-25 字
- 友好、自然、口语化，可以玩梗
- 如果对方是提问，简短回应并表示之后展开说
- 不要 emoji，不要客套书面语`;
  try {
    const out = await chat([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `${styleBlock(v)}\n\n${prompt}` },
    ], { maxTokens: 120 });
    return sanitize(out);
  } catch (e) {
    appendLog(`generateReply failed: ${e.message}`);
    return null;
  }
}
