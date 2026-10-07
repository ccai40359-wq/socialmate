// Shared AIHOT markdown parser.
// Real format (verified live):
//   1. [标题](https://aihot.news/items/xxx)
//      来源 · 发布于 10-07 22:46 · 行业
//      摘要：...
//      推荐理由：...
//      原文：https://...
export function parseAihotMarkdown(md) {
  const lines = md.split('\n');
  const items = [];
  let cur = null;
  const flush = () => { if (cur && cur.url) items.push(cur); cur = null; };
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const head = line.match(/^\s*(?:[-*]|\d+\.)\s*\[([^\]]+)\]\((https?:\/\/[^)]+)\)\s*$/);
    if (head) { flush(); cur = { title: head[1].trim(), url: head[2].trim() }; continue; }
    if (!cur) continue;
    const meta = line.match(/^\s{2,}(.+?)\s*·\s*发布于\s*([0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2})\s*·\s*(.+?)\s*$/);
    if (meta) { cur.source = meta[1].trim(); cur.published = meta[2].trim(); cur.category = meta[3].trim(); continue; }
    const sum = line.match(/^\s{2,}摘要[：:]\s*(.+)$/);
    if (sum) { cur.summary = sum[1].trim(); continue; }
    const why = line.match(/^\s{2,}推荐理由[：:]\s*(.+)$/);
    if (why) { cur.reason = why[1].trim(); continue; }
    const orig = line.match(/^\s{2,}原文[：:]\s*(https?:\/\/\S+)$/);
    if (orig) { cur.originalUrl = orig[1].trim(); continue; }
  }
  flush();
  const seen = new Set();
  return items.filter((it) => /aihot\.news\/items\//.test(it.url) && !seen.has(it.url) && seen.add(it.url));
}
