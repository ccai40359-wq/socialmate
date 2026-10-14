// Hong Kong savings-plan demand keywords for the leadgen radar.
// Pure data + pure functions: no IO, no imports, safe for tests and CLI.
export const DB = [
  '香港储蓄险',
  '港险 储蓄',
  '储蓄险 香港 收益',
  '美元储蓄 保单',
  '香港保险 分红',
  '香港储蓄险 复利',
  '港险 保本 储蓄',
  '香港 储蓄保险 推荐',
  '美元保单 香港',
  '香港储蓄 提领',
  '储蓄险 对比 内地',
  '香港保险 储蓄 计划',
  'hong kong savings plan',
  'hong kong insurance savings',
  'hk savings insurance',
  'hk dollar policy',
  'usd savings plan hk',
  'hk endowment plan',
];

export function expandKeywords(maxPerPlatform, keywordsExtra = []) {
  const pool = typeof keywordsExtra === 'string'
    ? (keywordsExtra || '').split(/[,，\n]/).map((s) => s.trim()).filter(Boolean)
    : Array.isArray(keywordsExtra) ? keywordsExtra : [];
  const all = [...DB, ...pool];
  const n = Math.max(0, Math.min(all.length, Number.isFinite(maxPerPlatform) ? maxPerPlatform : DB.length));
  return all.slice(0, n);
}