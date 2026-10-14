// X home / following timeline collection. Read-only.
// Same extraction approach as search.mjs: article[data-testid="tweet"],
// socialContext skip, parse-count for likes. Sources are exact:
// 'x-home' for For You, 'x-following' for the following feed.
// This layer NEVER publishes: it only reads timelines and returns candidates.
import { appendLog } from '../log.mjs';
import { parseLikeCount } from '../parse-count.mjs';
import { detectLang } from './lang.mjs';
import { normalizeCandidate } from './index.mjs';

// x-home = the For You tab, x-following = the Following tab. Both live on
// https://x.com/home and are switched by clicking a role="tab" — navigating
// to https://x.com/following does NOT open the following FEED, it redirects
// to the "people you follow" directory page (0 tweets), which silently left
// half of the interaction pool empty. Verified live: /following redirects to
// /<handle>/following with 0 articles; clicking the tab on /home yields 8.
const URLS = [
  ['https://x.com/home', 'x-home', null],
  ['https://x.com/home', 'x-following', 'Following'],
];

async function readTweets(page, url, source, limit, tabLabel = null) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(5000); // matches search/trends settle time

  // Switching to a non-default tab (Following) is a click, not a URL. Failures
  // are non-fatal: the default tab's rows are simply returned instead.
  if (tabLabel) {
    try {
      const tab = page.locator('[role="tab"]', { hasText: tabLabel }).first();
      if (await tab.count()) {
        await tab.click({ timeout: 10000 });
        await page.waitForTimeout(5000);
      } else {
        appendLog(`timeline ${source}: tab "${tabLabel}" not found; using default feed`);
      }
    } catch (e) {
      appendLog(`timeline ${source}: tab switch failed (${e.message}); using default feed`);
    }
  }

  const found = await page.evaluate(() => {
    const rows = [];
    for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
      if (art.querySelector('[data-testid="socialContext"]')) continue;
      const link = art.querySelector('a[href*="/status/"]');
      if (!link) continue;
      const href = link.getAttribute('href') || '';
      if (!/^\/[^/]+\/status\/\d+$/.test(href)) continue;
      const textNode = art.querySelector('[data-testid="tweetText"]');
      const who = art.querySelector('[data-testid="User-Name"]');
      const time = art.querySelector('time');
      const likeBtn = art.querySelector('[data-testid="like"]');
      rows.push({
        text: textNode ? textNode.innerText : '',
        author: who ? ((who.innerText || '').split('\n').find((l) => l.trim().startsWith('@')) || '').trim() : '',
        likesLabel: likeBtn ? (likeBtn.getAttribute('aria-label') || '') : '',
        when: time ? time.getAttribute('datetime') : null,
        href,
        url: 'https://x.com' + href,
      });
    }
    return rows;
  }).catch((e) => { appendLog(`timeline evaluate failed (${source}): ${e.message}`); return []; });

  const now = Date.now();
  const out = [];
  for (const r of found) {
    if (!r.text || !r.text.trim()) continue;
    const ageHours = r.when ? Math.max(0, (now - new Date(r.when).getTime()) / 3600000) : null;
    out.push({
      text: r.text,
      author: r.author,
      likes: parseLikeCount(r.likesLabel),
      ageHours: ageHours == null ? null : Math.round(ageHours * 10) / 10,
      url: r.url,
      lang: detectLang(r.text),
      source,
      origin: r.url,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export async function collectTimeline(page, { cfg, limit = 20 } = {}) {
  const out = [];
  for (const [url, source, tabLabel] of URLS) {
    if (out.length >= limit) break;
    try {
      const rows = await readTweets(page, url, source, limit - out.length, tabLabel);
      appendLog(`timeline ${source}: ${rows.length}`);
      // T2-d: every timeline candidate goes through the shared normalizer.
      for (const r of rows) out.push(normalizeCandidate(r, source));
    } catch (e) {
      appendLog(`timeline ${source} failed: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return out;
}
