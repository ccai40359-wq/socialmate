// Threads search collector. Read-only: goto the search URL, settle, scroll
// with humanize timing, then extract public posts. No writes, no typing.
import { thinkPause, scrollWarmup } from '../../humanize.mjs';
import { detectBlock } from '../../safety.mjs';

export const platform = 'threads';
export const label = 'Threads';
export let lastError = null;

const SELECTORS = {
  postCard: '[role="article"]',
  authorLink: 'a[href^="/@"]',
  postLink: 'a[href*="/post/"]',
  postText: 'div[dir="auto"]',
  postedAt: 'time',
  profileBio: 'div[dir="auto"]',
};

const LOGIN_WALL_RE = /登录或注册|用 Instagram 登录|Log in or sign up|Log in\b/i;

function isLoginWall(bodyText) {
  return LOGIN_WALL_RE.test(bodyText || '');
}

function abs(href) {
  if (!href) return '';
  if (/^https?:\/\//i.test(href)) return href;
  return 'https://www.threads.com' + href;
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
      author: authorHref ? authorHref.replace(/^\/@/, '@').split('?')[0] : '',
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
  const url = 'https://www.threads.com/search?q=' + encodeURIComponent(opts.keyword || '') + '&serp_type=default';
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