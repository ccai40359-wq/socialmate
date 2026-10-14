// Verifies the gate refusal path end-to-end in the renderer: seed an
// over-long draft, click 发布, and confirm a readable refusal toast appears
// and the draft is NOT removed from the queue.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
process.chdir(ROOT);
const DRAFTS = resolve('queue/drafts.json');
const backup = existsSync(DRAFTS) ? readFileSync(DRAFTS, 'utf8') : '[]';
const OUT = resolve('shots', 'ui');
mkdirSync(OUT, { recursive: true });

const restore = () => { try { writeFileSync(DRAFTS, backup, 'utf8'); } catch {} };
process.on('exit', restore);
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1); });
process.on('unhandledRejection', (e) => { restore(); console.error(e); process.exit(1); });

writeFileSync(DRAFTS, JSON.stringify([
  { id: 950, kind: 'post', createdAt: new Date().toISOString(), text: '啊'.repeat(400), title: '闸门拒绝演示' },
], null, 2), 'utf8');

const PORT = 4186;
const { startServer } = await import('../src/server.mjs');
const server = await startServer({ port: PORT });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.click('.nav-item[data-page="queue"]');
await page.waitForSelector('.q-item', { timeout: 10000 });
await page.click('.q-item .btn');
await page.waitForSelector('.toast.err', { timeout: 15000 });
const toast = await page.textContent('.toast.err');
const status = await page.textContent('.q-item .q-status');
await page.screenshot({ path: resolve(OUT, '07-gate-refusal.png') });

console.log('toast  :', toast.trim());
console.log('status :', status.trim());
const readable = /无法发布/.test(toast) && /太长/.test(toast);
const stayed = (await page.$$('.q-item')).length === 1;
console.log(readable ? 'PASS: refusal is human-readable' : 'FAIL: refusal not readable');
console.log(stayed ? 'PASS: refused draft still queued' : 'FAIL: draft disappeared');
console.log(errors.length ? 'PAGE ERRORS: ' + errors.join(' | ') : 'no page errors');

await browser.close();
server.close();
restore();
process.exitCode = readable && stayed && !errors.length ? 0 : 1;
