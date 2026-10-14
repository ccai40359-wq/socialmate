// Renders the four SocialMate pages in a real Chromium and writes PNGs.
// Seeds representative drafts first (backed up, then restored) so the queue
// page shows its real shape instead of an empty state.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
process.chdir(ROOT);
const PORT = 4188;
const OUT = resolve('shots', 'ui');
mkdirSync(OUT, { recursive: true });

const DRAFTS = 'queue/drafts.json';
const backup = existsSync(resolve(DRAFTS)) ? readFileSync(resolve(DRAFTS), 'utf8') : '[]';

const seeded = [
  {
    id: 101, createdAt: new Date(Date.now() - 12 * 60000).toISOString(), kind: 'quote',
    title: 'a16z 解析德州为何让数据中心排队等电',
    text: '474GW 排队 九成是数据中心 这泡沫谁先爆',
    targetUrl: 'https://x.com/a16z/status/1974118223344556677',
    quotedText: '德州电网暂停审批数据中心：并网队列从 63 GW 激增到 474 GW，约 90% 是数据中心。',
  },
  {
    id: 102, createdAt: new Date(Date.now() - 40 * 60000).toISOString(), kind: 'reply',
    title: null, text: '能，我天天这么干，回头细说',
    targetUrl: 'https://x.com/someone/status/1974100000000000001',
    replyTo: 'vibecoder',
    quotedText: '这个真的能自动发吗？',
  },
  {
    id: 103, createdAt: new Date(Date.now() - 90 * 60000).toISOString(), kind: 'post',
    title: '亚利桑那州法院裁定 AI 生成受害者视频带有不当情感分量 将重新量刑',
    text: '兄弟们 AI 生成的视频已经能影响量刑了 这口子开得有点大',
  },
];

writeFileSync(resolve(DRAFTS), JSON.stringify(seeded, null, 2), 'utf8');

// Restoring the real queue is not optional: a crash here used to destroy a
// genuine pending draft. Every exit path must put the original file back.
let server = null;
let browser = null;
const restore = () => { try { writeFileSync(resolve(DRAFTS), backup, 'utf8'); } catch {} };
process.on('exit', restore);
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1); });
process.on('unhandledRejection', (e) => { restore(); console.error(e); process.exit(1); });

