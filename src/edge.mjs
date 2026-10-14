// Isolated Edge launcher + CDP connection helper.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { appendLog } from './log.mjs';

export function launchEdge(profileDir, edgePath, port) {
  const dir = resolve(process.env.SOCIALMATE_DATA_DIR || process.cwd(), profileDir);
  if (!existsSync(dir)) throw new Error(`Profile copy missing: ${dir}\nRun: node scripts/copy-edge-profile.mjs (with Edge fully closed)`);
  const args = [
    `--user-data-dir=${dir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-restore-last-session',
    '--disable-session-crashed-bubble',
    '--disable-features=msEdgeSidebarV2,msEdgeShoppingAssistant',
    '--window-position=0,0',
    '--window-size=1280,900',
  ];
  appendLog(`Launching isolated Edge (port ${port})...`);
  const child = spawn(edgePath, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return child;
}

export function isCdpUp(port) {
  return fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) })
    .then(() => true)
    .catch(() => false);
}

export async function waitForCdp(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpUp(port)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export async function connect(cfg) {
  const { cdpPort: port, profileDir, edgePath } = cfg;
  if (!(await isCdpUp(port))) {
    launchEdge(profileDir, edgePath, port);
    const up = await waitForCdp(port, 40000);
    if (!up) throw new Error(`Edge did not expose CDP on port ${port}`);
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('No browser context available');
  return { browser, ctx };
}

export async function workPage(ctx) {
  const pages = ctx.pages();
  const existing = pages.find((p) => p.url().includes('x.com'));
  if (existing) return existing;
  return pages[0] || (await ctx.newPage());
}

export async function closeBrowser(browser) {
  try { await browser.close(); } catch (_) {}
}
