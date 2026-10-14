// Contact fetch (main-session glue): on-demand, single-lead only.
// Opens ONE profile page in the real browser to read a bio, extracts
// contacts, closes the tab. Bulk profile crawling is forbidden by design.
import { loadConfig } from '../aihot.mjs';
import { connect, closeBrowser } from '../edge.mjs';
import { extractContacts } from './contact.mjs';

export async function fetchLeadContacts(lead, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  let browser = null;
  let page = null;
  try {
    const { getAdapter } = await import('./adapters/index.mjs');
    const adapter = await getAdapter(lead.platform);
    if (!adapter || typeof adapter.fetchProfileContacts !== 'function') {
      return { contacts: [], warning: 'no-contact-adapter:' + lead.platform };
    }
    const conn = await connect(cfg);
    browser = conn.browser;
    page = await conn.ctx.newPage();
    const out = await adapter.fetchProfileContacts(page, lead, { cfg });
    const contacts = Array.isArray(out?.contacts) ? out.contacts : [];
    return { contacts: normalize(contacts), warning: out?.warning };
  } catch (e) {
    // Browser offline must not 500 the UI: return an explicit empty result.
    return { contacts: [], warning: 'browser-unavailable: ' + e.message };
  } finally {
    if (page) { try { await page.close(); } catch {} }
    if (browser) { try { await closeBrowser(browser); } catch {} }
  }
}

// If an adapter only returns a raw bio string, run the pure extractor here so
// every adapter does not have to. Keeps contact.mjs the single source of truth.
export function normalize(list) {
  const out = [];
  for (const c of list || []) {
    if (c && c.kind && c.value) { out.push({ kind: c.kind, value: c.value, source: c.source || 'bio' }); continue; }
    if (typeof c === 'string') out.push(...extractContacts(c));
  }
  return dedupe(out);
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((c) => {
    const k = c.kind + ':' + c.value;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

