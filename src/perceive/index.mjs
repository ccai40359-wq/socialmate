// Perception: where candidate content comes from. DESIGN.md §5.
// Four layers — X trends, X search, X home/following timeline, AIHOT, RSS
// (optional) — normalised into one shape. Every layer degrades on its own:
// one failing never empties the pool.
import { appendLog } from '../log.mjs';
import { aihotGet } from '../aihot.mjs';
import { parseAihotMarkdown } from '../aihot-parse.mjs';
import { collectTrends } from './trends.mjs';
import { searchTweets } from './search.mjs';
import { collectTimeline } from './timeline.mjs';
import { collectFeeds } from './feeds.mjs';
import { detectLang, detectLane } from './lang.mjs'
import { extractCommenters, collectCommentersFromPost, handleFromStatusUrl } from './commenters.mjs';
export { detectLang, extractCommenters, collectCommentersFromPost, handleFromStatusUrl };

// The one candidate shape every layer must emit. `ageHours` is the field
// callers read; `age` mirrors it for the DESIGN.md §5 schema. Full text and
// author are kept — quote comments need the complete tweet body, not a
// truncated title (T1-f / T5-b).
export function normalizeCandidate(c, fallbackSource) {
  const src = (c && c.source) || fallbackSource || 'unknown';
  const text = (c && (c.text ?? c.title)) || '';
  const out = {
    text,
    title: (c && (c.title ?? text)) || '',
    author: (c && c.author) || '',
    likes: (c && c.likes) ?? null,
    ageHours: (c && c.ageHours) ?? null,
    url: (c && c.url) || '',
    lang: (c && c.lang) || detectLang(text),
    source: src,
    origin: (c && c.origin) ?? null,
    // Lane classification (T1): every candidate is 'growth' or 'content'.
    // Pure rule classifier, never throws — a failure stays 'content'.
    intent: detectLane(text + ' ' + ((c && (c.title ?? text)) || '')),
  };
  out.age = out.ageHours; // schema mirror; ageHours stays the read field
  return out;
}

