// Comment-section discovery for the growth lane (涨粉).
// Read-only: opens a status page, extracts the commenters below it, then the
// caller re-verifies each handle on their profile page before anything else.
// Same extraction selectors as timeline.mjs / search.mjs:
//   article[data-testid="tweet"] ; [data-testid="User-Name"] -> @handle line;
//   [data-testid="icon-verified"] -> verified.
// canFollow is an optional signal ONLY (X renders the follow button only on
// hover, so a missing button means nothing) — it is never a gate. Whether the
// account is already followed is decided by follow() on the profile page.
import { appendLog } from '../log.mjs';

const HANDLE_RE = /^[a-z0-9_]{1,15}$/;

function cleanHandle(raw) {
  const h = String(raw == null ? '' : raw).trim().replace(/^@/, '').toLowerCase();
  return h;
}

// 'https://x.com/<handle>/status/<id>' -> '<handle>', '' when not parseable.
export function handleFromStatusUrl(url) {
  try {
    const m = /\/status\/\d+$/.exec(String(url || '').split('?')[0]);
    if (!m) return '';
    const before = String(url || '').split('?')[0].slice(0, m.index);
    const seg = before.split('/').filter(Boolean).pop() || '';
    return cleanHandle(seg);
  } catch {
    return '';
  }
}

// Pure extraction/dedupe/filter step. Rows are [{handle, verified, canFollow}].
// Returns [{author, verified, canFollow}] with bad handles dropped, duplicates
// merged (first occurrence wins), and the thread owner / my own handle removed.
// Never throws: bad input just yields [].
export function extractCommenters(rows, { selfHandle, myHandle } = {}) {
  if (!Array.isArray(rows)) return [];
  const skip = new Set();
  const self = cleanHandle(selfHandle);
  if (self) skip.add(self);
  const me = cleanHandle(myHandle);
  if (me) skip.add(me);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    try {
      const author = cleanHandle(r && r.handle);
      if (!HANDLE_RE.test(author)) continue;
      if (skip.has(author)) continue;
      if (seen.has(author)) continue;
      seen.add(author);
      out.push({
        author,
        verified: !!(r && r.verified),
        canFollow: !!(r && r.canFollow),
      });
    } catch {
      // One bad row must not break the whole batch.
    }
  }
  return out;
}

// I/O wrapper: goto(status page) -> settle -> evaluate comment rows ->
// extractCommenters. Degrades on ANY failure: logs and returns [] — never
// throws, never touches the candidate pool.
export async function collectCommentersFromPost(page, url, { selfHandle, myHandle, maxPerPost = 8 } = {}) {
  try {
    if (!page || typeof page.goto !== 'function' || typeof page.evaluate !== 'function') {
      appendLog('commenters: collect skipped (no usable page)');
      return [];
    }
    const owner = selfHandle || handleFromStatusUrl(url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000); // matches timeline/search settle time
    const raw = await page.evaluate(() => {
      const rows = [];
      const arts = document.querySelectorAll('article[data-testid="tweet"]');
      for (let i = 1; i < arts.length; i++) {
        const art = arts[i];
        const nameBox = art.querySelector('[data-testid="User-Name"]');
        const handle = nameBox ? ((nameBox.innerText || '').split('\n').find((l) => l.trim().startsWith('@')) || '').trim() : '';
        if (!handle) continue;
        rows.push({
          handle,
          verified: !!art.querySelector('[data-testid="icon-verified"]'),
          canFollow: !!art.querySelector('button[data-testid$="-follow"]'),
        });
      }
      return rows;
    });
    const list = extractCommenters(raw, { selfHandle: owner, myHandle });
    const n = Number(maxPerPost);
    const capped = Number.isFinite(n) && n > 0 ? list.slice(0, n) : list;
    appendLog('commenters: collected ' + capped.length + ' from ' + url);
    return capped;
  } catch (e) {
    appendLog('commenters: collect failed ' + url + ' (' + (e && e.message ? e.message : e) + ')');
    return [];
  }
}