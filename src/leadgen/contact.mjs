// Contact extraction from profile bio text. Pure function, no IO, no
// templates: it only recognises contact-shaped strings.
const WA_PATTERNS = [
  { label: 'wa-link', re: /(?:https?:\/\/)?(?:www\.)?wa\.me\/([A-Za-z0-9_+\-]{4,})/i },
  { label: 'whatsapp-link', re: /(?:https?:\/\/)?(?:chat\.)?whatsapp\.com\/(?:send|link)\/([A-Za-z0-9_+\-=]{4,})/i },
];
const WA_NUM_RE = /(?:^|[^\d+])(\+?\d{7,15})(?=$|[^\d])/;
const WECHAT_LABELS = ['微信号', '微信', 'VX', 'vx', 'V信', 'v信', '加微', '加微信', '微信同号', 'wechat', 'WeChat'];
const URL_RE = /https?:\/\/[^\s"'<>()]+/g;

function normPhone(v) { return v.replace(/[\s-]/g, ''); }
function isPhoneLike(v) {
  const n = v.replace(/[^\d]/g, '');
  return n.length >= 7 && n.length <= 15 && /^[0-9+\-() ]+$/.test(v);
}
function firstUrl(text) {
  const m = (text || '').match(URL_RE);
  return m ? m[0].replace(/[.,;:!?]+$/, '') : '';
}
function codePair(phone) {
  const clean = phone.replace(/[^\d+]/g, '');
  const m = clean.match(/^(\+\d{1,3})(\d+)$/);
  return m ? [m[2].slice(0, 4), m[2]] : ['', clean];
}
function looksLikePhone(s) {
  return /^\+?\d[\d\- ()]{6,17}$/.test(s.trim());
}

export function extractContacts(bioText) {
  const text = String(bioText || '');
  const out = [];

  for (const { label, re } of WA_PATTERNS) {
    const m = text.match(re);
    if (m) out.push({ kind: 'whatsapp', value: 'wa.me/' + m[1], source: 'bio' });
  }

  for (const label of WECHAT_LABELS) {
    const re = new RegExp(label + '\\s*[:：]?\\s*([A-Za-z0-9_\\-]{5,30})', 'i');
    const m = text.match(re);
    if (m) { out.push({ kind: 'wechat', value: m[1], source: 'bio' }); break; }
  }

  const url = firstUrl(text);
  if (url) out.push({ kind: 'link', value: url, source: 'bio' });

  const nums = (text.match(/\+?\d[\d\- ()\u2013\u2014]{7,17}/g) || []);
  for (const n of nums) {
    const v = normPhone(n);
    if (!v) continue;
    if (out.some((c) => c.kind === 'whatsapp' && (c.value === 'wa.me/' + v || c.value === 'wa.me/' + v.replace(/^\+/, '')))) continue;
    const [prefix, full] = codePair(v);
    const guess = (full.length >= 5 && full.length <= 12) ? { kind: 'whatsapp', value: v, source: 'bio' } : null;
    if (guess) { out.push(guess); break; }
  }

  const seen = new Set();
  return out.filter((c) => {
    const k = c.kind + ':' + c.value;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}