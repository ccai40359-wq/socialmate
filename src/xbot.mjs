// x.com automation over the CDP-attached Edge instance.
// Selectors verified live against the signed-in session.
// Behaviour is humanised (per-character typing, warmup) and every action
// checks for a block first so the scheduler can pause instead of hammering.
import { appendLog } from './log.mjs';
import { parseLikeCount } from './parse-count.mjs';

let humanize = null;
try { humanize = await import('./humanize.mjs'); } catch { humanize = null; }
let safety = null;
try { safety = await import('./safety.mjs'); } catch { safety = null; }

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
  mask: '[data-testid="mask"]',
};

async function gotoHome(page) {
  if (!/\/home/.test(page.url())) {
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  await page.waitForTimeout(2500);
}

// X renders its own failure page ("Something went wrong. Try reloading.") when
// a request dies server-side. A reload is the only recovery, and posting into
// that state just burns the click.
async function pageIsBroken(page) {
  return page.evaluate(() => /Something went wrong/i.test(document.body.innerText || '')).catch(() => false);
}

// Count visible overlays. A composer left behind by a failed submit keeps a
// full-screen mask with pointer-events:auto on top of the page, which silently
// swallows every later click (observed: SideNav_NewTweet_Button timeouts).
// NOTE: /home always renders an EMPTY inline composer, so an editor is only
// evidence of a leftover when it actually holds text.
async function overlayState(page) {
  return page.evaluate((sel) => {
    const visible = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      return el.getBoundingClientRect().width > 0;
    };
    const masks = [...document.querySelectorAll(sel.mask)].filter(visible).length;
    const editors = [...document.querySelectorAll(sel.editor)];
    const editorsWithText = editors.filter((e) => (e.innerText || '').trim().length > 0).length;
    return { masks, editors: editors.length, editorsWithText };
  }, { mask: SEL.mask, editor: SEL.editor }).catch(() => ({ masks: 0, editors: 0, editorsWithText: 0 }));
}

// Tear down a stale composer/overlay before doing anything else. Best-effort:
// it must never throw, because it runs as part of unattended publishing.
async function clearStaleComposer(page) {
  const { masks, editors, editorsWithText } = await overlayState(page);
  if (masks === 0 && editorsWithText === 0) return false;
  const close = page.locator(SEL.appBarClose).first();
  if (await close.isVisible({ timeout: 3000 }).catch(() => false)) {
    await close.click({ timeout: 8000 }).catch(() => {});
  } else {
    await page.keyboard.press('Escape').catch(() => {});
  }
  await page.waitForTimeout(1200);
  const confirm = page.locator(SEL.confirmSheet).first();
  if (await confirm.isVisible({ timeout: 2000 }).catch(() => false)) {
    await confirm.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
  }
  let after = await overlayState(page);
  if (after.masks > 0 || after.editorsWithText > 0) {
    // The close button did not take (X's own error page does this). A fresh
    // document is the reliable way out; it also clears the mask.
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
    after = await overlayState(page);
  }
  appendLog(`xbot: stale composer cleared (masks ${masks}->${after.masks}, editors ${editors}->${after.editors})`);
  return after.masks === 0 && after.editorsWithText === 0;
}

async function assertLoggedIn(page) {
  await gotoHome(page);
  const login = await page.locator(SEL.loginLink).first().isVisible({ timeout: 3000 }).catch(() => false);
  if (login) throw new Error('Not signed in on x.com');
}

// Throw a recognisable, tagged error when x.com is blocking us.
async function guard(page) {
  if (!safety?.detectBlock) return;
  const b = await safety.detectBlock(page).catch(() => ({ blocked: false }));
  if (b.blocked) {
    appendLog('xbot: blocked (' + b.reason + ')');
    const err = new Error('blocked: ' + b.reason);
    err.blocked = true;
    err.reason = b.reason;
    throw err;
  }
}

async function humanWarmup(page) {
  if (!humanize) return;
  await humanize.scrollWarmup(page).catch(() => {});
  await humanize.thinkPause(page).catch(() => {});
}

// Normalise for comparison only: X's editor renders the same prose with
// different whitespace than the string we handed it.
function normTyped(s) { return String(s || '').replace(/\s+/g, '').trim(); }

