// Cheap combined language detection shared by the perceive layers.
// CJK presence counts strongly, Latin letters count one each — a Portuguese
// tweet ("mas aí eles não descansam...") has no CJK and never lands in zh,
// while a Chinese tweet scores via CJK. Japanese kana and Korean hangul are
// detected explicitly so they are NOT silently labelled zh/en (T1-b / T1-d).
export function detectLang(text) {
  const t = (text || '');
  const cjk = (t.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  const kana = (t.match(/[\u3040-\u30ff]/g) || []).length;
  const hangul = (t.match(/[\uac00-\ud7af]/g) || []).length;
  if (kana > 0) return 'ja';
  if (hangul > 0) return 'ko';
  if (cjk > 0) return 'zh';
  if (latin > 0) return 'en';
  return 'en'; // digits/punctuation only: treat as en, gate decides
}

// ---- lane classification (T1) ------------------------------------------
// Candidates are split into two lanes: 'growth' (mutual-follow / follower
// farming talk) and 'content' (everything else). The classifier is a pure
// function: no LLM, no network, no Math.random — a failure always falls back
// to 'content' so a broken classifier can never empty the pool.
export const GROWTH_KEYWORDS = [
  '互关', '互粉', '互浇', '浇朋友', '浇水', '涨粉', '有关必回', '真诚', '交友',
  '多认识朋友', '认识朋友', '交朋友', '互关互赞', '互赞', '涨粉互关', '关注我',
  'follow back', 'followback', '互 follow', '互follow', '回关',
];

// A "tag" is a hashtag or a compact Chinese token that carries topic intent:
// #互关, #涨粉, 互关, 涨粉… A tweet whose tags are mostly growth words counts
// as growth even when the free text does not literally say the keyword.
export const GROWTH_TAG_RE = /#[^\s#，。！？]+|[\u4e00-\u9fff]{2,}/g;

export function estimateGrowth(text) {
  const t = String(text || '').toLowerCase();
  if (GROWTH_KEYWORDS.some((k) => t.includes(k.toLowerCase()))) return true;
  const tags = t.match(GROWTH_TAG_RE) || [];
  if (!tags.length) return false;
  const hits = tags.filter((tag) => GROWTH_KEYWORDS.some((k) => tag.toLowerCase().includes(k.toLowerCase()))).length;
  return hits / tags.length >= 0.5;
}

export function detectLane(text) {
  try {
    return estimateGrowth(text) ? 'growth' : 'content';
  } catch {
    return 'content';
  }
}
