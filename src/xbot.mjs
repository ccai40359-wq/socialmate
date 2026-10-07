// x.com automation over the CDP-attached Edge instance.
// All selectors below were verified live against the signed-in session.
import { appendLog } from './log.mjs';
import { parseLikeCount } from './parse-count.mjs';

export async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const SEL = {
  composeEntry: '[data-testid="SideNav_NewTweet_Button"]',
  editor: '[data-testid="tweetTextarea_0"]',
  postButton: '[data-testid="tweetButton"]',
  postButtonInline: '[data-testid="tweetButtonInline"]',
  retweet: '[data-testid="retweet"]',
  menuItem: '[role="menuitem"]',
  confirmSheet: '[data-testid="confirmationSheetConfirm"]',
  toast: '[data-testid="toast"]',
  loginLink: 'a[href="/login"]',
  modalEditor: '[role="dialog"] [data-testid="tweetTextarea_0"]',
  appBarClose: '[data-testid="app-bar-close"]',
};

async function gotoHome(page) {
  if (!/\/home/.test(page.url())) {
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  await page.waitForTimeout(2500);
}

async function assertLoggedIn(page) {
  await gotoHome(page);
  const login = await page.locator(SEL.loginLink).first().isVisible({ timeout: 3000 }).catch(() => false);
  if (login) throw new Error('Not signed in on x.com');
}

async function typeInto(page, text) {
  const modal = page.locator(SEL.modalEditor);
  const editor = (await modal.count()) > 0 ? modal.first() : page.locator(SEL.editor).first();
  await editor.waitFor({ state: 'visible', timeout: 15000 });
  await editor.click({ timeout: 10000 });
  await page.waitForTimeout(300);
  await page.keyboard.insertText(text);
  await page.waitForTimeout(600);
  return editor;
}

async function clickPost(page) {
  const btn = page.locator(SEL.postButton).last();
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  const disabled = await btn.getAttribute('aria-disabled');
  if (disabled === 'true') throw new Error('Post button disabled; content may be rejected or already empty');
  await btn.click({ timeout: 10000 });
  await page.waitForTimeout(5000);
  // The home timeline keeps an always-visible inline composer, so verify the
  // modal composer is gone rather than any composer.
  const modalLeft = await page.locator(SEL.modalEditor).count();
  if (modalLeft > 0) {
    const toast = await page.locator(SEL.toast).first().innerText({ timeout: 2000 }).catch(() => '');
    throw new Error(`Composer still open after submit. ${toast ? 'Toast: ' + toast : ''}`.trim());
  }
}

async function dismissComposer(page) {
  const before = await page.locator(SEL.modalEditor).count();
  if (before === 0) return false;
  const close = page.locator(SEL.appBarClose).first();
  if (await close.isVisible({ timeout: 3000 }).catch(() => false)) {
    await close.click({ timeout: 8000 }).catch(() => {});
  } else {
    await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(1200);
  const confirm = page.locator(SEL.confirmSheet).first();
  if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) {
    await confirm.click();
    await page.waitForTimeout(800);
  }
  await page.waitForTimeout(600);
  return (await page.locator(SEL.modalEditor).count()) === 0;
}

export async function post(page, text) {
  await assertLoggedIn(page);
  await page.locator(SEL.composeEntry).first().click({ timeout: 12000 });
  await page.waitForTimeout(1800);
  await typeInto(page, text);
  await clickPost(page);
  appendLog(`POST ok :: ${text.slice(0, 70).replace(/\s+/g, ' ')}`);
}

export async function quote(page, tweetUrl, comment) {
  await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3500);
  const rt = page.locator(SEL.retweet).first();
  await rt.waitFor({ state: 'visible', timeout: 12000 });
  await rt.click();
  await page.waitForTimeout(1200);
  const quoteItem = page.locator(SEL.menuItem).filter({ hasText: /^Quote$/i }).first();
  await quoteItem.waitFor({ state: 'visible', timeout: 8000 });
  await quoteItem.click();
  await page.waitForTimeout(2500);
  await typeInto(page, comment);
  await clickPost(page);
  appendLog(`QUOTE ok :: ${tweetUrl} :: ${comment.slice(0, 50).replace(/\s+/g, ' ')}`);
}

export async function reply(page, tweetUrl, text) {
  await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3500);
  const box = page.locator(SEL.editor).first();
  await box.waitFor({ state: 'visible', timeout: 12000 });
  await box.click({ timeout: 10000 });
  await page.waitForTimeout(400);
  await page.keyboard.insertText(text);
  await page.waitForTimeout(600);
  const btn = page.locator(SEL.postButtonInline).last();
  const target = (await btn.isVisible({ timeout: 3000 }).catch(() => false)) ? btn : page.locator(SEL.postButton).last();
  await target.click({ timeout: 10000 });
  await page.waitForTimeout(4000);
  appendLog(`REPLY ok :: ${tweetUrl} :: ${text.slice(0, 50).replace(/\s+/g, ' ')}`);
}

export async function like(page, tweetUrl) {
  await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  const btn = page.locator('[data-testid="like"]').first();
  if (await btn.isVisible({ timeout: 8000 }).catch(() => false)) {
    await btn.click();
    await page.waitForTimeout(1200);
    appendLog(`LIKE ok :: ${tweetUrl}`);
    return true;
  }
  appendLog(`LIKE skip :: button not found ${tweetUrl}`);
  return false;
}

export async function findTweetByQuery(page, query, opts = {}) {
  const minLikes = opts.minLikes ?? 0;
  const maxScrolls = opts.maxScrolls ?? 3;
  const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(5000);

  for (let i = 0; i < maxScrolls; i++) {
    const arts = await page.locator('article[data-testid="tweet"]').all();
    for (const art of arts) {
      const social = await art.locator('[data-testid="socialContext"]').count();
      if (social > 0) continue;

      const link = art.locator('a[href*="/status/"]').first();
      const href = await link.getAttribute('href').catch(() => null);
      if (!href || !/^\/[^/]+\/status\/\d+$/.test(href)) continue;

      const likes = await art
        .locator('[data-testid="like"]')
        .first()
        .getAttribute('aria-label')
        .then(parseLikeCount)
        .catch(() => 0);
      if (likes < minLikes) continue;

      const isReply = await art.locator('[data-testid="reply"]').count();
      if (isReply === 0) continue;

      return 'https://x.com' + href;
    }
    await page.mouse.wheel(0, 2200);
    await page.waitForTimeout(2200);
  }
  return null;
}

export async function verify(page) {
  await assertLoggedIn(page);
  const handle = await page
    .locator('[data-testid="SideNav_AccountSwitcher_Button"]')
    .first()
    .innerText({ timeout: 8000 })
    .catch(() => '');
  return handle.replace(/\s+/g, ' ').trim();
}

export { SEL, dismissComposer };
