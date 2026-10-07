// Extract like counts from X's aria-label (locale-tolerant).
// Examples: "123 Likes. Like", "1.2K Likes. Like", "0 个喜欢"
export function parseLikeCount(label) {
  if (!label) return 0;
  const m = label.match(/([\d.,]+)\s*([KMB万千]?)/i);
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (Number.isNaN(n)) return 0;
  const unit = (m[2] || '').toUpperCase();
  if (unit === 'K') return Math.round(n * 1e3);
  if (unit === 'M') return Math.round(n * 1e6);
  if (unit === 'B') return Math.round(n * 1e9);
  if (unit === '万') return Math.round(n * 1e4);
  return Math.round(n);
}

export function parseCountAny(text) {
  if (!text) return 0;
  const m = String(text).trim().match(/^([\d.,]+)\s*([KMB万千]?)$/i);
  if (!m) return parseLikeCount(text);
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (Number.isNaN(n)) return 0;
  const unit = (m[2] || '').toUpperCase();
  if (unit === 'K') return Math.round(n * 1e3);
  if (unit === 'M') return Math.round(n * 1e6);
  if (unit === 'B') return Math.round(n * 1e9);
  if (unit === '万') return Math.round(n * 1e4);
  return Math.round(n);
}
