// Collect my own posts using the canonical tweetText node.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connect, workPage, closeBrowser } from '../src/edge.mjs';
import { loadConfig } from '../src/aihot.mjs';

const cfg = loadConfig();
const TARGET = Number(process.argv[2] || 150);
const { browser, ctx } = await connect(cfg);
const page = await workPage(ctx);

await page.goto('https://x.com/SeanInAI111', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(6000);

const posts = new Map();
let stagnant = 0;

for (let round = 0; round < 80 && posts.size < TARGET && stagnant < 8; round++) {
  const data = await page.evaluate(() => {
    const out = [];
    for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
      const link = art.querySelector('a[href*="/status/"]');
      const who = art.querySelector('[data-testid="User-Name"]');
      const textNode = art.querySelector('[data-testid="tweetText"]');
      const time = art.querySelector('time');
      const group = art.querySelector('[role="group"]');
      if (!link || !who) continue;
      const href = link.getAttribute('href') || '';
      const m = href.match(/\/status\/(\d+)/);
      if (!m) continue;
      out.push({
        id: m[1],
        author: who.innerText || '',
        text: textNode ? textNode.innerText : '',
        when: time ? time.getAttribute('datetime') : null,
        metrics: group ? (group.getAttribute('aria-label') || '') : '',
        url: 'https://x.com' + href,
        hasQuote: !!art.querySelector('[data-testid="quoteTweet"]'),
        isReply: /Replying to/.test(art.innerText),
      });
    }
    return out;
  });

  const before = posts.size;
  for (const p of data) {
    if (!p.author.includes('@SeanInAI111')) continue;
    if (posts.has(p.id)) continue;
    posts.set(p.id, p);
  }
  if (posts.size === before) stagnant++; else stagnant = 0;
  await page.mouse.wheel(0, 2800);
  await page.waitForTimeout(2200);
}

const all = [...posts.values()];
writeFileSync(resolve('queue/my-posts.json'), JSON.stringify(all, null, 2), 'utf8');
const withText = all.filter((p) => p.text && p.text.trim().length > 2);
console.log(`Collected ${all.length} posts (${withText.length} with text) -> queue/my-posts.json`);
console.log('\n--- sample ---');
for (const p of withText.slice(0, 12)) {
  const date = (p.when || '').slice(0, 10);
  console.log(`[${date}]${p.hasQuote ? ' [quote]' : ''}${p.isReply ? ' [reply]' : ''} ${(p.text || '').replace(/\n/g, ' / ').slice(0, 120)}`);
}
await closeBrowser(browser);
