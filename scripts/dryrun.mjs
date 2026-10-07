// Full pipeline rehearsal: no submissions. Verifies login, content, and both
// action paths (post + quote) up to the moment before clicking Post.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connect, workPage, closeBrowser } from '../src/edge.mjs';
import { verify, dismissComposer, SEL } from '../src/xbot.mjs';
import { buildPost, buildQuoteComment, xOriginalOf, keywordsFor } from '../src/planner.mjs';
import { loadConfig } from '../src/aihot.mjs';

const cfg = loadConfig();
const pool = JSON.parse(readFileSync(resolve('queue/internal-links.json'), 'utf8'));
const { browser, ctx } = await connect(cfg);
const page = await workPage(ctx);

const who = await verify(page).catch((e) => 'ERR ' + e.message);
console.log('[1] account:', who);

const picks = [pool[0], pool[Math.floor(pool.length / 2)], pool[pool.length - 1]];
console.log('[2] content preview');
for (const it of picks) {
  console.log('   post  :', buildPost(it).replace(/\n/g, ' | ').slice(0, 130));
  console.log('   quote :', buildQuoteComment(it).slice(0, 110));
  console.log('   x-src :', xOriginalOf(it) || '(search fallback)');
}

const quoteable = pool.filter(xOriginalOf);
const item = quoteable[0];
console.log('[3] quote path rehearsal ->', xOriginalOf(item));
await page.goto(xOriginalOf(item), { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(4000);
await page.locator(SEL.retweet).first().click({ timeout: 12000 });
await page.waitForTimeout(1200);
await page.locator(SEL.menuItem).filter({ hasText: /^Quote$/i }).first().click({ timeout: 8000 });
await page.waitForTimeout(2500);
const ed = page.locator(SEL.editor).first();
await ed.click({ timeout: 10000 });
await page.keyboard.insertText(buildQuoteComment(item));
await page.waitForTimeout(800);
console.log('   post btn aria-disabled =', await page.locator(SEL.postButton).last().getAttribute('aria-disabled'));

console.log('[4] post path rehearsal');
await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(3000);
await page.locator(SEL.composeEntry).first().click({ timeout: 12000 });
await page.waitForTimeout(1800);
const ed2 = page.locator(SEL.editor).first();
await ed2.click({ timeout: 10000 });
await page.keyboard.insertText(buildPost(item));
await page.waitForTimeout(800);
console.log('   post btn aria-disabled =', await page.locator(SEL.postButton).last().getAttribute('aria-disabled'));

console.log('[5] cleanup');
await page.keyboard.press('Escape');
await page.waitForTimeout(1500);
const c = page.locator(SEL.confirmSheet).first();
if (await c.isVisible({ timeout: 3000 }).catch(() => false)) { await c.click(); console.log('   draft discarded'); }
await page.waitForTimeout(800);
console.log('   modal composer left:', await page.locator(SEL.modalEditor).count());
await closeBrowser(browser);
console.log('REHEARSAL DONE (nothing was posted)');
