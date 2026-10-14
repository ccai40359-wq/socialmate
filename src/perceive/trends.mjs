// X trend collection. Read-only, best-effort: a layout change returns [].
import { appendLog } from '../log.mjs';

export async function collectTrends(page, { cfg, limit = 20 } = {}) {
  await page.goto('https://x.com/explore/tabs/trending', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(5000);

  const raw = await page.evaluate(() => {
    const out = [];
    // Trend rows carry a testid and a "N posts" style meta line.
    for (const el of document.querySelectorAll('[data-testid="trend"]')) {
      const text = (el.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
      if (text.length < 2) continue;
      const meta = text.find((l) => /posts?|条帖子|帖子|趋势/i.test(l)) || '';
      const body = text.filter((l) => l !== meta && !/^(Trending|Trending in|现在趋势)/i.test(l));
      const title = body[body.length - 1] || text[0];
      if (!title) continue;
      const link = el.querySelector('a[href]');
      out.push({
        title,
        meta,
        url: link ? new URL(link.getAttribute('href'), 'https://x.com').href : 'https://x.com/explore/tabs/trending',
      });
    }
    return out;
  }).catch((e) => { appendLog('trends evaluate failed: ' + e.message); return []; });

  const cleaned = [];
  for (const t of raw) {
    if (/promoted|推广|广告/i.test(t.meta)) continue;
    cleaned.push({
      text: t.title,
      title: t.title,
      author: '',
      likes: null,
      ageHours: 1,
      url: t.url,
      lang: /[\u4e00-\u9fa5]/.test(t.title) ? 'zh' : 'en',
      source: 'x-trend',
      origin: null,
    });
    if (cleaned.length >= limit) break;
  }
  return cleaned;
}
