import { appendLog } from './log.mjs';
import { loadJson, saveJson } from './store.mjs';
import { checkKindBudget } from './gate.mjs';

let humanize = null;
try { humanize = await import('./humanize.mjs'); } catch { humanize = null; }

const rand = (a, b) => Math.random() * (b - a) + a;
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEFAULTS = {
  features: { post: true, quote: true, muse: true, reply: true, like: true, browse: false, follow: false, followBack: true },
  browse: { minutes: 3, maxScrolls: 8, likeWhileBrowsing: true },
};

// Feature/browse defaults live here so every caller (scheduler, tests) shares
// one resolution path: missing config fields fall back, numbers are clamped.
export function browseCfg(cfg = {}) {
  const f = { ...DEFAULTS.features, ...(cfg.features && typeof cfg.features === 'object' ? cfg.features : {}) };
  const b = { ...DEFAULTS.browse, ...(cfg.browse && typeof cfg.browse === 'object' ? cfg.browse : {}) };
  const minutes = Math.min(60, Math.max(1, Number(b.minutes) || DEFAULTS.browse.minutes));
  const maxScrolls = Math.min(30, Math.max(1, Math.round(Number(b.maxScrolls) || DEFAULTS.browse.maxScrolls)));
  return { ...cfg, features: f, browse: { ...b, minutes, maxScrolls } };
}

// Read-only timeline browsing: open x.com/home, scroll like a human, record
// what is seen, optionally like a few fresh tweets. NEVER publishes: this
// module imports no publish primitive (I2 / F3-b). Likes share the engage
// daily quota (state.engagesPublished capped by gate.perKind.engageDailyMax)
// and the queue/seen-likes.json dedupe set, so browse can never push the
// daily like total past the engage cap (F3-g / F3-h). browseDailyMax /
// browseCooldownMinutes only throttle the browsing rounds themselves.
export async function browseRound(page, opts = {}) {
  const cfg = browseCfg(opts.cfg || {});
  const b = cfg.browse;
  const state = opts.state || {};

  const budget = checkKindBudget({ kind: 'browse', state, cfg });
  if (!budget.ok) {
    appendLog('browse round: skipped (' + budget.reasons.join(',') + ')');
    return { browsed: 0, liked: 0, skipped: true, reasons: budget.reasons };
  }

  const seenLikesPath = opts.seenFile || 'queue/seen-likes.json';
  const seenLikes = loadJson(seenLikesPath, { urls: [] });
  const seenLikesSet = new Set(seenLikes.urls || []);

  const scrolls = Math.min(b.maxScrolls, opts.maxScrolls ?? b.maxScrolls);
  const engageMax = cfg.gate?.perKind?.engageDailyMax ?? 20;
  const maxLikes = Math.max(0, opts.maxLikes ?? 3);
  let browsed = 0;
  let liked = 0;

  try {
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000).catch(() => {});
    const started = Date.now();

    for (let i = 0; i < scrolls; i++) {
      const collected = await page.evaluate(() => {
        const rows = [];
        for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
          if (art.querySelector('[data-testid="socialContext"]')) continue;
          const link = art.querySelector('a[href*="/status/"]');
          if (!link) continue;
          const href = link.getAttribute('href') || '';
          if (!/^\/[^/]+\/status\/\d+$/.test(href)) continue;
          const btn = art.querySelector('[data-testid="like"]');
          rows.push({ href: 'https://x.com' + href, liked: !!btn && /unlike/i.test(btn.getAttribute('aria-label') || '') });
        }
        return rows;
      }).catch((e) => { appendLog('browse evaluate failed: ' + e.message); return []; });

      browsed += collected.length;

      if (b.likeWhileBrowsing && liked < maxLikes && (state.engagesPublished || 0) < engageMax) {
        const fresh = collected.filter((t) => !seenLikesSet.has(t.href) && !t.liked);
        for (const t of fresh) {
          if (liked >= maxLikes || (state.engagesPublished || 0) >= engageMax) break;
          const rel = t.href.replace(/^https:\/\/(?:www\.)?x\.com/, '');
          const likeBtn = page.locator('article[data-testid="tweet"]:has(a[href="' + rel + '"]) [data-testid="like"]').first();
          try {
            // P0: isVisible({timeout}) never polls, so a not-yet-mounted button
            // reads as "absent". Poll until it mounts or the budget runs out.
            let visible = false;
            const likeDeadline = Date.now() + 3000;
            while (Date.now() < likeDeadline) {
              visible = await likeBtn.isVisible().catch(() => false);
              if (visible) break;
              await sleep(200);
            }
            if (!visible) continue;
            await likeBtn.click({ timeout: 8000 });
            await sleep(randInt(600, 1600));
            seenLikesSet.add(t.href);
            state.engagesPublished = (state.engagesPublished || 0) + 1;
            state.lastEngageAt = Date.now();
            liked++;
            appendLog('browse LIKE ok :: ' + t.href);
          } catch (e) {
            appendLog('browse like failed (' + t.href + '): ' + e.message);
          }
        }
      }

      if (i < scrolls - 1) {
        if (humanize?.scrollWarmup) {
          try { await humanize.scrollWarmup(page, { rolls: 1 }); }
          catch { await page.mouse.wheel(0, 2200).catch(() => {}); }
        } else {
          await page.mouse.wheel(0, 2200).catch(() => {});
        }
        await sleep(randInt(1500, 4200));
      }
      if (Date.now() - started > b.minutes * 60_000) break;
    }
  } catch (e) {
    appendLog('browse round failed: ' + e.message);
  }

  seenLikes.urls = [...seenLikesSet].slice(-800);
  if (seenLikesSet.size > 0) saveJson(seenLikesPath, seenLikes);
  appendLog('browse round: browsed ' + browsed + ' tweets, liked ' + liked + '/' + maxLikes);
  return { browsed, liked, skipped: false };
}
