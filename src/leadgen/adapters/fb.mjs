// Facebook posts-search collector. Read-only. Signed-out visits usually land
// on a login wall; detectBlock covers the signed-out case and we return [].
import { thinkPause, scrollWarmup } from '../../humanize.mjs';
import { detectBlock } from '../../safety.mjs';

export const platform = 'fb';
export const label = 'Facebook';
export let lastError = null;

const SELECTORS = {
  postCard: 'article[role="article"]',
  postLink: 'a[href*="/posts/"]',
  authorLink: 'a[href*="/profile.php"], a[role="link"]',
  postText: 'div[dir="auto"]',
  postedAt: 'span[style*="color"], abbr',
  profileBio: 'div[data-nosnippet]',
};

const LOGIN_WALL_RE = /log into Facebook|登录 Facebook|You must log in|请先登录/i;

function isLoginWall(bodyText) {
  return LOGIN_WALL_RE.test(bodyText || '');
}

function abs(href) {
  if (!href) return '';
  if (/^https?:\/\//i.test(href)) return href;
  return 'https://www.facebook.com' + href;
}

async function readPosts(page, keyword, maxPosts) {
  const out = [];
  const collectedAt = new Date().toISOString();
  for (let i = 0; i < maxPosts * 2; i++) {
    const card = page.locator(SELECTORS.postCard).nth(i);
    const text = await card.locator(SELECTORS.postText).first().innerText({ timeout: 1000 }).catch(() => '');
    if (!text || !text.trim()) break;
    const linkHref = await card.locator(SELECTORS.postLink).first().getAttribute('href', { timeout: 1000 }).catch(() => '');
    if (!linkHref) continue;
    const authorHref = await card.locator(SELECTORS.authorLink).first().getAttribute('href', { timeout: 1000 }).catch(() => '');
    const when = await card.locator(SELECTORS.postedAt).first().getAttribute('datetime', { timeout: 500 }).catch(() => '');
    out.push({
      platform,
      postUrl: abs(linkHref),
      author: authorHref ? decodeURIComponent(authorHref.split('?')[0].replace(/^\/profile\.php\?id=/, '').replace(/^\//, '')) : '',
      authorUrl: authorHref ? abs(authorHref) : '',
      text: text.trim(),
      postedAt: when || undefined,
      keyword,
      collectedAt,
    });
    if (out.length >= maxPosts) break;
  }
  return out;
}

export async function collect(page, opts = {}) {
  const cfg = opts.cfg || {};
  const maxPosts = opts.maxPosts || cfg.leadgen?.maxPostsPerKeyword || 20;
  lastError = null;
  const url = 'https://www.facebook.com/search/posts/?q=' + encodeURIComponent(opts.keyword || '');
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector(SELECTORS.postCard, { timeout: 15000 }).catch(() => {});
    const blocked = await detectBlock(page);
    if (blocked.blocked) { lastError = 'blocked: ' + blocked.reason; return []; }

    const cardCount = await page.locator(SELECTORS.postCard).count().catch(() => 0);
    if (cardCount === 0) {
      const bodyText = await page.locator('body').innerText({ timeout: 8000 }).catch(() => '');
      if (isLoginWall(bodyText)) { lastError = 'blocked: signed-out'; return []; }
    }

    const rounds = Math.max(1, Math.min(4, Math.ceil(maxPosts / 8)));
    for (let i = 0; i < rounds; i++) {
      await scrollWarmup(page, { cfg });
      await thinkPause(page, { cfg });
    }
    return await readPosts(page, opts.keyword || '', maxPosts);
  } catch (e) {
    lastError = 'collect-error: ' + e.message;
    return [];
  }
}

export async function fetchProfileContacts(page, lead, opts = {}) {
  const cfg = opts.cfg || {};
  try {
    if (!lead?.authorUrl) return { contacts: [] };
    await page.goto(lead.authorUrl, { waitUntil: 'domcontentloaded', timeout: cfg.leadgen?.fetchProfileTimeoutMs || 20000 });
    await page.waitForSelector(SELECTORS.profileBio, { timeout: 15000 }).catch(() => {});
    const blocked = await detectBlock(page);
    if (blocked.blocked) return { contacts: [], warning: 'blocked: ' + blocked.reason };
    const profileText = await page.locator(SELECTORS.profileBio).first().innerText({ timeout: 8000 }).catch(() => '');
    const { extractContacts } = await import('../contact.mjs');
    return { contacts: extractContacts(profileText) };
  } catch (e) {
    return { contacts: [], warning: 'profile-read-error: ' + e.message };
  }
}