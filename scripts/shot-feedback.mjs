// Screenshots the reject-reason picker: the one UI surface the feedback loop
// adds. Seeds a draft (backed up, restored), opens the queue, clicks 丢弃.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
process.chdir(ROOT);
const PORT = 4202;
const OUT = resolve('shots', 'ui');
mkdirSync(OUT, { recursive: true });

const DRAFTS = 'queue/drafts.json';
const backup = existsSync(resolve(DRAFTS)) ? readFileSync(resolve(DRAFTS), 'utf8') : '[]';
writeFileSync(resolve(DRAFTS), JSON.stringify([
  { id: 801, createdAt: new Date().toISOString(), kind: 'post', text: '一条用来演示拒绝理由下拉的草稿：Grok 又又又更新了', title: 'demo' },
], null, 2), 'utf8');

let server = null, browser = null;
const restore = () => { try { writeFileSync(resolve(DRAFTS), backup, 'utf8'); } catch {} };
process.on('exit', restore);
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1); });

const { startServer } = await import('../src/server.mjs');
server = await startServer({ port: PORT });
browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.addInitScript(() => localStorage.setItem('onboarded', '1'));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.click('.nav-item[data-page="queue"]');
await page.waitForSelector('.q-item', { timeout: 10000 });
await page.click('.q-item .btn.ghost'); // 丢弃
await page.waitForSelector('#modal:not([hidden])', { timeout: 5000 });
await page.waitForTimeout(400);

const optionCount = await page.locator('#modalReason option').count();
const visible = await page.locator('#modalReasonWrap').isVisible();
const labels = await page.locator('#modalReason option').allInnerTexts();
await page.screenshot({ path: resolve(OUT, '08-reject-reason.png') });
console.log('modalReasonWrap visible :', visible);
console.log('reason option count     :', optionCount);
console.log('reason labels           :', labels.join(' | '));
console.log('screenshot              : shots/ui/08-reject-reason.png');
console.log(errors.length ? 'PAGE ERRORS: ' + errors.join(' | ') : 'no page errors');

await browser.close();
server.close();
restore();
if (!visible || optionCount < 7) { console.error('FAIL: reason picker missing'); process.exit(1); }
console.log('PASS: reject reason picker rendered');
