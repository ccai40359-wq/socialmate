// Follow-back discovery (回关) from the account's own Verified Followers list.
//
// Why this exists: the notifications feed only exposes a SAMPLE of new
// followers. When several people follow at once X renders "Tomson and 34
// others followed you" and the DOM carries links for only ~10 of them, so the
// rest were never discovered and never followed back. The /verified_followers
// page is the authoritative list: every row shows the follow button state and
// a literal "Follows you" badge, which is exactly the condition we want.
//
// Read-only. Degrades to [] on ANY failure so a layout change can never break
// the growth lane (or block the rest of a round).
import { appendLog } from '../log.mjs';

const HANDLE_RE = /^[a-z0-9_]{1,15}$/;

function clean(raw) {
  return String(raw == null ? '' : raw).trim().replace(/^@/, '').toLowerCase();
}

// Pure step: given raw cells [{text, links, verified, needsFollow}], return the
// deduped handles of accounts that (a) follow me and (b) I do NOT follow back
// yet. Never throws; bad input yields [].
export function extractVerifiedFollowBacks(cells, { myHandle } = {}) {
  if (!Array.isArray(cells)) return [];
  const me = clean(myHandle);
  const seen = new Set();
  const out = [];
  for (const c of cells) {
    try {
      if (!c || typeof c !== 'object') continue;
      const text = String(c.text || '');
      // "Follows you" is the badge X renders only when the account follows me.
      if (!/follows you/i.test(text)) continue;
      // An existing "Following" button means we already follow them back.
      if (c.needsFollow !== true) continue;
      const links = Array.isArray(c.links) ? c.links : [];
      let handle = '';
      for (const link of links) {
        const h = clean(String(link || '').replace(/^\//, '').split('/')[0]);
        if (HANDLE_RE.test(h)) { handle = h; break; }
      }
      if (!handle) continue;
      if (me && handle === me) continue;
      if (seen.has(handle)) continue;
      seen.add(handle);
      out.push({ author: handle, verified: c.verified === true, reason: 'follow-back' });
    } catch {
      // one bad cell must not break the batch
    }
  }
  return out;
}

// I/O wrapper: goto(verified_followers) -> settle -> scroll -> evaluate ->
// extract. Same contract as collectFollowBacks: never throws, never writes.
export async function collectVerifiedFollowBacks(page, { myHandle, maxScrolls = 4 } = {}) {
  try {
    const me = clean(myHandle);
    if (!me) { appendLog('verifiedFollowBack: skipped (no myHandle)'); return []; }
    if (!page || typeof page.goto !== 'function' || typeof page.evaluate !== 'function') {
      appendLog('verifiedFollowBack: skipped (no usable page)');
      return [];
    }
    await page.goto(`https://x.com/${encodeURIComponent(me)}/verified_followers`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(7000);
    const seenCells = [];
    const seenKey = new Set();
    for (let i = 0; i < Math.max(1, maxScrolls); i++) {
      const cells = await page.evaluate(() => {
        const out = [];
        for (const c of document.querySelectorAll('[data-testid="UserCell"]')) {
          const text = (c.innerText || '').replace(/\s+/g, ' ');
          // The follow button carries the target's id: <id>-follow when we do
          // NOT follow them yet, <id>-unfollow when we already do.
          const followBtn = c.querySelector('button[data-testid$="-follow"]');
          const unfollowBtn = c.querySelector('button[data-testid$="-unfollow"]');
          if (!followBtn && !unfollowBtn) continue;
          const links = [...c.querySelectorAll('a[href]')]
            .map((a) => a.getAttribute('href') || '')
            .filter((h) => /^\/[A-Za-z0-9_]{1,15}$/.test(h));
          out.push({
            text,
            links,
            verified: !!c.querySelector('[data-testid="icon-verified"]'),
            needsFollow: !!followBtn,
          });
        }
        return out;
      }).catch(() => []);
      for (const c of (Array.isArray(cells) ? cells : [])) {
        const key = Array.isArray(c && c.links) ? c.links.join(',') : '';
        if (!key || seenKey.has(key)) continue;
        seenKey.add(key);
        seenCells.push(c);
      }
      try { if (page.mouse && page.mouse.wheel) await page.mouse.wheel(0, 5000); } catch {}
      await page.waitForTimeout(2200);
    }
    const list = extractVerifiedFollowBacks(seenCells, { myHandle: me });
    appendLog('verifiedFollowBack: ' + list.length + ' candidate(s) from the verified-followers list');
    return list;
  } catch (e) {
    appendLog('verifiedFollowBack: collect failed (' + ((e && e.message) || e) + ')');
    return [];
  }
}