// X keyword search. Read-only.
// Extraction equivalent to findTweetByQuery in src/xbot.mjs: same
// https://x.com/search?q=...&f=live form, same article[data-testid="tweet"]
// reading, same socialContext skip, same like parsing via parse-count.mjs.
import { appendLog } from '../log.mjs';
import { parseLikeCount } from '../parse-count.mjs';
import { detectLang } from './lang.mjs';

export async function searchTweets(page, { cfg, keywords = [], limit = 20 } = {}) {
  const out = [];
  for (const kw of keywords) {
    if (out.length >= limit) break;
    // x.com search query language constraint (T1-b): explicit per seed.
    const lang = detectLang(kw);
    const q = kw + (lang === 'zh' ? ' lang:zh' : ' lang:en');
    const url = 'https://x.com/search?q=' + encodeURIComponent(q) + '&src=typed_query&f=live';
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(5000); // matches findTweetByQuery's settle time

      const found = await page.evaluate(() => {
        const rows = [];
        for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
          // socialContext marks "recommended"/"followed" rows, not real hits.
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
      });

      const now = Date.now();
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
          source: 'x-search',
          origin: r.url,
          keyword: kw,
        });
        if (out.length >= limit) break;
      }
    } catch (e) {
      appendLog('search "' + kw + '" failed: ' + e.message);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return out;
}