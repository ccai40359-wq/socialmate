// Review feedback store. Every approve / reject / edit is the only place a
// human tells us what they actually wanted, so it is recorded before the
// draft is removed. Read-only consumers (the prompt layer) call recentFeedback.
// This is CONTEXT for generation, never a publish gate: gate.mjs must not
// import this module.
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// Runtime data root: mirrors store/drafts/control so the packaged build
// (cwd = userData) and the dev build (cwd = repo root) resolve the same way.
// resolve() ignores DATA_ROOT when the caller passes an absolute path.
const DATA_ROOT = process.env.SOCIALMATE_DATA_DIR || process.cwd();
const DEFAULT = 'queue/feedback.json';
const MAX = 500;

export function loadFeedback(file = DEFAULT) {
  try {
    const list = JSON.parse(readFileSync(resolve(DATA_ROOT, file), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

// Atomic write, same tmp+rename discipline as drafts.mjs: the daemon and the
// UI can both append here while the reader parses it.
export function saveFeedback(list, file = DEFAULT) {
  const abs = resolve(DATA_ROOT, file);
  mkdirSync(dirname(abs), { recursive: true });
  const data = JSON.stringify(list, null, 2);
  const tmp = abs + '.tmp-' + process.pid;
  writeFileSync(tmp, data, 'utf8');
  // On Windows, renaming over an existing file fails with EPERM/EBUSY while a
  // scanner or another handle still holds the destination. That is transient,
  // so back off and retry; if it never settles, write in place so the record
  // is not lost (a torn read is recoverable, a dropped judgement is not).
  for (let i = 0; i < 6; i++) {
    try { renameSync(tmp, abs); return; }
    catch (e) {
      if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') throw e;
      const until = Date.now() + 20 * (i + 1);
      while (Date.now() < until) { /* brief spin */ }
    }
  }
  writeFileSync(abs, data, 'utf8');
  try { rmSync(tmp, { force: true }); } catch {}
}

// Record one judgement. Unknown/blank fields are dropped rather than stored as
// undefined so the file stays a clean JSON array.
export function recordFeedback(entry, file = DEFAULT) {
  const list = loadFeedback(file);
  const lastId = Number(list[list.length - 1]?.id) || 0;
  const clean = {};
  for (const [k, v] of Object.entries(entry || {})) {
    if (v === undefined || v === null || v === '') continue;
    clean[k] = v;
  }
  const row = { id: lastId + 1, ts: new Date().toISOString(), ...clean };
  list.push(row);
  const trimmed = list.slice(-MAX);
  saveFeedback(trimmed, file);
  return row;
}

// Newest-first, filtered by kind and action. Consumed as prompt context.
export function recentFeedback({ kind, action = 'reject', n = 10 } = {}, file = DEFAULT) {
  let list = loadFeedback(file);
  if (action) list = list.filter((x) => x.action === action);
  if (kind) list = list.filter((x) => x.kind === kind);
  return list.slice(-Math.max(0, n)).reverse();
}
