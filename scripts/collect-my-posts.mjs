// Collect my own posts using the canonical tweetText node.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connect, workPage, closeBrowser } from '../src/edge.mjs';
import { loadConfig } from '../src/aihot.mjs';

const cfg = loadConfig();
// Which account to collect. Not hardcoded: pass a handle as argv[3], or set
// SM_HANDLE / config.myHandle in config.json.
const HANDLE = (process.argv[3] || process.env.SM_HANDLE || cfg.myHandle || '').replace(/^@/, '');
if (!HANDLE) {
  console.error('Usage: node scripts/collect-my-posts.mjs [target=150] <handle>');
  console.error('   or: set SM_HANDLE=yourhandle  (or config.myHandle in config.json)');
  process.exit(1);
}
const TARGET = Number(process.argv[2] || 150);
const { browser, ctx } = await connect(cfg);
const page = await workPage(ctx);

await page.goto('https://x.com/' + HANDLE, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(6000);

const posts = new Map();
let stagnant = 0;

for (let round = 0; round < 80 && posts.size < TARGET && stagnant < 8; round++) {
  const data = await page.evaluate(() => {
    const out = [];
    // X renders emoji as <img alt="😭"> inside tweetText. innerText and
    // textContent BOTH skip them, which is how a corpus of 152 posts ended
    // up with zero emoji and the profile wrongly concluded "never uses emoji".
    // Walk the node tree and substitute each emoji image's alt text.
    const tweetTextWithEmoji = (node) => {
      let s = '';
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { s += child.nodeValue; continue; }
        if (child.nodeType !== 1) continue;
        if (child.tagName === 'IMG') { const a = child.getAttribute('alt'); if (a) s += a; continue; }
        if (child.tagName === 'BR') { s += '\n'; continue; }
        s += tweetTextWithEmoji(child);
      }
      return s;
    };
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
        text: textNode ? tweetTextWithEmoji(textNode) : '',
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
    if (!p.author.includes('@' + HANDLE)) continue;
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
