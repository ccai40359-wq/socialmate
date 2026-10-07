// Find replies to my own posts via the notifications timeline, and draft
// replies for them. Drafted text stays short and friendly; review mode
// (default) sends drafts to the queue instead of publishing.
import { appendLog } from './log.mjs';

const MY_HANDLE = 'SeanInAI111';

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function scanReplies(page, opts = {}) {
  const maxAgeHours = opts.maxAgeHours ?? 48;
  const cutoff = Date.now() - maxAgeHours * 3600_000;

  await page.goto('https://x.com/notifications', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(6000);

  const found = [];
  const arts = await page.locator('article[data-testid="tweet"]').all();
  for (const art of arts) {
    const nameBox = await art.locator('[data-testid="User-Name"]').first().innerText().catch(() => '');
    const handleLine = (nameBox.split('\n').find((l) => l.trim().startsWith('@')) || '').trim();
    const author = handleLine.replace('@', '');
    if (!author || author === MY_HANDLE) continue;

    const body = await art.innerText().catch(() => '');
    const replyingToMe = /Replying to[\s\S]{0,40}@SeanInAI111/.test(body) || new RegExp(`@${MY_HANDLE}`).test(body.split('\n')[0] || '');
    if (!replyingToMe) continue;

    const href = await art.locator('a[href*="/status/"]').first().getAttribute('href').catch(() => null);
    if (!href) continue;
    const idMatch = href.match(/status\/(\d+)/);
    if (!idMatch) continue;

    const when = await art.locator('time').first().getAttribute('datetime').catch(() => null);
    if (when && new Date(when).getTime() < cutoff) continue;

    found.push({ tweetId: idMatch[1], author, url: 'https://x.com' + href, text: extractText(body), when });
  }
  return dedupe(found);
}

function extractText(body) {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const skip = /^(Follow|Replying to|@|·|\d|Show|Translated|Verified|See)/;
  const texts = lines.filter((l) => !skip.test(l) && !l.startsWith('@') && l.length > 1);
  const best = texts.slice(-2).join(' ').trim();
  return best.slice(0, 200);
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((x) => (seen.has(x.tweetId) ? false : (seen.add(x.tweetId), true)));
}

const PRAISE = /(牛|强|厉害|有实力|赞|好|支持|不错|顶|cool|nice|great|awesome|love|good)/i;
const GREET = /(互|浇|关|来了|走起|支持|加油|签到|打卡)/;
const QUESTION = /[?？]|(怎么|如何|为什么|哪家|哪个|什么|有没有|是不是|能不能|how|why|what|which)/i;

export function draftReplyFor(item) {
  const t = item.text || '';
  if (QUESTION.test(t)) {
    return '好问题，我整理一下相关信息和数据，回头单独发一条展开说。感谢关注！';
  }
  if (PRAISE.test(t)) {
    return '谢谢支持！后面继续带来一手 AI 动态。';
  }
  if (GREET.test(t)) {
    return '感谢捧场，常来！';
  }
  return '收到，感谢留言！';
}