// Normalise for content comparison: lowercase, strip punctuation/whitespace,
// take a 48-char prefix so near-identical headlines collapse across sources.
export function fingerprint(text) {
  return (text || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .slice(0, 48);
}

// Dedupe by BOTH url and content fingerprint.
export function dedupeCandidates(list) {
  const byUrl = new Set();
  const byFp = new Set();
  const out = [];
  for (const c of list) {
    if (!c || !c.url) continue;
    const fp = fingerprint(c.text || c.title);
    if (byUrl.has(c.url)) continue;
    if (fp && byFp.has(fp)) continue;
    byUrl.add(c.url);
    if (fp) byFp.add(fp);
    out.push(c);
  }
  return out;
}

function aihotCandidates(items) {
  return items.map((it) => normalizeCandidate({
    text: it.summary || it.title,
    title: it.title,
    author: it.source || '',
    url: it.url,
    lang: 'zh',
    source: 'aihot',
    origin: it.originalUrl || null,
  }, 'aihot'));
}

// Relevance verdict. Prefers a cheap LLM when configured; degrades to pure
// rules when the model is unavailable or fails. NEVER returns "not relevant"
// on an empty/failed check — a degraded run must not clear the pool (T1-e).
const IRRELEVANT = /(美食|菜谱|旅游|攻略|穿搭|护肤|减肥|健身|游戏攻略|追剧|电影推荐|英超|欧冠|世界杯|NBA|演唱会|追星|八卦|情感|星座|生肖|运势|天气|早餐|午饭|晚饭|上班|下班|打卡|互关|互粉|浇朋友|涨粉)/;
const RELEVANT = /(AI|人工智能|大模型|模型|算法|芯片|半导体|机器人|智能体|agent|LLM|GPT|OpenAI|Anthropic|Google|微软|英伟达|NVIDIA|算力|数据|云|开源|编程|代码|开发者|技术|科技|研究|论文|benchmark|发布会|发布|上线|融资|收购|监管|专利|创业公司|startup|SaaS)/i;
const NON_RELEVANT = /(食品|农产品|房地产|房价|高考|中考|体育赛事|娱乐八卦|母婴|育儿|钓鱼|房产|保险|理财|养生|中医|股票推荐|币圈行情)/;
// Pure synchronous AI-relevance probe for stable-partition preference (T1):
// IRRELEVANT -> NON_RELEVANT -> RELEVANT, same priority as isRelevantCandidate.
// Never throws; ''/null/undefined all return false. Used only to PREFER AI
// topics, never as a hard filter - unknown text simply stays non-preferred.
export function looksAiRelevant(text) {
  const t = String(text == null ? '' : text).slice(0, 600);
  if (IRRELEVANT.test(t)) return false;      // 命中无关 → 非优先
  if (NON_RELEVANT.test(t)) return false;    // 命中非相关领域 → 非优先
  if (RELEVANT.test(t)) return true;         // 命中 AI/科技 → 优先
  return false;                              // 未知 → 非优先（只用于"优先"，不是硬闸门）
}


export async function isRelevantCandidate(candidate, cfg = {}, deps = {}) {
  const text = ((candidate.text || '') + ' ' + (candidate.title || '')).slice(0, 600);
  if (IRRELEVANT.test(text)) return false;
  try {
    const llm = await import('../llm.mjs');
    const configured = deps.isConfigured !== undefined ? deps.isConfigured() : (llm.isConfigured && llm.isConfigured());
    const completeJson = deps.completeJson || llm.completeJson;
    if (configured && typeof completeJson === 'function') {
      const res = await completeJson([
        { role: 'system', content: '你是 AI/科技资讯编辑。判断给定内容是否与 AI、机器学习、科技产品、芯片、机器人、开发者生态相关。只输出 JSON：{"relevant":true|false}。' },
        { role: 'user', content: `内容：${text}\n\n请判定是否与 AI/科技相关。` },
      ], { maxTokens: 1024, tier: 'cheap' });
      if (res && typeof res.relevant === 'boolean') return res.relevant;
    }
  } catch (e) {
    appendLog('perceive/relevance: LLM path failed (' + e.message + '); using rules');
  }
  // Pure-rule fallback: keep anything that looks tech-related, drop obvious
  // noise. No LLM reachable must not empty the pool.
  if (RELEVANT.test(text)) return true;
  if (NON_RELEVANT.test(text)) return false;
  return true; // unknown -> keep (never clear the pool)
}

// Language whitelist + likes floor at the perceive layer (T1-c / T1-d).
// Timeline rows (x-home/x-following) feed the muse lane: they only need a
// clean language, not a likes floor — the inspiration value is not about
// popularity.
export function qualityGate(candidate, cfg = {}) {
  const minLikes = cfg.perceive?.minLikes ?? 10;
  const lang = (candidate.lang || '').toLowerCase();
  if (!['zh', 'en'].includes(lang)) return { ok: false, reason: `lang:${lang}` };
  if ((candidate.source === 'x-home' || candidate.source === 'x-following')) return { ok: true };
  if (candidate.likes != null && candidate.likes < minLikes) return { ok: false, reason: `likes:${candidate.likes}<${minLikes}` };
  return { ok: true };
}

export async function collectCandidates({ page, cfg, limit = 40, timelineImpl, onStats } = {}) {
  const layers = [];
  // T6 counting only — the gate decisions below are untouched. dropReasons
  // counts every reason a read row failed to survive; bySource counts how many
  // rows each source contributed to "read" (duplicates included), so the
  // dashboard can honestly say read = kept + dropped.
  const dropReasons = {};
  const bySource = {};
  const countSource = (source) => { bySource[source] = (bySource[source] || 0) + 1; };
  // Reason is recorded per row, not as a running counter: the DEGRADED refill
  // below can put an already-"dropped" row back into the kept set, and only the
  // FINAL partition may be reported (otherwise the dashboard shows drop reasons
  // that add up to more than the rows actually dropped).
  const dropReasonOf = new Map();
  const drop = (source, reason) => { dropReasonOf.set(source, reason); };

  // AIHOT first: cheapest, most reliable, and the only source with summaries.
  // It must never be allowed to fail the whole call.
  try {
    const queries = ['/latest?limit=30', '/latest?limit=30&mode=all'];
    const items = [];
    for (const q of queries) {
      try { items.push(...parseAihotMarkdown(await aihotGet(cfg, q))); }
      catch (e) { appendLog('perceive/aihot skip: ' + e.message); }
    }
    const c = aihotCandidates(items);
    appendLog('perceive/aihot: ' + c.length);
    layers.push(...c);
  } catch (e) {
    appendLog('perceive/aihot failed: ' + e.message);
  }

  if (page) {
    try {
      const t = (await collectTrends(page, { cfg, limit: 20 })).map((c) => normalizeCandidate(c, 'x-trend'));
      appendLog('perceive/trends: ' + t.length);
      layers.push(...t);
    } catch (e) {
      appendLog('perceive/trends failed: ' + e.message);
    }

    try {
      // Topic expansion actually feeds the search layer: every configured
      // seed is expanded (including English translations) before searching.
      const seeds = (cfg.topicSeeds && cfg.topicSeeds.length) ? cfg.topicSeeds : ['artificial intelligence', '大模型'];
      const expanded = [];
      for (const seed of seeds) expanded.push(...await expandTopics(seed, cfg));
      const terms = [...new Set(expanded.map((x) => x.trim()).filter(Boolean))].slice(0, 12);
      const s = (await searchTweets(page, { cfg, keywords: terms, limit: 20 })).map((c) => normalizeCandidate(c, 'x-search'));
      appendLog('perceive/search: ' + s.length);
      layers.push(...s);
    } catch (e) {
      appendLog('perceive/search failed: ' + e.message);
    }

    try {
      const tlFn = timelineImpl || collectTimeline;
      const tl = (await tlFn(page, { cfg, limit: 20 })).map((c) => normalizeCandidate(c, 'x-home'));
      appendLog('perceive/timeline: ' + tl.length);
      layers.push(...tl);
    } catch (e) {
      appendLog('perceive/timeline failed: ' + e.message);
    }
  }

  // RSS: optional layer. Dead feeds never break collection; when cfg.feeds
  // is absent the layer returns [] quietly.
  const hasFeeds = !!(cfg && Array.isArray(cfg.feeds) && cfg.feeds.length);
  try {
    const r = (await collectFeeds(cfg, { limit: 10 })).map((c) => normalizeCandidate(c, 'rss'));
    if (hasFeeds) appendLog('perceive/rss: ' + r.length);
    layers.push(...r);
  } catch (e) {
    appendLog('perceive/rss failed: ' + e.message);
  }

  // Perceive-layer quality gate (T1-c / T1-d / T5-a): likes floor, language
  // whitelist, then relevance. Each layer degrades separately and never
  // clears the pool.
  const gated = [];
  const deduped = dedupeCandidates(layers);
  for (const c of layers) countSource(c.source || 'unknown');
  // Relevance is judged with a bounded worker pool instead of one sequential
  // LLM round-trip per row. Collection is a read pass that stalls publishing
  // while it runs (I2 keeps them out of the same pass), and serial checks made
  // that stall ~3 minutes for ~40 rows. Order is preserved so the pool is
  // byte-identical to the sequential version; only the wall time changes.
  const CONCURRENCY = 6;
  const verdicts = new Array(deduped.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= deduped.length) return;
      const c = deduped[i];
      const q = qualityGate(c, cfg);
      if (!q.ok) { verdicts[i] = { keep: false, log: `perceive/drop ${c.source}:${q.reason}`, reason: q.reason }; continue; }
      // Timeline rows feed the muse lane ("inspired by a tweet, say your own
      // thing") — they do not need to be AI-relevant, only well-behaved. They
      // still run the lane classification (T1): growth-intent rows stay in the
      // pool for the othersReply comment lane, they are never deleted.
      if (c.source === 'x-home' || c.source === 'x-following') {
        verdicts[i] = { keep: true, log: c.intent === 'growth' ? `perceive/timeline growth kept: ${c.source}` : null };
        continue;
      }
      let rel = true;
      try { rel = await isRelevantCandidate(c, cfg); } catch { rel = true; }
      verdicts[i] = rel ? { keep: true, log: null } : { keep: false, log: `perceive/drop ${c.source}:irrelevant`, reason: 'irrelevant' };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, deduped.length || 1) }, worker));
  for (let i = 0; i < deduped.length; i++) {
    const v = verdicts[i];
    if (!v) continue;
    if (v.log) appendLog(v.log);
    if (!v.keep) { drop(deduped[i], v.reason); continue; }
    gated.push(deduped[i]);
  }
  if (!gated.length) {
    appendLog('perceive: DEGRADED all layers gated out; keeping raw pool (never empty)');
    gated.push(...deduped.slice(0, limit));
  }

  // Reserve room per source so a rich AIHOT day does not crowd out the
  // signals that only X can provide (real engagement, real discussion).
  const quota = {
    'aihot': Math.ceil(limit * 0.4),
    'x-trend': Math.ceil(limit * 0.2),
    'x-search': Math.ceil(limit * 0.4),
    'x-home': Math.ceil(limit * 0.3),
    'x-following': Math.ceil(limit * 0.3),
    'rss': Math.ceil(limit * 0.15),
  };
  const used = {};
  const picked = [];
  for (const c of gated) {
    const cap = quota[c.source] ?? limit;
    used[c.source] = used[c.source] || 0;
    if (used[c.source] >= cap) continue;
    used[c.source]++;
    picked.push(c);
    if (picked.length >= limit) break;
  }
  const finalLog = { ...used };
  appendLog('perceive: ' + picked.length + ' after dedupe+gate ' + JSON.stringify(finalLog));
  if (typeof onStats === 'function') {
    try {
      const read = layers.length;
      const kept = gated.length;
      const dropped = Math.max(0, read - kept);
      // Rebuild the reason tally from the final kept/dropped split so
      // sum(dropReasons) == dropped in EVERY branch, including the DEGRADED
      // refill (rows that came back into "gated" no longer count as dropped).
      const keptSet = new Set(gated);
      const reasons = {};
      for (const row of deduped) {
        if (keptSet.has(row)) continue;
        const reason = dropReasonOf.get(row) || 'unknown';
        reasons[reason] = (reasons[reason] || 0) + 1;
      }
      const dupRemoved = Math.max(0, layers.length - deduped.length);
      if (dupRemoved) reasons.duplicate = (reasons.duplicate || 0) + dupRemoved;
      // Any residual (rows replaced by the DEGRADED refill) lands in "other".
      const accounted = Object.values(reasons).reduce((a, b) => a + b, 0);
      if (dropped > accounted) reasons.other = (reasons.other || 0) + (dropped - accounted);
      onStats({ read, kept, dropped, dropReasons: reasons, bySource: { ...bySource } });
    } catch { /* stats callback must never break collection */ }
  }
  return picked;
}