async function typeInto(page, text) {
  const modal = page.locator(SEL.modalEditor);
  const editor = (await modal.count()) > 0 ? modal.first() : page.locator(SEL.editor).first();
  await editor.waitFor({ state: 'visible', timeout: 15000 });
  if (humanize?.typeHuman) {
    try {
      await humanize.typeHuman(page, editor, text);
    } catch (e) {
      appendLog('humanize.typeHuman failed (' + e.message + '); falling back to insertText');
      await editor.click({ timeout: 10000 });
      await page.keyboard.insertText(text);
    }
  } else {
    await editor.click({ timeout: 10000 });
    await page.waitForTimeout(300);
    await page.keyboard.insertText(text);
  }
  await page.waitForTimeout(600);

  // Integrity check. Per-character typing (the humanisation) is driven by X's
  // React editor and drops characters on long bodies — observed live: a 383-char
  // post published as 326 chars ("不是新东西，但愿意花" arrived as "不是东，但愿花")
  // and its trailing emoji vanished. A post whose sentence is silently corrupted
  // is worse than no post, so the typed result is verified and, on mismatch,
  // repaired atomically (select-all + insertText), which lands the exact string.
  const want = normTyped(text);
  let got = normTyped(await editor.innerText().catch(() => ''));
  if (got !== want) {
    appendLog(`xbot: typed text mismatch (want ${want.length} chars, got ${got.length}); repairing atomically`);
    await editor.click({ timeout: 10000 }).catch(() => {});
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await page.waitForTimeout(250);
    await page.keyboard.insertText(text);
    await page.waitForTimeout(500);
    got = normTyped(await editor.innerText().catch(() => ''));
    appendLog(`xbot: after repair got ${got.length} chars (${got === want ? 'match' : 'STILL MISMATCH'})`);
  }
  return editor;
}

// X's compose surface is either an in-page dialog (home) or the standalone
// /compose/post route. The old check only looked at the dialog, so a standalone
// composer was never detected as "still open". The reliable signal for BOTH is
// whether our text is still sitting in a composer, so we compare content.
async function composerStillHolds(page, text) {
  return page.evaluate((t) => {
    const boxes = [...document.querySelectorAll('[data-testid="tweetTextarea_0"]')];
    if (!boxes.length) return false;
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const want = norm(t).slice(0, 40);
    if (!want) return boxes.length > 0;
    return boxes.some((b) => norm(b.innerText).includes(want));
  }, text).catch(() => false);
}

async function submitPost(page, text) {
  const btn = page.locator(SEL.postButton).last();
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  const disabled = await btn.getAttribute('aria-disabled');
  if (disabled === 'true') throw new Error('Post button disabled; content may be rejected or already empty');
  await btn.click({ timeout: 10000 });
  await page.waitForTimeout(5000);
  if (await composerStillHolds(page, text)) {
    const toast = await page.locator(SEL.toast).first().innerText({ timeout: 2000 }).catch(() => '');
    return { ok: false, toast };
  }
  return { ok: true };
}

// Submit, recovering from X's own error page. Safe against double-posting: a
// successful submit always clears the composer, so "text still in the box" is
// the only signal we ever retry on. A reload that drops the text aborts rather
// than guessing — the draft stays queued for a human instead.
async function clickPost(page, text) {
  let last = { ok: false, toast: '' };
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (await pageIsBroken(page)) {
      appendLog(`xbot: page reports "Something went wrong"; reloading before submit (attempt ${attempt})`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(3000);
      if (!(await composerStillHolds(page, text))) {
        throw new Error('Composer lost after reload; page was in an error state.');
      }
    }
    last = await submitPost(page, text);
    if (last.ok) return;
    if (attempt === 1) {
      appendLog('xbot: submit did not clear the composer; reloading and retrying once' + (last.toast ? ' (toast: ' + last.toast + ')' : ''));
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(3000);
      if (!(await composerStillHolds(page, text))) {
        throw new Error('Composer lost after reload; submit never landed.');
      }
    }
  }
  throw new Error('Composer still open after submit.' + (last.toast ? ' Toast: ' + last.toast : ''));
}

