// Safety: content screening (with risk gradient) and block detection.
// DESIGN.md §7 gates, §10 risk — finance/politics are opt-in and off by default.
import { appendLog } from './log.mjs';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

// X weighting: URLs count 23, most CJK codepoints 2, everything else 1.
export function weightedLen(text) {
  const urlRe = /https?:\/\/[^\s]+/g;
  let urls = 0;
  for (const _ of (text || '').matchAll(urlRe)) urls++;
  let len = urls * 23;
  for (const ch of (text || '').replace(urlRe, '')) {
    len += ch.codePointAt(0) >= 0x1100 ? 2 : 1;
  }
  return len;
}

const HARD_BLOCK = [
  { re: /(彩票|博彩|赌博|代理|刷单|返利|加微|私聊|兼职|荐股|开户|贷款|代购|投资群)/, tag: 'spam' },
  { re: /(色情|约炮|裸聊|成人视频|做爱)/, tag: 'adult' },
  { re: /(枪支|毒品|冰毒|大麻交易|假证|洗钱)/, tag: 'illegal' },
  { re: /(傻逼|妈的|操你|滚你|去死)/, tag: 'abuse' },
];

// Risk-gradient categories: present but disabled unless explicitly allowed.
const RISK_CATEGORIES = [
  { tag: 'politics', re: /(大选|选举|总统|议会|法案|外交冲突|战争|制裁|执政党|在野党|政治)/ },
  { tag: 'finance', re: /(买入|卖出|建仓|清仓|目标价|涨停|跌停|股票推荐|期权策略|炒币|合约开多|合约开空|收益率保证)/ },
];

export function screenContent(text, cfg = {}) {
  const t = text || '';
  for (const { re, tag } of HARD_BLOCK) {
    const m = t.match(re);
    if (m) return { ok: false, reason: `${tag}:${m[1]}` };
  }
  const allow = cfg.safety || {};
  for (const { tag, re } of RISK_CATEGORIES) {
    const m = t.match(re);
    if (!m) continue;
    const enabled = tag === 'politics' ? allow.allowPolitics : allow.allowFinance;
    if (!enabled) return { ok: false, reason: `category-disabled:${tag}` };
  }
  return { ok: true };
}

// Detect captcha / lockout / rate limit / signed-out. Never throws.
export async function detectBlock(page) {
  try {
    const url = page.url() || '';
    if (/captcha|arkose|challenge/i.test(url)) return { blocked: true, reason: 'captcha-url' };

    const body = await page.locator('body').innerText({ timeout: 8000 }).catch(() => '');
    const b = body || '';

    if (/unusual activity|verify you(?:.?re| are)? ?(?:a )?human|确认你是真人|安全验证|完成以下验证/i.test(b)) return { blocked: true, reason: 'captcha' };
    if (/account is temporarily locked|temporarily limited|账号已被暂时限制|已被冻结/i.test(b)) return { blocked: true, reason: 'locked' };
    if (/rate limit exceeded|over the daily limit|请求过于频繁|已达到每日上限/i.test(b)) return { blocked: true, reason: 'rate-limit' };
    if (/action blocked|looks like it might be automated|automated behavior|we can.?t complete this action|为了保护我们的用户|暂时无法执行此操作/i.test(b)) return { blocked: true, reason: 'action-blocked' };

    // x.com moves these routes around: /i/flow/login (legacy) and
    // /i/jf/onboarding/web?mode=login (current) both land on a login wall.
    // Verified live 2026-10-08: the old /i/flow/login-only check missed the
    // current onboarding route and reported blocked:false on a login wall.
    if (/\/i\/(?:flow|jf)\//i.test(url) || /[?&]mode=login\b/i.test(url) || /\/(?:login|signin|sign-in)\b/i.test(url)) {
      return { blocked: true, reason: 'signed-out' };
    }

    // A login overlay can sit on top of a signed-in feed (X shows the
    // onboarding sheet as a modal). The compose button is the signed-in
    // anchor: if it is gone while a login affordance is present, we are out.
    const compose = await page.locator('[data-testid="SideNav_NewTweet_Button"]').first().isVisible({ timeout: 1500 }).catch(() => false);
    if (!compose) {
      const loginLink = await page.locator('a[href="/login"]').first().isVisible({ timeout: 1500 }).catch(() => false);
      const loginField = await page.locator('input[autocomplete="username"], input[name="text"]').first().isVisible({ timeout: 1500 }).catch(() => false);
      if (loginLink || loginField) return { blocked: true, reason: 'signed-out' };
    }
    return { blocked: false };
  } catch (e) {
    appendLog(`detectBlock error (treated as not blocked): ${e.message}`);
    return { blocked: false };
  }
}

// T8-c: leave visual evidence when we are blocked, so the block can be
// inspected after the fact instead of guessed at. Kept here (not in run.mjs)
// so the capture path is directly testable without a browser.
export async function captureBlock(page, reason, opts = {}) {
  const dir = resolve(opts.dir || opts.cfg?.screenShotDir || "shots");
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = String(reason || "blocked").replace(/[^a-z0-9-]/gi, "-").slice(0, 40);
    const file = resolve(dir, `blocked-${stamp}-${slug}.png`);
    await page.screenshot({ path: file, fullPage: false });
    appendLog("BLOCKED screenshot: " + file);
    return file;
  } catch (e) {
    appendLog("BLOCKED screenshot failed: " + e.message);
    return null;
  }
}