// EXPAND contains no network calls, so topic expansion always works even
// when the LLM is unavailable. Every row leads with pure-English terms; the
// unknown-seed fallback also guarantees at least one pure-English term.
const EXPAND = {
  ai: ['AI', 'artificial intelligence', 'LLM', 'machine learning', '大模型'],
  'ai agent': ['AI agent', 'agentic AI', 'multi-agent', '智能体'],
  '人工智能': ['artificial intelligence', 'AI', 'machine learning', '大模型'],
  '大模型': ['large language model', 'foundation model', 'LLM', '大模型'],
  '美股': ['US stocks', 'S&P 500', 'earnings season', '美股'],
  '国际政治': ['geopolitics', 'election', 'sanctions', '国际政治'],
  '加密货币': ['crypto', 'bitcoin', 'ethereum', '加密货币'],
  '新能源': ['clean energy', 'renewable energy', 'solar stocks', '新能源'],
  '机器人': ['robotics', 'humanoid robot', 'robotics stocks', '机器人'],
  '芯片': ['semiconductors', 'chip stocks', 'Nvidia', '芯片'],
  '金融': ['financial markets', 'central bank', 'interest rates', '金融'],
};

// Keep the exported name and async signature: expandTopics(seed, cfg).
// A non-empty seed never yields an empty array.
export async function expandTopics(seed, cfg = {}) {
  const s = (seed || '').trim();
  if (!s) return [];

  // Prefer the model when one is configured; degrade to the built-in table.
  try {
    const llm = await import('../llm.mjs');
    if (llm.isConfigured()) {
      const res = await llm.completeJson([
        { role: 'user', content:
          '把社媒话题扩展成一组具体搜索词，必须包含英文翻译（X 上以英文为主），' +
          '且至少给出一个纯英文词。\n' +
          '话题：' + s + '\n' +
          '输出：{"keywords":["词1","词2",...]}  最多 6 个，只输出 JSON' },
      ], { maxTokens: 6144 });
      if (res && Array.isArray(res.keywords) && res.keywords.length) {
        const terms = res.keywords.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 6);
        if (terms.length) return terms;
      }
    }
  } catch (e) {
    appendLog('expandTopics: LLM path failed (' + e.message + '); using built-in table');
  }

  const key = Object.keys(EXPAND).find((k) => k.toLowerCase() === s.toLowerCase());
  if (key) return [...new Set([s, ...EXPAND[key]])];
  // Unknown seed: keep the seed plus English fallbacks, never empty.
  return [...new Set([s, s + ' news', 'technology news'])];
}
