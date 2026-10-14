// Live "about to publish" markers for the queue page.
//
// In 全自动 (auto) mode the daemon publishes inside the round and never leaves
// a review draft, so the queue page used to stay empty while the bot posted.
// These markers are written right BEFORE a publish primitive runs and cleared
// right after, so the UI can show "正在发布：<text>" for the 30-60s the agent
// spends typing. They live in their own file (never queue/drafts.json) so
// approve-all / reject can never see them, and a stale marker self-expires
// after TTL_MS so a crash mid-publish cannot leave a phantom row forever.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const DATA_ROOT = process.env.SOCIALMATE_DATA_DIR || process.cwd();
const DEFAULT = 'queue/pending-publish.json';
const TTL_MS = 10 * 60_000;

function absOf(file) { return resolve(DATA_ROOT, file); }

export function loadPending(file = DEFAULT) {
  try {
    const list = JSON.parse(readFileSync(absOf(file), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

// Atomic write (tmp + rename) for the same reason drafts.mjs does it: the
// daemon writes while the UI reads, and a half-written file must never be
// parsed as truth.
export function savePending(list, file = DEFAULT) {
  const abs = absOf(file);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = abs + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  renameSync(tmp, abs);
}

export function markPublishing(entry, file = DEFAULT) {
  const list = loadPending(file);
  const row = { id: 'pv' + Date.now() + '-' + Math.floor(Math.random() * 1000), at: new Date().toISOString(), ...entry };
  savePending([...list, row].slice(-20), file);
  return row;
}

export function clearPublishing(id, file = DEFAULT) {
  if (!id) return loadPending(file);
  const next = loadPending(file).filter((r) => String(r.id) !== String(id));
  savePending(next, file);
  return next;
}

// Pure so the TTL rule is directly assertable: a marker older than the TTL is
// treated as gone even if clearPublishing never ran.
export function freshPending(list, now = Date.now(), ttlMs = TTL_MS) {
  return (list || []).filter((r) => {
    const t = Date.parse((r && r.at) || '');
    return Number.isFinite(t) && now - t < ttlMs;
  });
}
