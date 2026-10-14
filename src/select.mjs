import { readFileSync } from 'node:fs';

// Selection brain: rank candidates and pick the next action.
// DESIGN.md §7 - score on relevance / discussion / comment-ability / freshness,
// pick top-N, then decide post vs quote. LLM scoring uses the CHEAP model tier
// (T3-e); decideAction is a pure function of its inputs (T5-a).
// 候选窗口由 cfg.select 控制，避免硬编码：cfg.select.topN（返回条数）与
// cfg.select.shortlistMax（送入 LLM 打分窗上限）来自配置；不设置时回落到保守默认值，
// 以保持现有调用（如 run.mjs 显式 { topN: 8 }）与既有测试语义不变。
let llm = null;
try { llm = await import('./llm.mjs'); } catch { llm = null; }
let log = null;
try { log = await import('./log.mjs'); } catch { log = null; }

function say(msg) { try { log?.appendLog?.(msg); } catch {} }

const SYSTEM = `你是社媒运营助手，负责对候选资讯打分排序。
四个维度各 0-25 分：relevance（与 AI/科技定位相关度）、discussion（讨论度）、
commentable（是否容易写出有价值点评）、safety（内容安全合规）。
数字与事实只能来自所给素材，不许自己编造；风格收敛、宁可平淡。
只输出 JSON，不要解释。`;

// D3: the candidate window is cfg-driven, no hard-coded 8/24. Both defaults
// stay backwards-compatible — an explicit { topN } (as run.mjs does) or an
// absent cfg (as tests do) resolves to the original behaviour.
export function windowFor(cfg = {}) {
  const s = cfg.select || {};
  const topN = Number(s.topN ?? s.top ?? 8);
  const shortMax = Number(s.shortMax ?? s.shortlist ?? Math.max(topN * 2, 16));
  const clamp = (x, min, max) => Math.min(max, Math.max(min, x));
  return { topN: clamp(Math.round(topN) || 8, 1, 40), shortMax: clamp(Math.round(shortMax) || 16, 1, 80) };
}

// Deterministic 0..1 hash of a candidate url/tweetId/text: stable per
// candidate, used as the quote-decision input instead of Math.random.
function hash01(candidate, seed = 0) {
  const raw = String((candidate && (candidate.url || candidate.tweetId || candidate.text)) || '');
  let h = 2166136261 ^ seed;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

export function heuristicScore(c, cfg = {}) {
  const likes = c.likes || 0;
  const age = c.ageHours ?? 24;
  let s = 12;
  s += Math.min(25, Math.round(Math.log10(likes + 1) * 8));
  s += Math.max(0, Math.round(25 - age));
  const t = (c.text || '') + (c.title || '');
  if (/发布|推出|上线|开源|launch|release|announce/i.test(t)) s += 8;
  if (/模型|model|agent|benchmark|论文|paper/i.test(t)) s += 8;
  if (/融资|收购|监管|法院|lawsuit/i.test(t)) s += 5;
  // T2-f: preferred authors are ranked higher (authorBoost, default 20).
  const prefs = (Array.isArray(cfg.preferredAuthors) ? cfg.preferredAuthors : []).map((a) => String(a).toLowerCase());
  if (c.author && prefs.includes(String(c.author).toLowerCase())) s += Number(cfg.authorBoost ?? 20) || 0;
  s += 25;
  return Math.min(100, s);
}

export async function rankCandidates(candidates, cfg = {}, { topN = 8 } = {}) {
  if (!candidates?.length) return [];
  const scored = candidates.map((c) => ({ ...c, score: heuristicScore(c, cfg) }));
  const configured = typeof llm?.isConfigured === 'function' && llm.isConfigured();
  const window = windowFor(cfg);

  if (!configured || typeof llm?.completeJson !== 'function') {
    say('rankCandidates: heuristic only (LLM not configured)');
    return scored.sort((a, b) => b.score - a.score).slice(0, window.topN);
  }

  const shortlist = scored.sort((a, b) => b.score - a.score).slice(0, window.shortMax);
  const list = shortlist
    .map((c, i) => `${i + 1}. [${c.source}] ${(c.title || c.text || '').slice(0, 90)} (likes=${c.likes ?? '-'}, age=${c.ageHours ?? '-'}h)`)
    .join('\n');

  let res = null;
  try {
    res = await llm.completeJson([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `账号定位：AI / 科技资讯与观点，中文，面向中文推特用户。

候选：
${list}

给每条打分（四维之和 0-100）并从高到低排序。
输出：{"ranked":[{"i":1,"score":88,"why":"一句话理由"}]}` },
    // 6144, not 2048: this model emits its reasoning into the budget and a
    // 2048 start truncated on most calls, forcing a second (identical) request
    // on the widen path. Measured: 70 such retries, ~2900s of round time burnt.
    ], { maxTokens: 6144, tier: 'cheap' });
  } catch (e) {
    say(`rankCandidates: LLM failed (${e.message}); heuristics`);
  }

  if (!res || !Array.isArray(res.ranked)) return shortlist.slice(0, window.topN);

  const out = [];
  for (const r of res.ranked) {
    const c = shortlist[Number(r.i) - 1];
    if (c) out.push({ ...c, score: Number(r.score) || c.score, why: r.why || '' });
  }
  for (const c of shortlist) if (!out.some((o) => o.url === c.url)) out.push(c);
  return out.slice(0, window.topN);
}

