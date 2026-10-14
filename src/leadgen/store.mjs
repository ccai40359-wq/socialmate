// Lead store for the leadgen radar. queue/leads.json, atomic writes (same
// discipline as src/drafts.mjs): the daemon appends while the UI patches, so
// a half-written file must never be readable.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const DATA_ROOT = process.env.SOCIALMATE_DATA_DIR || process.cwd();
const DEFAULT = 'queue/leads.json';

function abs(file) { return resolve(DATA_ROOT, file); }

export function loadLeads(file = DEFAULT) {
  try {
    const parsed = JSON.parse(readFileSync(abs(file), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function saveLeads(list, file = DEFAULT) {
  const target = abs(file);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = target + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  renameSync(tmp, target);
}

// Stable, idempotent id: same platform+url always yields the same id, so a
// re-collected post cannot masquerade as a new lead even across processes.
export function newLeadId(platform, postUrl) {
  return createHash('sha1').update(`${platform}\n${postUrl || ''}`).digest('hex').slice(0, 12);
}

export function appendLeads(newLeads, file = DEFAULT) {
  const list = loadLeads(file);
  const seen = new Set(list.map((l) => l.id));
  let added = 0;
  for (const raw of newLeads || []) {
    const id = raw.id || newLeadId(raw.platform, raw.postUrl);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    list.push({ ...raw, id });
    added++;
  }
  saveLeads(list, file);
  return { added, total: list.length };
}

export function patchLead(id, patch, file = DEFAULT) {
  const list = loadLeads(file);
  const idx = list.findIndex((l) => String(l.id) === String(id));
  if (idx === -1) return null;
  list[idx] = { ...list[idx], ...patch, updatedAt: new Date().toISOString() };
  saveLeads(list, file);
  return list[idx];
}

// LEADS_FILE is exported so tests and the UI server agree on one path.
export const LEADS_FILE = DEFAULT;