const { startServer } = await import('../src/server.mjs');
server = await startServer({ port: PORT });
browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
// First load auto-shows onboarding; acknowledge it so nav clicks below are
// not intercepted, then reload clean.
await page.evaluate(() => localStorage.setItem('onboarded', '1'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const shots = [
  ['dashboard', '01-dashboard.png'],
  ['queue', '02-queue.png'],
  ['model', '03-model.png'],
  ['settings', '04-settings.png'],
];
for (const [name, file] of shots) {
  await page.click(`.nav-item[data-page="${name}"]`);
  await page.waitForTimeout(900);
  await page.screenshot({ path: resolve(OUT, file) });
  console.log('shot', file);
}

// Dashboard must show the real avatar: the renderer pulls /api/avatar and the
// <img> must actually load a bitmap, proven via naturalWidth.
await page.click('.nav-item[data-page="dashboard"]');
await page.waitForTimeout(900);
await page.evaluate(() => { localStorage.setItem('onboarded', '1'); });
await page.waitForTimeout(400);
const nw = await page.evaluate(() => {
  const img = document.querySelector('#avatar img');
  return img ? { naturalWidth: img.naturalWidth, src: img.src, display: getComputedStyle(img).display } : null;
});
console.log('avatar-img naturalWidth=' + (nw ? nw.naturalWidth : 'null') + ' src=' + (nw ? nw.src : '') + ' display=' + (nw ? nw.display : ''));
if (!nw || nw.naturalWidth <= 0) { console.error('FAIL: avatar img naturalWidth is not > 0'); process.exitCode = 1; }
if (nw && nw.display !== 'block') { console.error('FAIL: avatar img is not visible (' + nw.display + ')'); process.exitCode = 1; }
// AC-3.4: sidebar name/handle must match what /api/status reports.
const stNow = await fetch(`http://127.0.0.1:${PORT}/api/status`).then((r) => r.json());
const sideText = await page.evaluate(() => ({
  name: document.querySelector('#acctName')?.textContent || '',
  handle: document.querySelector('#acctHandle')?.textContent || '',
}));
const wantName = (stNow.account || '').split(' @')[0] || '未识别';
const wantHandle = '@' + ((stNow.account || '').split(' @')[1] || '');
if (sideText.name !== wantName || sideText.handle !== wantHandle) {
  console.error('FAIL: sidebar account mismatch', JSON.stringify(sideText), 'vs', wantName, wantHandle);
  process.exitCode = 1;
} else {
  console.log('sidebar-account match: ' + sideText.name + ' ' + sideText.handle);
}
await page.screenshot({ path: resolve(OUT, 'dashboard-avatar.png') });
console.log('shot dashboard-avatar.png');

// Onboarding overlay: clear the flag and reload so it auto-shows, then capture.
// (In a fresh context the flag is absent, which is exactly the first-run path.)
await page.evaluate(() => { localStorage.removeItem('onboarded'); });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(900);
const obVisible = await page.evaluate(() => {
  const el = document.querySelector('#obOverlay');
  if (!el) return false;
  const cs = getComputedStyle(el);
  return !el.hidden && cs.display !== 'none' && cs.visibility !== 'hidden';
});
console.log('onboarding-overlay visible=' + obVisible);
if (!obVisible) { console.error('FAIL: onboarding overlay not visible'); process.exitCode = 1; }
await page.screenshot({ path: resolve(OUT, 'onboarding.png') });
console.log('shot onboarding.png');
// AC-4.3: completing the flow writes localStorage.onboarded=1 and a reload
// no longer auto-shows the overlay.
// The wizard has 5 steps: click 下一步 until the button reads 完成, then click
// it once more. Clicking a fixed count (the old 3) left the overlay stuck on
// step 4 and the completion assertions below could never pass.
for (let i = 0; i < 10; i++) {
  const label = await page.evaluate(() => document.getElementById('obNext')?.textContent || '');
  await page.click('#obNext');
  await page.waitForTimeout(250);
  if (label.includes('完成')) break;
}
await page.waitForTimeout(300);
const onboardedAfter = await page.evaluate(() => localStorage.getItem('onboarded'));
const hiddenAfter = await page.evaluate(() => { const el = document.querySelector('#obOverlay'); return !el || el.hidden; });
console.log('onboarded-flag-after-complete=' + onboardedAfter + ' overlay-hidden=' + hiddenAfter);
if (onboardedAfter !== '1' || !hiddenAfter) { console.error('FAIL: onboarding completion did not persist flag/hide'); process.exitCode = 1; }
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(700);
const autoHidden = await page.evaluate(() => { const el = document.querySelector('#obOverlay'); return !el || el.hidden; });
console.log('overlay-auto-hidden-after-reload=' + autoHidden);
if (!autoHidden) { console.error('FAIL: overlay re-shows after onboarding completed'); process.exitCode = 1; }
// AC-4.4: the settings page has a reopen button that shows the overlay again.
await page.click('.nav-item[data-page="settings"]');
await page.waitForTimeout(500);
const reopenVisible = await page.evaluate(() => {
  const btn = document.querySelector('#obReopen');
  return btn ? btn.offsetParent !== null : false;
});
console.log('reopen-btn visible=' + reopenVisible);
if (!reopenVisible) { console.error('FAIL: reopen onboarding button not visible on settings'); process.exitCode = 1; }
await page.click('#obReopen');
await page.waitForTimeout(300);
const reopened = await page.evaluate(() => {
  const el = document.querySelector('#obOverlay');
  return el ? !el.hidden : false;
});
console.log('overlay-reopened=' + reopened);
if (!reopened) { console.error('FAIL: overlay did not reopen'); process.exitCode = 1; }
await page.click('#obSkip');
await page.waitForTimeout(300);
await page.click('.nav-item[data-page="dashboard"]');
await page.waitForTimeout(300);
// Open the confirm dialog on the queue page to verify the danger path renders.
await page.click('.nav-item[data-page="queue"]');
await page.waitForTimeout(700);
await page.click('#approveAll');
await page.waitForTimeout(400);
await page.screenshot({ path: resolve(OUT, '05-confirm.png') });
console.log('shot 05-confirm.png');

await browser.close();
server.close();
restore();

console.log(errors.length ? 'PAGE ERRORS:\n' + errors.join('\n') : 'no page errors');
process.exitCode = errors.length ? 1 : 0;
