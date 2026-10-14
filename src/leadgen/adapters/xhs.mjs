// Xiaohongshu search collector. Read-only; XHS blocks hardest, so keywords are
// spaced out by collect.mjs and scrolling is slower (extra thinkPause dwell).
import { thinkPause, scrollWarmup } from '../../humanize.mjs';
import { detectBlock } from '../../safety.mjs';

export const platform = 'xhs';
export const label = '小红书';
export let lastError = null;

const SELECTORS = {
  card: 'section.note-item',
  cardFallback: 'a[href*="/explore/"]',
  postLink: 'a[href*="/explore/"]',
  authorLink: 'a[href*="/user/profile/"]',
  postText: 'div[class*="title"], span[class*="title"]',
  postedAt: 'time',
  profileBio: 'div[class*="desc"]',
};

const LOGIN_WALL_RE = /扫码登录|登录后查看|手机号登录|登录小红书|请先登录/i;

function isLoginWall(bodyText) {
  return LOGIN_WALL_RE.test(bodyText || '');
}

function abs(href) {
  if (!href) return '';
  if (/^https?:\/\//i.test(href)) return href;
  return 'https://www.xiaohongshu.com' + href;
}

async function readCards(page, keyword, maxPosts) {
  const out = [];
  const collectedAt = new Date().toISOString();
  const count = Math.min(4, maxPosts);
  for (let i = 0; i < count; i++) {
    const card = page.locator(SELECTORS.card).nth(i);
    let title = await card.locator(SELECTORS.postText).first().innerText({ timeout: 800 }).catch(() => '');
    const linkHref = await card.locator(SELECTORS.postLink).first().getAttribute('href', { timeout: 800 }).catch(() => '');
    if (!linkHref) { const fallback = page.locator(SELECTORS.cardFallback).nth(i); const fh = await fallback.getAttribute('href', { timeout: 800 }).catch(() => ''); if (!fh) continue; out.push(await row(linkHref || fh, title, keyword, collectedAt)); continue; }
    out.push(await row(linkHref, title, keyword, collectedAt));
    if (out.length >= maxPosts) break;
  }
  return out;
}

async function row(linkHref, title, keyword, collectedAt) {
  const authorHref = '';
  const when = '';
  return {
    platform,
    postUrl: abs(linkHref),
    author: authorHref ? authorHref.replace(/^\/user\/profile\//, '').split('?')[0] : '',
    authorUrl: authorHref ? abs(authorHref) : '',
    text: (title || '').trim(),
    postedAt: when || undefined,
    keyword,
    collectedAt,
  };
}

export async function collect(page, opts = {}) {
  const cfg = opts.cfg || {};
  const maxPosts = opts.maxPosts || cfg.leadgen?.maxPostsPerKeyword || 20;
  lastError = null;
  const url = 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(opts.keyword || '') + '&source=web_search_result_notes';
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector(SELECTORS.card, { timeout: 15000 }).catch(() => {});
    const blocked = await detectBlock(page);
    if (blocked.blocked) { lastError = 'blocked: ' + blocked.reason; return []; }

    const cardCount = await page.locator(SELECTORS.card).count().catch(() => 0);
    if (cardCount === 0) {
      const bodyText = await page.locator('body').innerText({ timeout: 8000 }).catch(() => '');
      if (isLoginWall(bodyText)) { lastError = 'blocked: signed-out'; return []; }
    }

    const rounds = Math.max(1, Math.min(4, Math.ceil(maxPosts / 8)));
    for (let i = 0; i < rounds; i++) {
      await scrollWarmup(page, { cfg });
      await thinkPause(page, { cfg });
    }
    return await readCards(page, opts.keyword || '', maxPosts);
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