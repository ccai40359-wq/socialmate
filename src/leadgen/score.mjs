// LLM scoring for leadgen: "does this public post show real HKD savings-plan
// demand?" Uses the cheap tier. Never throws into the collector: a scoring
// failure degrades to a low score with an explicit marker (fail-closed toward
// the human — an unscored post must never look like a hot lead).
import { completeJson, isConfigured, loadProviderConfig } from '../llm.mjs';
import { appendLog } from '../log.mjs';

export const INTENTS = ['ask', 'compare', 'complain', 'info', 'junk'];
export const GUARDS = ['ok', 'agent', 'offtopic'];

const SYSTEM = `你是香港储蓄险获客线索的筛选助手。给你一批来自小红书/Facebook/Threads的公开帖子，判断每条帖子背后的人是否存在"香港储蓄险/港险储蓄计划"的真实需求。
评分规则（demand 0-100）：
- 明确询问港险产品/收益/投保流程/对比：80-100，intent=ask
- 比较港险与其他储蓄/理财方式、纠结要不要买：60-85，intent=compare
- 抱怨没早点了解/身边人买了赚了/求推荐：50-75，intent=complain
- 泛泛讨论理财储蓄但未指向港险：20-45，intent=info
- 无关内容、广告、招聘、已投保炫耀、从业者引流：0-20，intent=junk
guard 字段：'agent'=发帖人自己是保险从业者/中介兜售；'offtopic'=与港险储蓄无关；'ok'=正常潜在客户。
reasons：给1-3条简短中文理由。
只输出 JSON：{"scores":[{"i":0,"demand":85,"intent":"ask","reasons":["..."],"guard":"ok"}]}（i 为输入数组下标，必须覆盖每条输入）。`;

function normalizePost(p) {
  return {
    id: p.id,
    platform: p.platform,
    text: String(p.text || '').slice(0, 600),
    author: p.author || '',
    keyword: p.keyword || '',
  };
}

function clampScore(s, raw) {
  const demand = Math.max(0, Math.min(100, Number(s?.demand) || 0));
  const intent = INTENTS.includes(s?.intent) ? s.intent : 'junk';
  const guard = GUARDS.includes(s?.guard) ? s.guard : 'ok';
  const reasons = Array.isArray(s?.reasons) ? s.reasons.slice(0, 3).map(String) : [];
  // Guarded rows are capped no matter what the model said: an agent hawking
  // plans or an unrelated post is not a lead (fail-closed).
  const capped = guard !== 'ok' ? Math.min(demand, 20) : demand;
  return { id: raw.id, demand: capped, intent, guard, reasons };
}

function degraded(raw, note) {
  return { id: raw.id, demand: 0, intent: 'junk', guard: 'offtopic', reasons: ['llm-degraded: ' + note], degraded: true };
}

export async function scoreLeads(posts, opts = {}) {
  const list = (posts || []).filter(Boolean);
  if (!list.length) return [];
  const provider = loadProviderConfig();
  if (!isConfigured(provider)) {
    appendLog('leadgen.score: provider not configured -> degraded scores');
    return list.map((p) => degraded(p, '未配置模型，未打分'));
  }

  const out = new Map();
  const BATCH = opts.batchSize || 8;
  for (let start = 0; start < list.length; start += BATCH) {
    const batch = list.slice(start, start + BATCH);
    const payload = batch.map((p, i) => ({ i, ...normalizePost(p) }));
    let result = null;
    try {
      result = await completeJson(
        [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: JSON.stringify(payload) },
        ],
        { tier: 'cheap', maxTokens: 2048, model: opts.model }
      );
    } catch (e) {
      appendLog(`leadgen.score: LLM error -> degraded batch (${e.message})`);
    }
    const scores = Array.isArray(result?.scores) ? result.scores : null;
    if (!scores) {
      for (const p of batch) out.set(p.id, degraded(p, '打分失败，降级为低分'));
      continue;
    }
    for (const p of batch) {
      const idx = batch.indexOf(p);
      const s = scores.find((x) => Number(x?.i) === idx);
      out.set(p.id, s ? clampScore(s, p) : degraded(p, '模型未返回该条评分'));
    }
  }
  return list.map((p) => out.get(p.id) || degraded(p, '未打分'));
}