// Open the composer, type, submit — with one full retry that re-opens and
// re-types if the first attempt lost the draft. Used by post() where re-typing
// is cheap; quote() keeps the conservative clickPost() because re-opening a
// quote composer means redoing the retweet menu.
async function composeAndSubmit(page, text) {
  let last = { ok: false, toast: '' };
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (await pageIsBroken(page)) {
      appendLog(`xbot: page reports "Something went wrong"; reloading before compose (attempt ${attempt})`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
    if (!(await composerStillHolds(page, text))) {
      await clearStaleComposer(page);
      await page.locator(SEL.composeEntry).first().click({ timeout: 15000 });
      await page.waitForTimeout(1800);
      await typeInto(page, text);
    }
    last = await submitPost(page, text);
    if (last.ok) return;
    if (attempt < 2) {
      appendLog('xbot: submit did not clear the composer; retrying once' + (last.toast ? ' (toast: ' + last.toast + ')' : ''));
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
  }
  throw new Error('Composer still open after submit.' + (last.toast ? ' Toast: ' + last.toast : ''));
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
  await guard(page);
  await humanWarmup(page);
  await composeAndSubmit(page, text);
  appendLog('POST ok :: ' + text.slice(0, 70).replace(/\s+/g, ' '));
}

export async function quote(page, tweetUrl, comment) {
  await guard(page);
  await humanWarmup(page);
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
  await clickPost(page, comment);
  appendLog('QUOTE ok :: ' + tweetUrl + ' :: ' + comment.slice(0, 50).replace(/\s+/g, ' '));
}

export async function reply(page, tweetUrl, text) {
  await guard(page);
  await humanWarmup(page);
  await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3500);
  const box = page.locator(SEL.editor).first();
  await box.waitFor({ state: 'visible', timeout: 12000 });
  if (humanize?.typeHuman) {
    try {
      await humanize.typeHuman(page, box, text);
    } catch {
      await box.click({ timeout: 10000 });
      await page.keyboard.insertText(text);
    }
  } else {
    await box.click({ timeout: 10000 });
    await page.waitForTimeout(400);
    await page.keyboard.insertText(text);
  }
  await page.waitForTimeout(600);
  const btn = page.locator(SEL.postButtonInline).last();
  const target = (await btn.isVisible({ timeout: 3000 }).catch(() => false)) ? btn : page.locator(SEL.postButton).last();
  await target.click({ timeout: 10000 });
  await page.waitForTimeout(4000);
  appendLog('REPLY ok :: ' + tweetUrl + ' :: ' + text.slice(0, 50).replace(/\s+/g, ' '));
}

export async function like(page, tweetUrl) {
  await guard(page);
  await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  const btn = page.locator('[data-testid="like"]').first();
  // P0 (engage-reliability): isVisible({timeout}) does NOT poll — it answered
  // "not visible" immediately while the SPA was still mounting, which is what
  // produced `LIKE skip :: button not found` in the live log. Poll by hand
  // until the button mounts (or the budget runs out).
  let found = false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    found = await btn.isVisible().catch(() => false);
    if (found) break;
    await page.waitForTimeout(300);
  }
  if (found) {
    await btn.click();
    await page.waitForTimeout(1200);
    appendLog('LIKE ok :: ' + tweetUrl);
    return true;
  }
  appendLog('LIKE skip :: button not found ' + tweetUrl);
  return false;
}

// Follow a BlueV growth target (涨粉 lane). Follow is a write action, so it
// starts with the same block guard as like() and the caller (growthFollowRound)
// only invokes it when resolveGate says this invocation may publish.
export async function follow(page, handleOrUrl) {
  await guard(page);
  const raw = String(handleOrUrl || '').trim();
  const m = raw.match(/(?:^|\/)@?([A-Za-z0-9_]{1,15})(?:\/|$)/);
  const handle = m ? m[1] : raw.replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//, '').split('/')[0];
  const url = /^https?:/.test(raw) ? raw : 'https://x.com/' + encodeURIComponent(handle);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    appendLog('FOLLOW skip :: navigation failed ' + handle + ' (' + e.message + ')');
    return { ok: false, reason: 'no-button' };
  }
  await page.waitForTimeout(3500);

  const followSel = 'button[data-testid$="-follow"]';
  const unfollowSel = 'button[data-testid$="-unfollow"]';
  const followBtn = page.locator(followSel).first();
  const unfollowBtn = page.locator(unfollowSel).first();
  let found = false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    found = await followBtn.isVisible().catch(() => false);
    if (found) break;
    found = await unfollowBtn.isVisible().catch(() => false);
    if (found) break;
    await page.waitForTimeout(300);
  }
  if (!found) {
    appendLog('FOLLOW skip :: button not found ' + handle);
    return { ok: false, reason: 'no-button' };
  }
  if (await unfollowBtn.isVisible().catch(() => false)) {
    appendLog('FOLLOW ok :: already following ' + handle);
    return { ok: true, already: true };
  }
  await followBtn.click({ timeout: 10000 });
  await page.waitForTimeout(1500);
  const afterFollow = await page.locator(unfollowSel).first().isVisible({ timeout: 6000 }).catch(() => false);
  if (afterFollow) {
    appendLog('FOLLOW ok :: ' + handle);
    return { ok: true };
  }
  appendLog('FOLLOW skip :: button not found ' + handle);
  return { ok: false, reason: 'no-button' };
}
export async function findTweetByQuery(page, query, opts = {}) {
  const minLikes = opts.minLikes ?? 0;
  const maxScrolls = opts.maxScrolls ?? 3;
  const url = 'https://x.com/search?q=' + encodeURIComponent(query) + '&src=typed_query&f=live';
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

      const likes = await art.locator('[data-testid="like"]').first().getAttribute('aria-label').then(parseLikeCount).catch(() => 0);
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
  const handle = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').first().innerText({ timeout: 8000 }).catch(() => '');
  return handle.replace(/\s+/g, ' ').trim();
}

export { SEL, dismissComposer };
