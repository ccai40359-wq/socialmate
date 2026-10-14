// Onboarding wizard end-to-end + screenshots (G2). Boots the real local
// server, walks the 5-step wizard through a fresh context (no onboarded flag),
// verifies each step renders its controls, and saves one PNG per step to
// shots/ui/. Fails (exit 1) on any page error or missing control.
//
// Note: /api/status and /api/avatar read the live Edge CDP session and can
// take ~8-18s each, so we never wait for networkidle; we poll for the step's
// controls instead.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
process.chdir(ROOT);
const PORT = 4189;
const OUT = resolve('shots', 'ui');
mkdirSync(OUT, { recursive: true });

const backup = existsSync(resolve('config.json')) ? readFileSync(resolve('config.json'), 'utf8') : null;
const restore = () => { if (backup) { try { writeFileSync(resolve('config.json'), backup, 'utf8'); } catch {} } };
process.on('exit', restore);
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1); });
process.on('unhandledRejection', (e) => { restore(); console.error(e); process.exit(1); });

const { startServer } = await import('../src/server.mjs');
const server = await startServer({ port: PORT });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });

async function waitVisible(ids, timeoutMs, wantStep) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = await page.evaluate((list) => {
      const res = {};
      for (const id of list) {
        const el = document.getElementById(id);
        if (!el) { res[id] = 'missing'; continue; }
        const cs = getComputedStyle(el);
        res[id] = (!el.hidden && cs.display !== 'none' && cs.visibility !== 'hidden') ? 'visible' : 'hidden';
      }
      return res;
    }, ids);
    const num = wantStep ? await page.evaluate(() => Number(document.getElementById('obStepNum')?.textContent || 0)) : 0;
    const total = wantStep ? await page.evaluate(() => Number(document.getElementById('obStepTotal')?.textContent || 0)) : 0;
    if (wantStep && !(num === wantStep && total === 5)) { await page.waitForTimeout(500); continue; }
    if (Object.values(out).every((v) => v === 'visible')) return out;
    await page.waitForTimeout(500);
  }
  return null;
}

const steps = [
  { file: '09-onboarding-1-browser.png', ids: ['obBrowserEdge', 'obBrowserChrome', 'obBrowserFirefox'] },
  { file: '10-onboarding-2-login.png', ids: ['obCopyCmdBtn', 'obAvatarImg', 'obAccountName', 'obAccountHandle'] },
  { file: '11-onboarding-3-model.png', ids: ['obMdlProtocol', 'obMdlBaseURL', 'obMdlApiKey', 'obMdlModel', 'obMdlTest', 'obMdlSave'] },
  { file: '12-onboarding-4-topics.png', ids: ['obTopicSeeds', 'obTopicsSave'] },
  { file: '13-onboarding-5-pace.png', ids: ['obDailyTarget', 'obMinGap', 'obHourStart', 'obHourEnd', 'obPaceSave'] },
];

for (let i = 0; i < steps.length; i++) {
  if (i === 0) {
    // Fresh context (no onboarded flag) auto-shows the wizard on load.
  } else {
    await page.click('#obNext');
  }
  const vis = await waitVisible(steps[i].ids, 35000, i + 1);
  if (!vis) {
    const now = await page.evaluate((list) => {
      const res = {};
      for (const id of list) {
        const el = document.getElementById(id);
        res[id] = el ? (el.hidden ? 'hidden' : 'exists') : 'missing';
      }
      return res;
    }, steps[i].ids);
    console.error(`step ${i + 1} controls not visible:`, JSON.stringify(now));
    process.exitCode = 1;
    continue;
  }
  const num = await page.evaluate(() => document.getElementById('obStepNum')?.textContent);
  const total = await page.evaluate(() => document.getElementById('obStepTotal')?.textContent);
  console.log(`step ${i + 1} controls visible (${num}/${total})`);
  await page.screenshot({ path: resolve(OUT, steps[i].file) });
  console.log('shot', steps[i].file);
}

await browser.close();
server.close();
restore();

console.log(errors.length ? 'PAGE ERRORS:\n' + errors.join('\n') : 'no page errors');
process.exitCode = errors.length ? 1 : process.exitCode;
