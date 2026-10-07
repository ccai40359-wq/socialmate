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

const profile = {
  handle: 'SeanInAI111',
  displayName: 'Sean（薄肌版）',
  identity: ['AI Builder / AI Agent & RAG 方向独立开发者', '薄肌健身爱好者', '在中国、面向国际（做 AI 项目 + 英语学习 + 涨粉）'],
  language: '中文为主，夹少量英文词（crazy / vibe coding / fo / prompt / token 等），不用 emoji',
  length: { average: 19, rule: '绝大多数 5-25 字，一句话说完；长内容最多 2-3 行' },
  tone: [
    '口语、直接、自信，有时故意挑衅式幽默（"如果你是X / 那我不要和你说话"）',
    '自嘲与玩梗并存（"穷鬼还是只能用gpt"、"手指要开始拉屎了"）',
    '对 AI 圈子有强观点，不怕下判断（"犹豫1s都是对opus5.5的不尊重"）',
    '对朋友友好热情，常用 兄弟们 / 蓝朋友们 / 各位义父义母 开头',
  ],
  openers: ['兄弟们', '蓝朋友们', '各位义父义母', '恭喜恭喜！', '是的', '还真是', '太crazy了'],
  closers: ['！', '？', '！？', '吧', '了', '就很'],
  never: [
    '不用 emoji',
    '不用书面语（"综上"、"值得注意的是"、"首先其次"）',
    '不用话题标签堆砌（最多 1-2 个互关类标签）',
    '不做长篇大论的科普，不写营销文案腔',
    '不吹不夸自己，多自嘲',
  ],
  topics: ['AI 模型/工具动态', 'AI 编程与 agent 工作流', 'token 成本与性价比', '薄肌训练', '涨粉/推特生态', '大学生活与职场'],
  samples: {
    tiny: byLength.tiny.slice(0, 25),
    short: byLength.short.slice(0, 30),
    medium: byLength.medium.slice(0, 20),
  },
  stats: { collected: mine.length, anchors: anchors.length, avgLen: Math.round(mine.reduce((s, p) => s + p.text.length, 0) / mine.length) },
};

writeFileSync(resolve('queue/voice-profile.json'), JSON.stringify(profile, null, 2), 'utf8');
console.log(`Voice profile built: ${profile.stats.collected} human posts, ${profile.stats.anchors} style anchors`);
console.log('avg length:', profile.stats.avgLen);
console.log('\ntiny samples:', byLength.tiny.slice(0, 8).join(' | '));
console.log('short samples:', byLength.short.slice(0, 8).join(' | '));
