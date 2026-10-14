// Follow-back discovery (回关). Read-only: opens the notifications page and
// extracts the handles of accounts that followed me, so the growth lane can
// follow them back. Same trailing-slash-free handle links X uses in the feed.
//
// Two notification shapes are covered (both verified live on x.com):
//   "时光兔兔 followed you"                 -> one /<handle> link
//   "Tomson and 34 others followed you"     -> up to 10 /<handle> links
// Aggregated entries only expose a sample of the followers, so this is a
// best-effort discovery source, not an exhaustive list.
import { appendLog } from '../log.mjs';

const HANDLE_RE = /^[a-z0-9_]{1,15}$/;

function clean(raw) {
  return String(raw == null ? '' : raw).trim().replace(/^@/, '').toLowerCase();
}

// Pure step: given raw cells [{text, links:[]}], return the deduped handle list
// of accounts that followed me. Never throws; bad input yields [].
export function extractFollowBacks(cells, { myHandle } = {}) {
  if (!Array.isArray(cells)) return [];
  const me = clean(myHandle);
  const seen = new Set();
  const out = [];
  for (const c of cells) {
    try {
      const text = String((c && c.text) || '');
      if (!/followed you/i.test(text)) continue;
      const links = Array.isArray(c && c.links) ? c.links : [];
      for (const link of links) {
        const h = clean(String(link || '').replace(/^\//, '').split('/')[0]);
        if (!HANDLE_RE.test(h)) continue;
        if (me && h === me) continue;
        if (seen.has(h)) continue;
        seen.add(h);
        out.push({ author: h, reason: 'follow-back' });
      }
    } catch {
      // one bad cell must not break the batch
    }
  }
  return out;
}

// I/O wrapper: goto(notifications) -> settle -> scroll -> evaluate -> extract.
// Degrades on ANY failure (logs + returns []), never throws, never writes.
export async function collectFollowBacks(page, { myHandle, maxScrolls = 8 } = {}) {
  try {
    if (!page || typeof page.goto !== 'function' || typeof page.evaluate !== 'function') {
      appendLog('followBack: collect skipped (no usable page)');
      return [];
    }
    await page.goto('https://x.com/notifications', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(8000);
    const seenCells = [];
    const seenKey = new Set();
    for (let i = 0; i < Math.max(1, maxScrolls); i++) {
      const cells = await page.evaluate(() => {
        const out = [];
        for (const c of document.querySelectorAll('[data-testid="cellInnerDiv"]')) {
          const text = (c.innerText || '').replace(/\s+/g, ' ');
          if (!/followed you/i.test(text)) continue;
          const links = [...c.querySelectorAll('a[href]')]
            .map((a) => a.getAttribute('href') || '')
            .filter((h) => /^\/[A-Za-z0-9_]{1,15}$/.test(h));
          if (links.length) out.push({ text, links });
        }
        return out;
      }).catch(() => []);
      for (const c of (Array.isArray(cells) ? cells : [])) {
        const key = Array.isArray(c && c.links) ? c.links.join(',') : '';
        if (!key || seenKey.has(key)) continue;
        seenKey.add(key);
        seenCells.push(c);
      }
      // Scrolling is best-effort: a mock/limited page may have no mouse, and
      // an already-collected batch must survive that.
      try { if (page.mouse && page.mouse.wheel) await page.mouse.wheel(0, 6000); } catch {}
      await page.waitForTimeout(2000);
    }
    const list = extractFollowBacks(seenCells, { myHandle });
    appendLog('followBack: ' + list.length + ' candidate(s) from notifications');
    return list;
  } catch (e) {
    appendLog('followBack: collect failed (' + ((e && e.message) || e) + ')');
    return [];
  }
}
