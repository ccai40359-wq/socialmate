// Leadgen collection orchestration. One real Edge tab, platforms serial,
// keywords spaced randomly, scoring + appendLeads, then a CollectReport.
// Read-only: checkAction('read') guards every round start.
import { connect, closeBrowser } from '../edge.mjs';
import { checkAction } from './gate.mjs';
import { expandKeywords } from './keywords.mjs';
import { appendLeads } from './store.mjs';
import { scoreLeads } from './score.mjs';
import { setRunning, recordCollectReport } from './status.mjs';
import { getAdapter, PLATFORMS } from './adapters/index.mjs';

const PLATFORM_ORDER = ['threads', 'fb', 'xhs'];

function rand(a, b) { return Math.random() * (b - a) + a; }

function platformConfig(cfg, platform) {
  const leadgen = cfg?.leadgen || {};
  const per = leadgen[platform] || {};
  return {
    maxPosts: Number(per.maxPostsPerKeyword) || Number(leadgen.maxPostsPerKeyword) || 20,
    gapMin: Number(per.keywordGapSecMin) || Number(leadgen.keywordGapSecMin) || 20,
    gapMax: Number(per.keywordGapSecMax) || Number(leadgen.keywordGapSecMax) || 60,
  };
}

export async function collectRun(opts = {}) {
  const { cfg, platforms, dryRun = false, now } = opts;
  const startedAt = new Date((now && !isNaN(now)) ? now : Date.now()).toISOString();
  const g = checkAction('read');
  if (!g.ok) {
    const report = { startedAt, endedAt: new Date().toISOString(), platforms: {}, totals: { collected: 0, added: 0 }, error: g.reason };
    return report;
  }
  const wanted = Array.isArray(platforms) && platforms.length ? platforms : PLATFORM_ORDER;
  const active = PLATFORM_ORDER.filter((p) => wanted.includes(p));
  const maxKeywords = opts.maxKeywords && opts.maxKeywords > 0 ? opts.maxKeywords : cfg?.leadgen?.maxKeywordsPerPlatform || 6;
  const keywords = expandKeywords(maxKeywords, cfg?.leadgen?.keywordsExtra);
  const kwsByPlatform = { threads: keywords, fb: keywords, xhs: keywords };

  if (dryRun) {
    const platformsOut = {};
    for (const p of active) {
      platformsOut[p] = {
        keywords: keywords.length,
        collected: keywords.length * 2,
        added: keywords.length * 2,
        scored: keywords.length * 2,
      };
    }
    const totals = {
      collected: active.reduce((s, p) => s + platformsOut[p].collected, 0),
      added: active.reduce((s, p) => s + platformsOut[p].added, 0),
    };
    return { startedAt, endedAt: new Date().toISOString(), platforms: platformsOut, totals };
  }

  let browser = null;
  let page = null;
  const report = { startedAt, endedAt: null, platforms: {}, totals: { collected: 0, added: 0 } };
  try {
    setRunning(true);
    const conn = await connect(cfg);
    browser = conn.browser;
    page = await conn.ctx.newPage();

    for (const p of active) {
      const platformOut = { keywords: 0, collected: 0, added: 0, scored: 0 };
      report.platforms[p] = platformOut;
      try {
        const adapter = await getAdapter(p);
        if (!adapter || typeof adapter.collect !== 'function') { platformOut.error = 'no-adapter:' + p; continue; }
        const pc = platformConfig(cfg, p);
        const platformKeywords = Array.isArray(kwsByPlatform[p]) ? kwsByPlatform[p] : [];
        platformOut.keywords = platformKeywords.length;
        for (let ki = 0; ki < platformKeywords.length; ki++) {
          const kw = platformKeywords[ki];
          const gate = checkAction('read');
          if (!gate.ok) { platformOut.error = gate.reason; break; }
          const posts = await adapter.collect(page, { cfg, keyword: kw, maxPosts: pc.maxPosts });
          if (adapter.lastError && !platformOut.error) platformOut.error = adapter.lastError;
          platformOut.collected += posts.length;
          const scored = await scoreLeads(posts);
          platformOut.scored += scored.length;
          const leads = posts.map((post, idx) => {
            const score = scored[idx] || {};
            return {
              ...post,
              demand: score.demand,
              intent: score.intent,
              reasons: score.reasons,
              guard: score.guard,
              status: 'new',
              discoveredAt: new Date().toISOString(),
            };
          });
          if (leads.length) {
            const res = await appendLeads(leads);
            platformOut.added += res.added;
          }
          if (ki < platformKeywords.length - 1) await new Promise((r) => setTimeout(r, rand(pc.gapMin, pc.gapMax) * 1000));
        }
      } catch (e) {
        platformOut.error = String((e && e.message) || e);
      }
    }
  } catch (e) {
    report.error = String((e && e.message) || e);
  } finally {
    if (page) { try { await page.close(); } catch (_) {} }
    if (browser) { try { await closeBrowser(browser); } catch (_) {} }
    report.endedAt = new Date().toISOString();
    report.totals = {
      collected: Object.values(report.platforms).reduce((s, p) => s + (p?.collected || 0), 0),
      added: Object.values(report.platforms).reduce((s, p) => s + (p?.added || 0), 0),
    };
    try { recordCollectReport(report); } catch (_) {}
  }
  return report;
}