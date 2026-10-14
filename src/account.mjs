// Live account and avatar discovery over the CDP-attached Edge session.
// Reads the account switcher DOM instead of trusting config values, with a
// process-local TTL cache and disk fallbacks so the dashboard stays usable
// while Edge is offline.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DATA_ROOT = process.env.SOCIALMATE_DATA_DIR || process.cwd();
import { appendLog } from './log.mjs';

const ACCOUNT_SELECTOR = '[data-testid="SideNav_AccountSwitcher_Button"]';
const AVATAR_SELECTOR = '[data-testid="SideNav_AccountSwitcher_Button"] img';
const AVATAR_FALLBACK = 'img[src*="profile_images"]';
const TTL_MS = 60_000;

let accountCache = null;
let avatarCache = null;

function readCache(file, fallback) {
  try { return JSON.parse(readFileSync(resolve(DATA_ROOT, file), 'utf8')); }
  catch { return fallback; }
}

function writeCache(file, value) {
  try {
    mkdirSync(resolve(DATA_ROOT, 'cache'), { recursive: true });
    writeFileSync(resolve(DATA_ROOT, file), JSON.stringify(value, null, 2), 'utf8');
  } catch {}
}

export function resetCaches() {
  accountCache = null;
  avatarCache = null;
}

export function parseAccountText(text) {
  if (!text) return { name: '', handle: '' };
  const ats = [...text.matchAll(/@\w+/g)].map((m) => m[0]);
  if (!ats.length) return { name: text.replace(/\s+/g, ' ').trim(), handle: '' };
  const handle = ats[ats.length - 1];
  const name = text.replace(handle, '').replace(/\s+/g, ' ').trim();
  return { name, handle };
}

function realDriver(cfg) {
  return {
    async readAccountText() {
      const edge = await import('./edge.mjs');
      const connection = await edge.connect(cfg);
      try {
        const page = await edge.workPage(connection.ctx);
        const text = await page.locator(ACCOUNT_SELECTOR).first().innerText({ timeout: 8000 }).catch(() => '');
        return text.replace(/\s+/g, ' ').trim();
      } finally {
        try { await connection.browser.close(); } catch {}
      }
    },
    async readAvatarSrc() {
      const edge = await import('./edge.mjs');
      const connection = await edge.connect(cfg);
      try {
        const page = await edge.workPage(connection.ctx);
        const locator = page.locator(AVATAR_SELECTOR).first();
        let src = await locator.getAttribute('src', { timeout: 6000 }).catch(() => null);
        if (!src) {
          src = await page.locator(AVATAR_FALLBACK).first().getAttribute('src', { timeout: 4000 }).catch(() => null);
        }
        return typeof src === 'string' && src.startsWith('http') ? src : null;
      } finally {
        try { await connection.browser.close(); } catch {}
      }
    },
  };
}

export async function readAccount(cfg, opts = {}) {
  const driver = opts.driver || realDriver(cfg);
  if (accountCache && Date.now() - accountCache.fetchedAt < TTL_MS) return accountCache;
  let text = '';
  try {
    text = await driver.readAccountText();
  } catch (e) {
    appendLog('account: live read failed (' + e.message + '); using cache');
  }
  if (text) {
    const { name, handle } = parseAccountText(text);
    const account = handle ? `${name} ${handle}` : (name || null);
    accountCache = { name, handle, account, fetchedAt: Date.now() };
    writeCache('cache/account.json', { name, handle, fetchedAt: accountCache.fetchedAt });
    return accountCache;
  }
  const disk = readCache('cache/account.json', null);
  if (disk && disk.name && disk.handle) {
    accountCache = { ...disk, account: `${disk.name} ${disk.handle}`, fetchedAt: disk.fetchedAt || Date.now() };
    return accountCache;
  }
  accountCache = { name: '', handle: '', account: null, fetchedAt: Date.now() };
  return accountCache;
}

export async function readAvatar(cfg, opts = {}) {
  const driver = opts.driver || realDriver(cfg);
  if (avatarCache && Date.now() - avatarCache.fetchedAt < TTL_MS) return avatarCache;
  let src = null;
  try {
    src = await driver.readAvatarSrc();
  } catch (e) {
    appendLog('avatar: live read failed (' + e.message + '); using cache');
  }
  if (src) {
    src = src.replace(/_normal\./i, '_200x200.');
    avatarCache = { url: src, fetchedAt: Date.now() };
    writeCache('cache/avatar.json', { url: src, fetchedAt: avatarCache.fetchedAt });
    return avatarCache;
  }
  const disk = readCache('cache/avatar.json', null);
  if (disk && disk.url) {
    avatarCache = { url: disk.url, fetchedAt: disk.fetchedAt || Date.now() };
    return avatarCache;
  }
  avatarCache = { url: null, fetchedAt: Date.now() };
  return avatarCache;
}
