// Verifies the real Electron shell boots: launches Electron with CDP enabled,
// attaches, and screenshots the actual app window (not just the web page).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
process.chdir(ROOT);
const OUT = resolve('shots', 'ui');
mkdirSync(OUT, { recursive: true });
const CDP = 9333;

const electronBin = resolve('node_modules', 'electron', 'dist', 'electron.exe');
const child = spawn(electronBin, ['.', `--remote-debugging-port=${CDP}`], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

const die = async (msg, code = 1) => {
  console.error(msg);
  try { child.kill(); } catch {}
  process.exitCode = code;
};

// Wait for CDP to answer.
let up = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) { up = true; break; }
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
if (!up) { await die('FAIL: Electron never exposed CDP.\n' + out.slice(-1500)); }
else {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
  const ctx = browser.contexts()[0];
  let page = ctx.pages().find((p) => p.url().includes('127.0.0.1'));
  for (let i = 0; i < 30 && !page; i++) {
    await new Promise((r) => setTimeout(r, 500));
    page = ctx.pages().find((p) => p.url().includes('127.0.0.1'));
  }
  if (!page) { await die('FAIL: no app window found. pages=' + ctx.pages().map((p) => p.url()).join(',')); }
  else {
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    await page.waitForSelector('#app', { timeout: 15000 });
    await page.waitForTimeout(1500);
    const title = await page.title();
    const heading = await page.textContent('#pageTitle');
    const daemon = await page.textContent('#daemonText');
    await page.screenshot({ path: resolve(OUT, '06-electron-window.png') });
    console.log('url      :', page.url());
    console.log('title    :', title);
    console.log('heading  :', heading);
    console.log('daemon   :', daemon);
    console.log('screenshot: shots/ui/06-electron-window.png');
    console.log(errors.length ? 'PAGE ERRORS: ' + errors.join(' | ') : 'no page errors');
    if (heading !== '仪表盘') await die('FAIL: shell did not render dashboard');
    else console.log('PASS: Electron shell booted and rendered');
  }
  try { await browser.close(); } catch {}
}
try { child.kill(); } catch {}
setTimeout(() => process.exit(process.exitCode || 0), 800);
