// Optional RSS/Atom perception layer. Read-only, best-effort.
// DESIGN.md §5: feeds are a fourth, optional layer behind AIHOT / X.
// Built-in fetch only, no dependencies. Every network call is wrapped in
// try/catch with AbortSignal.timeout; a dead feed never breaks collection.
import { appendLog } from '../log.mjs';

// Strip CDATA and XML-ish wrappers from a text node.
function cdata(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

// Resolve relative links against the feed URL itself.
function absUrl(href, base) {
  try { return new URL(href, base).href; } catch { return href; }
}

function ageFromTime(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round(((Date.now() - t) / 3600000) * 10) / 10);
}

function langOf(text) {
  return /[\u4e00-\u9fa5]/.test(text || '') ? 'zh' : 'en';
}

function rssItems(body) {
  const blocks = body.split(/<item[\s>]/i).slice(1);
  const out = [];
  for (const block of blocks) {
    const end = block.indexOf('</item>');
    const seg = end === -1 ? block : block.slice(0, end);
    const title = cdata((seg.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const link = (seg.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || '';
    const date = (seg.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1] || '';
    const text = cdata((seg.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || [])[1] || '');
    if (title && link) out.push({ title, link: link.trim(), published: date.trim(), text });
  }
  return out;
}

function atomItems(body) {
  const blocks = body.split(/<entry[\s>]/i).slice(1);
  const out = [];
  for (const block of blocks) {
    const end = block.indexOf('</entry>');
    const seg = end === -1 ? block : block.slice(0, end);
    const title = cdata((seg.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const link = (seg.match(/<link[^>]*\shref="([^"]+)"/i) || [])[1] || '';
    const date = (seg.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) || [])[1] || '';
    const text = cdata((seg.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || [])[1] || '');
    if (title && link) out.push({ title, link: link.trim(), published: date.trim(), text });
  }
  return out;
}

// Tiny tolerant RSS/Atom parser (regex/string only, no dependencies).
// Returns a normalised array of raw items; a parse failure returns [].
export function parseFeedXml(body) {
  if (!body || typeof body !== 'string') return [];
  const rss = rssItems(body);
  if (rss.length) return rss;
  return atomItems(body);
}

// Normalise one raw feed item into the shared candidate shape.
export function feedCandidate(raw, feedName, feedUrl) {
  const text = (raw.text || raw.title || '').trim();
  const link = raw.link || raw.url || feedUrl || '';
  return {
    text,
    title: (raw.title || '').trim() || text.slice(0, 80),
    author: feedName || '',
    likes: null,
    ageHours: ageFromTime(raw.published),
    url: absUrl(link, feedUrl),
    lang: langOf(text),
    source: 'rss',
    origin: raw.link || null,
  };
}

// Fetch one feed with a timeout; never throws (a dead feed must not break
// collection). Returns [] on any failure.
export async function fetchFeed(cfg, feed) {
  const name = feed.name || feed.url || 'unnamed';
  const url = feed.url || feed;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': cfg.aihotUserAgent || 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    const items = parseFeedXml(body);
    return items.map((raw) => feedCandidate(raw, name, url));
  } catch (e) {
    appendLog(`perceive/rss "${name}" failed: ${e.message}`);
    return [];
  }
}

// Collect from all configured feeds, quota'd by the caller. When cfg.feeds is
// absent this returns [] quietly, exactly as the spec requires.
export async function collectFeeds(cfg, { limit = 10 } = {}) {
  if (!cfg || !Array.isArray(cfg.feeds) || cfg.feeds.length === 0) return [];
  const out = [];
  for (const feed of cfg.feeds) {
    if (out.length >= limit) break;
    const got = await fetchFeed(cfg, feed);
    for (const c of got) {
      out.push(c);
      if (out.length >= limit) break;
    }
  }
  return out;
}