// Pure, deterministic quote/post decision (T5-a): no Math.random. A stable
// per-candidate hash is compared against the configured quoteRatio.
// quoteRatio is the LITERAL share of eligible candidates that become quotes
// (0.3 -> ~30% quote / 70% post); it is no longer offset by a hidden +0.2, so
// the number the UI shows is the number the lane actually delivers.
// Optional seed/index keeps tests deterministic.
export function decideAction(candidate, cfg = {}) {
  const features = cfg.features || {};
  // Lane routing (T1/T2): growth-intent candidates never quote or muse while
  // the lane rules are enabled (default true; false restores the old
  // behaviour). Candidates without an intent field are plain content and must
  // take the exact legacy path below (T5-a / F2-a/b/d stay intact).
  const laneRules = cfg.laneRules || {};
  const isGrowth = candidate.intent === 'growth';
  const growthNeverQuote = laneRules.growthNeverQuote !== false;
  const growthNeverMuse = laneRules.growthNeverMuse !== false;
  const quoteRatio = cfg.quoteRatio ?? 0.4;
  const museRatio = cfg.museRatio ?? 0.25;
  // Honest share: quoteRatio is the literal fraction of eligible picks that
  // become quotes. Clamped so a 0/1 boundary or a bad value can never invert
  // the lanes or crash the round.
  const quoteShare = Math.max(0, Math.min(0.95, quoteRatio));
  const seed = Number(cfg.seed ?? 0) + Number(cfg.index ?? 0);
  const h = hash01(candidate, seed);
  // Muse is bound to timeline inspiration (T3-e): only candidates collected
  // from the home/following timeline may yield a muse. Deterministic — no
  // randomness, same candidate always decides the same way.
  const fromTimeline = ['x-home', 'x-following'].includes(candidate.source);
  if (fromTimeline) {
    // Lane routing: while a rule is enabled the growth lane is closed for
    // that action, exactly as if the feature switch were off.
    const laneMuseOpen = !(isGrowth && growthNeverMuse);
    const laneQuoteOpen = !(isGrowth && growthNeverQuote);
    if (features.muse === false || !laneMuseOpen) {
      if (features.quote === false || !laneQuoteOpen) return 'post';
      return h < quoteShare ? 'quote' : 'post';
    }
    if (h < museRatio) return 'muse';
    if (features.quote === false || !laneQuoteOpen) return 'post';
    // Muse takes its configured band off the top; quote then keeps its
    // configured share of what is left, so quoteRatio stays a real share of
    // non-muse output instead of shrinking with the muse budget.
    const quoteBand = quoteShare / Math.max(1e-9, 1 - museRatio);
    if (h < museRatio + (1 - museRatio) * quoteBand) return 'quote';
    return 'post';
  }
  if (isGrowth && growthNeverQuote) return 'post';
  if (features.quote === false) return 'post';
  // Only a candidate with a native X status URL can actually be quoted
  // (pickQuoteTarget requires candidate.origin). Deciding 'post' up front
  // avoids a doomed navigation and keeps the quote/post split equal to
  // quoteRatio among the candidates that qualify.
  const hasNative = !!(candidate.origin && /(?:^https?:\/\/)(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/.test(candidate.origin));
  if (!hasNative) return 'post';
  return h < quoteShare ? 'quote' : 'post';
}
